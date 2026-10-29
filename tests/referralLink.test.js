'use strict';
/**
 * Referral-link loop tests (Armor Bearer -> Manna):
 *  - the provisioning webhook persists armor_bearer_id on the tenant
 *    (migration 024) instead of only logging it
 *  - re-provisioning is idempotent; a different valid code updates the
 *    stored value; a call without a code never clears it
 *  - GET /api/auth/me carries tenant.referral_link (the payload the
 *    "Grow with Armor Bearer" card reads) for provisioned tenants only
 *  - poisoned codes (quotes, slashes, 'javascript:') — whether they
 *    arrive via the webhook or are written straight into the DB — never
 *    become a link
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer } = require('./helpers');

setupTestEnv();
process.env.INFLUENCER_WEBHOOK_SECRET = 'test-webhook-secret-referral';

const { normalizeRefCode, referralLinkFor } = require('../src/lib/referral');

let server, base, db;
before(async () => {
  ({ server, base } = await startServer());
  db = require('../src/db').db;
});
after(async () => { server.close(); });

const H = { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' };
const TEST_PW = 'Test' + 'Pass' + '1234' + '5678';
const CODE1 = 'Ab3dEf7H';
const CODE2 = 'Zz9Yy8Xx';

function sessionCookie(res) {
  const m = (res.headers.get('set-cookie') || '').match(/d2rm_session=[^;]*/);
  return m && m[0];
}

async function register(email) {
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: H, redirect: 'manual',
    body: JSON.stringify({ companyName: 'Ref Co', email, password: TEST_PW }),
  });
  assert.equal(res.status, 201);
  return sessionCookie(res);
}

async function me(cookie) {
  const res = await fetch(base + '/api/auth/me', {
    headers: { 'X-Requested-With': 'XMLHttpRequest', Cookie: cookie },
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function provision(body) {
  const res = await fetch(base + '/api/webhooks/influencer-provision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': 'test-webhook-secret-referral' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function tenantAbId(email) {
  const row = db.prepare(
    'SELECT t.armor_bearer_id AS ab FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.email = ?'
  ).get(email);
  return row && row.ab;
}

test('lib: only strict alphanumeric codes become links', () => {
  assert.equal(referralLinkFor(CODE1), `https://armorbearer.d2rmmedia.com/r/${CODE1}`);
  assert.equal(normalizeRefCode(`  ${CODE1}  `), CODE1, 'surrounding whitespace is trimmed');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'a/b', 'a b', 'x"onclick="y',
    "q'--", '', '   ', null, undefined, 'ab', 'a'.repeat(33), 'code.with.dots', 'code?x=1']) {
    assert.equal(referralLinkFor(bad), null, `no link for ${JSON.stringify(bad)}`);
  }
});

test('webhook: new provision stores armor_bearer_id on the tenant', async () => {
  const r = await provision({ email: 'ref-new@example.org', name: 'New Aff', armor_bearer_id: CODE1 });
  assert.equal(r.status, 201);
  assert.equal(r.json.result, 'provisioned');
  assert.equal(tenantAbId('ref-new@example.org'), CODE1);
});

test('webhook: re-provision is idempotent and a new valid code updates the stored one', async () => {
  const again = await provision({ email: 'ref-new@example.org', armor_bearer_id: CODE1 });
  assert.equal(again.json.result, 'already_provisioned');
  assert.equal(tenantAbId('ref-new@example.org'), CODE1);
  const n = db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get('ref-new@example.org');
  assert.equal(n.n, 1, 'no duplicate user/tenant');

  const changed = await provision({ email: 'ref-new@example.org', armor_bearer_id: CODE2 });
  assert.equal(changed.json.result, 'already_provisioned');
  assert.equal(tenantAbId('ref-new@example.org'), CODE2, 'different incoming code updates the stored value');

  const noCode = await provision({ email: 'ref-new@example.org' });
  assert.equal(noCode.json.result, 'already_provisioned');
  assert.equal(tenantAbId('ref-new@example.org'), CODE2, 'a codeless call never clears the stored code');
});

test('/me: provisioned tenant gets referral_link; plain tenant gets no field', async () => {
  const cookie = await register('ref-me@example.org');
  const before1 = await me(cookie);
  assert.ok(!('referral_link' in before1.tenant), 'no referral_link before provisioning');

  const up = await provision({ email: 'ref-me@example.org', armor_bearer_id: CODE1 });
  assert.equal(up.json.result, 'plan_upgraded');
  assert.equal(tenantAbId('ref-me@example.org'), CODE1, 'upgrade path also persists the code');

  const after1 = await me(cookie);
  assert.equal(after1.tenant.plan, 'influencer');
  assert.equal(after1.tenant.referral_link, `https://armorbearer.d2rmmedia.com/r/${CODE1}`);
});

test('poisoned codes never become links — via webhook or direct DB write', async () => {
  const cookie = await register('ref-poison@example.org');
  for (const bad of ['javascript:alert(1)', 'x" onclick="evil', 'a/b/c', 'data:text/html;base64,x']) {
    const r = await provision({ email: 'ref-poison@example.org', armor_bearer_id: bad });
    assert.equal(r.json.ok, true);
    assert.equal(tenantAbId('ref-poison@example.org'), null,
      `poisoned code ${JSON.stringify(bad)} must not be stored`);
    const m = await me(cookie);
    assert.ok(!('referral_link' in m.tenant), `no link for ${JSON.stringify(bad)}`);
  }
  // Even if a bad value lands in the column by some other writer, /me
  // re-validates at construction time.
  const tid = db.prepare('SELECT tenant_id FROM users WHERE email = ?').get('ref-poison@example.org').tenant_id;
  db.prepare('UPDATE tenants SET armor_bearer_id = ? WHERE id = ?').run('bad code!', tid);
  const m2 = await me(cookie);
  assert.ok(!('referral_link' in m2.tenant), 'DB-poisoned value yields no link');
  db.prepare('UPDATE tenants SET armor_bearer_id = ? WHERE id = ?').run('javascript:alert(1)', tid);
  const m3 = await me(cookie);
  assert.ok(!('referral_link' in m3.tenant), 'scheme-shaped DB value yields no link');
});
