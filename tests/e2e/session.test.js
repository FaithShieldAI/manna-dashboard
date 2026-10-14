'use strict';
/**
 * E2E SESSION tests — the "ultimate check" for the bug Michael hit on
 * 2026-10-14: signed in, refreshed the browser, got
 * {"ok":false,"error":"unauthorized"}.
 *
 * Layer 1 (HTTP + real RFC-6265 cookie jar): replays EXACTLY what the
 * shipped frontend does — the login page's fetch() with its real headers —
 * and a real cookie jar (tough-cookie) decides what a browser would store
 * and re-send. "Refresh" is a fresh GET with the jar's cookies, which is
 * precisely what F5 does. If any of these fail, the session bug is back —
 * DO NOT SHIP.
 *
 * What this catches: Set-Cookie a browser would reject (Secure on http,
 * wrong Path/Domain, bad SameSite), session not persisted server-side,
 * missing credentials on requests, logout not actually ending the session.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer } = require('../helpers');
const {
  newJar, fetchWithJar, jarHasSessionCookie, registerUser,
  loginLikeFrontend, uniqueEmail, frontendHeaders, TEST_PASSWORD,
} = require('./helpers');

setupTestEnv();

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(() => server.close());

test('E2E SESSION: login sets a session cookie a real browser would store', async () => {
  const jar = newJar();
  const email = uniqueEmail('e2e-session');
  await registerUser(base, { email });

  // EXACTLY what public/js/login.js sends.
  const r = await loginLikeFrontend(jar, base, email, TEST_PASSWORD);
  assert.equal(r.status, 200, `login failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  assert.equal(r.json && r.json.ok, true, `login not ok: ${r.text.slice(0, 200)}`);

  // The honest check: would a real browser's cookie jar keep this cookie?
  // (Fails if e.g. Secure is set on http, Path/Domain mismatch, instant expiry.)
  assert.ok(
    await jarHasSessionCookie(jar, base + '/'),
    'FAIL: login response did not set a storable d2rm_session cookie — ' +
    'a real browser would have no session (this is the refresh bug)'
  );
});

test('E2E SESSION: session survives refresh — GET /app twice with the same jar', async () => {
  const jar = newJar();
  const email = uniqueEmail('e2e-session-refresh');
  await registerUser(base, { email });
  const login = await loginLikeFrontend(jar, base, email, TEST_PASSWORD);
  assert.equal(login.json && login.json.ok, true, 'login failed');

  async function loadApp() {
    const r = await fetchWithJar(jar, base + '/app');
    return r;
  }

  // First load (what the frontend does after window.location.href = '/app').
  let r = await loadApp();
  assert.equal(r.status, 200, `FAIL: /app returned HTTP ${r.status} right after login`);
  assert.ok(!r.text.includes('"error":"unauthorized"'), 'FAIL: unauthorized JSON on /app after login');
  assert.ok(r.text.includes('panel-overview'), 'FAIL: /app did not render the dashboard after login');

  // THE critical check — F5: brand-new request, same cookies, like a refresh.
  r = await loadApp();
  assert.equal(r.status, 200, `FAIL: /app returned HTTP ${r.status} AFTER REFRESH (session lost!)`);
  assert.ok(
    !r.text.includes('"error":"unauthorized"') && !r.text.includes('"ok":false'),
    `FAIL: unauthorized JSON after refresh — THE 2026-10-14 BUG IS BACK. Body: ${r.text.slice(0, 200)}`
  );
  assert.ok(r.text.includes('panel-overview'), 'FAIL: dashboard missing after refresh');
  // Note: the dashboard HTML legitimately contains the string '/login' inside
  // its own logout-button JS (location.href='/login' after logout), so we
  // assert on status + dashboard markers instead of the raw string.
});

test('E2E SESSION: session works across pages (/onboarding after /app)', async () => {
  const jar = newJar();
  const email = uniqueEmail('e2e-session-nav');
  await registerUser(base, { email });
  await loginLikeFrontend(jar, base, email, TEST_PASSWORD);

  const r = await fetchWithJar(jar, base + '/onboarding');
  assert.equal(r.status, 200, `FAIL: /onboarding returned HTTP ${r.status}`);
  assert.ok(!r.text.includes('"error":"unauthorized"'), 'FAIL: unauthorized JSON on /onboarding');
  assert.ok(r.text.includes('panel-overview'), 'FAIL: onboarding dashboard missing');
});

test('E2E SESSION: anonymous GET /app redirects to /login (expected behavior)', async () => {
  const jar = newJar(); // no login -> empty jar, like a fresh browser
  const r = await fetchWithJar(jar, base + '/app');
  assert.equal(r.status, 302, `expected 302 to /login, got HTTP ${r.status}`);
  assert.ok(
    String(r.headers.get('location')).includes('/login'),
    `expected redirect to /login, got: ${r.headers.get('location')}`
  );
});

test('E2E SESSION: logout ends the session — refresh afterwards requires login', async () => {
  const jar = newJar();
  const email = uniqueEmail('e2e-session-logout');
  await registerUser(base, { email });
  await loginLikeFrontend(jar, base, email, TEST_PASSWORD);

  let r = await fetchWithJar(jar, base + '/app');
  assert.equal(r.status, 200, 'login did not produce a working session');

  // EXACTLY what the UI logout does.
  const out = await fetchWithJar(jar, base + '/api/auth/logout', {
    method: 'POST',
    headers: frontendHeaders(),
  });
  assert.equal(out.json && out.json.ok, true, 'logout failed');

  // Refresh after logout must NOT be authenticated anymore.
  r = await fetchWithJar(jar, base + '/app');
  assert.equal(r.status, 302, `FAIL: after logout, /app returned HTTP ${r.status} instead of redirecting`);
  assert.ok(
    String(r.headers.get('location')).includes('/login'),
    'FAIL: after logout, refresh did not go to /login'
  );
});

test('E2E SESSION: wrong password sets NO session cookie', async () => {
  const jar = newJar();
  const email = uniqueEmail('e2e-session-badpw');
  await registerUser(base, { email });

  const r = await loginLikeFrontend(jar, base, email, 'wrong-password-123');
  assert.equal(r.status, 401, `expected 401, got HTTP ${r.status}`);
  assert.ok(
    !(await jarHasSessionCookie(jar, base + '/')),
    'FAIL: failed login still set a session cookie'
  );
});
