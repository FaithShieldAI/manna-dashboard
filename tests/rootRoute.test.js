'use strict';
/**
 * Root front-door tests (2026-10-28 audit fix — "Fix the rest").
 *
 * The root address used to bounce every visitor to /login. Now:
 * - GET / without a session -> 200, the SALES PAGE (public/sales.html)
 * - GET /login -> 200, login page unchanged
 * - GET / with a session -> 302 to /app (the old behavior, preserved)
 * - GET /app with a session -> 200 (authenticated flow unaffected)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer } = require('./helpers');

setupTestEnv();

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

const H = { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' };
const TEST_PW = 'Test' + 'Pass' + '1234' + '5678';

function sessionCookie(res) {
  const m = (res.headers.get('set-cookie') || '').match(/d2rm_session=[^;]*/);
  return m && m[0];
}

test('front door: GET / unauthenticated serves the sales page (200)', async () => {
  const res = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('<h1>Big agency data, little guy money.</h1>'), 'sales headline present');
  assert.ok(body.includes('$29.99'), 'sales pricing present');
  assert.ok(!body.includes('Welcome back to your marketing command center'), 'must not be the login page');
});

test('front door: GET /login still serves the login page (200)', async () => {
  const res = await fetch(base + '/login', { redirect: 'manual' });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('Welcome back'), 'login page marker present');
});

test('front door: GET / with a session redirects to /app; /app serves 200', async () => {
  const reg = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: H, redirect: 'manual',
    body: JSON.stringify({
      companyName: 'Front Door Co', email: 'front-door@example.org', password: TEST_PW,
    }),
  });
  assert.equal(reg.status, 201);
  const cookie = sessionCookie(reg);
  assert.ok(cookie, 'register should set a session cookie');

  const root = await fetch(base + '/', { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(new URL(root.headers.get('location'), base).pathname, '/app');

  const appRes = await fetch(base + '/app', { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(appRes.status, 200);
});
