'use strict';
/**
 * AI assistant tests (no ANTHROPIC_API_KEY in test env -> insight engine).
 *  - status reports the insights provider
 *  - chat answers from the tenant's real data (goals seeded below)
 *  - validation: empty / too-long / bad history
 *  - tenant isolation: reply contains nothing from another tenant
 *  - history is accepted and echoed back in order
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

async function register(email, company) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: company || ('AI Co ' + email), email, password: 'ai-secret-pw-1234',
  });
  assert.equal(r.status, 201);
  return { c, tenantId: r.json.tenant.id };
}

test('status reports insight engine without API key', async () => {
  const { c } = await register('st@example.org');
  const r = await c.get('/api/assistant/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.provider, 'insights');
});

test('chat validates input', async () => {
  const { c } = await register('v@example.org');
  const empty = await c.post('/api/assistant/chat', { message: '   ' });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error, 'message_required');
  const long = await c.post('/api/assistant/chat', { message: 'x'.repeat(2001) });
  assert.equal(long.status, 400);
  const badh = await c.post('/api/assistant/chat', { message: 'hi', history: 'nope' });
  assert.equal(badh.status, 400);
});

test('chat answers from tenant data: goals + next actions', async () => {
  const { c, tenantId } = await register('data@example.org');
  db.prepare(`INSERT INTO goals (tenant_id, goal_key, label, current_value, goal_value, unit)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(tenantId, 'subs', 'Newsletter subscribers', 250, 1000, 'subs');
  db.prepare(`INSERT INTO email_snapshots (tenant_id, window_key, sent, opens, clicks)
              VALUES (?, 'all', 2000, 300, 20)`)
    .run(tenantId);

  const g = await c.post('/api/assistant/chat', { message: 'how are my goals doing?' });
  assert.equal(g.status, 200);
  assert.equal(g.json.ok, true);
  assert.match(g.json.reply, /Newsletter subscribers/);
  assert.match(g.json.reply, /250/);

  // Mid-setup, "what should I do next?" is a walk-through question (the
  // current step only) — see the walk-through tests below. The marketing
  // next-actions answer applies once setup is closed.
  await c.post('/api/onboarding/dismiss', {});
  const n = await c.post('/api/assistant/chat', { message: 'what should I do next?' });
  assert.equal(n.status, 200);
  assert.match(n.json.reply, /next actions/i);
  // open rate 15% < 20% -> subject-line action should appear
  assert.match(n.json.reply, /subject/i);
});

test('walk-through: "what do I do first?" gets step 1, not the briefing', async () => {
  const { c } = await register('first@example.org');
  const r = await c.post('/api/assistant/chat', { message: 'I just signed up, what do I do first?' });
  assert.equal(r.status, 200);
  assert.match(r.json.reply, /step 1 of 5/);
  assert.match(r.json.reply, /Welcome & quick tour/);
  assert.match(r.json.reply, /Start setup/); // the real button on the page
  assert.doesNotMatch(r.json.reply, /Quick briefing/);
});

test('walk-through: a later step is answered in sequence, not jumped to', async () => {
  const { c } = await register('seq@example.org');
  const r = await c.post('/api/assistant/chat', { message: 'How do I set up my first campaign?' });
  assert.equal(r.status, 200);
  assert.match(r.json.reply, /step 5 of 5/);
  assert.match(r.json.reply, /in order/);
  assert.match(r.json.reply, /Welcome & quick tour/); // brought back to step 1
  assert.doesNotMatch(r.json.reply, /Quick briefing/);
});

test('walk-through: saying "done" advances to the next step', async () => {
  const { c } = await register('done@example.org');
  await c.post('/api/onboarding/welcome', {});
  const r = await c.post('/api/assistant/chat', { message: 'done' });
  assert.equal(r.status, 200);
  assert.match(r.json.reply, /step 2 of 5/);
  assert.match(r.json.reply, /Connect your socials/);
});

test('walk-through: completion is acknowledged once every step is done', async () => {
  const { c } = await register('complete@example.org');
  await c.post('/api/onboarding/welcome', {});
  await c.post('/api/onboarding/socials', { platform: 'instagram', handle: 'completewalk' });
  await c.post('/api/onboarding/templates/install-all', {});
  await c.post('/api/leads/jobs', { source: 'weblist', seeds: ['https://example.com'] });
  await c.post('/api/email/campaigns', { name: 'First blast' });
  const r = await c.post('/api/assistant/chat', { message: 'is my setup complete?' });
  assert.equal(r.status, 200);
  assert.match(r.json.reply, /all set up/);
  assert.match(r.json.reply, /every setup step is done/);
});

test('chat is tenant-isolated', async () => {
  const { tenantId } = await register('iso-a@example.org', 'Secret Plans Inc');
  db.prepare(`INSERT INTO goals (tenant_id, goal_key, label, current_value, goal_value)
              VALUES (?, ?, ?, ?, ?)`)
    .run(tenantId, 'g', 'Secret Project X Goal', 1, 100);
  const { c: cB } = await register('iso-b@example.org', 'Other Corp');
  const r = await cB.post('/api/assistant/chat', { message: 'summarize everything you know' });
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.json.reply, /Secret Project X/);
  assert.doesNotMatch(r.json.reply, /Secret Plans Inc/);
});

test('unauthenticated chat is rejected', async () => {
  const c = client(base);
  const r = await c.post('/api/assistant/chat', { message: 'hello' });
  assert.equal(r.status, 401);
});
