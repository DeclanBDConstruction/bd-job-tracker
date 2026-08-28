const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const importer = require('./import');
const riskAssessments = require('./riskAssessments');
const permitPdf = require('./permitPdf');
const cadDxf = require('./cadDxf');
const cadPdf = require('./cadPdf');
const { supabase, DOCUMENTS_BUCKET } = require('./supabaseClient');

const app = express();
const PORT = process.env.PORT || 3000;
// Render sits in front of the app behind exactly one reverse-proxy hop, which sets
// X-Forwarded-For - trusting exactly that one hop (not `true`, which would trust every hop
// and let a client spoof its own IP) lets the login/register rate limiters below identify
// real client IPs instead of only ever seeing Render's proxy address for everyone.
app.set('trust proxy', 1);

// CSP is left off deliberately: the app relies on inline style attributes (e.g. calendar
// swatch colours) that helmet's default policy would otherwise block.
app.use(helmet({ contentSecurityPolicy: false }));

function allowlistFilter(allowedRe, expectedLabel) {
  return (req, file, cb) => {
    if (!allowedRe.test(file.originalname)) {
      return cb(new Error(`"${file.originalname}" isn't an allowed file type - expected ${expectedLabel}`));
    }
    cb(null, true);
  };
}

const IMAGE_FILE_RE = /\.(jpe?g|png|webp|heic|heif|gif)$/i;
const SPREADSHEET_FILE_RE = /\.xlsx?$/i;
// Blocklist rather than an allowlist for the general document upload below - drawings, RAMS,
// permits and subby forms come in enough legitimate formats (CAD exports, scans, office docs)
// that guessing a safe allowlist risks rejecting something genuinely in use today. This still
// stops the actual risk (a disguised executable or script filed under a document category)
// without touching any file type already being uploaded.
const BLOCKED_FILE_RE = /\.(exe|msi|bat|cmd|sh|com|scr|vbs?|vbe|jse?|jar|ps1|psm1|dll|apk|dmg|iso|reg)$/i;

function blockDangerousFiles(req, file, cb) {
  if (BLOCKED_FILE_RE.test(file.originalname)) {
    return cb(new Error(`"${file.originalname}" isn't an allowed file type.`));
  }
  cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: allowlistFilter(SPREADSHEET_FILE_RE, 'an Excel file (.xls/.xlsx)'),
});
const uploadDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: blockDangerousFiles,
});
// Stricter than uploadDocument - only ever used for the operative's on-site photo upload,
// which should only ever actually be a photo.
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: allowlistFilter(IMAGE_FILE_RE, 'an image file'),
});

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
// unref() so this timer alone never keeps the process alive - irrelevant in normal operation
// (the HTTP listener already does that), but it means requiring this file in a test doesn't
// leave a dangling interval behind.
setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 20000).unref();

// ---------- Job documents (RAMS, drawings, permits, photos) ----------
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

// CAD drawing thumbnails (the drawing itself lives in Postgres as JSON - see db.js) live
// under this fixed prefix in the same bucket.
function cadDrawingStoragePath(storedName) {
  return `_library/cad/${storedName}`;
}

// Profile photos live under this fixed prefix in the same bucket - see setUserAvatar in db.js.
function avatarStoragePath(storedName) {
  return `_library/avatars/${storedName}`;
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
// Phones (and some carrier/office networks) cache static JS/HTML far more aggressively
// than "max-age=0" implies in practice, so people were stuck on stale nav markup/JS
// after a deploy even after a manual refresh. no-store forces every request to fetch
// the current file instead of trusting a cached copy.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));

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

function setSessionCookie(res, token) {
  // secure:true is safe unconditionally here - Render only ever serves this app over HTTPS,
  // so there's no legitimate plain-HTTP request for the cookie to need to ride along on.
  // No maxAge - this is deliberately a browser-session cookie (dies when the browser/tab is
  // fully closed), not a "stay signed in" one, so opening the app fresh always means signing
  // in and entering a 2FA code again. db.js's SESSION_TTL_MS backs this up server-side in
  // case a browser or PWA holds onto the cookie longer than it should.
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: true });
}

// ---------- Auth ----------
// These routes are intentionally registered before the auth-required gate below, since you
// can't be logged in yet when hitting them.

// Slows down password-guessing against a real account without adding any extra step for a
// legitimate sign-in - keyed by IP, generous enough that a real user mistyping their password
// a few times in a row never hits it.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts - wait a few minutes and try again.' },
});
// Registration is open to anyone who reaches this route (see the access-code check inside),
// so it gets the same throttle to stop it being hammered for either brute-forcing that code
// or spamming new accounts.
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts - wait a few minutes and try again.' },
});

app.post('/api/auth/register', registerLimiter, handle(async (req, res) => {
  // Registration is otherwise open to anyone who finds the app's URL, so a shared code
  // (set as the REGISTRATION_CODE env var, same convention as the Supabase config) gates it
  // to people the office has actually told - no email verification or approval step, just
  // one more field on the same form.
  if (!process.env.REGISTRATION_CODE) throw new Error('Registration is not configured - ask an admin to set REGISTRATION_CODE.');
  if ((req.body.accessCode || '').trim() !== process.env.REGISTRATION_CODE) {
    throw new Error('That access code is incorrect - check with the office.');
  }
  const user = await db.registerUser(req.body);
  setSessionCookie(res, await db.createSession(user.id));
  res.status(201).json(user);
}));

app.post('/api/auth/login', loginLimiter, handle(async (req, res) => {
  const user = await db.verifyLogin(req.body.email, req.body.password);
  // Password's right, but that's only half the story for an MFA account - hand back a
  // short-lived challenge token instead of a session, so the browser knows to prompt for a
  // code next. No cookie is set until /api/auth/mfa/verify-login confirms it.
  if (user.mfaEnabled) {
    const mfaToken = await db.createMfaChallenge(user.id);
    return res.json({ mfaRequired: true, mfaToken });
  }
  setSessionCookie(res, await db.createSession(user.id));
  res.json(user);
}));

// Same throttle as the password step - keyed by IP, generous for a real user fumbling their
// authenticator app but slow going for anyone trying to brute-force a 6-digit code.
app.post('/api/auth/mfa/verify-login', loginLimiter, handle(async (req, res) => {
  const user = await db.verifyMfaChallenge(req.body.mfaToken, req.body.code);
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

// MFA is mandatory for every account, regardless of role - until someone's completed setup
// (mfa_enabled true), the only things they can do are check who they are (/auth/me, above -
// already reachable pre-gate), sign out (/auth/logout, also pre-gate), or finish setting it
// up. See startMfaSetup/confirmMfaSetup in db.js and the forced setup screen in app.js that
// routes people here until they've done it.
const MFA_SETUP_ROUTES = [
  { method: 'POST', path: /^\/auth\/mfa\/setup$/ },
  { method: 'POST', path: /^\/auth\/mfa\/confirm$/ },
];

app.use('/api', (req, res, next) => {
  if (!req.user.mfaEnabled && !MFA_SETUP_ROUTES.some((r) => r.method === req.method && r.path.test(req.path))) {
    // mfaSetupRequired is a distinct flag (not just the 403 status) so the frontend can tell
    // this apart from an ordinary role-based 403 like "Admins only" and route to the forced
    // setup screen instead of just toasting an error - see the api() helper in app.js.
    return res.status(403).json({ error: 'Set up two-factor authentication to continue.', mfaSetupRequired: true });
  }
  next();
});

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

// The CAD section is a surveyor tool as much as an admin one - unlike most admin-gated
// features, surveyors need full read/write here, not just view.
function requireAdminOrSurveyor(req, res, next) {
  if (!['admin', 'surveyor'].includes(req.user.role)) return res.status(403).json({ error: 'Admins and surveyors only' });
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
  // Every role gets to protect their own account, same reasoning as the colour picker above.
  { method: 'POST', path: /^\/auth\/mfa\/setup$/ },
  { method: 'POST', path: /^\/auth\/mfa\/confirm$/ },
  { method: 'GET', path: /^\/diary$/ },
  { method: 'POST', path: /^\/diary$/ },
  { method: 'PUT', path: /^\/diary\/[^/]+\/complete$/ },
  { method: 'PUT', path: /^\/diary\/[^/]+$/ },
  { method: 'DELETE', path: /^\/diary\/[^/]+$/ },
  { method: 'GET', path: /^\/minigame\/today$/ },
  { method: 'POST', path: /^\/minigame\/score$/ },
  // Profile: viewing anyone's profile/photo is open to every role (Employees tab +
  // job-assignment click-through); the `me` routes are this role's own photo/qualifications,
  // same "me" trick as the colour picker above. Editing someone ELSE's profile stays
  // requireAdmin-gated in the route handlers themselves, so it needs no entry here.
  { method: 'GET', path: /^\/users\/[^/]+\/profile$/ },
  { method: 'GET', path: /^\/users\/[^/]+\/photo$/ },
  { method: 'POST', path: /^\/users\/me\/photo$/ },
  { method: 'DELETE', path: /^\/users\/me\/photo$/ },
  { method: 'POST', path: /^\/users\/me\/qualifications$/ },
  { method: 'PUT', path: /^\/users\/qualifications\/[^/]+$/ },
  { method: 'DELETE', path: /^\/users\/qualifications\/[^/]+$/ },
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
  { method: 'GET', path: /^\/risk-assessments$/ },
  { method: 'POST', path: /^\/job-assignments\/[^/]+\/rams$/ },
  { method: 'GET', path: /^\/job-assignments\/[^/]+\/rams$/ },
  { method: 'POST', path: /^\/job-assignments\/[^/]+\/rams\/attach-to-job$/ },
  { method: 'GET', path: /^\/job-assignments\/[^/]+\/rams-status$/ },
  { method: 'GET', path: /^\/job-assignments\/[^/]+\/rams-status\/[^/]+\/file$/ },
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

app.put('/api/users/:id/active', requireAdmin, handle(async (req, res) => {
  const user = await db.setUserActive(req.params.id, !!req.body.active);
  broadcast('users');
  res.json(user);
}));

app.put('/api/users/:id/employee', requireAdmin, handle(async (req, res) => {
  const user = await db.setUserEmployee(req.params.id, req.body.employeeId || null);
  broadcast('users');
  res.json(user);
}));

// Lost-phone recovery for someone else's MFA - see adminResetMfa in db.js. This is the only
// way to clear an account's 2FA; there's no self-service disable (see the note in db.js).
app.put('/api/users/:id/mfa-reset', requireAdmin, handle(async (req, res) => {
  const user = await db.adminResetMfa(req.params.id);
  broadcast('users');
  res.json(user);
}));

// ---------- MFA (self-service) ----------

app.post('/api/auth/mfa/setup', handle(async (req, res) => {
  res.json(await db.startMfaSetup(req.user.id, req.user.email));
}));

app.post('/api/auth/mfa/confirm', handle(async (req, res) => {
  const user = await db.confirmMfaSetup(req.user.id, req.body.code);
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

// ---------- Profiles (photo + qualifications) ----------
// Profile/photo reads are open to every role (Employees tab + job-assignment click-through);
// self-service writes use a literal `me` in the path so the STAFF/OPERATIVE route allowlist
// below can match them without knowing each user's id ahead of time. Admin-on-someone-else's-
// behalf routes use the real :id and are requireAdmin-gated instead.

app.get('/api/users/:id/profile', handle(async (req, res) => {
  const profile = await db.getUserProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'User not found' });
  res.json(profile);
}));

app.get('/api/users/:id/photo', handle(async (req, res) => {
  const storedName = await db.getUserAvatarStoredName(req.params.id);
  if (!storedName) return res.status(404).json({ error: 'No photo set' });
  const { data, error } = await supabase.storage.from(DOCUMENTS_BUCKET).download(avatarStoragePath(storedName));
  if (error) return res.status(404).json({ error: 'File not found in storage' });
  const buffer = Buffer.from(await data.arrayBuffer());
  res.setHeader('Content-Type', data.type || 'image/jpeg');
  res.send(buffer);
}));

async function replaceUserAvatar(userId, file, res) {
  if (!file) throw new Error('A photo is required');
  const storedName = makeStoredName(file.originalname);
  const { error } = await supabase.storage.from(DOCUMENTS_BUCKET)
    .upload(avatarStoragePath(storedName), file.buffer, { contentType: file.mimetype || 'application/octet-stream' });
  if (error) throw new Error(error.message);
  const previousStoredName = await db.setUserAvatar(userId, storedName);
  if (previousStoredName) await supabase.storage.from(DOCUMENTS_BUCKET).remove([avatarStoragePath(previousStoredName)]);
  broadcast('users');
  res.status(201).json({ ok: true });
}

app.post('/api/users/me/photo', uploadImage.single('file'), handle(async (req, res) => {
  await replaceUserAvatar(req.user.id, req.file, res);
}));

app.delete('/api/users/me/photo', handle(async (req, res) => {
  const previousStoredName = await db.clearUserAvatar(req.user.id);
  if (previousStoredName) await supabase.storage.from(DOCUMENTS_BUCKET).remove([avatarStoragePath(previousStoredName)]);
  broadcast('users');
  res.status(204).end();
}));

app.post('/api/users/:id/photo', requireAdmin, uploadImage.single('file'), handle(async (req, res) => {
  await replaceUserAvatar(req.params.id, req.file, res);
}));

app.delete('/api/users/:id/photo', requireAdmin, handle(async (req, res) => {
  const previousStoredName = await db.clearUserAvatar(req.params.id);
  if (previousStoredName) await supabase.storage.from(DOCUMENTS_BUCKET).remove([avatarStoragePath(previousStoredName)]);
  broadcast('users');
  res.status(204).end();
}));

app.post('/api/users/me/qualifications', handle(async (req, res) => {
  const qualification = await db.addUserQualification(req.user.id, req.body);
  broadcast('users');
  res.status(201).json(qualification);
}));

app.post('/api/users/:id/qualifications', requireAdmin, handle(async (req, res) => {
  const qualification = await db.addUserQualification(req.params.id, req.body);
  broadcast('users');
  res.status(201).json(qualification);
}));

app.put('/api/users/qualifications/:qid', handle(async (req, res) => {
  const qualification = await db.updateUserQualification(req.params.qid, req.body, req.user);
  broadcast('users');
  res.json(qualification);
}));

app.delete('/api/users/qualifications/:qid', handle(async (req, res) => {
  await db.deleteUserQualification(req.params.qid, req.user);
  broadcast('users');
  res.status(204).end();
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

// Every operative's assignment + clock-in/arrived/completed/clock-out log for this job in one
// place, so the Jobs tab's Team section can both display and manage assignments (add/edit/
// delete) without a separate Job Assignments tab. Not operative-reachable (they don't have
// Jobs tab access anyway - see OPERATIVE_ALLOWED_ROUTES). Returns the full assignment row
// (id/jobId/userId/etc, not just a narrow display subset) since the frontend reuses this
// response to drive edit/delete and to feed the Time Log / RAMS modals' lookups.
app.get('/api/jobs/:id/time-logs', handle(async (req, res) => {
  if (!JOB_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid job id' });
  const assignments = await db.listJobAssignmentsForJob(req.params.id);
  const withLogs = await Promise.all(assignments.map(async (a) => ({
    ...a,
    timeLogs: await db.listTimeLogs(a.id),
  })));
  res.json(withLogs);
}));

// ---------- Job Costing (profit/loss) ----------
// Not operative/staff-reachable (they don't have Jobs tab access at all - see the allowlists
// above), same as every other Job Detail route; admin and surveyor both pass through
// untouched, same access level they already have over the rest of a job's detail.

app.get('/api/jobs/:id/costing', handle(async (req, res) => {
  if (!JOB_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid job id' });
  res.json(await db.getJobCostingSummary(req.params.id));
}));

app.post('/api/jobs/:id/costing/lines', handle(async (req, res) => {
  if (!JOB_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid job id' });
  const line = await db.createJobCostingLine(req.params.id, req.body);
  broadcast('jobs');
  res.status(201).json(line);
}));

app.put('/api/costing-lines/:id', handle(async (req, res) => {
  const line = await db.updateJobCostingLine(req.params.id, req.body);
  broadcast('jobs');
  res.json(line);
}));

app.delete('/api/costing-lines/:id', handle(async (req, res) => {
  await db.deleteJobCostingLine(req.params.id);
  broadcast('jobs');
  res.status(204).end();
}));

app.put('/api/jobs/:id/costing/labour/:userId', handle(async (req, res) => {
  if (!JOB_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid job id' });
  await db.setJobCostingLabourHours(req.params.id, req.params.userId, req.body.hours);
  broadcast('jobs');
  res.json(await db.getJobCostingLabour(req.params.id));
}));

app.delete('/api/jobs/:id/costing/labour/:userId', handle(async (req, res) => {
  if (!JOB_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid job id' });
  await db.clearJobCostingLabourHours(req.params.id, req.params.userId);
  broadcast('jobs');
  res.json(await db.getJobCostingLabour(req.params.id));
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
  const job = await db.completeJob(req.params.id, req.user);
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
  // RAMS, photos and permits are meant to be reviewed on the spot (e.g. an operative or
  // surveyor checking one on their phone), not saved to disk first - inline + the real
  // content type lets the browser render it straight away (Chrome/Edge's built-in PDF and
  // image viewers), same as clicking a PDF/image link anywhere else on the web. Drawings
  // keep the old "always download" behaviour, unchanged.
  if (['rams', 'photos', 'permit'].includes(req.params.category)) {
    res.setHeader('Content-Type', data.type || 'application/pdf');
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

// Marks an old drawing/document revision as superseded (or un-marks it) without deleting it -
// a manual flag, not automatic on upload, since RAMS/photos deliberately keep every one.
app.put('/api/jobs/:id/documents/:category/:docId/superseded', validateDocumentParams, handle(async (req, res) => {
  const doc = await db.toggleDocumentSuperseded(req.params.id, req.params.category, req.params.docId, !!req.body.superseded);
  broadcast('jobs');
  res.json(doc);
}));

// Everything on a job (RAMS, drawings, permits, photos) bundled into one zip, named
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

// Shared "load this assignment, 404 if missing, 403 if not allowed" check used by every
// operative self-service job-assignment route below - collapses what was 11 near-identical
// copies of this same block into one place. `strict: true` means only the assignment's own
// operative may proceed (clock-in, RAMS/permit/photo submission - things that write); the
// default (false) also lets admin/surveyor through regardless of whose assignment it is,
// matching the unrestricted view they already have over the rest of a job (used by read
// routes admin/surveyor share with operatives, e.g. time-logs/RAMS viewing).
async function loadOwnedAssignment(req, res, message, { strict = false } = {}) {
  const assignment = await db.getJobAssignment(req.params.id);
  if (!assignment) { res.status(404).json({ error: 'Assignment not found' }); return null; }
  const blocked = strict
    ? assignment.userId !== req.user.id
    : db.OPERATIVE_ROLES.includes(req.user.role) && assignment.userId !== req.user.id;
  if (blocked) { res.status(403).json({ error: message }); return null; }
  return assignment;
}

// Clock in/arrived/clock out - ownership-checked here (db.js's clockIn/markArrived/clockOut
// trust the assignmentId they're given, same convention as addJobDocument etc), timestamps
// are always server-stamped inside those functions, never taken from the request body.
app.post('/api/job-assignments/:id/time/clock-in', handle(async (req, res) => {
  const assignment = await loadOwnedAssignment(req, res, 'You can only clock in on your own assignment', { strict: true });
  if (!assignment) return;
  const log = await db.clockIn(req.params.id);
  broadcast('jobAssignments');
  res.json(log);
}));

app.post('/api/job-assignments/:id/time/arrived', handle(async (req, res) => {
  const assignment = await loadOwnedAssignment(req, res, 'You can only mark yourself arrived on your own assignment', { strict: true });
  if (!assignment) return;
  const log = await db.markArrived(req.params.id);
  broadcast('jobAssignments');
  res.json(log);
}));

app.post('/api/job-assignments/:id/time/clock-out', handle(async (req, res) => {
  const assignment = await loadOwnedAssignment(req, res, 'You can only clock out on your own assignment', { strict: true });
  if (!assignment) return;
  const log = await db.clockOut(req.params.id);
  broadcast('jobAssignments');
  res.json(log);
}));

// Admin/surveyor get the same unrestricted view they already have over the rest of an
// assignment; an operative can only ever see their own (they never reach this route for
// someone else's assignment anyway - see OPERATIVE_ALLOWED_ROUTES - but the check stays
// here too since admin/surveyor share this same route and aren't operatives).
app.get('/api/job-assignments/:id/time-logs', handle(async (req, res) => {
  const assignment = await loadOwnedAssignment(req, res, 'You can only view time logs for your own assignment');
  if (!assignment) return;
  res.json(await db.listTimeLogs(req.params.id));
}));

// Narrow, purpose-built upload: hardcoded to the 'photos' category, and verified against
// the assignment's own job_id + user_id = req.user.id server-side - deliberately NOT the
// generic /api/jobs/:id/documents/:category route (that one is unrestricted-by-design for
// office roles across every category on any job, which is too broad to hand to operatives).
app.post('/api/job-assignments/:id/photo', uploadImage.single('file'), handle(async (req, res) => {
  if (!req.file) throw new Error('No file uploaded');
  const assignment = await loadOwnedAssignment(req, res, 'You can only upload photos against your own assignment', { strict: true });
  if (!assignment) return;
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
  const assignment = await loadOwnedAssignment(req, res, 'You can only save a permit against your own assignment', { strict: true });
  if (!assignment) return;

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

// ---------- Job Assignment RAMS ----------
// One RAMS submission per assignment (see the schema comment on job_assignment_rams) - the
// structured record (used for the markArrived gate and the operative's own edit/view) lives in
// job_assignment_rams, kept as-is (signature stored as the raw data URL, not decoded/embedded).
// On every save this ALSO renders an HTML snapshot (riskAssessments.renderRamsHtml) and drops it
// into the job's 'rams' document category, same as attaching a generic/library/custom risk
// assessment - so surveyors/admins reviewing everything on a job (not just the Job Assignments
// tab) see it there too. Saving again before Arrived (see the lock in db.js) adds another
// snapshot rather than replacing the old one - a running history of what changed is preferable
// to silently overwriting a HSE-relevant record.

async function attachRamsToJobDocuments(assignment, rams) {
  const html = riskAssessments.renderRamsHtml({
    methodStatement: rams.methodStatement,
    hazards: rams.hazards,
    operativeName: rams.operativeName,
    signatureImage: rams.signatureImage,
    createdAt: rams.createdAt,
    jobReference: assignment.jobReference || assignment.jobClient,
    task: assignment.task,
  });
  const originalName = `RAMS - ${rams.operativeName} - ${new Date(rams.createdAt).toLocaleDateString('en-GB')}.html`;
  const storedName = makeStoredName(originalName);
  const { error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(storagePath(assignment.jobId, 'rams', storedName), Buffer.from(html, 'utf8'), { contentType: 'text/html' });
  if (error) throw new Error(error.message);
  return db.addJobDocument(assignment.jobId, 'rams', {
    originalName,
    storedName,
    size: Buffer.byteLength(html, 'utf8'),
  });
}

app.post('/api/job-assignments/:id/rams', handle(async (req, res) => {
  const assignment = await loadOwnedAssignment(req, res, 'You can only save RAMS against your own assignment', { strict: true });
  if (!assignment) return;

  if (!decodePngDataUrl(req.body.signatureImage)) throw new Error('Sign before saving');

  const rams = await db.createJobAssignmentRams(req.params.id, req.body);
  await attachRamsToJobDocuments(assignment, rams);

  broadcast('jobAssignments');
  broadcast('jobs'); // so an admin/surveyor with the Job Detail RAMS tab open sees it live
  res.status(201).json(rams);
}));

app.get('/api/job-assignments/:id/rams', handle(async (req, res) => {
  const assignment = await loadOwnedAssignment(req, res, 'You can only view RAMS for your own assignment');
  if (!assignment) return;
  res.json(await db.getJobAssignmentRams(req.params.id));
}));

// Job-level RAMS status for the Assignment Detail modal (see markArrived/
// getJobAssignmentRamsStatus in db.js) - whether the job already has RAMS on file at all,
// so only one operative assigned to it ever needs to fill in the dynamic form, plus the
// list of those documents so the rest can just read them. Same ownership rule as above.
app.get('/api/job-assignments/:id/rams-status', handle(async (req, res) => {
  const assignment = await loadOwnedAssignment(req, res, 'You can only view RAMS status for your own assignment');
  if (!assignment) return;
  res.json(await db.getJobAssignmentRamsStatus(req.params.id));
}));

// Narrow, purpose-built read of one of those job-level RAMS documents via an operative's own
// assignment - deliberately not the generic /api/jobs/:id/documents/:category/:docId/file
// route, which is unrestricted-by-design for office roles and has no ownership check at all
// (same reasoning as the /photo route above).
app.get('/api/job-assignments/:id/rams-status/:docId/file', handle(async (req, res) => {
  const assignment = await loadOwnedAssignment(req, res, 'You can only view RAMS documents for your own assignment');
  if (!assignment) return;
  const doc = await db.getJobDocument(assignment.jobId, 'rams', req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .download(storagePath(assignment.jobId, 'rams', doc.storedName));
  if (error) return res.status(404).json({ error: 'File not found in storage' });
  const buffer = Buffer.from(await data.arrayBuffer());
  const filename = doc.originalName.replace(/[^a-zA-Z0-9_.\- ]/g, '_');
  res.setHeader('Content-Type', data.type || 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(buffer);
}));

// Manual re-sync for RAMS submitted before this auto-attach behaviour existed (or if the upload
// step ever fails at submit time) - regenerates the HTML snapshot from the existing structured
// record and files it under the job's documents, same as the automatic path above. Same
// ownership rule as the GET route below: the assignment's own operative, or admin/surveyor.
app.post('/api/job-assignments/:id/rams/attach-to-job', handle(async (req, res) => {
  const assignment = await loadOwnedAssignment(req, res, 'You can only attach RAMS for your own assignment');
  if (!assignment) return;
  const rams = await db.getJobAssignmentRams(req.params.id);
  if (!rams) return res.status(404).json({ error: 'No RAMS submitted for this assignment yet' });

  const doc = await attachRamsToJobDocuments(assignment, rams);
  broadcast('jobs');
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

// ---------- CAD Drawings ----------
// Standalone 2D drafting tool for admins/surveyors (floor plans, elevations, dimensioned
// site layouts) - see public/cad.js for the editor and scripts/supabase-schema.sql for the
// scene_data JSON shape. Every route here is admin/surveyor only; delete is admin-only,
// matching how the saved-risk-assessments library treats delete as more sensitive than
// create/read/update.

app.get('/api/cad-drawings', requireAdminOrSurveyor, handle(async (req, res) => {
  res.json(await db.listCadDrawings());
}));

app.get('/api/cad-drawings/:id', requireAdminOrSurveyor, handle(async (req, res) => {
  const drawing = await db.getCadDrawing(req.params.id);
  if (!drawing) return res.status(404).json({ error: 'Drawing not found' });
  res.json(drawing);
}));

app.post('/api/cad-drawings', requireAdminOrSurveyor, handle(async (req, res) => {
  const drawing = await db.addCadDrawing({
    name: req.body.name,
    sceneData: req.body.sceneData,
    createdBy: req.user.name,
  });
  res.status(201).json(drawing);
}));

app.put('/api/cad-drawings/:id', requireAdminOrSurveyor, handle(async (req, res) => {
  const drawing = await db.updateCadDrawing(req.params.id, {
    name: req.body.name,
    sceneData: req.body.sceneData,
    updatedBy: req.user.name,
  });
  if (!drawing) return res.status(404).json({ error: 'Drawing not found' });
  res.json(drawing);
}));

app.delete('/api/cad-drawings/:id', requireAdmin, handle(async (req, res) => {
  const drawing = await db.deleteCadDrawing(req.params.id);
  if (!drawing) return res.status(404).json({ error: 'Drawing not found' });
  if (drawing.thumbnailStoredName) {
    await supabase.storage.from(DOCUMENTS_BUCKET).remove([cadDrawingStoragePath(drawing.thumbnailStoredName)]);
  }
  res.status(204).end();
}));

app.post('/api/cad-drawings/:id/thumbnail', requireAdminOrSurveyor, uploadImage.single('file'), handle(async (req, res) => {
  if (!req.file) throw new Error('No file uploaded');
  const drawing = await db.getCadDrawing(req.params.id);
  if (!drawing) return res.status(404).json({ error: 'Drawing not found' });
  const storedName = makeStoredName('thumbnail.png');
  const { error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(cadDrawingStoragePath(storedName), req.file.buffer, { contentType: 'image/png' });
  if (error) throw new Error(error.message);
  if (drawing.thumbnailStoredName) {
    await supabase.storage.from(DOCUMENTS_BUCKET).remove([cadDrawingStoragePath(drawing.thumbnailStoredName)]);
  }
  const updated = await db.setCadDrawingThumbnail(req.params.id, storedName);
  res.status(201).json(updated);
}));

app.get('/api/cad-drawings/:id/thumbnail', requireAdminOrSurveyor, handle(async (req, res) => {
  const drawing = await db.getCadDrawing(req.params.id);
  if (!drawing || !drawing.thumbnailStoredName) return res.status(404).json({ error: 'No thumbnail' });
  const { data, error } = await supabase.storage.from(DOCUMENTS_BUCKET).download(cadDrawingStoragePath(drawing.thumbnailStoredName));
  if (error) return res.status(404).json({ error: 'File not found in storage' });
  const buffer = Buffer.from(await data.arrayBuffer());
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
}));

app.get('/api/cad-drawings/:id/export/dxf', requireAdminOrSurveyor, handle(async (req, res) => {
  const drawing = await db.getCadDrawing(req.params.id);
  if (!drawing) return res.status(404).json({ error: 'Drawing not found' });
  const dxf = cadDxf.sceneToDxf(drawing.sceneData);
  const filename = drawing.name.replace(/[^a-zA-Z0-9_.\- ]/g, '_');
  res.setHeader('Content-Type', 'application/dxf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.dxf"`);
  res.send(dxf);
}));

app.get('/api/cad-drawings/:id/export/pdf', requireAdminOrSurveyor, handle(async (req, res) => {
  const drawing = await db.getCadDrawing(req.params.id);
  if (!drawing) return res.status(404).json({ error: 'Drawing not found' });
  const pdfBuffer = await cadPdf.generateCadPdf(drawing);
  const filename = drawing.name.replace(/[^a-zA-Z0-9_.\- ]/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
  res.send(pdfBuffer);
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

// ---------- Mini-Game ----------

app.get('/api/minigame/today', handle(async (req, res) => {
  res.json(await db.getMiniGameToday(req.user));
}));

app.post('/api/minigame/score', handle(async (req, res) => {
  const result = await db.submitMiniGameScore(req.user, req.body);
  broadcast('minigame');
  res.json(result);
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

// Catches errors that happen before a route's own handle() wrapper can (multer's file-size/
// file-type rejections are the main case - they fire in middleware, ahead of the route body),
// so they reach the browser as the same clean {error} JSON shape as everything else instead
// of Express's default HTML/stack-trace page.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(400).json({ error: err.message || 'Request failed' });
});

// Guarded so requiring this file (e.g. from test/permissions.test.js, to exercise the real
// route allowlists below without duplicating them) never actually binds a port - only running
// it directly (`node server.js` / `npm start`) does.
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`BD Construction Job Tracker running at http://localhost:${PORT}`);
    console.log('Other devices on your office network can connect using your PC\'s IP address, e.g. http://192.168.x.x:' + PORT);
  });
}

module.exports = { app, STAFF_ALLOWED_ROUTES, OPERATIVE_ALLOWED_ROUTES, CALENDAR_DIARY_ROUTES };
