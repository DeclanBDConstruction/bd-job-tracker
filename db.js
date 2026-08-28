const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { supabase } = require('./supabaseClient');
const { riskBand } = require('./riskAssessments');

const DEFAULT_STATUSES = ['Won', 'In Progress', 'Complete', 'Invoiced', 'Lost', 'Cancelled'];
// The session cookie itself (see setSessionCookie in server.js) is what makes people sign in
// again on every fresh app open - it has no maxAge, so it dies with the browser/tab. This is
// just a server-side safety net in case a browser or PWA holds onto the cookie longer than it
// should, so a session can't ride along forever even then.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes - just long enough to open an authenticator app
const DOCUMENT_CATEGORIES = ['rams', 'drawings', 'photos', 'permit'];
const DOCUMENT_LABELS = { rams: 'RAMS', drawings: 'Drawings', photos: 'Photos', permit: 'Permit to Work' };
// Drawings aren't needed for every job (e.g. no design changes involved), and not every
// job needs a Permit to Work either (that's an operative-assignment thing, not every job
// has one), so neither blocks marking a job complete like rams/photos do.
const REQUIRED_DOCUMENT_CATEGORIES = DOCUMENT_CATEGORIES.filter((c) => c !== 'drawings' && c !== 'permit');

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

// Purely cosmetic profile customisation - free pick, not unique-per-person like the calendar
// colour above (plenty of people can have a gold border). The actual colours/gradients live
// in style.css keyed by these same values (see .avatar-border-X / .profile-bg-X) - these
// arrays are just the allowlist a save is validated against, same role as CALENDAR_COLOR_HEXES.
const PROFILE_BORDER_STYLES = ['none', 'bronze', 'silver', 'gold', 'blue', 'green', 'purple', 'red', 'diamond', 'fire', 'ice', 'rainbow'];
const PROFILE_BACKGROUND_THEMES = ['none', 'ocean', 'sunset', 'forest', 'slate', 'berry', 'galaxy', 'goldfoil', 'aurora'];

function genId() {
  return crypto.randomUUID();
}

function check(error) {
  if (!error) return;
  // Postgres constraint violations carry a stable `code` regardless of wording - rewritten
  // to plain English here so an unanticipated one doesn't leak a raw column/constraint name
  // to the browser. Specific cases that are actually expected to happen in normal use (e.g.
  // a duplicate email at registration, a calendar colour someone else just grabbed) still get
  // their own more precise message ahead of this, checked before check() is even called - this
  // is just the generic fallback for whatever isn't already anticipated.
  if (error.code === '23505') throw new Error('That already exists - check for a duplicate.');
  if (error.code === '23503') throw new Error('That references something that no longer exists.');
  if (error.code === '23502') throw new Error('A required field is missing.');
  throw new Error(error.message);
}

// ---------- Activity Log (admin audit trail) ----------

function rowToActivityLogEntry(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    actorRole: row.actor_role,
    action: row.action,
    summary: row.summary,
    targetType: row.target_type,
    targetId: row.target_id,
    details: row.details || {},
  };
}

// Unlike every other write in this file, a failed audit-log insert must never surface as a
// failed request for the thing it's describing (a job still got created even if this fails) -
// so this deliberately doesn't call check()/throw, just logs to the server console and moves on.
async function logActivity(actor, action, summary, targetType, targetId, details) {
  try {
    const { error } = await supabase.from('activity_log').insert({
      id: genId(),
      actor_user_id: actor ? actor.id : null,
      actor_name: actor ? actor.name : 'System',
      actor_role: actor ? actor.role : null,
      action,
      summary,
      target_type: targetType || null,
      target_id: targetId ? String(targetId) : null,
      details: details || {},
    });
    if (error) console.error('activity log write failed:', error.message);
  } catch (err) {
    console.error('activity log write failed:', err.message);
  }
}

// Terse one-liner for routine CRUD that doesn't need a hand-crafted sentence, e.g.
// logCrud(req.user, 'created', 'price_list_item', 'Price list item', item.name, item.id).
function logCrud(actor, verb, actionNoun, label, name, id) {
  const verbWord = verb === 'created' ? 'Created' : verb === 'updated' ? 'Updated' : 'Deleted';
  return logActivity(actor, `${actionNoun}.${verb}`, `${verbWord} ${label} "${name}"`, actionNoun, id);
}

async function listActivityLog(filters = {}, pagination = {}) {
  const limit = Math.min(Math.max(Number(pagination.limit) || 50, 1), 200);
  const offset = Math.max(Number(pagination.offset) || 0, 0);
  let query = supabase.from('activity_log').select('*', { count: 'exact' });
  if (filters.from) query = query.gte('created_at', filters.from);
  if (filters.to) query = query.lte('created_at', filters.to);
  if (filters.actorUserId) query = query.eq('actor_user_id', filters.actorUserId);
  if (filters.action) query = query.eq('action', filters.action);
  if (filters.targetType) query = query.eq('target_type', filters.targetType);
  if (filters.q) query = query.ilike('summary', `%${filters.q}%`);
  query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  const { data, error, count } = await query;
  check(error);
  return { entries: data.map(rowToActivityLogEntry), total: count, limit, offset };
}

// ---------- Employees ----------

// `hasAccount` flags employees whose name matched a user account at registration
// (see registerUser's employee_id auto-link), so the Employees tab can show at a
// glance who's actually signed up versus who's just a name on jobs. `role` (null if
// no linked account) rides along too - the Jobs tab's employee filter uses it to
// only offer admins/surveyors, since "employee" there means who won the job. `userId`
// (also null if unlinked) lets the Employees tab's "View Profile" button open the
// linked account's profile - see getUserProfile.
async function listEmployees() {
  const [{ data, error }, { data: userRows, error: userErr }] = await Promise.all([
    supabase.from('employees').select('*').order('name'),
    supabase.from('users').select('id, employee_id, role').not('employee_id', 'is', null),
  ]);
  check(error);
  check(userErr);
  const linkedUserByEmployeeId = new Map(userRows.map((u) => [u.employee_id, u]));
  return data.map((e) => {
    const linkedUser = linkedUserByEmployeeId.get(e.id);
    return { id: e.id, name: e.name, hasAccount: !!linkedUser, role: linkedUser ? linkedUser.role : null, userId: linkedUser ? linkedUser.id : null };
  });
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
    documents: { rams: [], drawings: [], photos: [], permit: [] },
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
    superseded: !!row.superseded,
  };
}

async function attachDocuments(jobs) {
  if (!jobs.length) return jobs;
  const { data: docs, error } = await supabase.from('job_documents').select('*').in('job_id', jobs.map((j) => j.id));
  check(error);
  const byJob = {};
  for (const d of docs) {
    if (!byJob[d.job_id]) byJob[d.job_id] = { rams: [], drawings: [], photos: [], permit: [] };
    byJob[d.job_id][d.category].push(rowToDocument(d));
  }
  jobs.forEach((j) => { j.documents = byJob[j.id] || { rams: [], drawings: [], photos: [], permit: [] }; });
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

async function completeJob(id, user) {
  // Admins can close a job down without RAMS/photos on file - they're the ones who'd
  // otherwise have to chase a surveyor to upload a missing document just to unblock
  // completion. Surveyors still need the documents in place first.
  if (!user || user.role !== 'admin') {
    const { data: docs, error: docErr } = await supabase.from('job_documents').select('category').eq('job_id', id);
    check(docErr);
    const counts = { rams: 0, drawings: 0, photos: 0, permit: 0 };
    docs.forEach((d) => { counts[d.category] += 1; });
    const missing = REQUIRED_DOCUMENT_CATEGORIES.filter((c) => counts[c] === 0);
    if (missing.length) {
      throw new Error(`Cannot complete job: missing ${missing.map((c) => DOCUMENT_LABELS[c]).join(', ')}. Upload these documents to the job first.`);
    }
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

// Manual "this is an old version" flag - never set automatically on upload, since some
// categories (RAMS, photos) deliberately keep every one as a running history rather than
// having a new upload replace the last. Superseded docs stay in place, just visually
// deprioritised in the Job Detail document list rather than removed.
async function toggleDocumentSuperseded(jobId, category, docId, superseded) {
  if (!DOCUMENT_CATEGORIES.includes(category)) throw new Error('Invalid document category');
  const { data, error } = await supabase.from('job_documents')
    .update({ superseded: !!superseded })
    .eq('id', docId).eq('job_id', jobId).eq('category', category).select().maybeSingle();
  check(error);
  if (!data) throw new Error('Document not found');
  return rowToDocument(data);
}

// ---------- Job Assignments ----------
// Who's physically doing the work on a job (installation/manufacturing operatives) - see
// the schema comment in scripts/supabase-schema.sql. Admin creates/edits/deletes; surveyor
// gets the same list read-only; each operative only ever sees their own (listMyJobAssignments).
// Storage (photo uploads) is handled in server.js, same convention as job documents - this
// file only ever touches Postgres rows.

function rowToJobAssignment(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    userId: row.user_id,
    assignedBy: row.assigned_by,
    task: row.task,
    startDate: row.start_date,
    durationDays: Number(row.duration_days) || 1,
    endDate: row.end_date,
    completed: row.completed,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Joins job/operative names onto each assignment via separate queries + Promise.all, the
// same app-code-join pattern as attachDocuments/attachVariations above (not a SQL join).
async function attachJobAssignmentContext(assignments) {
  if (!assignments.length) return assignments;
  const jobIds = [...new Set(assignments.map((a) => a.jobId))];
  const userIds = [...new Set(assignments.map((a) => a.userId))];
  const [{ data: jobRows, error: jobErr }, { data: userRows, error: userErr }] = await Promise.all([
    supabase.from('jobs').select('id, job_reference, client, location').in('id', jobIds),
    supabase.from('users').select('id, name').in('id', userIds),
  ]);
  check(jobErr);
  check(userErr);
  const jobById = Object.fromEntries(jobRows.map((j) => [j.id, j]));
  const userById = Object.fromEntries(userRows.map((u) => [u.id, u]));
  assignments.forEach((a) => {
    const job = jobById[a.jobId] || {};
    const user = userById[a.userId] || {};
    a.jobReference = job.job_reference || '';
    a.jobClient = job.client || '';
    a.jobLocation = job.location || '';
    a.userName = user.name || '';
  });
  return assignments;
}

async function listJobAssignments() {
  const { data, error } = await supabase.from('job_assignments').select('*')
    .order('start_date', { ascending: false }).order('created_at', { ascending: false });
  check(error);
  const rows = data.map(rowToJobAssignment);
  await attachJobAssignmentContext(rows);
  return rows;
}

async function listMyJobAssignments(user) {
  const { data, error } = await supabase.from('job_assignments').select('*')
    .eq('user_id', user.id).order('start_date');
  check(error);
  const rows = data.map(rowToJobAssignment);
  await attachJobAssignmentContext(rows);
  await attachTodayTimeLog(rows);
  return rows;
}

// One batched query for today's clock-in status across every assignment, rather than a
// per-assignment round trip - lets the Home dashboard offer a direct "Clock In" button
// without needing to open each assignment's detail modal first.
async function attachTodayTimeLog(assignments) {
  if (!assignments.length) return assignments;
  const { data, error } = await supabase.from('assignment_time_logs').select('*')
    .in('assignment_id', assignments.map((a) => a.id)).eq('log_date', timeLogDateStr());
  check(error);
  const logByAssignment = Object.fromEntries(data.map((row) => [row.assignment_id, rowToTimeLog(row)]));
  assignments.forEach((a) => { a.todayTimeLog = logByAssignment[a.id] || null; });
  return assignments;
}

// Every assignment against one job, regardless of which operative - used by the Jobs tab's
// Clock Times section so admins/surveyors can see every operative's time log for a job without
// going through the separate Job Assignments tab.
async function listJobAssignmentsForJob(jobId) {
  const { data, error } = await supabase.from('job_assignments').select('*')
    .eq('job_id', jobId).order('start_date');
  check(error);
  const rows = data.map(rowToJobAssignment);
  await attachJobAssignmentContext(rows);
  return rows;
}

async function getJobAssignment(id) {
  const { data, error } = await supabase.from('job_assignments').select('*').eq('id', id).maybeSingle();
  check(error);
  if (!data) return null;
  const [row] = await attachJobAssignmentContext([rowToJobAssignment(data)]);
  return row;
}

function validateJobAssignmentInput(input) {
  const errors = [];
  if (!input.jobId) errors.push('Job is required');
  if (!input.userId) errors.push('Operative is required');
  if (!input.task || !input.task.trim()) errors.push('Task description is required');
  if (!input.startDate || !DATE_RE.test(input.startDate)) errors.push('A valid start date is required');
  const durationDays = Number(input.durationDays);
  if (!durationDays || isNaN(durationDays) || durationDays <= 0) errors.push('Duration must be a positive number of days');
  return errors;
}

async function assertAssignableUser(userId) {
  const { data: user, error } = await supabase.from('users').select('id, name').eq('id', userId).maybeSingle();
  check(error);
  if (!user) throw new Error('Chosen user does not exist');
  return user;
}

async function createJobAssignment(input, assignedByUser) {
  const errors = validateJobAssignmentInput(input);
  if (errors.length) throw new Error(errors.join('; '));
  const { data: job, error: jobErr } = await supabase.from('jobs').select('id').eq('id', input.jobId).maybeSingle();
  check(jobErr);
  if (!job) throw new Error('Job not found');
  const assignee = await assertAssignableUser(input.userId);
  const durationDays = Math.max(1, Math.ceil(Number(input.durationDays)));
  const endDate = addDaysToDateString(input.startDate, durationDays - 1);
  const conflict = await findHolidayConflict(input.userId, input.startDate, endDate);
  if (conflict) throw new Error(`${assignee.name} is on holiday ${conflict.date} to ${conflict.endDate} - can't assign them for this period`);
  const row = {
    id: genId(),
    job_id: input.jobId,
    user_id: input.userId,
    assigned_by: assignedByUser ? assignedByUser.id : null,
    task: input.task.trim(),
    start_date: input.startDate,
    duration_days: durationDays,
    end_date: endDate,
    completed: false,
    completed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('job_assignments').insert(row).select().single();
  check(error);
  return getJobAssignment(data.id);
}

async function updateJobAssignment(id, input) {
  const errors = validateJobAssignmentInput(input);
  if (errors.length) throw new Error(errors.join('; '));
  const assignee = await assertAssignableUser(input.userId);
  const durationDays = Math.max(1, Math.ceil(Number(input.durationDays)));
  const endDate = addDaysToDateString(input.startDate, durationDays - 1);
  const conflict = await findHolidayConflict(input.userId, input.startDate, endDate);
  if (conflict) throw new Error(`${assignee.name} is on holiday ${conflict.date} to ${conflict.endDate} - can't assign them for this period`);
  const { data, error } = await supabase.from('job_assignments')
    .update({
      job_id: input.jobId,
      user_id: input.userId,
      task: input.task.trim(),
      start_date: input.startDate,
      duration_days: durationDays,
      end_date: endDate,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id).select().maybeSingle();
  check(error);
  if (!data) throw new Error('Assignment not found');
  return getJobAssignment(id);
}

async function deleteJobAssignment(id) {
  const { error } = await supabase.from('job_assignments').delete().eq('id', id);
  check(error);
}

// Ownership-scoped, same trust boundary as diary entries: an operative can only ever mark
// their OWN assignment done, never someone else's - no admin override (admins correct
// mistakes by editing/deleting the assignment itself, same reasoning as diary entries).
async function setJobAssignmentCompleted(id, completed, user) {
  const { data: existing, error: findErr } = await supabase.from('job_assignments').select('*').eq('id', id).maybeSingle();
  check(findErr);
  if (!existing) throw new Error('Assignment not found');
  if (existing.user_id !== user.id) throw new Error('You can only update your own assignment');

  // Completing requires today's time log to already show they arrived - that's what makes
  // the "how long they were there" figure (arrivedAt -> completedAt) meaningful. Un-marking
  // (completed: false) has no time-log side effect - it's a status flag, the time log stays
  // as a historical record of what actually happened that day.
  if (completed) {
    const log = await getTodayTimeLog(id);
    if (!log || !log.arrivedAt) throw new Error('Clock in and mark yourself as arrived before completing the job');
    if (!log.completedAt) {
      const now = new Date().toISOString();
      const { error: logErr } = await supabase.from('assignment_time_logs')
        .update({ completed_at: now, updated_at: now }).eq('id', log.id);
      check(logErr);
    }
  }

  const { error } = await supabase.from('job_assignments')
    .update({ completed, completed_at: completed ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
    .eq('id', id);
  check(error);
  return getJobAssignment(id);
}

// ---------- Assignment Time Logs ----------
// One row per assignment per calendar day worked - see the schema comment in
// scripts/supabase-schema.sql for the full reasoning. All four timestamps are always
// server-stamped (new Date().toISOString()) at the moment the operative taps the relevant
// button - never client-supplied - so these can't be backdated or edited after the fact.
// Ownership checks (is this the assignment's own operative calling?) happen in server.js,
// same convention as the photo/permit routes - these functions just trust the assignmentId
// they're given.

function timeLogDateStr() {
  return new Date().toISOString().slice(0, 10);
}

function rowToTimeLog(row) {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    logDate: row.log_date,
    clockInAt: row.clock_in_at,
    arrivedAt: row.arrived_at,
    completedAt: row.completed_at,
    clockOutAt: row.clock_out_at,
    // Minutes actually on site, computed at read time rather than stored - only present
    // once both ends of the window exist.
    onSiteMinutes: (row.arrived_at && row.completed_at)
      ? Math.round((new Date(row.completed_at) - new Date(row.arrived_at)) / 60000)
      : null,
  };
}

async function getTodayTimeLog(assignmentId) {
  const { data, error } = await supabase.from('assignment_time_logs').select('*')
    .eq('assignment_id', assignmentId).eq('log_date', timeLogDateStr()).maybeSingle();
  check(error);
  return data ? rowToTimeLog(data) : null;
}

// All the daily logs for an assignment, most recent first - used for the admin/surveyor
// Time Log view and, for a multi-day job, to show the operative their own history too.
async function listTimeLogs(assignmentId) {
  const { data, error } = await supabase.from('assignment_time_logs').select('*')
    .eq('assignment_id', assignmentId).order('log_date', { ascending: false });
  check(error);
  return data.map(rowToTimeLog);
}

async function clockIn(assignmentId) {
  const { data: existing, error: findErr } = await supabase.from('assignment_time_logs').select('*')
    .eq('assignment_id', assignmentId).eq('log_date', timeLogDateStr()).maybeSingle();
  check(findErr);
  if (existing && existing.clock_in_at) throw new Error('Already clocked in today');
  const now = new Date().toISOString();
  if (existing) {
    const { error } = await supabase.from('assignment_time_logs')
      .update({ clock_in_at: now, updated_at: now }).eq('id', existing.id);
    check(error);
  } else {
    const { error } = await supabase.from('assignment_time_logs').insert({
      id: genId(), assignment_id: assignmentId, log_date: timeLogDateStr(),
      clock_in_at: now, created_at: now, updated_at: now,
    });
    check(error);
  }
  return getTodayTimeLog(assignmentId);
}

async function markArrived(assignmentId) {
  // RAMS is required at the JOB level, not per-assignment - if it's already on file (an
  // office upload, or another operative on this same job already did theirs), nobody else
  // assigned to it needs to submit their own. Only fall back to checking this assignment's
  // own submission (the pre-job-level-gate behaviour) when the job doesn't have one yet,
  // which also covers the rare case where a submission's auto-attach to the job's documents
  // failed - see attachRamsToJobDocuments in server.js.
  const mine = await getJobAssignmentRams(assignmentId);
  if (!mine) {
    const assignment = await getJobAssignment(assignmentId);
    const job = assignment ? await getJob(assignment.jobId) : null;
    const jobHasRams = !!(job && job.documents.rams && job.documents.rams.length);
    if (!jobHasRams) throw new Error('Submit your RAMS for this job before marking yourself as arrived');
  }
  const log = await getTodayTimeLog(assignmentId);
  if (!log || !log.clockInAt) throw new Error('Clock in before marking yourself as arrived');
  if (log.arrivedAt) throw new Error('Already marked as arrived today');
  const now = new Date().toISOString();
  const { error } = await supabase.from('assignment_time_logs')
    .update({ arrived_at: now, updated_at: now }).eq('id', log.id);
  check(error);
  return getTodayTimeLog(assignmentId);
}

// Deliberately doesn't require arrivedAt - if they get called off before reaching site,
// they should still be able to clock out for the day rather than being stuck.
async function clockOut(assignmentId) {
  const log = await getTodayTimeLog(assignmentId);
  if (!log || !log.clockInAt) throw new Error('Clock in before clocking out');
  if (log.clockOutAt) throw new Error('Already clocked out today');
  const now = new Date().toISOString();
  const { error } = await supabase.from('assignment_time_logs')
    .update({ clock_out_at: now, updated_at: now }).eq('id', log.id);
  check(error);
  return getTodayTimeLog(assignmentId);
}

// ---------- Job Assignment RAMS ----------
// One RAMS (Risk Assessment & Method Statement) submission per job_assignment, not per day -
// the operative reviews/adjusts risk controls and hazards once for the whole assignment stint
// before starting work. Required before markArrived (see the gate above). Locks once they've
// actually marked themselves arrived on any day, so it stays a stable record of what they
// agreed to before starting - an admin editing/deleting the assignment is the only way to
// change it after that point.

function rowToJobAssignmentRams(row) {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    methodStatement: row.method_statement,
    hazards: row.hazards || [],
    operativeName: row.operative_name,
    signatureImage: row.signature_image,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getJobAssignmentRams(assignmentId) {
  const { data, error } = await supabase.from('job_assignment_rams').select('*')
    .eq('assignment_id', assignmentId).maybeSingle();
  check(error);
  return data ? rowToJobAssignmentRams(data) : null;
}

// Job-level view for the Assignment Detail modal: whether the JOB this assignment is on
// already has any RAMS document on file at all (an office upload, a library/custom RA
// attached from the Job Detail Rams tab, or any operative's own dynamic submission - all of
// these land in job.documents.rams, see attachRamsToJobDocuments in server.js and
// jobsMissingRams in app.js, which already treats job.documents.rams the same way). If so,
// nobody else assigned to the job needs to submit their own - they can just read what's there.
async function getJobAssignmentRamsStatus(assignmentId) {
  const assignment = await getJobAssignment(assignmentId);
  if (!assignment) return null;
  const job = await getJob(assignment.jobId);
  const documents = (job && job.documents.rams) || [];
  return { jobHasRams: documents.length > 0, documents };
}

function sanitizeRamsHazards(hazards) {
  return (Array.isArray(hazards) ? hazards : []).map((h) => ({
    id: h && h.id ? String(h.id).slice(0, 100) : null,
    title: String((h && h.title) || '').trim(),
    legislation: String((h && h.legislation) || '').trim(),
    hazard: String((h && h.hazard) || '').trim(),
    peopleAffected: String((h && h.peopleAffected) || '').trim(),
    currentControls: sanitizeRaList(h && h.currentControls),
    currentL: sanitizeRaRating(h && h.currentL),
    currentC: sanitizeRaRating(h && h.currentC),
    additionalControls: sanitizeRaList(h && h.additionalControls),
    additionalL: sanitizeRaRating(h && h.additionalL),
    additionalC: sanitizeRaRating(h && h.additionalC),
    ppe: sanitizeRaList(h && h.ppe),
  }));
}

function validateJobAssignmentRamsInput(input) {
  const errors = [];
  const methodStatement = (input.methodStatement || '').trim();
  if (!methodStatement) errors.push('A method statement is required');
  const hazards = sanitizeRamsHazards(input.hazards);
  if (!hazards.length) errors.push('At least one hazard is required');
  hazards.forEach((h, i) => {
    if (!h.title) errors.push(`Hazard ${i + 1}: a title is required`);
    if (!h.currentControls.length) errors.push(`Hazard ${i + 1}: at least one current risk control is required`);
  });
  const operativeName = (input.operativeName || '').trim();
  if (!operativeName) errors.push('Your name is required');
  if (errors.length) throw new Error(errors.join('. '));
  return { methodStatement, hazards, operativeName };
}

async function createJobAssignmentRams(assignmentId, input) {
  const { methodStatement, hazards, operativeName } = validateJobAssignmentRamsInput(input);
  const signatureImage = String(input.signatureImage || '');
  if (!signatureImage) throw new Error('Sign before saving');

  const existing = await getJobAssignmentRams(assignmentId);
  if (existing) {
    const log = await getTodayTimeLog(assignmentId);
    if (log && log.arrivedAt) throw new Error("RAMS is locked once you've marked yourself arrived - ask an admin to make changes");
    const { data, error } = await supabase.from('job_assignment_rams')
      .update({
        method_statement: methodStatement,
        hazards,
        operative_name: operativeName,
        signature_image: signatureImage,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id).select().maybeSingle();
    check(error);
    return rowToJobAssignmentRams(data);
  }

  const row = {
    id: genId(),
    assignment_id: assignmentId,
    method_statement: methodStatement,
    hazards,
    operative_name: operativeName,
    signature_image: signatureImage,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('job_assignment_rams').insert(row).select().single();
  check(error);
  return rowToJobAssignmentRams(data);
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

// ---------- CAD Drawings ----------
// Admin/surveyor-only 2D drafting tool. Unlike the library tables above, the drawing itself
// (geometry, layers, dimensions) is stored as JSON in scene_data so it can be reopened and
// edited, not just downloaded - see public/cad.js for the shape of that JSON.

function rowToCadDrawing(row) {
  return {
    id: row.id,
    name: row.name,
    jobId: row.job_id || null,
    sceneData: row.scene_data || {},
    thumbnailStoredName: row.thumbnail_stored_name || null,
    createdBy: row.created_by || '',
    updatedBy: row.updated_by || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Summary rows (used by the list view) deliberately omit scene_data - a drawing's full
// geometry can be sizeable, and the list only ever needs the metadata to render its cards.
function rowToCadDrawingSummary(row) {
  return {
    id: row.id,
    name: row.name,
    jobId: row.job_id || null,
    thumbnailStoredName: row.thumbnail_stored_name || null,
    createdBy: row.created_by || '',
    updatedBy: row.updated_by || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listCadDrawings() {
  const { data, error } = await supabase
    .from('cad_drawings')
    .select('id, name, job_id, thumbnail_stored_name, created_by, updated_by, created_at, updated_at')
    .order('updated_at', { ascending: false });
  check(error);
  return data.map(rowToCadDrawingSummary);
}

async function getCadDrawing(id) {
  const { data, error } = await supabase.from('cad_drawings').select('*').eq('id', id).maybeSingle();
  check(error);
  return data ? rowToCadDrawing(data) : null;
}

async function addCadDrawing({ name, sceneData, createdBy }) {
  const trimmedName = (name || '').trim();
  if (!trimmedName) throw new Error('Name is required');
  const row = {
    id: genId(),
    name: trimmedName,
    scene_data: sceneData || {},
    created_by: createdBy || null,
    updated_by: createdBy || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('cad_drawings').insert(row).select().single();
  check(error);
  return rowToCadDrawing(data);
}

async function updateCadDrawing(id, { name, sceneData, updatedBy }) {
  const patch = { updated_by: updatedBy || null, updated_at: new Date().toISOString() };
  if (name !== undefined) {
    const trimmedName = (name || '').trim();
    if (!trimmedName) throw new Error('Name is required');
    patch.name = trimmedName;
  }
  if (sceneData !== undefined) patch.scene_data = sceneData;
  const { data, error } = await supabase.from('cad_drawings').update(patch).eq('id', id).select().maybeSingle();
  check(error);
  if (!data) return null;
  return rowToCadDrawing(data);
}

async function setCadDrawingThumbnail(id, storedName) {
  const { data, error } = await supabase
    .from('cad_drawings')
    .update({ thumbnail_stored_name: storedName })
    .eq('id', id)
    .select()
    .maybeSingle();
  check(error);
  return data ? rowToCadDrawing(data) : null;
}

async function deleteCadDrawing(id) {
  const drawing = await getCadDrawing(id);
  if (!drawing) return null;
  const { error } = await supabase.from('cad_drawings').delete().eq('id', id);
  check(error);
  return drawing;
}

// ---------- Custom Risk Assessments (edited "Save As" copies) ----------
// Staff can open any risk assessment (a generic in-code template or another custom one),
// edit it, and "Save As" a new copy here - never overwrites the original, so the in-code
// templates stay untouched and nothing already saved is ever lost.

function sanitizeRaList(items) {
  return (Array.isArray(items) ? items : []).map((s) => String(s || '').trim()).filter(Boolean);
}

function sanitizeRaRating(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(5, Math.max(1, Math.round(v))) : 1;
}

function rowToCustomRiskAssessment(row) {
  const currentR = row.current_l * row.current_c;
  const additionalR = row.additional_l * row.additional_c;
  return {
    id: row.id,
    title: row.title,
    legislation: row.legislation || '',
    hazard: row.hazard || '',
    peopleAffected: row.people_affected || '',
    currentControls: row.current_controls || [],
    currentL: row.current_l,
    currentC: row.current_c,
    currentR,
    currentBand: riskBand(currentR),
    additionalControls: row.additional_controls || [],
    additionalL: row.additional_l,
    additionalC: row.additional_c,
    additionalR,
    additionalBand: riskBand(additionalR),
    ppe: row.ppe || [],
    basedOn: row.based_on || null,
    createdBy: row.created_by || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listCustomRiskAssessments() {
  const { data, error } = await supabase.from('custom_risk_assessments').select('*').order('title');
  check(error);
  return data.map(rowToCustomRiskAssessment);
}

async function getCustomRiskAssessment(id) {
  const { data, error } = await supabase.from('custom_risk_assessments').select('*').eq('id', id).maybeSingle();
  check(error);
  return data ? rowToCustomRiskAssessment(data) : null;
}

async function createCustomRiskAssessment(input, createdBy) {
  const title = (input.title || '').trim();
  if (!title) throw new Error('Title is required');
  const currentControls = sanitizeRaList(input.currentControls);
  if (!currentControls.length) throw new Error('At least one current risk control is required');

  const row = {
    id: genId(),
    title,
    legislation: (input.legislation || '').trim(),
    hazard: (input.hazard || '').trim(),
    people_affected: (input.peopleAffected || '').trim(),
    current_controls: currentControls,
    current_l: sanitizeRaRating(input.currentL),
    current_c: sanitizeRaRating(input.currentC),
    additional_controls: sanitizeRaList(input.additionalControls),
    additional_l: sanitizeRaRating(input.additionalL),
    additional_c: sanitizeRaRating(input.additionalC),
    ppe: sanitizeRaList(input.ppe),
    based_on: input.basedOn ? String(input.basedOn).slice(0, 100) : null,
    created_by: createdBy || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('custom_risk_assessments').insert(row).select().single();
  check(error);
  return rowToCustomRiskAssessment(data);
}

async function deleteCustomRiskAssessment(id) {
  const ra = await getCustomRiskAssessment(id);
  if (!ra) return null;
  const { error } = await supabase.from('custom_risk_assessments').delete().eq('id', id);
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

// Shared compliance-date check (currently used by subby insurance expiry) - null if no date
// is on file at all, since that's a different situation ("nothing recorded") from an actual
// expired/expiring one and callers may want to treat it differently.
const EXPIRY_SOON_DAYS = 30;
function expiryStatus(expiryDate) {
  if (!expiryDate) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (expiryDate < today) return 'expired';
  if (expiryDate <= addDaysToDateString(today, EXPIRY_SOON_DAYS)) return 'expiring-soon';
  return 'ok';
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
    isHoliday: !!row.is_holiday,
    createdAt: row.created_at,
  };
}

// Used when creating/updating a job assignment (see createJobAssignment/updateJobAssignment)
// - finds the first holiday that overlaps the assignment's date range, regardless of
// is_private, since a holiday always blocks an assignment even though most personal calendar
// entries stay hidden from everyone else.
async function findHolidayConflict(userId, startDate, endDate) {
  const { data, error } = await supabase.from('calendar_events').select('*')
    .eq('user_id', userId).eq('is_holiday', true)
    .lte('date', endDate).gte('end_date', startDate)
    .order('date').limit(1);
  check(error);
  return data.length ? rowToEvent(data[0]) : null;
}

// Returns public entries plus this user's own private ones - never another user's private
// entries, since those only ever belong on that person's own "My Calendar". Staff and
// operatives don't get the shared team calendar at all (see the allowlists in server.js),
// so they only ever get their own entries, public or private.
async function listCalendarEvents(user) {
  let query = supabase.from('calendar_events').select('*');
  const ownOnly = user.role === 'staff' || OPERATIVE_ROLES.includes(user.role);
  query = ownOnly ? query.eq('user_id', user.id) : query.or(`is_private.eq.false,user_id.eq.${user.id}`);
  const { data, error } = await query.order('date').order('created_at');
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
  const isHoliday = !!input.isHoliday;

  // A holiday can be logged on someone else's behalf if you're an admin (e.g. entering
  // approved leave for the team) - everyone else, and every other kind of entry, can only
  // ever be posted as yourself, same as before.
  let owner = user;
  if (isHoliday && user.role === 'admin' && input.userId) {
    const { data: targetUser, error: userErr } = await supabase.from('users').select('id, name')
      .eq('id', input.userId).maybeSingle();
    check(userErr);
    if (!targetUser) throw new Error('Chosen employee does not exist');
    owner = { id: targetUser.id, name: targetUser.name };
  }

  const spanDays = durationUnit === 'days' ? Math.max(1, Math.ceil(durationValue)) : 1;
  const row = {
    id: genId(),
    user_id: owner.id,
    user_name: owner.name,
    date: input.date,
    end_date: addDaysToDateString(input.date, spanDays - 1),
    title,
    duration_value: durationValue,
    duration_unit: durationUnit,
    start_time: startTime,
    end_time: endTime,
    // Holidays are always visible to everyone (never private) so the whole team can see
    // who's off when planning jobs - not user-choosable like an ordinary personal entry.
    is_private: isHoliday ? false : !!input.isPrivate,
    is_holiday: isHoliday,
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

// ---------- Job Costing (profit/loss) ----------
// Per-job costing breakdown shown in the Job Detail modal's Costing tab - same shape as the
// paper job-costing spreadsheet this replaces (Employee Hours / Sub Contractor / Materials
// sections, a markup % per materials/subby line, Grand Total, Profit, Spent).

const JOB_COSTING_SECTIONS = ['materials', 'subby'];

function rowToCostingLine(row) {
  const amounts = (row.amounts || []).map(Number).filter((n) => !isNaN(n));
  const unitPrice = amounts.reduce((sum, a) => sum + a, 0);
  const markupPercent = Number(row.markup_percent) || 0;
  const markupAmount = unitPrice * (markupPercent / 100);
  return {
    id: row.id,
    jobId: row.job_id,
    section: row.section,
    description: row.description,
    amounts,
    unitPrice,
    markupPercent,
    markupAmount,
    total: unitPrice + markupAmount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listJobCostingLines(jobId) {
  const { data, error } = await supabase.from('job_costing_lines').select('*').eq('job_id', jobId).order('created_at');
  check(error);
  return data.map(rowToCostingLine);
}

function validateCostingLineInput(input) {
  if (!JOB_COSTING_SECTIONS.includes(input.section)) throw new Error('Invalid costing section');
  const description = (input.description || '').trim();
  if (!description) throw new Error('A description is required');
  const amounts = (Array.isArray(input.amounts) ? input.amounts : [])
    .map(Number).filter((n) => !isNaN(n) && n >= 0);
  const markupPercent = Number(input.markupPercent);
  return { description, amounts, markupPercent: isNaN(markupPercent) ? 30 : markupPercent };
}

async function createJobCostingLine(jobId, input) {
  const { description, amounts, markupPercent } = validateCostingLineInput(input);
  const row = {
    id: genId(),
    job_id: jobId,
    section: input.section,
    description,
    amounts,
    markup_percent: markupPercent,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('job_costing_lines').insert(row).select().single();
  check(error);
  return rowToCostingLine(data);
}

async function updateJobCostingLine(id, input) {
  const { data: existing, error: findErr } = await supabase.from('job_costing_lines').select('section').eq('id', id).maybeSingle();
  check(findErr);
  if (!existing) throw new Error('Costing line not found');
  const { description, amounts, markupPercent } = validateCostingLineInput({ ...input, section: existing.section });
  const { data, error } = await supabase.from('job_costing_lines')
    .update({ description, amounts, markup_percent: markupPercent, updated_at: new Date().toISOString() })
    .eq('id', id).select().maybeSingle();
  check(error);
  if (!data) throw new Error('Costing line not found');
  return rowToCostingLine(data);
}

async function deleteJobCostingLine(id) {
  const { error } = await supabase.from('job_costing_lines').delete().eq('id', id);
  check(error);
}

// Employee hours for a job's Labour section: total clocked hours (clock-in to clock-out,
// summed across every day logged) per employee assigned to this job, using a saved override
// instead of the computed figure if one exists (see setJobCostingLabourHours). The rate isn't
// stored anywhere new - it's looked up from the existing Labour Rates list (price_list_items,
// kind='labour') by matching the job's client name, so adding/editing a rate there is all
// that's needed for a job against that client to pick it up automatically. No match at all
// means there's genuinely nothing to base a cost on yet - returned as rate: null rather than
// guessing a number, so the Costing tab can prompt to add one instead of silently costing £0.
async function getJobCostingLabour(jobId) {
  const job = await getJob(jobId);
  if (!job) throw new Error('Job not found');

  const assignments = await listJobAssignmentsForJob(jobId);
  const [{ data: logs, error: logsErr }, { data: overrides, error: overridesErr }, { data: rateRows, error: rateErr }] = await Promise.all([
    assignments.length
      ? supabase.from('assignment_time_logs').select('*').in('assignment_id', assignments.map((a) => a.id))
      : Promise.resolve({ data: [], error: null }),
    supabase.from('job_costing_labour_overrides').select('*').eq('job_id', jobId),
    supabase.from('price_list_items').select('*').eq('kind', 'labour'),
  ]);
  check(logsErr);
  check(overridesErr);
  check(rateErr);

  const clientNorm = (job.client || '').trim().toLowerCase();
  const rateMatch = (rateRows || []).find((r) => r.name.trim().toLowerCase() === clientNorm);
  const rate = rateMatch ? Number(rateMatch.price) : null;

  const hoursByAssignment = {};
  for (const log of logs) {
    if (!log.clock_in_at || !log.clock_out_at) continue;
    const hrs = (new Date(log.clock_out_at) - new Date(log.clock_in_at)) / 3600000;
    hoursByAssignment[log.assignment_id] = (hoursByAssignment[log.assignment_id] || 0) + hrs;
  }
  const hoursByUser = {};
  const nameByUser = {};
  for (const a of assignments) {
    hoursByUser[a.userId] = (hoursByUser[a.userId] || 0) + (hoursByAssignment[a.id] || 0);
    nameByUser[a.userId] = a.userName;
  }
  const overrideByUser = Object.fromEntries((overrides || []).map((o) => [o.user_id, Number(o.hours)]));

  const userIds = [...new Set([...Object.keys(hoursByUser), ...Object.keys(overrideByUser)])];

  const employees = userIds.map((userId) => {
    const computedHours = Math.round((hoursByUser[userId] || 0) * 100) / 100;
    const hasOverride = Object.prototype.hasOwnProperty.call(overrideByUser, userId);
    const hours = hasOverride ? overrideByUser[userId] : computedHours;
    return {
      userId,
      userName: nameByUser[userId] || '(former employee)',
      computedHours,
      hours,
      overridden: hasOverride,
      rate,
      total: rate === null ? 0 : hours * rate,
    };
  }).sort((a, b) => a.userName.localeCompare(b.userName));

  const totalHours = employees.reduce((sum, e) => sum + e.hours, 0);
  const total = employees.reduce((sum, e) => sum + e.total, 0);

  return { clientName: job.client, rate, employees, totalHours, total };
}

async function setJobCostingLabourHours(jobId, userId, hours) {
  const n = Number(hours);
  if (isNaN(n) || n < 0) throw new Error('Hours must be a positive number');
  const { data: existing, error: findErr } = await supabase.from('job_costing_labour_overrides')
    .select('id').eq('job_id', jobId).eq('user_id', userId).maybeSingle();
  check(findErr);
  if (existing) {
    const { error } = await supabase.from('job_costing_labour_overrides')
      .update({ hours: n, updated_at: new Date().toISOString() }).eq('id', existing.id);
    check(error);
  } else {
    const { error } = await supabase.from('job_costing_labour_overrides').insert({
      id: genId(), job_id: jobId, user_id: userId, hours: n,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    check(error);
  }
}

async function clearJobCostingLabourHours(jobId, userId) {
  const { error } = await supabase.from('job_costing_labour_overrides').delete().eq('job_id', jobId).eq('user_id', userId);
  check(error);
}

// Full profit/loss summary for the Costing tab. Grand Total (what Profit is based on)
// includes the materials/subby markup, matching how the existing paper job sheet calculates
// Profit = Quoted Price - Grand Total; Spent is the separate, raw-cost (no markup) actual
// cash-outlay figure the same sheet also tracks - both are kept, not collapsed into one.
async function getJobCostingSummary(jobId) {
  const job = await getJob(jobId);
  if (!job) throw new Error('Job not found');
  const [labour, lines] = await Promise.all([getJobCostingLabour(jobId), listJobCostingLines(jobId)]);
  const materialsLines = lines.filter((l) => l.section === 'materials');
  const subbyLines = lines.filter((l) => l.section === 'subby');
  const sumField = (arr, field) => arr.reduce((sum, l) => sum + l[field], 0);

  const materialsTotal = sumField(materialsLines, 'total');
  const materialsRaw = sumField(materialsLines, 'unitPrice');
  const subbyTotal = sumField(subbyLines, 'total');
  const subbyRaw = sumField(subbyLines, 'unitPrice');

  const grandTotal = labour.total + materialsTotal + subbyTotal;
  const spent = labour.total + materialsRaw + subbyRaw;
  const quotedPrice = Number(job.value) || 0;

  return {
    labour,
    materialsLines,
    subbyLines,
    materialsTotal,
    subbyTotal,
    grandTotal,
    spent,
    quotedPrice,
    profit: quotedPrice - grandTotal,
  };
}

// ---------- Subbies (subcontractor directory) ----------
// Shared contact list anyone can add to - not scoped to any one job or user.

function rowToSubby(row) {
  return {
    id: row.id,
    companyName: row.company_name,
    personName: row.person_name,
    phone: row.phone,
    trade: row.trade,
    formOriginalName: row.form_original_name,
    formStoredName: row.form_stored_name,
    formSize: row.form_size,
    insuranceExpiry: row.insurance_expiry || null,
    insuranceStatus: expiryStatus(row.insurance_expiry),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listSubbies() {
  const { data, error } = await supabase.from('subbies').select('*').order('company_name');
  check(error);
  return data.map(rowToSubby);
}

// Subbies whose insurance/compliance document is already expired or due within
// EXPIRY_SOON_DAYS - used by the Home dashboard's compliance card.
async function listSubbiesExpiring() {
  const all = await listSubbies();
  return all
    .filter((s) => s.insuranceStatus === 'expired' || s.insuranceStatus === 'expiring-soon')
    .sort((a, b) => (a.insuranceExpiry || '').localeCompare(b.insuranceExpiry || ''));
}

async function getSubby(id) {
  const { data, error } = await supabase.from('subbies').select('*').eq('id', id).maybeSingle();
  check(error);
  return data ? rowToSubby(data) : null;
}

function parseOptionalDate(value, label) {
  const clean = (value || '').trim();
  if (!clean) return null;
  if (!DATE_RE.test(clean)) throw new Error(`${label} must be a valid date`);
  return clean;
}

async function createSubby(input, fileInfo) {
  const companyName = (input.companyName || '').trim();
  const personName = (input.personName || '').trim();
  if (!companyName) throw new Error('Company name is required');
  if (!personName) throw new Error('Person\'s name is required');
  if (!fileInfo || !fileInfo.storedName) throw new Error('Subcontractor form is required');
  const insuranceExpiry = parseOptionalDate(input.insuranceExpiry, 'Insurance expiry');

  const row = {
    id: genId(),
    company_name: companyName,
    person_name: personName,
    phone: (input.phone || '').trim() || null,
    trade: (input.trade || '').trim() || null,
    insurance_expiry: insuranceExpiry,
    form_original_name: fileInfo.originalName,
    form_stored_name: fileInfo.storedName,
    form_size: fileInfo.size,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('subbies').insert(row).select().single();
  check(error);
  return rowToSubby(data);
}

async function updateSubby(id, input) {
  const companyName = (input.companyName || '').trim();
  const personName = (input.personName || '').trim();
  if (!companyName) throw new Error('Company name is required');
  if (!personName) throw new Error('Person\'s name is required');
  const insuranceExpiry = parseOptionalDate(input.insuranceExpiry, 'Insurance expiry');

  const { data, error } = await supabase.from('subbies')
    .update({
      company_name: companyName,
      person_name: personName,
      phone: (input.phone || '').trim() || null,
      trade: (input.trade || '').trim() || null,
      insurance_expiry: insuranceExpiry,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id).select().maybeSingle();
  check(error);
  if (!data) throw new Error('Subby not found');
  return rowToSubby(data);
}

async function deleteSubby(id) {
  const subby = await getSubby(id);
  if (!subby) return null;
  const { error } = await supabase.from('subbies').delete().eq('id', id);
  check(error);
  return subby;
}

// ---------- Quoting ----------
// Jobs that need a quote, distributed to surveyors. Anyone signed in can see the list;
// only admins and users with can_manage_quotes may add, edit, reassign or delete one. The
// surveyor a quote is assigned to can still tick it off themselves once it's done.

function rowToQuote(row) {
  return {
    id: row.id,
    clientName: row.client_name,
    siteAddress: row.site_address,
    description: row.description,
    dueDate: row.due_date,
    assignedTo: row.assigned_to,
    quoted: row.quoted,
    quotedAt: row.quoted_at,
    value: row.value === null || row.value === undefined ? null : Number(row.value),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseOptionalQuoteValue(input) {
  if (input === undefined || input === null || input === '') return null;
  const n = Number(input);
  if (isNaN(n)) throw new Error('Value must be a number');
  return n;
}

async function listQuotes() {
  const { data, error } = await supabase.from('quotes').select('*').order('quoted').order('due_date', { nullsFirst: false });
  check(error);
  return data.map(rowToQuote);
}

async function getQuote(id) {
  const { data, error } = await supabase.from('quotes').select('*').eq('id', id).maybeSingle();
  check(error);
  return data ? rowToQuote(data) : null;
}

async function createQuote(input, user) {
  if (!userCanManageQuotes(user)) throw new Error('Only quoting managers can add quotes');
  const clientName = (input.clientName || '').trim();
  if (!clientName) throw new Error('Client name is required');

  const row = {
    id: genId(),
    client_name: clientName,
    site_address: (input.siteAddress || '').trim() || null,
    description: (input.description || '').trim() || null,
    due_date: input.dueDate || null,
    assigned_to: input.assignedTo || null,
    value: parseOptionalQuoteValue(input.value),
    quoted: false,
    created_by: user.id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('quotes').insert(row).select().single();
  check(error);
  return rowToQuote(data);
}

async function updateQuote(id, input, user) {
  if (!userCanManageQuotes(user)) throw new Error('Only quoting managers can edit quotes');
  const clientName = (input.clientName || '').trim();
  if (!clientName) throw new Error('Client name is required');

  const { data, error } = await supabase.from('quotes')
    .update({
      client_name: clientName,
      site_address: (input.siteAddress || '').trim() || null,
      description: (input.description || '').trim() || null,
      due_date: input.dueDate || null,
      assigned_to: input.assignedTo || null,
      value: parseOptionalQuoteValue(input.value),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id).select().maybeSingle();
  check(error);
  if (!data) throw new Error('Quote not found');
  return rowToQuote(data);
}

async function setQuoteQuoted(id, quoted, user) {
  const quote = await getQuote(id);
  if (!quote) throw new Error('Quote not found');
  if (!userCanManageQuotes(user) && quote.assignedTo !== user.id) {
    throw new Error('Only the assigned surveyor or a quoting manager can update this');
  }
  const { data, error } = await supabase.from('quotes')
    .update({
      quoted: !!quoted,
      quoted_at: quoted ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id).select().maybeSingle();
  check(error);
  return rowToQuote(data);
}

async function deleteQuote(id, user) {
  if (!userCanManageQuotes(user)) throw new Error('Only quoting managers can delete quotes');
  const { error } = await supabase.from('quotes').delete().eq('id', id);
  check(error);
}

// ---------- Hire ----------
// Admin-only tracker for hired-in plant/equipment. Due-back date and overdue/due-soon
// flagging are computed at read time from hire_date + duration, not stored, so they're
// always correct against today rather than going stale.

const HIRE_DURATION_UNITS = ['days', 'weeks'];
const HIRE_DUE_SOON_DAYS = 3; // flag as "Due Soon" once within this many days of due back

function hireDueBackDate(hireDate, durationValue, durationUnit) {
  const days = durationUnit === 'weeks' ? Math.round(durationValue * 7) : Math.round(durationValue);
  return addDaysToDateString(hireDate, days);
}

function hireStatus(dueBack, returnedAt) {
  if (returnedAt) return 'returned';
  const today = new Date().toISOString().slice(0, 10);
  if (dueBack < today) return 'overdue';
  if (dueBack <= addDaysToDateString(today, HIRE_DUE_SOON_DAYS)) return 'due-soon';
  return 'on-hire';
}

function rowToHire(row) {
  const dueBack = hireDueBackDate(row.hire_date, Number(row.duration_value), row.duration_unit);
  return {
    id: row.id,
    item: row.item,
    supplier: row.supplier || '',
    jobNumber: row.job_number || '',
    hireDate: row.hire_date,
    quantity: Number(row.quantity) || 1,
    durationValue: Number(row.duration_value) || 1,
    durationUnit: row.duration_unit,
    dueBack,
    returnedAt: row.returned_at || '',
    status: hireStatus(dueBack, row.returned_at),
    createdAt: row.created_at,
  };
}

async function listHires() {
  const { data, error } = await supabase.from('hires').select('*');
  check(error);
  const hires = data.map((r) => rowToHire(r));
  const rank = { overdue: 0, 'due-soon': 1, 'on-hire': 2, returned: 3 };
  return hires.sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    return a.dueBack.localeCompare(b.dueBack);
  });
}

function validateHireInput(input) {
  const item = (input.item || '').trim();
  if (!item) throw new Error('Item is required');
  const hireDate = input.hireDate;
  if (!hireDate || !DATE_RE.test(hireDate)) throw new Error('A valid hire date is required');
  const quantity = Number(input.quantity);
  if (isNaN(quantity) || quantity <= 0) throw new Error('Quantity must be a positive number');
  const durationValue = Number(input.durationValue);
  if (isNaN(durationValue) || durationValue <= 0) throw new Error('Length of hire must be a positive number');
  const durationUnit = HIRE_DURATION_UNITS.includes(input.durationUnit) ? input.durationUnit : 'days';
  return {
    item,
    supplier: (input.supplier || '').trim(),
    job_number: (input.jobNumber || '').trim(),
    hire_date: hireDate,
    quantity,
    duration_value: durationValue,
    duration_unit: durationUnit,
  };
}

async function createHire(input) {
  const row = {
    id: genId(),
    ...validateHireInput(input),
    returned_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('hires').insert(row).select().single();
  check(error);
  return rowToHire(data);
}

async function updateHire(id, input) {
  const row = { ...validateHireInput(input), updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from('hires').update(row).eq('id', id).select().maybeSingle();
  check(error);
  if (!data) throw new Error('Hire not found');
  return rowToHire(data);
}

async function markHireReturned(id) {
  const { data, error } = await supabase.from('hires')
    .update({ returned_at: new Date().toISOString().slice(0, 10), updated_at: new Date().toISOString() })
    .eq('id', id).select().maybeSingle();
  check(error);
  if (!data) throw new Error('Hire not found');
  return rowToHire(data);
}

async function deleteHire(id) {
  const { error } = await supabase.from('hires').delete().eq('id', id);
  check(error);
}

// ---------- Vehicle Hire ----------
// Admin-only tracker for hired-in vehicles. Unlike plant Hire, there's no due-back date -
// a vehicle just sits "on-hire" until someone off-hires it (one-way, via markVehicleHireOffHired),
// at which point the off-hire date, who signed it back out, and any damage comments get
// recorded - signed_out only ever makes sense at the point a vehicle goes off hire, so it's
// not collected on create/update, only in markVehicleHireOffHired below.

function rowToVehicleHire(row) {
  return {
    id: row.id,
    supplier: row.supplier || '',
    hireDate: row.hire_date,
    registration: row.registration,
    make: row.make || '',
    model: row.model || '',
    signedIn: row.signed_in || '',
    signedOut: row.signed_out || '',
    offHireDate: row.off_hire_date || '',
    damageComments: row.damage_comments || '',
    status: row.off_hire_date ? 'off-hire' : 'on-hire',
    createdAt: row.created_at,
  };
}

async function listVehicleHires() {
  const { data, error } = await supabase.from('vehicle_hires').select('*').order('hire_date', { ascending: false });
  check(error);
  return data.map((r) => rowToVehicleHire(r));
}

function validateVehicleHireInput(input) {
  const registration = (input.registration || '').trim();
  if (!registration) throw new Error('Registration is required');
  const hireDate = input.hireDate;
  if (!hireDate || !DATE_RE.test(hireDate)) throw new Error('A valid hire date is required');
  return {
    supplier: (input.supplier || '').trim(),
    hire_date: hireDate,
    registration,
    make: (input.make || '').trim(),
    model: (input.model || '').trim(),
    signed_in: (input.signedIn || '').trim(),
  };
}

async function createVehicleHire(input) {
  const row = {
    id: genId(),
    ...validateVehicleHireInput(input),
    signed_out: null,
    off_hire_date: null,
    damage_comments: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('vehicle_hires').insert(row).select().single();
  check(error);
  return rowToVehicleHire(data);
}

async function updateVehicleHire(id, input) {
  const row = { ...validateVehicleHireInput(input), updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from('vehicle_hires').update(row).eq('id', id).select().maybeSingle();
  check(error);
  if (!data) throw new Error('Vehicle hire not found');
  return rowToVehicleHire(data);
}

async function markVehicleHireOffHired(id, signedOut, comments) {
  const { data, error } = await supabase.from('vehicle_hires')
    .update({
      signed_out: (signedOut || '').trim() || null,
      off_hire_date: new Date().toISOString().slice(0, 10),
      damage_comments: (comments || '').trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id).select().maybeSingle();
  check(error);
  if (!data) throw new Error('Vehicle hire not found');
  return rowToVehicleHire(data);
}

async function deleteVehicleHire(id) {
  const { error } = await supabase.from('vehicle_hires').delete().eq('id', id);
  check(error);
}

// ---------- Assets ----------
// Plant/tools/equipment tracked via printed QR labels - scan out (who's got it, optionally
// which job), scan back in with an immediate condition check (see checkInAsset), and a
// damaged item goes to 'repairs' instead of back into circulation until markAssetRepaired
// puts it back into service. Unlike Hire above, status here is event-driven (scan actions),
// not date-derived, so it's a real stored column rather than computed at read time.

const ASSET_STATUSES = ['available', 'checked_out', 'repairs'];

function rowToAsset(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category || '',
    qrToken: row.qr_token,
    status: row.status,
    currentJobId: row.current_job_id || null,
    currentHolderUserId: row.current_holder_user_id || null,
    checkedOutAt: row.checked_out_at || null,
    lastConditionStatus: row.last_condition_status || null,
    lastConditionNotes: row.last_condition_notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Joins job reference/client and holder name onto each asset - same app-code-join pattern
// as attachJobAssignmentContext, just skipped for assets that aren't currently checked out.
async function attachAssetContext(assets) {
  const jobIds = [...new Set(assets.filter((a) => a.currentJobId).map((a) => a.currentJobId))];
  const userIds = [...new Set(assets.filter((a) => a.currentHolderUserId).map((a) => a.currentHolderUserId))];
  const [{ data: jobRows, error: jobErr }, { data: userRows, error: userErr }] = await Promise.all([
    jobIds.length ? supabase.from('jobs').select('id, job_reference, client').in('id', jobIds) : Promise.resolve({ data: [], error: null }),
    userIds.length ? supabase.from('users').select('id, name').in('id', userIds) : Promise.resolve({ data: [], error: null }),
  ]);
  check(jobErr);
  check(userErr);
  const jobById = Object.fromEntries(jobRows.map((j) => [j.id, j]));
  const userById = Object.fromEntries(userRows.map((u) => [u.id, u]));
  assets.forEach((a) => {
    const job = a.currentJobId ? jobById[a.currentJobId] : null;
    a.currentJobReference = job ? (job.job_reference || job.client) : '';
    const user = a.currentHolderUserId ? userById[a.currentHolderUserId] : null;
    a.currentHolderName = user ? user.name : '';
  });
  return assets;
}

async function listAssets() {
  const { data, error } = await supabase.from('assets').select('*').order('name');
  check(error);
  return attachAssetContext(data.map(rowToAsset));
}

async function getAsset(id) {
  const { data, error } = await supabase.from('assets').select('*').eq('id', id).maybeSingle();
  check(error);
  if (!data) throw new Error('Asset not found');
  const [asset] = await attachAssetContext([rowToAsset(data)]);
  return asset;
}

async function getAssetByToken(token) {
  const { data, error } = await supabase.from('assets').select('*').eq('qr_token', token).maybeSingle();
  check(error);
  if (!data) return null;
  const [asset] = await attachAssetContext([rowToAsset(data)]);
  return asset;
}

// Short (10 hex chars) rather than the row's own uuid, so the printed/laminated label QR
// stays small and reliably scannable - the unique index on qr_token backstops a collision.
function generateQrToken() {
  return crypto.randomBytes(5).toString('hex');
}

async function createAsset(input) {
  const name = (input.name || '').trim();
  if (!name) throw new Error('Name is required');
  const row = {
    id: genId(),
    name,
    category: (input.category || '').trim(),
    qr_token: generateQrToken(),
    status: 'available',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('assets').insert(row).select().single();
  check(error);
  return rowToAsset(data);
}

async function updateAsset(id, input) {
  const name = (input.name || '').trim();
  if (!name) throw new Error('Name is required');
  const row = { name, category: (input.category || '').trim(), updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from('assets').update(row).eq('id', id).select().maybeSingle();
  check(error);
  if (!data) throw new Error('Asset not found');
  return rowToAsset(data);
}

async function deleteAsset(id) {
  const { error } = await supabase.from('assets').delete().eq('id', id);
  check(error);
}

async function checkOutAsset(id, { jobId, holderUserId }) {
  const { data: existing, error: findErr } = await supabase.from('assets').select('*').eq('id', id).maybeSingle();
  check(findErr);
  if (!existing) throw new Error('Asset not found');
  if (existing.status !== 'available') {
    throw new Error(existing.status === 'repairs' ? "This item is in repairs and can't be checked out" : 'This item is already checked out');
  }
  if (!holderUserId) throw new Error('Choose who is taking this out');
  const row = {
    status: 'checked_out',
    current_job_id: jobId || null,
    current_holder_user_id: holderUserId,
    checked_out_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  // Filtering the update on the status just read (not just id) closes the check-then-act gap
  // between the SELECT above and this write - if someone else's scan already moved this asset
  // on in between, this matches zero rows instead of silently clobbering their change.
  const { data, error } = await supabase.from('assets').update(row).eq('id', id).eq('status', 'available').select().maybeSingle();
  check(error);
  if (!data) throw new Error('This item was just checked out by someone else - try scanning it again');
  const [asset] = await attachAssetContext([rowToAsset(data)]);
  return asset;
}

async function checkInAsset(id, { condition, notes }) {
  const { data: existing, error: findErr } = await supabase.from('assets').select('*').eq('id', id).maybeSingle();
  check(findErr);
  if (!existing) throw new Error('Asset not found');
  if (existing.status !== 'checked_out') throw new Error('This item is not currently checked out');
  if (!['good', 'damaged'].includes(condition)) throw new Error('Choose the condition it came back in');
  const row = {
    status: condition === 'good' ? 'available' : 'repairs',
    current_job_id: null,
    current_holder_user_id: null,
    checked_out_at: null,
    last_condition_status: condition,
    last_condition_notes: (notes || '').trim(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('assets').update(row).eq('id', id).eq('status', 'checked_out').select().maybeSingle();
  check(error);
  if (!data) throw new Error('This item was just checked in by someone else - try scanning it again');
  return rowToAsset(data);
}

// Keeps last_condition_status/notes as historical context (what the last inspection found)
// rather than clearing them - the activity log already carries the "marked repaired" event
// itself, so this is just useful context to leave visible on the list once it's fixed.
async function markAssetRepaired(id) {
  const { data: existing, error: findErr } = await supabase.from('assets').select('*').eq('id', id).maybeSingle();
  check(findErr);
  if (!existing) throw new Error('Asset not found');
  if (existing.status !== 'repairs') throw new Error('This item is not in repairs');
  const { data, error } = await supabase.from('assets')
    .update({ status: 'available', updated_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'repairs').select().maybeSingle();
  check(error);
  if (!data) throw new Error('This item was just updated by someone else - try again');
  return rowToAsset(data);
}

async function getAssetQr(asset) {
  return QRCode.toDataURL(asset.qrToken);
}

// ---------- Signage ----------
// Inventory of physical site signs, shared and editable by anyone (removing one is
// admin-only). Seeded once with 10 rows (sign_number 1..10) the first time the table is
// empty; after that, sign_number just keeps counting up as people add/remove signs, it
// isn't reused. Each sign links to the job it's currently out at - no job means it's back
// in the yard and available.

const SIGNAGE_SEED_COUNT = 10;

async function ensureSignageSeeded() {
  const { count, error } = await supabase.from('signage').select('id', { count: 'exact', head: true });
  check(error);
  if (count > 0) return;
  const seed = [];
  for (let n = 1; n <= SIGNAGE_SEED_COUNT; n++) {
    seed.push({ id: genId(), sign_number: n, label: `Sign ${n}`, job_id: null, notes: null, updated_at: new Date().toISOString() });
  }
  const { error: insertError } = await supabase.from('signage').insert(seed);
  check(insertError);
}

function rowToSignage(row) {
  return {
    id: row.id,
    signNumber: row.sign_number,
    label: row.label,
    jobId: row.job_id || '',
    notes: row.notes || '',
    updatedAt: row.updated_at,
  };
}

async function listSignage() {
  await ensureSignageSeeded();
  const { data, error } = await supabase.from('signage').select('*').order('sign_number', { ascending: true });
  check(error);
  return data.map(rowToSignage);
}

async function createSignage(input) {
  const { data: maxRow, error: maxError } = await supabase.from('signage')
    .select('sign_number').order('sign_number', { ascending: false }).limit(1).maybeSingle();
  check(maxError);
  const nextNumber = (maxRow ? maxRow.sign_number : 0) + 1;
  const label = (input.label || '').trim() || `Sign ${nextNumber}`;
  const row = {
    id: genId(),
    sign_number: nextNumber,
    label,
    job_id: null,
    notes: null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('signage').insert(row).select().single();
  check(error);
  return rowToSignage(data);
}

async function updateSignage(id, input) {
  const label = (input.label || '').trim();
  if (!label) throw new Error('Sign label is required');
  const row = {
    label,
    job_id: input.jobId || null,
    notes: (input.notes || '').trim(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('signage').update(row).eq('id', id).select().maybeSingle();
  check(error);
  if (!data) throw new Error('Sign not found');
  return rowToSignage(data);
}

async function deleteSignage(id) {
  const { error } = await supabase.from('signage').delete().eq('id', id);
  check(error);
}

// ---------- Diary ----------
// Private journal, multiple timestamped entries per day. Every function here takes the
// requesting user and either scopes the query to them (list/create) or checks ownership
// before touching a row (update/delete) - there's no admin override, unlike calendar
// entries, since a diary is meant to be nobody's business but the person who wrote it.

function rowToDiaryEntry(row) {
  return {
    id: row.id,
    date: row.entry_date,
    text: row.entry_text,
    completed: row.completed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Ticked-off entries are only ever cleared out, and unticked ones only ever rolled
// forward, the next time this user's diary is actually loaded - there's no cron in this
// app, so "at the end of the day" really means "next time you open the tab on/after the
// next day". Same lazy-at-read-time approach as hire due-back status below.
async function rolloverDiaryEntries(user) {
  const today = new Date().toISOString().slice(0, 10);
  const { data: stale, error } = await supabase.from('diary_entries').select('id, completed')
    .eq('user_id', user.id).lt('entry_date', today);
  check(error);
  if (!stale.length) return;

  const doneIds = stale.filter((e) => e.completed).map((e) => e.id);
  const pendingIds = stale.filter((e) => !e.completed).map((e) => e.id);

  if (doneIds.length) {
    const { error: delErr } = await supabase.from('diary_entries').delete().in('id', doneIds);
    check(delErr);
  }
  if (pendingIds.length) {
    const { error: updErr } = await supabase.from('diary_entries')
      .update({ entry_date: today, updated_at: new Date().toISOString() })
      .in('id', pendingIds);
    check(updErr);
  }
}

async function listDiaryEntries(user) {
  await rolloverDiaryEntries(user);
  const { data, error } = await supabase.from('diary_entries').select('*')
    .eq('user_id', user.id)
    .order('entry_date', { ascending: false }).order('created_at', { ascending: false });
  check(error);
  return data.map(rowToDiaryEntry);
}

async function createDiaryEntry(input, user) {
  const text = (input.text || '').trim();
  if (!text) throw new Error('Entry text is required');
  const date = input.date;
  if (!date || !DATE_RE.test(date)) throw new Error('A valid date is required');

  const row = {
    id: genId(),
    user_id: user.id,
    entry_date: date,
    entry_text: text,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('diary_entries').insert(row).select().single();
  check(error);
  return rowToDiaryEntry(data);
}

async function updateDiaryEntry(id, input, user) {
  const text = (input.text || '').trim();
  if (!text) throw new Error('Entry text is required');
  const date = input.date;
  if (!date || !DATE_RE.test(date)) throw new Error('A valid date is required');

  const { data: existing, error: findErr } = await supabase.from('diary_entries').select('*').eq('id', id).maybeSingle();
  check(findErr);
  if (!existing) throw new Error('Diary entry not found');
  if (existing.user_id !== user.id) throw new Error('You can only edit your own diary entries');

  const { data, error } = await supabase.from('diary_entries')
    .update({ entry_date: date, entry_text: text, updated_at: new Date().toISOString() })
    .eq('id', id).select().maybeSingle();
  check(error);
  return rowToDiaryEntry(data);
}

async function setDiaryEntryCompleted(id, completed, user) {
  const { data: existing, error: findErr } = await supabase.from('diary_entries').select('*').eq('id', id).maybeSingle();
  check(findErr);
  if (!existing) throw new Error('Diary entry not found');
  if (existing.user_id !== user.id) throw new Error('You can only update your own diary entries');

  const { data, error } = await supabase.from('diary_entries')
    .update({ completed, updated_at: new Date().toISOString() })
    .eq('id', id).select().maybeSingle();
  check(error);
  return rowToDiaryEntry(data);
}

async function deleteDiaryEntry(id, user) {
  const { data: existing, error: findErr } = await supabase.from('diary_entries').select('*').eq('id', id).maybeSingle();
  check(findErr);
  if (!existing) throw new Error('Diary entry not found');
  if (existing.user_id !== user.id) throw new Error('You can only delete your own diary entries');

  const { error } = await supabase.from('diary_entries').delete().eq('id', id);
  check(error);
}

// ---------- Mini-Game ----------
// Daily whack-a-mole for a bit of fun. The target sequence itself is generated client-side
// (seeded from the date, see buildMinigameSequence in app.js) so this side never needs to
// know the game's rules - it just records a finished run's time and ranks people by it.
// Only ever the best time per person per day is kept, both so the "same challenge for
// everyone" daily leaderboard is a straight list rather than needing a GROUP BY, and so the
// all-time board (each person's best row across every date) is too.

// A legitimate run needs at least MINIGAME_ROUNDS worth of minimum pop delays back-to-back
// with zero misses - anything faster than this floor could only be a spoofed/replayed
// request, not an actual play-through, so it's rejected outright rather than silently
// distorting the leaderboard.
const MINIGAME_MIN_TIME_MS = 3000;

function rowToMiniGameScore(row) {
  return {
    id: row.id,
    date: row.game_date,
    userId: row.user_id,
    userName: row.user_name,
    timeMs: row.time_ms,
    misses: row.misses,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

async function getMiniGameToday(user) {
  const date = todayDateStr();
  const [daily, allTime] = await Promise.all([
    supabase.from('minigame_scores').select('*').eq('game_date', date).order('time_ms').limit(20),
    supabase.from('minigame_scores').select('user_id, user_name, time_ms').order('time_ms'),
  ]);
  check(daily.error);
  check(allTime.error);

  // Best row per person across every date - rows already arrive sorted fastest-first, so
  // the first time a user_id is seen is their best.
  const seen = new Set();
  const allTimeBest = [];
  for (const row of allTime.data) {
    if (seen.has(row.user_id)) continue;
    seen.add(row.user_id);
    allTimeBest.push({ userId: row.user_id, userName: row.user_name, timeMs: row.time_ms });
    if (allTimeBest.length >= 20) break;
  }

  const mine = daily.data.find((row) => row.user_id === user.id);
  return {
    date,
    dailyLeaderboard: daily.data.map(rowToMiniGameScore),
    allTimeLeaderboard: allTimeBest,
    myBestToday: mine ? rowToMiniGameScore(mine) : null,
  };
}

async function submitMiniGameScore(user, input) {
  const timeMs = Math.round(Number(input.timeMs));
  if (!Number.isFinite(timeMs) || timeMs < MINIGAME_MIN_TIME_MS) throw new Error('Invalid time');
  const misses = Math.round(Number(input.misses) || 0);
  if (!Number.isFinite(misses) || misses < 0) throw new Error('Invalid miss count');
  const date = todayDateStr();

  const { data: existing, error: findErr } = await supabase.from('minigame_scores')
    .select('*').eq('game_date', date).eq('user_id', user.id).maybeSingle();
  check(findErr);

  if (existing && existing.time_ms <= timeMs) {
    // Not an improvement on today's existing best - leave it as-is.
    return { improved: false, best: rowToMiniGameScore(existing) };
  }

  if (existing) {
    const { data, error } = await supabase.from('minigame_scores')
      .update({ time_ms: timeMs, misses, updated_at: new Date().toISOString() })
      .eq('id', existing.id).select().single();
    check(error);
    return { improved: true, best: rowToMiniGameScore(data) };
  }

  const { data, error } = await supabase.from('minigame_scores').insert({
    id: genId(), game_date: date, user_id: user.id, user_name: user.name,
    time_ms: timeMs, misses, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).select().single();
  check(error);
  return { improved: true, best: rowToMiniGameScore(data) };
}

// ---------- Auth ----------

// Office roles get the full app; operative roles (see OPERATIVE_ROLES below) don't have
// any features built for them yet, so every /api route except auth blocks them for now
// (see the operative-lockout middleware in server.js) - extend that allowlist as
// operative-specific screens get built instead of loosening this list.
const ROLES = ['admin', 'staff', 'surveyor', 'installation_operative', 'manufacturing_operative', 'stocks_manager'];
const OPERATIVE_ROLES = ['installation_operative', 'manufacturing_operative'];

function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    color: row.color || null,
    employeeId: row.employee_id || null,
    // Derived from role rather than the old can_manage_quotes column - admins and
    // surveyors can always manage quotes, nobody else can.
    canManageQuotes: row.role === 'admin' || row.role === 'surveyor',
    // Defaults true for rows saved before this column existed (see the schema migration).
    active: row.active !== false,
    mfaEnabled: !!row.mfa_enabled,
    hasPhoto: !!row.avatar_stored_name,
    profileBorder: row.profile_border || 'none',
    profileBackground: row.profile_background || 'none',
    createdAt: row.created_at,
  };
}

function userCanManageQuotes(user) {
  return !!user && (user.role === 'admin' || user.role === 'surveyor');
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
  if (user.active === false) throw new Error('This account has been disabled - ask an admin.');
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
  // Disabling a user (see setUserActive) should take effect immediately, not just block
  // their next login - an already-open session gets treated as signed-out right away.
  if (!user || user.active === false) return null;
  return sanitizeUser(user);
}

async function deleteSession(token) {
  const { error } = await supabase.from('sessions').delete().eq('token', token);
  check(error);
}

// First step of turning MFA on: hand back a fresh secret (as a QR code for an authenticator
// app, plus the raw text for manual entry) without switching mfa_enabled on yet - that only
// happens once confirmMfaSetup proves the person actually scanned it correctly. Calling this
// again before confirming just overwrites the unused secret with a new one, which is fine.
async function startMfaSetup(userId, email) {
  const secret = authenticator.generateSecret();
  const { error } = await supabase.from('users').update({ mfa_secret: secret }).eq('id', userId);
  check(error);
  const otpauth = authenticator.keyuri(email, 'BD Construction Job Tracker', secret);
  const qrDataUrl = await QRCode.toDataURL(otpauth);
  return { secret, qrDataUrl };
}

async function confirmMfaSetup(userId, code) {
  const { data: user, error } = await supabase.from('users').select('mfa_secret').eq('id', userId).maybeSingle();
  check(error);
  if (!user || !user.mfa_secret) throw new Error('Start setup again before entering a code.');
  if (!authenticator.check(String(code || '').trim(), user.mfa_secret)) {
    throw new Error('Incorrect code - check the app and try again.');
  }
  const { data, error: updErr } = await supabase.from('users').update({ mfa_enabled: true }).eq('id', userId).select().maybeSingle();
  check(updErr);
  return sanitizeUser(data);
}

// Deliberately no self-service "disable" - a password alone (something you know) must never
// be enough to turn off the thing that's supposed to require something you *have* too, or the
// second factor isn't really a second factor. Only adminResetMfa below can clear it.

// Lost-phone recovery: an admin clears someone else's MFA so they can sign in with just their
// password and set it up again. No password check needed here - it's gated by requireAdmin
// on the route instead, same as setUserRole/setUserActive.
async function adminResetMfa(userId) {
  const { data, error } = await supabase.from('users').update({ mfa_enabled: false, mfa_secret: null }).eq('id', userId).select().maybeSingle();
  check(error);
  if (!data) throw new Error('User not found');
  return sanitizeUser(data);
}

// Bridges "password was correct" and "a real session exists" for MFA accounts - see the
// /api/auth/login and /api/auth/mfa/verify-login routes in server.js. No session cookie is
// issued until verifyMfaChallenge succeeds, so this token alone can't authenticate anything.
async function createMfaChallenge(userId) {
  const now = Date.now();
  await supabase.from('mfa_challenges').delete().lt('expires_at', new Date(now).toISOString());
  const token = crypto.randomBytes(32).toString('hex');
  const { error } = await supabase.from('mfa_challenges').insert({
    token,
    user_id: userId,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + MFA_CHALLENGE_TTL_MS).toISOString(),
  });
  check(error);
  return token;
}

async function verifyMfaChallenge(token, code) {
  const { data: challenge, error } = await supabase.from('mfa_challenges').select('*').eq('token', token || '').maybeSingle();
  check(error);
  if (!challenge || new Date(challenge.expires_at).getTime() < Date.now()) {
    throw new Error('That sign-in attempt has expired - go back and sign in again.');
  }
  const { data: user, error: userErr } = await supabase.from('users').select('*').eq('id', challenge.user_id).maybeSingle();
  check(userErr);
  if (!user || user.active === false || !user.mfa_enabled) {
    throw new Error('That sign-in attempt is no longer valid - go back and sign in again.');
  }
  if (!authenticator.check(String(code || '').trim(), user.mfa_secret)) {
    throw new Error('Incorrect code - check the app and try again.');
  }
  await supabase.from('mfa_challenges').delete().eq('token', token);
  return sanitizeUser(user);
}

async function listUsers() {
  const { data, error } = await supabase.from('users').select('*').order('name');
  check(error);
  return data.map(sanitizeUser);
}

async function setUserRole(id, role) {
  if (!ROLES.includes(role)) throw new Error('Invalid role');
  const { data, error } = await supabase.from('users').update({ role }).eq('id', id).select().maybeSingle();
  check(error);
  if (!data) throw new Error('User not found');
  return sanitizeUser(data);
}

// Disabling rather than deleting a leaver's account keeps their name intact on historical
// jobs/assignments/reports - getUserBySession/verifyLogin both check this and treat a
// disabled account as signed-out immediately, not just blocked at their next login.
async function setUserActive(id, active) {
  const { data, error } = await supabase.from('users').update({ active: !!active }).eq('id', id).select().maybeSingle();
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

async function setUserProfileStyle(userId, { profileBorder, profileBackground }) {
  const border = profileBorder || 'none';
  const background = profileBackground || 'none';
  if (!PROFILE_BORDER_STYLES.includes(border)) throw new Error('Not a valid border style');
  if (!PROFILE_BACKGROUND_THEMES.includes(background)) throw new Error('Not a valid background theme');
  const { data, error } = await supabase.from('users')
    .update({ profile_border: border, profile_background: background })
    .eq('id', userId).select().maybeSingle();
  check(error);
  if (!data) throw new Error('User not found');
  return sanitizeUser(data);
}

// ---------- Profiles (photo + qualifications) ----------
// Pegged to `users` (login accounts), not `employees` (a name-only sales-credit list) -
// job_assignments.user_id points at users, which is the relation a future client portal
// will need when showing who's working a job.

function rowToQualification(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    expiryDate: row.expiry_date || null,
    status: expiryStatus(row.expiry_date),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listUserQualifications(userId) {
  const { data, error } = await supabase.from('user_qualifications').select('*').eq('user_id', userId).order('name');
  check(error);
  return data.map(rowToQualification);
}

async function addUserQualification(userId, { name, expiryDate }) {
  const cleanName = (name || '').trim();
  if (!cleanName) throw new Error('Qualification name is required');
  const { data, error } = await supabase.from('user_qualifications').insert({
    id: genId(),
    user_id: userId,
    name: cleanName,
    expiry_date: expiryDate || null,
  }).select().single();
  check(error);
  return rowToQualification(data);
}

async function updateUserQualification(id, { name, expiryDate }, requester) {
  const { data: existing, error: findErr } = await supabase.from('user_qualifications').select('*').eq('id', id).maybeSingle();
  check(findErr);
  if (!existing) throw new Error('Qualification not found');
  if (existing.user_id !== requester.id && requester.role !== 'admin') {
    throw new Error('You can only edit your own qualifications');
  }
  const cleanName = (name || '').trim();
  if (!cleanName) throw new Error('Qualification name is required');
  const { data, error } = await supabase.from('user_qualifications')
    .update({ name: cleanName, expiry_date: expiryDate || null, updated_at: new Date().toISOString() })
    .eq('id', id).select().single();
  check(error);
  return rowToQualification(data);
}

async function deleteUserQualification(id, requester) {
  const { data: existing, error: findErr } = await supabase.from('user_qualifications').select('*').eq('id', id).maybeSingle();
  check(findErr);
  if (!existing) throw new Error('Qualification not found');
  if (existing.user_id !== requester.id && requester.role !== 'admin') {
    throw new Error('You can only delete your own qualifications');
  }
  const { error } = await supabase.from('user_qualifications').delete().eq('id', id);
  check(error);
}

// Returns the *previous* stored name (or null) so the caller can delete the old file from
// Storage after the new one's already uploaded and saved - see setUserAvatar's callers in
// server.js, which upload-then-swap rather than swap-then-upload so a failed upload never
// leaves a user with no photo at all.
async function setUserAvatar(userId, storedName) {
  const { data: existing, error: findErr } = await supabase.from('users').select('avatar_stored_name').eq('id', userId).maybeSingle();
  check(findErr);
  if (!existing) throw new Error('User not found');
  const { error } = await supabase.from('users').update({ avatar_stored_name: storedName }).eq('id', userId);
  check(error);
  return existing.avatar_stored_name || null;
}

async function clearUserAvatar(userId) {
  const { data: existing, error: findErr } = await supabase.from('users').select('avatar_stored_name').eq('id', userId).maybeSingle();
  check(findErr);
  if (!existing) throw new Error('User not found');
  const { error } = await supabase.from('users').update({ avatar_stored_name: null }).eq('id', userId);
  check(error);
  return existing.avatar_stored_name || null;
}

async function getUserAvatarStoredName(userId) {
  const { data, error } = await supabase.from('users').select('avatar_stored_name').eq('id', userId).maybeSingle();
  check(error);
  return data ? data.avatar_stored_name || null : null;
}

// Public profile shape shown to a colleague viewed via the Employees tab or a job assignment
// (and, later, clients browsing a job's assigned team) - deliberately narrower than
// sanitizeUser: no email, no calendar colour, nothing account-related.
async function getUserProfile(id) {
  const { data, error } = await supabase.from('users')
    .select('id, name, role, active, avatar_stored_name, profile_border, profile_background')
    .eq('id', id).maybeSingle();
  check(error);
  if (!data || data.active === false) return null;
  const qualifications = await listUserQualifications(id);
  return {
    id: data.id,
    name: data.name,
    role: data.role,
    hasPhoto: !!data.avatar_stored_name,
    profileBorder: data.profile_border || 'none',
    profileBackground: data.profile_background || 'none',
    qualifications,
  };
}

module.exports = {
  DEFAULT_STATUSES,
  DOCUMENT_CATEGORIES,
  DOCUMENT_LABELS,
  CALENDAR_COLORS,
  PROFILE_BORDER_STYLES,
  PROFILE_BACKGROUND_THEMES,
  logActivity,
  logCrud,
  listActivityLog,
  registerUser,
  verifyLogin,
  createSession,
  getUserBySession,
  deleteSession,
  startMfaSetup,
  confirmMfaSetup,
  adminResetMfa,
  createMfaChallenge,
  verifyMfaChallenge,
  listUsers,
  setUserRole,
  setUserActive,
  setUserEmployee,
  ROLES,
  OPERATIVE_ROLES,
  listUserColors,
  setUserColor,
  setUserProfileStyle,
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
  toggleDocumentSuperseded,
  listJobAssignments,
  listMyJobAssignments,
  listJobAssignmentsForJob,
  getJobAssignment,
  createJobAssignment,
  updateJobAssignment,
  deleteJobAssignment,
  setJobAssignmentCompleted,
  getTodayTimeLog,
  listTimeLogs,
  clockIn,
  markArrived,
  clockOut,
  getJobAssignmentRams,
  getJobAssignmentRamsStatus,
  createJobAssignmentRams,
  listSavedRiskAssessments,
  getSavedRiskAssessment,
  addSavedRiskAssessment,
  deleteSavedRiskAssessment,
  listCadDrawings,
  getCadDrawing,
  addCadDrawing,
  updateCadDrawing,
  setCadDrawingThumbnail,
  deleteCadDrawing,
  listCustomRiskAssessments,
  getCustomRiskAssessment,
  createCustomRiskAssessment,
  deleteCustomRiskAssessment,
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
  listJobCostingLines,
  createJobCostingLine,
  updateJobCostingLine,
  deleteJobCostingLine,
  getJobCostingLabour,
  setJobCostingLabourHours,
  clearJobCostingLabourHours,
  getJobCostingSummary,
  listSubbies,
  listSubbiesExpiring,
  getSubby,
  createSubby,
  updateSubby,
  deleteSubby,
  listQuotes,
  getQuote,
  createQuote,
  updateQuote,
  setQuoteQuoted,
  deleteQuote,
  listHires,
  createHire,
  updateHire,
  markHireReturned,
  deleteHire,
  listVehicleHires,
  createVehicleHire,
  updateVehicleHire,
  markVehicleHireOffHired,
  deleteVehicleHire,
  ASSET_STATUSES,
  listAssets,
  getAsset,
  getAssetByToken,
  createAsset,
  updateAsset,
  deleteAsset,
  checkOutAsset,
  checkInAsset,
  markAssetRepaired,
  getAssetQr,
  listSignage,
  createSignage,
  updateSignage,
  deleteSignage,
  listDiaryEntries,
  createDiaryEntry,
  updateDiaryEntry,
  setDiaryEntryCompleted,
  deleteDiaryEntry,
  getMiniGameToday,
  submitMiniGameScore,
  listUserQualifications,
  addUserQualification,
  updateUserQualification,
  deleteUserQualification,
  setUserAvatar,
  clearUserAvatar,
  getUserAvatarStoredName,
  getUserProfile,
  // Pure helpers with no Supabase calls - exported so they can be unit-tested directly (see
  // test/db.pure.test.js) without needing a live database connection.
  addDaysToDateString,
  expiryStatus,
  hireDueBackDate,
  hireStatus,
  validateJobInput,
  validateJobAssignmentInput,
  rowToCostingLine,
};
