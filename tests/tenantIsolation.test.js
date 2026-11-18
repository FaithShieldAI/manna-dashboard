'use strict';
/**
 * Tenant isolation regression (2026-11-18, red-team walk finding):
 * a fresh tenant ("Red Team Walk 2026-11-18", production tenant 7)
 * opened its Email tab and saw the HOUSE tenant's six real campaigns
 * (Pastor Combo, nano-armor-bearer-oct2026, the two Pastor Trial
 * Invites, the two seniors batches), its Send Log showed the same
 * sends, and its Engagement Star of the Day was the house campaign
 * nano-armor-bearer-oct2026 at score 145.
 *
 * Root cause proven from the production backup snapshot
 * (manna-backup-20261118-224744.json): every tenant held its OWN copy
 * of the six rows in email_campaigns (tenant 7: ids 47-52), and
 * tenant 7's star_of_day row pointed at its own copy (campaign_id 48,
 * score 145). The read endpoints are tenant-scoped; the rows were
 * PLANTED into every tenant by scripts/seed-demo-data.js, which runs
 * for every tenant at every boot (src/server.js) and at every signup
 * (src/routes/auth.js runSignupSeeds).
 *
 * These tests reproduce the production pattern exactly:
 *   1. a house tenant holding the six real campaigns (names and
 *      figures copied from the production snapshot), and
 *   2. a fresh tenant with no campaigns of its own,
 * both put through seedDemoData the way boot and signup do it, then
 * read back through the app's own HTTP endpoints. The fresh tenant
 * must see EMPTY campaigns (the template's Send Log renders from the
 * same /api/email/campaigns response), an EMPTY star, and no
 * star_of_day row; the house tenant must still see its six campaigns
 * and its star at score 145.
 *
 * The same walk saw the header account age alternate between the
 * fresh tenant's true age and 1 month 9 days: the dashboard template
 * hardcodes DASH_START to 2026-10-09 and only corrects it if an async
 * /api/auth/me fetch lands. serveApp must inject the signed-in
 * tenant's own created_at at serve time; the /app test below pins
 * that.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

let server, base, db, unscoped;
before(async () => {
  ({ server, base } = await startServer());
  ({ db, unscoped } = require('../src/db'));
});
after(async () => { server.close(); });

const { seedDemoData } = require('../scripts/seed-demo-data');

// The house tenant's six real campaigns, names and figures as read
// from the production snapshot (tenant 1, ids 1-6).
const HOUSE_CAMPAIGNS = [
  { name: 'Pastor Combo — FaithShield + Armor Bearer <redacted> 1', provider: 'brevo', sent: 100, opens: 21, clicks: 2, unsubs: 0, bounces: 3, sent_at: '2026-10-12' },
  { name: 'nano-armor-bearer-oct2026', provider: 'kit', sent: 208, opens: 118, clicks: 9, unsubs: 2, bounces: 3, sent_at: '2026-10-09' },
  { name: 'Pastor Trial Invite — Portuguese', provider: 'mailerlite', sent: 47, opens: 27, clicks: 3, unsubs: 0, bounces: 1, sent_at: '2026-10-07' },
  { name: 'Pastor Trial Invite — Tagalog', provider: 'mailerlite', sent: 108, opens: 41, clicks: 4, unsubs: 1, bounces: 4, sent_at: '2026-10-07' },
  { name: 'send-batch-2-seniors.csv', provider: 'brevo', sent: 300, opens: 0, clicks: 0, unsubs: 0, bounces: 0, sent_at: '2026-10-07' },
  { name: 'send-batch-1-seniors.csv', provider: 'brevo', sent: 279, opens: 0, clicks: 0, unsubs: 0, bounces: 0, sent_at: '2026-10-06' },
];

let counter = 0;
async function registerTenant(label) {
  counter += 1;
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: `${label} ${counter}`,
    email: `${label.toLowerCase().replace(/\s+/g, '')}${counter}@iso.example`,
    password: 'iso-secret-pw-123',
    plan: 'starter',
  });
  assert.equal(r.status, 201);
  const me = await c.get('/api/auth/me');
  assert.equal(me.status, 200);
  return { client: c, tenant: me.json.tenant };
}

function insertHouseCampaigns(tenantId) {
  const ins = db.prepare(
    `INSERT INTO email_campaigns
       (tenant_id, name, provider, sent, opens, clicks, unsubs, bounces, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const c of HOUSE_CAMPAIGNS) {
    ins.run(tenantId, c.name, c.provider, c.sent, c.opens, c.clicks, c.unsubs, c.bounces, c.sent_at);
  }
}

test('fresh tenant seeded the production way: empty campaigns, empty send log, no star; house tenant keeps its six', async () => {
  const house = await registerTenant('House');
  const fresh = await registerTenant('Fresh');

  // Production shape: the house tenant holds its six real campaigns;
  // the fresh tenant has none of its own.
  insertHouseCampaigns(house.tenant.id);

  // The production seeding pattern: seedDemoData runs for EVERY
  // tenant at boot and for the new tenant at signup.
  seedDemoData(house.tenant.slug);
  seedDemoData(fresh.tenant.slug);

  // Fresh tenant: campaigns list must be empty. The dashboard's Send
  // Log renders from this same response (it filters this list to
  // rows with sends), so an empty list is an empty send log too.
  const fc = await fresh.client.get('/api/email/campaigns?limit=50');
  assert.equal(fc.status, 200);
  assert.deepEqual(fc.json.campaigns, [],
    'fresh tenant must not see the house campaigns in its Email Campaigns list or Send Log');

  // Fresh tenant: no Star of the Day, and asking must not create one.
  const fs = await fresh.client.get('/api/engagement/star');
  assert.equal(fs.status, 200);
  assert.equal(fs.json.star, null, 'fresh tenant must have no Star of the Day');
  const starRows = db.prepare('SELECT COUNT(*) AS n FROM star_of_day WHERE tenant_id = ?')
    .get(fresh.tenant.id).n;
  assert.equal(starRows, 0, 'no star_of_day row may be created for the fresh tenant');

  // House tenant: its six campaigns and its star are untouched.
  const hc = await house.client.get('/api/email/campaigns?limit=50');
  assert.equal(hc.status, 200);
  assert.equal(hc.json.campaigns.length, 6);
  assert.deepEqual(
    hc.json.campaigns.map((c) => c.name).sort(),
    HOUSE_CAMPAIGNS.map((c) => c.name).sort(),
  );
  const hs = await house.client.get('/api/engagement/star');
  assert.equal(hs.status, 200);
  assert.ok(hs.json.star, 'house tenant keeps its Star of the Day');
  assert.equal(hs.json.star.score, 145);
  assert.equal(hs.json.star.campaign.name, 'nano-armor-bearer-oct2026');
});

test('/app serves the signed-in tenant account start, not the hardcoded house date', async () => {
  // Raw fetch: the helpers client does not expose its cookie jar, and
  // /app is a page route that needs the session cookie.
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({
      companyName: 'Clock Co', email: 'clock@iso.example',
      password: 'iso-secret-pw-123', plan: 'starter',
    }),
  });
  assert.equal(res.status, 201);
  const setCookie = res.headers.get('set-cookie') || '';
  const m = setCookie.match(/d2rm_session=[^;]*/);
  assert.ok(m, 'register must set a session cookie');
  const reg = await res.json();
  const tenantRow = db.prepare('SELECT created_at FROM tenants WHERE id = ?').get(reg.tenant.id);
  assert.ok(tenantRow && tenantRow.created_at);

  const page = await fetch(base + '/app', { headers: { Cookie: m[0] }, redirect: 'manual' });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(
    html.includes(`var DASH_START = new Date("${tenantRow.created_at}")`),
    '/app must inject the signed-in tenant created_at as DASH_START',
  );
  assert.ok(
    !html.includes('2026-10-09T12:00:00-07:00'),
    '/app must not carry the hardcoded house start date',
  );
});
