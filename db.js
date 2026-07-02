const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_STATUSES = ['Won', 'In Progress', 'Complete', 'Invoiced', 'Lost', 'Cancelled'];
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function emptyState() {
  return { employees: [], jobs: [], users: [], sessions: [], calendarEvents: [] };
}

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(emptyState(), null, 2));
  }
}

function load() {
  ensureFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.employees) parsed.employees = [];
    if (!parsed.jobs) parsed.jobs = [];
    if (!parsed.users) parsed.users = [];
    if (!parsed.sessions) parsed.sessions = [];
    if (!parsed.calendarEvents) parsed.calendarEvents = [];
    return parsed;
  } catch (e) {
    throw new Error('Data file is corrupted: ' + e.message);
  }
}

function save(state) {
  // Write to a temp file then rename, so a crash mid-write can't corrupt db.json
  const tmpFile = DATA_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);
}

function genId() {
  return crypto.randomUUID();
}

// ---------- Employees ----------

function listEmployees() {
  return load().employees.sort((a, b) => a.name.localeCompare(b.name));
}

function findEmployeeByName(state, name) {
  const norm = name.trim().toLowerCase();
  return state.employees.find((e) => e.name.trim().toLowerCase() === norm);
}

function getOrCreateEmployee(state, name) {
  const clean = (name || '').trim();
  if (!clean) return null;
  let emp = findEmployeeByName(state, clean);
  if (!emp) {
    emp = { id: genId(), name: clean };
    state.employees.push(emp);
  }
  return emp;
}

function addEmployee(name) {
  const state = load();
  const clean = (name || '').trim();
  if (!clean) throw new Error('Employee name is required');
  if (findEmployeeByName(state, clean)) throw new Error('Employee already exists');
  const emp = { id: genId(), name: clean };
  state.employees.push(emp);
  save(state);
  return emp;
}

function renameEmployee(id, name) {
  const state = load();
  const emp = state.employees.find((e) => e.id === id);
  if (!emp) throw new Error('Employee not found');
  const clean = (name || '').trim();
  if (!clean) throw new Error('Employee name is required');
  emp.name = clean;
  save(state);
  return emp;
}

function deleteEmployee(id) {
  const state = load();
  const inUse = state.jobs.some((j) => j.employeeId === id);
  if (inUse) throw new Error('Cannot delete an employee who has jobs assigned. Reassign those jobs first.');
  state.employees = state.employees.filter((e) => e.id !== id);
  save(state);
}

// ---------- Jobs ----------

const DOCUMENT_CATEGORIES = ['rams', 'drawings', 'signoff', 'photos'];

// Jobs created before documents existed won't have this field yet, so backfill it in memory
// on every read rather than requiring a one-off migration.
function ensureDocuments(job) {
  if (!job.documents) job.documents = {};
  DOCUMENT_CATEGORIES.forEach((c) => { if (!job.documents[c]) job.documents[c] = []; });
  return job;
}

// Status (Won/In Progress/Complete/...) tracks the commercial side and is set by hand.
// Progress is a separate, derived signal for where the job is on site: not started yet,
// actively underway once the Start Date arrives, or completed — but completed only happens
// when someone explicitly closes the job down (completeJob), never automatically just
// because a date has passed or Status changed.
function computeProgress(job) {
  if (job.completedAt) return 'completed';
  const today = new Date().toISOString().slice(0, 10);
  if (job.startDate && job.startDate <= today) return 'active';
  return 'not-started';
}

function listJobs() {
  const state = load();
  const empById = Object.fromEntries(state.employees.map((e) => [e.id, e.name]));
  return state.jobs
    .map((j) => ({ ...ensureDocuments(j), employeeName: empById[j.employeeId] || '(unassigned)', progress: computeProgress(j) }))
    .sort((a, b) => (b.dateWon || '').localeCompare(a.dateWon || ''));
}

function getJob(id) {
  const state = load();
  const job = state.jobs.find((j) => j.id === id);
  return job ? ensureDocuments(job) : job;
}

function validateJobInput(input) {
  const errors = [];
  if (!input.client || !input.client.trim()) errors.push('Client is required');
  if (!input.employeeName || !input.employeeName.trim()) errors.push('Employee (won by) is required');
  if (input.value === undefined || input.value === null || isNaN(Number(input.value))) errors.push('Value must be a number');
  if (input.profit !== undefined && input.profit !== null && input.profit !== '' && isNaN(Number(input.profit))) errors.push('Profit must be a number');
  if (!input.dateWon) errors.push('Date won is required');
  return errors;
}

function createJob(input) {
  const errors = validateJobInput(input);
  if (errors.length) throw new Error(errors.join('; '));
  const state = load();
  const emp = getOrCreateEmployee(state, input.employeeName);
  const job = {
    id: genId(),
    jobReference: (input.jobReference || '').trim() || null,
    client: input.client.trim(),
    location: (input.location || '').trim(),
    employeeId: emp.id,
    value: Number(input.value) || 0,
    profit: input.profit === undefined || input.profit === null || input.profit === '' ? 0 : Number(input.profit),
    status: input.status && input.status.trim() ? input.status.trim() : 'Won',
    dateWon: input.dateWon,
    startDate: (input.startDate || '').trim(),
    description: (input.description || '').trim(),
    completedAt: '',
    documents: { rams: [], drawings: [], signoff: [], photos: [] },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.jobs.push(job);
  save(state);
  return job;
}

function updateJob(id, input) {
  const errors = validateJobInput(input);
  if (errors.length) throw new Error(errors.join('; '));
  const state = load();
  const job = state.jobs.find((j) => j.id === id);
  if (!job) throw new Error('Job not found');
  const emp = getOrCreateEmployee(state, input.employeeName);
  job.jobReference = (input.jobReference || '').trim() || null;
  job.client = input.client.trim();
  job.location = (input.location || '').trim();
  job.employeeId = emp.id;
  job.value = Number(input.value) || 0;
  job.profit = input.profit === undefined || input.profit === null || input.profit === '' ? 0 : Number(input.profit);
  job.status = input.status && input.status.trim() ? input.status.trim() : 'Won';
  job.dateWon = input.dateWon;
  job.startDate = (input.startDate || '').trim();
  job.description = (input.description || '').trim();
  job.updatedAt = new Date().toISOString();
  save(state);
  return job;
}

function deleteJob(id) {
  const state = load();
  const before = state.jobs.length;
  state.jobs = state.jobs.filter((j) => j.id !== id);
  if (state.jobs.length === before) throw new Error('Job not found');
  save(state);
}

const DOCUMENT_LABELS = { rams: 'RAMS', drawings: 'Drawings', signoff: 'Sign-off sheet', photos: 'Photos' };

function completeJob(id) {
  const state = load();
  const job = state.jobs.find((j) => j.id === id);
  if (!job) throw new Error('Job not found');
  ensureDocuments(job);
  const missing = DOCUMENT_CATEGORIES.filter((c) => job.documents[c].length === 0);
  if (missing.length) {
    throw new Error(`Cannot complete job: missing ${missing.map((c) => DOCUMENT_LABELS[c]).join(', ')}. Upload these documents to the job first.`);
  }
  job.completedAt = new Date().toISOString().slice(0, 10);
  job.updatedAt = new Date().toISOString();
  save(state);
  return job;
}

function reopenJob(id) {
  const state = load();
  const job = state.jobs.find((j) => j.id === id);
  if (!job) throw new Error('Job not found');
  job.completedAt = '';
  job.updatedAt = new Date().toISOString();
  save(state);
  return job;
}

// ---------- Job Documents ----------

function addJobDocument(jobId, category, fileInfo) {
  if (!DOCUMENT_CATEGORIES.includes(category)) throw new Error('Invalid document category');
  const state = load();
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) throw new Error('Job not found');
  ensureDocuments(job);
  const doc = {
    id: genId(),
    originalName: fileInfo.originalName,
    storedName: fileInfo.storedName,
    size: fileInfo.size,
    uploadedAt: new Date().toISOString(),
  };
  job.documents[category].push(doc);
  save(state);
  return doc;
}

function getJobDocument(jobId, category, docId) {
  if (!DOCUMENT_CATEGORIES.includes(category)) return null;
  const job = getJob(jobId);
  if (!job) return null;
  return job.documents[category].find((d) => d.id === docId) || null;
}

function deleteJobDocument(jobId, category, docId) {
  if (!DOCUMENT_CATEGORIES.includes(category)) return null;
  const state = load();
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return null;
  ensureDocuments(job);
  const idx = job.documents[category].findIndex((d) => d.id === docId);
  if (idx === -1) return null;
  const [removed] = job.documents[category].splice(idx, 1);
  save(state);
  return removed;
}

// ---------- Reports ----------

function yearlyReport() {
  const state = load();
  const empById = Object.fromEntries(state.employees.map((e) => [e.id, e.name]));
  const byYear = {};

  for (const job of state.jobs) {
    if (!job.dateWon) continue;
    const year = job.dateWon.slice(0, 4);
    if (!byYear[year]) byYear[year] = { year, totalTurnover: 0, totalProfit: 0, jobCount: 0, employees: {} };
    const bucket = byYear[year];
    bucket.totalTurnover += job.value || 0;
    bucket.totalProfit += job.profit || 0;
    bucket.jobCount += 1;
    const name = empById[job.employeeId] || '(unassigned)';
    if (!bucket.employees[name]) bucket.employees[name] = { employee: name, totalValue: 0, totalProfit: 0, jobCount: 0 };
    bucket.employees[name].totalValue += job.value || 0;
    bucket.employees[name].totalProfit += job.profit || 0;
    bucket.employees[name].jobCount += 1;
  }

  const years = Object.values(byYear)
    .map((bucket) => {
      const employees = Object.values(bucket.employees).sort((a, b) => b.totalValue - a.totalValue);
      return {
        year: bucket.year,
        totalTurnover: bucket.totalTurnover,
        totalProfit: bucket.totalProfit,
        jobCount: bucket.jobCount,
        employees,
        topEarner: employees[0] || null,
      };
    })
    .sort((a, b) => b.year.localeCompare(a.year));

  return years;
}

function clientReport() {
  const state = load();
  const byClient = {};

  for (const job of state.jobs) {
    const name = (job.client || '').trim() || '(unknown client)';
    if (!byClient[name]) byClient[name] = { client: name, totalValue: 0, totalProfit: 0, jobCount: 0 };
    byClient[name].totalValue += job.value || 0;
    byClient[name].totalProfit += job.profit || 0;
    byClient[name].jobCount += 1;
  }

  return Object.values(byClient).sort((a, b) => b.totalValue - a.totalValue);
}

// ---------- Calendar ----------
// A shared team calendar — anyone signed in can see and add to it. Entries have a start date
// and a duration; a multi-day duration makes the entry span forward across that many calendar
// days, so a "2 days" entry added on the 5th also shows on the 6th.

const DURATION_UNITS = ['hours', 'days'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function addDaysToDateString(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function listCalendarEvents() {
  return load().calendarEvents.slice().sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
}

function createCalendarEvent(input, user) {
  const errors = [];
  if (!input.date || !DATE_RE.test(input.date)) errors.push('A valid date is required');
  const title = (input.title || '').trim();
  if (!title) errors.push('A description of what you\'re doing is required');
  const durationValue = Number(input.durationValue);
  if (!durationValue || isNaN(durationValue) || durationValue <= 0) errors.push('Duration must be a positive number');
  const durationUnit = DURATION_UNITS.includes(input.durationUnit) ? input.durationUnit : null;
  if (!durationUnit) errors.push('Duration unit must be hours or days');
  if (errors.length) throw new Error(errors.join('; '));

  const spanDays = durationUnit === 'days' ? Math.max(1, Math.ceil(durationValue)) : 1;
  const state = load();
  const event = {
    id: genId(),
    userId: user.id,
    userName: user.name,
    date: input.date,
    endDate: addDaysToDateString(input.date, spanDays - 1),
    title,
    durationValue,
    durationUnit,
    createdAt: new Date().toISOString(),
  };
  state.calendarEvents.push(event);
  save(state);
  return event;
}

function deleteCalendarEvent(id, user) {
  const state = load();
  const event = state.calendarEvents.find((e) => e.id === id);
  if (!event) throw new Error('Calendar entry not found');
  if (event.userId !== user.id && user.role !== 'admin') {
    throw new Error('You can only delete your own calendar entries');
  }
  state.calendarEvents = state.calendarEvents.filter((e) => e.id !== id);
  save(state);
}

// ---------- Auth ----------

function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

function findUserByEmail(state, email) {
  const norm = (email || '').trim().toLowerCase();
  return state.users.find((u) => u.email === norm);
}

function registerUser({ name, email, password }) {
  const cleanName = (name || '').trim();
  const cleanEmail = (email || '').trim().toLowerCase();
  const errors = [];
  if (!cleanName) errors.push('Name is required');
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) errors.push('A valid email is required');
  if (!password || password.length < 6) errors.push('Password must be at least 6 characters');
  if (errors.length) throw new Error(errors.join('; '));

  const state = load();
  if (findUserByEmail(state, cleanEmail)) throw new Error('An account with that email already exists');

  const user = {
    id: genId(),
    name: cleanName,
    email: cleanEmail,
    passwordHash: bcrypt.hashSync(password, 10),
    // First account becomes admin. Roles aren't enforced anywhere yet — this just means
    // there's already an identity/role model in place for when permissions are added.
    role: state.users.length === 0 ? 'admin' : 'staff',
    createdAt: new Date().toISOString(),
  };
  state.users.push(user);
  save(state);
  return sanitizeUser(user);
}

function verifyLogin(email, password) {
  const state = load();
  const user = findUserByEmail(state, email);
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    throw new Error('Incorrect email or password');
  }
  return sanitizeUser(user);
}

function createSession(userId) {
  const state = load();
  const now = Date.now();
  state.sessions = state.sessions.filter((s) => new Date(s.expiresAt).getTime() > now);
  const token = crypto.randomBytes(32).toString('hex');
  state.sessions.push({
    token,
    userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  });
  save(state);
  return token;
}

function getUserBySession(token) {
  if (!token) return null;
  const state = load();
  const session = state.sessions.find((s) => s.token === token);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) return null;
  return sanitizeUser(state.users.find((u) => u.id === session.userId));
}

function deleteSession(token) {
  const state = load();
  state.sessions = state.sessions.filter((s) => s.token !== token);
  save(state);
}

function listUsers() {
  return load().users.map(sanitizeUser).sort((a, b) => a.name.localeCompare(b.name));
}

function promoteToAdmin(id) {
  const state = load();
  const user = state.users.find((u) => u.id === id);
  if (!user) throw new Error('User not found');
  user.role = 'admin';
  save(state);
  return sanitizeUser(user);
}

module.exports = {
  DEFAULT_STATUSES,
  DOCUMENT_CATEGORIES,
  registerUser,
  verifyLogin,
  createSession,
  getUserBySession,
  deleteSession,
  listUsers,
  promoteToAdmin,
  listEmployees,
  addEmployee,
  renameEmployee,
  deleteEmployee,
  listJobs,
  getJob,
  createJob,
  updateJob,
  deleteJob,
  completeJob,
  reopenJob,
  addJobDocument,
  getJobDocument,
  deleteJobDocument,
  yearlyReport,
  clientReport,
  listCalendarEvents,
  createCalendarEvent,
  deleteCalendarEvent,
};
