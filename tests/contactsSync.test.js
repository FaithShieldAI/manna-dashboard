'use strict';
/**
 * Contacts mirror sync endpoint: POST /api/auth/contacts-sync/:token is
 * guarded by the same MIGRATION_TOKEN pattern as the IP registry sync,
 * validates each contact (email shape, source category vocabulary), and
 * UPSERTS the tenant's influencers by (tenant_id, LOWER(email)) using
 * the syncD2rm category/tier/status mapping. It never deletes: rows the
 * mirror does not know about survive, and GET /api/overview
 * counts.collected reflects the tenant total after each batch.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
process.env.MIGRATION_TOKEN = 'test-migration-token-for-sync';

let server, base, db;
before(async () => {
  ({ server, base } = await startServer());
  db = require('../src/db').db;
});
after(async () => { server.close(); });

const CONTACTS = [
  { email: 'pastor@grace.example', name: 'Grace Pastor', category: 'pastor', subcategory: '', notes: 'vetted 2026-10-01', source_file: 'pastors.csv' },
  { email: 'church@hope.example', name: '', category: 'org', subcategory: null, notes: '', source_file: 'orgs.csv' },
  { email: 'creator@social.example', name: 'Casey Creator', category: 'influencer', subcategory: 'Nano', notes: '', source_file: 'creators.csv' },
];

async function register(email, companyName) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName,
    email,
    password: 'contacts-sync-12',
    plan: 'starter',
  });
  if (r.status === 409) {
    const login = await c.post('/api/auth/login', {
      email, password: 'contacts-sync-12',
    });
    assert.equal(login.status, 200);
    return c;
  }
  assert.equal(r.status, 201);
  return c;
}

const registerOwner = () => register('sync@contacts.example', 'Contacts Sync Co');

test('contacts sync rejects a wrong migration token', async () => {
  const c = client(base);
  const r = await c.post('/api/auth/contacts-sync/wrong-token', {
    tenant_email: 'sync@contacts.example', contacts: CONTACTS,
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'forbidden');
});

test('contacts sync validates tenant and contacts', async () => {
  await registerOwner();
  const c = client(base);
  const tok = process.env.MIGRATION_TOKEN;

  const noTenant = await c.post(`/api/auth/contacts-sync/${tok}`, { contacts: CONTACTS });
  assert.equal(noTenant.status, 400);
  assert.equal(noTenant.json.error, 'tenant_required');

  const badTenantId = await c.post(`/api/auth/contacts-sync/${tok}`, {
    tenant_id: -3, contacts: CONTACTS,
  });
  assert.equal(badTenantId.status, 400);
  assert.equal(badTenantId.json.error, 'invalid_tenant_id');

  const unknownId = await c.post(`/api/auth/contacts-sync/${tok}`, {
    tenant_id: 999999, contacts: CONTACTS,
  });
  assert.equal(unknownId.status, 404);
  assert.equal(unknownId.json.error, 'tenant_not_found');

  const unknownEmail = await c.post(`/api/auth/contacts-sync/${tok}`, {
    tenant_email: 'nobody@nowhere.example', contacts: CONTACTS,
  });
  assert.equal(unknownEmail.status, 404);
  assert.equal(unknownEmail.json.error, 'tenant_not_found');

  const missing = await c.post(`/api/auth/contacts-sync/${tok}`, {
    tenant_email: 'sync@contacts.example',
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, 'contacts_required');

  const empty = await c.post(`/api/auth/contacts-sync/${tok}`, {
    tenant_email: 'sync@contacts.example', contacts: [],
  });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error, 'contacts_required');

  const tooMany = await c.post(`/api/auth/contacts-sync/${tok}`, {
    tenant_email: 'sync@contacts.example',
    contacts: Array.from({ length: 1001 }, (_, i) => ({ email: `u${i}@x.example`, category: 'other' })),
  });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.json.error, 'contacts_required');

  const badEmail = await c.post(`/api/auth/contacts-sync/${tok}`, {
    tenant_email: 'sync@contacts.example',
    contacts: [{ email: 'not-an-email', category: 'pastor' }],
  });
  assert.equal(badEmail.status, 400);
  assert.equal(badEmail.json.error, 'invalid_contact:0.email');

  const longEmail = await c.post(`/api/auth/contacts-sync/${tok}`, {
    tenant_email: 'sync@contacts.example',
    contacts: [{ email: `${'a'.repeat(315)}@x.example`, category: 'pastor' }],
  });
  assert.equal(longEmail.status, 400);
  assert.equal(longEmail.json.error, 'invalid_contact:0.email');

  const badSecond = await c.post(`/api/auth/contacts-sync/${tok}`, {
    tenant_email: 'sync@contacts.example',
    contacts: [CONTACTS[0], { email: 'fine@x.example', category: 'church' }],
  });
  assert.equal(badSecond.status, 400);
  assert.equal(badSecond.json.error, 'invalid_contact:1.category');
});

test('contacts sync inserts, re-post updates without duplicating, overview counts follow', async () => {
  const c = await registerOwner();
  const tok = process.env.MIGRATION_TOKEN;
  const tenantId = db.prepare('SELECT tenant_id FROM users WHERE email = ?')
    .get('sync@contacts.example').tenant_id;

  // A curated row with a different source and a non-matching email must
  // survive every mirror run untouched.
  db.prepare(`
    INSERT INTO influencers (tenant_id, handle, platform, email, tier, category, status, notes, source)
    VALUES (?, 'Hand Picked', NULL, 'picked@manual.example', NULL, 'influencer', 'vetted', 'keep me', 'manual')
  `).run(tenantId);

  const r = await c.post(`/api/auth/contacts-sync/${tok}`, {
    tenant_email: 'sync@contacts.example', contacts: CONTACTS,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.received, 3);
  assert.equal(r.json.inserted, 3);
  assert.equal(r.json.updated, 0);
  assert.equal(r.json.total_in_tenant, 4); // 3 mirrored + 1 curated

  // Mapping landed as the syncD2rm import would map it.
  const pastor = db.prepare('SELECT * FROM influencers WHERE tenant_id = ? AND email = ?')
    .get(tenantId, 'pastor@grace.example');
  assert.equal(pastor.category, 'pastor');
  assert.equal(pastor.status, 'vetted'); // notes start with 'vetted'
  assert.equal(pastor.handle, 'Grace Pastor');
  assert.equal(pastor.source, 'd2rm-email-mirror');

  const church = db.prepare('SELECT * FROM influencers WHERE tenant_id = ? AND email = ?')
    .get(tenantId, 'church@hope.example');
  assert.equal(church.category, 'church'); // org maps to church
  assert.equal(church.handle, 'church'); // no name -> email local part
  assert.equal(church.status, 'unvetted');

  const creator = db.prepare('SELECT * FROM influencers WHERE tenant_id = ? AND email = ?')
    .get(tenantId, 'creator@social.example');
  assert.equal(creator.category, 'influencer');
  assert.equal(creator.tier, 'nano'); // subcategory, case-insensitive

  const picked = db.prepare('SELECT * FROM influencers WHERE tenant_id = ? AND email = ?')
    .get(tenantId, 'picked@manual.example');
  assert.equal(picked.source, 'manual');
  assert.equal(picked.notes, 'keep me');

  const overview = await c.get('/api/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.json.counts.collected, 4);

  // Re-posting the same contacts updates in place; the count is stable,
  // and a case-variant email still hits the same row.
  const changed = CONTACTS.map((x) => ({ ...x, name: 'Renamed Person' }));
  changed[0] = { ...changed[0], email: 'Pastor@Grace.Example' };
  const r2 = await c.post(`/api/auth/contacts-sync/${tok}`, {
    tenant_email: 'sync@contacts.example', contacts: changed,
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.inserted, 0);
  assert.equal(r2.json.updated, 3);
  assert.equal(r2.json.total_in_tenant, 4);
  const renamed = db.prepare('SELECT * FROM influencers WHERE tenant_id = ? AND LOWER(email) = LOWER(?)')
    .get(tenantId, 'pastor@grace.example');
  assert.equal(renamed.handle, 'Renamed Person');

  const overview2 = await c.get('/api/overview');
  assert.equal(overview2.json.counts.collected, 4);
});

test('contacts sync keeps family_office unmapped and tenants isolated', async () => {
  const tok = process.env.MIGRATION_TOKEN;
  const other = await register('other@contacts.example', 'Other Contacts Co');
  const otherTenantId = db.prepare('SELECT tenant_id FROM users WHERE email = ?')
    .get('other@contacts.example').tenant_id;

  const r = await client(base).post(`/api/auth/contacts-sync/${tok}`, {
    tenant_email: 'sync@contacts.example',
    contacts: [{ email: 'fund@capital.example', name: 'Capital Fund', category: 'family_office', subcategory: '', notes: '', source_file: 'funds.csv' }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.inserted, 1);

  const ownerTenantId = db.prepare('SELECT tenant_id FROM users WHERE email = ?')
    .get('sync@contacts.example').tenant_id;
  const fund = db.prepare('SELECT * FROM influencers WHERE tenant_id = ? AND email = ?')
    .get(ownerTenantId, 'fund@capital.example');
  assert.equal(fund.category, 'family_office');

  // The other tenant gained nothing from either sync.
  const otherCount = db.prepare('SELECT COUNT(*) AS n FROM influencers WHERE tenant_id = ?')
    .get(otherTenantId).n;
  assert.equal(otherCount, 0);
  const otherOverview = await other.get('/api/overview');
  assert.equal(otherOverview.json.counts.collected, 0);
});
