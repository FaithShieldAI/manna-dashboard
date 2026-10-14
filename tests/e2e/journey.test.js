'use strict';
/**
 * E2E JOURNEY tests — the exact first-time path a new customer walks:
 * signup -> onboarding -> dashboard, at the HTTP layer with a real cookie
 * jar (Layer 1), plus the negative auth cases. (See helpers.js for why the
 * network layer runs in node rather than Chromium here.)
 *
 * Flow mirrors the shipped frontend exactly:
 *   signup: public/js/signup.js  -> POST /api/auth/register -> /onboarding
 *   login:  public/js/login.js   -> POST /api/auth/login    -> /app
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer } = require('../helpers');
const {
  newJar, fetchWithJar, jarHasSessionCookie,
  uniqueEmail, frontendHeaders, TEST_PASSWORD,
} = require('./helpers');

setupTestEnv();

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(() => server.close());

/** EXACTLY what public/js/signup.js sends. */
async function signupLikeFrontend(jar, base, { companyName, displayName, email, password, plan = 'starter' }) {
  return fetchWithJar(jar, base + '/api/auth/register', {
    method: 'POST',
    headers: frontendHeaders(),
    body: { companyName, displayName, email, password, plan },
  });
}

test('E2E JOURNEY: signup -> onboarding -> app, brand-new user', async () => {
  const jar = newJar();
  const email = uniqueEmail('e2e-journey');

  // 1. The real signup form payload.
  const r = await signupLikeFrontend(jar, base, {
    companyName: 'Perimeter Walkers',
    displayName: 'Journey Tester',
    email,
    password: TEST_PASSWORD,
  });
  assert.equal(r.status, 201, `FAIL: signup returned HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  assert.equal(r.json && r.json.ok, true, `FAIL: signup not ok: ${r.text.slice(0, 200)}`);
  assert.ok(
    await jarHasSessionCookie(jar, base + '/'),
    'FAIL: signup did not set a storable session cookie (user would land logged-out)'
  );

  // 2. Signed-in user reaches /onboarding (the post-signup landing page).
  let page = await fetchWithJar(jar, base + '/onboarding');
  assert.equal(page.status, 200, `FAIL: /onboarding returned HTTP ${page.status} after signup`);
  assert.ok(page.text.includes('panel-overview'), 'FAIL: onboarding dashboard missing after signup');
  for (const tab of ['overview', 'email', 'warm', 'conversions', 'sites', 'influencers', 'social', 'ipregistry']) {
    assert.ok(
      page.text.includes(`data-tab="${tab}"`),
      `FAIL: onboarding missing tab button "${tab}" for a brand-new user`
    );
  }

  // 3. And the main app, with the Vetted tab present.
  page = await fetchWithJar(jar, base + '/app');
  assert.equal(page.status, 200, `FAIL: /app returned HTTP ${page.status} after signup`);
  assert.ok(page.text.includes('data-tab="vetted"'), 'FAIL: Vetted tab missing on /app for new user');
  assert.ok(page.text.includes('data-tab="billing"'), 'FAIL: Billing tab missing on /app for new user');
});

test('E2E JOURNEY: second login works (returning user)', async () => {
  const jar = newJar();
  const email = uniqueEmail('e2e-journey-login');

  await signupLikeFrontend(jar, base, {
    companyName: 'Return Co', displayName: 'Returner', email, password: TEST_PASSWORD,
  });

  // Fresh jar = fresh browser; log back in exactly like public/js/login.js.
  const jar2 = newJar();
  const r = await fetchWithJar(jar2, base + '/api/auth/login', {
    method: 'POST',
    headers: frontendHeaders(),
    body: { email, password: TEST_PASSWORD },
  });
  assert.equal(r.status, 200, `FAIL: returning-user login HTTP ${r.status}`);
  assert.equal(r.json && r.json.ok, true, 'FAIL: returning-user login not ok');
  assert.ok(await jarHasSessionCookie(jar2, base + '/'), 'FAIL: no session cookie on re-login');

  const app = await fetchWithJar(jar2, base + '/app');
  assert.equal(app.status, 200, 'FAIL: /app not reachable after re-login');
});

test('E2E JOURNEY: signup rejects short password with a clear error', async () => {
  const jar = newJar();
  const r = await signupLikeFrontend(jar, base, {
    companyName: 'Short PW Co', displayName: 'Shorty',
    email: uniqueEmail('e2e-shortpw'), password: 'short',
  });
  assert.equal(r.status, 400, `expected 400, got HTTP ${r.status}`);
  assert.equal(r.json && r.json.error, 'password_too_short', `unexpected error: ${r.text.slice(0, 120)}`);
  assert.ok(
    !(await jarHasSessionCookie(jar, base + '/')),
    'FAIL: rejected signup still set a session cookie'
  );
});

test('E2E JOURNEY: signup rejects duplicate email without confirming it exists', async () => {
  const email = uniqueEmail('e2e-dupe');
  const jar1 = newJar();
  const first = await signupLikeFrontend(jar1, base, {
    companyName: 'First Co', displayName: 'First', email, password: TEST_PASSWORD,
  });
  assert.equal(first.status, 201, 'setup signup failed');

  const jar2 = newJar();
  const r = await signupLikeFrontend(jar2, base, {
    companyName: 'Second Co', displayName: 'Second', email, password: TEST_PASSWORD,
  });
  assert.equal(r.status, 409, `expected 409, got HTTP ${r.status}`);
  assert.equal(r.json && r.json.error, 'email_unavailable', `unexpected error: ${r.text.slice(0, 120)}`);
});
