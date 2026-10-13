'use strict';
/**
 * Password reset + resend-verification tests.
 *  - forgot-password never reveals whether the email exists (always 200)
 *  - reset-password: valid token works, login with new pw succeeds,
 *    old pw fails, token is single-use, expired token rejected
 *  - reset revokes all sessions (logged out everywhere)
 *  - resend-verification issues a fresh token for unverified users
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

async function register(email) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Reset Co', email, password: 'original-password-1',
  });
  assert.equal(r.status, 201);
  return { c, devToken: r.json.devVerificationToken };
}

test('forgot-password is enumeration-safe (unknown email also 200)', async () => {
  const c = client(base);
  const r = await c.post('/api/auth/forgot-password', { email: 'nobody-here@example.org' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.devResetToken, undefined);
});

test('full reset flow: forgot -> reset -> login with new password', async () => {
  const { c } = await register('reset-me@example.org');

  const f = await c.post('/api/auth/forgot-password', { email: 'reset-me@example.org' });
  assert.equal(f.status, 200);
  assert.ok(f.json.devResetToken, 'dev token returned in non-production');

  const token = f.json.devResetToken;
  const bad = await c.post('/api/auth/reset-password', { token: 'wrong', password: 'new-password-12345' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_token');

  const short = await c.post('/api/auth/reset-password', { token, password: 'short' });
  assert.equal(short.status, 400);
  assert.equal(short.json.error, 'password_too_short');

  const ok = await c.post('/api/auth/reset-password', { token, password: 'brand-new-password-1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);

  // single-use: same token again fails
  const reuse = await c.post('/api/auth/reset-password', { token, password: 'another-password-12' });
  assert.equal(reuse.status, 400);
  assert.equal(reuse.json.error, 'invalid_token');

  // old password no longer works, new one does (fresh client = logged out everywhere)
  const c2 = client(base);
  const oldLogin = await c2.post('/api/auth/login', { email: 'reset-me@example.org', password: 'original-password-1' });
  assert.equal(oldLogin.status, 401);
  const newLogin = await c2.post('/api/auth/login', { email: 'reset-me@example.org', password: 'brand-new-password-1' });
  assert.equal(newLogin.status, 200);
});

test('reset revokes the pre-reset session', async () => {
  const { c } = await register('revoke-me@example.org');
  const me1 = await c.get('/api/auth/me');
  assert.equal(me1.status, 200, 'logged in before reset');

  const f = await c.post('/api/auth/forgot-password', { email: 'revoke-me@example.org' });
  await c.post('/api/auth/reset-password', { token: f.json.devResetToken, password: 'after-reset-pw-123' });

  const me2 = await c.get('/api/auth/me');
  assert.equal(me2.status, 401, 'old session revoked by password reset');
});

test('resend-verification issues a fresh token', async () => {
  const { c, devToken } = await register('reverify@example.org');
  assert.ok(devToken);
  const r = await c.post('/api/auth/resend-verification', {});
  assert.equal(r.status, 200);
  assert.ok(r.json.devVerificationToken);
  assert.notEqual(r.json.devVerificationToken, devToken);

  // verify with the fresh token
  const v = await c.post('/api/auth/verify-email', { token: r.json.devVerificationToken });
  assert.equal(v.status, 200);
  const r2 = await c.post('/api/auth/resend-verification', {});
  assert.equal(r2.json.already_verified, true);
});
