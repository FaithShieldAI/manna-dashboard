'use strict';
/**
 * Migration 022 regression tests ('individual' category for influencers):
 *  - the widened category CHECK accepts 'individual' (the bucket
 *    scripts/import-contacts.js maps source category 'other' to, landing
 *    the held-back unroled-individual contacts on deploy day)
 *  - the CHECK still rejects unknown categories
 *  - category counts surface the new bucket
 *  - podcast_outreach (017) still FK-references influencers after the
 *    table rebuild: rows link, and deleting the parent cascades
 * The fresh test DB is built by running every migration in order, so a
 * green run also proves 022 applies cleanly in the full chain.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

async function register(email) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Mig022 Co ' + email, email, password: 'mig022-secret-pw-12',
  });
  assert.equal(r.status, 201);
  return c;
}

async function myTenantId(c) {
  const r = await c.get('/api/auth/me');
  assert.equal(r.status, 200);
  return r.json.tenant.id;
}

test("category 'individual' is accepted and counted; bogus category still rejected", async () => {
  const c = await register('mig022-a@example.org');
  const tid = await myTenantId(c);
  const { db, forTenant } = require('../src/db');
  db.prepare('DELETE FROM influencers WHERE tenant_id = ?').run(tid);
  const tdb = forTenant(tid);

  const ins = tdb.createInfluencer({ handle: 'plain-person', category: 'individual', email: 'person@example.org' });
  assert.ok(ins && ins.lastInsertRowid, 'insert with category individual should succeed');

  const counts = tdb.influencerCategoryCounts();
  const ind = counts.find(r => r.category === 'individual');
  assert.ok(ind && ind.n >= 1, 'category counts should include the individual bucket');

  assert.throws(
    () => tdb.createInfluencer({ handle: 'nope', category: 'bogus' }),
    /CHECK|constraint/i,
    'unknown categories must still fail the CHECK'
  );
});

test('podcast_outreach FK survives the 022 rebuild (link + cascade)', async () => {
  const c = await register('mig022-b@example.org');
  const tid = await myTenantId(c);
  const { db, forTenant } = require('../src/db');
  const tdb = forTenant(tid);

  const podIns = tdb.createInfluencer({ handle: 'pod-host', category: 'podcast', email: 'host@example.org' });
  const podId = Number(podIns.lastInsertRowid);
  db.prepare(
    "INSERT INTO podcast_outreach (tenant_id, influencer_id, pitch_status) VALUES (?, ?, 'pitched')"
  ).run(tid, podId);
  const linked = db.prepare(
    'SELECT COUNT(*) AS n FROM podcast_outreach WHERE tenant_id = ? AND influencer_id = ?'
  ).get(tid, podId);
  assert.equal(linked.n, 1, 'outreach row should link to the influencer');

  db.prepare('DELETE FROM influencers WHERE id = ?').run(podId);
  const afterDelete = db.prepare(
    'SELECT COUNT(*) AS n FROM podcast_outreach WHERE tenant_id = ? AND influencer_id = ?'
  ).get(tid, podId);
  assert.equal(afterDelete.n, 0, 'deleting the influencer must cascade to podcast_outreach');

  const violations = db.prepare('PRAGMA foreign_key_check').all();
  assert.equal(violations.length, 0, 'foreign_key_check must be clean');
});
