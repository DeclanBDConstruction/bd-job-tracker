// Smoke tests for db.js's pure helpers (no Supabase calls) - date math, expiry/hire status
// thresholds, and job/assignment input validation. Dummy Supabase env vars are set below so
// requiring db.js doesn't throw (see supabaseClient.js) - createClient() itself never makes a
// network call, only the actual query methods do, and none of the functions tested here call
// any of those, so this runs safely with no real database.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');

test('addDaysToDateString adds/subtracts across month and year boundaries', () => {
  assert.equal(db.addDaysToDateString('2026-01-15', 10), '2026-01-25');
  assert.equal(db.addDaysToDateString('2026-01-30', 5), '2026-02-04');
  assert.equal(db.addDaysToDateString('2025-12-28', 5), '2026-01-02');
  assert.equal(db.addDaysToDateString('2026-03-01', -1), '2026-02-28');
  assert.equal(db.addDaysToDateString('2026-01-01', 0), '2026-01-01');
});

test('expiryStatus: null when nothing on file, otherwise expired/expiring-soon/ok', () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(db.expiryStatus(null), null);
  assert.equal(db.expiryStatus(''), null);
  assert.equal(db.expiryStatus(db.addDaysToDateString(today, -1)), 'expired');
  assert.equal(db.expiryStatus(db.addDaysToDateString(today, 10)), 'expiring-soon');
  assert.equal(db.expiryStatus(db.addDaysToDateString(today, 29)), 'expiring-soon');
  assert.equal(db.expiryStatus(db.addDaysToDateString(today, 31)), 'ok');
});

test('hireStatus: returned always wins, then overdue/due-soon/on-hire by due date', () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(db.hireStatus(db.addDaysToDateString(today, -5), '2026-01-01T00:00:00Z'), 'returned');
  assert.equal(db.hireStatus(db.addDaysToDateString(today, -1), null), 'overdue');
  assert.equal(db.hireStatus(today, null), 'due-soon');
  assert.equal(db.hireStatus(db.addDaysToDateString(today, 3), null), 'due-soon');
  assert.equal(db.hireStatus(db.addDaysToDateString(today, 4), null), 'on-hire');
});

test('hireDueBackDate converts weeks to days correctly', () => {
  assert.equal(db.hireDueBackDate('2026-01-01', 2, 'weeks'), db.addDaysToDateString('2026-01-01', 14));
  assert.equal(db.hireDueBackDate('2026-01-01', 3, 'days'), db.addDaysToDateString('2026-01-01', 3));
});

test('validateJobInput requires client, employeeName, a numeric value and a date won', () => {
  assert.deepEqual(
    db.validateJobInput({ client: '', employeeName: '', value: '', dateWon: '' }).length > 0,
    true,
  );
  assert.equal(
    db.validateJobInput({ client: 'Acme', employeeName: 'Neil', value: 1000, dateWon: '2026-01-01' }).length,
    0,
  );
  assert.equal(
    db.validateJobInput({ client: 'Acme', employeeName: 'Neil', value: 'not-a-number', dateWon: '2026-01-01' }).length > 0,
    true,
  );
});

test('validateJobAssignmentInput requires job, user, task, a valid start date and positive duration', () => {
  const errors = db.validateJobAssignmentInput({});
  assert.equal(errors.length > 0, true);

  const ok = db.validateJobAssignmentInput({
    jobId: 'job-1', userId: 'user-1', task: 'Install units', startDate: '2026-01-01', durationDays: 2,
  });
  assert.equal(ok.length, 0);

  const badDate = db.validateJobAssignmentInput({
    jobId: 'job-1', userId: 'user-1', task: 'Install units', startDate: 'not-a-date', durationDays: 2,
  });
  assert.equal(badDate.length > 0, true);

  const badDuration = db.validateJobAssignmentInput({
    jobId: 'job-1', userId: 'user-1', task: 'Install units', startDate: '2026-01-01', durationDays: 0,
  });
  assert.equal(badDuration.length > 0, true);
});
