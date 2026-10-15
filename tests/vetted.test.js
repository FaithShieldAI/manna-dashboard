'use strict';
/**
 * Vetted tab API tests:
 *  - GET /api/vetted/stats returns vetted/unvetted counts per category
 *  - GET /api/vetted/pending lists unvetted leads (tenant-scoped), category filter works
 *  - POST /api/vetted/:id/approve moves lead to vetted
 *  - POST /api/vetted/:id/reject moves lead to rejected
 *  - tenant isolation: one tenant's leads are invisible to another
 *  - invalid category/id rejected; auth required
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
    companyName: 'Vetted Co ' + email, email, password: 'vetted-secret-pw-12',
  });
  assert.equal(r.status, 201);
  return c;
}

// Seed one tenant's influencers directly via the db facade (tenant-scoped handle).
// Clears the tenant's influencers first: since 2026-10-14, /api/auth/register
// seeds demo contacts at signup, so the fixture must start from a known state.
function seedInfluencers(tenantId, rows) {
  const { db, forTenant } = require('../src/db');
  db.prepare('DELETE FROM influencers WHERE tenant_id = ?').run(tenantId);
  const tdb = forTenant(tenantId);
  for (const r of rows) tdb.createInfluencer(r);
}

// Grab the tenant id of the currently-logged-in client via its own profile endpoint.
async function myTenantId(c) {
  const r = await c.get('/api/auth/me');
  assert.equal(r.status, 200);
  return r.json.tenant.id;
}

test('stats + pending + approve + reject end to end', async () => {
  const c = await register('vetter1@example.org');
  const tid = await myTenantId(c);

  seedInfluencers(tid, [
    { handle: 'lead-a', category: 'influencer', status: 'unvetted', email: 'a@example.org' },
    { handle: 'lead-b', category: 'podcast', status: 'unvetted', email: 'b@example.org' },
    { handle: 'lead-c', category: 'pastor', status: 'vetted', email: 'c@example.org' },
  ]);

  const s = await c.get('/api/vetted/stats');
  assert.equal(s.status, 200);
  assert.ok(s.json.ok);
  assert.equal(s.json.unvetted.influencer, 1);
  assert.equal(s.json.unvetted.podcast, 1);
  assert.equal(s.json.vetted.pastor, 1);
  assert.equal(s.json.totals.unvetted, 2);
  assert.equal(s.json.totals.vetted, 1);

  const p = await c.get('/api/vetted/pending');
  assert.equal(p.status, 200);
  assert.equal(p.json.leads.length, 2);
  assert.ok(p.json.leads.every(l => l.status === 'unvetted'));

  const pf = await c.get('/api/vetted/pending?category=influencer');
  assert.equal(pf.status, 200);
  assert.equal(pf.json.leads.length, 1);
  assert.equal(pf.json.leads[0].handle, 'lead-a');

  const bad = await c.get('/api/vetted/pending?category=bogus');
  assert.equal(bad.status, 400);

  // approve lead-a
  const ap = await c.post('/api/vetted/' + pf.json.leads[0].id + '/approve', {});
  assert.equal(ap.status, 200);
  assert.equal(ap.json.status, 'vetted');

  const s2 = await c.get('/api/vetted/stats');
  assert.equal(s2.json.totals.vetted, 2);
  assert.equal(s2.json.totals.unvetted, 1);

  // reject lead-b
  const bId = p.json.leads.find(l => l.handle === 'lead-b').id;
  const rj = await c.post('/api/vetted/' + bId + '/reject', {});
  assert.equal(rj.status, 200);
  assert.equal(rj.json.status, 'rejected');

  const p2 = await c.get('/api/vetted/pending');
  assert.equal(p2.json.leads.length, 0);

  // nonexistent id
  const miss = await c.post('/api/vetted/999999/approve', {});
  assert.equal(miss.status, 404);
});

test('tenant isolation', async () => {
  const c1 = await register('vetter2a@example.org');
  const c2 = await register('vetter2b@example.org');
  const t1 = await myTenantId(c1);
  const t2 = await myTenantId(c2);
  assert.notEqual(t1, t2);

  seedInfluencers(t1, [{ handle: 'secret-lead', category: 'church', status: 'unvetted', email: 'secret@example.org' }]);

  const p2 = await c2.get('/api/vetted/pending');
  assert.equal(p2.status, 200);
  assert.ok(!p2.json.leads.some(l => l.handle === 'secret-lead'));

  // c2 cannot approve c1's lead
  const { forTenant } = require('../src/db');
  const leadId = forTenant(t1).pendingVetted()[0].id;
  const hack = await c2.post('/api/vetted/' + leadId + '/approve', {});
  assert.equal(hack.status, 404);

  // c1 can
  const ok2 = await c1.post('/api/vetted/' + leadId + '/approve', {});
  assert.equal(ok2.status, 200);
});

test('auth required', async () => {
  const anon = client(base);
  assert.equal((await anon.get('/api/vetted/stats')).status, 401);
  assert.equal((await anon.get('/api/vetted/pending')).status, 401);
  assert.equal((await anon.post('/api/vetted/1/approve', {})).status, 401);
});
