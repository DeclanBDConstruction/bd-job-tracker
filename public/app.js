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
  vehicleHires: [],
  assets: [],
  signage: [],
  diaryEntries: [],
  jobAssignments: [],
  myAssignments: [],
  allAssignments: [],
  operativeUsers: [],
  currentUser: null,
  minigameDate: null,
  minigameDaily: [],
  minigameAllTime: [],
  minigameMyBest: null,
  myQualifications: [],
};

const OPERATIVE_ROLES = ['installation_operative', 'manufacturing_operative'];
const isAdmin = () => !!(state.currentUser && state.currentUser.role === 'admin');
const isOperative = () => !!(state.currentUser && OPERATIVE_ROLES.includes(state.currentUser.role));
const isStaff = () => !!(state.currentUser && state.currentUser.role === 'staff');
const isSurveyor = () => !!(state.currentUser && state.currentUser.role === 'surveyor');
const isStocksManager = () => !!(state.currentUser && state.currentUser.role === 'stocks_manager');
const canManageQuotes = () => !!(state.currentUser && (state.currentUser.role === 'admin' || state.currentUser.canManageQuotes));

const money = (n) => '£' + (Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const slug = (s) => String(s || '').toLowerCase().replace(/\s+/g, '-');
const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : (s || ''));

// Non-blocking replacement for alert() - errors and success confirmations both surface here
// instead of a blocking browser popup, colour-coded so the two are never confused. Falls back
// to alert() if the container isn't in the DOM for some reason, so a call site is never
// silently swallowed. Dismisses itself, or on click.
function toast(message, type = 'error') {
  const container = document.getElementById('toastContainer');
  if (!container) { alert(message); return; }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  el.addEventListener('click', () => dismissToast(el));
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast-in'));
  setTimeout(() => dismissToast(el), type === 'success' ? 3500 : 6000);
}

function dismissToast(el) {
  if (!el.isConnected || !el.classList.contains('toast-in')) return;
  el.classList.remove('toast-in');
  el.addEventListener('transitionend', () => el.remove(), { once: true });
}

// Auth forms use novalidate so an empty/invalid field surfaces through the app's own
// .auth-error box instead of the browser's native validation bubble (mismatched styling).
function checkFormValidity(form, errorEl) {
  if (form.checkValidity()) return true;
  const invalidField = form.querySelector(':invalid');
  errorEl.textContent = invalidField ? invalidField.validationMessage : 'Please fill in all fields.';
  errorEl.hidden = false;
  return false;
}

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
    // An admin reset this person's 2FA (lost phone, etc.) while they still had an open
    // session elsewhere - route them into the forced setup screen instead of just toasting
    // an error on whatever request happened to be the first to notice.
    if (body.mfaSetupRequired) {
      const me = await fetch('/api/auth/me').then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (me) showMfaSetupRequired(me);
    }
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
  hideSplash();
}

// Removes the splash screen once the real bootstrap data load finishes, with a small floor
// so it doesn't just flash on a fast connection - see the .splash-hide CSS class this
// triggers, which replaces the old fixed-timer animation.
const SPLASH_MIN_DISPLAY_MS = 400;
function hideSplash() {
  const splash = document.getElementById('splash');
  if (splash) splash.classList.add('splash-hide');
}

function avatarInitials(name) {
  return (name || '').trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

// Shared by the topbar avatar, the Team directory, and the profile view/edit cards - shows the
// uploaded photo (proxied through the authenticated /api/users/:id/photo route, never a public
// URL) when one exists, falling back to initials otherwise. Also applies that person's chosen
// avatar border (see PROFILE_BORDER_STYLES in db.js) - purely cosmetic, follows them wherever
// their avatar shows up.
function renderAvatar(el, { id, name, hasPhoto, profileBorder }) {
  if (!el) return;
  if (hasPhoto && id) {
    el.textContent = '';
    el.innerHTML = `<img src="/api/users/${id}/photo" alt="${escapeHtml(name || '')}">`;
  } else {
    el.innerHTML = '';
    el.textContent = avatarInitials(name);
  }
  el.className = el.className.replace(/\bavatar-border-\S+/g, '').trim();
  if (profileBorder && profileBorder !== 'none') el.classList.add(`avatar-border-${profileBorder}`);
}

// Applies a person's chosen profile-card background theme (see PROFILE_BACKGROUND_THEMES in
// db.js) to the card wrapping their photo/name on My Profile and the read-only profile view -
// same "follows them around" cosmetic as the avatar border, just scoped to their own card.
function applyProfileBackground(el, profileBackground) {
  if (!el) return;
  el.classList.remove('profile-card-themed');
  el.className = el.className.replace(/\bprofile-bg-\S+/g, '').trim();
  if (profileBackground && profileBackground !== 'none') {
    el.classList.add('profile-card-themed', `profile-bg-${profileBackground}`);
  }
}

async function showApp(user) {
  state.currentUser = user;
  document.getElementById('authScreen').hidden = true;
  document.getElementById('appShell').hidden = false;
  document.getElementById('currentUserName').textContent = user.name;
  renderAvatar(document.getElementById('userAvatar'), user);
  // Play the header's little pop-in now, exactly when it actually becomes visible — could be
  // right after the splash (already signed in) or well after it (just signed in manually).
  document.querySelector('.topbar h1 .logo-mark').classList.add('animate-in');
  document.querySelector('.topbar h1 .brand-sub').classList.add('animate-in');

  document.getElementById('adminTabBtn').hidden = !isAdmin();
  document.getElementById('logsTabBtn').hidden = !isAdmin();
  document.getElementById('cadTabBtn').hidden = !(isAdmin() || isSurveyor());
  document.getElementById('clientsTabBtn').hidden = !isAdmin();
  document.getElementById('hireTabBtn').hidden = !isAdmin();
  document.getElementById('vehicleHireTabBtn').hidden = !isAdmin();
  document.getElementById('assetsTabBtn').hidden = !(isAdmin() || isStocksManager());
  document.getElementById('quotingAddRow').hidden = !canManageQuotes();
  // Admins/surveyors sometimes go on the tools themselves (assigned via the Jobs tab's
  // "Assign the Team" checklist same as anyone else) - they need the same self-service
  // Assignments tab an operative gets so they can actually clock in on their own assignment.
  // Staff and stocks managers have no route to ever be assigned a job, so they're excluded.
  document.getElementById('assignmentsTabBtn').hidden = isStaff() || isStocksManager();

  // Staff and operatives both only get Home, My Calendar and My Diary - everything else
  // (Jobs, Team, Operations, Reports, and the shared team Calendar) is hidden here for UI
  // purposes, but the real enforcement is server-side (see the allowlists in server.js).
  // Stocks managers are restricted the same way, except they keep the Operations dropdown
  // open specifically for Assets - every other button inside it is individually hidden below.
  const restricted = isStaff() || isOperative() || isStocksManager();
  document.getElementById('jobsTabGroup').hidden = restricted;
  document.getElementById('employeesTabBtn').hidden = restricted;
  document.getElementById('operationsTabGroup').hidden = restricted && !isStocksManager();
  document.getElementById('reportsTabGroup').hidden = restricted;
  document.getElementById('calendarTabBtn').hidden = restricted;
  document.getElementById('headerSearchWrap').hidden = restricted;
  ['labour', 'subbies', 'quoting', 'signage', 'pricelist'].forEach((tab) => {
    document.querySelector(`.tab-btn[data-tab="${tab}"]`).hidden = isStocksManager();
  });

  const bootstrapPromise = isStaff() ? bootstrapStaff() : isOperative() ? bootstrapOperative() : isStocksManager() ? bootstrapStocksManager() : bootstrap();
  connectLiveUpdates();
  const minDisplay = new Promise((resolve) => setTimeout(resolve, SPLASH_MIN_DISPLAY_MS));
  try {
    await Promise.all([bootstrapPromise, minDisplay]);
  } finally {
    hideSplash();
  }
}

// ---------- Live updates ----------
// The server pushes a tiny "type X changed" ping over SSE whenever anyone saves something;
// we just re-fetch that slice of data through the normal API and re-render in place, so
// everyone's screen stays current without needing to hit refresh.

let liveEvents = null;
let activityLogLiveRefreshTimer = null;

function activeTab() {
  const btn = document.querySelector('.tab-btn.active');
  return btn ? btn.dataset.tab : null;
}

function connectLiveUpdates() {
  if (liveEvents) return;
  liveEvents = new EventSource('/api/events');
  liveEvents.onmessage = (e) => {
    const { type } = JSON.parse(e.data);
    // Staff/operatives only load a narrow slice of data (see bootstrapStaff/
    // bootstrapOperative), so ignore pings for everything else rather than firing
    // requests the server will 403.
    if (isStaff() && !['calendar', 'diary', 'users'].includes(type)) return;
    if (isOperative() && !['calendar', 'diary', 'users', 'jobAssignments'].includes(type)) return;
    if (isStocksManager() && !['calendar', 'diary', 'users', 'assets', 'jobs'].includes(type)) return;
    // Virtually every mutation already broadcasts some type - piggyback on all of them to
    // refresh the Logs tab live if it's open, rather than adding a dedicated broadcast call
    // at every one of the ~50 activity-logging call sites in server.js. Only while still on
    // the first page though - resetting mid "Load more" would yank an admin back to the top
    // every time anyone else in the app does anything.
    if (activeTab() === 'logs' && activityLogState.offset <= ACTIVITY_LOG_PAGE_SIZE) {
      clearTimeout(activityLogLiveRefreshTimer);
      activityLogLiveRefreshTimer = setTimeout(() => loadActivityLog({ reset: true }), 400);
    }
    if (type === 'jobs') handleLiveJobsChange();
    else if (type === 'employees') handleLiveEmployeesChange();
    else if (type === 'calendar') handleLiveCalendarChange();
    else if (type === 'users') handleLiveUsersChange();
    else if (type === 'priceList') handleLivePriceListChange();
    else if (type === 'subbies') handleLiveSubbiesChange();
    else if (type === 'quotes') handleLiveQuotesChange();
    else if (type === 'hires') handleLiveHiresChange();
    else if (type === 'vehicleHires') handleLiveVehicleHiresChange();
    else if (type === 'signage') handleLiveSignageChange();
    else if (type === 'diary') handleLiveDiaryChange();
    else if (type === 'minigame') handleLiveMinigameChange();
    else if (type === 'jobAssignments') handleLiveJobAssignmentsChange();
    else if (type === 'assets') handleLiveAssetsChange();
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
  renderHomeDashboard();
}

async function handleLiveHiresChange() {
  if (activeTab() === 'hire') loadHires();
}

async function handleLiveVehicleHiresChange() {
  if (activeTab() === 'vehiclehire') loadVehicleHires();
}

async function handleLiveAssetsChange() {
  if (activeTab() === 'assets') loadAssets();
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

async function handleLiveJobAssignmentsChange() {
  if (isOperative()) {
    state.myAssignments = await api('/api/job-assignments/mine');
    renderCalendar();
    renderHomeDashboard();
    renderMyAssignmentsTab();
    if (currentAssignmentId && !document.getElementById('assignmentDetailModal').hidden) {
      await refreshAssignmentTimeLog();
      await refreshAssignmentRams();
    }
    return;
  }
  // Admin/surveyor: keep their own "Your Assignment" card/Assignments tab live too (they
  // can be assigned a job the same as anyone else), on top of the existing Job Detail refresh.
  // Also refresh the full assignment list so the "Jobs Missing a Permit to Work" dashboard
  // card (jobsMissingPermit) doesn't go stale when someone elsewhere gets assigned/clocks off.
  const [mine, all] = await Promise.all([api('/api/job-assignments/mine'), api('/api/job-assignments')]);
  state.myAssignments = mine;
  state.allAssignments = all;
  renderHomeDashboard();
  renderMyAssignmentsTab();
  if (currentAssignmentId && !document.getElementById('assignmentDetailModal').hidden) {
    await refreshAssignmentTimeLog();
    await refreshAssignmentRams();
  }
  if (currentDetailJobId && !jobDetailModal.hidden) {
    refreshJobDetail();
    if (currentTimeLogAssignmentId && !document.getElementById('timeLogModal').hidden) refreshTimeLogModal();
  }
}

async function handleLiveJobsChange() {
  state.jobs = await api('/api/jobs');
  renderJobs();
  renderCompletedJobs();
  renderEmployees();
  renderHomeDashboard();
  renderSignage();
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
  if (!document.getElementById('myProfileModal').hidden) openMyProfileModal();
}

async function checkAuth() {
  const res = await fetch('/api/auth/me');
  if (res.ok) {
    handleAuthenticated(await res.json());
  } else {
    showAuthScreen();
  }
}

// Routes a freshly-authenticated user (register/login/mfa-verify-login all end up here)
// either into the real app, or - since 2FA is mandatory for every account - into the forced
// setup screen first if they haven't completed it yet. Also the fallback the api() helper
// below reaches for when some other request 403s for the same reason.
function handleAuthenticated(user) {
  if (user.mfaEnabled) {
    showApp(user);
  } else {
    showMfaSetupRequired(user);
  }
}

async function showMfaSetupRequired(user) {
  state.currentUser = user;
  document.getElementById('appShell').hidden = true;
  document.getElementById('authScreen').hidden = false;
  document.getElementById('loginView').hidden = true;
  document.getElementById('registerView').hidden = true;
  document.getElementById('mfaView').hidden = true;
  document.getElementById('mfaSetupView').hidden = false;
  hideSplash();
  const errorEl = document.getElementById('mfaSetupConfirmError');
  errorEl.hidden = true;
  document.getElementById('mfaSetupConfirmForm').reset();
  try {
    const res = await fetch('/api/auth/mfa/setup', { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Could not start two-factor setup');
    }
    const { qrDataUrl, secret } = await res.json();
    document.getElementById('mfaSetupQrImage').src = qrDataUrl;
    document.getElementById('mfaSetupManualSecret').textContent = secret;
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
}

document.getElementById('mfaSetupConfirmForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const errorEl = document.getElementById('mfaSetupConfirmError');
  errorEl.hidden = true;
  if (!checkFormValidity(form, errorEl)) return;
  try {
    const res = await fetch('/api/auth/mfa/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: document.getElementById('mfaSetupConfirmCode').value }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Verification failed');
    }
    const user = await res.json();
    document.getElementById('mfaSetupConfirmForm').reset();
    document.getElementById('mfaSetupView').hidden = true;
    showApp(user);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

document.getElementById('mfaSetupSignOutBtn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  document.getElementById('mfaSetupView').hidden = true;
  document.getElementById('loginView').hidden = false;
  showAuthScreen();
});

document.getElementById('showRegisterBtn').addEventListener('click', () => {
  document.getElementById('loginView').hidden = true;
  document.getElementById('registerView').hidden = false;
});

document.getElementById('showLoginBtn').addEventListener('click', () => {
  document.getElementById('registerView').hidden = true;
  document.getElementById('loginView').hidden = false;
});

let pendingMfaToken = null;

function showMfaView() {
  document.getElementById('loginView').hidden = true;
  document.getElementById('registerView').hidden = true;
  document.getElementById('mfaView').hidden = false;
  document.getElementById('mfaLoginCode').focus();
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const errorEl = document.getElementById('loginError');
  errorEl.hidden = true;
  if (!checkFormValidity(form, errorEl)) return;
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
    const body = await res.json();
    if (body.mfaRequired) {
      pendingMfaToken = body.mfaToken;
      document.getElementById('mfaLoginForm').reset();
      showMfaView();
      return;
    }
    document.getElementById('loginForm').reset();
    handleAuthenticated(body);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

document.getElementById('mfaLoginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const errorEl = document.getElementById('mfaLoginError');
  errorEl.hidden = true;
  if (!checkFormValidity(form, errorEl)) return;
  try {
    const res = await fetch('/api/auth/mfa/verify-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mfaToken: pendingMfaToken,
        code: document.getElementById('mfaLoginCode').value,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Verification failed');
    }
    const user = await res.json();
    pendingMfaToken = null;
    document.getElementById('mfaLoginForm').reset();
    document.getElementById('mfaView').hidden = true;
    handleAuthenticated(user);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

document.getElementById('mfaBackToLoginBtn').addEventListener('click', () => {
  pendingMfaToken = null;
  document.getElementById('mfaLoginForm').reset();
  document.getElementById('mfaView').hidden = true;
  document.getElementById('loginView').hidden = false;
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const errorEl = document.getElementById('registerError');
  errorEl.hidden = true;
  if (!checkFormValidity(form, errorEl)) return;
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('registerName').value,
        email: document.getElementById('registerEmail').value,
        password: document.getElementById('registerPassword').value,
        accessCode: document.getElementById('registerAccessCode').value,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Could not create account');
    }
    const user = await res.json();
    document.getElementById('registerForm').reset();
    handleAuthenticated(user);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  document.getElementById('loginForm').reset();
  document.getElementById('registerView').hidden = true;
  document.getElementById('mfaView').hidden = true;
  document.getElementById('loginView').hidden = false;
  showAuthScreen();
});

// ---------- Two-factor auth (self-service) ----------

// 2FA is mandatory and can't be turned off from inside the app - a stolen password alone
// shouldn't be enough to swap out someone's second factor, which is exactly what a
// password-only self-service "disable" would let an attacker do. The only way to reset it is
// an admin doing it from the Admin tab (adminResetMfa in db.js), which drops the account back
// into the forced setup screen next time they sign in. This modal is read-only status.
document.getElementById('mfaSettingsBtn').addEventListener('click', () => {
  document.getElementById('mfaModal').hidden = false;
});

document.getElementById('mfaModalCloseBtn').addEventListener('click', () => {
  document.getElementById('mfaModal').hidden = true;
});

// ---------- Tabs ----------

function closeTabGroups() {
  document.querySelectorAll('.tab-group.open').forEach((g) => {
    g.classList.remove('open');
    const menu = g.querySelector('.tab-group-menu');
    menu.style.position = '';
    menu.style.top = '';
    menu.style.left = '';
  });
}

// On phones the tab bar scrolls horizontally instead of wrapping (see the 720px media
// query in style.css), which means it has to clip vertical overflow too - a dropdown
// menu opening below it would otherwise get cut off and look like it did nothing. So
// on narrow screens we switch the menu to viewport-fixed positioning, computed from
// the button's on-screen location, which escapes that clipping entirely.
function positionTabGroupMenu(group) {
  const menu = group.querySelector('.tab-group-menu');
  if (window.innerWidth > 720) return;
  const rect = group.querySelector('.tab-group-btn').getBoundingClientRect();
  const menuWidth = Math.max(menu.offsetWidth, 180);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
  menu.style.position = 'fixed';
  menu.style.top = (rect.bottom + 6) + 'px';
  menu.style.left = left + 'px';
}

// A quick "Loading…" placeholder for tabs that fetch on demand, so switching to one on a
// slow connection shows something immediately instead of sitting blank until the request
// resolves - the real render function (loadReports etc.) overwrites this once data arrives.
function showTabLoading(selector, colspan) {
  const el = document.querySelector(selector);
  if (!el) return;
  el.innerHTML = colspan
    ? `<tr><td colspan="${colspan}" class="empty-state">Loading…</td></tr>`
    : `<p class="empty-state">Loading…</p>`;
}

function goToTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-group-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
  btn.classList.add('active');
  const group = btn.closest('.tab-group');
  if (group) group.querySelector('.tab-group-btn').classList.add('active');
  document.getElementById('tab-' + tab).classList.add('active');
  closeTabGroups();
  if (tab === 'reports') { showTabLoading('#reportsContainer'); loadReports(); }
  if (tab === 'clients') { showTabLoading('#clientsContainer'); loadClients(); }
  if (tab === 'home') renderHomeDashboard();
  if (tab === 'admin') loadAdminUsers();
  if (tab === 'logs') { showTabLoading('#activityLogTable tbody', 3); loadActivityLog({ reset: true }); }
  if (tab === 'hire') { showTabLoading('#hiresTable tbody', 9); loadHires(); }
  if (tab === 'vehiclehire') { showTabLoading('#vehicleHiresTable tbody', 8); loadVehicleHires(); }
  if (tab === 'assets') { showTabLoading('#assetsTable tbody', 8); loadAssets(); }
  if (tab === 'quoting') loadQuotes();
  if (tab === 'assignments') renderMyAssignmentsTab();
  if (tab === 'diary') {
    setDiaryViewDate(todayDateStr());
    loadDiary();
  }
  if (tab === 'minigame') loadMinigame();
  if (tab === 'cad') {
    document.getElementById('cadGridEmpty').hidden = true;
    showTabLoading('#cadGrid');
    loadCadDrawings();
  }
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => goToTab(btn.dataset.tab));
});

document.querySelectorAll('.tab-group-btn').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const group = btn.closest('.tab-group');
    const wasOpen = group.classList.contains('open');
    closeTabGroups();
    if (!wasOpen) {
      group.classList.add('open');
      positionTabGroupMenu(group);
    }
  });
});

document.addEventListener('click', () => closeTabGroups());

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
  const [jobs, employees, statuses, riskAssessmentsList, raLibrary, raCustom, calendarEvents, priceListItems, subbies, myAssignments, allAssignments] = await Promise.all([
    api('/api/jobs'),
    api('/api/employees'),
    api('/api/statuses'),
    api('/api/risk-assessments'),
    api('/api/risk-assessments/library'),
    api('/api/risk-assessments/custom'),
    api('/api/calendar'),
    api('/api/price-list'),
    api('/api/subbies'),
    api('/api/job-assignments/mine'), // admin/surveyor can be assigned to a job too (see the Jobs tab's "Assign the Team" checklist) - this is how they see it and clock in on it themselves
    api('/api/job-assignments'), // every assignment across every job - used for the Home dashboard's "missing a permit" flag (see jobsMissingPermit)
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
  state.myAssignments = myAssignments;
  state.allAssignments = allAssignments;
  // Needed for the Job form's "Assign the Team" checklist and the Job Detail Team tab's
  // "+ Assign" row - GET /api/users is admin-only, so surveyors don't get this (fine, since
  // assigning is admin-only too - surveyors only ever view assignments read-only).
  if (isAdmin()) state.operativeUsers = await api('/api/users');
  renderStatusOptions();
  renderEmployeeOptions();
  // Admins and surveyors land on Jobs pre-filtered to their own won jobs, not the whole
  // company's - they can still switch the same dropdown to someone else or back to "All
  // employees". Only applies once on load so it doesn't fight a later filter choice on every
  // re-render (see handleLiveJobsChange etc., which call renderJobs() directly, not this).
  if (isSurveyor() || isAdmin()) {
    const mine = state.employees.find((e) => e.id === state.currentUser.employeeId);
    if (mine) document.getElementById('jobEmployeeFilter').value = mine.name;
  }
  renderJobs();
  renderCompletedJobs();
  renderEmployees();
  renderRiskAssessments();
  renderCalendar();
  renderPriceLists();
  renderSubbies();
  renderHomeDashboard();
  renderMyAssignmentsTab();

  // Split from the Promise.all above: the `signage` table only exists once the Supabase
  // migration has been run. Isolating it means a not-yet-migrated database degrades to
  // "tracker empty" instead of the whole app failing to load.
  try {
    state.signage = await api('/api/signage');
    renderSignage();
  } catch (err) {
    console.error('Signage tracker unavailable — has scripts/supabase-schema.sql been run?', err);
  }

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

// Staff only see Home, My Calendar and My Diary, so this loads just the calendar/diary
// slice instead of the full bootstrap() - the other endpoints are 403'd for staff anyway
// (see server.js), and calling them here would break Promise.all for the whole batch.
async function bootstrapStaff() {
  state.calendarEvents = await api('/api/calendar');
  renderCalendar();
  renderHomeDashboard();

  try {
    const [calendarColors, userColors] = await Promise.all([api('/api/calendar-colors'), api('/api/users/colors')]);
    state.calendarColors = calendarColors;
    state.userColors = userColors;
    renderCalendar();
    renderColorPicker();
  } catch (err) {
    console.warn('Calendar colours unavailable (database may need the colour migration run):', err.message);
    const container = document.getElementById('calColorPicker');
    if (container) container.innerHTML = `<span class="color-picker-error">Couldn't load colours: ${escapeHtml(err.message)}</span>`;
  }
}

// Operatives get Home, My Calendar and My Diary, plus their own job assignments (merged
// into My Calendar and surfaced on Home) - a trimmed bootstrap like bootstrapStaff, since
// everything else 403s for this role (see the operative allowlist in server.js).
async function bootstrapOperative() {
  const [calendarEvents, myAssignments, riskAssessmentsList] = await Promise.all([
    api('/api/calendar'),
    api('/api/job-assignments/mine'),
    api('/api/risk-assessments'),
  ]);
  state.calendarEvents = calendarEvents;
  state.myAssignments = myAssignments;
  state.riskAssessments = riskAssessmentsList;
  renderCalendar();
  renderHomeDashboard();
  renderMyAssignmentsTab();

  try {
    const [calendarColors, userColors] = await Promise.all([api('/api/calendar-colors'), api('/api/users/colors')]);
    state.calendarColors = calendarColors;
    state.userColors = userColors;
    renderCalendar();
    renderColorPicker();
  } catch (err) {
    console.warn('Calendar colours unavailable (database may need the colour migration run):', err.message);
    const container = document.getElementById('calColorPicker');
    if (container) container.innerHTML = `<span class="color-picker-error">Couldn't load colours: ${escapeHtml(err.message)}</span>`;
  }
}

// Stocks managers get Home, My Calendar and My Diary (like staff), plus the Assets tab -
// a trimmed bootstrap like bootstrapStaff, since everything else 403s for this role (see
// STOCKS_MANAGER_ALLOWED_ROUTES in server.js). Jobs/users are fetched read-only, just to
// populate the check-out form's job/holder pickers on the Scan screen.
async function bootstrapStocksManager() {
  const [calendarEvents, assets, jobs, operativeUsers] = await Promise.all([
    api('/api/calendar'),
    api('/api/assets'),
    api('/api/jobs'),
    api('/api/users'),
  ]);
  state.calendarEvents = calendarEvents;
  state.assets = assets;
  state.jobs = jobs;
  state.operativeUsers = operativeUsers;
  renderCalendar();
  renderHomeDashboard();
  renderAssets();

  try {
    const [calendarColors, userColors] = await Promise.all([api('/api/calendar-colors'), api('/api/users/colors')]);
    state.calendarColors = calendarColors;
    state.userColors = userColors;
    renderCalendar();
    renderColorPicker();
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
  // The Jobs tab's "Employee" column is who won the job, so only admins/surveyors are
  // ever meaningful here - operatives (and unlinked names) are left off the filter.
  state.employees.filter((e) => e.role === 'admin' || e.role === 'surveyor').forEach((e) => {
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

// Click-to-sort on the Jobs table header (see #jobsTableHead in index.html) - defaults to
// the same "most recently won first" order the API already returns, so sorting is purely
// additive until someone actually clicks a column.
let jobsSortKey = null;
let jobsSortDir = 'asc';

function sortJobs(list) {
  if (!jobsSortKey) return list;
  const numeric = jobsSortKey === 'value' || jobsSortKey === 'profit';
  const dir = jobsSortDir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    const av = a[jobsSortKey];
    const bv = b[jobsSortKey];
    if (numeric) return ((Number(av) || 0) - (Number(bv) || 0)) * dir;
    return String(av || '').localeCompare(String(bv || '')) * dir;
  });
}

function renderJobs() {
  const search = document.getElementById('jobSearch').value.trim().toLowerCase();
  const statusFilter = document.getElementById('jobStatusFilter').value;
  const progressFilter = document.getElementById('jobProgressFilter').value;
  const employeeFilter = document.getElementById('jobEmployeeFilter').value;

  // Completed jobs move off to their own tab, so they never clutter the main list.
  const filtered = sortJobs(state.jobs.filter((j) => {
    if (j.completedAt) return false;
    if (statusFilter && j.status !== statusFilter) return false;
    if (progressFilter && j.progress !== progressFilter) return false;
    if (employeeFilter && j.employeeName !== employeeFilter) return false;
    if (search) {
      const haystack = `${j.client} ${j.location || ''} ${j.jobReference || ''} ${j.description || ''}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  }));

  document.querySelectorAll('#jobsTableHead .sortable-th').forEach((th) => {
    th.classList.toggle('sort-asc', th.dataset.sort === jobsSortKey && jobsSortDir === 'asc');
    th.classList.toggle('sort-desc', th.dataset.sort === jobsSortKey && jobsSortDir === 'desc');
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

document.querySelectorAll('#jobsTableHead .sortable-th').forEach((th) => {
  th.addEventListener('click', () => {
    if (jobsSortKey === th.dataset.sort) {
      jobsSortDir = jobsSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      jobsSortKey = th.dataset.sort;
      jobsSortDir = 'asc';
    }
    renderJobs();
  });
});

async function completeJob(id) {
  if (!confirm('Mark this job as completed? It will move to the Completed Jobs tab — you can reopen it from there if needed.')) return;
  try {
    await api(`/api/jobs/${id}/complete`, { method: 'POST' });
  } catch (err) {
    toast(err.message, 'error');
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
    toast(err.message, 'error');
  } finally {
    e.target.value = '';
  }
});
document.getElementById('jobCancelBtn').addEventListener('click', closeJobModal);

// Checkbox per employee for the Job form's "Assign the Team" block. Already-assigned lads
// (edit mode only) come in checked+disabled so this form can only ever add assignments, never
// silently remove one via an unticked box - removal happens deliberately from the job's Team tab.
function renderAssignTeamChecklist(existingAssignments) {
  const assignedUserIds = new Set((existingAssignments || []).map((a) => a.userId));
  document.getElementById('fAssignTeamChecklist').innerHTML = state.operativeUsers.map((u) => `
    <label class="assign-team-checkbox-item">
      <input type="checkbox" value="${u.id}" ${assignedUserIds.has(u.id) ? 'checked disabled' : ''}>
      ${escapeHtml(u.name)}
    </label>`).join('');
  document.getElementById('fAssignTeamExistingNote').hidden = !assignedUserIds.size;
}

async function loadAssignTeamChecklist(id) {
  const existing = id ? await api(`/api/jobs/${id}/time-logs`).catch(() => []) : [];
  renderAssignTeamChecklist(existing);
}

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

  document.getElementById('fAssignTeamSection').hidden = !isAdmin();
  document.getElementById('fAssignTask').value = '';
  document.getElementById('fAssignStartDate').value = '';
  document.getElementById('fAssignDuration').value = '1';
  document.getElementById('fAssignTeamChecklist').innerHTML = '';
  document.getElementById('fAssignTeamExistingNote').hidden = true;
  if (isAdmin()) loadAssignTeamChecklist(id);

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

  // Newly-ticked (not already-assigned/disabled) lads to assign once the job itself is saved.
  const newlyCheckedTeam = isAdmin()
    ? [...document.querySelectorAll('#fAssignTeamChecklist input[type="checkbox"]:checked:not(:disabled)')]
    : [];
  const assignTask = document.getElementById('fAssignTask').value.trim();
  const assignStartDate = document.getElementById('fAssignStartDate').value;
  const assignDuration = document.getElementById('fAssignDuration').value || 1;
  if (newlyCheckedTeam.length && (!assignTask || !assignStartDate)) {
    toast('Fill in a Task and Start Date to assign the team, or untick everyone under Assign the Team.', 'error');
    return;
  }

  try {
    let jobId = id;
    if (id) {
      await api(`/api/jobs/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      const created = await api('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
      jobId = created.id;
    }
    if (newlyCheckedTeam.length) {
      // allSettled rather than all - one person having a holiday conflict shouldn't stop the
      // rest of the ticked team from being assigned; collect every failure and report them
      // together instead of just whichever one happened to reject first.
      const results = await Promise.allSettled(newlyCheckedTeam.map((cb) => api('/api/job-assignments', {
        method: 'POST',
        body: JSON.stringify({
          jobId,
          userId: cb.value,
          task: assignTask,
          startDate: assignStartDate,
          durationDays: assignDuration,
        }),
      })));
      const failures = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
      if (failures.length) throw new Error(failures.join('\n'));
    }
    const [jobs, employees] = await Promise.all([api('/api/jobs'), api('/api/employees')]);
    state.jobs = jobs;
    state.employees = employees;
    renderEmployeeOptions();
    renderJobs();
    renderEmployees();
    closeJobModal();
    toast(id ? 'Job updated.' : 'Job created.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- Job Detail ----------

const DOCUMENT_SECTIONS = ['rams', 'drawings', 'photos', 'permit'];

const jobDetailModal = document.getElementById('jobDetailModal');
let currentDetailJobId = null;

async function openJobDetail(id, section) {
  currentDetailJobId = id;
  editingTeamAssignmentId = null;
  const target = section || 'info';
  document.querySelectorAll('.job-detail-tab').forEach((b) => b.classList.toggle('active', b.dataset.section === target));
  document.querySelectorAll('.job-detail-section').forEach((s) => s.classList.toggle('active', s.id === `jobDetailSection-${target}`));
  document.getElementById('jobDetailDownloadBtn').href = `/api/jobs/${id}/documents-zip`;
  jobDetailModal.hidden = false;
  try {
    await refreshJobDetail();
  } catch (err) {
    toast(err.message, 'error');
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
  // Scoped to just this job while its detail modal is open - see renderJobTeamSection.
  state.jobAssignments = await api(`/api/jobs/${currentDetailJobId}/time-logs`);
  renderJobTeamSection(state.jobAssignments);
  const costing = await api(`/api/jobs/${currentDetailJobId}/costing`);
  renderJobCostingSection(costing);
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
    if (!description) { toast('Enter a description.', 'error'); return; }
    if (value === '' || isNaN(Number(value))) { toast('Enter a valid value.', 'error'); return; }
    try {
      await api(`/api/jobs/${currentDetailJobId}/variations`, {
        method: 'POST',
        body: JSON.stringify({ description, value: Number(value) }),
      });
      await refreshJobDetail();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  container.querySelectorAll('.variation-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this variation? This cannot be undone.')) return;
      try {
        await api(`/api/jobs/${currentDetailJobId}/variations/${btn.dataset.variation}`, { method: 'DELETE' });
        await refreshJobDetail();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

function renderDocumentSection(category, docs) {
  const container = document.getElementById(`jobDetailSection-${category}`);
  // Superseded copies (a manual "this is an old version" flag - see doc-supersede-btn below)
  // sort to the bottom and stay visually de-emphasised rather than being hidden or deleted.
  const sorted = [...(docs || [])].sort((a, b) => (a.superseded === b.superseded ? 0 : a.superseded ? 1 : -1));
  const items = sorted.map((d) => `
    <li class="doc-list-item${d.superseded ? ' doc-superseded' : ''}">
      <a href="/api/jobs/${currentDetailJobId}/documents/${category}/${d.id}/file" target="_blank">${escapeHtml(d.originalName)}</a>
      <span class="doc-meta">${formatBytes(d.size)} · ${new Date(d.uploadedAt).toLocaleDateString('en-GB')}${d.superseded ? ' · Old version' : ''}</span>
      <button type="button" class="link-btn doc-supersede-btn" data-doc="${d.id}" data-superseded="${d.superseded}">${d.superseded ? 'Restore' : 'Mark as old version'}</button>
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
      toast(err.message, 'error');
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
        toast(err.message, 'error');
      }
    });
  });
  container.querySelectorAll('.doc-supersede-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/jobs/${currentDetailJobId}/documents/${category}/${btn.dataset.doc}/superseded`, {
          method: 'PUT',
          body: JSON.stringify({ superseded: btn.dataset.superseded !== 'true' }),
        });
        await refreshJobDetail();
      } catch (err) {
        toast(err.message, 'error');
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

let employeesSearchTerm = '';

function renderEmployees() {
  document.getElementById('employeeAddRow').hidden = !isAdmin();
  const term = employeesSearchTerm.trim().toLowerCase();
  const list = state.employees.filter((e) => !term || e.name.toLowerCase().includes(term));
  const tbody = document.querySelector('#employeesTable tbody');
  tbody.innerHTML = '';
  list.forEach((e) => {
    const jobCount = state.jobs.filter((j) => j.employeeId === e.id).length;
    const tr = document.createElement('tr');
    if (e.hasAccount) tr.classList.add('employee-linked');
    tr.innerHTML = `<td>${escapeHtml(e.name)} <span style="color:var(--muted)">(${jobCount} job${jobCount === 1 ? '' : 's'})</span>${e.hasAccount ? '<span class="linked-badge" title="An account has been created and linked to this employee">Account linked</span>' : ''}</td>
      <td class="row-actions">${e.userId ? `<button type="button" data-view-profile-emp="${e.userId}">View Profile</button>` : ''}${isAdmin() ? `<button data-del-emp="${e.id}" class="danger">Delete</button>` : ''}</td>`;
    tbody.appendChild(tr);
  });
  if (!list.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="2" class="empty-state">${term ? 'No employees match your search.' : 'No employees yet.'}</td>`;
    tbody.appendChild(tr);
  }
}

document.getElementById('employeesSearch').addEventListener('input', (e) => {
  employeesSearchTerm = e.target.value;
  renderEmployees();
});

document.getElementById('addEmployeeBtn').addEventListener('click', async () => {
  const input = document.getElementById('newEmployeeName');
  if (!input.value.trim()) return;
  try {
    await api('/api/employees', { method: 'POST', body: JSON.stringify({ name: input.value }) });
    input.value = '';
    state.employees = await api('/api/employees');
    renderEmployeeOptions();
    renderEmployees();
    toast('Employee added.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.querySelector('#employeesTable tbody').addEventListener('click', async (e) => {
  const viewProfileId = e.target.dataset.viewProfileEmp;
  if (viewProfileId) { openProfileModal(viewProfileId); return; }
  const id = e.target.dataset.delEmp;
  if (!id) return;
  if (!confirm('Delete this employee?')) return;
  try {
    await api(`/api/employees/${id}`, { method: 'DELETE' });
    state.employees = await api('/api/employees');
    renderEmployeeOptions();
    renderEmployees();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- Profile (photo + qualifications) ----------
// Pegged to `users` (login accounts), not the Employees tab's name-only sales-credit list -
// see teamAssignmentDisplayRow and renderEmployees for the same read-only view (openProfileModal)
// reused for "who's assigned to this job" / "who's this employee's linked account", which a
// future client portal will call too.

async function openMyProfileModal() {
  renderMyProfile();
  document.getElementById('myProfileModal').hidden = false;
  try {
    const profile = await api(`/api/users/${state.currentUser.id}/profile`);
    state.myQualifications = profile.qualifications;
    renderMyQualifications();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderMyProfile() {
  const user = state.currentUser;
  if (!user) return;
  renderAvatar(document.getElementById('myProfilePhoto'), user);
  applyProfileBackground(document.getElementById('myProfileCard'), user.profileBackground);
  document.getElementById('myProfileName').textContent = user.name;
  document.getElementById('myProfileRole').textContent = ROLE_LABELS[user.role] || user.role;
  document.getElementById('myProfilePhotoRemoveBtn').hidden = !user.hasPhoto;
  renderProfileStylePicker();
}

// Free-pick cosmetic swatches for the avatar border and profile card background - same
// swatch-button pattern as the calendar colour picker (renderColorPicker), just without the
// "taken by someone else" exclusivity, since everyone can pick the same one.
const PROFILE_BORDER_LABELS = {
  none: 'None', bronze: 'Bronze', silver: 'Silver', gold: 'Gold', blue: 'Blue', green: 'Green',
  purple: 'Purple', red: 'Red', diamond: 'Diamond', fire: 'Fire', ice: 'Ice', rainbow: 'Rainbow (holo)',
};
const PROFILE_BACKGROUND_LABELS = {
  none: 'None', ocean: 'Ocean', sunset: 'Sunset', forest: 'Forest', slate: 'Slate', berry: 'Berry',
  galaxy: 'Galaxy', goldfoil: 'Gold Foil', aurora: 'Aurora',
};

function renderProfileStylePicker() {
  const user = state.currentUser;
  if (!user) return;

  const borderContainer = document.getElementById('profileBorderPicker');
  borderContainer.innerHTML = Object.entries(PROFILE_BORDER_LABELS).map(([value, label]) => `
    <button type="button" class="profile-style-swatch-btn style-${value}${user.profileBorder === value ? ' selected' : ''}"
      data-border="${value}" title="${label}" aria-label="${label}">${value === 'none' ? '—' : ''}</button>
  `).join('');
  borderContainer.querySelectorAll('[data-border]').forEach((btn) => {
    btn.addEventListener('click', () => saveProfileStyle({ profileBorder: btn.dataset.border, profileBackground: user.profileBackground }));
  });

  const bgContainer = document.getElementById('profileBackgroundPicker');
  bgContainer.innerHTML = Object.entries(PROFILE_BACKGROUND_LABELS).map(([value, label]) => `
    <button type="button" class="profile-style-swatch-btn style-${value}${user.profileBackground === value ? ' selected' : ''}"
      data-background="${value}" title="${label}" aria-label="${label}">${value === 'none' ? '—' : ''}</button>
  `).join('');
  bgContainer.querySelectorAll('[data-background]').forEach((btn) => {
    btn.addEventListener('click', () => saveProfileStyle({ profileBorder: user.profileBorder, profileBackground: btn.dataset.background }));
  });
}

async function saveProfileStyle(body) {
  try {
    state.currentUser = await api('/api/users/me/profile-style', { method: 'PUT', body: JSON.stringify(body) });
    renderMyProfile();
    renderAvatar(document.getElementById('userAvatar'), state.currentUser);
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('myProfileBtn').addEventListener('click', () => openMyProfileModal());

document.getElementById('myProfileModalCloseBtn').addEventListener('click', () => {
  document.getElementById('myProfileModal').hidden = true;
});

function qualificationExpiryCell(q) {
  if (!q.expiryDate) return '<span class="hint">No expiry</span>';
  const pillClass = q.status === 'expired' ? 'overdue' : q.status === 'expiring-soon' ? 'due-soon' : 'returned';
  const label = q.status === 'expired' ? 'Expired' : q.status === 'expiring-soon' ? 'Expiring Soon' : 'Valid';
  return `<span class="hire-status ${pillClass}">${label}</span> <span class="doc-meta">${q.expiryDate}</span>`;
}

function renderMyQualifications() {
  const tbody = document.querySelector('#myQualificationsTable tbody');
  tbody.innerHTML = state.myQualifications.map((q) => `
    <tr>
      <td>${escapeHtml(q.name)}</td>
      <td>${qualificationExpiryCell(q)}</td>
      <td class="row-actions"><button type="button" data-del-qualification="${q.id}" class="danger">Delete</button></td>
    </tr>
  `).join('');
  document.getElementById('myQualificationsEmptyState').hidden = !!state.myQualifications.length;
}

document.getElementById('myProfilePhotoInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/users/me/photo', { method: 'POST', body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Upload failed');
    }
    state.currentUser.hasPhoto = true;
    renderMyProfile();
    renderAvatar(document.getElementById('userAvatar'), state.currentUser);
    toast('Photo updated.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    e.target.value = '';
  }
});

document.getElementById('myProfilePhotoRemoveBtn').addEventListener('click', async () => {
  try {
    await api('/api/users/me/photo', { method: 'DELETE' });
    state.currentUser.hasPhoto = false;
    renderMyProfile();
    renderAvatar(document.getElementById('userAvatar'), state.currentUser);
    toast('Photo removed.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('addQualificationBtn').addEventListener('click', async () => {
  const nameInput = document.getElementById('newQualificationName');
  const expiryInput = document.getElementById('newQualificationExpiry');
  if (!nameInput.value.trim()) return;
  try {
    await api('/api/users/me/qualifications', {
      method: 'POST',
      body: JSON.stringify({ name: nameInput.value, expiryDate: expiryInput.value || null }),
    });
    nameInput.value = '';
    expiryInput.value = '';
    state.myQualifications = await api(`/api/users/${state.currentUser.id}/profile`).then((p) => p.qualifications);
    renderMyQualifications();
    toast('Qualification added.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.querySelector('#myQualificationsTable tbody').addEventListener('click', async (e) => {
  const id = e.target.dataset.delQualification;
  if (!id) return;
  if (!confirm('Delete this qualification?')) return;
  try {
    await api(`/api/users/qualifications/${id}`, { method: 'DELETE' });
    state.myQualifications = state.myQualifications.filter((q) => q.id !== id);
    renderMyQualifications();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// Shared read-only profile view - opened from the Employees tab (colleagues with a linked
// account) and from an assigned employee's name on a Job Detail page (see
// teamAssignmentDisplayRow below).
async function openProfileModal(userId) {
  try {
    const profile = await api(`/api/users/${userId}/profile`);
    document.getElementById('profileViewModalTitle').textContent = profile.name;
    renderAvatar(document.getElementById('profileViewPhoto'), profile);
    applyProfileBackground(document.getElementById('profileViewCard'), profile.profileBackground);
    document.getElementById('profileViewName').textContent = profile.name;
    document.getElementById('profileViewRole').textContent = ROLE_LABELS[profile.role] || profile.role;
    const tbody = document.querySelector('#profileViewQualificationsTable tbody');
    tbody.innerHTML = profile.qualifications.map((q) => `
      <tr><td>${escapeHtml(q.name)}</td><td>${qualificationExpiryCell(q)}</td></tr>
    `).join('');
    document.getElementById('profileViewQualificationsEmpty').hidden = !!profile.qualifications.length;
    document.getElementById('profileViewModal').hidden = false;
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('profileViewModalCloseBtn').addEventListener('click', () => {
  document.getElementById('profileViewModal').hidden = true;
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
          toast(err.message, 'error');
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
          toast(err.message, 'error');
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
      toast(err.message, 'error');
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

const SUBBY_INSURANCE_LABELS = { expired: 'Expired', 'expiring-soon': 'Expiring Soon', ok: 'Valid' };

function subbyInsuranceCell(s) {
  if (!s.insuranceStatus) return '<span class="hint">Not on file</span>';
  const pillClass = s.insuranceStatus === 'expired' ? 'overdue' : s.insuranceStatus === 'expiring-soon' ? 'due-soon' : 'returned';
  return `<span class="hire-status ${pillClass}">${SUBBY_INSURANCE_LABELS[s.insuranceStatus]}</span> <span class="doc-meta">${s.insuranceExpiry}</span>`;
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
          <td><input type="date" class="sb-edit-insurance" value="${s.insuranceExpiry || ''}"></td>
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
        <td>${subbyInsuranceCell(s)}</td>
        <td>${formCell}</td>
        <td class="row-actions">
          <button type="button" class="sb-edit-btn">Edit</button>
          ${isAdmin() ? '<button type="button" class="danger sb-delete-btn">Delete</button>' : ''}
        </td>
      </tr>`;
  }).join('') : `<tr><td colspan="7" class="empty-state">${subbiesSearchTerm.trim() ? 'No subbies match your search.' : 'Nothing added yet.'}</td></tr>`;

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
        insuranceExpiry: tr.querySelector('.sb-edit-insurance').value,
      };
      try {
        await api(`/api/subbies/${tr.dataset.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        state.subbies = await api('/api/subbies');
        editingSubbyId = null;
        renderSubbies();
      } catch (err) {
        toast(err.message, 'error');
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
        toast(err.message, 'error');
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
  const insuranceInput = document.getElementById('newSubbyInsuranceExpiry');
  const formInput = document.getElementById('newSubbyForm');
  if (!companyInput.value.trim() || !personInput.value.trim()) return;
  if (!formInput.files[0]) { toast('Upload the subcontractor form before adding a subby.', 'error'); return; }
  try {
    const formData = new FormData();
    formData.append('companyName', companyInput.value);
    formData.append('personName', personInput.value);
    formData.append('phone', phoneInput.value);
    formData.append('trade', tradeInput.value);
    formData.append('insuranceExpiry', insuranceInput.value);
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
    insuranceInput.value = '';
    formInput.value = '';
    document.getElementById('newSubbyFormName').textContent = '';
    state.subbies = await api('/api/subbies');
    renderSubbies();
    toast('Subby added.', 'success');
  } catch (err) {
    toast(err.message, 'error');
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
      <td><input type="number" class="qt-edit-value" value="${q.value === null ? '' : q.value}" step="0.01" min="0"></td>
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
      <td>${q.value === null ? '—' : money(q.value)}</td>
      <td>${escapeHtml(quotingUserName(q.assignedTo) || 'Unassigned')}</td>
      <td>${(canManage || isMine)
        ? `<label class="quote-status-toggle"><input type="checkbox" data-toggle-quote="${q.id}" ${q.quoted ? 'checked' : ''}> <span class="hire-status ${q.quoted ? 'returned' : 'due-soon'}">${q.quoted ? 'Quoted' : 'Pending'}</span></label>`
        : `<span class="hire-status ${q.quoted ? 'returned' : 'due-soon'}">${q.quoted ? 'Quoted' : 'Pending'}</span>`}</td>
      <td class="row-actions">
        ${canManage ? `<button type="button" class="qt-convert-btn">Convert to Job</button><button type="button" class="qt-edit-btn">Edit</button><button type="button" class="danger qt-delete-btn">Delete</button>` : ''}
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
        toast(err.message, 'error');
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
        value: tr.querySelector('.qt-edit-value').value || null,
        assignedTo: tr.querySelector('.qt-edit-assigned').value || null,
      };
      try {
        await api(`/api/quotes/${tr.dataset.id}`, { method: 'PUT', body: JSON.stringify(body) });
        editingQuoteId = null;
        loadQuotes();
      } catch (err) {
        toast(err.message, 'error');
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
        toast(err.message, 'error');
      }
    });
  });
  // Pre-fills the New Job form from this quote (client/site/description/value) rather than
  // silently creating the job outright - same reviewable pattern as the job-sheet import
  // prefill, so nothing gets created without someone actually checking it first. The quote
  // itself is left as-is (still there, still markable as quoted) since a job and a quote are
  // still two separate records - this just removes re-typing the same details twice.
  tbody.querySelectorAll('.qt-convert-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const q = state.quotes.find((x) => x.id === btn.closest('tr').dataset.id);
      if (!q) return;
      goToTab('jobs');
      openJobModal(null, {
        client: q.clientName,
        location: q.siteAddress || '',
        description: q.description || '',
        value: q.value === null ? '' : q.value,
        employeeName: quotingUserName(q.assignedTo) || '',
      });
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
  const valueInput = document.getElementById('newQuoteValue');
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
        value: valueInput.value || null,
        assignedTo: assignedInput.value || null,
      }),
    });
    clientInput.value = '';
    addressInput.value = '';
    descriptionInput.value = '';
    dueDateInput.value = '';
    valueInput.value = '';
    loadQuotes();
    toast('Quote added.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- Job Detail: Team (assignments) ----------
// Full assignment management lives inside the Job Detail modal's Team tab - assign who's
// physically carrying out this job, edit/delete assignments, and jump into their time log /
// RAMS / photos, all without a separate Job Assignments tab. Admin: full CRUD. Surveyor: same
// view, read-only (no add row, no edit/delete buttons - isAdmin() checks below). Staff and
// operatives never reach the Jobs tab at all (see showApp).

let editingTeamAssignmentId = null;

function operativeOptionsHtml(selectedId, excludeUserIds) {
  const exclude = excludeUserIds || new Set();
  return '<option value="">Employee…</option>' + state.operativeUsers
    .filter((u) => u.id === selectedId || !exclude.has(u.id))
    .map((u) => `<option value="${u.id}" ${selectedId === u.id ? 'selected' : ''}>${escapeHtml(u.name)}</option>`)
    .join('');
}

function timeLogTableHtml(timeLogs) {
  if (!timeLogs.length) return '<p class="empty-state">No time logged yet.</p>';
  return `
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>Date</th><th>Clock In</th><th>Arrived</th><th>Completed</th><th>Clock Out</th><th>On Site</th></tr></thead>
        <tbody>
          ${timeLogs.map((l) => `
            <tr>
              <td>${l.logDate}</td>
              <td>${timeLogTimeOf(l.clockInAt)}</td>
              <td>${timeLogTimeOf(l.arrivedAt)}</td>
              <td>${timeLogTimeOf(l.completedAt)}</td>
              <td>${timeLogTimeOf(l.clockOutAt)}</td>
              <td>${l.onSiteMinutes != null ? `${Math.floor(l.onSiteMinutes / 60)}h ${l.onSiteMinutes % 60}m` : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
}

function teamAssignmentDisplayRow(a) {
  return `
    <div class="job-clocktimes-assignment" data-id="${a.id}">
      <div class="job-team-row-header">
        <h4><button type="button" class="link-btn profile-link" data-view-profile="${a.userId}">${escapeHtml(a.userName)}</button> <span class="hint">— ${escapeHtml(a.task)}, ${a.startDate}, ${a.durationDays} day${a.durationDays === 1 ? '' : 's'}</span> <span class="status-pill ${a.completed ? 'complete' : 'in-progress'}">${a.completed ? 'Done' : 'Pending'}</span></h4>
        <div class="row-actions">
          <button type="button" class="ja-photos-btn">View Photos</button>
          <button type="button" class="ja-timelog-btn">Time Log</button>
          <button type="button" class="ja-rams-btn">RAMS</button>
          ${isAdmin() ? `<button type="button" class="ja-edit-btn">Edit</button><button type="button" class="danger ja-delete-btn">Delete</button>` : ''}
        </div>
      </div>
      ${timeLogTableHtml(a.timeLogs)}
    </div>`;
}

function teamAssignmentEditRow(a, excludeUserIds) {
  return `
    <div class="job-clocktimes-assignment job-team-row-editing" data-id="${a.id}">
      <div class="job-team-edit-fields">
        <select class="ja-edit-user">${operativeOptionsHtml(a.userId, excludeUserIds)}</select>
        <input type="text" class="ja-edit-task" value="${escapeHtml(a.task)}" placeholder="Task">
        <input type="date" class="ja-edit-start" value="${a.startDate}">
        <input type="number" class="ja-edit-duration" min="1" step="1" value="${a.durationDays}">
        <button type="button" class="primary ja-save-btn">Save</button>
        <button type="button" class="ja-cancel-btn">Cancel</button>
      </div>
    </div>`;
}

// `assignments` is scoped to just the job currently open in the Job Detail modal (see
// refreshJobDetail) - not the full cross-job list the old standalone Job Assignments tab held.
function renderJobTeamSection(assignments) {
  const container = document.getElementById('jobDetailSection-clocktimes');
  const assignedUserIds = new Set(assignments.map((a) => a.userId));
  const addRow = isAdmin() ? `
    <div class="import-upload job-team-add-row">
      <select id="teamAssignUser">${operativeOptionsHtml('', assignedUserIds)}</select>
      <input type="text" id="teamAssignTask" placeholder="Task (e.g. Install signage)">
      <input type="date" id="teamAssignStartDate">
      <input type="number" id="teamAssignDuration" placeholder="Days" min="1" step="1" value="1">
      <button type="button" id="teamAssignBtn" class="primary">+ Assign</button>
    </div>` : '';
  const list = assignments.length
    ? assignments.map((a) => (a.id === editingTeamAssignmentId ? teamAssignmentEditRow(a, assignedUserIds) : teamAssignmentDisplayRow(a))).join('')
    : '<p class="empty-state">No one assigned to this job yet.</p>';
  container.innerHTML = addRow + list;

  if (isAdmin()) {
    document.getElementById('teamAssignBtn').addEventListener('click', async () => {
      const userSel = document.getElementById('teamAssignUser');
      const taskInput = document.getElementById('teamAssignTask');
      const startInput = document.getElementById('teamAssignStartDate');
      const durationInput = document.getElementById('teamAssignDuration');
      if (!userSel.value || !taskInput.value.trim() || !startInput.value) {
        toast('Choose an employee and fill in the task and start date.', 'error');
        return;
      }
      try {
        await api('/api/job-assignments', {
          method: 'POST',
          body: JSON.stringify({
            jobId: currentDetailJobId,
            userId: userSel.value,
            task: taskInput.value,
            startDate: startInput.value,
            durationDays: durationInput.value || 1,
          }),
        });
        refreshJobDetail();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  container.querySelectorAll('.profile-link').forEach((btn) => {
    btn.addEventListener('click', () => openProfileModal(btn.dataset.viewProfile));
  });
  container.querySelectorAll('.ja-photos-btn').forEach((btn) => {
    btn.addEventListener('click', () => openJobDetail(currentDetailJobId, 'photos'));
  });
  container.querySelectorAll('.ja-timelog-btn').forEach((btn) => {
    btn.addEventListener('click', () => openTimeLogModal(btn.closest('[data-id]').dataset.id));
  });
  container.querySelectorAll('.ja-rams-btn').forEach((btn) => {
    btn.addEventListener('click', () => openRamsViewModal(btn.closest('[data-id]').dataset.id));
  });
  container.querySelectorAll('.ja-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => { editingTeamAssignmentId = btn.closest('[data-id]').dataset.id; renderJobTeamSection(state.jobAssignments); });
  });
  container.querySelectorAll('.ja-cancel-btn').forEach((btn) => {
    btn.addEventListener('click', () => { editingTeamAssignmentId = null; renderJobTeamSection(state.jobAssignments); });
  });
  container.querySelectorAll('.ja-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('[data-id]');
      const body = {
        jobId: currentDetailJobId,
        userId: row.querySelector('.ja-edit-user').value,
        task: row.querySelector('.ja-edit-task').value,
        startDate: row.querySelector('.ja-edit-start').value,
        durationDays: row.querySelector('.ja-edit-duration').value,
      };
      try {
        await api(`/api/job-assignments/${row.dataset.id}`, { method: 'PUT', body: JSON.stringify(body) });
        editingTeamAssignmentId = null;
        refreshJobDetail();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
  container.querySelectorAll('.ja-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this assignment?')) return;
      try {
        await api(`/api/job-assignments/${btn.closest('[data-id]').dataset.id}`, { method: 'DELETE' });
        refreshJobDetail();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

// ---------- Job Costing (profit/loss) ----------
// Replaces the old paper job-costing spreadsheet: Employee Hours (auto-filled from clocked
// time, editable per line), Subcontractors and Materials (freely editable cost lines with a
// markup %), and a Quoted Price/Grand Total/Profit/Spent summary - same shape, same
// arithmetic. Labour rate comes from the Labour Rates list (Operations tab) matched by the
// job's client name, not anything stored here.

function costingLineRow(line) {
  return `
    <tr data-id="${line.id}">
      <td><input type="text" class="costing-edit-desc" value="${escapeHtml(line.description)}"></td>
      <td><input type="text" class="costing-edit-amounts" value="${line.amounts.join(', ')}" placeholder="e.g. 120, 45.50"></td>
      <td>${money(line.unitPrice)}</td>
      <td><input type="number" class="costing-edit-markup" value="${line.markupPercent}" min="0" step="1"></td>
      <td>${money(line.markupAmount)}</td>
      <td><strong>${money(line.total)}</strong></td>
      <td class="row-actions">
        <button type="button" class="costing-save-btn">Save</button>
        <button type="button" class="danger costing-delete-btn">Delete</button>
      </td>
    </tr>
  `;
}

function costingSectionTableHtml(bodyId, rows) {
  return `
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>Description</th><th>Amounts</th><th>Unit Price</th><th>Markup %</th><th>Markup £</th><th>Total</th><th></th></tr></thead>
        <tbody id="${bodyId}">${rows}</tbody>
      </table>
    </div>
  `;
}

function renderJobCostingSection(costing) {
  const container = document.getElementById('jobDetailSection-costing');
  const labour = costing.labour;
  const rateNote = labour.rate === null
    ? `<p class="empty-state">No labour rate on file for "${escapeHtml(labour.clientName || '')}" - add one under Operations → Labour Rates (name it exactly the same as this job's client) to price up hours automatically.</p>`
    : `<p class="hint">Using the "${escapeHtml(labour.clientName)}" rate from Labour Rates: ${money(labour.rate)}/hr.</p>`;

  const employeeRows = labour.employees.length ? labour.employees.map((e) => `
    <tr data-user="${e.userId}">
      <td>${escapeHtml(e.userName)}</td>
      <td>
        <input type="number" class="costing-hours-input" value="${e.hours}" min="0" step="0.25" data-user="${e.userId}">
        ${e.overridden ? `<button type="button" class="link-btn costing-revert-hours-btn" data-user="${e.userId}">↺ Use clocked (${e.computedHours})</button>` : ''}
      </td>
      <td>${labour.rate === null ? '—' : money(labour.rate)}</td>
      <td><strong>${money(e.total)}</strong></td>
    </tr>
  `).join('') : `<tr><td colspan="4" class="empty-state">Nobody's clocked time on this job yet.</td></tr>`;

  container.innerHTML = `
    ${rateNote}
    <h3>Employee Hours</h3>
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>Employee</th><th>Hours (clock-in to clock-out)</th><th>Rate</th><th>Total</th></tr></thead>
        <tbody>${employeeRows}</tbody>
        <tfoot><tr><td><strong>Total</strong></td><td><strong>${labour.totalHours.toFixed(2)}</strong></td><td></td><td><strong>${money(labour.total)}</strong></td></tr></tfoot>
      </table>
    </div>

    <h3>Subcontractors</h3>
    ${costingSectionTableHtml('costingSubbyBody', costing.subbyLines.map(costingLineRow).join(''))}
    <div class="import-upload">
      <input type="text" id="costingNewSubbyDesc" placeholder="Description">
      <input type="text" id="costingNewSubbyAmounts" placeholder="Amounts, e.g. 120, 45.50">
      <input type="number" id="costingNewSubbyMarkup" placeholder="Markup %" value="30" min="0" step="1">
      <button type="button" id="costingAddSubbyBtn" class="primary">+ Add Line</button>
    </div>

    <h3>Materials</h3>
    ${costingSectionTableHtml('costingMaterialsBody', costing.materialsLines.map(costingLineRow).join(''))}
    <div class="import-upload">
      <input type="text" id="costingNewMaterialDesc" placeholder="Description">
      <input type="text" id="costingNewMaterialAmounts" placeholder="Amounts, e.g. 120, 45.50">
      <input type="number" id="costingNewMaterialMarkup" placeholder="Markup %" value="30" min="0" step="1">
      <button type="button" id="costingAddMaterialBtn" class="primary">+ Add Line</button>
    </div>

    <div class="report-summary">
      <div class="stat"><div class="label">Quoted Price</div><div class="value">${money(costing.quotedPrice)}</div></div>
      <div class="stat"><div class="label">Grand Total (cost)</div><div class="value">${money(costing.grandTotal)}</div></div>
      <div class="stat"><div class="label">Profit</div><div class="value ${costing.profit >= 0 ? 'green' : 'red'}">${money(costing.profit)}</div></div>
      <div class="stat"><div class="label">Spent (raw cost, no markup)</div><div class="value">${money(costing.spent)}</div></div>
    </div>
  `;

  container.querySelectorAll('.costing-hours-input').forEach((input) => {
    input.addEventListener('change', async () => {
      try {
        await api(`/api/jobs/${currentDetailJobId}/costing/labour/${input.dataset.user}`, {
          method: 'PUT',
          body: JSON.stringify({ hours: input.value }),
        });
        const fresh = await api(`/api/jobs/${currentDetailJobId}/costing`);
        renderJobCostingSection(fresh);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
  container.querySelectorAll('.costing-revert-hours-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/jobs/${currentDetailJobId}/costing/labour/${btn.dataset.user}`, { method: 'DELETE' });
        const fresh = await api(`/api/jobs/${currentDetailJobId}/costing`);
        renderJobCostingSection(fresh);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  function wireLineButtons(scopeId) {
    container.querySelectorAll(`#${scopeId} .costing-save-btn`).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tr = btn.closest('tr');
        const body = {
          description: tr.querySelector('.costing-edit-desc').value,
          amounts: tr.querySelector('.costing-edit-amounts').value.split(',').map((s) => s.trim()).filter(Boolean),
          markupPercent: tr.querySelector('.costing-edit-markup').value,
        };
        try {
          await api(`/api/costing-lines/${tr.dataset.id}`, { method: 'PUT', body: JSON.stringify(body) });
          const fresh = await api(`/api/jobs/${currentDetailJobId}/costing`);
          renderJobCostingSection(fresh);
          toast('Line saved.', 'success');
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
    container.querySelectorAll(`#${scopeId} .costing-delete-btn`).forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this line?')) return;
        try {
          await api(`/api/costing-lines/${btn.closest('tr').dataset.id}`, { method: 'DELETE' });
          const fresh = await api(`/api/jobs/${currentDetailJobId}/costing`);
          renderJobCostingSection(fresh);
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  }
  wireLineButtons('costingSubbyBody');
  wireLineButtons('costingMaterialsBody');

  function wireAddLine(section, descId, amountsId, markupId, btnId) {
    document.getElementById(btnId).addEventListener('click', async () => {
      const descInput = document.getElementById(descId);
      const amountsInput = document.getElementById(amountsId);
      const markupInput = document.getElementById(markupId);
      if (!descInput.value.trim()) { toast('Enter a description.', 'error'); return; }
      try {
        await api(`/api/jobs/${currentDetailJobId}/costing/lines`, {
          method: 'POST',
          body: JSON.stringify({
            section,
            description: descInput.value,
            amounts: amountsInput.value.split(',').map((s) => s.trim()).filter(Boolean),
            markupPercent: markupInput.value,
          }),
        });
        const fresh = await api(`/api/jobs/${currentDetailJobId}/costing`);
        renderJobCostingSection(fresh);
        toast('Line added.', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
  wireAddLine('subby', 'costingNewSubbyDesc', 'costingNewSubbyAmounts', 'costingNewSubbyMarkup', 'costingAddSubbyBtn');
  wireAddLine('materials', 'costingNewMaterialDesc', 'costingNewMaterialAmounts', 'costingNewMaterialMarkup', 'costingAddMaterialBtn');
}

// ---------- Time Log viewer (admin/surveyor, read-only) ----------

let currentTimeLogAssignmentId = null;

function timeLogTimeOf(iso) {
  return iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—';
}

function openTimeLogModal(id) {
  currentTimeLogAssignmentId = id;
  const a = state.jobAssignments.find((x) => x.id === id);
  document.getElementById('timeLogModalTitle').textContent = a
    ? `Time Log — ${a.userName} — ${a.jobReference || a.jobClient}${a.jobLocation ? ' — ' + a.jobLocation : ''}`
    : 'Time Log';
  document.getElementById('timeLogModal').hidden = false;
  refreshTimeLogModal();
}

async function refreshTimeLogModal() {
  const tbody = document.querySelector('#timeLogTable tbody');
  try {
    const logs = await api(`/api/job-assignments/${currentTimeLogAssignmentId}/time-logs`);
    document.getElementById('timeLogEmptyState').hidden = !!logs.length;
    tbody.innerHTML = logs.map((l) => `
      <tr>
        <td>${l.logDate}</td>
        <td>${timeLogTimeOf(l.clockInAt)}</td>
        <td>${timeLogTimeOf(l.arrivedAt)}</td>
        <td>${timeLogTimeOf(l.completedAt)}</td>
        <td>${timeLogTimeOf(l.clockOutAt)}</td>
        <td>${l.onSiteMinutes != null ? `${Math.floor(l.onSiteMinutes / 60)}h ${l.onSiteMinutes % 60}m` : '—'}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = '';
    document.getElementById('timeLogEmptyState').hidden = false;
    document.getElementById('timeLogEmptyState').textContent = err.message;
  }
}

document.getElementById('timeLogModalCloseBtn').addEventListener('click', () => {
  document.getElementById('timeLogModal').hidden = true;
});

// ---------- RAMS viewer (admin/surveyor, read-only) ----------

let currentRamsViewAssignmentId = null;

function openRamsViewModal(id) {
  currentRamsViewAssignmentId = id;
  const a = state.jobAssignments.find((x) => x.id === id);
  document.getElementById('ramsViewModalTitle').textContent = a
    ? `RAMS — ${a.userName} — ${a.jobReference || a.jobClient}${a.jobLocation ? ' — ' + a.jobLocation : ''}`
    : 'RAMS';
  document.getElementById('ramsViewModal').hidden = false;
  refreshRamsViewModal();
}

function ramsHazardCardHtml(h) {
  const currentBand = raBandClient(h.currentL * h.currentC);
  const additionalBand = raBandClient(h.additionalL * h.additionalC);
  return `
    <div class="ra-card">
      <div class="ra-card-top">
        <h3>${escapeHtml(h.title)}</h3>
        <span class="risk-badge ${currentBand.slug}">${escapeHtml(currentBand.label)}</span>
      </div>
      ${h.legislation ? `<p class="ra-card-summary">${escapeHtml(h.legislation)}</p>` : ''}
      ${h.hazard ? `<p>${escapeHtml(h.hazard)}</p>` : ''}
      ${h.peopleAffected ? `<p><strong>Who might be harmed:</strong> ${escapeHtml(h.peopleAffected)}</p>` : ''}
      <p><strong>Current controls:</strong></p>
      <ul>${(h.currentControls || []).map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
      <p class="risk-badge ${currentBand.slug}">Current: ${h.currentL} × ${h.currentC} = ${h.currentL * h.currentC} — ${escapeHtml(currentBand.label)}</p>
      ${(h.additionalControls || []).length ? `<p><strong>Additional controls:</strong></p><ul>${h.additionalControls.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : ''}
      <p class="risk-badge ${additionalBand.slug}">With additional controls: ${h.additionalL} × ${h.additionalC} = ${h.additionalL * h.additionalC} — ${escapeHtml(additionalBand.label)}</p>
      ${(h.ppe || []).length ? `<p><strong>PPE required:</strong> ${h.ppe.map(escapeHtml).join(', ')}</p>` : ''}
    </div>
  `;
}

function ramsViewHtml(rams) {
  return `
    <h3>Method Statement</h3>
    <p>${escapeHtml(rams.methodStatement).replace(/\n/g, '<br>')}</p>
    <h3>Risk Assessment</h3>
    <div class="ra-grid">${(rams.hazards || []).map(ramsHazardCardHtml).join('')}</div>
    <h3>Signed</h3>
    <p>${escapeHtml(rams.operativeName)} — ${new Date(rams.createdAt).toLocaleString('en-GB')}</p>
    <img class="rams-signature-view" src="${rams.signatureImage}" alt="Signature">
  `;
}

async function refreshRamsViewModal() {
  const body = document.getElementById('ramsViewModalBody');
  try {
    const rams = await api(`/api/job-assignments/${currentRamsViewAssignmentId}/rams`);
    document.getElementById('ramsViewEmptyState').hidden = !!rams;
    document.getElementById('ramsViewModalActions').hidden = !rams;
    body.innerHTML = rams ? ramsViewHtml(rams) : '';
  } catch (err) {
    body.innerHTML = '';
    document.getElementById('ramsViewModalActions').hidden = true;
    document.getElementById('ramsViewEmptyState').hidden = false;
    document.getElementById('ramsViewEmptyState').textContent = err.message;
  }
}

document.getElementById('ramsViewModalCloseBtn').addEventListener('click', () => {
  document.getElementById('ramsViewModal').hidden = true;
});

// Backfills/re-syncs the job's document list for a RAMS that was submitted before the
// auto-attach behaviour existed (or if the upload step ever failed at submit time) - see the
// matching /rams/attach-to-job route in server.js.
document.getElementById('ramsAttachToJobBtn').addEventListener('click', async () => {
  try {
    await api(`/api/job-assignments/${currentRamsViewAssignmentId}/rams/attach-to-job`, { method: 'POST' });
    toast('Attached to the job\'s documents - check the Jobs tab.', 'success');
  } catch (err) {
    toast(err.message, 'error');
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
        toast(err.message, 'error');
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
        toast(err.message, 'error');
      }
    });
  });
  tbody.querySelectorAll('[data-return]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/hires/${btn.dataset.return}/return`, { method: 'POST' });
        loadHires();
      } catch (err) {
        toast(err.message, 'error');
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
        toast(err.message, 'error');
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
    toast(err.message, 'error');
  }
});

// ---------- Vehicle Hire ----------
// Admin-only tracker for hired-in vehicles. A vehicle only ever moves from on-hire to
// off-hire (never back) via the per-row status dropdown, which pops an inline comments
// box for noting any new damage before the move is confirmed.

let editingVehicleHireId = null;
let offHiringVehicleHireId = null;

async function loadVehicleHires() {
  state.vehicleHires = await api('/api/vehicle-hires');
  renderVehicleHires();
}

function vehicleHireEditRow(v) {
  return `
    <tr data-id="${v.id}">
      <td><input type="text" class="vh-edit-supplier" value="${escapeHtml(v.supplier)}"></td>
      <td><input type="date" class="vh-edit-date" value="${v.hireDate}"></td>
      <td><input type="text" class="vh-edit-registration" value="${escapeHtml(v.registration)}"></td>
      <td><input type="text" class="vh-edit-make" value="${escapeHtml(v.make)}"></td>
      <td><input type="text" class="vh-edit-model" value="${escapeHtml(v.model)}"></td>
      <td><input type="text" class="vh-edit-signedin" value="${escapeHtml(v.signedIn)}"></td>
      <td><span class="hire-status on-hire">On Hire</span></td>
      <td class="row-actions">
        <button type="button" class="primary vh-save-btn">Save</button>
        <button type="button" class="vh-cancel-btn">Cancel</button>
      </td>
    </tr>
  `;
}

function vehicleHireOffHiringRow(v) {
  return `
    <tr data-id="${v.id}">
      <td colspan="8">
        <div class="vh-offhire-confirm">
          <strong>${escapeHtml(v.registration)} — ${escapeHtml(v.make)} ${escapeHtml(v.model)}</strong>
          <input type="text" class="vh-offhire-signedout" placeholder="Signed out (name)">
          <textarea class="vh-offhire-comments" placeholder="Any new damage to note? (optional)"></textarea>
          <div class="vh-offhire-actions">
            <button type="button" class="primary vh-confirm-offhire-btn">Confirm Off Hire</button>
            <button type="button" class="vh-cancel-offhire-btn">Cancel</button>
          </div>
        </div>
      </td>
    </tr>
  `;
}

function vehicleHireDisplayRow(v) {
  return `
    <tr>
      <td>${escapeHtml(v.supplier || '—')}</td>
      <td>${v.hireDate}</td>
      <td>${escapeHtml(v.registration)}</td>
      <td>${escapeHtml(v.make || '—')}</td>
      <td>${escapeHtml(v.model || '—')}</td>
      <td>${escapeHtml(v.signedIn || '—')}</td>
      <td>
        <select class="vh-status-select" data-vh-status="${v.id}">
          <option value="on-hire" selected>On Hire</option>
          <option value="off-hire">Off Hire</option>
        </select>
      </td>
      <td class="row-actions">
        <button type="button" data-edit-vh="${v.id}">Edit</button>
        <button type="button" class="danger" data-del-vh="${v.id}">Delete</button>
      </td>
    </tr>
  `;
}

function vehicleHireOffHiredRow(v) {
  return `
    <tr>
      <td>${escapeHtml(v.supplier || '—')}</td>
      <td>${v.hireDate}</td>
      <td>${escapeHtml(v.registration)}</td>
      <td>${escapeHtml(v.make || '—')}</td>
      <td>${escapeHtml(v.model || '—')}</td>
      <td>${escapeHtml(v.signedIn || '—')}</td>
      <td>${escapeHtml(v.signedOut || '—')}</td>
      <td>${v.offHireDate}</td>
      <td>${escapeHtml(v.damageComments || '—')}</td>
      <td class="row-actions">
        <button type="button" class="danger" data-del-vh="${v.id}">Delete</button>
      </td>
    </tr>
  `;
}

function renderVehicleHires() {
  const view = document.getElementById('vehicleHireViewSelect').value;
  document.getElementById('vehicleHireOnHireSection').hidden = view !== 'on-hire';
  document.getElementById('vehicleHireOffHireSection').hidden = view !== 'off-hire';

  const term = document.getElementById('vehicleHireSearch').value.trim().toLowerCase();
  const filtered = term
    ? state.vehicleHires.filter((v) => [v.supplier, v.registration, v.make, v.model].some((f) => (f || '').toLowerCase().includes(term)))
    : state.vehicleHires;
  const onHire = filtered.filter((v) => v.status !== 'off-hire');
  const offHire = filtered.filter((v) => v.status === 'off-hire');
  const onHireCount = state.vehicleHires.filter((v) => v.status !== 'off-hire').length;
  const offHireCount = state.vehicleHires.filter((v) => v.status === 'off-hire').length;

  const tbody = document.querySelector('#vehicleHiresTable tbody');
  document.getElementById('vehicleHiresEmptyState').hidden = !!onHire.length;
  document.getElementById('vehicleHiresEmptyState').textContent = onHireCount && term
    ? 'No vehicles on hire match your search.'
    : 'No vehicles on hire yet.';
  tbody.innerHTML = onHire.map((v) => {
    if (v.id === offHiringVehicleHireId) return vehicleHireOffHiringRow(v);
    if (v.id === editingVehicleHireId) return vehicleHireEditRow(v);
    return vehicleHireDisplayRow(v);
  }).join('');

  const offHireTbody = document.querySelector('#vehicleHiresOffHireTable tbody');
  document.getElementById('vehicleHiresOffHireEmptyState').hidden = !!offHire.length;
  document.getElementById('vehicleHiresOffHireEmptyState').textContent = offHireCount && term
    ? 'No off-hired vehicles match your search.'
    : 'No off-hired vehicles yet.';
  offHireTbody.innerHTML = offHire.map((v) => vehicleHireOffHiredRow(v)).join('');

  document.querySelectorAll('#vehicleHiresTable [data-del-vh], #vehicleHiresOffHireTable [data-del-vh]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this vehicle hire record? This cannot be undone.')) return;
      try {
        await api(`/api/vehicle-hires/${btn.dataset.delVh}`, { method: 'DELETE' });
        loadVehicleHires();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  tbody.querySelectorAll('[data-edit-vh]').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingVehicleHireId = btn.dataset.editVh;
      renderVehicleHires();
    });
  });
  tbody.querySelectorAll('.vh-cancel-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingVehicleHireId = null;
      renderVehicleHires();
    });
  });
  tbody.querySelectorAll('.vh-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const body = {
        supplier: tr.querySelector('.vh-edit-supplier').value.trim(),
        hireDate: tr.querySelector('.vh-edit-date').value,
        registration: tr.querySelector('.vh-edit-registration').value.trim(),
        make: tr.querySelector('.vh-edit-make').value.trim(),
        model: tr.querySelector('.vh-edit-model').value.trim(),
        signedIn: tr.querySelector('.vh-edit-signedin').value.trim(),
      };
      try {
        await api(`/api/vehicle-hires/${tr.dataset.id}`, { method: 'PUT', body: JSON.stringify(body) });
        editingVehicleHireId = null;
        loadVehicleHires();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  tbody.querySelectorAll('.vh-status-select').forEach((select) => {
    select.addEventListener('change', () => {
      if (select.value === 'off-hire') {
        offHiringVehicleHireId = select.dataset.vhStatus;
        renderVehicleHires();
      }
    });
  });
  tbody.querySelectorAll('.vh-cancel-offhire-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      offHiringVehicleHireId = null;
      renderVehicleHires();
    });
  });
  tbody.querySelectorAll('.vh-confirm-offhire-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const comments = tr.querySelector('.vh-offhire-comments').value.trim();
      const signedOut = tr.querySelector('.vh-offhire-signedout').value.trim();
      try {
        await api(`/api/vehicle-hires/${tr.dataset.id}/off-hire`, { method: 'POST', body: JSON.stringify({ comments, signedOut }) });
        offHiringVehicleHireId = null;
        loadVehicleHires();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

document.getElementById('vehicleHireSearch').addEventListener('input', renderVehicleHires);
document.getElementById('vehicleHireViewSelect').addEventListener('change', renderVehicleHires);

document.getElementById('vehicleHireAddForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    supplier: document.getElementById('vehicleHireSupplierInput').value.trim(),
    hireDate: document.getElementById('vehicleHireDateInput').value,
    registration: document.getElementById('vehicleHireRegistrationInput').value.trim(),
    make: document.getElementById('vehicleHireMakeInput').value.trim(),
    model: document.getElementById('vehicleHireModelInput').value.trim(),
    signedIn: document.getElementById('vehicleHireSignedInInput').value.trim(),
  };
  try {
    await api('/api/vehicle-hires', { method: 'POST', body: JSON.stringify(body) });
    e.target.reset();
    loadVehicleHires();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- Assets (plant/tools/equipment, QR scan out/in) ----------
// Admins and stocks managers only (see requireAssetsAccess in server.js). Add/edit happens
// in a modal (assetModal) rather than inline rows like Hire, since there's only two fields.
// Check-out/check-in/repairs all happen from the Scan modal - see the scan block further down.

const ASSET_STATUS_LABELS = { available: 'Available', checked_out: 'Checked Out', repairs: 'Repairs' };

async function loadAssets() {
  state.assets = await api('/api/assets');
  renderAssets();
}

function assetRow(a) {
  const checkedOutAt = a.checkedOutAt ? new Date(a.checkedOutAt).toLocaleString('en-GB') : '—';
  const lastCondition = a.lastConditionStatus ? (a.lastConditionStatus === 'good' ? 'Good' : 'Damaged') : '—';
  return `
    <tr>
      <td>${escapeHtml(a.name)}</td>
      <td>${escapeHtml(a.category || '—')}</td>
      <td><span class="status-pill ${a.status}">${ASSET_STATUS_LABELS[a.status]}</span></td>
      <td>${escapeHtml(a.currentJobReference || '—')}</td>
      <td>${escapeHtml(a.currentHolderName || '—')}</td>
      <td>${checkedOutAt}</td>
      <td>${lastCondition}</td>
      <td class="row-actions">
        <button type="button" data-qr-asset="${a.id}">View QR</button>
        <button type="button" data-edit-asset="${a.id}">Edit</button>
        ${isAdmin() ? `<button type="button" class="danger" data-del-asset="${a.id}">Delete</button>` : ''}
      </td>
    </tr>
  `;
}

function renderAssets() {
  const term = document.getElementById('assetSearch').value.trim().toLowerCase();
  const status = document.getElementById('assetStatusFilter').value;
  const filtered = state.assets.filter((a) => {
    if (status && a.status !== status) return false;
    if (term && ![a.name, a.category].some((v) => (v || '').toLowerCase().includes(term))) return false;
    return true;
  });

  const tbody = document.querySelector('#assetsTable tbody');
  document.getElementById('assetsEmptyState').hidden = !!filtered.length;
  document.getElementById('assetsEmptyState').textContent = state.assets.length && (term || status)
    ? 'No assets match your search.'
    : 'No assets added yet.';
  tbody.innerHTML = filtered.map(assetRow).join('');

  tbody.querySelectorAll('[data-qr-asset]').forEach((btn) => {
    btn.addEventListener('click', () => openAssetQr(btn.dataset.qrAsset));
  });
  tbody.querySelectorAll('[data-edit-asset]').forEach((btn) => {
    btn.addEventListener('click', () => openAssetModal(state.assets.find((a) => a.id === btn.dataset.editAsset)));
  });
  tbody.querySelectorAll('[data-del-asset]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this asset? This cannot be undone.')) return;
      try {
        await api(`/api/assets/${btn.dataset.delAsset}`, { method: 'DELETE' });
        loadAssets();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

document.getElementById('assetSearch').addEventListener('input', renderAssets);
document.getElementById('assetStatusFilter').addEventListener('change', renderAssets);

function openAssetModal(asset) {
  document.getElementById('assetModalTitle').textContent = asset ? 'Edit Asset' : 'Add Asset';
  document.getElementById('assetId').value = asset ? asset.id : '';
  document.getElementById('assetNameInput').value = asset ? asset.name : '';
  document.getElementById('assetCategoryInput').value = asset ? asset.category : '';
  document.getElementById('assetModal').hidden = false;
}

document.getElementById('newAssetBtn').addEventListener('click', () => openAssetModal(null));
document.getElementById('assetModalCloseBtn').addEventListener('click', () => { document.getElementById('assetModal').hidden = true; });

document.getElementById('assetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('assetId').value;
  const body = {
    name: document.getElementById('assetNameInput').value.trim(),
    category: document.getElementById('assetCategoryInput').value.trim(),
  };
  try {
    if (id) await api(`/api/assets/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/assets', { method: 'POST', body: JSON.stringify(body) });
    document.getElementById('assetModal').hidden = true;
    loadAssets();
  } catch (err) {
    toast(err.message, 'error');
  }
});

async function openAssetQr(id) {
  try {
    const asset = state.assets.find((a) => a.id === id);
    const { qrDataUrl } = await api(`/api/assets/${id}/qr`);
    document.getElementById('assetQrImage').src = qrDataUrl;
    document.getElementById('assetQrName').textContent = asset ? asset.name : '';
    document.getElementById('assetQrToken').textContent = asset ? asset.qrToken : '';
    document.getElementById('assetQrModal').hidden = false;
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('assetQrModalCloseBtn').addEventListener('click', () => { document.getElementById('assetQrModal').hidden = true; });

// ---------- Asset scanning (camera + jsQR) ----------
// No existing pattern in this codebase to crib from - everything else here is server
// round-trips and DOM rendering, not live camera/canvas processing. The camera stream stays
// open for the whole modal session (so scanning several items in a row doesn't re-prompt for
// permission or flicker the video each time) - only the decode loop pauses while a result is
// on screen, and both the loop and the camera stop for good when the modal closes.

let scanStream = null;
let scanRafId = null;
let scanBusy = false; // true while a result is showing or a lookup is in flight - pauses decoding
let scanModalOpen = false; // guards against getUserMedia resolving after the modal's already closed

async function openScanModal() {
  document.getElementById('scanResultPanel').innerHTML = '';
  document.getElementById('scanStatusMsg').textContent = '';
  document.getElementById('scanManualToken').value = '';
  document.getElementById('scanAssetModal').hidden = false;
  scanBusy = false;
  scanModalOpen = true;
  scanFrameCount = 0;
  if (typeof jsQR === 'undefined') {
    document.getElementById('scanStatusMsg').textContent = 'Scanner failed to load (jsQR missing) - use the code box below instead.';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    // The user may have closed the modal while the permission prompt was still up - don't
    // hand a fresh camera stream to a scan loop nothing will ever stop again.
    if (!scanModalOpen) { stream.getTracks().forEach((t) => t.stop()); return; }
    scanStream = stream;
    const video = document.getElementById('scanVideo');
    video.srcObject = scanStream;
    await video.play();
    if (!scanModalOpen) return;
    scanLoop();
  } catch (err) {
    document.getElementById('scanStatusMsg').textContent = 'Camera unavailable - enter the code below instead.';
  }
}

function closeScanModal() {
  scanModalOpen = false;
  if (scanRafId) cancelAnimationFrame(scanRafId);
  scanRafId = null;
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  document.getElementById('scanAssetModal').hidden = true;
}

// Phone cameras (especially iPhones) shoot video at a much higher resolution than a QR
// decode needs - scanning every frame at native resolution means copying and processing
// several megapixels up to 60 times a second, which can make the loop unusably slow. jsQR
// finds a code just as reliably from a much smaller frame, so every frame is downscaled to
// this before decoding.
const SCAN_MAX_DIMENSION = 480;

let scanFrameCount = 0;

function scanLoop() {
  if (scanBusy) { scanRafId = requestAnimationFrame(scanLoop); return; }
  const video = document.getElementById('scanVideo');
  const canvas = document.getElementById('scanCanvas');
  // A thrown error here (e.g. a transient canvas read failure) would otherwise kill the
  // requestAnimationFrame chain for good - the video keeps playing so the camera still looks
  // "on", but no frame is ever decoded again. Catching it and just trying the next frame is
  // what actually keeps this resilient instead of silently dying after one bad frame.
  try {
    if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth) {
      const scale = Math.min(1, SCAN_MAX_DIMENSION / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      scanFrameCount += 1;
      if (scanFrameCount % 20 === 0) {
        document.getElementById('scanStatusMsg').textContent = `Scanning… (${canvas.width}×${canvas.height}, ${scanFrameCount} frames checked)`;
      }
      if (code && code.data) {
        lookupAssetToken(code.data);
        scanRafId = requestAnimationFrame(scanLoop);
        return;
      }
    } else {
      document.getElementById('scanStatusMsg').textContent = 'Waiting for camera…';
    }
  } catch (err) {
    document.getElementById('scanStatusMsg').textContent = `Scan error: ${err.message} (retrying…)`;
  }
  scanRafId = requestAnimationFrame(scanLoop);
}

async function lookupAssetToken(token) {
  if (scanBusy) return;
  scanBusy = true;
  try {
    const asset = await api(`/api/assets/lookup/${encodeURIComponent(token)}`);
    renderScanResult(asset);
  } catch (err) {
    document.getElementById('scanStatusMsg').textContent = err.message;
    scanBusy = false;
  }
}

function renderScanResult(asset) {
  document.getElementById('scanStatusMsg').textContent = '';
  const panel = document.getElementById('scanResultPanel');
  if (asset.status === 'available') {
    const holderOptions = state.operativeUsers.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
    const jobOptions = state.jobs.map((j) => `<option value="${j.id}">${escapeHtml(j.jobReference || j.client)}</option>`).join('');
    panel.innerHTML = `
      <div class="asset-scan-result">
        <h3>${escapeHtml(asset.name)}</h3>
        <p class="hint">Available — check it out</p>
        <label>Taking it<select id="scanHolderSelect"><option value="">Choose person…</option>${holderOptions}</select></label>
        <label>Job (optional)<select id="scanJobSelect"><option value="">No specific job</option>${jobOptions}</select></label>
        <button type="button" id="scanConfirmBtn" class="primary">Check Out</button>
        <button type="button" id="scanCancelBtn">Cancel</button>
      </div>
    `;
    document.getElementById('scanConfirmBtn').addEventListener('click', async () => {
      const holderUserId = document.getElementById('scanHolderSelect').value;
      const jobId = document.getElementById('scanJobSelect').value;
      if (!holderUserId) { toast('Choose who is taking this out', 'error'); return; }
      try {
        await api(`/api/assets/${asset.id}/check-out`, { method: 'POST', body: JSON.stringify({ holderUserId, jobId: jobId || null }) });
        toast(`Checked out "${asset.name}"`, 'success');
        resumeScan();
        if (activeTab() === 'assets') loadAssets();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    document.getElementById('scanCancelBtn').addEventListener('click', resumeScan);
  } else if (asset.status === 'checked_out') {
    panel.innerHTML = `
      <div class="asset-scan-result">
        <h3>${escapeHtml(asset.name)}</h3>
        <p class="hint">Checked out to ${escapeHtml(asset.currentHolderName || '—')}${asset.currentJobReference ? ` for job ${escapeHtml(asset.currentJobReference)}` : ''} — check it in</p>
        <label><input type="radio" name="scanCondition" value="good" checked> Good condition</label>
        <label><input type="radio" name="scanCondition" value="damaged"> Damaged — send to Repairs</label>
        <label>Notes<textarea id="scanConditionNotes" rows="2"></textarea></label>
        <button type="button" id="scanConfirmBtn" class="primary">Check In</button>
        <button type="button" id="scanCancelBtn">Cancel</button>
      </div>
    `;
    document.getElementById('scanConfirmBtn').addEventListener('click', async () => {
      const condition = panel.querySelector('input[name="scanCondition"]:checked').value;
      const notes = document.getElementById('scanConditionNotes').value.trim();
      try {
        await api(`/api/assets/${asset.id}/check-in`, { method: 'POST', body: JSON.stringify({ condition, notes }) });
        toast(`Checked in "${asset.name}"`, 'success');
        resumeScan();
        if (activeTab() === 'assets') loadAssets();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    document.getElementById('scanCancelBtn').addEventListener('click', resumeScan);
  } else {
    panel.innerHTML = `
      <div class="asset-scan-result">
        <h3>${escapeHtml(asset.name)}</h3>
        <p class="hint">In repairs${asset.lastConditionNotes ? `: ${escapeHtml(asset.lastConditionNotes)}` : ''}</p>
        <button type="button" id="scanConfirmBtn" class="primary">Mark Repaired</button>
        <button type="button" id="scanCancelBtn">Cancel</button>
      </div>
    `;
    document.getElementById('scanConfirmBtn').addEventListener('click', async () => {
      try {
        await api(`/api/assets/${asset.id}/mark-repaired`, { method: 'POST' });
        toast(`Marked "${asset.name}" as repaired`, 'success');
        resumeScan();
        if (activeTab() === 'assets') loadAssets();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    document.getElementById('scanCancelBtn').addEventListener('click', resumeScan);
  }
}

function resumeScan() {
  document.getElementById('scanResultPanel').innerHTML = '';
  scanBusy = false;
}

document.getElementById('assetsScanBtn').addEventListener('click', openScanModal);
document.getElementById('scanAssetModalCloseBtn').addEventListener('click', closeScanModal);
document.getElementById('scanManualBtn').addEventListener('click', () => {
  const token = document.getElementById('scanManualToken').value.trim();
  if (token) lookupAssetToken(token);
});

// ---------- Signage Tracker ----------
// Shared inventory of site signs (no admin gate, unlike Hire, except removing a sign).
// Each sign links to the job it's currently out at; no job means it's back in the yard
// and available to go out again.

let editingSignageId = null;

function signageJobLabel(job) {
  return `${job.jobReference || '(no ref)'} - ${job.location || '(no location)'}`;
}

function signageJobOptions(s) {
  return state.jobs
    .slice()
    .sort((a, b) => signageJobLabel(a).localeCompare(signageJobLabel(b)))
    .map((j) => `<option value="${j.id}" ${s.jobId === j.id ? 'selected' : ''}>${escapeHtml(signageJobLabel(j))}</option>`)
    .join('');
}

function signageEditRow(s) {
  return `
    <tr data-id="${s.id}">
      <td><input type="text" class="signage-edit-label" value="${escapeHtml(s.label)}"></td>
      <td>
        <select class="signage-edit-job">
          <option value="">— Available —</option>
          ${signageJobOptions(s)}
        </select>
      </td>
      <td><input type="text" class="signage-edit-notes" value="${escapeHtml(s.notes)}"></td>
      <td class="row-actions">
        <button type="button" class="primary signage-save-btn">Save</button>
        <button type="button" class="signage-cancel-btn">Cancel</button>
      </td>
    </tr>
  `;
}

function signageDisplayRow(s) {
  const job = state.jobs.find((j) => j.id === s.jobId);
  const available = !job;
  return `
    <tr>
      <td>${escapeHtml(s.label)}</td>
      <td><span class="signage-status ${available ? 'available' : 'out'}">${available ? 'Available' : escapeHtml(signageJobLabel(job))}</span></td>
      <td>${escapeHtml(s.notes || '—')}</td>
      <td class="row-actions">
        <button type="button" data-edit-signage="${s.id}">Edit</button>
        ${isAdmin() ? `<button type="button" class="danger" data-del-signage="${s.id}">Remove</button>` : ''}
      </td>
    </tr>
  `;
}

function renderSignage() {
  const available = state.signage.filter((s) => !s.jobId || !state.jobs.some((j) => j.id === s.jobId)).length;
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
        jobId: tr.querySelector('.signage-edit-job').value,
        notes: tr.querySelector('.signage-edit-notes').value.trim(),
      };
      try {
        await api(`/api/signage/${tr.dataset.id}`, { method: 'PUT', body: JSON.stringify(body) });
        editingSignageId = null;
        state.signage = await api('/api/signage');
        renderSignage();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
  tbody.querySelectorAll('[data-del-signage]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this sign? This cannot be undone.')) return;
      try {
        await api(`/api/signage/${btn.dataset.delSignage}`, { method: 'DELETE' });
        state.signage = await api('/api/signage');
        renderSignage();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

document.getElementById('signageAddForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const label = document.getElementById('signageLabelInput').value.trim();
  try {
    await api('/api/signage', { method: 'POST', body: JSON.stringify({ label }) });
    e.target.reset();
    state.signage = await api('/api/signage');
    renderSignage();
  } catch (err) {
    toast(err.message, 'error');
  }
});

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
        toast(err.message, 'error');
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
        toast(err.message, 'error');
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
        toast(err.message, 'error');
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
    toast(err.message, 'error');
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

// Reshapes a job assignment into the same event-ish shape createCalendarView's chips/day
// list already know how to render, flagged isAssignment so both spots can style/behave
// differently (fixed-colour chip, no delete button, "View" opens the assignment detail
// modal instead of a plain text row).
function assignmentToCalEvent(a) {
  return {
    id: `assignment-${a.id}`,
    assignmentId: a.id,
    isAssignment: true,
    userId: a.userId,
    userName: a.userName,
    date: a.startDate,
    endDate: a.endDate,
    title: `${a.jobReference ? a.jobReference + ' — ' : ''}${a.task}`,
    isPrivate: true,
    completed: a.completed,
    jobId: a.jobId,
  };
}

// Builds one calendar (month grid + day modal + add form) wired to its own set of DOM ids.
// Used once for the shared team calendar and once for the private "My Calendar" - same
// month-grid/day-modal behaviour, just scoped to a different slice of state.calendarEvents.
function createCalendarView({ scope, ids }) {
  let viewYear = calToday.getFullYear();
  let viewMonth = calToday.getMonth();
  let selectedDate = null;

  // "My Calendar" is everything that's yours - your private entries plus anything you've put
  // on the shared team calendar, so your day is in one place without duplicating any rows.
  // Operatives additionally get their job assignments merged in (read-only, see
  // assignmentToCalEvent) - never on the shared team calendar, which operatives don't have.
  function eventsOnDate(ds) {
    const personal = state.calendarEvents.filter((e) => {
      const include = scope === 'private'
        ? !!(state.currentUser && e.userId === state.currentUser.id)
        : !e.isPrivate;
      if (!include) return false;
      return ds >= e.date && ds <= e.endDate;
    });
    if (scope !== 'private' || !isOperative()) return personal;
    const assignments = state.myAssignments
      .filter((a) => ds >= a.startDate && ds <= a.endDate)
      .map(assignmentToCalEvent);
    return [...personal, ...assignments];
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
      // Holidays get folded into a single summary chip rather than one chip per person -
      // with ~20 staff, everyone booking leave on the same day would otherwise bury the
      // actual jobs/meetings behind a wall of "+N more".
      const holidayEvents = dayEvents.filter((e) => e.isHoliday);
      const otherEvents = dayEvents.filter((e) => !e.isHoliday);
      const chips = otherEvents.slice(0, MAX_CHIPS).map((e) => e.isAssignment
        ? `<div class="cal-chip cal-chip-assignment" title="${escapeHtml(e.title)} (${e.completed ? 'Done' : 'Pending'})">${escapeHtml(truncate(e.title, 20))}</div>`
        : `<div class="cal-chip" style="background:${userColor(e)}" title="${escapeHtml(e.userName)}: ${escapeHtml(e.title)} (${formatWhen(e)})">${scope === 'private' ? escapeHtml(truncate(e.title, 20)) : `${escapeHtml(e.userName)}: ${escapeHtml(truncate(e.title, 16))}`}</div>`
      ).join('');
      const more = otherEvents.length > MAX_CHIPS ? `<div class="cal-chip-more">+${otherEvents.length - MAX_CHIPS} more</div>` : '';
      const holidayChip = holidayEvents.length === 0 ? '' : holidayEvents.length === 1
        ? `<div class="cal-chip cal-chip-holiday" title="${escapeHtml(holidayEvents[0].userName)}: ${escapeHtml(holidayEvents[0].title)}">🏖 ${scope === 'private' ? escapeHtml(truncate(holidayEvents[0].title, 20)) : escapeHtml(holidayEvents[0].userName)}</div>`
        : `<div class="cal-chip cal-chip-holiday" title="${escapeHtml(holidayEvents.map((e) => e.userName).join(', '))}">🏖 ${holidayEvents.length} on holiday</div>`;
      return `
        <div class="cal-cell${isToday ? ' cal-cell-today' : ''}" data-date="${ds}" role="button" tabindex="0" aria-label="${ds}${isToday ? ', today' : ''}">
          <div class="cal-cell-date">${d}${isToday ? '<span class="cal-today-badge">Today</span>' : ''}</div>
          <div class="cal-cell-events">${holidayChip}${chips}${more}</div>
        </div>
      `;
    }).join('');

    grid.querySelectorAll('.cal-cell[data-date]').forEach((cell) => {
      cell.addEventListener('click', () => openDayModal(cell.dataset.date));
      cell.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        openDayModal(cell.dataset.date);
      });
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
    syncHolidayFields();
    document.getElementById(ids.modal).hidden = false;
  }

  function renderDayEvents() {
    const events = eventsOnDate(selectedDate);
    const list = document.getElementById(ids.eventsList);
    list.innerHTML = events.map((e) => e.isAssignment ? `
      <li class="cal-day-event-item cal-day-event-assignment">
        <span class="cal-swatch cal-swatch-assignment"></span>
        <div class="cal-day-event-body">
          <div class="cal-day-event-title">${escapeHtml(e.title)}</div>
          <div class="cal-day-event-meta">${e.date} to ${e.endDate} · <span class="status-pill ${e.completed ? 'complete' : 'in-progress'}">${e.completed ? 'Done' : 'Pending'}</span></div>
        </div>
        <button type="button" class="assignment-view-btn" data-assignment="${e.assignmentId}">View</button>
      </li>
    ` : `
      <li class="cal-day-event-item">
        <span class="cal-swatch" style="background:${userColor(e)}"></span>
        <div class="cal-day-event-body">
          <div class="cal-day-event-title">${e.isHoliday ? '🏖 ' : ''}${escapeHtml(e.title)}${scope === 'private' && !e.isPrivate ? ' <span class="cal-today-badge" title="Also visible to everyone on the team calendar">Team</span>' : ''}</div>
          <div class="cal-day-event-meta">${scope === 'private' ? '' : `${escapeHtml(e.userName)} · `}${formatWhen(e)}${e.date !== e.endDate ? ` · ${e.date} to ${e.endDate}` : ''}</div>
        </div>
        ${(state.currentUser && (state.currentUser.id === e.userId || state.currentUser.role === 'admin')) ? `<button type="button" class="danger cal-day-event-delete" data-id="${e.id}">Delete</button>` : ''}
      </li>
    `).join('');
    document.getElementById(ids.emptyState).hidden = events.length !== 0;

    list.querySelectorAll('.assignment-view-btn').forEach((btn) => {
      btn.addEventListener('click', () => openAssignmentDetail(btn.dataset.assignment));
    });

    list.querySelectorAll('.cal-day-event-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this calendar entry?')) return;
        try {
          await api(`/api/calendar/${btn.dataset.id}`, { method: 'DELETE' });
          state.calendarEvents = await api('/api/calendar');
          renderDayEvents();
          render();
        } catch (err) {
          toast(err.message, 'error');
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
    if (isAdmin()) {
      document.getElementById(ids.holidayFor).innerHTML = '<option value="">Myself</option>'
        + state.operativeUsers.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
    }
    document.getElementById(ids.addTitle).focus();
  });

  // Toggles between a specific start/end time (same day) and a number-of-days field
  // depending on what's picked in the "When" dropdown.
  function syncKindFields() {
    const kind = document.getElementById(ids.kind).value;
    document.getElementById(ids.timeFields).hidden = kind !== 'time';
    document.getElementById(ids.daysFields).hidden = kind !== 'days';
  }
  document.getElementById(ids.kind).addEventListener('change', syncKindFields);

  // A holiday always spans whole days and is always visible to everyone (see
  // createCalendarEvent in db.js) - not a per-entry choice like an ordinary event - so this
  // hides the "When" picker entirely and forces it to "days" rather than asking. Admins
  // additionally get a "Holiday for" picker to log one on someone else's behalf.
  function syncHolidayFields() {
    const isHoliday = document.getElementById(ids.typeSelect).value === 'holiday';
    const kindSelect = document.getElementById(ids.kind);
    kindSelect.closest('label').hidden = isHoliday;
    if (isHoliday) kindSelect.value = 'days';
    syncKindFields();
    document.getElementById(ids.holidayForWrap).hidden = !isHoliday || !isAdmin();
  }
  document.getElementById(ids.typeSelect).addEventListener('change', syncHolidayFields);

  document.getElementById(ids.addCancelBtn).addEventListener('click', () => {
    document.getElementById(ids.addForm).reset();
    document.getElementById(ids.addForm).hidden = true;
    document.getElementById(ids.addBtn).hidden = false;
    syncHolidayFields();
  });

  document.getElementById(ids.addForm).addEventListener('submit', async (e) => {
    e.preventDefault();
    const isHoliday = document.getElementById(ids.typeSelect).value === 'holiday';
    const kind = isHoliday ? 'days' : document.getElementById(ids.kind).value;
    const payload = {
      date: selectedDate,
      title: document.getElementById(ids.addTitle).value,
      durationUnit: kind,
      isPrivate: scope === 'private',
      isHoliday,
    };
    if (kind === 'days') {
      payload.durationValue = document.getElementById(ids.addDurationValue).value;
    } else {
      payload.startTime = document.getElementById(ids.addStartTime).value;
      payload.endTime = document.getElementById(ids.addEndTime).value;
    }
    if (isHoliday && isAdmin()) {
      const forUserId = document.getElementById(ids.holidayFor).value;
      if (forUserId) payload.userId = forUserId;
    }
    try {
      await api('/api/calendar', { method: 'POST', body: JSON.stringify(payload) });
      state.calendarEvents = await api('/api/calendar');
      document.getElementById(ids.addForm).reset();
      document.getElementById(ids.addForm).hidden = true;
      document.getElementById(ids.addBtn).hidden = false;
      syncHolidayFields();
      renderDayEvents();
      render();
    } catch (err) {
      toast(err.message, 'error');
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
    typeSelect: 'calDayAddType', holidayForWrap: 'calDayAddHolidayForWrap', holidayFor: 'calDayAddHolidayFor',
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
    typeSelect: 'myCalDayAddType', holidayForWrap: 'myCalDayAddHolidayForWrap', holidayFor: 'myCalDayAddHolidayFor',
  },
});

function renderCalendar() {
  teamCalendar.render();
  myCalendar.render();
}

// ---------- Assignment Detail (operative self-service: view, upload photo, mark done) ----------

let currentAssignmentId = null;

function findMyAssignment(id) {
  return state.myAssignments.find((a) => a.id === id);
}

let currentAssignmentTimeLog = null;
let currentAssignmentRams = null;
let currentAssignmentRamsStatus = null;

async function openAssignmentDetail(id) {
  currentAssignmentId = id;
  currentAssignmentTimeLog = null; // avoid briefly showing the previously-open assignment's clock state
  currentAssignmentRams = null;
  currentAssignmentRamsStatus = null;
  renderAssignmentDetail();
  renderAssignmentTimeLog();
  renderAssignmentRamsStatus();
  document.getElementById('assignmentDetailModal').hidden = false;
  await Promise.all([refreshAssignmentTimeLog(), refreshAssignmentRams()]);
}

function renderAssignmentDetail() {
  const a = findMyAssignment(currentAssignmentId);
  if (!a) { document.getElementById('assignmentDetailModal').hidden = true; return; }
  document.getElementById('assignmentDetailTitle').textContent = `${a.jobReference || a.jobClient}${a.jobLocation ? ' — ' + a.jobLocation : ''}`;
  document.getElementById('assignmentDetailInfo').innerHTML = `
    <div><dt>Task</dt><dd>${escapeHtml(a.task)}</dd></div>
    <div><dt>Start Date</dt><dd>${a.startDate}</dd></div>
    <div><dt>Duration</dt><dd>${a.durationDays} day${a.durationDays === 1 ? '' : 's'}</dd></div>
    <div><dt>Status</dt><dd><span class="status-pill ${a.completed ? 'complete' : 'in-progress'}">${a.completed ? 'Done' : 'Pending'}</span></dd></div>
  `;
  const completeBtn = document.getElementById('assignmentCompleteBtn');
  completeBtn.textContent = a.completed ? 'Mark as Not Done' : 'Mark as Done';
  // Un-completing is always allowed (no time-log dependency); completing requires today's
  // arrival to already be logged, since that's what makes the on-site duration meaningful -
  // see setJobAssignmentCompleted in db.js, which enforces this server-side regardless.
  const canComplete = a.completed || !!(currentAssignmentTimeLog && currentAssignmentTimeLog.arrivedAt);
  completeBtn.disabled = !canComplete;
  completeBtn.title = canComplete ? '' : 'Clock in and mark yourself as arrived first';
}

function timeOfDay(iso) {
  return iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null;
}

function renderAssignmentTimeLog() {
  const log = currentAssignmentTimeLog;
  const box = document.getElementById('assignmentTimeLog');
  const clockedIn = log && log.clockInAt;
  const arrived = log && log.arrivedAt;
  const clockedOut = log && log.clockOutAt;

  box.innerHTML = `
    <h3>Today's Time Log</h3>
    <div class="time-log-row">
      <div class="time-log-step">
        <span class="time-log-label">Clock In</span>
        ${clockedIn
          ? `<span class="time-log-value">${timeOfDay(log.clockInAt)}</span>`
          : `<button type="button" id="assignmentClockInBtn">Clock In</button>`}
      </div>
      <div class="time-log-step">
        <span class="time-log-label">Arrived</span>
        ${arrived
          ? `<span class="time-log-value">${timeOfDay(log.arrivedAt)}</span>`
          : (() => {
              // Job-level, not per-assignment - see renderAssignmentRamsStatus/db.js markArrived.
              const ramsDone = !!(currentAssignmentRams || (currentAssignmentRamsStatus && currentAssignmentRamsStatus.jobHasRams));
              const canMarkArrived = clockedIn && ramsDone;
              const title = !clockedIn ? 'Clock in first' : !ramsDone ? 'Submit your RAMS first' : '';
              return `<button type="button" id="assignmentArrivedBtn" ${canMarkArrived ? '' : 'disabled'} title="${title}">Mark Arrived</button>`;
            })()}
      </div>
      <div class="time-log-step">
        <span class="time-log-label">Clock Out</span>
        ${clockedOut
          ? `<span class="time-log-value">${timeOfDay(log.clockOutAt)}</span>`
          : `<button type="button" id="assignmentClockOutBtn" ${clockedIn ? '' : 'disabled'} title="${clockedIn ? '' : 'Clock in first'}">Clock Out</button>`}
      </div>
    </div>
    ${log && log.onSiteMinutes != null
      ? `<p class="time-log-duration">On site for ${Math.floor(log.onSiteMinutes / 60)}h ${log.onSiteMinutes % 60}m</p>`
      : ''}
  `;

  const clockInBtn = document.getElementById('assignmentClockInBtn');
  if (clockInBtn) clockInBtn.addEventListener('click', () => runTimeLogAction('clock-in'));
  const arrivedBtn = document.getElementById('assignmentArrivedBtn');
  if (arrivedBtn) arrivedBtn.addEventListener('click', () => runTimeLogAction('arrived'));
  const clockOutBtn = document.getElementById('assignmentClockOutBtn');
  if (clockOutBtn) clockOutBtn.addEventListener('click', () => runTimeLogAction('clock-out'));
}

const TIME_LOG_ACTION_LABELS = { 'clock-in': 'Clocked in.', arrived: 'Marked as arrived.', 'clock-out': 'Clocked out.' };

async function runTimeLogAction(action) {
  try {
    await api(`/api/job-assignments/${currentAssignmentId}/time/${action}`, { method: 'POST' });
    await refreshAssignmentTimeLog();
    toast(TIME_LOG_ACTION_LABELS[action] || 'Saved.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function refreshAssignmentTimeLog() {
  try {
    const logs = await api(`/api/job-assignments/${currentAssignmentId}/time-logs`);
    currentAssignmentTimeLog = logs.find((l) => l.logDate === todayDateStr()) || null;
  } catch (err) {
    currentAssignmentTimeLog = null;
  }
  renderAssignmentTimeLog();
  renderAssignmentDetail();
}

async function refreshAssignmentRams() {
  try {
    currentAssignmentRams = await api(`/api/job-assignments/${currentAssignmentId}/rams`);
  } catch (err) {
    currentAssignmentRams = null;
  }
  try {
    currentAssignmentRamsStatus = await api(`/api/job-assignments/${currentAssignmentId}/rams-status`);
  } catch (err) {
    currentAssignmentRamsStatus = null;
  }
  renderAssignmentRamsStatus();
  renderAssignmentTimeLog(); // the Arrived button's disabled state depends on these too
}

// RAMS is required once per JOB, not once per operative on it - if it's already on file
// (an office upload, or a teammate's own submission on a different assignment against the
// same job) nothing is required here at all, just links to read what's there. Only when the
// job has nothing yet does this operative need to fill in the dynamic form themselves - see
// db.js's getJobAssignmentRamsStatus/markArrived for the matching server-side logic.
// Once THIS operative has actually submitted their own, it also locks once they've marked
// themselves arrived (see the matching server-side check in db.js createJobAssignmentRams) -
// after that the button just opens a read-only view rather than the editable form.
function renderAssignmentRamsStatus() {
  const box = document.getElementById('assignmentRamsStatus');
  const btn = document.getElementById('assignmentRamsBtn');
  const locked = !!(currentAssignmentTimeLog && currentAssignmentTimeLog.arrivedAt);
  const jobDocs = (currentAssignmentRamsStatus && currentAssignmentRamsStatus.documents) || [];

  if (currentAssignmentRams) {
    // "Attach to Job Documents" is a manual retry in case the automatic upload (on save) ever
    // missed - lets the operative fix it themselves rather than needing an admin, same action
    // as ramsAttachToJobBtn in the admin RAMS viewer.
    box.innerHTML = `
      <span class="status-pill complete">RAMS submitted ${new Date(currentAssignmentRams.createdAt).toLocaleDateString('en-GB')}${locked ? ' (locked)' : ''}</span>
      <button type="button" id="assignmentRamsAttachBtn" class="link-btn">Attach to Job Documents</button>
    `;
    document.getElementById('assignmentRamsAttachBtn').addEventListener('click', async () => {
      try {
        await api(`/api/job-assignments/${currentAssignmentId}/rams/attach-to-job`, { method: 'POST' });
        toast('Attached to the job\'s documents.', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    btn.hidden = false;
    btn.textContent = locked ? 'View RAMS' : 'View / Edit RAMS';
  } else if (jobDocs.length) {
    box.innerHTML = `
      <span class="status-pill complete">RAMS already on file for this job</span>
      ${jobDocs.map((d) => `<a class="link-btn" href="/api/job-assignments/${currentAssignmentId}/rams-status/${d.id}/file" target="_blank" rel="noopener">View ${escapeHtml(d.originalName)}</a>`).join('')}
    `;
    btn.hidden = true; // nothing for this operative to fill in - the links above cover it
  } else {
    box.innerHTML = `<span class="status-pill in-progress">RAMS required before Mark Arrived</span>`;
    btn.hidden = false;
    btn.textContent = 'RAMS (required)';
  }
}

document.getElementById('assignmentDetailCloseBtn').addEventListener('click', () => {
  document.getElementById('assignmentDetailModal').hidden = true;
});

document.getElementById('assignmentCompleteBtn').addEventListener('click', async () => {
  const a = findMyAssignment(currentAssignmentId);
  if (!a) return;
  try {
    await api(`/api/job-assignments/${a.id}/complete`, { method: 'PUT', body: JSON.stringify({ completed: !a.completed }) });
    state.myAssignments = await api('/api/job-assignments/mine');
    await refreshAssignmentTimeLog();
    renderCalendar();
    renderHomeDashboard();
    renderMyAssignmentsTab();
    toast(a.completed ? 'Marked as not done.' : 'Marked as done.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('assignmentPhotoInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch(`/api/job-assignments/${currentAssignmentId}/photo`, { method: 'POST', body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Upload failed');
    }
    toast('Photo uploaded.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    e.target.value = '';
  }
});

// ---------- Permit to Work (filled in-app, saved straight onto the job - see the
// POST /api/job-assignments/:id/permit route, which generates the PDF server-side from
// these values so there's no separate download/fill-externally/upload-back step). ----------

// A finger/stylus/mouse signature pad backed by a <canvas> - pointer events unify touch,
// pen and mouse input in one listener set, which is what actually needs to work here since
// this is signed on iPads/phones. touch-action:none on the canvas (see style.css) stops the
// page scrolling while someone's mid-signature. Coordinates are rescaled from the canvas's
// on-screen CSS size to its internal pixel size, since the two can differ (e.g. the pad
// renders narrower than 495px on a phone) - without that, drawing would land in the wrong
// place on any screen narrower than the pad's native resolution.
function createSignaturePad(canvasId) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#0c2233';

  let drawing = false;
  let hasDrawn = false;

  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drawing = true;
    hasDrawn = true;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    e.preventDefault();
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });

  ['pointerup', 'pointerleave', 'pointercancel'].forEach((evt) => {
    canvas.addEventListener(evt, () => { drawing = false; });
  });

  return {
    clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      hasDrawn = false;
    },
    isEmpty() { return !hasDrawn; },
    toDataUrl() { return canvas.toDataURL('image/png'); },
  };
}

const operativeSignaturePad = createSignaturePad('permitOperativeSignatureCanvas');
const managerSignaturePad = createSignaturePad('permitManagerSignatureCanvas');
const ramsSignaturePad = createSignaturePad('ramsSignatureCanvas');
const signaturePadsByCanvasId = {
  permitOperativeSignatureCanvas: operativeSignaturePad,
  permitManagerSignatureCanvas: managerSignaturePad,
  ramsSignatureCanvas: ramsSignaturePad,
};

document.querySelectorAll('.signature-clear-btn').forEach((btn) => {
  const pad = signaturePadsByCanvasId[btn.dataset.target];
  btn.addEventListener('click', () => pad.clear());
});

document.getElementById('assignmentPermitBtn').addEventListener('click', () => {
  const a = findMyAssignment(currentAssignmentId);
  if (!a) return;
  document.getElementById('permitSiteName').value = a.jobLocation || a.jobClient || '';
  document.getElementById('permitJobNumber').value = a.jobReference || '';
  document.getElementById('permitDescription').value = a.task || '';
  document.getElementById('permitDate').value = todayDateStr();
  document.getElementById('permitOperativeName').value = state.currentUser.name || '';
  document.getElementById('permitManagerName').value = '';
  operativeSignaturePad.clear();
  managerSignaturePad.clear();
  document.getElementById('permitFormModal').hidden = false;
});

function closePermitForm() {
  document.getElementById('permitFormModal').hidden = true;
}

document.getElementById('permitFormCloseBtn').addEventListener('click', closePermitForm);
document.getElementById('permitFormCancelBtn').addEventListener('click', closePermitForm);

document.getElementById('permitForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (operativeSignaturePad.isEmpty() || managerSignaturePad.isEmpty()) {
    toast('Both the operative and manager need to sign before saving.', 'error');
    return;
  }
  try {
    await api(`/api/job-assignments/${currentAssignmentId}/permit`, {
      method: 'POST',
      body: JSON.stringify({
        siteName: document.getElementById('permitSiteName').value,
        jobNumber: document.getElementById('permitJobNumber').value,
        description: document.getElementById('permitDescription').value,
        date: document.getElementById('permitDate').value,
        operativeName: document.getElementById('permitOperativeName').value,
        operativeSignatureImage: operativeSignaturePad.toDataUrl(),
        managerName: document.getElementById('permitManagerName').value,
        managerSignatureImage: managerSignaturePad.toDataUrl(),
      }),
    });
    closePermitForm();
    toast('Permit to Work saved.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- RAMS form (operative self-service) ----------
// One RAMS per assignment - the operative picks hazards from the generic templates
// (state.riskAssessments, same list the admin Risk Assessments tab uses) and adjusts them for
// today, same editable-fields shape as raEditFormHtml but repeatable per hazard. Locks once
// they've marked themselves arrived (see renderAssignmentRamsStatus) - the form still opens but
// read-only past that point, same reasoning as the server-side lock in db.js.

let ramsHazardBlocks = [];
let ramsLocalIdSeq = 0;
let ramsFormLocked = false;

// Filling this form out (per-hazard controls, L/C ratings, PPE, method statement, signature)
// takes several minutes of one-thumb typing on site, and Close/Cancel used to discard it
// outright with no warning. Rather than add a confirm-to-discard prompt, we just keep it
// saved locally as they type and restore it next time they open the form for this
// assignment - so an accidental tap, dropped signal, or closed tab never loses the work.
function ramsDraftKey(assignmentId) {
  return `ramsDraft:${assignmentId}`;
}

function saveRamsDraft() {
  if (ramsFormLocked || !currentAssignmentId) return;
  const draft = {
    methodStatement: document.getElementById('ramsMethodStatement').value,
    operativeName: document.getElementById('ramsOperativeName').value,
    hazards: readRamsHazardBlocks(),
  };
  try {
    localStorage.setItem(ramsDraftKey(currentAssignmentId), JSON.stringify(draft));
  } catch {
    // localStorage unavailable/full - autosave is a convenience, not a hard requirement
  }
}

function loadRamsDraft(assignmentId) {
  try {
    const raw = localStorage.getItem(ramsDraftKey(assignmentId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearRamsDraft(assignmentId) {
  try {
    localStorage.removeItem(ramsDraftKey(assignmentId));
  } catch {
    // ignore
  }
}

function ramsHazardBlockHtml(h) {
  return `
    <div class="rams-hazard-block" data-local-id="${h.localId}">
      <div class="rams-hazard-block-header">
        <h4>${escapeHtml(h.title)}</h4>
        <div class="rams-hazard-block-header-actions">
          <button type="button" class="link-btn rams-minimise-hazard-btn">Minimise</button>
          ${ramsFormLocked ? '' : `<button type="button" class="link-btn rams-remove-hazard-btn" data-local-id="${h.localId}">Remove</button>`}
        </div>
      </div>
      <div class="rams-hazard-block-body">
        ${h.legislation ? `<p class="hint">${escapeHtml(h.legislation)}</p>` : ''}
        <div class="ra-edit-badges rams-hazard-badges"></div>
        <label>Hazard &amp; Potential Harm<textarea class="rams-hazard-hazard" rows="2" ${ramsFormLocked ? 'disabled' : ''}>${escapeHtml(h.hazard || '')}</textarea></label>
        <label>Who Might Be Harmed<input type="text" class="rams-hazard-peopleaffected" value="${escapeHtml(h.peopleAffected || '')}" ${ramsFormLocked ? 'disabled' : ''}></label>
        <div class="ra-edit-grid">
          <label>Current Risk Controls (one per line)<textarea class="rams-hazard-currentcontrols" rows="4" ${ramsFormLocked ? 'disabled' : ''}>${escapeHtml((h.currentControls || []).join('\n'))}</textarea></label>
          <label>Additional Risk Controls (one per line)<textarea class="rams-hazard-additionalcontrols" rows="4" ${ramsFormLocked ? 'disabled' : ''}>${escapeHtml((h.additionalControls || []).join('\n'))}</textarea></label>
        </div>
        <div class="ra-edit-grid ra-edit-lc">
          <label>Current L<input type="number" class="rams-hazard-currentl" min="1" max="5" value="${h.currentL}" ${ramsFormLocked ? 'disabled' : ''}></label>
          <label>Current C<input type="number" class="rams-hazard-currentc" min="1" max="5" value="${h.currentC}" ${ramsFormLocked ? 'disabled' : ''}></label>
          <label>Additional L<input type="number" class="rams-hazard-additionall" min="1" max="5" value="${h.additionalL}" ${ramsFormLocked ? 'disabled' : ''}></label>
          <label>Additional C<input type="number" class="rams-hazard-additionalc" min="1" max="5" value="${h.additionalC}" ${ramsFormLocked ? 'disabled' : ''}></label>
        </div>
        <label>PPE Required (one per line)<textarea class="rams-hazard-ppe" rows="3" ${ramsFormLocked ? 'disabled' : ''}>${escapeHtml((h.ppe || []).join('\n'))}</textarea></label>
      </div>
    </div>
  `;
}

function updateRamsHazardBadge(block) {
  const cl = Number(block.querySelector('.rams-hazard-currentl').value) || 1;
  const cc = Number(block.querySelector('.rams-hazard-currentc').value) || 1;
  const al = Number(block.querySelector('.rams-hazard-additionall').value) || 1;
  const ac = Number(block.querySelector('.rams-hazard-additionalc').value) || 1;
  const currentR = cl * cc;
  const additionalR = al * ac;
  const currentBand = raBandClient(currentR);
  const additionalBand = raBandClient(additionalR);
  block.querySelector('.rams-hazard-badges').innerHTML = `
    <span class="risk-badge ${currentBand.slug}">Current: ${cl} × ${cc} = ${currentR} — ${escapeHtml(currentBand.label)}</span>
    <span class="risk-badge ${additionalBand.slug}">With additional controls: ${al} × ${ac} = ${additionalR} — ${escapeHtml(additionalBand.label)}</span>
  `;
}

function renderRamsHazardBlocks() {
  const container = document.getElementById('ramsHazardBlocks');
  document.getElementById('ramsHazardsEmptyState').hidden = !!ramsHazardBlocks.length;
  container.innerHTML = ramsHazardBlocks.map(ramsHazardBlockHtml).join('');
  container.querySelectorAll('.rams-hazard-block').forEach((block) => {
    updateRamsHazardBadge(block);
    block.querySelectorAll('.rams-hazard-currentl, .rams-hazard-currentc, .rams-hazard-additionall, .rams-hazard-additionalc')
      .forEach((input) => input.addEventListener('input', () => updateRamsHazardBadge(block)));
  });
  container.querySelectorAll('.rams-remove-hazard-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      ramsHazardBlocks = ramsHazardBlocks.filter((h) => h.localId !== btn.dataset.localId);
      renderRamsHazardBlocks();
      saveRamsDraft();
    });
  });
  // Pure DOM toggle, deliberately not a re-render - re-rendering would rebuild every block's
  // HTML from ramsHazardBlocks, which only holds each hazard's starting values, wiping out
  // whatever the operative has typed into other blocks that hasn't been read back yet (that
  // only happens at submit time, see readRamsHazardBlocks).
  container.querySelectorAll('.rams-minimise-hazard-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const block = btn.closest('.rams-hazard-block');
      const collapsed = block.classList.toggle('collapsed');
      btn.textContent = collapsed ? 'Expand' : 'Minimise';
    });
  });
}

function readRamsHazardBlocks() {
  return [...document.querySelectorAll('#ramsHazardBlocks .rams-hazard-block')].map((block) => {
    const source = ramsHazardBlocks.find((h) => h.localId === block.dataset.localId) || {};
    return {
      id: source.id || null,
      title: source.title || '',
      legislation: source.legislation || '',
      hazard: block.querySelector('.rams-hazard-hazard').value.trim(),
      peopleAffected: block.querySelector('.rams-hazard-peopleaffected').value.trim(),
      currentControls: linesToList(block.querySelector('.rams-hazard-currentcontrols').value),
      currentL: Number(block.querySelector('.rams-hazard-currentl').value) || 1,
      currentC: Number(block.querySelector('.rams-hazard-currentc').value) || 1,
      additionalControls: linesToList(block.querySelector('.rams-hazard-additionalcontrols').value),
      additionalL: Number(block.querySelector('.rams-hazard-additionall').value) || 1,
      additionalC: Number(block.querySelector('.rams-hazard-additionalc').value) || 1,
      ppe: linesToList(block.querySelector('.rams-hazard-ppe').value),
    };
  });
}

document.getElementById('ramsAddHazardBtn').addEventListener('click', () => {
  const picker = document.getElementById('ramsHazardPicker');
  const raId = picker.value;
  if (!raId) return;
  if (ramsHazardBlocks.some((h) => h.id === raId)) { picker.value = ''; return; }
  const ra = state.riskAssessments.find((r) => r.id === raId);
  if (!ra) return;
  ramsHazardBlocks.push({
    localId: String(ramsLocalIdSeq++),
    id: ra.id,
    title: ra.title,
    legislation: ra.legislation || '',
    hazard: ra.hazard || '',
    peopleAffected: ra.peopleAffected || '',
    currentControls: ra.currentControls || [],
    currentL: ra.currentL,
    currentC: ra.currentC,
    additionalControls: ra.additionalControls || [],
    additionalL: ra.additionalL,
    additionalC: ra.additionalC,
    ppe: ra.ppe || [],
  });
  picker.value = '';
  renderRamsHazardBlocks();
  saveRamsDraft();
});

// Delegated so it covers every hazard block's fields (re-rendered per add/remove) plus the
// method statement and name, without wiring a listener to each one individually.
document.getElementById('ramsForm').addEventListener('input', saveRamsDraft);

document.getElementById('assignmentRamsBtn').addEventListener('click', () => {
  const a = findMyAssignment(currentAssignmentId);
  if (!a) return;
  ramsFormLocked = !!(currentAssignmentTimeLog && currentAssignmentTimeLog.arrivedAt);

  document.getElementById('ramsHazardPicker').innerHTML = '<option value="">Add a hazard…</option>'
    + state.riskAssessments.map((ra) => `<option value="${ra.id}">${escapeHtml(ra.title)}</option>`).join('');

  if (currentAssignmentRams) {
    document.getElementById('ramsMethodStatement').value = currentAssignmentRams.methodStatement;
    document.getElementById('ramsOperativeName').value = currentAssignmentRams.operativeName;
    ramsHazardBlocks = currentAssignmentRams.hazards.map((h) => ({ localId: String(ramsLocalIdSeq++), ...h }));
  } else {
    document.getElementById('ramsMethodStatement').value = '';
    document.getElementById('ramsOperativeName').value = state.currentUser.name || '';
    ramsHazardBlocks = [];
  }

  // An unsaved draft (see saveRamsDraft) always wins over the last-submitted server copy -
  // it can only exist if they typed something after that, so it's the more recent state.
  const draft = ramsFormLocked ? null : loadRamsDraft(currentAssignmentId);
  if (draft) {
    document.getElementById('ramsMethodStatement').value = draft.methodStatement;
    document.getElementById('ramsOperativeName').value = draft.operativeName;
    ramsHazardBlocks = draft.hazards.map((h) => ({ localId: String(ramsLocalIdSeq++), ...h }));
  }

  renderRamsHazardBlocks();
  ramsSignaturePad.clear();

  document.getElementById('ramsMethodStatement').disabled = ramsFormLocked;
  document.getElementById('ramsOperativeName').disabled = ramsFormLocked;
  document.getElementById('ramsHazardPicker').disabled = ramsFormLocked;
  document.getElementById('ramsAddHazardBtn').disabled = ramsFormLocked;
  document.querySelector('#ramsForm button[type="submit"]').hidden = ramsFormLocked;
  document.querySelector('#ramsFormModal .hint').textContent = ramsFormLocked
    ? "RAMS is locked once you've marked yourself arrived - this is a read-only record. Ask an admin if it needs changing."
    : 'Complete this before marking yourself as arrived on site. Pick every hazard that applies to this job and adjust the controls/likelihood/consequence for today if needed.';

  document.getElementById('ramsFormModal').hidden = false;
});

function closeRamsForm() {
  document.getElementById('ramsFormModal').hidden = true;
}

document.getElementById('ramsFormCloseBtn').addEventListener('click', closeRamsForm);
document.getElementById('ramsFormCancelBtn').addEventListener('click', closeRamsForm);

document.getElementById('ramsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (ramsFormLocked) return;
  const methodStatement = document.getElementById('ramsMethodStatement').value.trim();
  if (!methodStatement) { toast('Fill in the method statement.', 'error'); return; }
  const hazards = readRamsHazardBlocks();
  if (!hazards.length) { toast('Add at least one hazard.', 'error'); return; }
  const operativeName = document.getElementById('ramsOperativeName').value.trim();
  if (!operativeName) { toast('Fill in your name.', 'error'); return; }
  if (ramsSignaturePad.isEmpty()) { toast('Sign before saving.', 'error'); return; }
  try {
    await api(`/api/job-assignments/${currentAssignmentId}/rams`, {
      method: 'POST',
      body: JSON.stringify({
        methodStatement,
        hazards,
        operativeName,
        signatureImage: ramsSignaturePad.toDataUrl(),
      }),
    });
    clearRamsDraft(currentAssignmentId);
    closeRamsForm();
    await refreshAssignmentRams();
    toast('RAMS saved.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
});

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
        toast(err.message, 'error');
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

// Jobs with someone actively assigned on site today that don't have a Permit to Work on
// file - unlike RAMS, a permit isn't needed for every job, only ones where an assignment is
// actually in progress right now (see REQUIRED_DOCUMENT_CATEGORIES in db.js, which
// deliberately excludes 'permit' for the same reason), so this only ever flags jobs where
// that's genuinely true today, not every job that happens to lack one.
function jobsMissingPermit() {
  const todayStr = todayDateStr();
  const activeJobIds = new Set(
    state.allAssignments
      .filter((a) => !a.completed && a.startDate <= todayStr && a.endDate >= todayStr)
      .map((a) => a.jobId)
  );
  return state.jobs
    .filter((j) => activeJobIds.has(j.id) && !(j.documents && j.documents.permit && j.documents.permit.length))
    .sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''));
}

// Subbies whose insurance/compliance document is already expired or due soon - mirrors the
// server-side listSubbiesExpiring but reuses the copy of state.subbies already loaded rather
// than firing an extra request.
function subbiesExpiring() {
  return state.subbies
    .filter((s) => s.insuranceStatus === 'expired' || s.insuranceStatus === 'expiring-soon')
    .sort((a, b) => (a.insuranceExpiry || '').localeCompare(b.insuranceExpiry || ''));
}

function renderHomeDashboard() {
  const container = document.getElementById('homeDashboard');
  if (!container) return;
  // Staff don't have access to Jobs or the shared Calendar, so the dashboard cards that
  // surface company-wide job/RAMS and everyone's-today data don't apply to them - just
  // leave it empty and let the welcome hero/slideshow below carry the page.
  if (isStaff()) {
    container.innerHTML = '';
    return;
  }
  if (isOperative()) {
    renderOperativeHomeDashboard(container);
    return;
  }
  const todayStr = todayDateStr();
  // Admin/surveyor can be assigned to a job too (see the Jobs tab's "Assign the Team"
  // checklist) - e.g. going on the tools themselves. Surface every one of their own current
  // assignments here, not just the nearest, so this matches what they'd see on My Calendar -
  // and only appends the card at all when they actually have one, rather than cluttering
  // this already busy dashboard with an empty "no assignment" card.
  const myUpcoming = [...state.myAssignments]
    .filter((a) => !a.completed)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const todaysEvents = eventsOnDate(todayStr).sort((a, b) => a.userName.localeCompare(b.userName));
  const missingRams = jobsMissingRams();
  const missingPermit = jobsMissingPermit();
  const expiringSubbies = subbiesExpiring();
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

  const permitHtml = missingPermit.length
    ? `<ul class="home-rams-list">${missingPermit.map((j) => `
        <li>
          <div class="home-rams-info">
            <strong>${escapeHtml(j.client)}${j.location ? ' — ' + escapeHtml(j.location) : ''}</strong>
            <span class="home-rams-date">Someone's on site today, no permit on file</span>
          </div>
          <button type="button" class="home-rams-btn" data-job-permit="${j.id}">View Job</button>
        </li>
      `).join('')}</ul>`
    : `<p class="empty-state">Every job with someone on site today has a permit on file.</p>`;

  const subbyHtml = expiringSubbies.length
    ? `<ul class="home-rams-list">${expiringSubbies.map((s) => `
        <li>
          <div class="home-rams-info">
            <strong>${escapeHtml(s.companyName)}</strong>
            <span class="home-rams-date">${s.insuranceStatus === 'expired' ? 'Expired ' : 'Expires '}${s.insuranceExpiry}</span>
          </div>
          <button type="button" class="home-rams-btn" data-goto-subbies="1">View</button>
        </li>
      `).join('')}</ul>`
    : `<p class="empty-state">No subby insurance documents expiring soon.</p>`;

  container.innerHTML = `
    ${myUpcoming.length ? myAssignmentsCardHtml(myUpcoming, todayStr) : ''}
    <div class="dashboard-card">
      <h3>Today — ${todayLabel}</h3>
      ${todayHtml}
      <button type="button" class="link-btn" id="homeGoCalendarBtn">Open Calendar</button>
    </div>
    <div class="dashboard-card">
      <h3>Jobs Missing RAMS</h3>
      ${ramsHtml}
    </div>
    <div class="dashboard-card">
      <h3>Jobs Missing a Permit to Work</h3>
      ${permitHtml}
    </div>
    <div class="dashboard-card">
      <h3>Subby Insurance Expiring</h3>
      ${subbyHtml}
    </div>
  `;

  document.getElementById('homeGoCalendarBtn').addEventListener('click', () => {
    goToTab('calendar');
    teamCalendar.openDayModal(todayStr);
  });

  container.querySelectorAll('.home-rams-btn[data-job]').forEach((btn) => {
    btn.addEventListener('click', () => openJobDetail(btn.dataset.job, 'rams'));
  });
  container.querySelectorAll('[data-job-permit]').forEach((btn) => {
    btn.addEventListener('click', () => openJobDetail(btn.dataset.jobPermit, 'permit'));
  });
  container.querySelectorAll('[data-goto-subbies]').forEach((btn) => {
    btn.addEventListener('click', () => goToTab('subbies'));
  });
  container.querySelectorAll('[data-assignment]').forEach((btn) => {
    btn.addEventListener('click', () => openAssignmentDetail(btn.dataset.assignment));
  });
  container.querySelectorAll('[data-quick-clockin]').forEach((btn) => {
    btn.addEventListener('click', () => quickClockIn(btn.dataset.quickClockin));
  });
}

// Shared "Your Assignments" dashboard card - lists every one of the user's own current
// (not-completed) assignments, same set My Calendar merges in - not just the nearest one,
// so this doesn't undersell what's actually been penned in for them. Used by the
// operative-only dashboard below (which always shows it, even when empty) and by the
// admin/surveyor dashboard above (which only appends it when they actually have any).
function myAssignmentsCardHtml(assignments, todayStr) {
  return `
    <div class="dashboard-card">
      <h3>Your Assignments</h3>
      <ul class="home-rams-list">${assignments.map((a) => assignmentRowHtml(a, todayStr)).join('')}</ul>
    </div>
  `;
}

// Operatives get one small card (all of their current/upcoming assignments) instead of the
// company-wide Today/Missing-RAMS cards, which don't apply since they can't see Jobs or
// the shared Calendar - same reasoning as staff's empty dashboard above.
function renderOperativeHomeDashboard(container) {
  const todayStr = todayDateStr();
  const upcoming = [...state.myAssignments]
    .filter((a) => !a.completed)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  container.innerHTML = upcoming.length
    ? myAssignmentsCardHtml(upcoming, todayStr)
    : `<div class="dashboard-card"><h3>Your Assignments</h3><p class="empty-state">No current assignment.</p></div>`;
  container.querySelectorAll('[data-assignment]').forEach((btn) => {
    btn.addEventListener('click', () => openAssignmentDetail(btn.dataset.assignment));
  });
  container.querySelectorAll('[data-quick-clockin]').forEach((btn) => {
    btn.addEventListener('click', () => quickClockIn(btn.dataset.quickClockin));
  });
}

// ---------- My Assignments (operative-only tab) ----------
// Full list of an operative's own assignments, split into "Current" (not yet marked done)
// and a "Past Jobs" dropdown (completed) - a job moves from one to the other as soon as
// they mark it done via the assignment detail modal (see assignmentCompleteBtn above).

function assignmentRowHtml(a, todayStr) {
  const clockedInToday = !!(a.todayTimeLog && a.todayTimeLog.clockInAt);
  // Clock-in has no RAMS dependency (only "Mark Arrived" does, see runTimeLogAction/db.js
  // markArrived) so it's safe to offer as a single tap right here, rather than making this
  // the most-repeated action of the day always cost a trip through the detail modal.
  const canQuickClockIn = !a.completed && !clockedInToday && todayStr >= a.startDate && todayStr <= a.endDate;
  return `
    <li>
      <div class="home-rams-info">
        <strong>${escapeHtml(a.jobReference || a.jobClient)}${a.jobLocation ? ' — ' + escapeHtml(a.jobLocation) : ''}</strong>
        <span class="home-rams-date">${escapeHtml(a.task)} · ${a.startDate < todayStr ? 'Started ' : 'Starts '}${a.startDate} · ${a.durationDays} day${a.durationDays === 1 ? '' : 's'}${clockedInToday ? ' · Clocked in' : ''}</span>
      </div>
      <div class="home-rams-actions">
        ${canQuickClockIn ? `<button type="button" class="primary home-rams-btn" data-quick-clockin="${a.id}">Clock In</button>` : ''}
        <button type="button" class="home-rams-btn" data-assignment="${a.id}">View</button>
      </div>
    </li>
  `;
}

async function quickClockIn(id) {
  try {
    await api(`/api/job-assignments/${id}/time/clock-in`, { method: 'POST' });
    state.myAssignments = await api('/api/job-assignments/mine');
    renderHomeDashboard();
    renderMyAssignmentsTab();
    toast('Clocked in.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderMyAssignmentsTab() {
  const select = document.getElementById('assignmentsViewSelect');
  if (!select) return;
  const view = select.value;
  const currentList = document.getElementById('myAssignmentsCurrentList');
  const pastList = document.getElementById('myAssignmentsPastList');
  currentList.hidden = view !== 'current';
  pastList.hidden = view !== 'past';

  const todayStr = todayDateStr();
  const current = state.myAssignments.filter((a) => !a.completed).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const past = state.myAssignments.filter((a) => a.completed).sort((a, b) => b.startDate.localeCompare(a.startDate));

  document.getElementById('myAssignmentsCurrentEmpty').hidden = view !== 'current' || !!current.length;
  document.getElementById('myAssignmentsPastEmpty').hidden = view !== 'past' || !!past.length;

  currentList.innerHTML = current.map((a) => assignmentRowHtml(a, todayStr)).join('');
  pastList.innerHTML = past.map((a) => assignmentRowHtml(a, todayStr)).join('');

  [currentList, pastList].forEach((list) => {
    list.querySelectorAll('[data-assignment]').forEach((btn) => {
      btn.addEventListener('click', () => openAssignmentDetail(btn.dataset.assignment));
    });
    list.querySelectorAll('[data-quick-clockin]').forEach((btn) => {
      btn.addEventListener('click', () => quickClockIn(btn.dataset.quickClockin));
    });
  });
}

document.getElementById('assignmentsViewSelect').addEventListener('change', renderMyAssignmentsTab);

// ---------- Mini-Game ----------
// Daily whack-a-mole, just for fun. The target sequence (which hole, and how long it
// waits before popping up) is generated here from a string seed, deterministically -
// everyone who plays on the same date gets the exact same sequence, so times are directly
// comparable, Wordle-style. The server (db.js submitMiniGameScore) never sees or checks the
// sequence itself, only the resulting time - see MINIGAME_MIN_TIME_MS there for the one
// sanity check that catches an obviously spoofed time.

const MINIGAME_HOLES = 9;
const MINIGAME_ROUNDS = 15;
const MINIGAME_POP_TIMEOUT_MS = 1200; // how long a mole stays up before it's a miss
const MINIGAME_MISS_PENALTY_MS = 1500; // added to the final time per miss

let minigameRun = null;

// A small string-seeded PRNG (xmur3 hash feeding mulberry32) - not cryptographic, just
// needs to be deterministic per date and fast, so everyone's browser derives the identical
// sequence independently without the server needing to generate or transmit it.
function minigameSeedFn(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function buildMinigameSequence(dateStr) {
  const rand = minigameSeedFn('minigame-' + dateStr);
  const sequence = [];
  let lastHole = -1;
  for (let i = 0; i < MINIGAME_ROUNDS; i++) {
    let hole;
    do { hole = Math.floor(rand() * MINIGAME_HOLES); } while (hole === lastHole);
    lastHole = hole;
    sequence.push({ hole, delayMs: 250 + Math.floor(rand() * 500) });
  }
  return sequence;
}

function ensureMinigameGrid() {
  const grid = document.getElementById('minigameGrid');
  if (grid.children.length) return;
  for (let i = 0; i < MINIGAME_HOLES; i++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'minigame-hole';
    cell.dataset.hole = String(i);
    cell.addEventListener('click', () => handleMinigameHoleClick(i));
    grid.appendChild(cell);
  }
}

function minigameTimeLabel(ms) {
  return (ms / 1000).toFixed(2) + 's';
}

async function loadMinigame() {
  ensureMinigameGrid();
  document.getElementById('minigameStartBtn').textContent = 'Start';
  document.getElementById('minigameStartBtn').disabled = false;
  document.getElementById('minigameResult').hidden = true;
  document.getElementById('minigameTimer').textContent = '0.00s';
  document.getElementById('minigameHits').textContent = `0/${MINIGAME_ROUNDS}`;
  document.getElementById('minigameMisses').textContent = '0';
  await loadMinigameLeaderboards();
}

async function loadMinigameLeaderboards() {
  const data = await api('/api/minigame/today');
  state.minigameDate = data.date;
  state.minigameDaily = data.dailyLeaderboard;
  state.minigameAllTime = data.allTimeLeaderboard;
  state.minigameMyBest = data.myBestToday;
  renderMinigameLeaderboards();
}

async function handleLiveMinigameChange() {
  if (activeTab() === 'minigame') await loadMinigameLeaderboards();
}

function minigameLeaderboardRowsHtml(list) {
  if (!list.length) return `<tr><td colspan="3" class="empty-state">No times yet — be the first!</td></tr>`;
  return list.map((row, i) => `
    <tr${row.userId === state.currentUser.id ? ' class="minigame-row-me"' : ''}>
      <td>${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</td>
      <td>${escapeHtml(row.userName)}</td>
      <td>${minigameTimeLabel(row.timeMs)}</td>
    </tr>
  `).join('');
}

function renderMinigameLeaderboards() {
  document.querySelector('#minigameDailyTable tbody').innerHTML = minigameLeaderboardRowsHtml(state.minigameDaily);
  document.querySelector('#minigameAllTimeTable tbody').innerHTML = minigameLeaderboardRowsHtml(state.minigameAllTime);
  document.getElementById('minigameMyBest').textContent = state.minigameMyBest
    ? `Your best today: ${minigameTimeLabel(state.minigameMyBest.timeMs)}`
    : `You haven't played today yet — give it a go!`;
}

function startMinigame() {
  ensureMinigameGrid();
  document.querySelectorAll('.minigame-hole').forEach((h) => h.classList.remove('active'));
  document.getElementById('minigameStartBtn').textContent = 'Playing…';
  document.getElementById('minigameStartBtn').disabled = true;
  document.getElementById('minigameResult').hidden = true;
  document.getElementById('minigameTimer').textContent = '0.00s';
  document.getElementById('minigameHits').textContent = `0/${MINIGAME_ROUNDS}`;
  document.getElementById('minigameMisses').textContent = '0';

  minigameRun = {
    sequence: buildMinigameSequence(state.minigameDate || todayDateStr()),
    round: 0,
    misses: 0,
    activeHole: -1,
    startTime: performance.now(),
    popTimer: null,
    timeoutTimer: null,
    tickTimer: setInterval(updateMinigameTimerDisplay, 100),
  };
  scheduleNextMinigameMole();
}

function updateMinigameTimerDisplay() {
  if (!minigameRun) return;
  document.getElementById('minigameTimer').textContent = minigameTimeLabel(performance.now() - minigameRun.startTime);
}

function scheduleNextMinigameMole() {
  const step = minigameRun.sequence[minigameRun.round];
  minigameRun.popTimer = setTimeout(() => {
    if (!minigameRun) return;
    minigameRun.activeHole = step.hole;
    const cell = document.querySelector(`.minigame-hole[data-hole="${step.hole}"]`);
    if (cell) cell.classList.add('active');
    minigameRun.timeoutTimer = setTimeout(() => registerMinigameMiss(step.hole), MINIGAME_POP_TIMEOUT_MS);
  }, step.delayMs);
}

function registerMinigameMiss(hole) {
  if (!minigameRun || minigameRun.activeHole !== hole) return;
  minigameRun.misses++;
  document.getElementById('minigameMisses').textContent = minigameRun.misses;
  advanceMinigameRound();
}

// A click on the wrong hole (or before anything's popped up yet) costs a miss too but
// doesn't advance the round - the current mole keeps waiting for its own timeout or the
// correct click, so a spam-clicker can't skip ahead by mashing every hole.
function handleMinigameHoleClick(hole) {
  if (!minigameRun) return;
  if (hole !== minigameRun.activeHole) {
    minigameRun.misses++;
    document.getElementById('minigameMisses').textContent = minigameRun.misses;
    return;
  }
  clearTimeout(minigameRun.timeoutTimer);
  advanceMinigameRound();
}

function advanceMinigameRound() {
  const cell = document.querySelector(`.minigame-hole[data-hole="${minigameRun.activeHole}"]`);
  if (cell) cell.classList.remove('active');
  minigameRun.activeHole = -1;
  minigameRun.round++;
  document.getElementById('minigameHits').textContent = `${minigameRun.round}/${MINIGAME_ROUNDS}`;
  if (minigameRun.round >= MINIGAME_ROUNDS) finishMinigame();
  else scheduleNextMinigameMole();
}

async function finishMinigame() {
  clearInterval(minigameRun.tickTimer);
  const totalMs = Math.round((performance.now() - minigameRun.startTime) + minigameRun.misses * MINIGAME_MISS_PENALTY_MS);
  const misses = minigameRun.misses;
  minigameRun = null;

  document.getElementById('minigameTimer').textContent = minigameTimeLabel(totalMs);
  document.getElementById('minigameStartBtn').textContent = 'Play Again';
  document.getElementById('minigameStartBtn').disabled = false;

  const resultEl = document.getElementById('minigameResult');
  resultEl.hidden = false;
  try {
    const result = await api('/api/minigame/score', { method: 'POST', body: JSON.stringify({ timeMs: totalMs, misses }) });
    resultEl.textContent = result.improved
      ? `New best: ${minigameTimeLabel(totalMs)} (${misses} missed) — leaderboard updated!`
      : `Finished in ${minigameTimeLabel(totalMs)} (${misses} missed) — your best today is still ${minigameTimeLabel(result.best.timeMs)}.`;
    await loadMinigameLeaderboards();
  } catch (err) {
    resultEl.textContent = `Finished in ${minigameTimeLabel(totalMs)}, but couldn't save your score: ${err.message}`;
  }
}

document.getElementById('minigameStartBtn').addEventListener('click', startMinigame);

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

let raSearchTerm = '';

function renderRiskAssessments() {
  const grid = document.getElementById('raGrid');
  const term = raSearchTerm.trim().toLowerCase();
  const raLibrary = state.raLibrary.filter((ra) => !term || ra.name.toLowerCase().includes(term));
  const riskAssessments = state.riskAssessments.filter((ra) => !term || ra.title.toLowerCase().includes(term));
  const raCustom = state.raCustom.filter((ra) => !term || ra.title.toLowerCase().includes(term));
  const libraryCards = raLibrary.map((ra) => `
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
  const genericCards = riskAssessments.map((ra) => `
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
  const customCards = raCustom.map((ra) => `
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
  const allCards = libraryCards.join('') + customCards.join('') + genericCards.join('');
  grid.innerHTML = allCards || `<p class="empty-state">No risk assessments match your search.</p>`;
  grid.querySelectorAll('.ra-view-btn').forEach((btn) => btn.addEventListener('click', () => openRaModal(btn.dataset.kind, btn.dataset.ra)));
  grid.querySelectorAll('.ra-library-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this saved risk assessment? This cannot be undone.')) return;
      try {
        await api(`/api/risk-assessments/library/${btn.dataset.ra}`, { method: 'DELETE' });
        state.raLibrary = await api('/api/risk-assessments/library');
        renderRiskAssessments();
      } catch (err) {
        toast(err.message, 'error');
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
        toast(err.message, 'error');
      }
    });
  });
}

document.getElementById('raSearch').addEventListener('input', (e) => {
  raSearchTerm = e.target.value;
  renderRiskAssessments();
});

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
  if (!file) { toast('Choose a file to upload.', 'error'); return; }
  if (!name) { toast('Give this risk assessment a name.', 'error'); return; }
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
    toast(err.message, 'error');
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
      if (!name) { toast('Give the new risk assessment a name.', 'error'); return; }
      if (!fields.currentControls.length) { toast('Add at least one current risk control.', 'error'); return; }
      try {
        const saved = await api('/api/risk-assessments/custom', {
          method: 'POST',
          body: JSON.stringify({ ...fields, title: name, basedOn: `${kind}:${ra.id}` }),
        });
        state.raCustom = await api('/api/risk-assessments/custom');
        renderRiskAssessments();
        toast('Saved — you\'ll find it in the Risk Assessments list.', 'success');
        openRaModal('custom', saved.id);
      } catch (err) {
        toast(err.message, 'error');
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
  if (!jobId) { toast('Choose a job to attach this risk assessment to.', 'error'); return; }
  const kindPrefix = currentRaKind === 'generic' ? '' : `${currentRaKind}/`;
  const endpoint = `/api/jobs/${jobId}/risk-assessments/${kindPrefix}${currentRaId}/attach`;
  try {
    await api(endpoint, { method: 'POST' });
    toast('Attached — you\'ll find it in that job\'s RAMS documents.', 'success');
    closeRaModal();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- Reports ----------

// Downloads a CSV built from a plain array-of-arrays (first row = headers) - used by the
// Reports/Client Report tabs' Export buttons so the figures on screen can leave the app
// (an accountant, a year-end pack) without manually retyping them.
function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map((cell) => {
    const s = String(cell === undefined || cell === null ? '' : cell);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

let lastYearlyReport = [];

async function loadReports() {
  document.getElementById('reportsHeading').textContent = isAdmin() ? 'Yearly Reports' : 'My Yearly Report';
  const container = document.getElementById('reportsContainer');

  if (!isAdmin()) {
    const years = await api('/api/reports/yearly');
    lastYearlyReport = years;
    renderOwnYearlyReport(container, years);
    return;
  }

  const [years, monthly] = await Promise.all([api('/api/reports/yearly'), api('/api/reports/monthly')]);
  lastYearlyReport = years;

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

document.getElementById('reportsExportBtn').addEventListener('click', () => {
  if (!lastYearlyReport.length) { toast('Nothing to export yet.', 'error'); return; }
  const rows = [['Year', 'Employee', 'Total Value', 'Total Profit', 'Jobs Won']];
  if (isAdmin()) {
    lastYearlyReport.forEach((y) => y.employees.forEach((e) => {
      rows.push([y.year, e.employee, e.totalValue.toFixed(2), e.totalProfit.toFixed(2), e.jobCount]);
    }));
  } else {
    lastYearlyReport.forEach((y) => {
      rows.push([y.year, state.currentUser.name, y.own.totalValue.toFixed(2), y.own.totalProfit.toFixed(2), y.own.jobCount]);
    });
  }
  downloadCsv('yearly-report.csv', rows);
});

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

let lastClientReport = [];

async function loadClients() {
  const clients = await api('/api/reports/clients');
  lastClientReport = clients;
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

document.getElementById('clientsExportBtn').addEventListener('click', () => {
  if (!lastClientReport.length) { toast('Nothing to export yet.', 'error'); return; }
  const rows = [['Rank', 'Client', 'Total Value', 'Total Profit', 'Jobs']];
  lastClientReport.forEach((c, i) => rows.push([i + 1, c.client, c.totalValue.toFixed(2), c.totalProfit.toFixed(2), c.jobCount]));
  downloadCsv('client-report.csv', rows);
});

// ---------- Admin ----------

const ROLE_LABELS = {
  admin: 'Admin',
  staff: 'Staff',
  surveyor: 'Surveyor',
  installation_operative: 'Installation Operative',
  manufacturing_operative: 'Manufacturing Operative',
  stocks_manager: 'Stocks Manager',
};

async function loadAdminUsers() {
  const users = await api('/api/users');
  const tbody = document.querySelector('#adminUsersTable tbody');
  tbody.innerHTML = users.map((u) => `
    <tr>
      <td>${escapeHtml(u.name)}</td>
      <td>${escapeHtml(u.email)}</td>
      <td>
        <select class="admin-role-select" data-user="${u.id}" data-name="${escapeHtml(u.name)}" ${u.id === state.currentUser.id ? 'disabled title="You can\'t change your own role"' : ''}>
          ${Object.entries(ROLE_LABELS).map(([value, label]) => `<option value="${value}" ${u.role === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </td>
      <td>
        <select class="admin-employee-select" data-user="${u.id}">
          <option value="">— Not linked —</option>
          ${state.employees.map((e) => `<option value="${e.id}" ${u.employeeId === e.id ? 'selected' : ''}>${escapeHtml(e.name)}</option>`).join('')}
        </select>
      </td>
      <td>
        ${u.id === state.currentUser.id
          ? `<span class="status-pill complete">Active</span>`
          : `<button type="button" class="admin-active-toggle ${u.active ? '' : 'danger'}" data-user="${u.id}" data-name="${escapeHtml(u.name)}" data-active="${u.active}">${u.active ? 'Active' : 'Disabled'}</button>`}
      </td>
      <td>
        ${u.mfaEnabled
          ? `<button type="button" class="admin-mfa-reset" data-user="${u.id}" data-name="${escapeHtml(u.name)}">On — Reset</button>`
          : `<span class="status-pill">Off</span>`}
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.admin-role-select').forEach((select) => {
    select.addEventListener('change', async () => {
      const role = select.value;
      if (!confirm(`Set ${select.dataset.name}'s role to ${ROLE_LABELS[role]}?`)) {
        loadAdminUsers();
        return;
      }
      try {
        await api(`/api/users/${select.dataset.user}/role`, {
          method: 'PUT',
          body: JSON.stringify({ role }),
        });
        loadAdminUsers();
      } catch (err) {
        toast(err.message, 'error');
        loadAdminUsers();
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
        toast(err.message, 'error');
        loadAdminUsers();
      }
    });
  });

  tbody.querySelectorAll('.admin-active-toggle').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const nowActive = btn.dataset.active !== 'true';
      const verb = nowActive ? 're-enable' : 'disable';
      if (!confirm(`Are you sure you want to ${verb} ${btn.dataset.name}'s account?`)) return;
      try {
        await api(`/api/users/${btn.dataset.user}/active`, {
          method: 'PUT',
          body: JSON.stringify({ active: nowActive }),
        });
        loadAdminUsers();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  tbody.querySelectorAll('.admin-mfa-reset').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Turn off two-factor authentication for ${btn.dataset.name}? They'll be able to sign in with just their password until they set it up again — use this for a lost or replaced phone.`)) return;
      try {
        await api(`/api/users/${btn.dataset.user}/mfa-reset`, { method: 'PUT' });
        loadAdminUsers();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

// ---------- Activity Log (admin) ----------

const ACTIVITY_LOG_PAGE_SIZE = 50;
const activityLogState = { offset: 0, total: 0, actorsLoaded: false };

function activityLogFilterParams() {
  const params = new URLSearchParams();
  const from = document.getElementById('logFromDate').value;
  const to = document.getElementById('logToDate').value;
  const actorUserId = document.getElementById('logActorFilter').value;
  const action = document.getElementById('logActionFilter').value;
  const q = document.getElementById('logSearch').value.trim();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (actorUserId) params.set('actorUserId', actorUserId);
  if (action) params.set('action', action);
  if (q) params.set('q', q);
  return params;
}

async function loadActivityLog({ reset } = {}) {
  if (reset) activityLogState.offset = 0;
  if (!activityLogState.actorsLoaded) {
    const select = document.getElementById('logActorFilter');
    select.innerHTML = '<option value="">All people</option>'
      + state.operativeUsers.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
    activityLogState.actorsLoaded = true;
  }
  const params = activityLogFilterParams();
  params.set('limit', ACTIVITY_LOG_PAGE_SIZE);
  params.set('offset', activityLogState.offset);
  const { entries, total } = await api(`/api/activity-log?${params.toString()}`);
  activityLogState.total = total;
  renderActivityLogRows(entries, !reset && activityLogState.offset > 0);
  activityLogState.offset += entries.length;
  document.getElementById('logLoadMoreBtn').hidden = activityLogState.offset >= total;
}

function renderActivityLogRows(entries, append) {
  const tbody = document.querySelector('#activityLogTable tbody');
  const empty = document.getElementById('activityLogEmpty');
  const rowsHtml = entries.map((e) => `
    <tr>
      <td>${new Date(e.createdAt).toLocaleString('en-GB')}</td>
      <td>${escapeHtml(e.actorName)}</td>
      <td>${escapeHtml(e.summary)}</td>
    </tr>
  `).join('');
  if (append) tbody.insertAdjacentHTML('beforeend', rowsHtml);
  else tbody.innerHTML = rowsHtml;
  empty.hidden = tbody.children.length > 0;
}

['logFromDate', 'logToDate', 'logActorFilter', 'logActionFilter'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => loadActivityLog({ reset: true }));
});
let logSearchDebounceTimer = null;
document.getElementById('logSearch').addEventListener('input', () => {
  clearTimeout(logSearchDebounceTimer);
  logSearchDebounceTimer = setTimeout(() => loadActivityLog({ reset: true }), 300);
});
document.getElementById('logLoadMoreBtn').addEventListener('click', () => loadActivityLog());

// ---------- Modal accessibility (focus trap + Escape-to-close) ----------
// Retrofitted once, globally, rather than touching every individual modal's open/close call
// site (there are dozens scattered through this file) - a MutationObserver notices any of the
// 10 .modal-overlay elements becoming visible/hidden, and one delegated keydown/focusin
// handler covers all of them the same way, so this works regardless of which function opened
// or closed a given modal.

function visibleModals() {
  return [...document.querySelectorAll('.modal-overlay')].filter((m) => !m.hidden);
}

// DOM order approximates stacking order here (later = drawn on top, see the modal-stacking
// note elsewhere) - good enough to pick "the one Escape/focus-trap should act on" without
// needing an explicit z-index/open-order stack.
function topmostModal() {
  const visible = visibleModals();
  return visible.length ? visible[visible.length - 1] : null;
}

function focusableElements(container) {
  return [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((el) => el.offsetParent !== null);
}

// Keeps only the topmost open modal's dim/blur backdrop visible - an earlier one still open
// underneath (e.g. Assignment Detail while its RAMS form is open on top) gets it suppressed
// via .modal-stack-behind instead of compounding into a double-dim.
function updateModalStackDimming() {
  const visible = visibleModals();
  document.querySelectorAll('.modal-overlay.modal-stack-behind').forEach((m) => m.classList.remove('modal-stack-behind'));
  visible.slice(0, -1).forEach((m) => m.classList.add('modal-stack-behind'));
}

document.querySelectorAll('.modal-overlay').forEach((modal) => {
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.tabIndex = -1; // fallback focus target if a modal ever has nothing focusable inside
  new MutationObserver(() => {
    updateModalStackDimming();
    if (!modal.hidden) {
      const focusables = focusableElements(modal);
      (focusables[0] || modal).focus({ preventScroll: true });
    }
  }).observe(modal, { attributes: true, attributeFilter: ['hidden'] });
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modal = topmostModal();
  if (!modal) return;
  // Clicking the modal's own close/cancel button (rather than just hiding it directly) means
  // Escape goes through the same reset-state logic as actually clicking Close would.
  const closeBtn = modal.querySelector('[id$="CloseBtn"], [id$="CancelBtn"]');
  if (closeBtn) closeBtn.click();
  else modal.hidden = true;
});

document.addEventListener('focusin', (e) => {
  const modal = topmostModal();
  if (!modal || modal.contains(e.target)) return;
  const focusables = focusableElements(modal);
  (focusables[0] || modal).focus({ preventScroll: true });
});

checkAuth();
