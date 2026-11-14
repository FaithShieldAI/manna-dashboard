'use strict';
/**
 * Sign-in record tests (Michael's order, 2026-11-14: "just his and
 * mine", "but only those two").
 *
 * The record covers exactly two keyed accounts:
 *   michael@faithshield.ai  and  support@faithshield.ai
 * (a) a keyed user's sign-in stamps last_login_at;
 * (b) a non-keyed user's sign-in does NOT stamp anything;
 * (c) the /api/auth/me payload carries the record fields only for
 *     keyed users (absent entirely for everyone else);
 * (d) a keyed user's activity/logout produces a session duration;
 * (e) a non-keyed user accumulates no activity stamp and no duration.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

const PW = 'test-password-123';

function userRow(email) {
  const { db } = require('../src/db');
  return db.prepare(
    'SELECT last_login_at, last_activity_at, last_session_seconds FROM users WHERE email = ?'
  ).get(email);
}

async function registerAndLogin(c, companyName, email) {
  const r = await c.post('/api/auth/register', {
    companyName, email, password: PW, displayName: 'T', plan: 'starter',
  });
  assert.equal(r.status, 201);
  await c.post('/api/auth/logout', {});
  const login = await c.post('/api/auth/login', { email, password: PW });
  assert.equal(login.status, 200);
  assert.equal(login.json.ok, true);
}

test('(a) keyed user sign-in stamps last_login_at (Hunter key)', async () => {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Hunter Key Co', email: 'support@faithshield.ai',
    password: PW, displayName: 'Hunter Raines', plan: 'starter',
  });
  assert.equal(r.status, 201);
  // Register alone creates a session but is NOT a password sign-in:
  // nothing is stamped yet.
  await c.post('/api/auth/logout', {});
  let row = userRow('support@faithshield.ai');
  assert.equal(row.last_login_at, null);
  assert.equal(row.last_activity_at, null);
  assert.equal(row.last_session_seconds, null);

  const login = await c.post('/api/auth/login', { email: 'support@faithshield.ai', password: PW });
  assert.equal(login.status, 200);
  row = userRow('support@faithshield.ai');
  assert.ok(row.last_login_at, 'last_login_at stamped at sign-in');
  assert.ok(Math.abs(Date.now() - new Date(row.last_login_at).getTime()) < 60000, 'stamp is current');
  assert.ok(row.last_activity_at, 'activity stamped at sign-in');
});

test('(a) keyed user sign-in stamps last_login_at (Michael key)', async () => {
  const c = client(base);
  await registerAndLogin(c, 'Michael Key Co', 'michael@faithshield.ai');
  const row = userRow('michael@faithshield.ai');
  assert.ok(row.last_login_at, 'last_login_at stamped at sign-in');
  assert.ok(Math.abs(Date.now() - new Date(row.last_login_at).getTime()) < 60000, 'stamp is current');
});

test('(c) /me carries the record fields for a keyed user', async () => {
  const c = client(base);
  // support@faithshield.ai was registered by test (a) in this file.
  const login = await c.post('/api/auth/login', { email: 'support@faithshield.ai', password: PW });
  assert.equal(login.status, 200);
  const me = await c.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.ok('last_login_at' in me.json.user, 'last_login_at present on keyed payload');
  assert.ok(me.json.user.last_login_at, 'last_login_at has a value');
  assert.ok('last_session_seconds' in me.json.user, 'last_session_seconds present on keyed payload');
});

test('(b)+(e) non-keyed user: no sign-in stamp, no activity, no duration, no payload fields', async () => {
  const c = client(base);
  await registerAndLogin(c, 'Plain Co', 'someone@testco.example');
  const me = await c.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.ok(!('last_login_at' in me.json.user), 'no last_login_at on non-keyed payload');
  assert.ok(!('last_session_seconds' in me.json.user), 'no last_session_seconds on non-keyed payload');
  await c.post('/api/auth/logout', {});
  const row = userRow('someone@testco.example');
  assert.equal(row.last_login_at, null);
  assert.equal(row.last_activity_at, null);
  assert.equal(row.last_session_seconds, null);
});

test('(d) keyed user activity and logout produce a session duration', async () => {
  const c = client(base);
  const login = await c.post('/api/auth/login', { email: 'support@faithshield.ai', password: PW });
  assert.equal(login.status, 200);
  // Backdate the sign-in by 10 minutes so the visit length is
  // deterministic, then make an authenticated request (activity).
  const { db } = require('../src/db');
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  db.prepare('UPDATE users SET last_login_at = ? WHERE email = ?')
    .run(tenMinAgo, 'support@faithshield.ai');
  const me = await c.get('/api/auth/me');
  assert.equal(me.status, 200);
  let row = userRow('support@faithshield.ai');
  assert.ok(typeof row.last_session_seconds === 'number', 'duration stored after activity');
  assert.ok(row.last_session_seconds >= 590 && row.last_session_seconds < 700,
    `duration reflects the visit length (got ${row.last_session_seconds})`);
  assert.ok(row.last_activity_at, 'activity stamp present');
  assert.equal(me.json.user.last_session_seconds, row.last_session_seconds,
    'payload duration matches the stored duration');
  // Logout finalizes the duration; it stays stored afterwards.
  await c.post('/api/auth/logout', {});
  row = userRow('support@faithshield.ai');
  assert.ok(typeof row.last_session_seconds === 'number' && row.last_session_seconds >= 590,
    'duration still stored after logout');
});
