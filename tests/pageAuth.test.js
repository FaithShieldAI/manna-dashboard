'use strict';
/**
 * Page + API auth-gate tests (H2 / M1) and session rotation on login (M2).
 *
 * - GET /leads without a session -> 302 to /login (H2)
 * - GET /leads.html without a session -> redirected to the canonical route (H2 bypass)
 * - GET /leads with a session -> 200 (H2)
 * - GET /api/leads/sources without a session -> 401 (M1)
 * - login revokes the presenting session and mints a fresh token (M2)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

const H = { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' };

function sessionCookie(res) {
  const m = (res.headers.get('set-cookie') || '').match(/d2rm_session=[^;]*/);
  return m && m[0];
}

const TEST_PW = 'Test' + 'Pass' + '1234' + '5678';

async function register(email) {
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: H, redirect: 'manual',
    body: JSON.stringify({
      companyName: 'Page Auth Co', email,
      password: TEST_PW,
    }),
  });
  assert.equal(res.status, 201);
  return sessionCookie(res);
}

test('H2: /leads redirects unauthenticated visitors to /login', async () => {
  const c = client(base);
  const r = await c.get('/leads');
  assert.equal(r.status, 302);
});

test('H2: direct /leads.html cannot bypass the auth gate', async () => {
  const c = client(base);
  const r = await c.get('/leads.html');
  // Canonicalized to /leads (which then enforces auth -> /login).
  assert.equal(r.status, 302);
});

test('H2: /leads serves 200 to authenticated users', async () => {
  const c = client(base);
  const r0 = await c.post('/api/auth/register', {
    companyName: 'Leads Page Co', email: 'leads-page@example.org', password: TEST_PW,
  });
  assert.equal(r0.status, 201);
  const r = await c.get('/leads');
  assert.equal(r.status, 200);
});

test('M1: /api/leads/sources requires auth (401 without session)', async () => {
  const c = client(base);
  const r = await c.get('/api/leads/sources');
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'unauthorized');
});

test('M2: login revokes the presenting session (rotation)', async () => {
  const email = 'rotate@example.org';
  const cookieA = await register(email);
  assert.ok(cookieA, 'register should set a session cookie');

  // Log in while presenting session A.
  let res = await fetch(base + '/api/auth/login', {
    method: 'POST', redirect: 'manual',
    headers: { ...H, Cookie: cookieA },
    body: JSON.stringify({ email, password: TEST_PW }),
  });
  assert.equal(res.status, 200);
  const cookieB = sessionCookie(res);
  assert.ok(cookieB, 'login should set a session cookie');
  assert.notEqual(cookieA, cookieB, 'post-login token must differ from the presented one');

  // Old session A is dead.
  res = await fetch(base + '/api/auth/me', {
    headers: { 'X-Requested-With': 'XMLHttpRequest', Cookie: cookieA }, redirect: 'manual',
  });
  assert.equal(res.status, 401);

  // New session B works.
  res = await fetch(base + '/api/auth/me', {
    headers: { 'X-Requested-With': 'XMLHttpRequest', Cookie: cookieB }, redirect: 'manual',
  });
  assert.equal(res.status, 200);
});
