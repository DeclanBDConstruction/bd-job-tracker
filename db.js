const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { supabase } = require('./supabaseClient');

const DEFAULT_STATUSES = ['Won', 'In Progress', 'Complete', 'Invoiced', 'Lost', 'Cancelled'];
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DOCUMENT_CATEGORIES = ['rams', 'drawings', 'signoff', 'photos'];
const DOCUMENT_LABELS = { rams: 'RAMS', drawings: 'Drawings', signoff: 'Sign-off sheet', photos: 'Photos' };
// Drawings aren't needed for every job (e.g. no design changes involved), so they're
// still uploadable but don't block marking a job complete like the others do.
const REQUIRED_DOCUMENT_CATEGORIES = DOCUMENT_CATEGORIES.filter((c) => c !== 'drawings');

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

// `hasAccount` flags employees whose name matched a user account at registration
// (see registerUser's employee_id auto-link), so the Employees tab can show at a
// glance who's actually signed up versus who's just a name on jobs.
async function listEmployees() {
  const [{ data, error }, { data: userRows, error: userErr }] = await Promise.all([
    supabase.from('employees').select('*').order('name'),
    supabase.from('users').select('employee_id').not('employee_id', 'is', null),
  ]);
  check(error);
  check(userErr);
  const linkedIds = new Set(userRows.map((u) => u.employee_id));
  return data.map((e) => ({ id: e.id, name: e.name, hasAccount: linkedIds.has(e.id) }));
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
    variations: [],
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

function rowToVariation(row) {
  return {
    id: row.id,
    description: row.description,
    value: Number(row.value) || 0,
    createdAt: row.created_at,
  };
}

async function attachVariations(jobs) {
  if (!jobs.length) return jobs;
  const { data: rows, error } = await supabase.from('job_variations').select('*').in('job_id', jobs.map((j) => j.id));
  check(error);
  const byJob = {};
  for (const r of rows) {
    if (!byJob[r.job_id]) byJob[r.job_id] = [];
    byJob[r.job_id].push(rowToVariation(r));
  }
  jobs.forEach((j) => {
    j.variations = (byJob[j.id] || []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  });
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
  await Promise.all([attachDocuments(jobs), attachVariations(jobs)]);
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
  await Promise.all([attachDocuments([job]), attachVariations([job])]);
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
  await Promise.all([attachDocuments([job]), attachVariations([job])]);
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
  const missing = REQUIRED_DOCUMENT_CATEGORIES.filter((c) => counts[c] === 0);
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

// ---------- Job Variations ----------
// Extra works agreed after the original quote - kept separate from the job's Value so
// scope changes are visible instead of silently making the quoted value stale.

async function addJobVariation(jobId, input) {
  const description = (input.description || '').trim();
  if (!description) throw new Error('Description is required');
  const value = Number(input.value);
  if (isNaN(value)) throw new Error('Value must be a number');
  const { data: job, error: jobErr } = await supabase.from('jobs').select('id').eq('id', jobId).maybeSingle();
  check(jobErr);
  if (!job) throw new Error('Job not found');
  const row = {
    id: genId(),
    job_id: jobId,
    description,
    value,
    created_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('job_variations').insert(row).select().single();
  check(error);
  return rowToVariation(data);
}

async function deleteJobVariation(jobId, variationId) {
  const { data, error } = await supabase.from('job_variations').select('*')
    .eq('id', variationId).eq('job_id', jobId).maybeSingle();
  check(error);
  if (!data) return null;
  const { error: delErr } = await supabase.from('job_variations').delete().eq('id', variationId);
  check(delErr);
  return rowToVariation(data);
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

// ---------- Saved Risk Assessments (library) ----------
// Staff-uploaded risk assessments, kept separate from any one job so the same file can be
// attached again next time that job (or a similar one) comes up. Metadata lives here; the
// file bytes live in Supabase Storage (handled in server.js), same bucket as job documents.

function rowToSavedRiskAssessment(row) {
  return {
    id: row.id,
    name: row.name,
    originalName: row.original_name,
    storedName: row.stored_name,
    size: row.size,
    uploadedBy: row.uploaded_by || '',
    createdAt: row.created_at,
  };
}

async function listSavedRiskAssessments() {
  const { data, error } = await supabase.from('saved_risk_assessments').select('*').order('name');
  check(error);
  return data.map(rowToSavedRiskAssessment);
}

async function getSavedRiskAssessment(id) {
  const { data, error } = await supabase.from('saved_risk_assessments').select('*').eq('id', id).maybeSingle();
  check(error);
  return data ? rowToSavedRiskAssessment(data) : null;
}

async function addSavedRiskAssessment(fileInfo) {
  const name = (fileInfo.name || '').trim();
  if (!name) throw new Error('Name is required');
  const row = {
    id: genId(),
    name,
    original_name: fileInfo.originalName,
    stored_name: fileInfo.storedName,
    size: fileInfo.size,
    uploaded_by: fileInfo.uploadedBy || null,
    created_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('saved_risk_assessments').insert(row).select().single();
  check(error);
  return rowToSavedRiskAssessment(data);
}

async function deleteSavedRiskAssessment(id) {
  const ra = await getSavedRiskAssessment(id);
  if (!ra) return null;
  const { error } = await supabase.from('saved_risk_assessments').delete().eq('id', id);
  check(error);
  return ra;
}

// ---------- Reports ----------

// Company-wide breakdown for admins; scoped to just the viewer's own figures (keyed by
// their linked employee_id, set at registration - see registerUser) for anyone else, so
// staff can see their own performance without seeing what everyone else won.
async function yearlyReport(viewer) {
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
    const empKey = job.employee_id || '(unassigned)';
    const name = empNameById[job.employee_id] || '(unassigned)';
    if (!bucket.employees[empKey]) bucket.employees[empKey] = { employeeId: job.employee_id || null, employee: name, totalValue: 0, totalProfit: 0, jobCount: 0 };
    bucket.employees[empKey].totalValue += job.value || 0;
    bucket.employees[empKey].totalProfit += job.profit || 0;
    bucket.employees[empKey].jobCount += 1;
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

  if (viewer && viewer.role !== 'admin') {
    if (!viewer.employeeId) return [];
    return years
      .map((y) => {
        const own = y.employees.find((e) => e.employeeId === viewer.employeeId);
        return own ? { year: y.year, own: { totalValue: own.totalValue, totalProfit: own.totalProfit, jobCount: own.jobCount } } : null;
      })
      .filter(Boolean);
  }

  return years;
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

const DURATION_UNITS = ['time', 'days'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

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
    durationValue: row.duration_value === null ? null : Number(row.duration_value),
    durationUnit: row.duration_unit,
    startTime: row.start_time,
    endTime: row.end_time,
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
  const durationUnit = DURATION_UNITS.includes(input.durationUnit) ? input.durationUnit : null;
  if (!durationUnit) errors.push('Choose either a specific time or a number of days');

  let durationValue = null;
  let startTime = null;
  let endTime = null;
  if (durationUnit === 'days') {
    durationValue = Number(input.durationValue);
    if (!durationValue || isNaN(durationValue) || durationValue <= 0) errors.push('Number of days must be a positive number');
  } else if (durationUnit === 'time') {
    startTime = input.startTime;
    endTime = input.endTime;
    if (!TIME_RE.test(startTime || '') || !TIME_RE.test(endTime || '')) errors.push('A valid start and end time is required');
    else if (endTime <= startTime) errors.push('End time must be after start time');
  }
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
    start_time: startTime,
    end_time: endTime,
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

// ---------- Price List (Labour & Materials) ----------
// One flat table of name+price items, split into the Labour tab and the Price List tab by
// `kind` - reference data for pricing up quotes, not tied to any specific job.

const PRICE_LIST_KINDS = ['labour', 'material'];

function rowToPriceListItem(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    price: Number(row.price),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listPriceListItems() {
  const { data, error } = await supabase.from('price_list_items').select('*').order('name');
  check(error);
  return data.map(rowToPriceListItem);
}

async function createPriceListItem(input) {
  const kind = PRICE_LIST_KINDS.includes(input.kind) ? input.kind : null;
  if (!kind) throw new Error('Kind must be labour or material');
  const name = (input.name || '').trim();
  if (!name) throw new Error('Item name is required');
  const price = Number(input.price);
  if (isNaN(price) || price < 0) throw new Error('Price must be a valid number');

  const row = {
    id: genId(),
    kind,
    name,
    price,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('price_list_items').insert(row).select().single();
  check(error);
  return rowToPriceListItem(data);
}

async function updatePriceListItem(id, input) {
  const name = (input.name || '').trim();
  if (!name) throw new Error('Item name is required');
  const price = Number(input.price);
  if (isNaN(price) || price < 0) throw new Error('Price must be a valid number');

  const { data, error } = await supabase.from('price_list_items')
    .update({ name, price, updated_at: new Date().toISOString() })
    .eq('id', id).select().maybeSingle();
  check(error);
  if (!data) throw new Error('Item not found');
  return rowToPriceListItem(data);
}

async function deletePriceListItem(id) {
  const { error } = await supabase.from('price_list_items').delete().eq('id', id);
  check(error);
}

// ---------- Auth ----------

function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    color: row.color || null,
    employeeId: row.employee_id || null,
    createdAt: row.created_at,
  };
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

  // Auto-link to the matching employee record by name (e.g. "Neil Gaskell" signing up
  // links to the "Neil Gaskell" employee), so their Yearly Report can be scoped to just
  // their own figures. Leaves employee_id null if no employee matches that name yet -
  // an admin can add the matching employee and have them re-register, or this can be
  // wired up to a manual override later if that turns out to be needed.
  const matchingEmployee = await findEmployeeByName(cleanName);

  const row = {
    id: genId(),
    name: cleanName,
    email: cleanEmail,
    password_hash: bcrypt.hashSync(password, 10),
    // First account becomes admin, same bootstrap rule as before.
    role: count === 0 ? 'admin' : 'staff',
    employee_id: matchingEmployee ? matchingEmployee.id : null,
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

// Manual override for the name-match auto-link done at registration (see registerUser) -
// covers accounts created before that existed, and cases where the typed name didn't
// exactly match the employee record.
async function setUserEmployee(userId, employeeId) {
  if (employeeId) {
    const { data: emp, error: empErr } = await supabase.from('employees').select('id').eq('id', employeeId).maybeSingle();
    check(empErr);
    if (!emp) throw new Error('Employee not found');
  }
  const { data, error } = await supabase.from('users').update({ employee_id: employeeId || null }).eq('id', userId).select().maybeSingle();
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
  setUserEmployee,
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
  addJobVariation,
  deleteJobVariation,
  addJobDocument,
  getJobDocument,
  deleteJobDocument,
  listSavedRiskAssessments,
  getSavedRiskAssessment,
  addSavedRiskAssessment,
  deleteSavedRiskAssessment,
  yearlyReport,
  monthlyReport,
  clientReport,
  listCalendarEvents,
  createCalendarEvent,
  deleteCalendarEvent,
  listPriceListItems,
  createPriceListItem,
  updatePriceListItem,
  deletePriceListItem,
};
