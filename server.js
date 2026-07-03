const express = require('express');
const multer = require('multer');
const path = require('path');
const db = require('./db');
const importer = require('./import');
const riskAssessments = require('./riskAssessments');
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

app.use(express.json());
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

app.post('/api/users/:id/promote', requireAdmin, handle(async (req, res) => {
  const user = await db.promoteToAdmin(req.params.id);
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
  res.setHeader('Content-Disposition', `attachment; filename="${doc.originalName.replace(/[^a-zA-Z0-9_.\- ]/g, '_')}"`);
  res.send(buffer);
}));

app.delete('/api/jobs/:id/documents/:category/:docId', validateDocumentParams, handle(async (req, res) => {
  const doc = await db.deleteJobDocument(req.params.id, req.params.category, req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  await supabase.storage.from(DOCUMENTS_BUCKET).remove([storagePath(req.params.id, req.params.category, doc.storedName)]);
  broadcast('jobs');
  res.status(204).end();
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
  res.json(await db.yearlyReport());
}));

app.get('/api/reports/monthly', handle(async (req, res) => {
  res.json(await db.monthlyReport());
}));

app.get('/api/reports/clients', handle(async (req, res) => {
  res.json(await db.clientReport());
}));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`BD Construction Job Tracker running at http://localhost:${PORT}`);
  console.log('Other devices on your office network can connect using your PC\'s IP address, e.g. http://192.168.x.x:' + PORT);
});
