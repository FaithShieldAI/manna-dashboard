'use strict';
/**
 * Warm leads sync endpoint: POST /api/auth/warm-leads-sync/:token is
 * guarded by the same MIGRATION_TOKEN pattern as the other sync
 * routes, validates the per-recipient warm list (warm = opened or
 * clicked) segmented by line, replaces the tenant's stored list, and
 * the stored people come back through GET /api/email/warm-leads and
 * the Overview warm count — the same numbers the private dashboard's
 * Warm Leads panel shows.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
process.env.MIGRATION_TOKEN = 'test-migration-token-for-sync';

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

const PAYLOAD = {
  computed_at: '2026-11-15T18:00:00Z',
  unwired_note: 'No per-recipient opens or clicks are recorded yet for other lines.',
  segments: [
    {
      key: 'pr', label: 'PR', note: 'Nov 3, 2026 PR mailing', tracked: 3,
      leads: [
        { name: 'Outlet A', email: 'a@paper.example', opens: 5, clicks: 2, last_activity: '2026-11-13T18:39:35Z' },
        { name: 'Outlet B', email: 'b@paper.example', opens: 3, clicks: 0, last_activity: '2026-11-10T12:00:00Z' },
      ],
    },
    {
      key: 'armor_bearer', label: 'Armor Bearer', note: 'Kit records, frozen Nov 3, 2026', tracked: 1,
      leads: [
        { name: 'Creator C', email: 'c@creator.example', opens: null, clicks: 1, last_activity: '2026-10-11T09:00:00Z' },
      ],
    },
  ],
};

async function registerOwner(email) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Warm Sync Co',
    email,
    password: 'warm-secret-12345',
    plan: 'starter',
  });
  if (r.status === 409) {
    const login = await c.post('/api/auth/login', { email, password: 'warm-secret-12345' });
    assert.equal(login.status, 200);
    return c;
  }
  assert.equal(r.status, 201);
  return c;
}

test('warm leads sync rejects a wrong migration token', async () => {
  const c = client(base);
  const r = await c.post('/api/auth/warm-leads-sync/wrong-token', {
    tenant_email: 'warm@sync.example', segments: PAYLOAD.segments,
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'forbidden');
});

test('warm leads sync validates segments and warm-only leads', async () => {
  await registerOwner('warm@sync.example');
  const badKey = await client(base).post(`/api/auth/warm-leads-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'warm@sync.example',
    segments: [{ key: 'Bad Key!', label: 'X', tracked: 1, leads: [] }],
  });
  assert.equal(badKey.status, 400);
  assert.equal(badKey.json.error, 'invalid_segment:0.key');

  const notWarm = await client(base).post(`/api/auth/warm-leads-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'warm@sync.example',
    segments: [{
      key: 'pr', label: 'PR', tracked: 1,
      leads: [{ name: 'Cold', email: 'cold@paper.example', opens: 0, clicks: 0, last_activity: null }],
    }],
  });
  assert.equal(notWarm.status, 400);
  assert.equal(notWarm.json.error, 'invalid_segment:0.lead:0.not_warm');
});

test('warm leads sync stores the list and the reads show the same counts', async () => {
  const c = await registerOwner('warm@sync.example');
  const r = await c.post(`/api/auth/warm-leads-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'warm@sync.example', ...PAYLOAD,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.totals.warm, 3);
  assert.equal(r.json.totals.clickers, 2);
  assert.equal(r.json.totals.tracked, 4);
  assert.equal(r.json.segments.pr, 2);
  assert.equal(r.json.segments.armor_bearer, 1);

  const w = await c.get('/api/email/warm-leads');
  assert.equal(w.status, 200);
  assert.equal(w.json.totals.warm, 3);
  assert.equal(w.json.totals.clickers, 2);
  assert.equal(w.json.totals.tracked, 4);
  assert.equal(w.json.computed_at, '2026-11-15T18:00:00Z');
  assert.equal(w.json.segments.length, 2);
  const pr = w.json.segments.find(s => s.key === 'pr');
  assert.equal(pr.warm, 2);
  assert.equal(pr.tracked, 3);
  // Ranked clicks first: the 2-click lead leads the segment.
  assert.equal(pr.leads[0].email, 'a@paper.example');
  assert.equal(pr.leads[1].email, 'b@paper.example');
  const ab = w.json.segments.find(s => s.key === 'armor_bearer');
  assert.equal(ab.leads[0].opens, null);
  assert.equal(ab.leads[0].clicks, 1);

  const ov = await c.get('/api/overview');
  assert.equal(ov.status, 200);
  assert.equal(ov.json.email.warmTotal, 3);
});

test('warm leads sync replaces the stored list on the next sync', async () => {
  const c = await registerOwner('warm@sync.example');
  const r = await c.post(`/api/auth/warm-leads-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'warm@sync.example',
    segments: [{
      key: 'pr', label: 'PR', note: 'Nov 3, 2026 PR mailing', tracked: 3,
      leads: [{ name: 'Outlet A', email: 'a@paper.example', opens: 6, clicks: 3, last_activity: '2026-11-14T10:00:00Z' }],
    }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.totals.warm, 1);

  const w = await c.get('/api/email/warm-leads');
  assert.equal(w.json.segments.length, 1);
  assert.equal(w.json.totals.warm, 1);
  assert.equal(w.json.totals.tracked, 3);
});

test('warm leads are tenant-scoped: an unsynced tenant reads empty', async () => {
  const c = await registerOwner('other@sync.example');
  const w = await c.get('/api/email/warm-leads');
  assert.equal(w.status, 200);
  assert.deepEqual(w.json.segments, []);
  assert.equal(w.json.totals, null);

  const ov = await c.get('/api/overview');
  assert.equal(ov.json.email.warmTotal, 0);
});
