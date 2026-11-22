'use strict';
/**
 * The Scribe journey, walked as the user walks it (2026-11-22):
 * Michael's standing order is that a feature gets put through its
 * paces, every step, the way he would use it. The drafts feature was
 * audited table-by-table but never walked end to end, so three breaks
 * on one short path reached him: drafts created into a table no screen
 * showed, a chat that could not say where they were, and an approval
 * that made the draft vanish into a status nothing reads. This test
 * walks the whole path in order and pins every step:
 *   analyze -> create drafts -> ask the chat where they are ->
 *   waiting list shows them -> approve one -> decided list keeps it ->
 *   chat no longer calls it waiting.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

const PW = 'journey-' + 'pw-1234';

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

test('the full Scribe drafts journey, step by step as the user walks it', async () => {
  const c = client(base);
  const reg = await c.post('/api/auth/register', {
    companyName: 'Journey Co', email: 'journey@example.org', password: PW,
  });
  assert.equal(reg.status, 201);

  // 1. Run a Scribe analysis (stub mode in tests: no Spark key).
  const an = await c.post('/api/scribe/analyze', {});
  assert.equal(an.status, 200);
  assert.ok(an.json.ok && an.json.analysis_id, 'analysis produced');

  // 2. Create drafts from the analysis (201 on create, per the route).
  const created = await c.post('/api/scribe/drafts', { analysis_id: an.json.analysis_id });
  assert.equal(created.status, 201);
  assert.ok(created.json.ok && created.json.created.length >= 1, 'at least one draft created');

  // 3. The waiting list (what the Scribe Drafts block renders) shows them.
  const waiting = await c.get('/api/scribe/drafts?status=draft');
  assert.equal(waiting.json.drafts.length, created.json.created.length, 'waiting list matches creation');
  const firstTitle = waiting.json.drafts[0].title;

  // 4. Ask the chat where the drafts are: it names the place and a draft.
  const ask = await c.post('/api/assistant/chat', { message: 'where are my scribe drafts' });
  assert.equal(ask.status, 200);
  assert.ok(ask.json.reply.includes('Scribe Drafts list'), 'chat names the location');
  assert.ok(ask.json.reply.includes(firstTitle), 'chat names a waiting draft');

  // 5. Approve the first draft: it leaves the waiting list...
  const first = waiting.json.drafts[0];
  const ap = await c.post(`/api/scribe/drafts/${first.id}/status`, { status: 'approved' });
  assert.equal(ap.status, 200);
  const waitingAfter = await c.get('/api/scribe/drafts?status=draft');
  assert.equal(waitingAfter.json.drafts.length, waiting.json.drafts.length - 1, 'approved draft leaves waiting');

  // 6. ...and lands in the decided list with a timestamp (not vanished).
  const decided = await c.get('/api/scribe/drafts?status=approved');
  assert.equal(decided.json.drafts.length, 1, 'decided list holds the approved draft');
  assert.equal(decided.json.drafts[0].id, first.id);
  assert.ok(decided.json.drafts[0].decided_at, 'decision is timestamped');

  // 7. Ask the chat again: the approved draft is no longer called waiting.
  const askAgain = await c.post('/api/assistant/chat', { message: 'where are my scribe drafts' });
  assert.equal(askAgain.status, 200);
  if (waitingAfter.json.drafts.length === 0) {
    assert.ok(askAgain.json.reply.includes('no Scribe drafts waiting'), 'chat says none waiting');
  } else {
    assert.ok(!askAgain.json.reply.includes(firstTitle), 'approved draft not listed as waiting');
  }

  // 8. A decided draft cannot be decided again (terminal state).
  const again = await c.post(`/api/scribe/drafts/${first.id}/status`, { status: 'dismissed' });
  assert.equal(again.status, 409, 'second decision refused');
});
