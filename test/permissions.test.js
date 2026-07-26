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
const { STAFF_ALLOWED_ROUTES, OPERATIVE_ALLOWED_ROUTES } = require('../server');

function allowed(routes, method, path) {
  return routes.some((r) => r.method === method && r.path.test(path));
}

test('staff can reach calendar/diary routes', () => {
  assert.equal(allowed(STAFF_ALLOWED_ROUTES, 'GET', '/calendar'), true);
  assert.equal(allowed(STAFF_ALLOWED_ROUTES, 'POST', '/diary'), true);
  assert.equal(allowed(STAFF_ALLOWED_ROUTES, 'PUT', '/diary/abc123/complete'), true);
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
