'use strict';
/**
 * Regression test for the 2026-11-18 audit finding: GET /api/drips/scheduled
 * was unreachable because GET /api/drips/:id was defined first and swallowed
 * the literal segment 'scheduled' as a campaign id (400 invalid_id). The
 * scheduled-sends list could never be read through the API.
 *
 * This test drives the exact user flow: create a campaign, schedule a send,
 * list the scheduled sends, cancel one.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

let server, base, c;
before(async () => {
  ({ server, base } = await startServer());
  c = client(base);
  const reg = await c.post('/api/auth/register', {
    companyName: 'Drips Scheduled QA',
    email: 'drips-qa@example.org',
    password: 'drips-qa-password-1',
    plan: 'heavy30',
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
});
after(async () => { server.close(); });

test('scheduled sends: create -> list -> cancel works end to end', async () => {
  const camp = await c.post('/api/email/campaigns', { name: 'Sched QA Campaign' });
  assert.equal(camp.status, 201, JSON.stringify(camp.json));
  const campaignId = camp.json.campaign.id;

  const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const created = await c.post('/api/drips/scheduled', {
    campaign_id: campaignId, scheduled_at: future,
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));

  // The regression: this returned 400 invalid_id before the route-order fix.
  const list = await c.get('/api/drips/scheduled');
  assert.equal(list.status, 200, JSON.stringify(list.json));
  assert.equal(list.json.ok, true);
  const mine = list.json.scheduled.find(s => s.id === created.json.id);
  assert.ok(mine, 'created scheduled send must appear in the list');
  assert.equal(mine.campaign_id, campaignId);
  assert.equal(mine.status, 'pending');
  assert.equal(mine.campaign_name, 'Sched QA Campaign');

  const cancel = await c.del(`/api/drips/scheduled/${created.json.id}`);
  assert.equal(cancel.status, 200, JSON.stringify(cancel.json));

  const list2 = await c.get('/api/drips/scheduled');
  const after = list2.json.scheduled.find(s => s.id === created.json.id);
  assert.equal(after.status, 'cancelled');
});

test('campaign detail by id still works after the reorder', async () => {
  const drip = await c.post('/api/drips', {
    name: 'Detail QA Drip',
    steps: [{ delay_hours: 0, template_key: 'welcome-1' }],
  });
  assert.equal(drip.status, 201, JSON.stringify(drip.json));
  const detail = await c.get(`/api/drips/${drip.json.id}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  assert.equal(detail.json.drip.name, 'Detail QA Drip');
  const bad = await c.get('/api/drips/not-a-number');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_id');
});
