const state = {
  jobs: [],
  employees: [],
  statuses: [],
  riskAssessments: [],
  raLibrary: [],
  raCustom: [],
  calendarEvents: [],
  calendarColors: [],
  userColors: [],
  priceListItems: [],
  subbies: [],
  quotes: [],
  hires: [],
  signage: [],
  diaryEntries: [],
  currentUser: null,
};

const isAdmin = () => !!(state.currentUser && state.currentUser.role === 'admin');
const canManageQuotes = () => !!(state.currentUser && (state.currentUser.role === 'admin' || state.currentUser.canManageQuotes));

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
  document.getElementById('userAvatar').textContent = (user.name || '')
    .trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  document.getElementById('adminTabBtn').hidden = !isAdmin();
  document.getElementById('clientsTabBtn').hidden = !isAdmin();
  document.getElementById('hireTabBtn').hidden = !isAdmin();
  document.getElementById('quotingAddRow').hidden = !canManageQuotes();
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
    else if (type === 'priceList') handleLivePriceListChange();
    else if (type === 'subbies') handleLiveSubbiesChange();
    else if (type === 'quotes') handleLiveQuotesChange();
    else if (type === 'hires') handleLiveHiresChange();
    else if (type === 'signage') handleLiveSignageChange();
    else if (type === 'diary') handleLiveDiaryChange();
  };
}

function disconnectLiveUpdates() {
  if (liveEvents) {
    liveEvents.close();
    liveEvents = null;
  }
}

async function handleLivePriceListChange() {
  state.priceListItems = await api('/api/price-list');
  renderPriceLists();
}

async function handleLiveSubbiesChange() {
  state.subbies = await api('/api/subbies');
  renderSubbies();
}

async function handleLiveHiresChange() {
  if (activeTab() === 'hire') loadHires();
}

async function handleLiveSignageChange() {
  state.signage = await api('/api/signage');
  renderSignage();
}

async function handleLiveQuotesChange() {
  if (activeTab() === 'quoting') loadQuotes();
}

async function handleLiveDiaryChange() {
  if (activeTab() === 'diary') loadDiary();
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
  teamCalendar.refreshIfOpen();
  myCalendar.refreshIfOpen();
}

// Covers both admin promotions and calendar-colour picks - either way, everyone's picker
// and calendar chips need to reflect who owns what right away, not just the person who changed it.
async function handleLiveUsersChange() {
  try {
    state.userColors = await api('/api/users/colors');
    renderCalendar();
    renderColorPicker();
    renderHomeDashboard();
    if (activeTab() === 'quoting') renderQuoting();
    teamCalendar.refreshIfOpen();
    myCalendar.refreshIfOpen();
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
  if (tab === 'hire') loadHires();
  if (tab === 'quoting') loadQuotes();
  if (tab === 'diary') {
    setDiaryViewDate(todayDateStr());
    loadDiary();
  }
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => goToTab(btn.dataset.tab));
});

document.getElementById('logoHomeBtn').addEventListener('click', () => goToTab('home'));

// ---------- Header Search ----------
// Jump straight to a job from anywhere in the app, regardless of which tab is active -
// searches state.jobs (which includes completed jobs too, not just the open Jobs list).

function headerSearchMatches(term) {
  const q = term.trim().toLowerCase();
  if (!q) return [];
  return state.jobs
    .filter((j) => [j.jobReference, j.client, j.location, j.employeeName, j.description]
      .some((v) => (v || '').toLowerCase().includes(q)))
    .slice(0, 8);
}

function renderHeaderSearchResults(term) {
  const panel = document.getElementById('headerSearchResults');
  if (!term.trim()) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }
  const matches = headerSearchMatches(term);
  panel.hidden = false;
  panel.innerHTML = matches.length
    ? matches.map((j) => `
        <div class="header-search-item" data-job="${j.id}">
          <span class="header-search-item-title">${escapeHtml(j.client)}${j.location ? ' — ' + escapeHtml(j.location) : ''}</span>
          <span class="header-search-item-meta">${j.jobReference ? 'Job ' + escapeHtml(j.jobReference) + ' · ' : ''}${escapeHtml(j.status)}${j.completedAt ? ' · Completed' : ''}</span>
        </div>
      `).join('')
    : '<div class="header-search-empty">No jobs match your search.</div>';

  panel.querySelectorAll('[data-job]').forEach((el) => {
    el.addEventListener('click', () => {
      openJobDetail(el.dataset.job);
      closeHeaderSearch();
    });
  });
}

function closeHeaderSearch() {
  document.getElementById('headerSearchInput').value = '';
  const panel = document.getElementById('headerSearchResults');
  panel.hidden = true;
  panel.innerHTML = '';
}

document.getElementById('headerSearchInput').addEventListener('input', (e) => {
  renderHeaderSearchResults(e.target.value);
});

document.getElementById('headerSearchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeHeaderSearch();
  if (e.key === 'Enter') {
    const first = document.querySelector('#headerSearchResults [data-job]');
    if (first) { openJobDetail(first.dataset.job); closeHeaderSearch(); }
  }
});

document.addEventListener('click', (e) => {
  if (!document.getElementById('headerSearchWrap').contains(e.target)) closeHeaderSearch();
});

// ---------- Home Slideshow ----------
// Static marketing images, not tied to any app data, so this runs once at load rather
// than as part of bootstrap/render.

(function initHomeSlideshow() {
  const slideshow = document.getElementById('homeSlideshow');
  const track = slideshow && slideshow.querySelector('.slideshow-track');
  const slides = track ? Array.from(track.children) : [];
  if (!slideshow || !slides.length) return;

  const dotsContainer = slideshow.querySelector('.slideshow-dots');
  const dots = slides.map((_, i) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'slideshow-dot';
    dot.setAttribute('aria-label', `Go to slide ${i + 1}`);
    dot.addEventListener('click', () => { goTo(i); restart(); });
    dotsContainer.appendChild(dot);
    return dot;
  });

  let index = 0;
  let timer = null;

  function goTo(i) {
    index = (i + slides.length) % slides.length;
    track.style.transform = `translateX(-${index * 100}%)`;
    dots.forEach((d, di) => d.classList.toggle('active', di === index));
  }

  function restart() {
    clearInterval(timer);
    timer = setInterval(() => goTo(index + 1), 5000);
  }

  slideshow.querySelector('.slideshow-prev').addEventListener('click', () => { goTo(index - 1); restart(); });
  slideshow.querySelector('.slideshow-next').addEventListener('click', () => { goTo(index + 1); restart(); });
  slideshow.addEventListener('mouseenter', () => clearInterval(timer));
  slideshow.addEventListener('mouseleave', restart);

  goTo(0);
  restart();
})();

// ---------- Bootstrap ----------

async function bootstrap() {
  const [jobs, employees, statuses, riskAssessmentsList, raLibrary, raCustom, calendarEvents, priceListItems, subbies, signage] = await Promise.all([
    api('/api/jobs'),
    api('/api/employees'),
    api('/api/statuses'),
    api('/api/risk-assessments'),
    api('/api/risk-assessments/library'),
    api('/api/risk-assessments/custom'),
    api('/api/calendar'),
    api('/api/price-list'),
    api('/api/subbies'),
    api('/api/signage'),
  ]);
  state.jobs = jobs;
  state.employees = employees;
  state.statuses = statuses;
  state.riskAssessments = riskAssessmentsList;
  state.raLibrary = raLibrary;
  state.raCustom = raCustom;
  state.calendarEvents = calendarEvents;
  state.priceListItems = priceListItems;
  state.subbies = subbies;
  state.signage = signage;
  renderStatusOptions();
  renderEmployeeOptions();
  renderJobs();
  renderCompletedJobs();
  renderEmployees();
  renderRiskAssessments();
  renderCalendar();
  renderPriceLists();
  renderSubbies();
  renderSignage();
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
    renderQuoting();
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
  renderVariationsSection(job.variations || []);
}

function variationsTotal(variations) {
  return (variations || []).reduce((sum, v) => sum + v.value, 0);
}

function renderJobDetailInfo(job) {
  document.getElementById('jobDetailTitle').textContent = `${job.client}${job.location ? ' — ' + job.location : ''}`;
  const varTotal = variationsTotal(job.variations);
  document.getElementById('jobDetailSection-info').innerHTML = `
    <dl class="detail-grid">
      <div><dt>Job Number</dt><dd>${escapeHtml(job.jobReference || '—')}</dd></div>
      <div><dt>Client</dt><dd>${escapeHtml(job.client)}</dd></div>
      <div><dt>Location</dt><dd>${escapeHtml(job.location || '—')}</dd></div>
      <div><dt>Won By</dt><dd>${escapeHtml(job.employeeName)}</dd></div>
      <div><dt>Date Won</dt><dd>${job.dateWon || '—'}</dd></div>
      <div><dt>Start Date</dt><dd>${job.startDate || '—'}</dd></div>
      <div><dt>Value</dt><dd>${money(job.value)}</dd></div>
      ${varTotal ? `<div><dt>Variations Total</dt><dd>${money(varTotal)}</dd></div>
      <div><dt>Adjusted Value</dt><dd>${money(job.value + varTotal)}</dd></div>` : ''}
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

// ---------- Job Variations ----------
// Extra works agreed after the original quote - tracked separately from the job's Value
// so scope changes stay visible instead of quietly making the quoted value stale.

function renderVariationsSection(variations) {
  const container = document.getElementById('jobDetailSection-variations');
  const items = variations.map((v) => `
    <li class="doc-list-item">
      <span class="variation-desc">${escapeHtml(v.description)}</span>
      <span class="doc-meta">${money(v.value)} · ${new Date(v.createdAt).toLocaleDateString('en-GB')}</span>
      <button type="button" class="danger variation-delete-btn" data-variation="${v.id}">Delete</button>
    </li>
  `).join('');
  container.innerHTML = `
    <form id="variationAddForm" class="variation-add-form">
      <input type="text" id="variationDescInput" placeholder="Description (e.g. Extra electrical sockets)" required>
      <input type="number" id="variationValueInput" placeholder="Value (£, use - for a deduction)" step="0.01" required>
      <button type="submit" class="primary">+ Add Variation</button>
    </form>
    <ul class="doc-list">${items}</ul>
    ${!variations.length ? '<p class="empty-state">No variations recorded yet.</p>' : `<p class="variation-total">Variations total: <strong>${money(variationsTotal(variations))}</strong></p>`}
  `;

  document.getElementById('variationAddForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const description = document.getElementById('variationDescInput').value.trim();
    const value = document.getElementById('variationValueInput').value;
    if (!description) { alert('Enter a description.'); return; }
    if (value === '' || isNaN(Number(value))) { alert('Enter a valid value.'); return; }
    try {
      await api(`/api/jobs/${currentDetailJobId}/variations`, {
        method: 'POST',
        body: JSON.stringify({ description, value: Number(value) }),
      });
      await refreshJobDetail();
    } catch (err) {
      alert(err.message);
    }
  });

  container.querySelectorAll('.variation-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this variation? This cannot be undone.')) return;
      try {
        await api(`/api/jobs/${currentDetailJobId}/variations/${btn.dataset.variation}`, { method: 'DELETE' });
        await refreshJobDetail();
      } catch (err) {
        alert(err.message);
      }
    });
  });
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
    if (e.hasAccount) tr.classList.add('employee-linked');
    tr.innerHTML = `<td>${escapeHtml(e.name)} <span style="color:var(--muted)">(${jobCount} job${jobCount === 1 ? '' : 's'})</span>${e.hasAccount ? '<span class="linked-badge" title="An account has been created and linked to this employee">Account linked</span>' : ''}</td>
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

// ---------- Price List (Labour & Materials) ----------

// Builds one item+price list (search, add row, inline edit/delete) wired to its own DOM ids.
// Used once for Labour and once for Price List - same table/search/edit behaviour, just
// scoped to a different `kind` slice of state.priceListItems.
function createPriceListView({ kind, ids }) {
  let editingId = null;
  let searchTerm = '';

  function items() {
    const term = searchTerm.trim().toLowerCase();
    return state.priceListItems
      .filter((it) => it.kind === kind && (!term || it.name.toLowerCase().includes(term)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function render() {
    const list = items();
    const tbody = document.querySelector(`#${ids.table} tbody`);
    tbody.innerHTML = list.length ? list.map((it) => {
      if (editingId === it.id) {
        return `
          <tr data-id="${it.id}">
            <td><input type="text" class="pl-edit-name" value="${escapeHtml(it.name)}"></td>
            <td><input type="number" step="0.01" min="0" class="pl-edit-price" value="${it.price}"></td>
            <td class="row-actions">
              <button type="button" class="primary pl-save-btn">Save</button>
              <button type="button" class="pl-cancel-btn">Cancel</button>
            </td>
          </tr>`;
      }
      return `
        <tr data-id="${it.id}">
          <td>${escapeHtml(it.name)}</td>
          <td>${money(it.price)}</td>
          <td class="row-actions">
            <button type="button" class="pl-edit-btn">Edit</button>
            ${isAdmin() ? '<button type="button" class="danger pl-delete-btn">Delete</button>' : ''}
          </td>
        </tr>`;
    }).join('') : `<tr><td colspan="3" class="empty-state">${searchTerm.trim() ? 'No items match your search.' : 'Nothing added yet.'}</td></tr>`;

    tbody.querySelectorAll('.pl-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => { editingId = btn.closest('tr').dataset.id; render(); });
    });
    tbody.querySelectorAll('.pl-cancel-btn').forEach((btn) => {
      btn.addEventListener('click', () => { editingId = null; render(); });
    });
    tbody.querySelectorAll('.pl-save-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tr = btn.closest('tr');
        const payload = {
          name: tr.querySelector('.pl-edit-name').value,
          price: tr.querySelector('.pl-edit-price').value,
        };
        try {
          await api(`/api/price-list/${tr.dataset.id}`, { method: 'PUT', body: JSON.stringify(payload) });
          state.priceListItems = await api('/api/price-list');
          editingId = null;
          render();
        } catch (err) {
          alert(err.message);
        }
      });
    });
    tbody.querySelectorAll('.pl-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('tr').dataset.id;
        if (!confirm('Delete this item?')) return;
        try {
          await api(`/api/price-list/${id}`, { method: 'DELETE' });
          state.priceListItems = await api('/api/price-list');
          render();
        } catch (err) {
          alert(err.message);
        }
      });
    });
  }

  document.getElementById(ids.search).addEventListener('input', (e) => {
    searchTerm = e.target.value;
    render();
  });

  document.getElementById(ids.addBtn).addEventListener('click', async () => {
    const nameInput = document.getElementById(ids.addName);
    const priceInput = document.getElementById(ids.addPrice);
    if (!nameInput.value.trim()) return;
    try {
      await api('/api/price-list', { method: 'POST', body: JSON.stringify({ kind, name: nameInput.value, price: priceInput.value }) });
      nameInput.value = '';
      priceInput.value = '';
      state.priceListItems = await api('/api/price-list');
      render();
    } catch (err) {
      alert(err.message);
    }
  });

  return { render };
}

const labourList = createPriceListView({
  kind: 'labour',
  ids: { search: 'labourSearch', addName: 'newLabourName', addPrice: 'newLabourPrice', addBtn: 'addLabourBtn', table: 'labourTable' },
});

const materialList = createPriceListView({
  kind: 'material',
  ids: { search: 'priceListSearch', addName: 'newPriceListName', addPrice: 'newPriceListPrice', addBtn: 'addPriceListBtn', table: 'priceListTable' },
});

function renderPriceLists() {
  labourList.render();
  materialList.render();
}

// ---------- Subbies (subcontractor directory) ----------
// Shared contact list - anyone can add/edit an entry, admins can delete. Search matches
// company name, person's name or trade (not phone - phone numbers aren't what people
// search by when trying to find "that plasterer" or "that lot at ABC Roofing").

let editingSubbyId = null;
let subbiesSearchTerm = '';

function subbiesList() {
  const term = subbiesSearchTerm.trim().toLowerCase();
  return state.subbies
    .filter((s) => !term
      || s.companyName.toLowerCase().includes(term)
      || s.personName.toLowerCase().includes(term)
      || (s.trade || '').toLowerCase().includes(term))
    .sort((a, b) => a.companyName.localeCompare(b.companyName));
}

function renderSubbies() {
  const list = subbiesList();
  const tbody = document.querySelector('#subbiesTable tbody');
  tbody.innerHTML = list.length ? list.map((s) => {
    const formCell = s.formStoredName
      ? `<a href="/api/subbies/${s.id}/file" target="_blank">${escapeHtml(s.formOriginalName || 'Form')}</a>`
      : '<span class="hint">No form</span>';
    if (editingSubbyId === s.id) {
      return `
        <tr data-id="${s.id}">
          <td><input type="text" class="sb-edit-company" value="${escapeHtml(s.companyName)}"></td>
          <td><input type="text" class="sb-edit-person" value="${escapeHtml(s.personName)}"></td>
          <td><input type="tel" class="sb-edit-phone" value="${escapeHtml(s.phone || '')}"></td>
          <td><input type="text" class="sb-edit-trade" value="${escapeHtml(s.trade || '')}"></td>
          <td>${formCell}</td>
          <td class="row-actions">
            <button type="button" class="primary sb-save-btn">Save</button>
            <button type="button" class="sb-cancel-btn">Cancel</button>
          </td>
        </tr>`;
    }
    return `
      <tr data-id="${s.id}">
        <td>${escapeHtml(s.companyName)}</td>
        <td>${escapeHtml(s.personName)}</td>
        <td>${escapeHtml(s.phone || '')}</td>
        <td>${escapeHtml(s.trade || '')}</td>
        <td>${formCell}</td>
        <td class="row-actions">
          <button type="button" class="sb-edit-btn">Edit</button>
          ${isAdmin() ? '<button type="button" class="danger sb-delete-btn">Delete</button>' : ''}
        </td>
      </tr>`;
  }).join('') : `<tr><td colspan="6" class="empty-state">${subbiesSearchTerm.trim() ? 'No subbies match your search.' : 'Nothing added yet.'}</td></tr>`;

  tbody.querySelectorAll('.sb-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => { editingSubbyId = btn.closest('tr').dataset.id; renderSubbies(); });
  });
  tbody.querySelectorAll('.sb-cancel-btn').forEach((btn) => {
    btn.addEventListener('click', () => { editingSubbyId = null; renderSubbies(); });
  });
  tbody.querySelectorAll('.sb-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const payload = {
        companyName: tr.querySelector('.sb-edit-company').value,
        personName: tr.querySelector('.sb-edit-person').value,
        phone: tr.querySelector('.sb-edit-phone').value,
        trade: tr.querySelector('.sb-edit-trade').value,
      };
      try {
        await api(`/api/subbies/${tr.dataset.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        state.subbies = await api('/api/subbies');
        editingSubbyId = null;
        renderSubbies();
      } catch (err) {
        alert(err.message);
      }
    });
  });
  tbody.querySelectorAll('.sb-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('tr').dataset.id;
      if (!confirm('Delete this subby?')) return;
      try {
        await api(`/api/subbies/${id}`, { method: 'DELETE' });
        state.subbies = await api('/api/subbies');
        renderSubbies();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

document.getElementById('subbiesSearch').addEventListener('input', (e) => {
  subbiesSearchTerm = e.target.value;
  renderSubbies();
});

document.getElementById('newSubbyForm').addEventListener('change', (e) => {
  const file = e.target.files[0];
  document.getElementById('newSubbyFormName').textContent = file ? file.name : '';
});

document.getElementById('addSubbyBtn').addEventListener('click', async () => {
  const companyInput = document.getElementById('newSubbyCompany');
  const personInput = document.getElementById('newSubbyPerson');
  const phoneInput = document.getElementById('newSubbyPhone');
  const tradeInput = document.getElementById('newSubbyTrade');
  const formInput = document.getElementById('newSubbyForm');
  if (!companyInput.value.trim() || !personInput.value.trim()) return;
  if (!formInput.files[0]) { alert('Upload the subcontractor form before adding a subby.'); return; }
  try {
    const formData = new FormData();
    formData.append('companyName', companyInput.value);
    formData.append('personName', personInput.value);
    formData.append('phone', phoneInput.value);
    formData.append('trade', tradeInput.value);
    formData.append('file', formInput.files[0]);
    const res = await fetch('/api/subbies', { method: 'POST', body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Add failed');
    }
    companyInput.value = '';
    personInput.value = '';
    phoneInput.value = '';
    tradeInput.value = '';
    formInput.value = '';
    document.getElementById('newSubbyFormName').textContent = '';
    state.subbies = await api('/api/subbies');
    renderSubbies();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- Quoting ----------

let quotingSearchTerm = '';
let editingQuoteId = null;

function quotingUserName(id) {
  if (!id) return '';
  const u = state.userColors.find((x) => x.id === id);
  return u ? u.name : '';
}

function quotesList() {
  const term = quotingSearchTerm.trim().toLowerCase();
  return state.quotes.filter((q) => !term
    || q.clientName.toLowerCase().includes(term)
    || (q.siteAddress || '').toLowerCase().includes(term)
    || (q.description || '').toLowerCase().includes(term)
    || quotingUserName(q.assignedTo).toLowerCase().includes(term));
}

function quoteAssigneeOptions(selectedId) {
  return '<option value="">Unassigned</option>'
    + state.userColors.map((u) => `<option value="${u.id}" ${selectedId === u.id ? 'selected' : ''}>${escapeHtml(u.name)}</option>`).join('');
}

function quoteEditRow(q) {
  return `
    <tr data-id="${q.id}">
      <td><input type="text" class="qt-edit-client" value="${escapeHtml(q.clientName)}"></td>
      <td><input type="text" class="qt-edit-address" value="${escapeHtml(q.siteAddress || '')}"></td>
      <td><input type="text" class="qt-edit-description" value="${escapeHtml(q.description || '')}"></td>
      <td><input type="date" class="qt-edit-duedate" value="${q.dueDate || ''}"></td>
      <td><select class="qt-edit-assigned">${quoteAssigneeOptions(q.assignedTo)}</select></td>
      <td><span class="hire-status ${q.quoted ? 'returned' : 'due-soon'}">${q.quoted ? 'Quoted' : 'Pending'}</span></td>
      <td class="row-actions">
        <button type="button" class="primary qt-save-btn">Save</button>
        <button type="button" class="qt-cancel-btn">Cancel</button>
      </td>
    </tr>`;
}

function quoteDisplayRow(q) {
  const canManage = canManageQuotes();
  const isMine = !!(state.currentUser && state.currentUser.id === q.assignedTo);
  return `
    <tr data-id="${q.id}">
      <td>${escapeHtml(q.clientName)}</td>
      <td>${escapeHtml(q.siteAddress || '—')}</td>
      <td>${escapeHtml(q.description || '—')}</td>
      <td>${q.dueDate ? new Date(q.dueDate).toLocaleDateString('en-GB') : '—'}</td>
      <td>${escapeHtml(quotingUserName(q.assignedTo) || 'Unassigned')}</td>
      <td>${(canManage || isMine)
        ? `<label class="quote-status-toggle"><input type="checkbox" data-toggle-quote="${q.id}" ${q.quoted ? 'checked' : ''}> <span class="hire-status ${q.quoted ? 'returned' : 'due-soon'}">${q.quoted ? 'Quoted' : 'Pending'}</span></label>`
        : `<span class="hire-status ${q.quoted ? 'returned' : 'due-soon'}">${q.quoted ? 'Quoted' : 'Pending'}</span>`}</td>
      <td class="row-actions">
        ${canManage ? '<button type="button" class="qt-edit-btn">Edit</button><button type="button" class="danger qt-delete-btn">Delete</button>' : ''}
      </td>
    </tr>`;
}

function renderQuoting() {
  const list = quotesList();
  const tbody = document.querySelector('#quotingTable tbody');
  document.getElementById('quotingEmptyState').hidden = !!list.length;
  document.getElementById('quotingEmptyState').textContent = state.quotes.length && quotingSearchTerm.trim()
    ? 'No quotes match your search.'
    : 'No quotes yet.';
  tbody.innerHTML = list.map((q) => (q.id === editingQuoteId ? quoteEditRow(q) : quoteDisplayRow(q))).join('');

  // Rebuild the add-form assignee list from the latest users, but keep whatever the
  // person had already picked so a live refresh mid-selection doesn't reset it.
  const assignSelect = document.getElementById('newQuoteAssignedTo');
  const previousSelection = assignSelect.value;
  assignSelect.innerHTML = quoteAssigneeOptions(previousSelection);

  tbody.querySelectorAll('[data-toggle-quote]').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const id = checkbox.dataset.toggleQuote;
      const quoted = checkbox.checked;
      try {
        await api(`/api/quotes/${id}/quoted`, { method: 'PUT', body: JSON.stringify({ quoted }) });
        const q = state.quotes.find((x) => x.id === id);
        if (q) q.quoted = quoted;
        renderQuoting();
      } catch (err) {
        checkbox.checked = !quoted;
        alert(err.message);
      }
    });
  });
  tbody.querySelectorAll('.qt-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => { editingQuoteId = btn.closest('tr').dataset.id; renderQuoting(); });
  });
  tbody.querySelectorAll('.qt-cancel-btn').forEach((btn) => {
    btn.addEventListener('click', () => { editingQuoteId = null; renderQuoting(); });
  });
  tbody.querySelectorAll('.qt-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const body = {
        clientName: tr.querySelector('.qt-edit-client').value,
        siteAddress: tr.querySelector('.qt-edit-address').value,
        description: tr.querySelector('.qt-edit-description').value,
        dueDate: tr.querySelector('.qt-edit-duedate').value || null,
        assignedTo: tr.querySelector('.qt-edit-assigned').value || null,
      };
      try {
        await api(`/api/quotes/${tr.dataset.id}`, { method: 'PUT', body: JSON.stringify(body) });
        editingQuoteId = null;
        loadQuotes();
      } catch (err) {
        alert(err.message);
      }
    });
  });
  tbody.querySelectorAll('.qt-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this quote?')) return;
      try {
        await api(`/api/quotes/${btn.closest('tr').dataset.id}`, { method: 'DELETE' });
        loadQuotes();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

async function loadQuotes() {
  state.quotes = await api('/api/quotes');
  renderQuoting();
}

document.getElementById('quotingSearch').addEventListener('input', (e) => {
  quotingSearchTerm = e.target.value;
  renderQuoting();
});

document.getElementById('addQuoteBtn').addEventListener('click', async () => {
  const clientInput = document.getElementById('newQuoteClient');
  const addressInput = document.getElementById('newQuoteAddress');
  const descriptionInput = document.getElementById('newQuoteDescription');
  const dueDateInput = document.getElementById('newQuoteDueDate');
  const assignedInput = document.getElementById('newQuoteAssignedTo');
  if (!clientInput.value.trim()) return;
  try {
    await api('/api/quotes', {
      method: 'POST',
      body: JSON.stringify({
        clientName: clientInput.value,
        siteAddress: addressInput.value,
        description: descriptionInput.value,
        dueDate: dueDateInput.value || null,
        assignedTo: assignedInput.value || null,
      }),
    });
    clientInput.value = '';
    addressInput.value = '';
    descriptionInput.value = '';
    dueDateInput.value = '';
    loadQuotes();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- Hire ----------
// Admin-only tracker for hired-in plant/equipment - flags a hire once it's due back
// soon or is already overdue, computed server-side against today so it's never stale.

const HIRE_STATUS_LABELS = { 'on-hire': 'On Hire', 'due-soon': 'Due Soon', overdue: 'Overdue', returned: 'Off Hired' };

let editingHireId = null;

async function loadHires() {
  state.hires = await api('/api/hires');
  renderHires();
}

function hireEditRow(h) {
  return `
    <tr data-id="${h.id}">
      <td><input type="text" class="hire-edit-item" value="${escapeHtml(h.item)}"></td>
      <td><input type="text" class="hire-edit-supplier" value="${escapeHtml(h.supplier)}"></td>
      <td><input type="text" class="hire-edit-jobnumber" value="${escapeHtml(h.jobNumber)}"></td>
      <td><input type="date" class="hire-edit-date" value="${h.hireDate}"></td>
      <td><input type="number" min="1" step="1" class="hire-edit-qty" value="${h.quantity}"></td>
      <td class="hire-edit-length">
        <input type="number" min="1" step="1" class="hire-edit-duration" value="${h.durationValue}">
        <select class="hire-edit-unit">
          <option value="days" ${h.durationUnit === 'days' ? 'selected' : ''}>Days</option>
          <option value="weeks" ${h.durationUnit === 'weeks' ? 'selected' : ''}>Weeks</option>
        </select>
      </td>
      <td>${h.dueBack}</td>
      <td><span class="hire-status ${h.status}">${HIRE_STATUS_LABELS[h.status]}</span></td>
      <td class="row-actions">
        <button type="button" class="primary hire-save-btn">Save</button>
        <button type="button" class="hire-cancel-btn">Cancel</button>
      </td>
    </tr>
  `;
}

function hireDisplayRow(h) {
  return `
    <tr>
      <td>${escapeHtml(h.item)}</td>
      <td>${escapeHtml(h.supplier || '—')}</td>
      <td>${escapeHtml(h.jobNumber || '—')}</td>
      <td>${h.hireDate}</td>
      <td>${h.quantity}</td>
      <td>${h.durationValue} ${h.durationUnit}</td>
      <td>${h.dueBack}</td>
      <td><span class="hire-status ${h.status}">${HIRE_STATUS_LABELS[h.status]}</span></td>
      <td class="row-actions">
        <button type="button" data-edit-hire="${h.id}">Edit</button>
        <button type="button" data-return="${h.id}">Mark Off Hired</button>
        <button type="button" class="danger" data-del-hire="${h.id}">Delete</button>
      </td>
    </tr>
  `;
}

function hireOffHiredRow(h) {
  return `
    <tr>
      <td>${escapeHtml(h.item)}</td>
      <td>${escapeHtml(h.supplier || '—')}</td>
      <td>${escapeHtml(h.jobNumber || '—')}</td>
      <td>${h.hireDate}</td>
      <td>${h.quantity}</td>
      <td>${h.durationValue} ${h.durationUnit}</td>
      <td>${h.returnedAt}</td>
      <td class="row-actions">
        <button type="button" class="danger" data-del-hire="${h.id}">Delete</button>
      </td>
    </tr>
  `;
}

function renderHires() {
  const view = document.getElementById('hireViewSelect').value;
  document.getElementById('hireOnHiredSection').hidden = view !== 'on-hire';
  document.getElementById('hireOffHiredSection').hidden = view !== 'off-hired';

  // Summary always reflects every hire, regardless of the search box, so overdue/due-soon
  // counts stay a reliable heads-up even while someone's searching for something else.
  const overdue = state.hires.filter((h) => h.status === 'overdue').length;
  const dueSoon = state.hires.filter((h) => h.status === 'due-soon').length;
  const summary = document.getElementById('hireSummary');
  summary.innerHTML = (overdue || dueSoon)
    ? `<p class="hire-flag-banner">${overdue ? `<strong>${overdue}</strong> hire${overdue === 1 ? '' : 's'} overdue` : ''}${overdue && dueSoon ? ' · ' : ''}${dueSoon ? `<strong>${dueSoon}</strong> due back within 3 days` : ''}</p>`
    : '';

  const term = document.getElementById('hireSearch').value.trim().toLowerCase();
  const filtered = term
    ? state.hires.filter((h) => [h.item, h.supplier, h.jobNumber].some((v) => (v || '').toLowerCase().includes(term)))
    : state.hires;
  const active = filtered.filter((h) => h.status !== 'returned');
  const offHired = filtered.filter((h) => h.status === 'returned');
  const activeCount = state.hires.filter((h) => h.status !== 'returned').length;
  const offHiredCount = state.hires.filter((h) => h.status === 'returned').length;

  const tbody = document.querySelector('#hiresTable tbody');
  document.getElementById('hiresEmptyState').hidden = !!active.length;
  document.getElementById('hiresEmptyState').textContent = activeCount && term
    ? 'No hires match your search.'
    : 'No hires recorded yet.';
  tbody.innerHTML = active.map((h) => (h.id === editingHireId ? hireEditRow(h) : hireDisplayRow(h))).join('');

  const offHiredTbody = document.querySelector('#hiresOffHiredTable tbody');
  document.getElementById('hiresOffHiredEmptyState').hidden = !!offHired.length;
  document.getElementById('hiresOffHiredEmptyState').textContent = offHiredCount && term
    ? 'No off-hired equipment matches your search.'
    : 'No off-hired equipment yet.';
  offHiredTbody.innerHTML = offHired.map((h) => hireOffHiredRow(h)).join('');
  offHiredTbody.querySelectorAll('[data-del-hire]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this hire record? This cannot be undone.')) return;
      try {
        await api(`/api/hires/${btn.dataset.delHire}`, { method: 'DELETE' });
        loadHires();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  tbody.querySelectorAll('[data-edit-hire]').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingHireId = btn.dataset.editHire;
      renderHires();
    });
  });
  tbody.querySelectorAll('.hire-cancel-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingHireId = null;
      renderHires();
    });
  });
  tbody.querySelectorAll('.hire-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const body = {
        item: tr.querySelector('.hire-edit-item').value.trim(),
        supplier: tr.querySelector('.hire-edit-supplier').value.trim(),
        jobNumber: tr.querySelector('.hire-edit-jobnumber').value.trim(),
        hireDate: tr.querySelector('.hire-edit-date').value,
        quantity: Number(tr.querySelector('.hire-edit-qty').value),
        durationValue: Number(tr.querySelector('.hire-edit-duration').value),
        durationUnit: tr.querySelector('.hire-edit-unit').value,
      };
      try {
        await api(`/api/hires/${tr.dataset.id}`, { method: 'PUT', body: JSON.stringify(body) });
        editingHireId = null;
        loadHires();
      } catch (err) {
        alert(err.message);
      }
    });
  });
  tbody.querySelectorAll('[data-return]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/hires/${btn.dataset.return}/return`, { method: 'POST' });
        loadHires();
      } catch (err) {
        alert(err.message);
      }
    });
  });
  tbody.querySelectorAll('[data-del-hire]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this hire record? This cannot be undone.')) return;
      try {
        await api(`/api/hires/${btn.dataset.delHire}`, { method: 'DELETE' });
        loadHires();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

document.getElementById('hireSearch').addEventListener('input', renderHires);
document.getElementById('hireViewSelect').addEventListener('change', renderHires);

document.getElementById('hireAddForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    item: document.getElementById('hireItemInput').value.trim(),
    supplier: document.getElementById('hireSupplierInput').value.trim(),
    jobNumber: document.getElementById('hireJobNumberInput').value.trim(),
    hireDate: document.getElementById('hireDateInput').value,
    quantity: Number(document.getElementById('hireQuantityInput').value),
    durationValue: Number(document.getElementById('hireDurationInput').value),
    durationUnit: document.getElementById('hireDurationUnitSelect').value,
  };
  try {
    await api('/api/hires', { method: 'POST', body: JSON.stringify(body) });
    e.target.reset();
    document.getElementById('hireQuantityInput').value = 1;
    loadHires();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- Signage Tracker ----------
// Fixed inventory of 10 site signs, shared across everyone (no admin gate, unlike Hire).
// Each sign's location is edited in place; a blank location means it's back in the yard
// and available to go out again.

let editingSignageId = null;

function signageEditRow(s) {
  return `
    <tr data-id="${s.id}">
      <td><input type="text" class="signage-edit-label" value="${escapeHtml(s.label)}"></td>
      <td><input type="text" class="signage-edit-location" value="${escapeHtml(s.location)}" placeholder="Blank = available"></td>
      <td><input type="text" class="signage-edit-notes" value="${escapeHtml(s.notes)}"></td>
      <td class="row-actions">
        <button type="button" class="primary signage-save-btn">Save</button>
        <button type="button" class="signage-cancel-btn">Cancel</button>
      </td>
    </tr>
  `;
}

function signageDisplayRow(s) {
  const available = !s.location;
  return `
    <tr>
      <td>${escapeHtml(s.label)}</td>
      <td><span class="signage-status ${available ? 'available' : 'out'}">${available ? 'Available' : escapeHtml(s.location)}</span></td>
      <td>${escapeHtml(s.notes || '—')}</td>
      <td class="row-actions">
        <button type="button" data-edit-signage="${s.id}">Edit</button>
      </td>
    </tr>
  `;
}

function renderSignage() {
  const available = state.signage.filter((s) => !s.location).length;
  const summary = document.getElementById('signageSummary');
  summary.innerHTML = `<p class="signage-summary-banner"><strong>${available}</strong> of <strong>${state.signage.length}</strong> signs available</p>`;

  const tbody = document.querySelector('#signageTable tbody');
  tbody.innerHTML = state.signage.map((s) => (s.id === editingSignageId ? signageEditRow(s) : signageDisplayRow(s))).join('');

  tbody.querySelectorAll('[data-edit-signage]').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingSignageId = btn.dataset.editSignage;
      renderSignage();
    });
  });
  tbody.querySelectorAll('.signage-cancel-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingSignageId = null;
      renderSignage();
    });
  });
  tbody.querySelectorAll('.signage-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const body = {
        label: tr.querySelector('.signage-edit-label').value.trim(),
        location: tr.querySelector('.signage-edit-location').value.trim(),
        notes: tr.querySelector('.signage-edit-notes').value.trim(),
      };
      try {
        await api(`/api/signage/${tr.dataset.id}`, { method: 'PUT', body: JSON.stringify(body) });
        editingSignageId = null;
        state.signage = await api('/api/signage');
        renderSignage();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

// ---------- Diary ----------
// Private journal, multiple timestamped entries per day - the server always scopes this
// to req.user, so there's no filtering to do here beyond how it's grouped/displayed.

let editingDiaryId = null;
let diaryViewDate = null;

async function loadDiary() {
  state.diaryEntries = await api('/api/diary');
  renderDiary();
}

function shiftDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return calDateStr(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

// Also drives what date new entries get added to - there's a single "which day am I
// looking at" concept for the whole tab, rather than a separate picker in the add form.
function setDiaryViewDate(dateStr) {
  diaryViewDate = dateStr;
  document.getElementById('diaryViewDateInput').value = dateStr;
  document.getElementById('diaryAddingForLabel').textContent =
    dateStr === todayDateStr() ? 'Adding to today' : `Adding to ${diaryDateLabel(dateStr)}`;
  renderDiary();
}

function diaryEntryTime(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function diaryDateLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function diaryEntryRow(entry) {
  if (entry.id === editingDiaryId) {
    return `
      <li class="diary-entry-item diary-entry-editing" data-id="${entry.id}">
        <textarea class="diary-edit-text" rows="3">${escapeHtml(entry.text)}</textarea>
        <div class="diary-entry-footer">
          <input type="date" class="diary-edit-date" value="${entry.date}">
          <div class="diary-entry-actions">
            <button type="button" class="primary diary-save-btn">Save</button>
            <button type="button" class="diary-cancel-btn">Cancel</button>
          </div>
        </div>
      </li>
    `;
  }
  return `
    <li class="diary-entry-item${entry.completed ? ' diary-entry-done' : ''}" data-id="${entry.id}">
      <div class="diary-entry-main">
        <input type="checkbox" class="diary-entry-check" data-toggle-diary="${entry.id}" ${entry.completed ? 'checked' : ''} title="${entry.completed ? 'Mark not done' : 'Mark done'}">
        <p class="diary-entry-text">${escapeHtml(entry.text).replace(/\n/g, '<br>')}</p>
      </div>
      <div class="diary-entry-footer">
        <span class="diary-entry-meta">${diaryEntryTime(entry.createdAt)}${entry.updatedAt !== entry.createdAt ? ' · edited' : ''}</span>
        <div class="diary-entry-actions">
          <button type="button" data-edit-diary="${entry.id}">Edit</button>
          <button type="button" class="danger" data-del-diary="${entry.id}">Delete</button>
        </div>
      </div>
    </li>
  `;
}

function renderDiary() {
  const list = document.getElementById('diaryEntries');
  const dayEntries = state.diaryEntries.filter((e) => e.date === diaryViewDate);
  document.getElementById('diaryEmptyState').hidden = !!dayEntries.length;
  list.innerHTML = dayEntries.map(diaryEntryRow).join('');

  list.querySelectorAll('[data-toggle-diary]').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const id = checkbox.dataset.toggleDiary;
      const completed = checkbox.checked;
      try {
        await api(`/api/diary/${id}/complete`, { method: 'PUT', body: JSON.stringify({ completed }) });
        const entry = state.diaryEntries.find((e) => e.id === id);
        if (entry) entry.completed = completed;
        renderDiary();
      } catch (err) {
        checkbox.checked = !completed;
        alert(err.message);
      }
    });
  });
  list.querySelectorAll('[data-edit-diary]').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingDiaryId = btn.dataset.editDiary;
      renderDiary();
    });
  });
  list.querySelectorAll('.diary-cancel-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingDiaryId = null;
      renderDiary();
    });
  });
  list.querySelectorAll('.diary-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const li = btn.closest('li');
      const body = {
        text: li.querySelector('.diary-edit-text').value.trim(),
        date: li.querySelector('.diary-edit-date').value,
      };
      try {
        await api(`/api/diary/${li.dataset.id}`, { method: 'PUT', body: JSON.stringify(body) });
        editingDiaryId = null;
        loadDiary();
      } catch (err) {
        alert(err.message);
      }
    });
  });
  list.querySelectorAll('[data-del-diary]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this diary entry? This cannot be undone.')) return;
      try {
        await api(`/api/diary/${btn.dataset.delDiary}`, { method: 'DELETE' });
        loadDiary();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

document.getElementById('diaryAddForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    text: document.getElementById('diaryTextInput').value.trim(),
    date: diaryViewDate,
  };
  try {
    await api('/api/diary', { method: 'POST', body: JSON.stringify(body) });
    document.getElementById('diaryTextInput').value = '';
    loadDiary();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('diaryPrevBtn').addEventListener('click', () => setDiaryViewDate(shiftDateStr(diaryViewDate, -1)));
document.getElementById('diaryNextBtn').addEventListener('click', () => setDiaryViewDate(shiftDateStr(diaryViewDate, 1)));
document.getElementById('diaryTodayBtn').addEventListener('click', () => setDiaryViewDate(todayDateStr()));
document.getElementById('diaryViewDateInput').addEventListener('change', (e) => {
  if (e.target.value) setDiaryViewDate(e.target.value);
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

// Entries saved before start/end times existed are still stored as "X hours" - keep showing
// those as-is rather than as "undefined–undefined" now that new entries use actual times.
function formatWhen(e) {
  if (e.durationUnit === 'days' || e.durationUnit === 'hours') {
    const v = Number(e.durationValue);
    const label = e.durationUnit === 'days' ? (v === 1 ? 'day' : 'days') : (v === 1 ? 'hour' : 'hours');
    return `${v} ${label}`;
  }
  return `${e.startTime}–${e.endTime}`;
}

// Public/team events, visible to everyone. Excludes private entries - even your own -
// since those only ever appear on your own "My Calendar" view (see createCalendarView below).
function eventsOnDate(ds) {
  return state.calendarEvents.filter((e) => !e.isPrivate && ds >= e.date && ds <= e.endDate);
}

const calToday = new Date();

// Builds one calendar (month grid + day modal + add form) wired to its own set of DOM ids.
// Used once for the shared team calendar and once for the private "My Calendar" - same
// month-grid/day-modal behaviour, just scoped to a different slice of state.calendarEvents.
function createCalendarView({ scope, ids }) {
  let viewYear = calToday.getFullYear();
  let viewMonth = calToday.getMonth();
  let selectedDate = null;

  // "My Calendar" is everything that's yours - your private entries plus anything you've put
  // on the shared team calendar, so your day is in one place without duplicating any rows.
  function eventsOnDate(ds) {
    return state.calendarEvents.filter((e) => {
      const include = scope === 'private'
        ? !!(state.currentUser && e.userId === state.currentUser.id)
        : !e.isPrivate;
      if (!include) return false;
      return ds >= e.date && ds <= e.endDate;
    });
  }

  function render() {
    const grid = document.getElementById(ids.grid);
    const label = new Date(viewYear, viewMonth, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    document.getElementById(ids.monthLabel).textContent = label;

    const firstOfMonth = new Date(viewYear, viewMonth, 1);
    const startWeekday = (firstOfMonth.getDay() + 6) % 7; // Monday = 0
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const todayStr = calDateStr(calToday.getFullYear(), calToday.getMonth(), calToday.getDate());

    const cells = [];
    for (let i = 0; i < startWeekday; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);

    const MAX_CHIPS = 3;
    grid.innerHTML = cells.map((d) => {
      if (!d) return '<div class="cal-cell cal-cell-empty"></div>';
      const ds = calDateStr(viewYear, viewMonth, d);
      const dayEvents = eventsOnDate(ds);
      const isToday = ds === todayStr;
      const chips = dayEvents.slice(0, MAX_CHIPS).map((e) => `
        <div class="cal-chip" style="background:${userColor(e)}" title="${escapeHtml(e.userName)}: ${escapeHtml(e.title)} (${formatWhen(e)})">${scope === 'private' ? escapeHtml(truncate(e.title, 20)) : `${escapeHtml(e.userName)}: ${escapeHtml(truncate(e.title, 16))}`}</div>
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
      cell.addEventListener('click', () => openDayModal(cell.dataset.date));
    });
  }

  function openDayModal(ds) {
    selectedDate = ds;
    const [y, m, d] = ds.split('-').map(Number);
    document.getElementById(ids.modalTitle).textContent = new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    renderDayEvents();
    document.getElementById(ids.addForm).reset();
    document.getElementById(ids.addForm).hidden = true;
    document.getElementById(ids.addBtn).hidden = false;
    syncKindFields();
    document.getElementById(ids.modal).hidden = false;
  }

  function renderDayEvents() {
    const events = eventsOnDate(selectedDate);
    const list = document.getElementById(ids.eventsList);
    list.innerHTML = events.map((e) => `
      <li class="cal-day-event-item">
        <span class="cal-swatch" style="background:${userColor(e)}"></span>
        <div class="cal-day-event-body">
          <div class="cal-day-event-title">${escapeHtml(e.title)}${scope === 'private' && !e.isPrivate ? ' <span class="cal-today-badge" title="Also visible to everyone on the team calendar">Team</span>' : ''}</div>
          <div class="cal-day-event-meta">${scope === 'private' ? '' : `${escapeHtml(e.userName)} · `}${formatWhen(e)}${e.date !== e.endDate ? ` · ${e.date} to ${e.endDate}` : ''}</div>
        </div>
        ${(state.currentUser && (state.currentUser.id === e.userId || state.currentUser.role === 'admin')) ? `<button type="button" class="danger cal-day-event-delete" data-id="${e.id}">Delete</button>` : ''}
      </li>
    `).join('');
    document.getElementById(ids.emptyState).hidden = events.length !== 0;

    list.querySelectorAll('.cal-day-event-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this calendar entry?')) return;
        try {
          await api(`/api/calendar/${btn.dataset.id}`, { method: 'DELETE' });
          state.calendarEvents = await api('/api/calendar');
          renderDayEvents();
          render();
        } catch (err) {
          alert(err.message);
        }
      });
    });
  }

  document.getElementById(ids.prevBtn).addEventListener('click', () => {
    viewMonth -= 1;
    if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
    render();
  });

  document.getElementById(ids.nextBtn).addEventListener('click', () => {
    viewMonth += 1;
    if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
    render();
  });

  document.getElementById(ids.todayBtn).addEventListener('click', () => {
    viewYear = calToday.getFullYear();
    viewMonth = calToday.getMonth();
    render();
  });

  document.getElementById(ids.closeBtn).addEventListener('click', () => { document.getElementById(ids.modal).hidden = true; });

  document.getElementById(ids.addBtn).addEventListener('click', () => {
    document.getElementById(ids.addForm).hidden = false;
    document.getElementById(ids.addBtn).hidden = true;
    document.getElementById(ids.addTitle).focus();
  });

  // Toggles between a specific start/end time (same day) and a number-of-days field
  // (for holidays/multi-day entries) depending on what's picked in the "When" dropdown.
  function syncKindFields() {
    const kind = document.getElementById(ids.kind).value;
    document.getElementById(ids.timeFields).hidden = kind !== 'time';
    document.getElementById(ids.daysFields).hidden = kind !== 'days';
  }
  document.getElementById(ids.kind).addEventListener('change', syncKindFields);

  document.getElementById(ids.addCancelBtn).addEventListener('click', () => {
    document.getElementById(ids.addForm).reset();
    document.getElementById(ids.addForm).hidden = true;
    document.getElementById(ids.addBtn).hidden = false;
    syncKindFields();
  });

  document.getElementById(ids.addForm).addEventListener('submit', async (e) => {
    e.preventDefault();
    const kind = document.getElementById(ids.kind).value;
    const payload = {
      date: selectedDate,
      title: document.getElementById(ids.addTitle).value,
      durationUnit: kind,
      isPrivate: scope === 'private',
    };
    if (kind === 'days') {
      payload.durationValue = document.getElementById(ids.addDurationValue).value;
    } else {
      payload.startTime = document.getElementById(ids.addStartTime).value;
      payload.endTime = document.getElementById(ids.addEndTime).value;
    }
    try {
      await api('/api/calendar', { method: 'POST', body: JSON.stringify(payload) });
      state.calendarEvents = await api('/api/calendar');
      document.getElementById(ids.addForm).reset();
      document.getElementById(ids.addForm).hidden = true;
      document.getElementById(ids.addBtn).hidden = false;
      syncKindFields();
      renderDayEvents();
      render();
    } catch (err) {
      alert(err.message);
    }
  });

  function refreshIfOpen() {
    if (selectedDate && !document.getElementById(ids.modal).hidden) renderDayEvents();
  }

  return { render, openDayModal, refreshIfOpen };
}

const teamCalendar = createCalendarView({
  scope: 'team',
  ids: {
    grid: 'calendarGrid', monthLabel: 'calMonthLabel', prevBtn: 'calPrevBtn', nextBtn: 'calNextBtn', todayBtn: 'calTodayBtn',
    modal: 'calDayModal', modalTitle: 'calDayModalTitle', closeBtn: 'calDayCloseBtn', eventsList: 'calDayEventsList',
    emptyState: 'calDayEmptyState', addBtn: 'calDayAddBtn', addForm: 'calDayAddForm', addTitle: 'calDayAddTitle',
    kind: 'calDayAddKind', timeFields: 'calDayAddTimeFields', daysFields: 'calDayAddDaysFields',
    addStartTime: 'calDayAddStartTime', addEndTime: 'calDayAddEndTime',
    addDurationValue: 'calDayAddDurationValue', addCancelBtn: 'calDayAddCancelBtn',
  },
});

const myCalendar = createCalendarView({
  scope: 'private',
  ids: {
    grid: 'myCalendarGrid', monthLabel: 'myCalMonthLabel', prevBtn: 'myCalPrevBtn', nextBtn: 'myCalNextBtn', todayBtn: 'myCalTodayBtn',
    modal: 'myCalDayModal', modalTitle: 'myCalDayModalTitle', closeBtn: 'myCalDayCloseBtn', eventsList: 'myCalDayEventsList',
    emptyState: 'myCalDayEmptyState', addBtn: 'myCalDayAddBtn', addForm: 'myCalDayAddForm', addTitle: 'myCalDayAddTitle',
    kind: 'myCalDayAddKind', timeFields: 'myCalDayAddTimeFields', daysFields: 'myCalDayAddDaysFields',
    addStartTime: 'myCalDayAddStartTime', addEndTime: 'myCalDayAddEndTime',
    addDurationValue: 'myCalDayAddDurationValue', addCancelBtn: 'myCalDayAddCancelBtn',
  },
});

function renderCalendar() {
  teamCalendar.render();
  myCalendar.render();
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
          <span class="home-today-duration">${formatWhen(e)}</span>
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
    teamCalendar.openDayModal(todayStr);
  });

  container.querySelectorAll('.home-rams-btn').forEach((btn) => {
    btn.addEventListener('click', () => openJobDetail(btn.dataset.job, 'rams'));
  });
}

// ---------- Risk Assessments ----------
// Three kinds of card in the same grid, distinguished by data-kind on their "View & Attach
// to Job" button: staff-uploaded files ("library"), generic in-code templates ("generic"),
// and edited "Save As" copies of either ("custom"). Generic and custom ones open in an
// editable form; editing one and using Save As creates a new "custom" entry rather than
// overwriting the original, so the in-code templates never change and nothing saved is lost.

function raBandClient(r) {
  if (r <= 2) return { label: 'No Action', slug: 'no-action' };
  if (r <= 6) return { label: 'Monitor', slug: 'monitor' };
  if (r <= 12) return { label: 'Action', slug: 'action' };
  if (r <= 16) return { label: 'Urgent Action', slug: 'urgent-action' };
  return { label: 'Stop', slug: 'stop' };
}

function renderRiskAssessments() {
  const grid = document.getElementById('raGrid');
  const libraryCards = state.raLibrary.map((ra) => `
    <div class="ra-card">
      <div class="ra-card-top">
        <h3>${escapeHtml(ra.name)}</h3>
        <span class="risk-badge">Saved</span>
      </div>
      <p class="ra-card-summary">Uploaded ${new Date(ra.createdAt).toLocaleDateString('en-GB')} · ${formatBytes(ra.size)}${ra.uploadedBy ? ' · ' + escapeHtml(ra.uploadedBy) : ''}</p>
      <div class="ra-card-actions">
        <button type="button" class="ra-view-btn" data-kind="library" data-ra="${ra.id}">View &amp; Attach to Job</button>
        <a href="/api/risk-assessments/library/${ra.id}/file" class="ra-download-btn">Download</a>
        ${isAdmin() ? `<button type="button" class="danger ra-library-delete-btn" data-ra="${ra.id}">Delete</button>` : ''}
      </div>
    </div>
  `);
  const genericCards = state.riskAssessments.map((ra) => `
    <div class="ra-card">
      <div class="ra-card-top">
        <h3>${escapeHtml(ra.title)}</h3>
        <span class="risk-badge ${ra.currentBand.slug}">${escapeHtml(ra.currentBand.label)}</span>
      </div>
      <p class="ra-card-summary">Risk rating ${ra.currentL} × ${ra.currentC} = ${ra.currentR}, reduced to ${ra.additionalR} with additional controls.</p>
      <div class="ra-card-actions">
        <button type="button" class="ra-view-btn" data-kind="generic" data-ra="${ra.id}">View, Edit &amp; Attach to Job</button>
        <a href="/api/risk-assessments/${ra.id}/download" class="ra-download-btn">Download</a>
      </div>
    </div>
  `);
  const customCards = state.raCustom.map((ra) => `
    <div class="ra-card">
      <div class="ra-card-top">
        <h3>${escapeHtml(ra.title)}</h3>
        <span class="risk-badge ${ra.currentBand.slug}">${escapeHtml(ra.currentBand.label)}</span>
      </div>
      <p class="ra-card-summary">Risk rating ${ra.currentL} × ${ra.currentC} = ${ra.currentR}, reduced to ${ra.additionalR} with additional controls.${ra.createdBy ? ' · Saved by ' + escapeHtml(ra.createdBy) : ''}</p>
      <div class="ra-card-actions">
        <button type="button" class="ra-view-btn" data-kind="custom" data-ra="${ra.id}">View, Edit &amp; Attach to Job</button>
        <a href="/api/risk-assessments/custom/${ra.id}/download" class="ra-download-btn">Download</a>
        ${isAdmin() ? `<button type="button" class="danger ra-custom-delete-btn" data-ra="${ra.id}">Delete</button>` : ''}
      </div>
    </div>
  `);
  grid.innerHTML = libraryCards.join('') + customCards.join('') + genericCards.join('');
  grid.querySelectorAll('.ra-view-btn').forEach((btn) => btn.addEventListener('click', () => openRaModal(btn.dataset.kind, btn.dataset.ra)));
  grid.querySelectorAll('.ra-library-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this saved risk assessment? This cannot be undone.')) return;
      try {
        await api(`/api/risk-assessments/library/${btn.dataset.ra}`, { method: 'DELETE' });
        state.raLibrary = await api('/api/risk-assessments/library');
        renderRiskAssessments();
      } catch (err) {
        alert(err.message);
      }
    });
  });
  grid.querySelectorAll('.ra-custom-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this saved risk assessment? This cannot be undone.')) return;
      try {
        await api(`/api/risk-assessments/custom/${btn.dataset.ra}`, { method: 'DELETE' });
        state.raCustom = await api('/api/risk-assessments/custom');
        renderRiskAssessments();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

document.getElementById('raLibraryFileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  document.getElementById('raLibraryFileName').textContent = file ? file.name : '';
  const nameInput = document.getElementById('raLibraryNameInput');
  if (file && !nameInput.value.trim()) nameInput.value = file.name.replace(/\.[^.]+$/, '');
});

document.getElementById('raLibraryUploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = document.getElementById('raLibraryFileInput').files[0];
  const name = document.getElementById('raLibraryNameInput').value.trim();
  if (!file) { alert('Choose a file to upload.'); return; }
  if (!name) { alert('Give this risk assessment a name.'); return; }
  const formData = new FormData();
  formData.append('file', file);
  formData.append('name', name);
  try {
    const res = await fetch('/api/risk-assessments/library', { method: 'POST', body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Upload failed');
    }
    e.target.reset();
    document.getElementById('raLibraryFileName').textContent = '';
    state.raLibrary = await api('/api/risk-assessments/library');
    renderRiskAssessments();
  } catch (err) {
    alert(err.message);
  }
});

const raModal = document.getElementById('raModal');
let currentRaId = null;
let currentRaKind = 'generic';

const linesToList = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean);

function raEditFormHtml(ra) {
  return `
    <div class="ra-edit-badges" id="raEditBadges"></div>
    <label>Title<input type="text" id="raEditTitle" value="${escapeHtml(ra.title)}"></label>
    <label>Relevant Legislation<input type="text" id="raEditLegislation" value="${escapeHtml(ra.legislation || '')}"></label>
    <label>Hazard &amp; Potential Harm<textarea id="raEditHazard" rows="2">${escapeHtml(ra.hazard || '')}</textarea></label>
    <label>Who Might Be Harmed<input type="text" id="raEditPeopleAffected" value="${escapeHtml(ra.peopleAffected || '')}"></label>
    <div class="ra-edit-grid">
      <label>Current Risk Controls (one per line)<textarea id="raEditCurrentControls" rows="5">${escapeHtml((ra.currentControls || []).join('\n'))}</textarea></label>
      <label>Additional Risk Controls (one per line)<textarea id="raEditAdditionalControls" rows="5">${escapeHtml((ra.additionalControls || []).join('\n'))}</textarea></label>
    </div>
    <div class="ra-edit-grid ra-edit-lc">
      <label>Current L<input type="number" id="raEditCurrentL" min="1" max="5" value="${ra.currentL}"></label>
      <label>Current C<input type="number" id="raEditCurrentC" min="1" max="5" value="${ra.currentC}"></label>
      <label>Additional L<input type="number" id="raEditAdditionalL" min="1" max="5" value="${ra.additionalL}"></label>
      <label>Additional C<input type="number" id="raEditAdditionalC" min="1" max="5" value="${ra.additionalC}"></label>
    </div>
    <label>PPE Required (one per line)<textarea id="raEditPpe" rows="3">${escapeHtml((ra.ppe || []).join('\n'))}</textarea></label>
    <div class="ra-save-as">
      <label>Save As<input type="text" id="raSaveAsName" value="${escapeHtml(ra.title)}" placeholder="Name for the new risk assessment"></label>
      <button type="button" id="raSaveAsBtn" class="primary">Save as New Risk Assessment</button>
    </div>
  `;
}

function updateRaEditBadges() {
  const cl = Number(document.getElementById('raEditCurrentL').value) || 1;
  const cc = Number(document.getElementById('raEditCurrentC').value) || 1;
  const al = Number(document.getElementById('raEditAdditionalL').value) || 1;
  const ac = Number(document.getElementById('raEditAdditionalC').value) || 1;
  const currentR = cl * cc;
  const additionalR = al * ac;
  const currentBand = raBandClient(currentR);
  const additionalBand = raBandClient(additionalR);
  document.getElementById('raEditBadges').innerHTML = `
    <span class="risk-badge ${currentBand.slug}">Current: ${cl} × ${cc} = ${currentR} — ${escapeHtml(currentBand.label)}</span>
    <span class="risk-badge ${additionalBand.slug}">With additional controls: ${al} × ${ac} = ${additionalR} — ${escapeHtml(additionalBand.label)}</span>
  `;
}

function readRaEditForm() {
  return {
    title: document.getElementById('raEditTitle').value.trim(),
    legislation: document.getElementById('raEditLegislation').value.trim(),
    hazard: document.getElementById('raEditHazard').value.trim(),
    peopleAffected: document.getElementById('raEditPeopleAffected').value.trim(),
    currentControls: linesToList(document.getElementById('raEditCurrentControls').value),
    currentL: Number(document.getElementById('raEditCurrentL').value) || 1,
    currentC: Number(document.getElementById('raEditCurrentC').value) || 1,
    additionalControls: linesToList(document.getElementById('raEditAdditionalControls').value),
    additionalL: Number(document.getElementById('raEditAdditionalL').value) || 1,
    additionalC: Number(document.getElementById('raEditAdditionalC').value) || 1,
    ppe: linesToList(document.getElementById('raEditPpe').value),
  };
}

function openRaModal(kind, id) {
  currentRaKind = kind;
  currentRaId = id;

  if (kind === 'library') {
    const ra = state.raLibrary.find((r) => r.id === id);
    if (!ra) return;
    document.getElementById('raModalTitle').textContent = ra.name;
    document.getElementById('raModalBody').innerHTML = `
      <p>Uploaded file: <a href="/api/risk-assessments/library/${ra.id}/file" target="_blank">${escapeHtml(ra.originalName)}</a> (${formatBytes(ra.size)})</p>
      <p class="hint">Open the file above to review it, then attach it to a job below.</p>
    `;
    document.getElementById('raDownloadLink').href = `/api/risk-assessments/library/${ra.id}/file`;
  } else {
    const list = kind === 'custom' ? state.raCustom : state.riskAssessments;
    const ra = list.find((r) => r.id === id);
    if (!ra) return;
    document.getElementById('raModalTitle').textContent = ra.title;
    document.getElementById('raModalBody').innerHTML = raEditFormHtml(ra);
    document.getElementById('raDownloadLink').href = kind === 'custom'
      ? `/api/risk-assessments/custom/${ra.id}/download`
      : `/api/risk-assessments/${ra.id}/download`;
    updateRaEditBadges();
    ['raEditCurrentL', 'raEditCurrentC', 'raEditAdditionalL', 'raEditAdditionalC'].forEach((elId) => {
      document.getElementById(elId).addEventListener('input', updateRaEditBadges);
    });
    document.getElementById('raSaveAsBtn').addEventListener('click', async () => {
      const fields = readRaEditForm();
      const name = document.getElementById('raSaveAsName').value.trim();
      if (!name) { alert('Give the new risk assessment a name.'); return; }
      if (!fields.currentControls.length) { alert('Add at least one current risk control.'); return; }
      try {
        const saved = await api('/api/risk-assessments/custom', {
          method: 'POST',
          body: JSON.stringify({ ...fields, title: name, basedOn: `${kind}:${ra.id}` }),
        });
        state.raCustom = await api('/api/risk-assessments/custom');
        renderRiskAssessments();
        alert('Saved — you\'ll find it in the Risk Assessments list.');
        openRaModal('custom', saved.id);
      } catch (err) {
        alert(err.message);
      }
    });
  }

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
  const kindPrefix = currentRaKind === 'generic' ? '' : `${currentRaKind}/`;
  const endpoint = `/api/jobs/${jobId}/risk-assessments/${kindPrefix}${currentRaId}/attach`;
  try {
    await api(endpoint, { method: 'POST' });
    alert('Attached — you\'ll find it in that job\'s RAMS documents.');
    closeRaModal();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- Reports ----------

async function loadReports() {
  document.getElementById('reportsHeading').textContent = isAdmin() ? 'Yearly Reports' : 'My Yearly Report';
  const container = document.getElementById('reportsContainer');

  if (!isAdmin()) {
    renderOwnYearlyReport(container, await api('/api/reports/yearly'));
    return;
  }

  const [years, monthly] = await Promise.all([api('/api/reports/yearly'), api('/api/reports/monthly')]);

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

// Non-admins only ever see their own figures per year - no company totals, no other
// employees' numbers, no monthly trend (that's company-wide, so admin-only too).
function renderOwnYearlyReport(container, years) {
  if (!state.currentUser.employeeId) {
    container.innerHTML = '<p class="empty-state">Your account isn\'t linked to an employee yet — ask an admin to check your name matches an entry on the Employees tab.</p>';
    return;
  }
  if (!years.length) {
    container.innerHTML = '<p class="empty-state">No jobs recorded against your name yet.</p>';
    return;
  }
  container.innerHTML = years.map((y) => `
    <div class="report-year">
      <h3>${y.year}</h3>
      <div class="report-summary">
        <div class="stat"><div class="label">Your Value Won</div><div class="value">${money(y.own.totalValue)}</div></div>
        <div class="stat"><div class="label">Your Profit</div><div class="value green">${money(y.own.totalProfit)}</div></div>
        <div class="stat"><div class="label">Your Jobs Won</div><div class="value">${y.own.jobCount}</div></div>
      </div>
    </div>
  `).join('');
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
      <td>
        <select class="admin-employee-select" data-user="${u.id}">
          <option value="">— Not linked —</option>
          ${state.employees.map((e) => `<option value="${e.id}" ${u.employeeId === e.id ? 'selected' : ''}>${escapeHtml(e.name)}</option>`).join('')}
        </select>
      </td>
      <td>${u.role === 'admin'
        ? '<span class="hint">Admin</span>'
        : `<button type="button" data-toggle-quoting="${u.id}" data-name="${escapeHtml(u.name)}" data-on="${u.canManageQuotes}">${u.canManageQuotes ? 'Revoke Quoting' : 'Grant Quoting'}</button>`}</td>
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

  tbody.querySelectorAll('[data-toggle-quoting]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const grant = btn.dataset.on !== 'true';
      try {
        await api(`/api/users/${btn.dataset.toggleQuoting}/quoting`, {
          method: 'PUT',
          body: JSON.stringify({ canManageQuotes: grant }),
        });
        loadAdminUsers();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  tbody.querySelectorAll('.admin-employee-select').forEach((select) => {
    select.addEventListener('change', async () => {
      try {
        await api(`/api/users/${select.dataset.user}/employee`, {
          method: 'PUT',
          body: JSON.stringify({ employeeId: select.value || null }),
        });
        state.employees = await api('/api/employees');
        renderEmployees();
      } catch (err) {
        alert(err.message);
        loadAdminUsers();
      }
    });
  });
}

checkAuth();
