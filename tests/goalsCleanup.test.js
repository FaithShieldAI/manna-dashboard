'use strict';
/**
 * Goals cleanup fix (2026-11-10), three parts:
 *
 * 1. The D2RM import (src/lib/syncD2rm.js) no longer seeds a 'sustained'
 *    goal: Sustained left the suite 2026-10-28, so a future admin sync
 *    must not re-plant the row.
 * 2. GET /api/goals (and the goals block of GET /api/overview) report
 *    email_collection's current value as the tenant's LIVE lead count,
 *    overriding the counter the import froze (1,578) at read time only;
 *    the stored row is never rewritten on read.
 * 3. POST /api/auth/goals-cleanup/:token (MIGRATION_TOKEN-gated, same
 *    pattern as contacts-sync) deletes ONLY the named tenant's
 *    goal_key = 'sustained' row and is idempotent.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
process.env.MIGRATION_TOKEN = 'test-migration-token-for-sync';

let server, base, db;
before(async () => {
  ({ server, base } = await startServer());
  db = require('../src/db').db;
});
after(async () => { server.close(); });

async function register(email, companyName) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName,
    email,
    password: 'goals-cleanup-12',
    plan: 'starter',
  });
  assert.equal(r.status, 201);
  const tenantId = db.prepare('SELECT tenant_id FROM users WHERE email = ?')
    .get(email).tenant_id;
  return { c, tenantId };
}

function insertGoal(tenantId, key, label, current, goal, unit) {
  db.prepare(`
    INSERT INTO goals (tenant_id, goal_key, label, current_value, goal_value, unit)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tenantId, key, label, current, goal, unit);
}

function insertLead(tenantId, email) {
  db.prepare(`
    INSERT INTO influencers (tenant_id, handle, platform, email, tier, category, status, notes, source)
    VALUES (?, ?, NULL, ?, NULL, 'pastor', 'unvetted', '', 'test')
  `).run(tenantId, email.split('@')[0], email);
}

test('syncD2rm GOALS no longer contains sustained, and a sync plants no sustained row', async () => {
  const { GOALS, syncD2rmData } = require('../src/lib/syncD2rm');
  assert.deepEqual(
    GOALS.map((g) => g.goal_key).sort(),
    ['armor_bearer', 'email_collection', 'faithshield', 'k_punk'],
  );

  const { tenantId } = await register('sync@goals.example', 'Sync Goals Co');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2rm-goals-source-'));
  const sourceDbPath = path.join(dir, 'source.db');
  const sdb = new DatabaseSync(sourceDbPath);
  sdb.exec(`CREATE TABLE contacts (
    email TEXT, first_name TEXT, category TEXT, subcategory TEXT,
    source_file TEXT, notes TEXT)`);
  sdb.prepare('INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?)')
    .run('one@pastor.example', 'Pastor One', 'pastor', '', 'pastors.csv', '');
  sdb.close();

  syncD2rmData({ sourceDbPath, tenantId });

  const keys = db.prepare('SELECT goal_key FROM goals WHERE tenant_id = ? ORDER BY goal_key')
    .all(tenantId).map((r) => r.goal_key);
  assert.deepEqual(keys, ['armor_bearer', 'email_collection', 'faithshield', 'k_punk']);
});

test('GET /api/goals overrides email_collection with the live lead count, read-time only', async () => {
  const { c, tenantId } = await register('reader@goals.example', 'Reader Goals Co');
  // The frozen import value, as planted in production.
  insertGoal(tenantId, 'email_collection', 'Email collection', 1578, 10, 'emails');
  insertGoal(tenantId, 'armor_bearer', 'Armor Bearer <redacted>', 3, 100, 'affiliates');
  insertLead(tenantId, 'a@leads.example');
  insertLead(tenantId, 'b@leads.example');
  insertLead(tenantId, 'c@leads.example');
  insertLead(tenantId, 'd@leads.example');

  const r = await c.get('/api/goals');
  assert.equal(r.status, 200);
  const byKey = Object.fromEntries(r.json.goals.map((g) => [g.key, g]));
  assert.equal(byKey.email_collection.current, 4); // live count, not 1578
  assert.equal(byKey.email_collection.pct, 40);
  assert.equal(byKey.armor_bearer.current, 3); // stored value untouched

  // The overview's goals block agrees with its own collected card.
  const ov = await c.get('/api/overview');
  assert.equal(ov.status, 200);
  assert.equal(ov.json.counts.collected, 4);
  const ovGoals = Object.fromEntries(ov.json.goals.map((g) => [g.key, g]));
  assert.equal(ovGoals.email_collection.current, 4);

  // Read-time only: the stored row still holds the frozen value.
  const stored = db.prepare(
    "SELECT current_value FROM goals WHERE tenant_id = ? AND goal_key = 'email_collection'"
  ).get(tenantId);
  assert.equal(stored.current_value, 1578);
});

test('goals-cleanup rejects a wrong migration token', async () => {
  const r = await client(base).post('/api/auth/goals-cleanup/wrong-token', { tenant_id: 1 });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'forbidden');
});

test('goals-cleanup validates the tenant', async () => {
  const tok = process.env.MIGRATION_TOKEN;
  const c = client(base);

  const noTenant = await c.post(`/api/auth/goals-cleanup/${tok}`, {});
  assert.equal(noTenant.status, 400);
  assert.equal(noTenant.json.error, 'tenant_required');

  const badId = await c.post(`/api/auth/goals-cleanup/${tok}`, { tenant_id: -2 });
  assert.equal(badId.status, 400);
  assert.equal(badId.json.error, 'invalid_tenant_id');

  const unknown = await c.post(`/api/auth/goals-cleanup/${tok}`, { tenant_id: 999999 });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error, 'tenant_not_found');
});

test('goals-cleanup removes only the target tenant sustained row, and is idempotent', async () => {
  const tok = process.env.MIGRATION_TOKEN;
  const a = await register('a@cleanup.example', 'Cleanup A Co');
  const b = await register('b@cleanup.example', 'Cleanup B Co');
  for (const t of [a.tenantId, b.tenantId]) {
    insertGoal(t, 'sustained', 'Sustained users', 0, 100, 'users');
    insertGoal(t, 'email_collection', 'Email collection', 42, 11500, 'emails');
    insertGoal(t, 'faithshield', 'FaithShield paying users', 0, 100, 'users');
  }

  const r = await client(base).post(`/api/auth/goals-cleanup/${tok}`, { tenant_id: a.tenantId });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.tenant_id, a.tenantId);
  assert.equal(r.json.removed, 1);

  // Tenant A: sustained gone, every other goal intact.
  const aKeys = db.prepare('SELECT goal_key FROM goals WHERE tenant_id = ? ORDER BY goal_key')
    .all(a.tenantId).map((x) => x.goal_key);
  assert.deepEqual(aKeys, ['email_collection', 'faithshield']);

  // Tenant B: untouched, sustained row still present.
  const bKeys = db.prepare('SELECT goal_key FROM goals WHERE tenant_id = ? ORDER BY goal_key')
    .all(b.tenantId).map((x) => x.goal_key);
  assert.deepEqual(bKeys, ['email_collection', 'faithshield', 'sustained']);

  // Second run: nothing left to remove.
  const r2 = await client(base).post(`/api/auth/goals-cleanup/${tok}`, { tenant_id: a.tenantId });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.removed, 0);
});
