'use strict';
/**
 * "Grow with Armor Bearer" Overview card tests:
 *  - the served /app HTML contains the card, the Armor Bearer link, and
 *    the referral empty-state block (Manna stores no referral link yet,
 *    so the empty state is the honest default render)
 *  - serve-time template transforms stay healthy after the card edit
 *  - the card's data contract: /api/auth/me exposes tenant.plan —
 *    'influencer' is the affiliate state (set by the AB -> Manna
 *    provisioning webhook, migration 016) — and the tenant payload
 *    carries NO referral link field, which is exactly why the card must
 *    not (and does not) fabricate one
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

async function register(email) {
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: H, redirect: 'manual',
    body: JSON.stringify({ companyName: 'AB Card Co', email, password: TEST_PW }),
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

test('served dashboard contains the Armor Bearer card and transform health is ok', async () => {
  const cookie = await register('abcard-page@example.org');
  const res = await fetch(base + '/app', { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('id="ab-grow-card"'), 'card must be present in the served dashboard');
  assert.ok(html.includes('https://armorbearer.d2rmmedia.com/'), 'card must link to Armor Bearer');
  assert.ok(html.includes('id="ab-referral-empty"'), 'referral empty state must be present');
  assert.ok(html.includes('id="ab-affiliate-block"'), 'affiliate block must be present');

  const health = await fetch(base + '/api/transform-health', {
    headers: { 'X-Requested-With': 'XMLHttpRequest', Cookie: cookie },
  });
  assert.equal(health.status, 200);
  const hj = await health.json();
  assert.equal(hj.ok, true, 'serve-time transform targets must all still match the template');
});

test('/api/auth/me plan drives the card: non-affiliate by default, influencer after provisioning', async () => {
  const cookie = await register('abcard-me@example.org');
  const before1 = await me(cookie);
  assert.notEqual(before1.tenant.plan, 'influencer', 'fresh signup must not be an affiliate');
  assert.ok(!('referral_link' in before1.tenant) && !('referral_url' in before1.tenant),
    'tenant payload carries no referral link — the card empty state is the correct render');

  const { db } = require('../src/db');
  db.prepare("UPDATE tenants SET plan = 'influencer' WHERE id = ?").run(before1.tenant.id);

  const after1 = await me(cookie);
  assert.equal(after1.tenant.plan, 'influencer', "provisioned tenant must read back plan 'influencer'");
});
