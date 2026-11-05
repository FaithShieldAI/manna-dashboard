'use strict';
/**
 * Email snapshot sync endpoint: POST /api/auth/email-snapshots-sync/:token
 * is guarded by the same MIGRATION_TOKEN pattern as the migration routes,
 * validates the standard outgoing-mail column set (sent, opens, clicks,
 * opt-outs, bounces, replies), upserts one tenant's four windows, and the
 * stored values come back through GET /api/email/windows.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
process.env.MIGRATION_TOKEN = 'test-migration-token-for-sync';

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

const WINDOWS = {
  '24h': { sent: 10, opens: 4, clicks: 1, unsubs: 0, bounces: 1, replies: 2 },
  '7d': { sent: 70, opens: 21, clicks: 3, unsubs: 1, bounces: 5, replies: 6 },
  '30d': { sent: 300, opens: 90, clicks: 12, unsubs: 3, bounces: 20, replies: 11 },
  'all': { sent: 900, opens: 270, clicks: 40, unsubs: 9, bounces: 60, replies: 16 },
};

async function registerOwner() {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Snapshot Sync Co',
    email: 'sync@snapshot.example',
    password: 'snapshot-secret-12',
    plan: 'starter',
  });
  if (r.status === 409) {
    const login = await c.post('/api/auth/login', {
      email: 'sync@snapshot.example', password: 'snapshot-secret-12',
    });
    assert.equal(login.status, 200);
    return c;
  }
  assert.equal(r.status, 201);
  return c;
}

test('snapshot sync rejects a wrong migration token', async () => {
  const c = client(base);
  const r = await c.post('/api/auth/email-snapshots-sync/wrong-token', {
    tenant_email: 'sync@snapshot.example', windows: WINDOWS,
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'forbidden');
});

test('snapshot sync validates the window set and metrics', async () => {
  const c = await registerOwner();
  const missing = await c.post(`/api/auth/email-snapshots-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'sync@snapshot.example',
    windows: { '24h': WINDOWS['24h'] },
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, 'window_missing:7d');

  const bad = await c.post(`/api/auth/email-snapshots-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'sync@snapshot.example',
    windows: { ...WINDOWS, '24h': { ...WINDOWS['24h'], bounces: -1 } },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_metric:24h.bounces');
});

test('snapshot sync upserts windows and /api/email/windows reads them back', async () => {
  const c = await registerOwner();
  const r = await c.post(`/api/auth/email-snapshots-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'sync@snapshot.example', windows: WINDOWS,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.windows['24h'].sent, 10);
  assert.equal(r.json.windows['24h'].bounces, 1);
  assert.equal(r.json.windows['24h'].replies, 2);
  assert.equal(r.json.windows.all.sent, 900);
  assert.ok(r.json.server_pr_event_windows);
  assert.ok('opens' in r.json.server_pr_event_windows.all);

  const w = await c.get('/api/email/windows');
  assert.equal(w.status, 200);
  assert.equal(w.json.windows['7d'].sent, 70);
  assert.equal(w.json.windows['7d'].opens, 21);
  assert.equal(w.json.windows['7d'].clicks, 3);
  assert.equal(w.json.windows['7d'].bounces, 5);
  assert.equal(w.json.windows['7d'].replies, 6);
  assert.equal(w.json.windows['7d'].opt_outs, 1);
  assert.notEqual(w.json.windows['24h'].sent, w.json.windows.all.sent);
});
