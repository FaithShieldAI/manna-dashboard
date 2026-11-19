'use strict';
/**
 * Boot-seeder grant gate (2026-11-19, full-package rule):
 * seedInfluencers() at server startup tops up ONLY granted tenants —
 * the house tenant (id 1) and tenants with a recorded 'd2rm-arsenal'
 * grant in tenant_seed_state (Armor Bearer affiliates, granted
 * deliberately by the influencer webhook or the affiliate script).
 * A standalone Manna tenant starts from scratch and is never seeded
 * here. The old behavior seeded EVERY empty tenant, copying 13,871
 * house contacts into each new signup and growing the migration
 * export past 52 MB until it 502'd.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer } = require('./helpers');

setupTestEnv();

let server, db, unscoped;
before(async () => {
  ({ server } = await startServer());
  ({ db, unscoped } = require('../src/db'));
});
after(async () => { server.close(); });

const { seedInfluencers } = require('../scripts/seed-contacts');

const infCount = (tid) =>
  db.prepare('SELECT COUNT(*) AS n FROM influencers WHERE tenant_id = ?').get(tid).n;

test('boot seeder skips an ungranted tenant and seeds a granted one', async () => {
  const tPlain = Number(unscoped.createTenant('Plain Co', 'plain-co', 'starter').lastInsertRowid);
  const tGrant = Number(unscoped.createTenant('Grant Co', 'grant-co', 'starter').lastInsertRowid);
  db.prepare(
    "INSERT INTO tenant_seed_state (tenant_id, seed_key, version, row_count, seeded_at, updated_at) VALUES (?, 'd2rm-arsenal', 1, 0, ?, ?)"
  ).run(tGrant, new Date().toISOString(), new Date().toISOString());
  assert.equal(infCount(tPlain), 0);
  assert.equal(infCount(tGrant), 0);
  const r = await seedInfluencers();
  assert.equal(infCount(tPlain), 0);
  assert.ok(infCount(tGrant) > 0);
  assert.ok(r.totalInserted > 0);
});

test('boot seeder is idempotent for a granted tenant', async () => {
  const tGrant = Number(unscoped.createTenant('Grant Two', 'grant-two', 'starter').lastInsertRowid);
  db.prepare(
    "INSERT INTO tenant_seed_state (tenant_id, seed_key, version, row_count, seeded_at, updated_at) VALUES (?, 'd2rm-arsenal', 1, 0, ?, ?)"
  ).run(tGrant, new Date().toISOString(), new Date().toISOString());
  await seedInfluencers();
  const first = infCount(tGrant);
  assert.ok(first > 0);
  await seedInfluencers();
  assert.equal(infCount(tGrant), first);
});
