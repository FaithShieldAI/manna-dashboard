'use strict';
/**
 * Auth flow tests: register, login, me, logout, logout-everywhere,
 * validation errors, duplicate email, bad credentials, email verification.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

test('register creates tenant + owner and logs in', async () => {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Test Co',
    email: 'founder@testco.example',
    password: 'supersecret-password-1',
    displayName: 'Founder',
    plan: 'pro',
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.user.email, 'founder@testco.example');
  assert.equal(r.json.user.role, 'owner');
  assert.equal(r.json.tenant.slug, 'test-co');
  assert.equal(r.json.tenant.plan, 'pro');

  const me = await c.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, 'founder@testco.example');
});

test('register rejects short password', async () => {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Short PW Co',
    email: 'shortpw@example.org',
    password: 'too-short',
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'password_too_short');
});

test('register rejects duplicate email without confirming it exists', async () => {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Another Co',
    email: 'founder@testco.example', // already registered above
    password: 'another-secret-pw-1',
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'email_unavailable');
});

test('login works and bad credentials do not', async () => {
  const c = client(base);
  const bad = await c.post('/api/auth/login', {
    email: 'founder@testco.example', password: 'wrong-password-zzz',
  });
  assert.equal(bad.status, 401);

  const unknown = await c.post('/api/auth/login', {
    email: 'nobody@nowhere.example', password: 'wrong-password-zzz',
  });
  assert.equal(unknown.status, 401); // same shape, no user enumeration

  const good = await c.post('/api/auth/login', {
    email: 'founder@testco.example', password: 'supersecret-password-1',
  });
  assert.equal(good.status, 200);
  assert.equal(good.json.ok, true);

  const me = await c.get('/api/auth/me');
  assert.equal(me.status, 200);
});

test('logout revokes the session', async () => {
  const c = client(base);
  await c.post('/api/auth/login', {
    email: 'founder@testco.example', password: 'supersecret-password-1',
  });
  assert.equal((await c.get('/api/auth/me')).status, 200);
  assert.equal((await c.post('/api/auth/logout')).json.ok, true);
  assert.equal((await c.get('/api/auth/me')).status, 401);
});

test('unauthenticated API access is rejected', async () => {
  const c = client(base);
  for (const p of ['/api/overview', '/api/sites', '/api/funnels', '/api/goals']) {
    const r = await c.get(p);
    assert.equal(r.status, 401, p);
  }
});

test('CSRF check blocks mutating requests without the header', async () => {
  // raw fetch without X-Requested-With
  const loginRes = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'founder@testco.example', password: 'supersecret-password-1' }),
  });
  assert.equal(loginRes.status, 403);
  assert.equal((await loginRes.json()).error, 'csrf_check_failed');
});

test('email verification flow works', async () => {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Verify Co',
    email: 'verify@verifyco.example',
    password: 'verify-secret-pw-12',
  });
  assert.equal(r.status, 201);
  const token = r.json.devVerificationToken;
  assert.ok(token, 'dev token returned in non-production');

  const v = await c.post('/api/auth/verify-email', { token });
  assert.equal(v.json.ok, true);

  const again = await c.post('/api/auth/verify-email', { token });
  assert.equal(again.status, 400); // single-use
});
