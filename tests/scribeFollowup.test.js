'use strict';
/**
 * The loop (Michael, 2026-10-31): a recorded move fires Scribe
 * automatically. The follow-up notice carries what happened, the
 * reaction's direction, Scribe's dictated next move with its drafts
 * already prepared, and Scribe's questions. The operator answers the
 * questions and presses OK — the only human acts in the loop — and
 * that one press decides the whole prepared batch.
 *
 * The trigger is fire-and-forget, so tests poll for the notice. The
 * per-tenant cooldown is set to 0 here (SCRIBE_FOLLOWUP_MIN_MS) so
 * back-to-back moves in one test each get their follow-up.
 */
process.env.SCRIBE_FOLLOWUP_MIN_MS = '0';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

async function registeredClient(email) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Loop Co', email, password: 'loop-secret-pw-1234',
  });
  assert.equal(r.status, 201, 'register failed: ' + JSON.stringify(r.json));
  return c;
}

async function waitForFollowups(c, n, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await c.get('/api/scribe/followups');
    if (r.json && r.json.ok && r.json.followups.length >= n) return r.json.followups;
    await new Promise(res => setTimeout(res, 120));
  }
  const r = await c.get('/api/scribe/followups');
  return (r.json && r.json.followups) || [];
}

test('posting a move fires Scribe: notice + prepared drafts + a question', async () => {
  const c = await registeredClient('loop-post@example.org');
  const p = await c.post('/api/engagement/social', {
    platform: 'instagram', post_url: 'https://instagram.com/reel/LOOP1',
    likes: 3, shares: 1, comments: 2, clicks: 4,
  });
  assert.equal(p.status, 201);

  const followups = await waitForFollowups(c, 1);
  assert.equal(followups.length >= 1, true, 'a follow-up should arrive on its own');
  const f = followups[0];
  assert.equal(f.event_type, 'posting_logged');
  assert.equal(f.status, 'pending');
  assert.match(f.summary, /instagram/);
  assert.ok(f.analysis_id, 'notice links its analysis');
  assert.ok(f.next_move, 'Scribe dictated a next move');
  assert.ok(f.drafts_count >= 1, 'drafts were prepared automatically, got ' + f.drafts_count);
  assert.ok(Array.isArray(f.questions) && f.questions.length >= 1, 'Scribe asked a question');

  // the prepared drafts exist and are still drafts (nothing proceeded)
  const drafts = await c.get('/api/scribe/drafts?status=draft');
  assert.equal(drafts.json.drafts.filter(d => d.analysis_id === f.analysis_id).length, f.drafts_count);
});

test('operator answers land, and the OK decides the whole batch at once', async () => {
  const c = await registeredClient('loop-ok@example.org');
  await c.post('/api/engagement/social', {
    platform: 'facebook', post_url: 'https://facebook.com/watch/LOOP2', likes: 1,
  });
  const [f] = await waitForFollowups(c, 1);
  assert.ok(f, 'follow-up arrived');

  const ans = await c.post(`/api/scribe/followups/${f.id}/answers`, {
    answers: { '0': 'Parents film first, on Instagram.' },
  });
  assert.equal(ans.status, 200, JSON.stringify(ans.json));
  assert.equal(ans.json.followup.answers['0'], 'Parents film first, on Instagram.');

  const dec = await c.post(`/api/scribe/followups/${f.id}/decide`, { decision: 'approved' });
  assert.equal(dec.status, 200, JSON.stringify(dec.json));
  assert.equal(dec.json.followup.status, 'approved');
  assert.equal(dec.json.drafts_decided, f.drafts_count);

  // every draft of that analysis is approved; none left in draft
  const approved = await c.get('/api/scribe/drafts?status=approved');
  assert.equal(approved.json.drafts.filter(d => d.analysis_id === f.analysis_id).length, f.drafts_count);
  const stillDraft = await c.get('/api/scribe/drafts?status=draft');
  assert.equal(stillDraft.json.drafts.filter(d => d.analysis_id === f.analysis_id).length, 0);

  // a decided follow-up refuses a second decision
  const again = await c.post(`/api/scribe/followups/${f.id}/decide`, { decision: 'dismissed' });
  assert.equal(again.status, 400);
});

test('metrics update notes the reaction direction (up), Not now shelves the batch', async () => {
  const c = await registeredClient('loop-dir@example.org');
  const p = await c.post('/api/engagement/social', {
    platform: 'instagram', post_url: 'https://instagram.com/reel/LOOP3',
    likes: 1, shares: 0, comments: 0, clicks: 1,
  });
  assert.equal(p.status, 201);
  await waitForFollowups(c, 1);

  const put = await c.put(`/api/engagement/social/${p.json.posting.id}/metrics`, {
    likes: 40, shares: 5, comments: 9, clicks: 12,
  });
  assert.equal(put.status, 200);

  const followups = await waitForFollowups(c, 2);
  const f = followups.find(x => x.event_type === 'metrics_updated');
  assert.ok(f, 'metrics follow-up arrived');
  assert.equal(f.direction, 'up');
  assert.match(f.summary, /2 to 66/);

  const dec = await c.post(`/api/scribe/followups/${f.id}/decide`, { decision: 'dismissed' });
  assert.equal(dec.status, 200);
  assert.equal(dec.json.followup.status, 'dismissed');
  const dismissed = await c.get('/api/scribe/drafts?status=dismissed');
  assert.equal(dismissed.json.drafts.filter(d => d.analysis_id === f.analysis_id).length, f.drafts_count);
});

test('A/B sync fires a follow-up naming the scores', async () => {
  const c = await registeredClient('loop-ab@example.org');
  const mk = async (url, m) => {
    const r = await c.post('/api/engagement/social', { platform: 'instagram', post_url: url, ...m });
    assert.equal(r.status, 201);
    return r.json.posting;
  };
  const pa = await mk('https://instagram.com/reel/LA', { clicks: 9, likes: 20, shares: 2, comments: 1 });
  const pb = await mk('https://instagram.com/reel/LB', { clicks: 1, likes: 2, shares: 0, comments: 0 });
  await waitForFollowups(c, 2); // the two posting notices

  const t = await c.post('/api/engagement/ab', {
    name: 'Loop test', kind: 'video', variant_a_post_id: pa.id, variant_b_post_id: pb.id,
  });
  assert.equal(t.status, 201);
  const sy = await c.post(`/api/engagement/ab/${t.json.test.id}/sync`, {});
  assert.equal(sy.status, 200);

  const followups = await waitForFollowups(c, 3);
  const f = followups.find(x => x.event_type === 'ab_synced');
  assert.ok(f, 'sync follow-up arrived');
  assert.match(f.summary, /A scores 50, B scores 5/);
});
