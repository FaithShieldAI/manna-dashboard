'use strict';
/**
 * Armor Bearer affiliates feed: POST /api/auth/ab-affiliates-sync is
 * guarded by the same MIGRATION_TOKEN pattern as the other sync
 * doors, validates the door account list, classifies it under the
 * owner's counting rule (2026-11-22: test accounts and second
 * accounts are not counted; src/lib/abAffiliates.js), and stores the
 * counts the armor_bearer goal then serves while the sync is fresh.
 *
 * The classification fixture is the verified live census of
 * 2026-11-22, read from the Armor Bearer dashboard-read door: 20
 * accounts = 6 approved real people and 14 pending that are not
 * prospects (10 October security and red-team test accounts, 3
 * second accounts, 1 house support account). Under the rule the
 * true count is 6 approved, 0 pending.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
process.env.MIGRATION_TOKEN = 'test-migration-token-for-ab-sync';

let server, base, db;
before(async () => {
  ({ server, base } = await startServer());
  ({ db } = require('../src/db'));
});
after(async () => { server.close(); });

const { classifyAffiliates } = require('../src/lib/abAffiliates');
const { seedDemoData } = require('../scripts/seed-demo-data');
const TOK = process.env.MIGRATION_TOKEN;
const PW = 'ab-affiliates' + '-secret-12';

// The 2026-11-22 door census, verbatim names and emails.
const CENSUS = [
  { name: 'Michael Faber', email: 'michael@faithshield.ai', status: 'approved' },
  { name: 'Leon Sievers', email: 'leon@faithshield.ai', status: 'approved' },
  { name: 'Peter Fields', email: 'peterfield6@hotmail.com', status: 'approved' },
  { name: 'Isaac Pemberton', email: 'isaacpemberton795@gmail.com', status: 'approved' },
  { name: 'Sid Allen', email: 'sid.allen@yahoo.com', status: 'approved' },
  { name: 'Nicola Stiffler', email: 'nicola@afpaconnect.com', status: 'approved' },
  { name: 'Michael', email: 'mikemixer2002@gmail.com', status: 'pending' },
  { name: '<script>alert(1)</script>', email: 'xss-test@example.com', status: 'pending' },
  { name: 'A'.repeat(500), email: 'longtest@example.com', status: 'pending' },
  { name: 'Weak Test', email: 'weaktest@example.com', status: 'pending' },
  { name: 'Rapid One', email: 'rapid1@example.com', status: 'pending' },
  { name: 'Rapid Two', email: 'rapid2@example.com', status: 'pending' },
  { name: '\u200b', email: 'redteam-armorbearer-1@example.com', status: 'pending' },
  { name: 'BadEmail', email: 'a@b', status: 'pending' },
  { name: 'A'.repeat(100), email: 'redteam-armorbearer-2@example.com', status: 'pending' },
  { name: 'Jesús ñ 日本語', email: 'redteam-armorbearer-3@example.com', status: 'pending' },
  { name: 'Nyxx', email: 'support@faithshield.ai', status: 'pending' },
  { name: 'Red Team Oct24', email: 'redteam-oct24@example.com', status: 'pending' },
  { name: 'Leon Sievers', email: 'itsme@leonsievers.com', status: 'pending' },
  { name: 'Sid Allen', email: 'basedinfaith@mail.com', status: 'pending' },
];
const REAL_APPROVED = [
  'michael@faithshield.ai', 'leon@faithshield.ai', 'peterfield6@hotmail.com',
  'isaacpemberton795@gmail.com', 'sid.allen@yahoo.com', 'nicola@afpaconnect.com',
];

test('classification: the 2026-11-22 census counts 6 approved, 0 pending, 14 excluded', () => {
  const r = classifyAffiliates(CENSUS);
  assert.equal(r.raw_total, 20);
  assert.equal(r.approved, 6);
  assert.equal(r.pending, 0);
  assert.equal(r.rejected, 0);
  assert.equal(r.excluded, 14);
  assert.equal(r.approved + r.pending + r.rejected + r.excluded, r.raw_total);
  const counted = r.audit.filter(a => a.counted).map(a => a.email).sort();
  assert.deepEqual(counted, [...REAL_APPROVED].sort());
  for (const a of r.audit.filter(a => !a.counted)) {
    assert.ok(a.reason, `excluded ${a.email} must carry a reason`);
  }
});

test('classification: real newcomers count, test-style newcomers do not', () => {
  const withProspect = classifyAffiliates([
    ...CENSUS,
    { name: 'Grace Miller', email: 'grace@firstchurch.org', status: 'pending' },
    { name: 'Tom Reed', email: 'tom@reedmedia.com', status: 'approved' },
  ]);
  assert.equal(withProspect.pending, 1);
  assert.equal(withProspect.approved, 7);
  assert.equal(withProspect.excluded, 14);

  const withJunk = classifyAffiliates([
    ...CENSUS,
    { name: 'QA Test', email: 'qa-test@newchurch.org', status: 'pending' },
    { name: 'Probe', email: 'probe@example.net', status: 'pending' },
  ]);
  assert.equal(withJunk.pending, 0);
  assert.equal(withJunk.excluded, 16);
});

test('classification: whole-word matching spares real addresses containing test letters', () => {
  const r = classifyAffiliates([
    { name: 'Latest News', email: 'latest@church.org', status: 'approved' },
    { name: 'Contest Team', email: 'contest@church.org', status: 'pending' },
    { name: 'Newtest Media', email: 'newtest@church.org', status: 'pending' },
  ]);
  assert.equal(r.approved, 1);
  assert.equal(r.pending, 2);
  assert.equal(r.excluded, 0);
});

async function registerSeeded(email, companyName) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName, email, password: PW, plan: 'starter',
  });
  assert.equal(r.status, 201, `register ${email}: ${JSON.stringify(r.json)}`);
  const tenantId = Number(r.json.tenant.id);
  const slug = db.prepare('SELECT slug FROM tenants WHERE id = ?').get(tenantId).slug;
  seedDemoData(slug);
  return { c, tenantId };
}

const byKey = (j) => Object.fromEntries(j.goals.map(g => [g.key, g]));

test('sync endpoint rejects a wrong migration token and stores nothing', async () => {
  const c = client(base);
  const r = await c.post('/api/auth/ab-affiliates-sync/wrong-token', {
    affiliates: CENSUS, generated_at: '2026-11-23T00:00:00Z',
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'forbidden');
  const row = db.prepare('SELECT COUNT(*) AS n FROM ab_affiliate_counts').get();
  assert.equal(row.n, 0);
});

test('sync endpoint validates the account list', async () => {
  const c = client(base);
  const missing = await c.post(`/api/auth/ab-affiliates-sync/${TOK}`, {});
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, 'affiliates_required');

  const badStatus = await c.post(`/api/auth/ab-affiliates-sync/${TOK}`, {
    affiliates: [{ name: 'X', email: 'x@church.org', status: 'maybe' }],
  });
  assert.equal(badStatus.status, 400);
  assert.equal(badStatus.json.error, 'invalid_affiliate:0.status');

  const badEmail = await c.post(`/api/auth/ab-affiliates-sync/${TOK}`, {
    affiliates: [{ name: 'X', email: 'not-an-email', status: 'pending' }],
  });
  assert.equal(badEmail.status, 400);
  assert.equal(badEmail.json.error, 'invalid_affiliate:0.email');
});

test('goal has no feed before any sync, then serves the classified count while fresh', async () => {
  const A = await registerSeeded('owner@abfeed.example', 'AB Feed Co');

  for (const path of ['/api/goals', '/api/overview']) {
    const beforeSync = byKey((await A.c.get(path)).json);
    assert.equal(beforeSync.armor_bearer.live_feed, false, `${path} before sync`);
    assert.equal(beforeSync.armor_bearer.current, null, `${path} before sync`);
    assert.equal(beforeSync.armor_bearer.goal, 100, `${path} keeps the target`);
  }

  const c = client(base);
  const r = await c.post(`/api/auth/ab-affiliates-sync/${TOK}`, {
    affiliates: CENSUS, generated_at: '2026-11-23T17:40:57Z',
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.approved, 6);
  assert.equal(r.json.pending, 0);
  assert.equal(r.json.excluded, 14);
  assert.equal(r.json.raw_total, 20);
  assert.ok(r.json.received_at);

  const stored = db.prepare('SELECT * FROM ab_affiliate_counts WHERE id = 1').get();
  assert.equal(stored.approved, 6);
  assert.equal(JSON.parse(stored.audit_json).length, 20);

  for (const path of ['/api/goals', '/api/overview']) {
    const afterSync = byKey((await A.c.get(path)).json);
    assert.equal(afterSync.armor_bearer.live_feed, true, `${path} after sync`);
    assert.equal(afterSync.armor_bearer.current, 6, `${path} after sync`);
    assert.equal(afterSync.armor_bearer.goal, 100, `${path} target`);
    assert.equal(afterSync.armor_bearer.pct, 6, `${path} pct`);
  }
});

test('goal falls back to no-feed when the stored sync goes stale', async () => {
  const A = await registerSeeded('stale@abfeed.example', 'AB Stale Co');
  const fresh = byKey((await A.c.get('/api/goals')).json);
  assert.equal(fresh.armor_bearer.current, 6);

  const old = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  db.prepare('UPDATE ab_affiliate_counts SET received_at = ? WHERE id = 1').run(old);

  const stale = byKey((await A.c.get('/api/goals')).json);
  assert.equal(stale.armor_bearer.live_feed, false);
  assert.equal(stale.armor_bearer.current, null);
  assert.equal(stale.armor_bearer.goal, 100);
});
