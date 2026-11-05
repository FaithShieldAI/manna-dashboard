'use strict';
/**
 * Live windows: POST /api/auth/live-windows-sync/:token (migration
 * token) stores the VM-computed payload per tenant; while it is fresh
 * (<=180s) GET /api/email/windows serves it labeled source:'live' with
 * its as_of, and the public read-token endpoint serves it to the
 * private dashboard. When the payload goes stale, /api/email/windows
 * falls back to the snapshots, labeled source:'snapshot'.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
process.env.MIGRATION_TOKEN = 'test-migration-token-live';
process.env.LIVE_WINDOWS_READ_TOKEN = 'test-read-token';
process.env.LIVE_WINDOWS_TENANT_EMAIL = 'live@windows.example';

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

const PAYLOAD = {
  as_of: '2026-11-05T15:00:00Z',
  windows: {
    '24h': { sent: 5, opens: 2, clicks: 1, unsub: 0, bounces: 0, replies: 1, open_rate: 40, click_rate: 20, optout_rate: 0, warm: { total: 1, by_lang: { english: 1 } }, label: '24 hours' },
    '7d': { sent: 50, opens: 20, clicks: 4, unsub: 1, bounces: 3, replies: 6, open_rate: 40, click_rate: 8, optout_rate: 2, warm: { total: 2, by_lang: { english: 2 } }, label: '7 days' },
    '30d': { sent: 200, opens: 80, clicks: 10, unsub: 2, bounces: 9, replies: 11, open_rate: 40, click_rate: 5, optout_rate: 1, warm: { total: 3, by_lang: {} }, label: '30 days' },
    'all': { sent: 900, opens: 300, clicks: 40, unsub: 9, bounces: 60, replies: 16, open_rate: 33.3, click_rate: 4.4, optout_rate: 1, warm: { total: 3, by_lang: {} }, label: 'all time' },
  },
  sources: { kit: { as_of: '2026-11-05T15:00:00Z', error: null, stale: false } },
};

async function registerOwner() {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Live Windows Co',
    email: 'live@windows.example',
    password: 'live-windows-secret-1',
    plan: 'starter',
  });
  if (r.status === 409) {
    const login = await c.post('/api/auth/login', {
      email: 'live@windows.example', password: 'live-windows-secret-1',
    });
    assert.equal(login.status, 200);
    return c;
  }
  assert.equal(r.status, 201);
  return c;
}

test('live windows sync rejects a wrong migration token', async () => {
  const c = client(base);
  const r = await c.post('/api/auth/live-windows-sync/wrong-token', {
    tenant_email: 'live@windows.example', payload: PAYLOAD,
  });
  assert.equal(r.status, 403);
});

test('live windows sync validates the payload shape', async () => {
  const c = client(base);
  await registerOwner();
  const missing = await c.post(`/api/auth/live-windows-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'live@windows.example', payload: { windows: { '24h': PAYLOAD.windows['24h'] } },
  });
  assert.equal(missing.status, 400);
  const badMetric = JSON.parse(JSON.stringify(PAYLOAD));
  badMetric.windows['7d'].sent = -1;
  const bad = await c.post(`/api/auth/live-windows-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'live@windows.example', payload: badMetric,
  });
  assert.equal(bad.status, 400);
});

test('fresh live payload is served by /api/email/windows, labeled live', async () => {
  const c = await registerOwner();
  const r = await c.post(`/api/auth/live-windows-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'live@windows.example', payload: PAYLOAD,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.as_of, PAYLOAD.as_of);

  const w = await c.get('/api/email/windows');
  assert.equal(w.status, 200);
  assert.equal(w.json.source, 'live');
  assert.equal(w.json.as_of, PAYLOAD.as_of);
  assert.equal(w.json.windows['7d'].sent, 50);
  assert.equal(w.json.windows['7d'].opens, 20);
  assert.equal(w.json.windows['7d'].opt_outs, 1);
  assert.equal(w.json.windows['7d'].replies, 6);
  assert.equal(w.json.live_windows.all.sent, 900);
});

test('public live-windows read serves the payload only with the read token', async () => {
  const noToken = await fetch(base + '/api/auth/live-windows');
  assert.equal(noToken.status, 404);
  const wrong = await fetch(base + '/api/auth/live-windows?k=nope');
  assert.equal(wrong.status, 404);
  const okRes = await fetch(base + '/api/auth/live-windows?k=test-read-token');
  assert.equal(okRes.status, 200);
  const j = await okRes.json();
  assert.equal(j.ok, true);
  assert.equal(j.as_of, PAYLOAD.as_of);
  assert.equal(j.windows['30d'].sent, 200);
  assert.equal(j.fresh, true);
  assert.equal(okRes.headers.get('access-control-allow-origin'), 'https://dashboard.d2rmmedia.com');
});

test('stale live payload falls back to snapshots, labeled snapshot', async () => {
  const { db } = require('../src/db');
  db.prepare("UPDATE live_windows SET received_at = ?")
    .run(new Date(Date.now() - 10 * 60 * 1000).toISOString());
  const c = await registerOwner();
  const w = await c.get('/api/email/windows');
  assert.equal(w.status, 200);
  assert.equal(w.json.source, 'snapshot');
});
