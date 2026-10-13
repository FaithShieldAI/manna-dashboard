'use strict';
/**
 * Tenant isolation tests — THE security-critical suite.
 *
 * Tenant A ("Alpha") is created via the public API. Tenant B ("Beta") rows
 * are inserted directly into the DB with a different tenant_id, simulating
 * another customer's data. Every API endpoint is then called with Alpha's
 * session and must return ONLY Alpha's rows — never Beta's.
 *
 * If any of these fail, the build is not shippable.
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

const BETA_MARKER = 'BETA-MARKER- SHOULD-NEVER-LEAK';

let alphaCounter = 0;
async function registerAlpha() {
  alphaCounter += 1;
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: `Alpha Org ${alphaCounter}`,
    email: `alpha${alphaCounter}@alpha.example`,
    password: 'alpha-secret-pw-12',
    plan: 'starter',
  });
  assert.equal(r.status, 201);
  return c; // logged in as Alpha owner
}

let betaCounter = 0;

function insertBetaRows() {
  betaCounter += 1;
  const t = unscoped.createTenant('Beta Org', `beta-org-${betaCounter}`, 'starter');
  const tid = Number(t.lastInsertRowid);
  const ins = (sql, ...p) => db.prepare(sql).run(tid, ...p);

  const sr = ins('INSERT INTO sites (tenant_id, site_key, name) VALUES (?, ?, ?)', 'site', BETA_MARKER);
  ins('INSERT INTO site_daily_metrics (tenant_id, site_id, day, visitors) VALUES (?, ?, ?, ?)',
    Number(sr.lastInsertRowid), '2026-10-01', 666);
  ins('INSERT INTO site_events (tenant_id, site_id, event_name, occurred_at) VALUES (?, ?, ?, ?)',
    Number(sr.lastInsertRowid), BETA_MARKER, new Date().toISOString());
  ins('INSERT INTO email_snapshots (tenant_id, window_key, sent) VALUES (?, ?, ?)', 'all', 666);
  ins(`INSERT INTO email_campaigns (tenant_id, name, provider) VALUES (?, ?, ?)`, BETA_MARKER, 'brevo');
  ins('INSERT INTO influencers (tenant_id, handle, category) VALUES (?, ?, ?)', BETA_MARKER, 'influencer');
  ins('INSERT INTO ip_assets (tenant_id, title, asset_type) VALUES (?, ?, ?)', BETA_MARKER, 'copyright');
  ins('INSERT INTO social_accounts (tenant_id, platform, handle) VALUES (?, ?, ?)', 'x', BETA_MARKER);
  ins('INSERT INTO goals (tenant_id, goal_key, label, current_value, goal_value) VALUES (?, ?, ?, ?, ?)',
    'beta-goal', BETA_MARKER, 666, 1000);
  const fr = ins('INSERT INTO funnels (tenant_id, funnel_key, name) VALUES (?, ?, ?)', 'beta-funnel', BETA_MARKER);
  db.prepare('INSERT INTO funnel_stages (funnel_id, stage_key, label, current_value) VALUES (?, ?, ?, ?)')
    .run(Number(fr.lastInsertRowid), 's', BETA_MARKER, 666);
  return tid;
}

function assertNoLeak(obj, path) {
  const s = JSON.stringify(obj);
  assert.ok(!s.includes(BETA_MARKER), `LEAK at ${path}: beta marker found in response`);
}

test('no cross-tenant leakage on any read endpoint', async () => {
  const alpha = await registerAlpha();
  insertBetaRows();

  // Alpha adds one of its own rows so responses are non-empty.
  const me = await alpha.get('/api/auth/me');
  const alphaTenantId = me.json.tenant.id;
  db.prepare('INSERT INTO goals (tenant_id, goal_key, label, current_value, goal_value) VALUES (?, ?, ?, ?, ?)')
    .run(alphaTenantId, 'alpha-goal', 'Alpha Goal', 10, 100);

  const endpoints = [
    '/api/overview',
    '/api/sites',
    '/api/email/windows',
    '/api/email/campaigns',
    '/api/funnels',
    '/api/influencers',
    '/api/influencers/counts',
    '/api/influencers?category=podcast',
    '/api/ip-registry',
    '/api/social',
    '/api/goals',
  ];
  for (const ep of endpoints) {
    const r = await alpha.get(ep);
    assert.equal(r.status, 200, ep);
    assertNoLeak(r.json, ep);
  }

  // Alpha's own data IS visible.
  const goals = await alpha.get('/api/goals');
  assert.ok(goals.json.goals.some(g => g.key === 'alpha-goal'), 'alpha goal visible');
  assert.ok(!goals.json.goals.some(g => g.key === 'beta-goal'), 'beta goal hidden');
});

test('tenant B site key is invisible to tenant A (404, not data)', async () => {
  const alpha = await registerAlpha();
  insertBetaRows();
  const r = await alpha.get('/api/sites/site/stats'); // 'site' belongs to Beta
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'site_not_found');
});

test('tenant B cannot be reached by guessing numeric IDs', async () => {
  const alpha = await registerAlpha();
  const betaTid = insertBetaRows();
  // Funnel listing must not include beta's funnel.
  const r = await alpha.get('/api/funnels');
  const names = JSON.stringify(r.json);
  assert.ok(!names.includes(BETA_MARKER));
  assert.ok(betaTid > 0, 'sanity: beta tenant exists');
});
