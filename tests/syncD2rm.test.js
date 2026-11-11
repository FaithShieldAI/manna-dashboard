'use strict';
/**
 * syncD2rm (the one-shot D2RM import behind POST /api/admin/sync-d2rm)
 * must never write email_snapshots again: the live mail-truth chain owns
 * those windows. Before 2026-11-10 the import upserted a frozen
 * 2026-10-14 capture (1042/223/19 in every window) over the chain's
 * fresh numbers. This test seeds live snapshot rows, runs the import,
 * and proves the rows come through untouched while contacts, campaigns
 * and goals still sync. It also pins the exported mapping helpers the
 * contacts mirror endpoint reuses.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

let server, base, db, tenantId, sourceDbPath;
before(async () => {
  ({ server, base } = await startServer());
  db = require('../src/db').db;

  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Sync D2RM Co',
    email: 'owner@syncd2rm.example',
    password: 'syncd2rm-secret-1',
    plan: 'starter',
  });
  assert.equal(r.status, 201);
  tenantId = db.prepare('SELECT tenant_id FROM users WHERE email = ?')
    .get('owner@syncd2rm.example').tenant_id;

  // A minimal collectors' source DB (the syncContacts/syncGoals shape).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2rm-source-'));
  sourceDbPath = path.join(dir, 'source.db');
  const sdb = new DatabaseSync(sourceDbPath);
  sdb.exec(`CREATE TABLE contacts (
    email TEXT, first_name TEXT, category TEXT, subcategory TEXT,
    source_file TEXT, notes TEXT)`);
  const ins = sdb.prepare('INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?)');
  ins.run('one@pastor.example', 'Pastor One', 'pastor', '', 'pastors.csv', '');
  ins.run('two@church.example', 'Church Two', 'org', '', 'orgs.csv', 'vetted already');
  sdb.close();
});
after(async () => { server.close(); });

test('syncD2rm leaves pre-existing email_snapshots untouched', async () => {
  // Live-chain windows, as the snapshot sync would have posted them.
  const insSnap = db.prepare(`
    INSERT INTO email_snapshots
      (tenant_id, window_key, sent, opens, clicks, unsubs, bounces, replies, warm_total, warm_by_lang_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const key of ['24h', '7d', '30d', 'all']) {
    insSnap.run(tenantId, key, 777, 55, 9, 1, 2, 3, 4, '{"english":4}');
  }

  const { syncD2rmData } = require('../src/lib/syncD2rm');
  const result = syncD2rmData({ sourceDbPath, tenantId });

  // No snapshot write is reported anymore...
  assert.equal(result.snapshots, undefined);
  // ...and every stored window still holds the chain's numbers.
  const rows = db.prepare(
    'SELECT window_key, sent, opens, clicks FROM email_snapshots WHERE tenant_id = ? ORDER BY window_key'
  ).all(tenantId);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.sent, 777, `${row.window_key} sent must stay the chain value`);
    assert.equal(row.opens, 55);
    assert.equal(row.clicks, 9);
  }

  // The rest of the import still works: contacts landed (org -> church),
  // campaigns and goals were upserted.
  assert.equal(result.contacts.inserted, 2);
  const contacts = db.prepare(
    'SELECT email, category FROM influencers WHERE tenant_id = ? ORDER BY email'
  ).all(tenantId).map((r) => ({ email: r.email, category: r.category }));
  assert.deepEqual(contacts, [
    { email: 'one@pastor.example', category: 'pastor' },
    { email: 'two@church.example', category: 'church' },
  ]);
  const campaignCount = db.prepare(
    'SELECT COUNT(*) AS n FROM email_campaigns WHERE tenant_id = ?'
  ).get(tenantId).n;
  assert.ok(campaignCount > 0);
  const goal = db.prepare(
    "SELECT current_value FROM goals WHERE tenant_id = ? AND goal_key = 'email_collection'"
  ).get(tenantId);
  assert.equal(goal.current_value, 2); // live contact count from the source DB

  // A second run changes nothing about the snapshots either.
  const again = syncD2rmData({ sourceDbPath, tenantId });
  assert.equal(again.snapshots, undefined);
  const afterRows = db.prepare(
    'SELECT COUNT(*) AS n, SUM(sent) AS s FROM email_snapshots WHERE tenant_id = ?'
  ).get(tenantId);
  assert.equal(afterRows.n, 4);
  assert.equal(afterRows.s, 4 * 777);
});

test('syncD2rm exports the shared contact mapping helpers', () => {
  const { mapCategory, mapTier, mapStatus, CATEGORY_MAP } = require('../src/lib/syncD2rm');
  assert.equal(CATEGORY_MAP.org, 'church');
  assert.equal(mapCategory('org'), 'church');
  assert.equal(mapCategory('pastor'), 'pastor');
  assert.equal(mapCategory('handles'), 'influencer'); // unmapped -> default bucket
  assert.equal(mapCategory(undefined), 'influencer');
  assert.equal(mapTier(' Nano '), 'nano');
  assert.equal(mapTier('huge'), null);
  assert.equal(mapTier(null), null);
  assert.equal(mapStatus('vetted 2026-10-01'), 'vetted');
  assert.equal(mapStatus(''), 'unvetted');
  assert.equal(mapStatus(null), 'unvetted');
});
