'use strict';
/**
 * Signup seeding tests — 2026-11-19 (full-package rule):
 * a new signup starts FROM SCRATCH. Only Armor Bearer affiliates get
 * the full package (13,871 house contacts), by deliberate grant
 * (influencer webhook -> arsenalSeed, or the deliberate affiliate
 * script). The old signup seeds copied the full house arsenal into
 * EVERY new tenant, which grew the migration export past 52 MB until
 * it 502'd and broke the backup and the dashboard sync.
 *
 * The contract under test: signup -> empty tenant (0 influencers,
 * 0 goals, 0 campaigns, 0 email snapshots), and nothing arrives
 * later — no background seeding, no boot re-planting. A deliberate
 * grant (seedTenantInfluencers) still loads a tenant, idempotently.
 *
 * NOTE: this file deliberately does NOT call setupTestEnv() from helpers.js,
 * because the harness sets MANNA_SKIP_SIGNUP_SEED=1. This file exercises the
 * real production path.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2rm-test-'));
// 2026-11-19: clean up the temp DB at exit (see tests/helpers.js).
process.on('exit', () => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});
process.env.DATABASE_PATH = path.join(dir, 'test.db');
process.env.NODE_ENV = 'test';
delete process.env.MANNA_SKIP_SIGNUP_SEED; // exercise the real signup path

let server, base, db;
before(async () => {
  const app = require('../src/server');
  db = require('../src/db').db;
  server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); });

async function register(email, companyName) {
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({
      companyName: companyName || ('Co ' + email),
      email, password: 'seed-test-password-12', plan: 'starter',
    }),
  });
  const json = await res.json();
  assert.equal(res.status, 201);
  return json.tenant;
}

const count = (table, tid) =>
  db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`).get(tid).n;

// The old tests polled for the seeded state to arrive. The new contract is
// the opposite: poll to prove NOTHING arrives — no background seed, no boot
// re-planting — for the whole window.
async function waitQuiet(tid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (count('influencers', tid) !== 0
      || count('goals', tid) !== 0
      || count('email_snapshots', tid) !== 0
      || count('email_campaigns', tid) !== 0) return false;
    await new Promise(r => setTimeout(r, 250));
  }
  return true;
}

test('signup starts from scratch: no house contacts, no goals, no campaigns', async () => {
  const tenant = await register('scratch@example.com', 'Scratch Co');
  assert.equal(await waitQuiet(tenant.id), true);
  assert.equal(count('influencers', tenant.id), 0);
  assert.equal(count('goals', tenant.id), 0);
  assert.equal(count('email_campaigns', tenant.id), 0);
  assert.equal(count('email_snapshots', tenant.id), 0);
});

test('a deliberate grant still loads a tenant, idempotently', async () => {
  const tenant = await register('grant@example.com', 'Grant Co');
  const { seedTenantInfluencers } = require('../scripts/seed-contacts');
  const r1 = seedTenantInfluencers(tenant.id);
  assert.equal(r1.skipped, false);
  assert.ok(r1.count > 0);
  const r2 = seedTenantInfluencers(tenant.id);
  assert.equal(r2.skipped, true);
  assert.equal(count('influencers', tenant.id), r1.count);
});

test('a second signup does not touch the first tenant', async () => {
  const t1 = await register('scope1@example.com', 'Scope One');
  const t2 = await register('scope2@example.com', 'Scope Two');
  assert.equal(await waitQuiet(t1.id, 3000), true);
  assert.equal(await waitQuiet(t2.id, 3000), true);
  assert.equal(count('influencers', t1.id), 0);
  assert.equal(count('influencers', t2.id), 0);
});

test('registration still succeeds (201) with no seeding', async () => {
  const tenant = await register('resilient@example.com', 'Resilient Co');
  assert.ok(tenant.id > 0);
});
