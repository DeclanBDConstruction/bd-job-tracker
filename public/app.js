const state = {
  jobs: [],
  employees: [],
  statuses: [],
  riskAssessments: [],
  calendarEvents: [],
  calendarColors: [],
  userColors: [],
  currentUser: null,
};

const isAdmin = () => !!(state.currentUser && state.currentUser.role === 'admin');

const money = (n) => '£' + (Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const slug = (s) => String(s || '').toLowerCase().replace(/\s+/g, '-');
const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : (s || ''));

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  if (res.status === 401) {
    showAuthScreen();
    throw new Error('Your session has expired — please sign in again.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------- Auth ----------

function showAuthScreen() {
  disconnectLiveUpdates();
  document.getElementById('appShell').hidden = true;
  document.getElementById('authScreen').hidden = false;
}

function showApp(user) {
  state.currentUser = user;
  document.getElementById('authScreen').hidden = true;
  document.getElementById('appShell').hidden = false;
  document.getElementById('currentUserName').textContent = user.name;
  document.getElementById('adminTabBtn').hidden = !isAdmin();
  // Play the header's little pop-in now, exactly when it actually becomes visible — could be
  // right after the splash (already signed in) or well after it (just signed in manually).
  document.querySelector('.topbar h1 .logo-mark').classList.add('animate-in');
  document.querySelector('.topbar h1 .brand-sub').classList.add('animate-in');
  bootstrap();
  connectLiveUpdates();
}

// ---------- Live updates ----------
// The server pushes a tiny "type X changed" ping over SSE whenever anyone saves something;
// we just re-fetch that slice of data through the normal API and re-render in place, so
// everyone's screen stays current without needing to hit refresh.

let liveEvents = null;

function activeTab() {
  const btn = document.querySelector('.tab-btn.active');
  return btn ? btn.dataset.tab : null;
}

function connectLiveUpdates() {
  if (liveEvents) return;
  liveEvents = new EventSource('/api/events');
  liveEvents.onmessage = (e) => {
    const { type } = JSON.parse(e.data);
    if (type === 'jobs') handleLiveJobsChange();
    else if (type === 'employees') handleLiveEmployeesChange();
    else if (type === 'calendar') handleLiveCalendarChange();
    else if (type === 'users') handleLiveUsersChange();
  };
}

function disconnectLiveUpdates() {
  if (liveEvents) {
    liveEvents.close();
    liveEvents = null;
  }
}

async function handleLiveJobsChange() {
  state.jobs = await api('/api/jobs');
  renderJobs();
  renderCompletedJobs();
  renderEmployees();
  renderHomeDashboard();
  if (currentDetailJobId && !jobDetailModal.hidden) refreshJobDetail();
  if (activeTab() === 'reports') loadReports();
  if (activeTab() === 'clients') loadClients();
}

async function handleLiveEmployeesChange() {
  state.employees = await api('/api/employees');
  renderEmployeeOptions();
  renderEmployees();
  renderJobs();
  renderCompletedJobs();
}

async function handleLiveCalendarChange() {
  state.calendarEvents = await api('/api/calendar');
  renderCalendar();
  renderHomeDashboard();
  if (calSelectedDate && !calDayModal.hidden) renderCalDayEvents();
}

// Covers both admin promotions and calendar-colour picks - either way, everyone's picker
// and calendar chips need to reflect who owns what right away, not just the person who changed it.
async function handleLiveUsersChange() {
  try {
    state.userColors = await api('/api/users/colors');
    renderCalendar();
    renderColorPicker();
    renderHomeDashboard();
    if (calSelectedDate && !calDayModal.hidden) renderCalDayEvents();
  } catch (err) {
    console.warn('Calendar colours unavailable:', err.message);
  }
  if (activeTab() === 'admin') loadAdminUsers();
}

async function checkAuth() {
  const res = await fetch('/api/auth/me');
  if (res.ok) {
    showApp(await res.json());
  } else {
    showAuthScreen();
  }
}

document.getElementById('showRegisterBtn').addEventListener('click', () => {
  document.getElementById('loginView').hidden = true;
  document.getElementById('registerView').hidden = false;
});

document.getElementById('showLoginBtn').addEventListener('click', () => {
  document.getElementById('registerView').hidden = true;
  document.getElementById('loginView').hidden = false;
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('loginError');
  errorEl.hidden = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('loginEmail').value,
        password: document.getElementById('loginPassword').value,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Sign in failed');
    }
    const user = await res.json();
    document.getElementById('loginForm').reset();
    showApp(user);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('registerError');
  errorEl.hidden = true;
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('registerName').value,
        email: document.getElementById('registerEmail').value,
        password: document.getElementById('registerPassword').value,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Could not create account');
    }
    const user = await res.json();
    document.getElementById('registerForm').reset();
    showApp(user);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  document.getElementById('loginForm').reset();
  document.getElementById('registerView').hidden = true;
  document.getElementById('loginView').hidden = false;
  showAuthScreen();
});

// ---------- Tabs ----------

function goToTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  document.querySelector(`.tab-btn[data-tab="${tab}"]`).classList.add('active');
  document.getElementById('tab-' + tab).classList.add('active');
  if (tab === 'reports') loadReports();
  if (tab === 'clients') loadClients();
  if (tab === 'home') renderHomeDashboard();
  if (tab === 'admin') loadAdminUsers();
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => goToTab(btn.dataset.tab));
});

document.getElementById('logoHomeBtn').addEventListener('click', () => goToTab('home'));

// ---------- Bootstrap ----------

async function bootstrap() {
  const [jobs, employees, statuses, riskAssessmentsList, calendarEvents] = await Promise.all([
    api('/api/jobs'),
    api('/api/employees'),
    api('/api/statuses'),
    api('/api/risk-assessments'),
    api('/api/calendar'),
  ]);
  state.jobs = jobs;
  state.employees = employees;
  state.statuses = statuses;
  state.riskAssessments = riskAssessmentsList;
  state.calendarEvents = calendarEvents;
  renderStatusOptions();
  renderEmployeeOptions();
  renderJobs();
  renderCompletedJobs();
  renderEmployees();
  renderRiskAssessments();
  renderCalendar();
  renderHomeDashboard();

  // Split from the Promise.all above: this needs a `users.color` column that only
  // exists once the Supabase migration has been run. Isolating it means a
  // not-yet-migrated database degrades to "no colour picker yet" instead of the
  // whole app failing to load.
  try {
    const [calendarColors, userColors] = await Promise.all([api('/api/calendar-colors'), api('/api/users/colors')]);
    state.calendarColors = calendarColors;
    state.userColors = userColors;
    renderCalendar();
    renderColorPicker();
    renderHomeDashboard();
  } catch (err) {
    console.warn('Calendar colours unavailable (database may need the colour migration run):', err.message);
    const container = document.getElementById('calColorPicker');
    if (container) container.innerHTML = `<span class="color-picker-error">Couldn't load colours: ${escapeHtml(err.message)}</span>`;
  }
}

function renderStatusOptions() {
  const filterSel = document.getElementById('jobStatusFilter');
  const formSel = document.getElementById('fStatus');
  filterSel.querySelectorAll('option:not(:first-child)').forEach((o) => o.remove());
  formSel.innerHTML = '';
  state.statuses.forEach((s) => {
    const o1 = document.createElement('option'); o1.value = s; o1.textContent = s;
    filterSel.appendChild(o1);
    const o2 = document.createElement('option'); o2.value = s; o2.textContent = s;
    formSel.appendChild(o2);
  });
}

function renderEmployeeOptions() {
  const filterSel = document.getElementById('jobEmployeeFilter');
  filterSel.querySelectorAll('option:not(:first-child)').forEach((o) => o.remove());
  state.employees.forEach((e) => {
    const o = document.createElement('option'); o.value = e.name; o.textContent = e.name;
    filterSel.appendChild(o);
  });
  const datalist = document.getElementById('employeeList');
  datalist.innerHTML = '';
  state.employees.forEach((e) => {
    const o = document.createElement('option'); o.value = e.name;
    datalist.appendChild(o);
  });
}

// ---------- Jobs ----------

const PROGRESS_LABELS = { 'not-started': 'Not Started', active: 'Active', completed: 'Completed' };

function renderJobs() {
  const search = document.getElementById('jobSearch').value.trim().toLowerCase();
  const statusFilter = document.getElementById('jobStatusFilter').value;
  const progressFilter = document.getElementById('jobProgressFilter').value;
  const employeeFilter = document.getElementById('jobEmployeeFilter').value;

  // Completed jobs move off to their own tab, so they never clutter the main list.
  const filtered = state.jobs.filter((j) => {
    if (j.completedAt) return false;
    if (statusFilter && j.status !== statusFilter) return false;
    if (progressFilter && j.progress !== progressFilter) return false;
    if (employeeFilter && j.employeeName !== employeeFilter) return false;
    if (search) {
      const haystack = `${j.client} ${j.location || ''} ${j.jobReference || ''} ${j.description || ''}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  const tbody = document.querySelector('#jobsTable tbody');
  tbody.innerHTML = '';
  filtered.forEach((j) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td title="${j.dateWon || ''}">${j.dateWon || ''}</td>
      <td title="${escapeHtml(j.jobReference || '')}">${j.jobReference || ''}</td>
      <td title="${escapeHtml(j.client)}">${escapeHtml(j.client)}</td>
      <td title="${escapeHtml(j.location || '')}">${escapeHtml(j.location || '')}</td>
      <td class="desc-cell" title="${escapeHtml(j.description || '')}">${escapeHtml(truncate(j.description, 45))}</td>
      <td title="${escapeHtml(j.employeeName)}">${escapeHtml(j.employeeName)}</td>
      <td>${money(j.value)}</td>
      <td>${money(j.profit)}</td>
      <td><span class="status-pill ${slug(j.status)}">${escapeHtml(j.status)}</span></td>
      <td><span class="progress-pill ${j.progress}">${PROGRESS_LABELS[j.progress] || j.progress}</span></td>
      <td class="row-actions">
        <div class="action-icons">
          <button type="button" class="icon-btn" data-view="${j.id}" title="View">👁</button>
          <button type="button" class="icon-btn" data-edit="${j.id}" title="Edit">✎</button>
          <button type="button" class="icon-btn icon-btn-green" data-complete="${j.id}" title="Mark Complete">✓</button>
          ${isAdmin() ? `<button type="button" class="icon-btn icon-btn-danger" data-delete="${j.id}" title="Delete">🗑</button>` : ''}
        </div>
      </td>`;
    tbody.appendChild(tr);
  });

  document.getElementById('jobsEmptyState').hidden = filtered.length !== 0;

  tbody.querySelectorAll('[data-view]').forEach((btn) => btn.addEventListener('click', () => openJobDetail(btn.dataset.view)));
  tbody.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => openJobModal(btn.dataset.edit)));
  tbody.querySelectorAll('[data-delete]').forEach((btn) => btn.addEventListener('click', () => deleteJob(btn.dataset.delete)));
  tbody.querySelectorAll('[data-complete]').forEach((btn) => btn.addEventListener('click', () => completeJob(btn.dataset.complete)));
}

async function completeJob(id) {
  if (!confirm('Mark this job as completed? It will move to the Completed Jobs tab — you can reopen it from there if needed.')) return;
  try {
    await api(`/api/jobs/${id}/complete`, { method: 'POST' });
  } catch (err) {
    alert(err.message);
    openJobDetail(id);
    return;
  }
  state.jobs = await api('/api/jobs');
  renderJobs();
  renderCompletedJobs();
}

async function reopenJob(id) {
  await api(`/api/jobs/${id}/reopen`, { method: 'POST' });
  state.jobs = await api('/api/jobs');
  renderJobs();
  renderCompletedJobs();
}

function renderCompletedJobs() {
  const search = document.getElementById('completedSearch').value.trim().toLowerCase();

  const filtered = state.jobs.filter((j) => {
    if (!j.completedAt) return false;
    if (search) {
      const haystack = `${j.client} ${j.location || ''} ${j.jobReference || ''} ${j.description || ''}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  }).sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));

  const tbody = document.querySelector('#completedJobsTable tbody');
  tbody.innerHTML = '';
  filtered.forEach((j) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td title="${j.completedAt || ''}">${j.completedAt || ''}</td>
      <td title="${j.dateWon || ''}">${j.dateWon || ''}</td>
      <td title="${escapeHtml(j.jobReference || '')}">${j.jobReference || ''}</td>
      <td title="${escapeHtml(j.client)}">${escapeHtml(j.client)}</td>
      <td title="${escapeHtml(j.location || '')}">${escapeHtml(j.location || '')}</td>
      <td class="desc-cell" title="${escapeHtml(j.description || '')}">${escapeHtml(truncate(j.description, 45))}</td>
      <td title="${escapeHtml(j.employeeName)}">${escapeHtml(j.employeeName)}</td>
      <td>${money(j.value)}</td>
      <td>${money(j.profit)}</td>
      <td><span class="status-pill ${slug(j.status)}">${escapeHtml(j.status)}</span></td>
      <td class="row-actions">
        <div class="action-icons">
          <button type="button" class="icon-btn" data-view="${j.id}" title="View">👁</button>
          <button type="button" class="icon-btn" data-edit="${j.id}" title="Edit">✎</button>
          <button type="button" class="icon-btn icon-btn-green" data-reopen="${j.id}" title="Reopen">↺</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
  });

  document.getElementById('completedEmptyState').hidden = filtered.length !== 0;

  tbody.querySelectorAll('[data-view]').forEach((btn) => btn.addEventListener('click', () => openJobDetail(btn.dataset.view)));
  tbody.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => openJobModal(btn.dataset.edit)));
  tbody.querySelectorAll('[data-reopen]').forEach((btn) => btn.addEventListener('click', () => reopenJob(btn.dataset.reopen)));
}

document.getElementById('completedSearch').addEventListener('input', renderCompletedJobs);

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.getElementById('jobSearch').addEventListener('input', renderJobs);
document.getElementById('jobStatusFilter').addEventListener('change', renderJobs);
document.getElementById('jobProgressFilter').addEventListener('change', renderJobs);
document.getElementById('jobEmployeeFilter').addEventListener('change', renderJobs);

async function deleteJob(id) {
  if (!confirm('Delete this job? This cannot be undone.')) return;
  await api(`/api/jobs/${id}`, { method: 'DELETE' });
  state.jobs = await api('/api/jobs');
  renderJobs();
}

// ---------- Job modal ----------

const jobModal = document.getElementById('jobModal');
const jobForm = document.getElementById('jobForm');

document.getElementById('newJobBtn').addEventListener('click', () => openJobModal(null));

document.getElementById('importJobSheetBtn').addEventListener('click', () => {
  document.getElementById('importJobSheetFile').click();
});

document.getElementById('importJobSheetFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/import/jobsheet', { method: 'POST', body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Could not read that file');
    }
    const data = await res.json();
    // If this job number already matches an existing job, ask before touching it — never
    // silently overwrite. Job numbers can collide by mistake (typo, reused template), and
    // silently jumping into edit mode risked clobbering an unrelated job's data.
    const existing = data.jobReference
      ? state.jobs.find((j) => (j.jobReference || '').trim().toLowerCase() === data.jobReference.trim().toLowerCase())
      : null;
    let targetId = null;
    let finalPrefill = data;
    if (existing) {
      const useExisting = confirm(
        `A job with Job Number "${data.jobReference}" already exists:\n\n` +
        `${existing.client}${existing.location ? ' — ' + existing.location : ''} (${money(existing.value)})\n\n` +
        `Update that job with this sheet's details? Choose Cancel to create a separate new job instead.`
      );
      if (useExisting) {
        targetId = existing.id;
      } else {
        // Don't carry the colliding Job Number onto a second job — that would make the
        // next re-import match the wrong one. Leave it blank for the user to set themselves.
        finalPrefill = { ...data, jobReference: '' };
      }
    }
    openJobModal(targetId, finalPrefill);
  } catch (err) {
    alert(err.message);
  } finally {
    e.target.value = '';
  }
});
document.getElementById('jobCancelBtn').addEventListener('click', closeJobModal);

function openJobModal(id, prefill) {
  jobForm.reset();
  document.getElementById('jobId').value = id || '';
  document.getElementById('jobModalTitle').textContent = id
    ? (prefill ? 'Edit Job (updated from job sheet)' : 'Edit Job')
    : (prefill ? 'New Job (from job sheet)' : 'New Job');
  // Profit and Status usually aren't known/decided until a job is under way or finished,
  // so only show them once there's an existing job to edit — not when first creating one.
  document.getElementById('fProfitField').hidden = !id;
  document.getElementById('fStatusField').hidden = !id;

  const job = id ? state.jobs.find((j) => j.id === id) : null;
  // Prefer a value from the uploaded job sheet, falling back to the existing job's value
  // (when editing) or a sensible default (when creating fresh).
  const field = (key, fallback) => {
    if (prefill && prefill[key] !== undefined && prefill[key] !== '') return prefill[key];
    return job ? job[key] : fallback;
  };

  document.getElementById('fJobReference').value = field('jobReference', '') || '';
  document.getElementById('fClient').value = field('client', '') || '';
  document.getElementById('fLocation').value = field('location', '') || '';
  document.getElementById('fEmployeeName').value = field('employeeName', '') || '';
  document.getElementById('fDateWon').value = field('dateWon', new Date().toISOString().slice(0, 10));
  document.getElementById('fStartDate').value = field('startDate', '') || '';
  document.getElementById('fValue').value = field('value', '');
  document.getElementById('fDescription').value = field('description', '') || '';
  document.getElementById('fProfit').value = job ? job.profit : '';
  document.getElementById('fStatus').value = job ? job.status : 'Won';

  // If this came from a job sheet that didn't quite match the usual layout, some fields
  // may not have been readable — call those out so they're not just silently blank.
  const note = document.getElementById('jobModalNote');
  if (prefill) {
    const missing = [];
    if (!field('client', '')) missing.push('Client');
    if (!field('employeeName', '')) missing.push('Employee');
    if (!prefill.dateWon && !(job && job.dateWon)) missing.push('Date Won');
    if (field('value', '') === '') missing.push('Value');
    if (missing.length) {
      note.textContent = `Couldn't read ${missing.join(', ')} from that file — please fill ${missing.length > 1 ? 'them' : 'it'} in below before saving.`;
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  } else {
    note.hidden = true;
  }

  jobModal.hidden = false;
}

function closeJobModal() {
  jobModal.hidden = true;
}

jobForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('jobId').value;
  const payload = {
    jobReference: document.getElementById('fJobReference').value,
    client: document.getElementById('fClient').value,
    location: document.getElementById('fLocation').value,
    employeeName: document.getElementById('fEmployeeName').value,
    dateWon: document.getElementById('fDateWon').value,
    startDate: document.getElementById('fStartDate').value,
    value: document.getElementById('fValue').value,
    profit: document.getElementById('fProfit').value,
    status: document.getElementById('fStatus').value,
    description: document.getElementById('fDescription').value,
  };
  try {
    if (id) {
      await api(`/api/jobs/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
    }
    const [jobs, employees] = await Promise.all([api('/api/jobs'), api('/api/employees')]);
    state.jobs = jobs;
    state.employees = employees;
    renderEmployeeOptions();
    renderJobs();
    renderEmployees();
    closeJobModal();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- Job Detail ----------

const DOCUMENT_SECTIONS = ['rams', 'drawings', 'signoff', 'photos'];

const jobDetailModal = document.getElementById('jobDetailModal');
let currentDetailJobId = null;

async function openJobDetail(id, section) {
  currentDetailJobId = id;
  const target = section || 'info';
  document.querySelectorAll('.job-detail-tab').forEach((b) => b.classList.toggle('active', b.dataset.section === target));
  document.querySelectorAll('.job-detail-section').forEach((s) => s.classList.toggle('active', s.id === `jobDetailSection-${target}`));
  jobDetailModal.hidden = false;
  try {
    await refreshJobDetail();
  } catch (err) {
    alert(err.message);
    closeJobDetail();
  }
}

async function refreshJobDetail() {
  const job = await api(`/api/jobs/${currentDetailJobId}`);
  const emp = state.employees.find((e) => e.id === job.employeeId);
  job.employeeName = emp ? emp.name : '(unassigned)';
  renderJobDetailInfo(job);
  DOCUMENT_SECTIONS.forEach((category) => renderDocumentSection(category, (job.documents || {})[category]));
}

function renderJobDetailInfo(job) {
  document.getElementById('jobDetailTitle').textContent = `${job.client}${job.location ? ' — ' + job.location : ''}`;
  document.getElementById('jobDetailSection-info').innerHTML = `
    <dl class="detail-grid">
      <div><dt>Job Number</dt><dd>${escapeHtml(job.jobReference || '—')}</dd></div>
      <div><dt>Client</dt><dd>${escapeHtml(job.client)}</dd></div>
      <div><dt>Location</dt><dd>${escapeHtml(job.location || '—')}</dd></div>
      <div><dt>Won By</dt><dd>${escapeHtml(job.employeeName)}</dd></div>
      <div><dt>Date Won</dt><dd>${job.dateWon || '—'}</dd></div>
      <div><dt>Start Date</dt><dd>${job.startDate || '—'}</dd></div>
      <div><dt>Value</dt><dd>${money(job.value)}</dd></div>
      <div><dt>Profit</dt><dd>${money(job.profit)}</dd></div>
      <div><dt>Status</dt><dd><span class="status-pill ${slug(job.status)}">${escapeHtml(job.status)}</span></dd></div>
      <div><dt>Notes</dt><dd>${escapeHtml(job.description || '—')}</dd></div>
    </dl>
    <div class="modal-actions">
      <button type="button" id="jobDetailEditBtn">Edit Job</button>
    </div>
  `;
  document.getElementById('jobDetailEditBtn').addEventListener('click', () => {
    closeJobDetail();
    openJobModal(job.id);
  });
}

function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(0)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

function renderDocumentSection(category, docs) {
  const container = document.getElementById(`jobDetailSection-${category}`);
  const items = (docs || []).map((d) => `
    <li class="doc-list-item">
      <a href="/api/jobs/${currentDetailJobId}/documents/${category}/${d.id}/file" target="_blank">${escapeHtml(d.originalName)}</a>
      <span class="doc-meta">${formatBytes(d.size)} · ${new Date(d.uploadedAt).toLocaleDateString('en-GB')}</span>
      <button type="button" class="danger doc-delete-btn" data-doc="${d.id}">Delete</button>
    </li>
  `).join('');
  container.innerHTML = `
    <label class="upload-btn">+ Upload File<input type="file" class="doc-upload-input" hidden></label>
    <ul class="doc-list">${items}</ul>
    ${!docs || !docs.length ? '<p class="empty-state">No files uploaded yet.</p>' : ''}
  `;
  container.querySelector('.doc-upload-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch(`/api/jobs/${currentDetailJobId}/documents/${category}`, { method: 'POST', body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Upload failed');
      }
      await refreshJobDetail();
    } catch (err) {
      alert(err.message);
    } finally {
      e.target.value = '';
    }
  });
  container.querySelectorAll('.doc-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this file? This cannot be undone.')) return;
      try {
        await api(`/api/jobs/${currentDetailJobId}/documents/${category}/${btn.dataset.doc}`, { method: 'DELETE' });
        await refreshJobDetail();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

async function closeJobDetail() {
  jobDetailModal.hidden = true;
  currentDetailJobId = null;
  // Document uploads/deletes only refresh this one job in the modal, not the shared jobs
  // list — refresh it here so views like the Home dashboard's "missing RAMS" list don't
  // show stale state after the modal closes.
  state.jobs = await api('/api/jobs');
  renderJobs();
  renderCompletedJobs();
  renderHomeDashboard();
}

document.getElementById('jobDetailCloseBtn').addEventListener('click', closeJobDetail);

document.querySelectorAll('.job-detail-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.job-detail-tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.job-detail-section').forEach((s) => s.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`jobDetailSection-${btn.dataset.section}`).classList.add('active');
  });
});

// ---------- Employees ----------

function renderEmployees() {
  document.getElementById('employeeAddRow').hidden = !isAdmin();
  const tbody = document.querySelector('#employeesTable tbody');
  tbody.innerHTML = '';
  state.employees.forEach((e) => {
    const jobCount = state.jobs.filter((j) => j.employeeId === e.id).length;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(e.name)} <span style="color:var(--muted)">(${jobCount} job${jobCount === 1 ? '' : 's'})</span></td>
      <td class="row-actions">${isAdmin() ? `<button data-del-emp="${e.id}" class="danger">Delete</button>` : ''}</td>`;
    tbody.appendChild(tr);
  });
}

document.getElementById('addEmployeeBtn').addEventListener('click', async () => {
  const input = document.getElementById('newEmployeeName');
  if (!input.value.trim()) return;
  try {
    await api('/api/employees', { method: 'POST', body: JSON.stringify({ name: input.value }) });
    input.value = '';
    state.employees = await api('/api/employees');
    renderEmployeeOptions();
    renderEmployees();
  } catch (err) {
    alert(err.message);
  }
});

document.querySelector('#employeesTable tbody').addEventListener('click', async (e) => {
  const id = e.target.dataset.delEmp;
  if (!id) return;
  if (!confirm('Delete this employee?')) return;
  try {
    await api(`/api/employees/${id}`, { method: 'DELETE' });
    state.employees = await api('/api/employees');
    renderEmployeeOptions();
    renderEmployees();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- Calendar ----------

// Prefer the colour someone has actually chosen (state.userColors, kept in sync with the
// server); anyone who hasn't picked yet still gets a stable-looking colour via the old
// name hash, so the calendar never shows blank/white chips.
function userColor(event) {
  const chosen = state.userColors.find((u) => u.id === event.userId);
  if (chosen && chosen.color) return chosen.color;
  const name = event.userName || '';
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return PIE_COLORS[hash % PIE_COLORS.length];
}

function pad2(n) { return String(n).padStart(2, '0'); }

function calDateStr(year, month, day) {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

function formatDuration(value, unit) {
  const v = Number(value);
  const label = unit === 'days' ? (v === 1 ? 'day' : 'days') : (v === 1 ? 'hour' : 'hours');
  return `${v} ${label}`;
}

function eventsOnDate(ds) {
  return state.calendarEvents.filter((e) => ds >= e.date && ds <= e.endDate);
}

const calToday = new Date();
let calViewYear = calToday.getFullYear();
let calViewMonth = calToday.getMonth();

function renderCalendar() {
  const grid = document.getElementById('calendarGrid');
  const label = new Date(calViewYear, calViewMonth, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  document.getElementById('calMonthLabel').textContent = label;

  const firstOfMonth = new Date(calViewYear, calViewMonth, 1);
  const startWeekday = (firstOfMonth.getDay() + 6) % 7; // Monday = 0
  const daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();
  const todayStr = calDateStr(calToday.getFullYear(), calToday.getMonth(), calToday.getDate());

  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const MAX_CHIPS = 3;
  grid.innerHTML = cells.map((d) => {
    if (!d) return '<div class="cal-cell cal-cell-empty"></div>';
    const ds = calDateStr(calViewYear, calViewMonth, d);
    const dayEvents = eventsOnDate(ds);
    const isToday = ds === todayStr;
    const chips = dayEvents.slice(0, MAX_CHIPS).map((e) => `
      <div class="cal-chip" style="background:${userColor(e)}" title="${escapeHtml(e.userName)}: ${escapeHtml(e.title)} (${formatDuration(e.durationValue, e.durationUnit)})">${escapeHtml(e.userName)}: ${escapeHtml(truncate(e.title, 16))}</div>
    `).join('');
    const more = dayEvents.length > MAX_CHIPS ? `<div class="cal-chip-more">+${dayEvents.length - MAX_CHIPS} more</div>` : '';
    return `
      <div class="cal-cell${isToday ? ' cal-cell-today' : ''}" data-date="${ds}">
        <div class="cal-cell-date">${d}${isToday ? '<span class="cal-today-badge">Today</span>' : ''}</div>
        <div class="cal-cell-events">${chips}${more}</div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.cal-cell[data-date]').forEach((cell) => {
    cell.addEventListener('click', () => openCalDayModal(cell.dataset.date));
  });
}

// Ten fixed colours, one person per colour (server enforces this - see
// users_color_unique_idx). Taken-by-someone-else swatches are shown but disabled;
// your own is checked; either way the swatch's title always names who has it, so
// colour is never the only way anyone's identified on the calendar.
function renderColorPicker() {
  const container = document.getElementById('calColorPicker');
  if (!container || !state.currentUser) return;
  const myColor = (state.userColors.find((u) => u.id === state.currentUser.id) || {}).color;

  container.innerHTML = state.calendarColors.map((c) => {
    const owner = state.userColors.find((u) => u.color === c.hex);
    const isMine = c.hex === myColor;
    const isTaken = !!owner && !isMine;
    const title = isMine ? `${c.name} (yours)` : isTaken ? `${c.name} — taken by ${owner.name}` : c.name;
    return `
      <button type="button" class="color-swatch-btn${isMine ? ' selected' : ''}${isTaken ? ' taken' : ''}"
        style="background:${c.hex}" data-color="${c.hex}" title="${escapeHtml(title)}" ${isTaken ? 'disabled' : ''}
        aria-label="${escapeHtml(title)}">${isMine ? '✓' : ''}</button>
    `;
  }).join('');

  container.querySelectorAll('.color-swatch-btn:not(.taken)').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api('/api/users/me/color', { method: 'PUT', body: JSON.stringify({ color: btn.dataset.color }) });
        state.userColors = await api('/api/users/colors');
        renderColorPicker();
        renderCalendar();
      } catch (err) {
        alert(err.message);
        state.userColors = await api('/api/users/colors');
        renderColorPicker();
      }
    });
  });
}

document.getElementById('calPrevBtn').addEventListener('click', () => {
  calViewMonth -= 1;
  if (calViewMonth < 0) { calViewMonth = 11; calViewYear -= 1; }
  renderCalendar();
});

document.getElementById('calNextBtn').addEventListener('click', () => {
  calViewMonth += 1;
  if (calViewMonth > 11) { calViewMonth = 0; calViewYear += 1; }
  renderCalendar();
});

document.getElementById('calTodayBtn').addEventListener('click', () => {
  calViewYear = calToday.getFullYear();
  calViewMonth = calToday.getMonth();
  renderCalendar();
});

const calDayModal = document.getElementById('calDayModal');
const calDayAddForm = document.getElementById('calDayAddForm');
let calSelectedDate = null;

function openCalDayModal(ds) {
  calSelectedDate = ds;
  const [y, m, d] = ds.split('-').map(Number);
  document.getElementById('calDayModalTitle').textContent = new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  renderCalDayEvents();
  calDayAddForm.reset();
  calDayAddForm.hidden = true;
  document.getElementById('calDayAddBtn').hidden = false;
  calDayModal.hidden = false;
}

function renderCalDayEvents() {
  const events = eventsOnDate(calSelectedDate);
  const list = document.getElementById('calDayEventsList');
  list.innerHTML = events.map((e) => `
    <li class="cal-day-event-item">
      <span class="cal-swatch" style="background:${userColor(e)}"></span>
      <div class="cal-day-event-body">
        <div class="cal-day-event-title">${escapeHtml(e.title)}</div>
        <div class="cal-day-event-meta">${escapeHtml(e.userName)} · ${formatDuration(e.durationValue, e.durationUnit)}${e.date !== e.endDate ? ` · ${e.date} to ${e.endDate}` : ''}</div>
      </div>
      ${(state.currentUser && (state.currentUser.id === e.userId || state.currentUser.role === 'admin')) ? `<button type="button" class="danger cal-day-event-delete" data-id="${e.id}">Delete</button>` : ''}
    </li>
  `).join('');
  document.getElementById('calDayEmptyState').hidden = events.length !== 0;

  list.querySelectorAll('.cal-day-event-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this calendar entry?')) return;
      try {
        await api(`/api/calendar/${btn.dataset.id}`, { method: 'DELETE' });
        state.calendarEvents = await api('/api/calendar');
        renderCalDayEvents();
        renderCalendar();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

document.getElementById('calDayCloseBtn').addEventListener('click', () => { calDayModal.hidden = true; });

document.getElementById('calDayAddBtn').addEventListener('click', () => {
  calDayAddForm.hidden = false;
  document.getElementById('calDayAddBtn').hidden = true;
  document.getElementById('calDayAddTitle').focus();
});

document.getElementById('calDayAddCancelBtn').addEventListener('click', () => {
  calDayAddForm.reset();
  calDayAddForm.hidden = true;
  document.getElementById('calDayAddBtn').hidden = false;
});

calDayAddForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    date: calSelectedDate,
    title: document.getElementById('calDayAddTitle').value,
    durationValue: document.getElementById('calDayAddDurationValue').value,
    durationUnit: document.getElementById('calDayAddDurationUnit').value,
  };
  try {
    await api('/api/calendar', { method: 'POST', body: JSON.stringify(payload) });
    state.calendarEvents = await api('/api/calendar');
    calDayAddForm.reset();
    calDayAddForm.hidden = true;
    document.getElementById('calDayAddBtn').hidden = false;
    renderCalDayEvents();
    renderCalendar();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- Home Dashboard ----------

function todayDateStr() {
  const d = new Date();
  return calDateStr(d.getFullYear(), d.getMonth(), d.getDate());
}

// Jobs due to be (or already) on site within the next two weeks that don't have a RAMS
// document uploaded yet — the thing most worth catching before someone turns up on site.
function jobsMissingRams() {
  const todayStr = todayDateStr();
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + 14);
  const horizonStr = calDateStr(horizon.getFullYear(), horizon.getMonth(), horizon.getDate());
  return state.jobs
    .filter((j) => !j.completedAt && j.startDate && j.startDate <= horizonStr)
    .filter((j) => !(j.documents && j.documents.rams && j.documents.rams.length))
    .sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''));
}

function renderHomeDashboard() {
  const container = document.getElementById('homeDashboard');
  if (!container) return;
  const todayStr = todayDateStr();
  const todaysEvents = eventsOnDate(todayStr).sort((a, b) => a.userName.localeCompare(b.userName));
  const missingRams = jobsMissingRams();
  const todayLabel = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  const todayHtml = todaysEvents.length
    ? `<ul class="home-today-list">${todaysEvents.map((e) => `
        <li>
          <span class="cal-swatch" style="background:${userColor(e)}"></span>
          <span class="home-today-name">${escapeHtml(e.userName)}</span>
          <span class="home-today-desc">${escapeHtml(e.title)}</span>
          <span class="home-today-duration">${formatDuration(e.durationValue, e.durationUnit)}</span>
        </li>
      `).join('')}</ul>`
    : `<p class="empty-state">Nothing on the calendar for today.</p>`;

  const ramsHtml = missingRams.length
    ? `<ul class="home-rams-list">${missingRams.map((j) => `
        <li>
          <div class="home-rams-info">
            <strong>${escapeHtml(j.client)}${j.location ? ' — ' + escapeHtml(j.location) : ''}</strong>
            <span class="home-rams-date">${j.startDate < todayStr ? 'Started ' : 'Starts '}${j.startDate}</span>
          </div>
          <button type="button" class="home-rams-btn" data-job="${j.id}">Add RAMS</button>
        </li>
      `).join('')}</ul>`
    : `<p class="empty-state">All jobs starting soon have RAMS in place. Nice one.</p>`;

  container.innerHTML = `
    <div class="dashboard-card">
      <h3>Today — ${todayLabel}</h3>
      ${todayHtml}
      <button type="button" class="link-btn" id="homeGoCalendarBtn">Open Calendar</button>
    </div>
    <div class="dashboard-card">
      <h3>Jobs Missing RAMS</h3>
      ${ramsHtml}
    </div>
  `;

  document.getElementById('homeGoCalendarBtn').addEventListener('click', () => {
    goToTab('calendar');
    openCalDayModal(todayStr);
  });

  container.querySelectorAll('.home-rams-btn').forEach((btn) => {
    btn.addEventListener('click', () => openJobDetail(btn.dataset.job, 'rams'));
  });
}

// ---------- Risk Assessments ----------

function renderRiskAssessments() {
  const grid = document.getElementById('raGrid');
  grid.innerHTML = state.riskAssessments.map((ra) => `
    <div class="ra-card">
      <div class="ra-card-top">
        <h3>${escapeHtml(ra.title)}</h3>
        <span class="risk-badge ${ra.currentBand.slug}">${escapeHtml(ra.currentBand.label)}</span>
      </div>
      <p class="ra-card-summary">Risk rating ${ra.currentL} × ${ra.currentC} = ${ra.currentR}, reduced to ${ra.additionalR} with additional controls.</p>
      <div class="ra-card-actions">
        <button type="button" class="ra-view-btn" data-ra="${ra.id}">View &amp; Attach to Job</button>
        <a href="/api/risk-assessments/${ra.id}/download" class="ra-download-btn">Download</a>
      </div>
    </div>
  `).join('');
  grid.querySelectorAll('[data-ra]').forEach((btn) => btn.addEventListener('click', () => openRaModal(btn.dataset.ra)));
}

const raModal = document.getElementById('raModal');
let currentRaId = null;

function openRaModal(id) {
  const ra = state.riskAssessments.find((r) => r.id === id);
  if (!ra) return;
  currentRaId = id;
  document.getElementById('raModalTitle').textContent = ra.title;
  document.getElementById('raModalBody').innerHTML = `
    <p class="ra-meta">
      <span class="risk-badge ${ra.currentBand.slug}">Current: ${ra.currentL} × ${ra.currentC} = ${ra.currentR} — ${escapeHtml(ra.currentBand.label)}</span>
      <span class="risk-badge ${ra.additionalBand.slug}">With additional controls: ${ra.additionalL} × ${ra.additionalC} = ${ra.additionalR} — ${escapeHtml(ra.additionalBand.label)}</span>
    </p>
    ${ra.legislation ? `<p class="ra-meta">${escapeHtml(ra.legislation)}</p>` : ''}
    <h4>Hazard &amp; Potential Harm</h4>
    <p>${escapeHtml(ra.hazard)}</p>
    <h4>Who Might Be Harmed</h4>
    <p>${escapeHtml(ra.peopleAffected)}</p>
    <h4>Current Risk Controls</h4>
    <ul>${ra.currentControls.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
    <h4>Additional Risk Controls</h4>
    <ul>${ra.additionalControls.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
    <h4>PPE Required</h4>
    <ul>${ra.ppe.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
  `;

  document.getElementById('raDownloadLink').href = `/api/risk-assessments/${ra.id}/download`;

  const jobSelect = document.getElementById('raAttachJobSelect');
  jobSelect.innerHTML = '<option value="">Attach to job…</option>';
  state.jobs
    .filter((j) => !j.completedAt)
    .sort((a, b) => a.client.localeCompare(b.client))
    .forEach((j) => {
      const o = document.createElement('option');
      o.value = j.id;
      o.textContent = `${j.client}${j.location ? ' — ' + j.location : ''}${j.jobReference ? ' (' + j.jobReference + ')' : ''}`;
      jobSelect.appendChild(o);
    });

  raModal.hidden = false;
}

function closeRaModal() {
  raModal.hidden = true;
  currentRaId = null;
}

document.getElementById('raModalCloseBtn').addEventListener('click', closeRaModal);

document.getElementById('raAttachBtn').addEventListener('click', async () => {
  const jobId = document.getElementById('raAttachJobSelect').value;
  if (!jobId) { alert('Choose a job to attach this risk assessment to.'); return; }
  try {
    await api(`/api/jobs/${jobId}/risk-assessments/${currentRaId}/attach`, { method: 'POST' });
    alert('Attached — you\'ll find it in that job\'s RAMS documents.');
    closeRaModal();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- Reports ----------

async function loadReports() {
  const [years, monthly] = await Promise.all([api('/api/reports/yearly'), api('/api/reports/monthly')]);
  const container = document.getElementById('reportsContainer');

  const yearCardsHtml = !years.length
    ? '<p class="empty-state">No jobs recorded yet — add or import jobs to see reports.</p>'
    : years.map((y) => {
    const maxValue = Math.max(...y.employees.map((e) => e.totalValue), 1);
    const bars = y.employees.map((e) => `
      <div class="bar-row">
        <div>${escapeHtml(e.employee)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(e.totalValue / maxValue) * 100}%"></div></div>
        <div>${money(e.totalValue)}</div>
      </div>
    `).join('');
    return `
      <div class="report-year">
        <h3>${y.year}</h3>
        <div class="report-summary">
          <div class="stat"><div class="label">Total Turnover</div><div class="value">${money(y.totalTurnover)}</div></div>
          <div class="stat"><div class="label">Total Profit</div><div class="value green">${money(y.totalProfit)}</div></div>
          <div class="stat"><div class="label">Jobs Won</div><div class="value">${y.jobCount}</div></div>
        </div>
        ${y.topEarner ? `<div class="top-earner">🏆 <strong>${escapeHtml(y.topEarner.employee)}</strong> won the most this year — ${money(y.topEarner.totalValue)} across ${y.topEarner.jobCount} job(s).</div>` : ''}
        <div class="bars">${bars}</div>
      </div>
    `;
  }).join('');

  container.innerHTML = `<div class="monthly-chart-card" id="monthlyChartCard"></div>${yearCardsHtml}`;
  buildMonthlyChart(monthly);
}

// ---------- Monthly Comparison Chart ----------
// One line per year, £ value won per calendar month, so the office can see at a
// glance whether this month is up or down against last month and against the
// same month in previous years.

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortMoney(n) {
  const v = Math.round(n);
  if (Math.abs(v) >= 1000000) return '£' + (v / 1000000).toFixed(v % 1000000 === 0 ? 0 : 1) + 'M';
  if (Math.abs(v) >= 1000) return '£' + Math.round(v / 1000) + 'k';
  return '£' + v;
}

// Picks a "nice" round step (1/2/5/10 × a power of ten) for axis ticks, the way
// most charting libraries do, so the axis reads 5,000 / 10,000 rather than 4,873.
function niceTickStep(roughStep) {
  const mag = Math.pow(10, Math.floor(Math.log10(roughStep || 1)));
  const residual = roughStep / mag;
  if (residual > 5) return 10 * mag;
  if (residual > 2) return 5 * mag;
  if (residual > 1) return 2 * mag;
  return mag;
}

function buildMonthlyChart(monthly) {
  const card = document.getElementById('monthlyChartCard');
  if (!monthly.length) {
    card.innerHTML = `
      <h3>Monthly Comparison</h3>
      <p class="empty-state">No jobs recorded yet — add or import jobs to see the monthly comparison.</p>
    `;
    return;
  }

  const currentYear = String(new Date().getFullYear());
  const currentMonthIdx = new Date().getMonth();

  // The current year's line stops at this month rather than dropping to a
  // misleading zero for months that simply haven't happened yet.
  const series = monthly.map((y) => {
    const lastIdx = y.year === currentYear ? currentMonthIdx : 11;
    return { year: y.year, values: y.months.slice(0, lastIdx + 1) };
  });

  const colors = PIE_COLORS.filter((c) => c !== '#9c9c9c');
  const colorByYear = {};
  series.forEach((s, i) => { colorByYear[s.year] = colors[i % colors.length]; });

  const maxValue = Math.max(1, ...series.flatMap((s) => s.values));
  const step = niceTickStep(maxValue / 4);
  const ticks = [0];
  while (ticks[ticks.length - 1] < maxValue) ticks.push(ticks[ticks.length - 1] + step);
  const maxTick = ticks[ticks.length - 1];

  const W = 760, H = 300;
  const marginLeft = 54, marginRight = 60, marginTop = 16, marginBottom = 28;
  const plotW = W - marginLeft - marginRight;
  const plotH = H - marginTop - marginBottom;
  const x = (i) => marginLeft + (i / 11) * plotW;
  const y = (v) => marginTop + plotH - (v / maxTick) * plotH;

  const gridlines = ticks.map((t) => `
    <line class="chart-gridline" x1="${marginLeft}" y1="${y(t).toFixed(1)}" x2="${W - marginRight}" y2="${y(t).toFixed(1)}"></line>
    <text class="chart-axis-label" x="${marginLeft - 8}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end">${shortMoney(t)}</text>
  `).join('');

  const xLabels = MONTH_LABELS.map((m, i) => `
    <text class="chart-axis-label" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${m}</text>
  `).join('');

  // End-of-line year labels can collide when two years finish close together in
  // value - nudge the lower one down rather than let them overlap.
  const endPoints = series
    .filter((s) => s.values.length)
    .map((s) => ({ year: s.year, actualY: y(s.values[s.values.length - 1]) }))
    .sort((a, b) => a.actualY - b.actualY);
  const MIN_LABEL_GAP = 14;
  for (let i = 1; i < endPoints.length; i++) {
    if (endPoints[i].actualY - endPoints[i - 1].actualY < MIN_LABEL_GAP) {
      endPoints[i].actualY = endPoints[i - 1].actualY + MIN_LABEL_GAP;
    }
  }
  const labelYByYear = Object.fromEntries(endPoints.map((e) => [e.year, e.actualY]));

  const lines = series.filter((s) => s.values.length).map((s) => {
    const color = colorByYear[s.year];
    const d = s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const lastIdx = s.values.length - 1;
    const lastX = x(lastIdx);
    const lastYActual = y(s.values[lastIdx]);
    const labelY = labelYByYear[s.year];
    return `
      <path class="chart-line" d="${d}" stroke="${color}"></path>
      <circle class="chart-end-dot" cx="${lastX.toFixed(1)}" cy="${lastYActual.toFixed(1)}" r="4" fill="${color}"></circle>
      ${Math.abs(labelY - lastYActual) > 0.5 ? `<line x1="${(lastX + 6).toFixed(1)}" y1="${lastYActual.toFixed(1)}" x2="${(lastX + 14).toFixed(1)}" y2="${labelY.toFixed(1)}" stroke="${color}" stroke-width="1"></line>` : ''}
      <text class="chart-end-label" x="${(lastX + 16).toFixed(1)}" y="${(labelY + 4).toFixed(1)}">${s.year}</text>
    `;
  }).join('');

  const legend = series.map((s) => `
    <div class="chart-legend-item"><span class="chart-legend-key" style="background:${colorByYear[s.year]}"></span>${s.year}</div>
  `).join('');

  card.innerHTML = `
    <div class="monthly-chart-head">
      <h3>Monthly Comparison</h3>
      <button type="button" class="chart-table-toggle" id="monthlyTableToggle">View as table</button>
    </div>
    <p class="monthly-chart-sub">Value won per month — compare this year's pace against previous years.</p>
    <div class="chart-legend">${legend}</div>
    <div class="chart-wrap" id="monthlyChartWrap">
      <svg viewBox="0 0 ${W} ${H}" id="monthlyChartSvg">
        ${gridlines}
        ${xLabels}
        ${lines}
        <line class="chart-crosshair" id="monthlyCrosshair" x1="0" y1="${marginTop}" x2="0" y2="${H - marginBottom}"></line>
        <rect class="chart-hit-area" x="${marginLeft}" y="${marginTop}" width="${plotW}" height="${plotH}"></rect>
      </svg>
      <div class="chart-tooltip" id="monthlyTooltip"></div>
    </div>
    <div class="table-scroll" id="monthlyTableWrap" hidden>
      <table class="monthly-table">
        <thead><tr><th>Month</th>${series.map((s) => `<th>${s.year}</th>`).join('')}</tr></thead>
        <tbody>
          ${MONTH_LABELS.map((m, i) => `
            <tr>
              <td>${m}</td>
              ${series.map((s) => `<td>${i < s.values.length ? money(s.values[i]) : '—'}</td>`).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  wireMonthlyChartInteraction(series, colorByYear, { x, marginLeft, plotW, W });

  document.getElementById('monthlyTableToggle').addEventListener('click', () => {
    const chartWrap = document.getElementById('monthlyChartWrap');
    const tableWrap = document.getElementById('monthlyTableWrap');
    const toggle = document.getElementById('monthlyTableToggle');
    const showingTable = !tableWrap.hidden;
    tableWrap.hidden = showingTable;
    chartWrap.hidden = !showingTable;
    toggle.textContent = showingTable ? 'View as table' : 'View as chart';
  });
}

function wireMonthlyChartInteraction(series, colorByYear, geo) {
  const svg = document.getElementById('monthlyChartSvg');
  const hitArea = svg.querySelector('.chart-hit-area');
  const crosshair = document.getElementById('monthlyCrosshair');
  const tooltip = document.getElementById('monthlyTooltip');
  const wrap = document.getElementById('monthlyChartWrap');

  function monthIndexAt(clientX) {
    const rect = svg.getBoundingClientRect();
    const scale = geo.W / rect.width;
    const svgX = (clientX - rect.left) * scale;
    const idx = Math.round(((svgX - geo.marginLeft) / geo.plotW) * 11);
    return Math.max(0, Math.min(11, idx));
  }

  function hide() {
    crosshair.style.opacity = '0';
    tooltip.classList.remove('visible');
  }

  function showAt(clientX, clientY) {
    const idx = monthIndexAt(clientX);
    const rows = series
      .filter((s) => idx < s.values.length)
      .map((s) => ({ year: s.year, value: s.values[idx] }))
      .sort((a, b) => b.value - a.value);
    if (!rows.length) { hide(); return; }

    crosshair.setAttribute('x1', geo.x(idx).toFixed(1));
    crosshair.setAttribute('x2', geo.x(idx).toFixed(1));
    crosshair.style.opacity = '1';

    tooltip.innerHTML = `
      <div class="chart-tooltip-title">${MONTH_LABELS[idx]}</div>
      ${rows.map((r) => `
        <div class="chart-tooltip-row">
          <span class="chart-tooltip-key" style="background:${colorByYear[r.year]}"></span>
          <span class="chart-tooltip-year">${r.year}</span>
          <span class="chart-tooltip-value">${money(r.value)}</span>
        </div>
      `).join('')}
    `;
    tooltip.classList.add('visible');

    const wrapRect = wrap.getBoundingClientRect();
    let left = clientX - wrapRect.left + 14;
    const top = clientY - wrapRect.top - 10;
    const maxLeft = wrapRect.width - tooltip.offsetWidth - 8;
    if (left > maxLeft) left = clientX - wrapRect.left - tooltip.offsetWidth - 14;
    tooltip.style.left = `${Math.max(4, left)}px`;
    tooltip.style.top = `${Math.max(4, top)}px`;
  }

  hitArea.addEventListener('pointermove', (e) => showAt(e.clientX, e.clientY));
  hitArea.addEventListener('pointerleave', hide);
}

const PIE_COLORS = ['#186a9c', '#92c648', '#e8a13d', '#c8574f', '#7c5cbf', '#2fa89a', '#d6668f', '#5c8a3c', '#9c9c9c'];

function buildClientPieChart(clients, totalTurnover) {
  const MAX_SLICES = 8;
  const slices = clients.slice(0, MAX_SLICES).map((c) => ({ label: c.client, value: c.totalValue }));
  if (clients.length > MAX_SLICES) {
    const otherValue = clients.slice(MAX_SLICES).reduce((sum, c) => sum + c.totalValue, 0);
    slices.push({ label: `Other (${clients.length - MAX_SLICES} clients)`, value: otherValue });
  }

  let cumulative = 0;
  const stops = slices.map((s, i) => {
    const startPct = totalTurnover ? (cumulative / totalTurnover) * 100 : 0;
    cumulative += s.value;
    const endPct = totalTurnover ? (cumulative / totalTurnover) * 100 : 0;
    return `${PIE_COLORS[i % PIE_COLORS.length]} ${startPct}% ${endPct}%`;
  }).join(', ');

  const legend = slices.map((s, i) => `
    <div class="pie-legend-item">
      <span class="pie-swatch" style="background:${PIE_COLORS[i % PIE_COLORS.length]}"></span>
      <span class="pie-legend-label">${escapeHtml(s.label)}</span>
      <span class="pie-legend-pct">${totalTurnover ? ((s.value / totalTurnover) * 100).toFixed(1) : '0.0'}%</span>
    </div>
  `).join('');

  return `
    <div class="pie-chart-wrap">
      <div class="pie-chart" style="background: conic-gradient(${stops})"></div>
      <div class="pie-legend">${legend}</div>
    </div>
  `;
}

async function loadClients() {
  const clients = await api('/api/reports/clients');
  const container = document.getElementById('clientsContainer');
  if (!clients.length) {
    container.innerHTML = '<p class="empty-state">No jobs recorded yet — add or import jobs to see the client ranking.</p>';
    return;
  }
  const totalTurnover = clients.reduce((sum, c) => sum + c.totalValue, 0);
  const totalProfit = clients.reduce((sum, c) => sum + c.totalProfit, 0);
  const top = clients[0];

  const rows = clients.map((c, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(c.client)}</td>
      <td>${money(c.totalValue)}</td>
      <td>${money(c.totalProfit)}</td>
      <td>${c.jobCount}</td>
    </tr>
  `).join('');

  container.innerHTML = `
    <div class="report-year">
      <div class="report-summary">
        <div class="stat"><div class="label">Clients</div><div class="value">${clients.length}</div></div>
        <div class="stat"><div class="label">Total Turnover</div><div class="value">${money(totalTurnover)}</div></div>
        <div class="stat"><div class="label">Total Profit</div><div class="value green">${money(totalProfit)}</div></div>
      </div>
      <div class="top-earner">🏆 <strong>${escapeHtml(top.client)}</strong> has brought in the most money overall — ${money(top.totalValue)} across ${top.jobCount} job(s).</div>
      <h3 class="pie-chart-heading">Turnover Share by Client</h3>
      ${buildClientPieChart(clients, totalTurnover)}
      <div class="table-scroll">
        <table class="data-table">
          <thead><tr><th>Rank</th><th>Client</th><th>Total Value</th><th>Total Profit</th><th>Jobs</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

// ---------- Admin ----------

async function loadAdminUsers() {
  const users = await api('/api/users');
  const tbody = document.querySelector('#adminUsersTable tbody');
  tbody.innerHTML = users.map((u) => `
    <tr>
      <td>${escapeHtml(u.name)}</td>
      <td>${escapeHtml(u.email)}</td>
      <td><span class="role-badge ${u.role}">${escapeHtml(u.role)}</span></td>
      <td class="row-actions">${u.role !== 'admin' ? `<button type="button" class="primary" data-promote="${u.id}" data-name="${escapeHtml(u.name)}">Make Admin</button>` : ''}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-promote]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Make ${btn.dataset.name} an admin? They'll be able to delete jobs and manage the employee list.`)) return;
      try {
        await api(`/api/users/${btn.dataset.promote}/promote`, { method: 'POST' });
        loadAdminUsers();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

checkAuth();
