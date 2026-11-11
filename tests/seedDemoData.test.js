'use strict';
/**
 * Seed-demo-data fossil fix (2026-11-10): scripts/seed-demo-data.js runs
 * for every tenant at every server boot (src/server.js) and at signup
 * (src/routes/auth.js). It used to UPSERT unconditionally, carrying the
 * retired 'sustained' goal, a frozen email_collection value (1578) and
 * the frozen 2026-10-14 email windows (1042/223/19 in all four) — so
 * every restart re-planted sustained, reset live goal counters
 * (including the Stripe-fed faithshield goal) and re-froze
 * email_snapshots until the mail-truth chain re-posted.
 *
 * The seed is now first-run-only and fossil-free:
 *   1. GOALS come from src/lib/syncD2rm.js (single source of truth):
 *      no 'sustained', 'mannaai' + 'two_fishes' present.
 *   2. Goal writes are insert-only — existing progress is never reset.
 *   3. email_snapshots get zeroed insert-only starter rows; the frozen
 *      capture is never written.
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

const { seedDemoData, GOALS: SEED_GOALS } = require('../scripts/seed-demo-data');

function makeTenant(slug) {
  const r = unscoped.createTenant('Seed ' + slug, slug, 'starter');
  return Number(r.lastInsertRowid);
}

const goalRows = (tid) => db.prepare(
  'SELECT goal_key, label, current_value, goal_value, unit FROM goals WHERE tenant_id = ? ORDER BY goal_key'
).all(tid);
const snapRows = (tid) => db.prepare(
  'SELECT window_key, sent, opens, clicks, unsubs, bounces, warm_total FROM email_snapshots WHERE tenant_id = ? ORDER BY window_key'
).all(tid);
const count = (table, tid) =>
  db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`).get(tid).n;

test('seed GOALS are the syncD2rm GOALS (single source of truth, no sustained)', () => {
  const { GOALS } = require('../src/lib/syncD2rm');
  assert.deepEqual(SEED_GOALS, GOALS);
  assert.deepEqual(
    SEED_GOALS.map((g) => g.goal_key).sort(),
    ['armor_bearer', 'email_collection', 'faithshield', 'k_punk', 'mannaai', 'two_fishes'],
  );
  assert.ok(!SEED_GOALS.some((g) => g.goal_key === 'sustained'));
});

test('fresh tenant gets the full new goal set, zeroed snapshots, campaigns, and no sustained', () => {
  const tid = makeTenant('seed-fresh');
  seedDemoData('seed-fresh');

  const goals = goalRows(tid);
  assert.deepEqual(goals.map((g) => g.goal_key),
    ['armor_bearer', 'email_collection', 'faithshield', 'k_punk', 'mannaai', 'two_fishes']);
  const byKey = Object.fromEntries(goals.map((g) => [g.goal_key, g]));
  assert.deepEqual({ ...byKey.mannaai }, {
    goal_key: 'mannaai', label: 'MannaAi users', current_value: 0, goal_value: 100, unit: 'users',
  });
  assert.deepEqual({ ...byKey.two_fishes }, {
    goal_key: 'two_fishes', label: 'Two Fishes households', current_value: 0, goal_value: 100, unit: 'households',
  });
  // email_collection stores 0 (the syncD2rm definition leaves it null;
  // the live count is applied by the read path / the D2RM sync).
  assert.equal(byKey.email_collection.current_value, 0);

  // Snapshots: exactly the four windows, every counter zero — the frozen
  // 1042/223/19 capture is never written.
  const snaps = snapRows(tid);
  assert.equal(snaps.length, 4);
  for (const s of snaps) {
    assert.deepEqual(
      [s.sent, s.opens, s.clicks, s.unsubs, s.bounces, s.warm_total],
      [0, 0, 0, 0, 0, 0],
      `window ${s.window_key} must be zeroed`,
    );
  }

  assert.equal(count('email_campaigns', tid), 6);
});

test('boot re-seed of an existing tenant changes no goal progress and no live snapshot', () => {
  const tid = makeTenant('seed-existing');
  seedDemoData('seed-existing');

  // Live progress lands after the first seed: Stripe-fed faithshield
  // counter, the mirrored email count, a new-suite goal, and the
  // mail-truth chain's real 'all' window.
  db.prepare("UPDATE goals SET current_value = 7 WHERE tenant_id = ? AND goal_key = 'faithshield'").run(tid);
  db.prepare("UPDATE goals SET current_value = 13981 WHERE tenant_id = ? AND goal_key = 'email_collection'").run(tid);
  db.prepare("UPDATE goals SET current_value = 3 WHERE tenant_id = ? AND goal_key = 'mannaai'").run(tid);
  db.prepare("UPDATE email_snapshots SET sent = 2117, opens = 286, clicks = 393 WHERE tenant_id = ? AND window_key = 'all'").run(tid);

  // A restart runs the seed again for every tenant.
  seedDemoData('seed-existing');

  const byKey = Object.fromEntries(goalRows(tid).map((g) => [g.goal_key, g]));
  assert.equal(byKey.faithshield.current_value, 7);
  assert.equal(byKey.email_collection.current_value, 13981);
  assert.equal(byKey.mannaai.current_value, 3);
  assert.equal(goalRows(tid).length, 6);
  assert.ok(!('sustained' in byKey), 're-seed must not plant a sustained row');

  const all = snapRows(tid).find((s) => s.window_key === 'all');
  assert.deepEqual([all.sent, all.opens, all.clicks], [2117, 286, 393]);
});

test('seeding is idempotent across repeated runs', () => {
  const tid = makeTenant('seed-idem');
  seedDemoData('seed-idem');
  seedDemoData('seed-idem');
  seedDemoData('seed-idem');
  assert.equal(count('goals', tid), 6);
  assert.equal(count('email_snapshots', tid), 4);
  assert.equal(count('email_campaigns', tid), 6);
});
