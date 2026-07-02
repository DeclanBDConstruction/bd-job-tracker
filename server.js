const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const importer = require('./import');
const riskAssessments = require('./riskAssessments');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ---------- Job documents (RAMS, drawings, sign-off sheets, photos) ----------

const UPLOADS_ROOT = path.join(__dirname, 'data', 'uploads');
const JOB_ID_RE = /^[0-9a-f-]{36}$/i;

const documentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOADS_ROOT, req.params.id, req.params.category);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9_.\- ]/g, '_');
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`);
  },
});
const uploadDocument = multer({ storage: documentStorage, limits: { fileSize: 25 * 1024 * 1024 } });

// Runs before multer touches the filesystem, so a bad job id or category never gets used to
// build a disk path.
function validateDocumentParams(req, res, next) {
  if (!JOB_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid job id' });
  if (!db.DOCUMENT_CATEGORIES.includes(req.params.category)) return res.status(400).json({ error: 'Invalid document category' });
  if (!db.getJob(req.params.id)) return res.status(404).json({ error: 'Job not found' });
  next();
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
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

app.post('/api/auth/register', handle((req, res) => {
  const user = db.registerUser(req.body);
  setSessionCookie(res, db.createSession(user.id));
  res.status(201).json(user);
}));

app.post('/api/auth/login', handle((req, res) => {
  const user = db.verifyLogin(req.body.email, req.body.password);
  setSessionCookie(res, db.createSession(user.id));
  res.json(user);
}));

app.post('/api/auth/logout', handle((req, res) => {
  const { sid } = parseCookies(req);
  if (sid) db.deleteSession(sid);
  res.clearCookie('sid');
  res.status(204).end();
}));

app.get('/api/auth/me', handle((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  res.json(user);
}));

// Everything below this line requires a signed-in user.
app.use('/api', (req, res, next) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  next();
});

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

// ---------- Users (admin) ----------

app.get('/api/users', requireAdmin, handle((req, res) => {
  res.json(db.listUsers());
}));

app.post('/api/users/:id/promote', requireAdmin, handle((req, res) => {
  res.json(db.promoteToAdmin(req.params.id));
}));

// ---------- Employees ----------

app.get('/api/employees', handle((req, res) => {
  res.json(db.listEmployees());
}));

app.post('/api/employees', requireAdmin, handle((req, res) => {
  res.status(201).json(db.addEmployee(req.body.name));
}));

app.put('/api/employees/:id', requireAdmin, handle((req, res) => {
  res.json(db.renameEmployee(req.params.id, req.body.name));
}));

app.delete('/api/employees/:id', requireAdmin, handle((req, res) => {
  db.deleteEmployee(req.params.id);
  res.status(204).end();
}));

// ---------- Jobs ----------

app.get('/api/jobs', handle((req, res) => {
  res.json(db.listJobs());
}));

app.get('/api/jobs/:id', handle((req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
}));

app.post('/api/jobs', handle((req, res) => {
  res.status(201).json(db.createJob(req.body));
}));

app.put('/api/jobs/:id', handle((req, res) => {
  res.json(db.updateJob(req.params.id, req.body));
}));

app.delete('/api/jobs/:id', requireAdmin, handle((req, res) => {
  db.deleteJob(req.params.id);
  fs.rm(path.join(UPLOADS_ROOT, req.params.id), { recursive: true, force: true }, () => {});
  res.status(204).end();
}));

app.post('/api/jobs/:id/complete', handle((req, res) => {
  res.json(db.completeJob(req.params.id));
}));

app.post('/api/jobs/:id/reopen', handle((req, res) => {
  res.json(db.reopenJob(req.params.id));
}));

app.post('/api/jobs/:id/documents/:category', validateDocumentParams, uploadDocument.single('file'), handle((req, res) => {
  if (!req.file) throw new Error('No file uploaded');
  const doc = db.addJobDocument(req.params.id, req.params.category, {
    originalName: req.file.originalname,
    storedName: req.file.filename,
    size: req.file.size,
  });
  res.status(201).json(doc);
}));

app.get('/api/jobs/:id/documents/:category/:docId/file', validateDocumentParams, handle((req, res) => {
  const doc = db.getJobDocument(req.params.id, req.params.category, req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  res.download(path.join(UPLOADS_ROOT, req.params.id, req.params.category, doc.storedName), doc.originalName);
}));

app.delete('/api/jobs/:id/documents/:category/:docId', validateDocumentParams, handle((req, res) => {
  const doc = db.deleteJobDocument(req.params.id, req.params.category, req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  fs.unlink(path.join(UPLOADS_ROOT, req.params.id, req.params.category, doc.storedName), () => {});
  res.status(204).end();
}));

// ---------- Risk Assessments ----------

app.get('/api/risk-assessments', handle((req, res) => {
  res.json(riskAssessments.listRiskAssessments());
}));

app.get('/api/risk-assessments/:id/download', handle((req, res) => {
  const ra = riskAssessments.getRiskAssessment(req.params.id);
  if (!ra) return res.status(404).json({ error: 'Risk assessment not found' });
  const html = riskAssessments.renderHtml(ra);
  res.setHeader('Content-Disposition', `attachment; filename="${ra.title.replace(/[^a-zA-Z0-9_.\- ]/g, '_')} - Risk Assessment.html"`);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
}));

app.post('/api/jobs/:id/risk-assessments/:raId/attach', handle((req, res) => {
  if (!JOB_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid job id' });
  if (!db.getJob(req.params.id)) return res.status(404).json({ error: 'Job not found' });
  const ra = riskAssessments.getRiskAssessment(req.params.raId);
  if (!ra) return res.status(404).json({ error: 'Risk assessment not found' });

  const html = riskAssessments.renderHtml(ra);
  const originalName = `${ra.title} - Risk Assessment.html`;
  const safeName = originalName.replace(/[^a-zA-Z0-9_.\- ]/g, '_');
  const storedName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
  const dir = path.join(UPLOADS_ROOT, req.params.id, 'rams');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, storedName), html);

  const doc = db.addJobDocument(req.params.id, 'rams', {
    originalName,
    storedName,
    size: Buffer.byteLength(html),
  });
  res.status(201).json(doc);
}));

// ---------- Calendar ----------

app.get('/api/calendar', handle((req, res) => {
  res.json(db.listCalendarEvents());
}));

app.post('/api/calendar', handle((req, res) => {
  res.status(201).json(db.createCalendarEvent(req.body, req.user));
}));

app.delete('/api/calendar/:id', handle((req, res) => {
  db.deleteCalendarEvent(req.params.id, req.user);
  res.status(204).end();
}));

// ---------- Status list ----------

app.get('/api/statuses', handle((req, res) => {
  res.json(db.DEFAULT_STATUSES);
}));

// ---------- Import ----------

app.post('/api/import/jobsheet', upload.single('file'), handle((req, res) => {
  if (!req.file) throw new Error('No file uploaded');
  res.json(importer.parseJobSheet(req.file.buffer));
}));

// ---------- Reports ----------

app.get('/api/reports/yearly', handle((req, res) => {
  res.json(db.yearlyReport());
}));

app.get('/api/reports/clients', handle((req, res) => {
  res.json(db.clientReport());
}));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`BD Construction Job Tracker running at http://localhost:${PORT}`);
  console.log('Other devices on your office network can connect using your PC\'s IP address, e.g. http://192.168.x.x:' + PORT);
});
