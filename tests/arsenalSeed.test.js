'use strict';
/**
 * Affiliate arsenal preload tests ("loaded guns", Michael 2026-10-25).
 *
 * Proves, against the REAL seed file (data/seed/arsenal-seed.json,
 * generated from the master email-database.db):
 *   1. the seed file reconciles to the master DB: 13,871 rows, exact
 *      per-category counts on both the master and mapped sides;
 *   2. a fresh influencer tenant is seeded with the FULL count;
 *   3. a second run inserts ZERO (idempotency);
 *   4. pre-existing same-email rows are ADOPTED (external_id set, row
 *      content untouched), never duplicated;
 *   5. tenant isolation: seeding one tenant writes nothing to another,
 *      and each tenant can hold its own full copy;
 *   6. the Armor Bearer provisioning webhook seeds a new tenant
 *      synchronously, and a webhook replay changes nothing.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { setupTestEnv, startServer } = require('./helpers');

process.env.INFLUENCER_WEBHOOK_SECRET = 'arsenal-test-secret';
setupTestEnv();

let server, base, db, unscoped, arsenal;

const countWhere = (tid, clause, ...params) =>
  db.prepare(`SELECT COUNT(*) AS n FROM influencers WHERE tenant_id = ? AND ${clause}`).get(tid, ...params).n;
const categoryCounts = (tid) => Object.fromEntries(
  db.prepare('SELECT category, COUNT(*) AS n FROM influencers WHERE tenant_id = ? GROUP BY category')
    .all(tid).map(r => [r.category, r.n])
);

function makeTenant(slug, plan) {
  const r = unscoped.createTenant('T ' + slug, slug, plan);
  return Number(r.lastInsertRowid);
}

before(async () => {
  ({ server, base } = await startServer());
  ({ db, unscoped } = require('../src/db'));
  arsenal = require('../src/lib/arsenalSeed');
});
after(async () => { server.close(); });

test('seed file reconciles to the master database (13,871, exact category counts)', () => {
  const data = arsenal.loadSeedData();
  assert.equal(data.total, 13871);
  assert.equal(data.rows.length, 13871);
  assert.deepEqual(data.counts_by_master_category, {
    pastor: 9305, influencer: 1861, other: 1129, org: 625,
    attorney: 500, handles: 291, podcast: 160
  });
  assert.deepEqual(data.counts_by_mapped_category, {
    pastor: 9305, influencer: 2152, individual: 1129,
    church: 625, attorney: 500, podcast: 160
  });
  // master ids unique — the idempotency key is sound
  assert.equal(new Set(data.rows.map(r => r.master_id)).size, 13871);
});

test('first run inserts the full arsenal into a fresh influencer tenant', () => {
  const tid = makeTenant('arsenal-fresh', 'influencer');
  const started = Date.now();
  const r = arsenal.seedArsenalForTenant(db, tid);
  const ms = Date.now() - started;
  // eslint-disable-next-line no-console
  console.log(`[arsenal-test] first seed of 13,871 rows took ${ms}ms`);
  assert.ok(ms < 20000, `seed too slow: ${ms}ms`);
  assert.equal(r.inserted, 13871);
  assert.equal(r.adopted, 0);
  assert.equal(r.complete, true);
  assert.equal(countWhere(tid, "source = 'd2rm-arsenal'"), 13871);
  assert.equal(countWhere(tid, 'external_id IS NOT NULL'), 13871);
  assert.deepEqual(categoryCounts(tid), {
    pastor: 9305, influencer: 2152, individual: 1129,
    church: 625, attorney: 500, podcast: 160
  });
  const state = db.prepare(
    "SELECT version, row_count FROM tenant_seed_state WHERE tenant_id = ? AND seed_key = 'd2rm-arsenal'"
  ).get(tid);
  assert.deepEqual({ ...state }, { version: 1, row_count: 13871 });
});

test('second run inserts zero duplicates', () => {
  const tid = Number(db.prepare("SELECT id FROM tenants WHERE slug = 'arsenal-fresh'").get().id);
  const beforeCount = countWhere(tid, '1=1');
  const r = arsenal.seedArsenalForTenant(db, tid);
  assert.equal(r.inserted, 0);
  assert.equal(r.adopted, 0);
  assert.equal(r.already, 13871);
  assert.equal(countWhere(tid, '1=1'), beforeCount);
});

test('pre-existing same-email rows are adopted, never duplicated or overwritten', () => {
  const tid = makeTenant('arsenal-adopt', 'influencer');
  const data = arsenal.loadSeedData();
  const sample = data.rows.slice(0, 3);
  const ins = db.prepare(`
    INSERT INTO influencers (tenant_id, handle, platform, email, tier, category, status, notes, source)
    VALUES (?, ?, ?, ?, ?, ?, 'contacted', 'affiliate-collected row — keep me', 'lead-collect:youtube')
  `);
  for (const s of sample) ins.run(tid, s.handle, s.platform, s.email, s.tier, s.category);

  const r = arsenal.seedArsenalForTenant(db, tid);
  assert.equal(r.adopted, 3);
  assert.equal(r.inserted, 13871 - 3);
  assert.equal(countWhere(tid, '1=1'), 13871);
  assert.equal(countWhere(tid, 'external_id IS NOT NULL'), 13871);
  for (const s of sample) {
    const row = db.prepare(
      'SELECT notes, status, source FROM influencers WHERE tenant_id = ? AND external_id = ?'
    ).get(tid, s.master_id);
    assert.equal(row.notes, 'affiliate-collected row — keep me');
    assert.equal(row.status, 'contacted');
    assert.equal(row.source, 'lead-collect:youtube');
  }
  // and a re-run after adoption is also a no-op
  const r2 = arsenal.seedArsenalForTenant(db, tid);
  assert.equal(r2.inserted + r2.adopted, 0);
});

test('tenant isolation: seeding one tenant writes nothing to another', () => {
  const a = makeTenant('arsenal-iso-a', 'influencer');
  const b = makeTenant('arsenal-iso-b', 'starter');
  arsenal.seedArsenalForTenant(db, a);
  assert.equal(countWhere(a, 'external_id IS NOT NULL'), 13871);
  assert.equal(countWhere(b, '1=1'), 0);

  const { forTenant } = require('../src/db');
  assert.equal(forTenant(b).influencers({ limit: 5 }).length, 0);
  assert.equal(forTenant(a).influencers({ limit: 5 }).length, 5);
  assert.deepEqual(Object.fromEntries(
    forTenant(a).influencerCategoryCounts().map(r => [r.category, r.n])
  ), { pastor: 9305, influencer: 2152, individual: 1129, church: 625, attorney: 500, podcast: 160 });

  // B can hold its OWN full copy — rows are per-tenant, never shared.
  const rb = arsenal.seedArsenalForTenant(db, b);
  assert.equal(rb.inserted, 13871);
  assert.equal(countWhere(a, '1=1'), 13871);
  assert.equal(countWhere(b, '1=1'), 13871);
});

async function provision(email, secret) {
  const res = await fetch(base + '/api/webhooks/influencer-provision', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Webhook-Secret': secret || 'arsenal-test-secret'
    },
    body: JSON.stringify({ email, name: 'Arsenal Hook', armor_bearer_id: 'AbC123xYz' })
  });
  return { status: res.status, json: await res.json() };
}

test('provisioning webhook seeds the new tenant; replay inserts nothing', async () => {
  const first = await provision('arsenal-hook@example.com');
  assert.equal(first.status, 201);
  assert.equal(first.json.result, 'provisioned');
  const tid = first.json.tenant_id;
  assert.equal(countWhere(tid, "source = 'd2rm-arsenal'"), 13871);

  const replay = await provision('arsenal-hook@example.com');
  assert.equal(replay.status, 200);
  assert.equal(replay.json.result, 'already_provisioned');
  assert.equal(countWhere(tid, '1=1'), 13871);

  const bad = await provision('arsenal-hook2@example.com', 'wrong-secret');
  assert.equal(bad.status, 401);
});

test('missing seed file degrades gracefully: empty seed, no throw (packaging-miss guard)', () => {
  // Regression for the 2026-10-29 production ENOENT: .dockerignore kept
  // data/seed/arsenal-seed.json out of the Docker image, and loadSeedData
  // threw, breaking seeding. A missing file must now return an empty
  // seed (with a loud warning) so signup/webhook flows never break.
  const missing = path.join(__dirname, 'no-such-arsenal-seed.json');
  const data = arsenal.loadSeedData(missing);
  assert.equal(data.total, 0);
  assert.deepEqual(data.rows, []);

  // seedArsenalForTenant against the missing file is a no-op, not a crash.
  const tid = makeTenant('arsenal-missing', 'influencer');
  const r = arsenal.seedArsenalForTenant(db, tid, { seedPath: missing });
  assert.equal(r.inserted, 0);
  assert.equal(r.adopted, 0);
  assert.equal(r.total, 0);
  assert.equal(countWhere(tid, '1=1'), 0);

  // The empty fallback is NOT cached as the real seed: the default path
  // still loads the full file afterwards.
  assert.equal(arsenal.loadSeedData().total, 13871);
});
