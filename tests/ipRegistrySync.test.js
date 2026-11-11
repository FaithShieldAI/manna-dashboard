'use strict';
/**
 * IP registry sync endpoint: POST /api/auth/ip-registry-sync/:token is
 * guarded by the same MIGRATION_TOKEN pattern as the snapshot sync,
 * validates each asset against the ip_assets vocabularies, replaces the
 * tenant's ip_assets with the posted set (the registry file stays the
 * single source of truth), and the stored rows come back through
 * GET /api/ip-registry.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
process.env.MIGRATION_TOKEN = 'test-migration-token-for-sync';

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

const HASH = 'a'.repeat(64);
const ASSETS = [
  { title: 'FaithShield AI', description: 'App brand. Owner: FaithShield.', asset_type: 'trademark', status: 'created-unregistered', content_hash: HASH, created_at: '2026-10-01' },
  { title: 'Sermon Coach method', description: 'Internal method.', asset_type: 'trade_secret', status: 'created-unregistered', content_hash: null, created_at: '2026-10-12' },
  { title: 'faith.tech', description: 'House domain.', asset_type: 'domain', status: 'registered', content_hash: null, created_at: '2026-11-05' },
];

async function registerOwner() {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'IP Sync Co',
    email: 'sync@ip.example',
    password: 'ip-sync-secret-12',
    plan: 'starter',
  });
  if (r.status === 409) {
    const login = await c.post('/api/auth/login', {
      email: 'sync@ip.example', password: 'ip-sync-secret-12',
    });
    assert.equal(login.status, 200);
    return c;
  }
  assert.equal(r.status, 201);
  return c;
}

test('ip registry sync rejects a wrong migration token', async () => {
  const c = client(base);
  const r = await c.post('/api/auth/ip-registry-sync/wrong-token', {
    tenant_email: 'sync@ip.example', assets: ASSETS,
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'forbidden');
});

test('ip registry sync validates tenant and assets', async () => {
  await registerOwner();
  const c = client(base);
  const missing = await c.post(`/api/auth/ip-registry-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'sync@ip.example',
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, 'assets_required');

  const unknown = await c.post(`/api/auth/ip-registry-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'nobody@nowhere.example', assets: ASSETS,
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error, 'tenant_not_found');

  const badType = await c.post(`/api/auth/ip-registry-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'sync@ip.example',
    assets: [{ ...ASSETS[0], asset_type: 'trade-secret' }],
  });
  assert.equal(badType.status, 400);
  assert.equal(badType.json.error, 'invalid_asset:0.asset_type');

  const badHash = await c.post(`/api/auth/ip-registry-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'sync@ip.example',
    assets: [{ ...ASSETS[0], content_hash: 'not-a-hash' }],
  });
  assert.equal(badHash.status, 400);
  assert.equal(badHash.json.error, 'invalid_asset:0.content_hash');
});

test('ip registry sync replaces the tenant assets and /api/ip-registry reads them back', async () => {
  const c = await registerOwner();
  const r = await c.post(`/api/auth/ip-registry-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'sync@ip.example', assets: ASSETS,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.count, 3);

  const list = await c.get('/api/ip-registry');
  assert.equal(list.status, 200);
  assert.equal(list.json.assets.length, 3);
  const tm = list.json.assets.find((a) => a.asset_type === 'trademark');
  assert.equal(tm.title, 'FaithShield AI');
  assert.equal(tm.content_hash, HASH);
  assert.equal(tm.created_at, '2026-10-01');

  const domains = await c.get('/api/ip-registry?type=domain');
  assert.equal(domains.json.assets.length, 1);
  assert.equal(domains.json.assets[0].status, 'registered');

  // A second sync replaces, never duplicates.
  const r2 = await c.post(`/api/auth/ip-registry-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'sync@ip.example', assets: [ASSETS[2]],
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.count, 1);
  const list2 = await c.get('/api/ip-registry');
  assert.equal(list2.json.assets.length, 1);
  assert.equal(list2.json.assets[0].title, 'faith.tech');
});
