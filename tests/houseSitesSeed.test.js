'use strict';
/**
 * House sites seed door (2026-11-21): POST
 * /api/auth/house-sites-seed/:token idempotently ensures the house
 * tenant (resolved from the house owner account) has one site row per
 * house property, so the Sites panel lists FaithShield, MannaAi,
 * Armor Bearer, K-Punk and Two Fishes. Sustained is deliberately NOT
 * seeded: it is no longer a house product. Token-gated like every
 * staff door.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
process.env.MIGRATION_TOKEN = 'test-migration-token';

let server, base, c;
before(async () => {
  ({ server, base } = await startServer());
  c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'House Co', email: 'michael@faithshield.ai', password: 'house-secret-1',
  });
  assert.equal(r.status, 201);
});
after(async () => { server.close(); });

test('door creates the five house sites for the house tenant', async () => {
  const r = await c.post(`/api/auth/house-sites-seed/${process.env.MIGRATION_TOKEN}`, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const byKey = {};
  for (const row of r.json.results) byKey[row.site] = row.status;
  assert.deepEqual(byKey, {
    faithshield: 'created',
    manna: 'created',
    armorbearer: 'created',
    kpunk: 'created',
    twofishes: 'created',
  });
  const keys = r.json.sites.map(s => s.site_key);
  assert.deepEqual(keys, ['faithshield', 'manna', 'armorbearer', 'kpunk', 'twofishes']);
  assert.equal(keys.includes('sustained'), false);
});

test('door is idempotent: a second run creates nothing', async () => {
  const r = await c.post(`/api/auth/house-sites-seed/${process.env.MIGRATION_TOKEN}`, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.results.every(x => x.status === 'exists'), true);
  assert.equal(r.json.sites.length, 5);
});

test('door rejects a wrong token', async () => {
  const r = await c.post('/api/auth/house-sites-seed/wrong-token', {});
  assert.equal(r.status, 403);
});
