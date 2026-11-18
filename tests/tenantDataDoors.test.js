'use strict';
/**
 * Staff data doors (2026-11-18, tenant 1 data completion):
 *
 *   POST /api/auth/tenant-funnels/:token   — insert-if-missing funnel
 *     creation for a tenant, mirroring POST /api/funnels validation and
 *     storage, returning the tenant's funnel list as the read-back. The
 *     house tenant's Conversions tab is filled by staff (no owner
 *     credentials are available to the operator), in the pattern of the
 *     tenant-plan winner-activation door.
 *   POST /api/auth/social-stats-sync/:token — writes verified platform
 *     counts into EXISTING social_accounts rows (Manna's own track path
 *     cannot write tenant 1's platforms at all; the rows stood at their
 *     insert-time zeros).
 *   POST /api/auth/campaigns-sync/:token — upserts provider campaign
 *     stats into email_campaigns by (tenant_id, name), the refresh step
 *     the Campaigns card needed (Oct 19, 2026 EmailOctopus opens stood
 *     at a stale 9 and 16 against the provider's 15 and 27).
 *
 * All three are guarded by the MIGRATION_TOKEN pattern, resolve the
 * tenant by tenant_email or tenant_id, and must never write into
 * another tenant's rows.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
process.env.MIGRATION_TOKEN = ['test', 'data', 'doors'].join('-');

let server, base, db, forTenant;
before(async () => {
  ({ server, base } = await startServer());
  ({ db, forTenant } = require('../src/db'));
});
after(async () => { server.close(); });

const TOKEN = process.env.MIGRATION_TOKEN;

async function registerOwner(email, companyName) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName, email, password: 'data-doors-secret-12', plan: 'starter',
  });
  assert.equal(r.status, 201, `register ${email}: ${JSON.stringify(r.json)}`);
  const user = db.prepare('SELECT tenant_id FROM users WHERE LOWER(email) = LOWER(?)').get(email);
  return { c, tenantId: Number(user.tenant_id) };
}

// The house tenant's five funnels, exactly as the 2026-11-18 funnels
// backfill report's ENTRY LIST names them (names and stage labels
// verbatim; no goal values are on record for any stage).
const HOUSE_FUNNELS = [
  { name: 'Influencer funnel', stages: ['Vetted influencers', 'Emailed', 'Opened', 'Clicked', 'Replied', 'Approved affiliates'].map(label => ({ label })) },
  { name: 'Pastor funnel', stages: ['Emailed', 'Replied', 'Trial requests'].map(label => ({ label })) },
  { name: 'Family office funnel', stages: ['Collected', 'Vetted', 'Contacted', 'Conversation'].map(label => ({ label })) },
  { name: 'MannaAi users', stages: ['Visitor', 'Signup', 'Trial', 'Customer'].map(label => ({ label })) },
  { name: 'K-Punk Kickstarter notify-me', stages: ['Visitor', 'Notify-me signup', 'Kickstarter backer'].map(label => ({ label })) },
];

test('tenant-funnels door: wrong token is refused', async () => {
  const c = client(base);
  const r = await c.post('/api/auth/tenant-funnels/wrong-token', {
    tenant_id: 1, funnels: HOUSE_FUNNELS,
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'forbidden');
});

test('tenant-funnels door: creates the five funnels, read back through the tenant API, idempotent', async () => {
  const { c, tenantId } = await registerOwner('funnels@doors.example', 'Funnels Door Co');
  const r = await c.post(`/api/auth/tenant-funnels/${TOKEN}`, {
    tenant_id: tenantId, funnels: HOUSE_FUNNELS,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.inserted, [
    'influencer-funnel', 'pastor-funnel', 'family-office-funnel', 'mannaai-users', 'k-punk-kickstarter-notify-me',
  ]);
  assert.deepEqual(r.json.skipped, []);

  // Read back through the tenant's own session API, the Conversions
  // tab's data path: names and stage labels exact, in order.
  const list = await c.get('/api/funnels');
  assert.equal(list.status, 200);
  assert.equal(list.json.funnels.length, 5);
  const byKey = Object.fromEntries(list.json.funnels.map(f => [f.key, f]));
  assert.deepEqual(byKey['influencer-funnel'].stages.map(s => s.label),
    ['Vetted influencers', 'Emailed', 'Opened', 'Clicked', 'Replied', 'Approved affiliates']);
  assert.deepEqual(byKey['pastor-funnel'].stages.map(s => s.label),
    ['Emailed', 'Replied', 'Trial requests']);
  assert.deepEqual(byKey['family-office-funnel'].stages.map(s => s.label),
    ['Collected', 'Vetted', 'Contacted', 'Conversation']);
  assert.deepEqual(byKey['mannaai-users'].stages.map(s => s.key),
    ['visitor', 'signup', 'trial', 'customer']);
  assert.deepEqual(byKey['k-punk-kickstarter-notify-me'].stages.map(s => s.label),
    ['Visitor', 'Notify-me signup', 'Kickstarter backer']);

  // Re-running the staff load inserts nothing.
  const again = await c.post(`/api/auth/tenant-funnels/${TOKEN}`, {
    tenant_id: tenantId, funnels: HOUSE_FUNNELS,
  });
  assert.equal(again.status, 200);
  assert.deepEqual(again.json.inserted, []);
  assert.deepEqual(again.json.skipped, [
    'influencer-funnel', 'pastor-funnel', 'family-office-funnel', 'mannaai-users', 'k-punk-kickstarter-notify-me',
  ]);
  const list2 = await c.get('/api/funnels');
  assert.equal(list2.json.funnels.length, 5);
});

test('tenant-funnels door: validation and tenant isolation', async () => {
  const { c, tenantId } = await registerOwner('funnels2@doors.example', 'Funnels Door Two');
  const bad = await c.post(`/api/auth/tenant-funnels/${TOKEN}`, {
    tenant_id: tenantId, funnels: [{ name: 'Broken funnel', stages: [] }],
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_stages');

  const missing = await c.post(`/api/auth/tenant-funnels/${TOKEN}`, {
    tenant_id: 999999, funnels: HOUSE_FUNNELS,
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'tenant_not_found');

  // This tenant never got the house funnels: its list is empty even
  // though another tenant holds all five.
  const list = await c.get('/api/funnels');
  assert.equal(list.status, 200);
  assert.equal(list.json.funnels.length, 0);
});

test('social-stats-sync door: writes verified counts into existing rows only', async () => {
  const { c, tenantId } = await registerOwner('social@doors.example', 'Social Door Co');
  const tdb = forTenant(tenantId);
  tdb.upsertSocialAccount({ platform: 'instagram', handle: '@faithshield.ai' });
  tdb.upsertSocialAccount({ platform: 'facebook', handle: 'Manna AI' });

  const wrong = await c.post('/api/auth/social-stats-sync/wrong-token', {
    tenant_id: tenantId, accounts: [{ platform: 'instagram', handle: '@faithshield.ai', followers: 11, posts: 8 }],
  });
  assert.equal(wrong.status, 403);

  const r = await c.post(`/api/auth/social-stats-sync/${TOKEN}`, {
    tenant_id: tenantId,
    accounts: [
      { platform: 'instagram', handle: '@faithshield.ai', followers: 11, posts: 8 },
      { platform: 'facebook', handle: 'Manna AI', followers: 1, posts: 0 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.updated, 2);

  const list = await c.get('/api/social');
  assert.equal(list.status, 200);
  const ig = list.json.accounts.find(a => a.platform === 'instagram');
  const fb = list.json.accounts.find(a => a.platform === 'facebook');
  assert.equal(ig.followers, 11);
  assert.equal(ig.posts, 8);
  assert.equal(fb.followers, 1);

  // A row the tenant does not hold is refused, never created.
  const ghost = await c.post(`/api/auth/social-stats-sync/${TOKEN}`, {
    tenant_id: tenantId,
    accounts: [{ platform: 'instagram', handle: '@not-a-row', followers: 5, posts: 1 }],
  });
  assert.equal(ghost.status, 404);
  assert.equal(ghost.json.error, 'social_account_not_found:instagram:@not-a-row');
  const list2 = await c.get('/api/social');
  assert.equal(list2.json.accounts.length, 2);

  const bad = await c.post(`/api/auth/social-stats-sync/${TOKEN}`, {
    tenant_id: tenantId,
    accounts: [{ platform: 'instagram', handle: '@faithshield.ai', followers: -1, posts: 8 }],
  });
  assert.equal(bad.status, 400);
});

test('social-stats-sync door: another tenant with the same handle is untouched', async () => {
  const { c, tenantId } = await registerOwner('social2@doors.example', 'Social Door Two');
  forTenant(tenantId).upsertSocialAccount({ platform: 'instagram', handle: '@faithshield.ai' });
  const list = await c.get('/api/social');
  const ig = list.json.accounts.find(a => a.platform === 'instagram');
  assert.equal(ig.followers, 0);
  assert.equal(ig.posts, 0);
});

test('campaigns-sync door: upserts by name and refreshes stale figures in place', async () => {
  const { c, tenantId } = await registerOwner('campaigns@doors.example', 'Campaigns Door Co');
  const wrong = await c.post('/api/auth/campaigns-sync/wrong-token', {
    tenant_id: tenantId,
    campaigns: [{ name: 'X', sent: 1, opens: 0, clicks: 0, unsubs: 0, bounces: 0 }],
  });
  assert.equal(wrong.status, 403);

  const stale = [
    { name: 'Armor Bearer <redacted> - 2026-10-19', provider: 'emailoctopus', sent: 50, opens: 16, clicks: 0, unsubs: 1, bounces: 2, sent_at: '2026-10-19' },
    { name: 'Armor Bearer <redacted> Wave3 - 2026-10-19', provider: 'emailoctopus', sent: 44, opens: 9, clicks: 1, unsubs: 0, bounces: 5, sent_at: '2026-10-19' },
  ];
  const r1 = await c.post(`/api/auth/campaigns-sync/${TOKEN}`, { tenant_id: tenantId, campaigns: stale });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  assert.equal(r1.json.inserted, 2);
  assert.equal(r1.json.updated, 0);

  // The refresh: same names, provider's fresh opens (27 and 15).
  const fresh = [
    { name: 'Armor Bearer <redacted> - 2026-10-19', provider: 'emailoctopus', sent: 50, opens: 27, clicks: 0, unsubs: 1, bounces: 2, sent_at: '2026-10-19' },
    { name: 'Armor Bearer <redacted> Wave3 - 2026-10-19', provider: 'emailoctopus', sent: 44, opens: 15, clicks: 1, unsubs: 0, bounces: 5, sent_at: '2026-10-19' },
  ];
  const r2 = await c.post(`/api/auth/campaigns-sync/${TOKEN}`, { tenant_id: tenantId, campaigns: fresh });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.inserted, 0);
  assert.equal(r2.json.updated, 2);

  const list = await c.get('/api/email/campaigns');
  assert.equal(list.status, 200);
  assert.equal(list.json.campaigns.length, 2);
  const plain = list.json.campaigns.find(x => x.name === 'Armor Bearer <redacted> - 2026-10-19');
  const wave3 = list.json.campaigns.find(x => x.name === 'Armor Bearer <redacted> Wave3 - 2026-10-19');
  assert.equal(plain.opens, 27);
  assert.equal(wave3.opens, 15);

  const bad = await c.post(`/api/auth/campaigns-sync/${TOKEN}`, {
    tenant_id: tenantId,
    campaigns: [{ name: 'Neg', sent: -1, opens: 0, clicks: 0, unsubs: 0, bounces: 0 }],
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_metric:Neg.sent');
});
