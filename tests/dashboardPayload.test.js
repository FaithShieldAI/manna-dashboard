'use strict';
/**
 * Dashboard payload (migration 036): the analytics VM's mail-truth
 * chain pushes the private dashboard's panel HTML here
 * (POST /api/auth/dashboard-payload-sync/:token, migration token);
 * the static dashboard page reads it back through the read-token
 * endpoint and swaps panels at view time.
 *
 * Covers: the token gates, payload validation, the >256kb regression
 * (the global JSON parser must not reject these bodies before the
 * route's own 8mb parser sees them — the 2026-11-07 live failure),
 * the stored read with its CORS header, and tenant resolution.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
process.env.MIGRATION_TOKEN = 'test-migration-token-dash';
process.env.LIVE_WINDOWS_READ_TOKEN = 'test-read-token-dash';
process.env.LIVE_WINDOWS_TENANT_EMAIL = 'dash@payload.example';

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

async function registerOwner() {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Dashboard Payload Co',
    email: 'dash@payload.example',
    password: 'dash-payload-secret-1',
    plan: 'starter',
  });
  if (r.status === 409) {
    const login = await c.post('/api/auth/login', {
      email: 'dash@payload.example', password: 'dash-payload-secret-1',
    });
    assert.equal(login.status, 200);
    return c;
  }
  assert.equal(r.status, 201);
  return c;
}

const SMALL = { generated_at: '2026-11-08T10:00:00Z', sections: { 'panel-email': '<p>hi</p>' } };

test('dashboard payload sync rejects a wrong migration token', async () => {
  await registerOwner();
  const r = await client(base).post('/api/auth/dashboard-payload-sync/wrong-token', {
    tenant_email: 'dash@payload.example', payload: SMALL,
  });
  assert.equal(r.status, 403);
});

test('dashboard payload sync validates the payload shape', async () => {
  await registerOwner();
  const c = client(base);
  const tok = process.env.MIGRATION_TOKEN;
  const noPayload = await c.post(`/api/auth/dashboard-payload-sync/${tok}`, {
    tenant_email: 'dash@payload.example',
  });
  assert.equal(noPayload.status, 400);
  const empty = await c.post(`/api/auth/dashboard-payload-sync/${tok}`, {
    tenant_email: 'dash@payload.example', payload: { sections: {} },
  });
  assert.equal(empty.status, 400);
  const nonString = await c.post(`/api/auth/dashboard-payload-sync/${tok}`, {
    tenant_email: 'dash@payload.example', payload: { sections: { a: 42 } },
  });
  assert.equal(nonString.status, 400);
});

test('dashboard payload sync + read round trip, with CORS for the dashboard origin', async () => {
  await registerOwner();
  const c = client(base);
  const r = await c.post(`/api/auth/dashboard-payload-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'dash@payload.example', payload: SMALL,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.sections, 1);

  const noToken = await fetch(base + '/api/auth/dashboard-payload');
  assert.equal(noToken.status, 404);
  const wrong = await fetch(base + '/api/auth/dashboard-payload?k=nope');
  assert.equal(wrong.status, 404);
  const okRes = await fetch(base + '/api/auth/dashboard-payload?k=test-read-token-dash');
  assert.equal(okRes.status, 200);
  const j = await okRes.json();
  assert.equal(j.ok, true);
  assert.equal(j.as_of, '2026-11-08T10:00:00Z');
  assert.equal(j.sections['panel-email'], '<p>hi</p>');
  assert.equal(okRes.headers.get('access-control-allow-origin'), 'https://dashboard.d2rmmedia.com');
});

test('regression: a payload body over the global 256kb parser limit still syncs', async () => {
  await registerOwner();
  const big = {
    generated_at: '2026-11-08T10:05:00Z',
    sections: { 'panel-email': '<p>' + 'x'.repeat(400 * 1024) + '</p>' },
  };
  const r = await client(base).post(`/api/auth/dashboard-payload-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'dash@payload.example', payload: big,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});
