// Smoke tests for the role-based route allowlists in server.js (STAFF_ALLOWED_ROUTES,
// OPERATIVE_ALLOWED_ROUTES) - the real single choke point restricted roles are gated by (see
// the app.use('/api', ...) middleware in server.js). Requires the real server.js module
// (dummy Supabase env vars below let it load without a live database - see db.pure.test.js
// for why that's safe) rather than duplicating the arrays, so this actually catches a route
// falling out of sync with its intended role, not just a hand-copied guess. server.js guards
// app.listen() behind require.main === module, so requiring it here never binds a port.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const { STAFF_ALLOWED_ROUTES, OPERATIVE_ALLOWED_ROUTES, CLIENT_ALLOWED_ROUTES } = require('../server');

function allowed(routes, method, path) {
  return routes.some((r) => r.method === method && r.path.test(path));
}

test('staff can reach calendar/diary routes', () => {
  assert.equal(allowed(STAFF_ALLOWED_ROUTES, 'GET', '/calendar'), true);
  assert.equal(allowed(STAFF_ALLOWED_ROUTES, 'POST', '/diary'), true);
  assert.equal(allowed(STAFF_ALLOWED_ROUTES, 'PUT', '/diary/abc123/complete'), true);
});

test('staff and operatives can both reach the mini-game routes', () => {
  assert.equal(allowed(STAFF_ALLOWED_ROUTES, 'GET', '/minigame/today'), true);
  assert.equal(allowed(STAFF_ALLOWED_ROUTES, 'POST', '/minigame/score'), true);
  assert.equal(allowed(OPERATIVE_ALLOWED_ROUTES, 'GET', '/minigame/today'), true);
  assert.equal(allowed(OPERATIVE_ALLOWED_ROUTES, 'POST', '/minigame/score'), true);
});

test('staff cannot reach Jobs, job-assignments, or admin-only routes', () => {
  assert.equal(allowed(STAFF_ALLOWED_ROUTES, 'GET', '/jobs'), false);
  assert.equal(allowed(STAFF_ALLOWED_ROUTES, 'GET', '/job-assignments/mine'), false);
  assert.equal(allowed(STAFF_ALLOWED_ROUTES, 'GET', '/users'), false);
  assert.equal(allowed(STAFF_ALLOWED_ROUTES, 'POST', '/job-assignments'), false);
});

test('operatives get calendar/diary plus their own self-scoped job-assignment routes', () => {
  assert.equal(allowed(OPERATIVE_ALLOWED_ROUTES, 'GET', '/calendar'), true);
  assert.equal(allowed(OPERATIVE_ALLOWED_ROUTES, 'GET', '/job-assignments/mine'), true);
  assert.equal(allowed(OPERATIVE_ALLOWED_ROUTES, 'PUT', '/job-assignments/abc123/complete'), true);
  assert.equal(allowed(OPERATIVE_ALLOWED_ROUTES, 'POST', '/job-assignments/abc123/time/clock-in'), true);
  assert.equal(allowed(OPERATIVE_ALLOWED_ROUTES, 'GET', '/job-assignments/abc123/rams-status'), true);
  assert.equal(allowed(OPERATIVE_ALLOWED_ROUTES, 'GET', '/job-assignments/abc123/rams-status/doc1/file'), true);
});

test('operatives cannot reach Jobs, the full job-assignments list, or admin-only routes', () => {
  assert.equal(allowed(OPERATIVE_ALLOWED_ROUTES, 'GET', '/jobs'), false);
  assert.equal(allowed(OPERATIVE_ALLOWED_ROUTES, 'GET', '/job-assignments'), false);
  assert.equal(allowed(OPERATIVE_ALLOWED_ROUTES, 'POST', '/job-assignments'), false);
  assert.equal(allowed(OPERATIVE_ALLOWED_ROUTES, 'DELETE', '/job-assignments/abc123'), false);
  assert.equal(allowed(OPERATIVE_ALLOWED_ROUTES, 'GET', '/users'), false);
  assert.equal(allowed(OPERATIVE_ALLOWED_ROUTES, 'GET', '/subbies'), false);
});

test('clients can reach their own jobs, documents, zip download and booked-in calendar', () => {
  assert.equal(allowed(CLIENT_ALLOWED_ROUTES, 'GET', '/jobs'), true);
  assert.equal(allowed(CLIENT_ALLOWED_ROUTES, 'GET', '/jobs/abc123'), true);
  assert.equal(allowed(CLIENT_ALLOWED_ROUTES, 'GET', '/jobs/abc123/documents/rams/doc1/file'), true);
  assert.equal(allowed(CLIENT_ALLOWED_ROUTES, 'GET', '/jobs/abc123/documents-zip'), true);
  assert.equal(allowed(CLIENT_ALLOWED_ROUTES, 'GET', '/client/calendar'), true);
  assert.equal(allowed(CLIENT_ALLOWED_ROUTES, 'POST', '/auth/mfa/setup'), true);
});

test('clients cannot reach costing, time-logs, document uploads/deletes, variations, users or employees', () => {
  assert.equal(allowed(CLIENT_ALLOWED_ROUTES, 'GET', '/jobs/abc123/costing'), false);
  assert.equal(allowed(CLIENT_ALLOWED_ROUTES, 'GET', '/jobs/abc123/time-logs'), false);
  assert.equal(allowed(CLIENT_ALLOWED_ROUTES, 'POST', '/jobs/abc123/documents/photos'), false);
  assert.equal(allowed(CLIENT_ALLOWED_ROUTES, 'DELETE', '/jobs/abc123/documents/rams/doc1'), false);
  assert.equal(allowed(CLIENT_ALLOWED_ROUTES, 'POST', '/jobs/abc123/variations'), false);
  assert.equal(allowed(CLIENT_ALLOWED_ROUTES, 'DELETE', '/jobs/abc123/variations/v1'), false);
  assert.equal(allowed(CLIENT_ALLOWED_ROUTES, 'GET', '/users'), false);
  assert.equal(allowed(CLIENT_ALLOWED_ROUTES, 'GET', '/employees'), false);
  assert.equal(allowed(CLIENT_ALLOWED_ROUTES, 'GET', '/calendar'), false);
});
