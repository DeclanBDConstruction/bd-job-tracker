const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const path = require('path');
const db = require('./db');
const importer = require('./import');
const riskAssessments = require('./riskAssessments');
const permitPdf = require('./permitPdf');
const { supabase, DOCUMENTS_BUCKET } = require('./supabaseClient');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const uploadDocument = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---------- Live updates (Server-Sent Events) ----------
// Every write in this file goes through this same server, so rather than watching Postgres
// for changes, we just tell already-connected browsers "go re-fetch X" right after we save it.
// Keeps the client dumb (still reads through the normal authenticated /api routes) and needs
// no Supabase keys or realtime config exposed to the browser.

const sseClients = new Set();

function broadcast(type) {
  const payload = `data: ${JSON.stringify({ type })}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// Proxies/browsers can silently drop an idle connection, so ping periodically to keep it open.
setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 20000);

// ---------- Job documents (RAMS, drawings, sign-off sheets, photos) ----------
// Files live in Supabase Storage under `${jobId}/${category}/${storedName}`; only
// job_documents rows (metadata) live in Postgres.

const JOB_ID_RE = /^[0-9a-f-]{36}$/i;

function storagePath(jobId, category, storedName) {
  return `${jobId}/${category}/${storedName}`;
}

// Saved risk assessments (the upload-once, attach-to-any-job library) live under this
// fixed prefix in the same bucket - `_library` can never collide with a job id (job ids
// are UUIDs).
function libraryStoragePath(storedName) {
  return `_library/rams/${storedName}`;
}

// Signed subcontractor forms live under this fixed prefix in the same bucket.
function subbyFormStoragePath(storedName) {
  return `_library/subbies/${storedName}`;
}

function makeStoredName(originalName) {
  const safeName = originalName.replace(/[^a-zA-Z0-9_.\- ]/g, '_');
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
}

// Runs before anything touches storage, so a bad job id or category never gets used to
// build a storage path.
async function validateDocumentParams(req, res, next) {
  try {
    if (!JOB_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid job id' });
    if (!db.DOCUMENT_CATEGORIES.includes(req.params.category)) return res.status(400).json({ error: 'Invalid document category' });
    if (!(await db.getJob(req.params.id))) return res.status(404).json({ error: 'Job not found' });
    next();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// Default 100kb is tight for a request carrying two base64 signature-pad PNGs (see the
// Permit to Work route) - other routes already accept much larger multipart uploads via
// multer, so this is a proportionate bump, not a new risk.
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return cookies;
}

function currentUser(req) {
  return db.getUserBySession(parseCookies(req).sid);
}

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, matches db.js session TTL

function setSessionCookie(res, token) {
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_MAX_AGE_MS });
}

// ---------- Auth ----------
// These routes are intentionally registered before the auth-required gate below, since you
// can't be logged in yet when hitting them.

app.post('/api/auth/register', handle(async (req, res) => {
  const user = await db.registerUser(req.body);
  setSessionCookie(res, await db.createSession(user.id));
  res.status(201).json(user);
}));

app.post('/api/auth/login', handle(async (req, res) => {
  const user = await db.verifyLogin(req.body.email, req.body.password);
  setSessionCookie(res, await db.createSession(user.id));
  res.json(user);
}));

app.post('/api/auth/logout', handle(async (req, res) => {
  const { sid } = parseCookies(req);
  if (sid) await db.deleteSession(sid);
  res.clearCookie('sid');
  res.status(204).end();
}));

app.get('/api/auth/me', handle(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  res.json(user);
}));

// Everything below this line requires a signed-in user.
app.use('/api', async (req, res, next) => {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    req.user = user;
    next();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

// Staff and operatives each get a narrow allowlist instead of the full app - the frontend
// hides everything else too (see the role checks in app.js), but this is the real
// enforcement, since either account could otherwise still call any other route directly.
// Paths here are relative to the '/api' mount point (Express strips it from req.path
// inside an app.use('/api', ...) middleware), so these do NOT repeat the '/api' prefix.
// Both roles share the calendar/diary routes; operatives additionally get their own
// job-assignment routes, self-scoped in db.js (see listMyJobAssignments/
// setJobAssignmentCompleted) rather than gated here. Admin and surveyor pass through
// untouched by either check below.
const CALENDAR_DIARY_ROUTES = [
  { method: 'GET', path: /^\/events$/ },
  { method: 'GET', path: /^\/calendar$/ },
  { method: 'POST', path: /^\/calendar$/ },
  { method: 'DELETE', path: /^\/calendar\/[^/]+$/ },
  { method: 'GET', path: /^\/calendar-colors$/ },
  { method: 'GET', path: /^\/users\/colors$/ },
  { method: 'PUT', path: /^\/users\/me\/color$/ },
  { method: 'GET', path: /^\/diary$/ },
  { method: 'POST', path: /^\/diary$/ },
  { method: 'PUT', path: /^\/diary\/[^/]+\/complete$/ },
  { method: 'PUT', path: /^\/diary\/[^/]+$/ },
  { method: 'DELETE', path: /^\/diary\/[^/]+$/ },
];

const STAFF_ALLOWED_ROUTES = CALENDAR_DIARY_ROUTES;

const OPERATIVE_ALLOWED_ROUTES = [
  ...CALENDAR_DIARY_ROUTES,
  { method: 'GET', path: /^\/job-assignments\/mine$/ },
  { method: 'PUT', path: /^\/job-assignments\/[^/]+\/complete$/ },
  { method: 'POST', path: /^\/job-assignments\/[^/]+\/photo$/ },
  { method: 'POST', path: /^\/job-assignments\/[^/]+\/permit$/ },
  { method: 'POST', path: /^\/job-assignments\/[^/]+\/time\/clock-in$/ },
  { method: 'POST', path: /^\/job-assignments\/[^/]+\/time\/arrived$/ },
  { method: 'POST', path: /^\/job-assignments\/[^/]+\/time\/clock-out$/ },
  { method: 'GET', path: /^\/job-assignments\/[^/]+\/time-logs$/ },
];

app.use('/api', (req, res, next) => {
  if (req.user.role === 'staff' && !STAFF_ALLOWED_ROUTES.some((r) => r.method === req.method && r.path.test(req.path))) {
    return res.status(403).json({ error: 'Not available for your role' });
  }
  if (db.OPERATIVE_ROLES.includes(req.user.role) && !OPERATIVE_ALLOWED_ROUTES.some((r) => r.method === req.method && r.path.test(req.path))) {
    return res.status(403).json({ error: 'Not available for your role' });
  }
  next();
});

// ---------- Live updates (SSE) ----------

app.get('/api/events', (req, res) => {
  req.setTimeout(0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ---------- Users (admin) ----------

app.get('/api/users', requireAdmin, handle(async (req, res) => {
  res.json(await db.listUsers());
}));

app.put('/api/users/:id/role', requireAdmin, handle(async (req, res) => {
  const user = await db.setUserRole(req.params.id, req.body.role);
  broadcast('users');
  res.json(user);
}));

app.put('/api/users/:id/employee', requireAdmin, handle(async (req, res) => {
  const user = await db.setUserEmployee(req.params.id, req.body.employeeId || null);
  broadcast('users');
  res.json(user);
}));

// Everyone (not just admins) needs these two to run the calendar colour picker: the
// fixed palette to choose from, and who's already using which colour.
app.get('/api/calendar-colors', handle(async (req, res) => {
  res.json(db.CALENDAR_COLORS);
}));

app.get('/api/users/colors', handle(async (req, res) => {
  res.json(await db.listUserColors());
}));

app.put('/api/users/me/color', handle(async (req, res) => {
  const user = await db.setUserColor(req.user.id, req.body.color);
  broadcast('users');
  res.json(user);
}));

// ---------- Employees ----------

app.get('/api/employees', handle(async (req, res) => {
  res.json(await db.listEmployees());
}));

app.post('/api/employees', requireAdmin, handle(async (req, res) => {
  const employee = await db.addEmployee(req.body.name);
  broadcast('employees');
  res.status(201).json(employee);
}));

app.put('/api/employees/:id', requireAdmin, handle(async (req, res) => {
  const employee = await db.renameEmployee(req.params.id, req.body.name);
  broadcast('employees');
  res.json(employee);
}));

app.delete('/api/employees/:id', requireAdmin, handle(async (req, res) => {
  await db.deleteEmployee(req.params.id);
  broadcast('employees');
  res.status(204).end();
}));

// ---------- Jobs ----------

app.get('/api/jobs', handle(async (req, res) => {
  res.json(await db.listJobs());
}));

app.get('/api/jobs/:id', handle(async (req, res) => {
  const job = await db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
}));

app.post('/api/jobs', handle(async (req, res) => {
  const job = await db.createJob(req.body);
  broadcast('jobs');
  res.status(201).json(job);
}));

app.put('/api/jobs/:id', handle(async (req, res) => {
  const job = await db.updateJob(req.params.id, req.body);
  broadcast('jobs');
  res.json(job);
}));

app.delete('/api/jobs/:id', requireAdmin, handle(async (req, res) => {
  const job = await db.getJob(req.params.id);
  await db.deleteJob(req.params.id);
  if (job) {
    const paths = db.DOCUMENT_CATEGORIES.flatMap((category) =>
      job.documents[category].map((doc) => storagePath(req.params.id, category, doc.storedName)));
    if (paths.length) await supabase.storage.from(DOCUMENTS_BUCKET).remove(paths);
  }
  broadcast('jobs');
  res.status(204).end();
}));

app.post('/api/jobs/:id/complete', handle(async (req, res) => {
  const job = await db.completeJob(req.params.id);
  broadcast('jobs');
  res.json(job);
}));

app.post('/api/jobs/:id/reopen', handle(async (req, res) => {
  const job = await db.reopenJob(req.params.id);
  broadcast('jobs');
  res.json(job);
}));

app.post('/api/jobs/:id/variations', handle(async (req, res) => {
  if (!JOB_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid job id' });
  if (!(await db.getJob(req.params.id))) return res.status(404).json({ error: 'Job not found' });
  const variation = await db.addJobVariation(req.params.id, req.body);
  broadcast('jobs');
  res.status(201).json(variation);
}));

app.delete('/api/jobs/:id/variations/:variationId', handle(async (req, res) => {
  const variation = await db.deleteJobVariation(req.params.id, req.params.variationId);
  if (!variation) return res.status(404).json({ error: 'Variation not found' });
  broadcast('jobs');
  res.status(204).end();
}));

app.post('/api/jobs/:id/documents/:category', validateDocumentParams, uploadDocument.single('file'), handle(async (req, res) => {
  if (!req.file) throw new Error('No file uploaded');
  const storedName = makeStoredName(req.file.originalname);
  const { error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(storagePath(req.params.id, req.params.category, storedName), req.file.buffer, {
      contentType: req.file.mimetype || 'application/octet-stream',
    });
  if (error) throw new Error(error.message);
  const doc = await db.addJobDocument(req.params.id, req.params.category, {
    originalName: req.file.originalname,
    storedName,
    size: req.file.size,
  });
  broadcast('jobs');
  res.status(201).json(doc);
}));

app.get('/api/jobs/:id/documents/:category/:docId/file', validateDocumentParams, handle(async (req, res) => {
  const doc = await db.getJobDocument(req.params.id, req.params.category, req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .download(storagePath(req.params.id, req.params.category, doc.storedName));
  if (error) return res.status(404).json({ error: 'File not found in storage' });
  const buffer = Buffer.from(await data.arrayBuffer());
  const filename = doc.originalName.replace(/[^a-zA-Z0-9_.\- ]/g, '_');
  // Permits are generated PDFs meant to be reviewed on the spot (e.g. a surveyor checking
  // one), not saved to disk first - inline + the real content type lets the browser render
  // it straight away, same as clicking a PDF link anywhere else on the web. Every other
  // document category keeps the old "always download" behaviour, unchanged.
  if (req.params.category === 'permit') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  } else {
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  }
  res.send(buffer);
}));

app.delete('/api/jobs/:id/documents/:category/:docId', validateDocumentParams, handle(async (req, res) => {
  const doc = await db.deleteJobDocument(req.params.id, req.params.category, req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  await supabase.storage.from(DOCUMENTS_BUCKET).remove([storagePath(req.params.id, req.params.category, doc.storedName)]);
  broadcast('jobs');
  res.status(204).end();
}));

// Everything on a job (RAMS, drawings, sign-off sheets, photos) bundled into one zip, named
// after the job number and location, plus a short info sheet with the start date - built for
// forwarding on to someone outside the company (e.g. attaching to an email) in one go.
app.get('/api/jobs/:id/documents-zip', handle(async (req, res) => {
  if (!JOB_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid job id' });
  const job = await db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const namePart = [job.jobReference, job.location].filter(Boolean).join(' - ') || job.client || 'Job';
  const filename = namePart.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Job';

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('Zip generation failed:', err);
    res.destroy();
  });
  archive.pipe(res);

  archive.append(
    [
      `Job Number: ${job.jobReference || '—'}`,
      `Client: ${job.client || '—'}`,
      `Location: ${job.location || '—'}`,
      `Start Date: ${job.startDate || '—'}`,
    ].join('\r\n') + '\r\n',
    { name: 'Job Info.txt' },
  );

  for (const category of db.DOCUMENT_CATEGORIES) {
    const docs = (job.documents || {})[category] || [];
    for (const doc of docs) {
      const entryName = `${db.DOCUMENT_LABELS[category]}/${doc.originalName}`;
      try {
        const { data, error } = await supabase.storage
          .from(DOCUMENTS_BUCKET)
          .download(storagePath(job.id, category, doc.storedName));
        if (error) throw new Error(error.message);
        archive.append(Buffer.from(await data.arrayBuffer()), { name: entryName });
      } catch (err) {
        archive.append(`Couldn't include this file: ${err.message}\r\n`, { name: `${entryName} - FAILED TO DOWNLOAD.txt` });
      }
    }
  }

  await archive.finalize();
}));

// ---------- Job Assignments ----------
// Admin creates/edits/deletes who's assigned to physically do a job; surveyor gets the
// same list read-only (nothing here stops a surveyor calling these directly - same trust
// level as already having unrestricted access to any job's Job Detail modal). Staff never
// reach this (not on their allowlist); operatives only reach the three self-scoped routes
// at the bottom (see OPERATIVE_ALLOWED_ROUTES above) - ownership is re-checked in db.js too.

app.get('/api/job-assignments', handle(async (req, res) => {
  res.json(await db.listJobAssignments());
}));

app.post('/api/job-assignments', requireAdmin, handle(async (req, res) => {
  const assignment = await db.createJobAssignment(req.body, req.user);
  broadcast('jobAssignments');
  res.status(201).json(assignment);
}));

app.put('/api/job-assignments/:id', requireAdmin, handle(async (req, res) => {
  const assignment = await db.updateJobAssignment(req.params.id, req.body);
  broadcast('jobAssignments');
  res.json(assignment);
}));

app.delete('/api/job-assignments/:id', requireAdmin, handle(async (req, res) => {
  await db.deleteJobAssignment(req.params.id);
  broadcast('jobAssignments');
  res.status(204).end();
}));

// ---- Operative-scoped (see OPERATIVE_ALLOWED_ROUTES) ----

app.get('/api/job-assignments/mine', handle(async (req, res) => {
  res.json(await db.listMyJobAssignments(req.user));
}));

app.put('/api/job-assignments/:id/complete', handle(async (req, res) => {
  const assignment = await db.setJobAssignmentCompleted(req.params.id, !!req.body.completed, req.user);
  broadcast('jobAssignments');
  res.json(assignment);
}));

// Clock in/arrived/clock out - ownership-checked here (db.js's clockIn/markArrived/clockOut
// trust the assignmentId they're given, same convention as addJobDocument etc), timestamps
// are always server-stamped inside those functions, never taken from the request body.
app.post('/api/job-assignments/:id/time/clock-in', handle(async (req, res) => {
  const assignment = await db.getJobAssignment(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  if (assignment.userId !== req.user.id) return res.status(403).json({ error: 'You can only clock in on your own assignment' });
  const log = await db.clockIn(req.params.id);
  broadcast('jobAssignments');
  res.json(log);
}));

app.post('/api/job-assignments/:id/time/arrived', handle(async (req, res) => {
  const assignment = await db.getJobAssignment(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  if (assignment.userId !== req.user.id) return res.status(403).json({ error: 'You can only mark yourself arrived on your own assignment' });
  const log = await db.markArrived(req.params.id);
  broadcast('jobAssignments');
  res.json(log);
}));

app.post('/api/job-assignments/:id/time/clock-out', handle(async (req, res) => {
  const assignment = await db.getJobAssignment(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  if (assignment.userId !== req.user.id) return res.status(403).json({ error: 'You can only clock out on your own assignment' });
  const log = await db.clockOut(req.params.id);
  broadcast('jobAssignments');
  res.json(log);
}));

// Admin/surveyor get the same unrestricted view they already have over the rest of an
// assignment; an operative can only ever see their own (they never reach this route for
// someone else's assignment anyway - see OPERATIVE_ALLOWED_ROUTES - but the check stays
// here too since admin/surveyor share this same route and aren't operatives).
app.get('/api/job-assignments/:id/time-logs', handle(async (req, res) => {
  const assignment = await db.getJobAssignment(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  if (db.OPERATIVE_ROLES.includes(req.user.role) && assignment.userId !== req.user.id) {
    return res.status(403).json({ error: 'You can only view time logs for your own assignment' });
  }
  res.json(await db.listTimeLogs(req.params.id));
}));

// Narrow, purpose-built upload: hardcoded to the 'photos' category, and verified against
// the assignment's own job_id + user_id = req.user.id server-side - deliberately NOT the
// generic /api/jobs/:id/documents/:category route (that one is unrestricted-by-design for
// office roles across every category on any job, which is too broad to hand to operatives).
app.post('/api/job-assignments/:id/photo', uploadDocument.single('file'), handle(async (req, res) => {
  if (!req.file) throw new Error('No file uploaded');
  const assignment = await db.getJobAssignment(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  if (assignment.userId !== req.user.id) return res.status(403).json({ error: 'You can only upload photos against your own assignment' });
  const storedName = makeStoredName(req.file.originalname);
  const { error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(storagePath(assignment.jobId, 'photos', storedName), req.file.buffer, {
      contentType: req.file.mimetype || 'application/octet-stream',
    });
  if (error) throw new Error(error.message);
  const doc = await db.addJobDocument(assignment.jobId, 'photos', {
    originalName: req.file.originalname,
    storedName,
    size: req.file.size,
  });
  broadcast('jobs'); // so an admin/surveyor with the Job Detail Photos tab open sees it live
  res.status(201).json(doc);
}));

// Fills in and saves the Permit to Work in one step: the operative fills the form in-app
// (see the Permit to Work modal in app.js), this generates the PDF from those values and
// saves it straight onto the job's 'permit' document category server-side - no separate
// "open a blank PDF, fill it externally, upload the file back" round trip, since a browser's
// own PDF viewer can't report back to the app when someone fills it in. Ownership-checked
// the same way as the photo route above; not the generic /api/jobs/:id/documents/:category
// route, same reasoning as that one.
// A signature comes over the wire as a data URL from <canvas>.toDataURL('image/png') on
// the client (see createSignaturePad in app.js) - strip the data: prefix and decode to the
// raw PNG bytes pdf-lib's embedPng needs. Returns null for anything that isn't a plausible
// PNG data URL, so a malformed/missing signature fails validation below rather than
// crashing PDF generation.
function decodePngDataUrl(dataUrl) {
  const match = /^data:image\/png;base64,([a-zA-Z0-9+/=]+)$/.exec(String(dataUrl || ''));
  return match ? Buffer.from(match[1], 'base64') : null;
}

app.post('/api/job-assignments/:id/permit', handle(async (req, res) => {
  const assignment = await db.getJobAssignment(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  if (assignment.userId !== req.user.id) return res.status(403).json({ error: 'You can only save a permit against your own assignment' });

  const textFields = ['siteName', 'jobNumber', 'description', 'date', 'operativeName', 'managerName'];
  const FIELD_LABELS = {
    siteName: 'Site Name', jobNumber: 'Job Number', description: 'Description of Work', date: 'Date',
    operativeName: 'Operative Name', managerName: 'Manager Name',
  };
  const missing = textFields.filter((f) => !String(req.body[f] || '').trim());
  if (missing.length) {
    throw new Error(`Fill in every field before saving: ${missing.map((f) => FIELD_LABELS[f]).join(', ')}`);
  }

  const operativeSignatureImage = decodePngDataUrl(req.body.operativeSignatureImage);
  const managerSignatureImage = decodePngDataUrl(req.body.managerSignatureImage);
  if (!operativeSignatureImage || !managerSignatureImage) {
    throw new Error('Both the operative and manager need to sign before saving');
  }

  const pdfBuffer = await permitPdf.generatePermitPdf({
    siteName: req.body.siteName,
    jobNumber: req.body.jobNumber,
    description: req.body.description,
    date: req.body.date,
    operativeName: req.body.operativeName,
    operativeSignatureImage,
    managerName: req.body.managerName,
    managerSignatureImage,
  });
  const storedName = makeStoredName('Permit to Work.pdf');
  const { error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(storagePath(assignment.jobId, 'permit', storedName), pdfBuffer, { contentType: 'application/pdf' });
  if (error) throw new Error(error.message);
  const doc = await db.addJobDocument(assignment.jobId, 'permit', {
    originalName: 'Permit to Work.pdf',
    storedName,
    size: pdfBuffer.length,
  });
  broadcast('jobs'); // so an admin/surveyor with the Job Detail Permit to Work tab open sees it live
  res.status(201).json(doc);
}));

// ---------- Risk Assessments ----------

app.get('/api/risk-assessments', handle(async (req, res) => {
  res.json(riskAssessments.listRiskAssessments());
}));

app.get('/api/risk-assessments/:id/download', handle(async (req, res) => {
  const ra = riskAssessments.getRiskAssessment(req.params.id);
  if (!ra) return res.status(404).json({ error: 'Risk assessment not found' });
  const html = riskAssessments.renderHtml(ra);
  res.setHeader('Content-Disposition', `attachment; filename="${ra.title.replace(/[^a-zA-Z0-9_.\- ]/g, '_')} - Risk Assessment.html"`);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
}));

app.post('/api/jobs/:id/risk-assessments/:raId/attach', handle(async (req, res) => {
  if (!JOB_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid job id' });
  if (!(await db.getJob(req.params.id))) return res.status(404).json({ error: 'Job not found' });
  const ra = riskAssessments.getRiskAssessment(req.params.raId);
  if (!ra) return res.status(404).json({ error: 'Risk assessment not found' });

  const html = riskAssessments.renderHtml(ra);
  const originalName = `${ra.title} - Risk Assessment.html`;
  const storedName = makeStoredName(originalName);
  const { error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(storagePath(req.params.id, 'rams', storedName), Buffer.from(html, 'utf8'), { contentType: 'text/html' });
  if (error) throw new Error(error.message);

  const doc = await db.addJobDocument(req.params.id, 'rams', {
    originalName,
    storedName,
    size: Buffer.byteLength(html),
  });
  broadcast('jobs');
  res.status(201).json(doc);
}));

// ---------- Saved Risk Assessments (library) ----------
// Risk assessments staff have written and uploaded themselves - saved once here so they
// can be attached to any job, including the same job again if it comes up in future.

app.get('/api/risk-assessments/library', handle(async (req, res) => {
  res.json(await db.listSavedRiskAssessments());
}));

app.post('/api/risk-assessments/library', uploadDocument.single('file'), handle(async (req, res) => {
  if (!req.file) throw new Error('No file uploaded');
  const storedName = makeStoredName(req.file.originalname);
  const { error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(libraryStoragePath(storedName), req.file.buffer, {
      contentType: req.file.mimetype || 'application/octet-stream',
    });
  if (error) throw new Error(error.message);
  const ra = await db.addSavedRiskAssessment({
    name: req.body.name || req.file.originalname,
    originalName: req.file.originalname,
    storedName,
    size: req.file.size,
    uploadedBy: req.user.name,
  });
  res.status(201).json(ra);
}));

app.get('/api/risk-assessments/library/:id/file', handle(async (req, res) => {
  const ra = await db.getSavedRiskAssessment(req.params.id);
  if (!ra) return res.status(404).json({ error: 'Risk assessment not found' });
  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .download(libraryStoragePath(ra.storedName));
  if (error) return res.status(404).json({ error: 'File not found in storage' });
  const buffer = Buffer.from(await data.arrayBuffer());
  res.setHeader('Content-Disposition', `attachment; filename="${ra.originalName.replace(/[^a-zA-Z0-9_.\- ]/g, '_')}"`);
  res.send(buffer);
}));

app.delete('/api/risk-assessments/library/:id', requireAdmin, handle(async (req, res) => {
  const ra = await db.deleteSavedRiskAssessment(req.params.id);
  if (!ra) return res.status(404).json({ error: 'Risk assessment not found' });
  await supabase.storage.from(DOCUMENTS_BUCKET).remove([libraryStoragePath(ra.storedName)]);
  res.status(204).end();
}));

app.post('/api/jobs/:id/risk-assessments/library/:raId/attach', handle(async (req, res) => {
  if (!JOB_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid job id' });
  if (!(await db.getJob(req.params.id))) return res.status(404).json({ error: 'Job not found' });
  const ra = await db.getSavedRiskAssessment(req.params.raId);
  if (!ra) return res.status(404).json({ error: 'Risk assessment not found' });

  const { data, error: downloadErr } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .download(libraryStoragePath(ra.storedName));
  if (downloadErr) throw new Error('Saved file not found in storage');
  const buffer = Buffer.from(await data.arrayBuffer());
  const storedName = makeStoredName(ra.originalName);
  const { error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(storagePath(req.params.id, 'rams', storedName), buffer, {
      contentType: data.type || 'application/octet-stream',
    });
  if (error) throw new Error(error.message);

  const doc = await db.addJobDocument(req.params.id, 'rams', {
    originalName: ra.originalName,
    storedName,
    size: buffer.length,
  });
  broadcast('jobs');
  res.status(201).json(doc);
}));

// ---------- Custom Risk Assessments (edited "Save As" copies) ----------
// Any risk assessment - generic or another custom one - can be edited and saved as a new
// one here. Never overwrites the original it was based on.

app.get('/api/risk-assessments/custom', handle(async (req, res) => {
  res.json(await db.listCustomRiskAssessments());
}));

app.post('/api/risk-assessments/custom', handle(async (req, res) => {
  const ra = await db.createCustomRiskAssessment(req.body, req.user.name);
  res.status(201).json(ra);
}));

app.get('/api/risk-assessments/custom/:id/download', handle(async (req, res) => {
  const ra = await db.getCustomRiskAssessment(req.params.id);
  if (!ra) return res.status(404).json({ error: 'Risk assessment not found' });
  const html = riskAssessments.renderHtml(ra);
  res.setHeader('Content-Disposition', `attachment; filename="${ra.title.replace(/[^a-zA-Z0-9_.\- ]/g, '_')} - Risk Assessment.html"`);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
}));

app.delete('/api/risk-assessments/custom/:id', requireAdmin, handle(async (req, res) => {
  const ra = await db.deleteCustomRiskAssessment(req.params.id);
  if (!ra) return res.status(404).json({ error: 'Risk assessment not found' });
  res.status(204).end();
}));

app.post('/api/jobs/:id/risk-assessments/custom/:raId/attach', handle(async (req, res) => {
  if (!JOB_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid job id' });
  if (!(await db.getJob(req.params.id))) return res.status(404).json({ error: 'Job not found' });
  const ra = await db.getCustomRiskAssessment(req.params.raId);
  if (!ra) return res.status(404).json({ error: 'Risk assessment not found' });

  const html = riskAssessments.renderHtml(ra);
  const originalName = `${ra.title} - Risk Assessment.html`;
  const storedName = makeStoredName(originalName);
  const { error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(storagePath(req.params.id, 'rams', storedName), Buffer.from(html, 'utf8'), { contentType: 'text/html' });
  if (error) throw new Error(error.message);

  const doc = await db.addJobDocument(req.params.id, 'rams', {
    originalName,
    storedName,
    size: Buffer.byteLength(html),
  });
  broadcast('jobs');
  res.status(201).json(doc);
}));

// ---------- Calendar ----------

app.get('/api/calendar', handle(async (req, res) => {
  res.json(await db.listCalendarEvents(req.user));
}));

app.post('/api/calendar', handle(async (req, res) => {
  const event = await db.createCalendarEvent(req.body, req.user);
  broadcast('calendar');
  res.status(201).json(event);
}));

app.delete('/api/calendar/:id', handle(async (req, res) => {
  await db.deleteCalendarEvent(req.params.id, req.user);
  broadcast('calendar');
  res.status(204).end();
}));

// ---------- Diary (private to the signed-in user) ----------

app.get('/api/diary', handle(async (req, res) => {
  res.json(await db.listDiaryEntries(req.user));
}));

app.post('/api/diary', handle(async (req, res) => {
  const entry = await db.createDiaryEntry(req.body, req.user);
  broadcast('diary');
  res.status(201).json(entry);
}));

app.put('/api/diary/:id', handle(async (req, res) => {
  const entry = await db.updateDiaryEntry(req.params.id, req.body, req.user);
  broadcast('diary');
  res.json(entry);
}));

app.put('/api/diary/:id/complete', handle(async (req, res) => {
  const entry = await db.setDiaryEntryCompleted(req.params.id, !!req.body.completed, req.user);
  broadcast('diary');
  res.json(entry);
}));

app.delete('/api/diary/:id', handle(async (req, res) => {
  await db.deleteDiaryEntry(req.params.id, req.user);
  broadcast('diary');
  res.status(204).end();
}));

// ---------- Price List (Labour & Materials) ----------

app.get('/api/price-list', handle(async (req, res) => {
  res.json(await db.listPriceListItems());
}));

app.post('/api/price-list', handle(async (req, res) => {
  const item = await db.createPriceListItem(req.body);
  broadcast('priceList');
  res.status(201).json(item);
}));

app.put('/api/price-list/:id', handle(async (req, res) => {
  const item = await db.updatePriceListItem(req.params.id, req.body);
  broadcast('priceList');
  res.json(item);
}));

app.delete('/api/price-list/:id', requireAdmin, handle(async (req, res) => {
  await db.deletePriceListItem(req.params.id);
  broadcast('priceList');
  res.status(204).end();
}));

// ---------- Subbies (subcontractor directory) ----------
// Every subby needs a signed subcontractor form on file, so adding one is a multipart
// upload rather than a plain JSON post - no file, no record.

app.get('/api/subbies', handle(async (req, res) => {
  res.json(await db.listSubbies());
}));

app.post('/api/subbies', uploadDocument.single('file'), handle(async (req, res) => {
  if (!req.file) throw new Error('Subcontractor form is required');
  const storedName = makeStoredName(req.file.originalname);
  const { error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(subbyFormStoragePath(storedName), req.file.buffer, {
      contentType: req.file.mimetype || 'application/octet-stream',
    });
  if (error) throw new Error(error.message);
  const subby = await db.createSubby(req.body, {
    originalName: req.file.originalname,
    storedName,
    size: req.file.size,
  });
  broadcast('subbies');
  res.status(201).json(subby);
}));

app.get('/api/subbies/:id/file', handle(async (req, res) => {
  const subby = await db.getSubby(req.params.id);
  if (!subby || !subby.formStoredName) return res.status(404).json({ error: 'Form not found' });
  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .download(subbyFormStoragePath(subby.formStoredName));
  if (error) return res.status(404).json({ error: 'File not found in storage' });
  const buffer = Buffer.from(await data.arrayBuffer());
  res.setHeader('Content-Disposition', `attachment; filename="${subby.formOriginalName.replace(/[^a-zA-Z0-9_.\- ]/g, '_')}"`);
  res.send(buffer);
}));

app.put('/api/subbies/:id', handle(async (req, res) => {
  const subby = await db.updateSubby(req.params.id, req.body);
  broadcast('subbies');
  res.json(subby);
}));

app.delete('/api/subbies/:id', requireAdmin, handle(async (req, res) => {
  const subby = await db.deleteSubby(req.params.id);
  if (subby && subby.formStoredName) {
    await supabase.storage.from(DOCUMENTS_BUCKET).remove([subbyFormStoragePath(subby.formStoredName)]);
  }
  broadcast('subbies');
  res.status(204).end();
}));

// ---------- Quoting ----------
// Everyone signed in can see the list; add/edit/reassign/delete is restricted to quoting
// managers inside db.js (which also lets the assigned surveyor tick their own off).

app.get('/api/quotes', handle(async (req, res) => {
  res.json(await db.listQuotes());
}));

app.post('/api/quotes', handle(async (req, res) => {
  const quote = await db.createQuote(req.body, req.user);
  broadcast('quotes');
  res.status(201).json(quote);
}));

app.put('/api/quotes/:id', handle(async (req, res) => {
  const quote = await db.updateQuote(req.params.id, req.body, req.user);
  broadcast('quotes');
  res.json(quote);
}));

app.put('/api/quotes/:id/quoted', handle(async (req, res) => {
  const quote = await db.setQuoteQuoted(req.params.id, !!req.body.quoted, req.user);
  broadcast('quotes');
  res.json(quote);
}));

app.delete('/api/quotes/:id', handle(async (req, res) => {
  await db.deleteQuote(req.params.id, req.user);
  broadcast('quotes');
  res.status(204).end();
}));

// ---------- Hire (admin only) ----------

app.get('/api/hires', requireAdmin, handle(async (req, res) => {
  res.json(await db.listHires());
}));

app.post('/api/hires', requireAdmin, handle(async (req, res) => {
  const hire = await db.createHire(req.body);
  broadcast('hires');
  res.status(201).json(hire);
}));

app.put('/api/hires/:id', requireAdmin, handle(async (req, res) => {
  const hire = await db.updateHire(req.params.id, req.body);
  broadcast('hires');
  res.json(hire);
}));

app.post('/api/hires/:id/return', requireAdmin, handle(async (req, res) => {
  const hire = await db.markHireReturned(req.params.id);
  broadcast('hires');
  res.json(hire);
}));

app.delete('/api/hires/:id', requireAdmin, handle(async (req, res) => {
  await db.deleteHire(req.params.id);
  broadcast('hires');
  res.status(204).end();
}));

// ---------- Vehicle Hire (admin only) ----------

app.get('/api/vehicle-hires', requireAdmin, handle(async (req, res) => {
  res.json(await db.listVehicleHires());
}));

app.post('/api/vehicle-hires', requireAdmin, handle(async (req, res) => {
  const vehicleHire = await db.createVehicleHire(req.body);
  broadcast('vehicleHires');
  res.status(201).json(vehicleHire);
}));

app.put('/api/vehicle-hires/:id', requireAdmin, handle(async (req, res) => {
  const vehicleHire = await db.updateVehicleHire(req.params.id, req.body);
  broadcast('vehicleHires');
  res.json(vehicleHire);
}));

app.post('/api/vehicle-hires/:id/off-hire', requireAdmin, handle(async (req, res) => {
  const vehicleHire = await db.markVehicleHireOffHired(req.params.id, req.body.signedOut, req.body.comments);
  broadcast('vehicleHires');
  res.json(vehicleHire);
}));

app.delete('/api/vehicle-hires/:id', requireAdmin, handle(async (req, res) => {
  await db.deleteVehicleHire(req.params.id);
  broadcast('vehicleHires');
  res.status(204).end();
}));

// ---------- Signage (shared - anyone can view/add/update; removing one is admin-only) ----------

app.get('/api/signage', handle(async (req, res) => {
  res.json(await db.listSignage());
}));

app.post('/api/signage', handle(async (req, res) => {
  const sign = await db.createSignage(req.body);
  broadcast('signage');
  res.status(201).json(sign);
}));

app.put('/api/signage/:id', handle(async (req, res) => {
  const sign = await db.updateSignage(req.params.id, req.body);
  broadcast('signage');
  res.json(sign);
}));

app.delete('/api/signage/:id', requireAdmin, handle(async (req, res) => {
  await db.deleteSignage(req.params.id);
  broadcast('signage');
  res.status(204).end();
}));

// ---------- Status list ----------

app.get('/api/statuses', handle(async (req, res) => {
  res.json(db.DEFAULT_STATUSES);
}));

// ---------- Import ----------

app.post('/api/import/jobsheet', upload.single('file'), handle(async (req, res) => {
  if (!req.file) throw new Error('No file uploaded');
  res.json(importer.parseJobSheet(req.file.buffer));
}));

// ---------- Reports ----------

app.get('/api/reports/yearly', handle(async (req, res) => {
  res.json(await db.yearlyReport(req.user));
}));

// Company-wide monthly trend, not broken down by employee - still admin-only, since it
// reveals total turnover across everyone rather than the viewer's own figures.
app.get('/api/reports/monthly', requireAdmin, handle(async (req, res) => {
  res.json(await db.monthlyReport());
}));

app.get('/api/reports/clients', requireAdmin, handle(async (req, res) => {
  res.json(await db.clientReport());
}));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`BD Construction Job Tracker running at http://localhost:${PORT}`);
  console.log('Other devices on your office network can connect using your PC\'s IP address, e.g. http://192.168.x.x:' + PORT);
});
