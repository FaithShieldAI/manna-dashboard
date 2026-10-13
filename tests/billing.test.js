'use strict';
/**
 * Billing / plan-limit tests:
 *  - starter ($50): 2 projects max, 5k emails/mo quota
 *  - pro ($100): 10 projects max, 20k emails/mo quota
 *  - GET /api/billing reports plan, limits, usage (Stripe stubbed)
 *  - POST /api/email/log-send enforces the monthly quota
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

async function registerStarter(email) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Starter Co ' + email,
    email,
    password: 'starter-secret-pw-1',
    plan: 'starter',
  });
  assert.equal(r.status, 201);
  return c;
}

test('starter is capped at 2 projects', async () => {
  const c = await registerStarter('starter1@example.org');
  for (const key of ['proj-a', 'proj-b']) {
    const r = await c.post('/api/sites', { siteKey: key, name: 'Project ' + key });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.ok(r.json.collect_key, 'collect_key issued on create');
  }
  const over = await c.post('/api/sites', { siteKey: 'proj-c', name: 'Project C' });
  assert.equal(over.status, 403);
  assert.equal(over.json.error, 'project_limit_reached');
  assert.equal(over.json.limit, 2);
  assert.equal(over.json.used, 2);
});

test('pro allows up to 10 projects', async () => {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Pro Co', email: 'pro1@example.org',
    password: 'pro-secret-pw-1234', plan: 'pro',
  });
  assert.equal(r.status, 201);
  for (let i = 0; i < 10; i++) {
    const cr = await c.post('/api/sites', { siteKey: 'p' + i, name: 'P ' + i });
    assert.equal(cr.status, 201);
  }
  const over = await c.post('/api/sites', { siteKey: 'p10', name: 'P 10' });
  assert.equal(over.status, 403);
  assert.equal(over.json.limit, 10);
});

test('billing endpoint reports plan, limits, usage (stripe stubbed)', async () => {
  const c = await registerStarter('starter2@example.org');
  const r = await c.get('/api/billing');
  assert.equal(r.status, 200);
  assert.equal(r.json.plan, 'starter');
  assert.equal(r.json.price_label, '$50/mo');
  assert.equal(r.json.limits.projects, 2);
  assert.equal(r.json.limits.emails_per_month, 5000);
  assert.equal(r.json.usage.projects_used, 0);
  assert.equal(r.json.usage.emails_remaining, 5000);
  assert.equal(r.json.checkout.stubbed, true);
  assert.match(r.json.tagline, /little guy money/);
});

test('email quota enforced at 5k/mo for starter', async () => {
  const c = await registerStarter('starter3@example.org');
  const ok = await c.post('/api/email/log-send', { count: 4999 });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.used, 4999);
  assert.equal(ok.json.remaining, 1);

  const over = await c.post('/api/email/log-send', { count: 2 });
  assert.equal(over.status, 403);
  assert.equal(over.json.error, 'email_quota_exceeded');
  assert.equal(over.json.remaining, 1);

  const exact = await c.post('/api/email/log-send', { count: 1 });
  assert.equal(exact.status, 200);
  assert.equal(exact.json.remaining, 0);
  assert.equal(exact.json.delivery.stubbed, true);
});

test('site creation validates input', async () => {
  const c = await registerStarter('starter4@example.org');
  const bad = await c.post('/api/sites', { siteKey: 'BAD KEY!!', name: 'X' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_site_key');
  const noname = await c.post('/api/sites', { siteKey: 'ok-key', name: 'x' });
  assert.equal(noname.status, 400);
  const dup = await c.post('/api/sites', { siteKey: 'dup', name: 'Dup One' });
  assert.equal(dup.status, 201);
  const dup2 = await c.post('/api/sites', { siteKey: 'dup', name: 'Dup Two' });
  assert.equal(dup2.status, 409);
  assert.equal(dup2.json.error, 'site_key_taken');
});
