const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { supabase } = require('./supabaseClient');

const DEFAULT_STATUSES = ['Won', 'In Progress', 'Complete', 'Invoiced', 'Lost', 'Cancelled'];
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DOCUMENT_CATEGORIES = ['rams', 'drawings', 'signoff', 'photos'];
const DOCUMENT_LABELS = { rams: 'RAMS', drawings: 'Drawings', signoff: 'Sign-off sheet', photos: 'Photos' };

// Fixed 10-colour set for the calendar: chosen so every colour stays legible with white
// text on it and any two are tell-apart-able (including colour-blind vision), verified with
// the data-viz skill's palette validator rather than picked by eye. Each person picks one
// (enforced one-per-colour by the `users_color_unique_idx` partial unique index), so the
// server is the single source of truth both apps agree on - see CALENDAR_COLORS below.
const CALENDAR_COLORS = [
  { name: 'Blue', hex: '#1c6e9c' },
  { name: 'Red', hex: '#b6402e' },
  { name: 'Amber', hex: '#b8720d' },
  { name: 'Violet', hex: '#7a4fb0' },
  { name: 'Green', hex: '#2f7a3a' },
  { name: 'Teal', hex: '#009a8b' },
  { name: 'Wine', hex: '#7b354c' },
  { name: 'Cyan', hex: '#0096a9' },
  { name: 'Rose', hex: '#a65a67' },
  { name: 'Magenta', hex: '#87156c' },
];
const CALENDAR_COLOR_HEXES = CALENDAR_COLORS.map((c) => c.hex);

function genId() {
  return crypto.randomUUID();
}

function check(error) {
  if (error) throw new Error(error.message);
}

// ---------- Employees ----------

async function listEmployees() {
  const { data, error } = await supabase.from('employees').select('*').order('name');
  check(error);
  return data;
}

async function findEmployeeByName(name) {
  const norm = name.trim().toLowerCase();
  const { data, error } = await supabase.from('employees').select('*');
  check(error);
  return data.find((e) => e.name.trim().toLowerCase() === norm) || null;
}

async function getOrCreateEmployee(name) {
  const clean = (name || '').trim();
  if (!clean) return null;
  const existing = await findEmployeeByName(clean);
  if (existing) return existing;
  const { data, error } = await supabase.from('employees').insert({ id: genId(), name: clean }).select().single();
  check(error);
  return data;
}

async function addEmployee(name) {
  const clean = (name || '').trim();
  if (!clean) throw new Error('Employee name is required');
  if (await findEmployeeByName(clean)) throw new Error('Employee already exists');
  const { data, error } = await supabase.from('employees').insert({ id: genId(), name: clean }).select().single();
  check(error);
  return data;
}

async function renameEmployee(id, name) {
  const clean = (name || '').trim();
  if (!clean) throw new Error('Employee name is required');
  const { data, error } = await supabase.from('employees').update({ name: clean }).eq('id', id).select().maybeSingle();
  check(error);
  if (!data) throw new Error('Employee not found');
  return data;
}

async function deleteEmployee(id) {
  const { data: inUse, error: jobsErr } = await supabase.from('jobs').select('id').eq('employee_id', id).limit(1);
  check(jobsErr);
  if (inUse.length) throw new Error('Cannot delete an employee who has jobs assigned. Reassign those jobs first.');
  const { error } = await supabase.from('employees').delete().eq('id', id);
  check(error);
}

// ---------- Jobs ----------

// Status (Won/In Progress/Complete/...) tracks the commercial side and is set by hand.
// Progress is a separate, derived signal for where the job is on site: not started yet,
// actively underway once the Start Date arrives, or completed - but completed only happens
// when someone explicitly closes the job down (completeJob), never automatically just
// because a date has passed or Status changed.
function computeProgress(row) {
  if (row.completed_at) return 'completed';
  const today = new Date().toISOString().slice(0, 10);
  if (row.start_date && row.start_date <= today) return 'active';
  return 'not-started';
}

function rowToJob(row, empNameById) {
  return {
    id: row.id,
    jobReference: row.job_reference,
    client: row.client,
    location: row.location || '',
    employeeId: row.employee_id,
    employeeName: (empNameById && empNameById[row.employee_id]) || '(unassigned)',
    value: Number(row.value) || 0,
    profit: Number(row.profit) || 0,
    status: row.status,
    dateWon: row.date_won,
    startDate: row.start_date || '',
    description: row.description || '',
    completedAt: row.completed_at || '',
    documents: { rams: [], drawings: [], signoff: [], photos: [] },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    progress: computeProgress(row),
  };
}

function rowToDocument(row) {
  return {
    id: row.id,
    originalName: row.original_name,
    storedName: row.stored_name,
    size: row.size,
    uploadedAt: row.uploaded_at,
  };
}

async function attachDocuments(jobs) {
  if (!jobs.length) return jobs;
  const { data: docs, error } = await supabase.from('job_documents').select('*').in('job_id', jobs.map((j) => j.id));
  check(error);
  const byJob = {};
  for (const d of docs) {
    if (!byJob[d.job_id]) byJob[d.job_id] = { rams: [], drawings: [], signoff: [], photos: [] };
    byJob[d.job_id][d.category].push(rowToDocument(d));
  }
  jobs.forEach((j) => { j.documents = byJob[j.id] || { rams: [], drawings: [], signoff: [], photos: [] }; });
  return jobs;
}

async function employeeNameMap() {
  const { data, error } = await supabase.from('employees').select('*');
  check(error);
  return Object.fromEntries(data.map((e) => [e.id, e.name]));
}

async function listJobs() {
  const [{ data: rows, error }, empNameById] = await Promise.all([
    supabase.from('jobs').select('*'),
    employeeNameMap(),
  ]);
  check(error);
  const jobs = rows.map((r) => rowToJob(r, empNameById));
  await attachDocuments(jobs);
  return jobs.sort((a, b) => (b.dateWon || '').localeCompare(a.dateWon || ''));
}

async function getJob(id) {
  const [{ data: row, error }, empNameById] = await Promise.all([
    supabase.from('jobs').select('*').eq('id', id).maybeSingle(),
    employeeNameMap(),
  ]);
  check(error);
  if (!row) return null;
  const job = rowToJob(row, empNameById);
  await attachDocuments([job]);
  return job;
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

async function createJob(input) {
  const errors = validateJobInput(input);
  if (errors.length) throw new Error(errors.join('; '));
  const emp = await getOrCreateEmployee(input.employeeName);
  const now = new Date().toISOString();
  const row = {
    id: genId(),
    job_reference: (input.jobReference || '').trim() || null,
    client: input.client.trim(),
    location: (input.location || '').trim(),
    employee_id: emp.id,
    value: Number(input.value) || 0,
    profit: input.profit === undefined || input.profit === null || input.profit === '' ? 0 : Number(input.profit),
    status: input.status && input.status.trim() ? input.status.trim() : 'Won',
    date_won: input.dateWon,
    start_date: (input.startDate || '').trim(),
    description: (input.description || '').trim(),
    completed_at: '',
    created_at: now,
    updated_at: now,
  };
  const { data, error } = await supabase.from('jobs').insert(row).select().single();
  check(error);
  return rowToJob(data, { [emp.id]: emp.name });
}

async function updateJob(id, input) {
  const errors = validateJobInput(input);
  if (errors.length) throw new Error(errors.join('; '));
  const emp = await getOrCreateEmployee(input.employeeName);
  const row = {
    job_reference: (input.jobReference || '').trim() || null,
    client: input.client.trim(),
    location: (input.location || '').trim(),
    employee_id: emp.id,
    value: Number(input.value) || 0,
    profit: input.profit === undefined || input.profit === null || input.profit === '' ? 0 : Number(input.profit),
    status: input.status && input.status.trim() ? input.status.trim() : 'Won',
    date_won: input.dateWon,
    start_date: (input.startDate || '').trim(),
    description: (input.description || '').trim(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('jobs').update(row).eq('id', id).select().maybeSingle();
  check(error);
  if (!data) throw new Error('Job not found');
  const job = rowToJob(data, { [emp.id]: emp.name });
  await attachDocuments([job]);
  return job;
}

async function deleteJob(id) {
  const { data, error } = await supabase.from('jobs').delete().eq('id', id).select();
  check(error);
  if (!data.length) throw new Error('Job not found');
}

async function completeJob(id) {
  const { data: docs, error: docErr } = await supabase.from('job_documents').select('category').eq('job_id', id);
  check(docErr);
  const counts = { rams: 0, drawings: 0, signoff: 0, photos: 0 };
  docs.forEach((d) => { counts[d.category] += 1; });
  const missing = DOCUMENT_CATEGORIES.filter((c) => counts[c] === 0);
  if (missing.length) {
    throw new Error(`Cannot complete job: missing ${missing.map((c) => DOCUMENT_LABELS[c]).join(', ')}. Upload these documents to the job first.`);
  }
  const { data, error } = await supabase.from('jobs')
    .update({ completed_at: new Date().toISOString().slice(0, 10), updated_at: new Date().toISOString() })
    .eq('id', id).select().maybeSingle();
  check(error);
  if (!data) throw new Error('Job not found');
  return getJob(id);
}

async function reopenJob(id) {
  const { data, error } = await supabase.from('jobs')
    .update({ completed_at: '', updated_at: new Date().toISOString() })
    .eq('id', id).select().maybeSingle();
  check(error);
  if (!data) throw new Error('Job not found');
  return getJob(id);
}

// ---------- Job Documents ----------
// Metadata lives here; the actual file bytes live in Supabase Storage (handled in server.js).

async function addJobDocument(jobId, category, fileInfo) {
  if (!DOCUMENT_CATEGORIES.includes(category)) throw new Error('Invalid document category');
  const { data: job, error: jobErr } = await supabase.from('jobs').select('id').eq('id', jobId).maybeSingle();
  check(jobErr);
  if (!job) throw new Error('Job not found');
  const row = {
    id: genId(),
    job_id: jobId,
    category,
    original_name: fileInfo.originalName,
    stored_name: fileInfo.storedName,
    size: fileInfo.size,
    uploaded_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('job_documents').insert(row).select().single();
  check(error);
  return rowToDocument(data);
}

async function getJobDocument(jobId, category, docId) {
  if (!DOCUMENT_CATEGORIES.includes(category)) return null;
  const { data, error } = await supabase.from('job_documents').select('*')
    .eq('id', docId).eq('job_id', jobId).eq('category', category).maybeSingle();
  check(error);
  return data ? rowToDocument(data) : null;
}

async function deleteJobDocument(jobId, category, docId) {
  const doc = await getJobDocument(jobId, category, docId);
  if (!doc) return null;
  const { error } = await supabase.from('job_documents').delete().eq('id', docId);
  check(error);
  return doc;
}

// ---------- Reports ----------

async function yearlyReport() {
  const [{ data: jobs, error }, empNameById] = await Promise.all([
    supabase.from('jobs').select('*'),
    employeeNameMap(),
  ]);
  check(error);
  const byYear = {};

  for (const job of jobs) {
    if (!job.date_won) continue;
    const year = job.date_won.slice(0, 4);
    if (!byYear[year]) byYear[year] = { year, totalTurnover: 0, totalProfit: 0, jobCount: 0, employees: {} };
    const bucket = byYear[year];
    bucket.totalTurnover += job.value || 0;
    bucket.totalProfit += job.profit || 0;
    bucket.jobCount += 1;
    const name = empNameById[job.employee_id] || '(unassigned)';
    if (!bucket.employees[name]) bucket.employees[name] = { employee: name, totalValue: 0, totalProfit: 0, jobCount: 0 };
    bucket.employees[name].totalValue += job.value || 0;
    bucket.employees[name].totalProfit += job.profit || 0;
    bucket.employees[name].jobCount += 1;
  }

  return Object.values(byYear)
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
}

// Value won per calendar month, split out by year, so the front end can plot one
// line per year and let the office compare this year's pace against past ones.
async function monthlyReport() {
  const { data: jobs, error } = await supabase.from('jobs').select('date_won, value');
  check(error);
  const byYear = {};
  for (const job of jobs) {
    if (!job.date_won) continue;
    const year = job.date_won.slice(0, 4);
    const month = Number(job.date_won.slice(5, 7)) - 1;
    if (month < 0 || month > 11) continue;
    if (!byYear[year]) byYear[year] = Array(12).fill(0);
    byYear[year][month] += job.value || 0;
  }
  return Object.keys(byYear).sort().map((year) => ({ year, months: byYear[year] }));
}

async function clientReport() {
  const { data: jobs, error } = await supabase.from('jobs').select('*');
  check(error);
  const byClient = {};

  for (const job of jobs) {
    const name = (job.client || '').trim() || '(unknown client)';
    if (!byClient[name]) byClient[name] = { client: name, totalValue: 0, totalProfit: 0, jobCount: 0 };
    byClient[name].totalValue += job.value || 0;
    byClient[name].totalProfit += job.profit || 0;
    byClient[name].jobCount += 1;
  }

  return Object.values(byClient).sort((a, b) => b.totalValue - a.totalValue);
}

// ---------- Calendar ----------
// A shared team calendar - anyone signed in can see and add to it - plus private entries
// that only their owner can ever see (is_private = true). Entries have a start date
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

function rowToEvent(row) {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    date: row.date,
    endDate: row.end_date,
    title: row.title,
    durationValue: Number(row.duration_value),
    durationUnit: row.duration_unit,
    isPrivate: row.is_private,
    createdAt: row.created_at,
  };
}

// Returns public entries plus this user's own private ones - never another user's private
// entries, since those only ever belong on that person's own "My Calendar".
async function listCalendarEvents(user) {
  const { data, error } = await supabase.from('calendar_events').select('*')
    .or(`is_private.eq.false,user_id.eq.${user.id}`)
    .order('date').order('created_at');
  check(error);
  return data.map(rowToEvent);
}

async function createCalendarEvent(input, user) {
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
  const row = {
    id: genId(),
    user_id: user.id,
    user_name: user.name,
    date: input.date,
    end_date: addDaysToDateString(input.date, spanDays - 1),
    title,
    duration_value: durationValue,
    duration_unit: durationUnit,
    is_private: !!input.isPrivate,
    created_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('calendar_events').insert(row).select().single();
  check(error);
  return rowToEvent(data);
}

async function deleteCalendarEvent(id, user) {
  const { data: event, error } = await supabase.from('calendar_events').select('*').eq('id', id).maybeSingle();
  check(error);
  if (!event) throw new Error('Calendar entry not found');
  if (event.user_id !== user.id && user.role !== 'admin') {
    throw new Error('You can only delete your own calendar entries');
  }
  const { error: delErr } = await supabase.from('calendar_events').delete().eq('id', id);
  check(delErr);
}

// ---------- Auth ----------

function sanitizeUser(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, email: row.email, role: row.role, color: row.color || null, createdAt: row.created_at };
}

async function findUserByEmail(email) {
  const norm = (email || '').trim().toLowerCase();
  const { data, error } = await supabase.from('users').select('*').eq('email', norm).maybeSingle();
  check(error);
  return data;
}

async function registerUser({ name, email, password }) {
  const cleanName = (name || '').trim();
  const cleanEmail = (email || '').trim().toLowerCase();
  const errors = [];
  if (!cleanName) errors.push('Name is required');
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) errors.push('A valid email is required');
  if (!password || password.length < 6) errors.push('Password must be at least 6 characters');
  if (errors.length) throw new Error(errors.join('; '));

  if (await findUserByEmail(cleanEmail)) throw new Error('An account with that email already exists');

  const { count, error: countErr } = await supabase.from('users').select('*', { count: 'exact', head: true });
  check(countErr);

  const row = {
    id: genId(),
    name: cleanName,
    email: cleanEmail,
    password_hash: bcrypt.hashSync(password, 10),
    // First account becomes admin, same bootstrap rule as before.
    role: count === 0 ? 'admin' : 'staff',
    created_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('users').insert(row).select().single();
  check(error);
  return sanitizeUser(data);
}

async function verifyLogin(email, password) {
  const user = await findUserByEmail(email);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    throw new Error('Incorrect email or password');
  }
  return sanitizeUser(user);
}

async function createSession(userId) {
  const now = Date.now();
  await supabase.from('sessions').delete().lt('expires_at', new Date(now).toISOString());
  const token = crypto.randomBytes(32).toString('hex');
  const { error } = await supabase.from('sessions').insert({
    token,
    user_id: userId,
    created_at: new Date().toISOString(),
    expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
  });
  check(error);
  return token;
}

async function getUserBySession(token) {
  if (!token) return null;
  const { data: session, error } = await supabase.from('sessions').select('*').eq('token', token).maybeSingle();
  check(error);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;
  const { data: user, error: userErr } = await supabase.from('users').select('*').eq('id', session.user_id).maybeSingle();
  check(userErr);
  return sanitizeUser(user);
}

async function deleteSession(token) {
  const { error } = await supabase.from('sessions').delete().eq('token', token);
  check(error);
}

async function listUsers() {
  const { data, error } = await supabase.from('users').select('*').order('name');
  check(error);
  return data.map(sanitizeUser);
}

async function promoteToAdmin(id) {
  const { data, error } = await supabase.from('users').update({ role: 'admin' }).eq('id', id).select().maybeSingle();
  check(error);
  if (!data) throw new Error('User not found');
  return sanitizeUser(data);
}

// Everyone signed in needs to see who's using which colour (to grey out taken ones), so
// this is deliberately not admin-only like listUsers().
async function listUserColors() {
  const { data, error } = await supabase.from('users').select('id, name, color').order('name');
  check(error);
  return data;
}

async function setUserColor(userId, color) {
  if (!CALENDAR_COLOR_HEXES.includes(color)) throw new Error('Not a valid calendar colour');
  const { data, error } = await supabase.from('users').update({ color }).eq('id', userId).select().maybeSingle();
  if (error) {
    // Postgres unique_violation on the partial index - someone else grabbed it first.
    if (error.code === '23505') throw new Error('That colour was just taken by someone else - pick another');
    check(error);
  }
  if (!data) throw new Error('User not found');
  return sanitizeUser(data);
}

module.exports = {
  DEFAULT_STATUSES,
  DOCUMENT_CATEGORIES,
  CALENDAR_COLORS,
  registerUser,
  verifyLogin,
  createSession,
  getUserBySession,
  deleteSession,
  listUsers,
  promoteToAdmin,
  listUserColors,
  setUserColor,
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
  monthlyReport,
  clientReport,
  listCalendarEvents,
  createCalendarEvent,
  deleteCalendarEvent,
};
