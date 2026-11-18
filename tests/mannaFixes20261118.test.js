'use strict';
/**
 * Regression tests for the 2026-11-18 Heavy 30 audit fix list:
 *  - Social Posting Tracking accepts YouTube (migration 040 + route list)
 *  - a manually logged posting also writes the content_postings
 *    attribution row (migration 008's table had NO writer at all)
 *  - postingLog.recordPosting (the auto-feed used by the posting
 *    routes) writes attribution always, tracking row when a URL exists
 *  - POST /ab/:id/winner refuses to overwrite a decided test
 *  - migration-export covers every live table (30 were missing)
 *  - tenant-plan door: staff activation sets plan + status and reads
 *    back entitlements; billing shows the video cap in limits
 *  - send-mail door enforces the tenant email quota and meters only
 *    real sends (stubbed sends record nothing)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
process.env.MIGRATION_TOKEN = 'test-migration-token';

const { db, forTenant } = require('../src/db');
const { currentMonthKey } = require('../src/lib/plans');
const postingLog = require('../src/lib/postingLog');

let server, base, c, tenantId;
before(async () => {
  ({ server, base } = await startServer());
  c = client(base);
  const reg = await c.post('/api/auth/register', {
    companyName: 'Fixes QA Tenant',
    email: 'fixes-qa@example.org',
    password: 'fixes-qa-password-1',
    plan: 'heavy30',
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  tenantId = reg.json.tenant.id;
});
after(async () => { server.close(); });

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// --- Social Posting Tracking: YouTube + attribution ------------------------

test('youtube posting logs, lists, and writes an attribution row', async () => {
  const url = 'https://www.youtube.com/watch?v=qa1234567';
  const r = await c.post('/api/engagement/social', {
    platform: 'youtube', post_url: url, likes: 5, shares: 2, comments: 3, clicks: 4,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.posting.platform, 'youtube');

  const list = await c.get('/api/engagement/social?platform=youtube');
  assert.equal(list.status, 200);
  assert.ok(list.json.postings.some(p => p.post_url === url));

  const attr = db.prepare(
    'SELECT * FROM content_postings WHERE tenant_id = ? AND post_url = ?'
  ).get(tenantId, url);
  assert.ok(attr, 'content_postings attribution row must exist');
  assert.equal(attr.platform, 'youtube');
  assert.equal(attr.likes, 5);
  assert.equal(attr.clicks, 4);
});

test('recordPosting: attribution always, tracking row only with a real URL', async () => {
  // Truth Social publish returns no URL in this flow: attribution only.
  const a = postingLog.recordPosting({
    tenantId, platform: 'truth', postUrl: null, notes: 'post_id 42',
  });
  assert.ok(a.content_posting_id, 'attribution row written');
  assert.equal(a.social_posting_id, null, 'no tracking row without a URL');
  const row = db.prepare('SELECT * FROM content_postings WHERE id = ?').get(a.content_posting_id);
  assert.equal(row.platform, 'truthsocial', 'platform alias normalized');

  // YouTube publish with a URL: both rows.
  const b = postingLog.recordPosting({
    tenantId, platform: 'youtube',
    postUrl: 'https://www.youtube.com/watch?v=auto12345',
  });
  assert.ok(b.content_posting_id);
  assert.ok(b.social_posting_id, 'tracking row written with a URL');
  const sp = db.prepare('SELECT * FROM social_postings WHERE id = ?').get(b.social_posting_id);
  assert.equal(sp.platform, 'youtube');
});

// --- A/B winner overwrite ---------------------------------------------------

test('a decided A/B test refuses a second winner', async () => {
  const created = await c.post('/api/engagement/ab', {
    name: 'Winner QA', variant_a_template: 'welcome-1', variant_b_template: 'welcome-2',
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.test.id;
  const first = await c.post(`/api/engagement/ab/${id}/winner`, { variant: 'a' });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.test.winner, 'a');
  const second = await c.post(`/api/engagement/ab/${id}/winner`, { variant: 'b' });
  assert.equal(second.status, 400, JSON.stringify(second.json));
  assert.equal(second.json.error, 'test_already_done');
  const after = await c.get('/api/engagement/ab');
  const t = after.json.tests.find(x => x.id === id);
  assert.equal(t.winner, 'a', 'original winner stands');
});

// --- Migration export completeness ------------------------------------------

test('migration-export covers every live table', async () => {
  const r = await client(base).get(`/api/auth/migration-export/${process.env.MIGRATION_TOKEN}`);
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 200));
  const live = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  ).all().map(x => x.name)
    .filter(n => !n.startsWith('sqlite_') && n !== 'schema_migrations' && !n.endsWith('_new'));
  assert.ok(live.length >= 50, `expected the full schema, saw ${live.length} tables`);
  for (const t of live) {
    assert.ok(Array.isArray(r.json.data[t]), `export must include live table ${t} as rows`);
  }
  // The tables the audit named explicitly:
  for (const t of ['ab_tests', 'social_postings', 'video_jobs', 'drip_campaigns',
    'drip_steps', 'drip_enrollments', 'drip_send_log', 'scheduled_sends',
    'scribe_analyses', 'scribe_drafts', 'scribe_followups', 'facebook_pages',
    'pr_targets', 'pr_releases', 'pr_pitches']) {
    assert.ok(Array.isArray(r.json.data[t]), `export must include ${t}`);
  }
});

// --- Tenant-plan door + billing limits --------------------------------------

test('tenant-plan door activates plan + status and reads back entitlements', async () => {
  const bad = await client(base).post(`/api/auth/tenant-plan/${process.env.MIGRATION_TOKEN}`, {
    tenant_id: tenantId, plan: 'platinum',
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_plan');

  const r = await client(base).post(`/api/auth/tenant-plan/${process.env.MIGRATION_TOKEN}`, {
    tenant_id: tenantId, plan: 'heavy30', subscription_status: 'active', extra_seats: 1,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.tenant.plan, 'heavy30');
  assert.equal(r.json.tenant.subscription_status, 'active');
  assert.equal(r.json.tenant.extra_seats, 1);
  assert.equal(r.json.entitlements.emails_per_month, 50000);
  assert.equal(r.json.entitlements.videos_per_month, 30);
  assert.equal(r.json.entitlements.effective_emails_per_month, 50000);

  const wrong = await client(base).post('/api/auth/tenant-plan/wrong-token', {
    tenant_id: tenantId, subscription_status: 'active',
  });
  assert.equal(wrong.status, 403);
});

test('billing limits show the video cap for the tenant plan', async () => {
  const r = await c.get('/api/billing/');
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 200));
  assert.equal(r.json.plan, 'heavy30');
  assert.equal(r.json.limits.videos_per_month, 30);
  assert.equal(r.json.limits.emails_per_month, 50000);
});

// --- Send-mail door metering --------------------------------------------------

const CSV = [
  'outlet,email,version,body_file,subject',
  'Example Outlet,person@example.org,V1,body-1.txt,Hello there',
  '',
].join('\n');
const MAIL = {
  to: 'person@example.org',
  subject: 'Hello there',
  text: 'This is the locked body text.',
};
function validProof() {
  return {
    order_id: 'fixes-qa-order',
    recipients_sha256: sha(CSV),
    recipients_csv: CSV,
    body_sha256: sha(MAIL.text),
    subject_sha256: sha(MAIL.subject),
    version: 'V1',
    not_before: '2020-01-01T00:00:00Z',
  };
}

test('send-mail door enforces the tenant quota and meters only real sends', async () => {
  // A second client registers the house owner identity the door
  // resolves by default; a fresh tenant is 'trialing' (cap 100).
  const c2 = client(base);
  const reg = await c2.post('/api/auth/register', {
    companyName: 'Door QA House',
    email: 'michael@faithshield.ai',
    password: 'door-qa-password-1',
    plan: 'starter',
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  const houseTenant = reg.json.tenant.id;
  const monthKey = currentMonthKey();

  // Under the cap: the door accepts (mailer stub in tests -> 502),
  // and a stubbed (unsent) mail records NO usage.
  const accepted = await client(base).post(`/api/auth/send-mail/${process.env.MIGRATION_TOKEN}`, {
    ...MAIL, lockProof: validProof(),
  });
  assert.equal(accepted.status, 502, JSON.stringify(accepted.json));
  assert.equal(accepted.json.error, 'send_stubbed');
  assert.equal(forTenant(houseTenant).getUsage(monthKey), 0, 'stubbed sends are not metered');

  // At the trial cap (100): the door refuses before the mailer runs.
  forTenant(houseTenant).addUsage(monthKey, 100);
  const refused = await client(base).post(`/api/auth/send-mail/${process.env.MIGRATION_TOKEN}`, {
    ...MAIL, lockProof: validProof(),
  });
  assert.equal(refused.status, 403, JSON.stringify(refused.json));
  assert.equal(refused.json.error, 'trial_email_limit_reached');
  assert.equal(refused.json.limit, 100);
  assert.equal(refused.json.used, 100);
});
