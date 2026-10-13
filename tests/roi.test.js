'use strict';
/**
 * ROI tests: per-campaign, per-funnel, and the overview rollup.
 * Seed data: campaign $50 cost / $210 revenue (320% ROI),
 * funnels $50/$210 and $200/$600.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

// Require AFTER setupTestEnv so the module picks up the test DATABASE_PATH.
const { db } = require('../src/db');

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

async function seedWithRoi(tag) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'ROI Co ' + tag, email: `roi-${tag}@example.org`, password: 'roi-secret-pw-123',
  });
  assert.equal(r.status, 201);
  const tenantId = r.json.tenant.id;
  // campaign: $100 cost, $350 revenue -> 250% ROI, $250 profit
  db.prepare(`INSERT INTO email_campaigns (tenant_id, name, provider, sent, cost_cents, revenue_cents)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(tenantId, 'Launch', 'kit', 1000, 10000, 35000);
  // campaign: $0 cost, $0 revenue -> null ROI
  db.prepare(`INSERT INTO email_campaigns (tenant_id, name, sent) VALUES (?, ?, ?)`)
    .run(tenantId, 'Free blast', 500);
  // funnel: $200 cost, $100 revenue -> -50% ROI (loss)
  const f = db.prepare(`INSERT INTO funnels (tenant_id, funnel_key, name, cost_cents, revenue_cents)
                        VALUES (?, ?, ?, ?, ?)`)
    .run(tenantId, 'f1', 'Funnel One', 20000, 10000);
  db.prepare(`INSERT INTO funnel_stages (funnel_id, stage_key, label, current_value, goal_value)
              VALUES (?, ?, ?, ?, ?)`)
    .run(Number(f.lastInsertRowid), 's1', 'Stage', 10, 100);
  return c;
}

test('campaign ROI math', async () => {
  const c = await seedWithRoi("a");
  const r = await c.get('/api/email/campaigns');
  assert.equal(r.status, 200);
  const launch = r.json.campaigns.find(x => x.name === 'Launch');
  assert.equal(launch.cost_cents, 10000);
  assert.equal(launch.revenue_cents, 35000);
  assert.equal(launch.profit_cents, 25000);
  assert.equal(launch.roi_pct, 250);

  const free = r.json.campaigns.find(x => x.name === 'Free blast');
  assert.equal(free.roi_pct, null);
  assert.equal(free.profit_cents, 0);
});

test('funnel ROI math (including a loss)', async () => {
  const c = await seedWithRoi("b");
  const r = await c.get('/api/funnels');
  const f = r.json.funnels.find(x => x.key === 'f1');
  assert.equal(f.profit_cents, -10000);
  assert.equal(f.roi_pct, -50);
});

test('overview ROI rollup sums funnels + campaigns', async () => {
  const c = await seedWithRoi("c");
  const r = await c.get('/api/overview');
  // cost: 10000 + 0 + 20000 = 30000; revenue: 35000 + 0 + 10000 = 45000
  // profit 15000, roi = 50%
  assert.equal(r.json.roi.cost_cents, 30000);
  assert.equal(r.json.roi.revenue_cents, 45000);
  assert.equal(r.json.roi.profit_cents, 15000);
  assert.equal(r.json.roi.roi_pct, 50);
});
