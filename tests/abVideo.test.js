'use strict';
/**
 * A/B does both (Michael, 2026-10-31): the engagement A/B board must run
 * video tests (variants = two social postings, scoreboard synced from the
 * postings) alongside the original email template tests.
 */
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
    companyName: 'AB Co', email, password: 'ab-secret-pw-12345',
  });
  assert.equal(r.status, 201, 'register failed: ' + JSON.stringify(r.json));
  return c;
}

async function logPost(c, url, metrics) {
  const r = await c.post('/api/engagement/social', {
    platform: 'instagram', post_url: url, ...(metrics || {}),
  });
  assert.equal(r.status, 201, 'log post failed: ' + JSON.stringify(r.json));
  return r.json.posting;
}

test('video A/B test: create, sync pulls the scoreboard from the postings', async () => {
  const c = await registeredClient('ab-video@example.org');
  const pa = await logPost(c, 'https://instagram.com/reel/AAA', { clicks: 10, likes: 40, shares: 5, comments: 3 });
  const pb = await logPost(c, 'https://instagram.com/reel/BBB', { clicks: 4, likes: 12, shares: 1, comments: 2 });

  const cr = await c.post('/api/engagement/ab', {
    name: 'Parents hook test', kind: 'video',
    variant_a_post_id: pa.id, variant_b_post_id: pb.id,
  });
  assert.equal(cr.status, 201, 'create failed: ' + JSON.stringify(cr.json));
  const t = cr.json.test;
  assert.equal(t.kind, 'video');
  assert.equal(t.variant_a_post.platform, 'instagram');
  assert.equal(t.variant_b_post.id, pb.id);
  assert.deepEqual(t.scores, { a: 0, b: 0 });

  const sy = await c.post(`/api/engagement/ab/${t.id}/sync`, {});
  assert.equal(sy.status, 200, 'sync failed: ' + JSON.stringify(sy.json));
  assert.equal(sy.json.test.status, 'running');
  assert.equal(sy.json.test.clicks_a, 10);
  assert.equal(sy.json.test.likes_a, 40);
  assert.equal(sy.json.test.clicks_b, 4);
  // score = clicks*3 + likes + shares + comments
  assert.equal(sy.json.test.scores.a, 10 * 3 + 40 + 5 + 3);
  assert.equal(sy.json.test.scores.b, 4 * 3 + 12 + 1 + 2);
  assert.equal(sy.json.auto_winner, null);

  // manual winner still works for video tests
  const w = await c.post(`/api/engagement/ab/${t.id}/winner`, { variant: 'a' });
  assert.equal(w.status, 200);
  assert.equal(w.json.test.winner, 'a');
  assert.equal(w.json.test.status, 'done');

  // a done test refuses further syncs
  const sy2 = await c.post(`/api/engagement/ab/${t.id}/sync`, {});
  assert.equal(sy2.status, 400);
  assert.equal(sy2.json.error, 'test_already_done');
});

test('video A/B test: validation (same post twice, foreign post, bad kind)', async () => {
  const c = await registeredClient('ab-valid@example.org');
  const other = await registeredClient('ab-other@example.org');
  const mine = await logPost(c, 'https://instagram.com/reel/MINE', {});
  const foreign = await logPost(other, 'https://instagram.com/reel/FOREIGN', {});

  const same = await c.post('/api/engagement/ab', {
    name: 'Same', kind: 'video', variant_a_post_id: mine.id, variant_b_post_id: mine.id,
  });
  assert.equal(same.status, 400);
  assert.equal(same.json.error, 'invalid_variant_posts');

  const cross = await c.post('/api/engagement/ab', {
    name: 'Cross', kind: 'video', variant_a_post_id: mine.id, variant_b_post_id: foreign.id,
  });
  assert.equal(cross.status, 400);
  assert.equal(cross.json.error, 'invalid_variant_posts');

  const badKind = await c.post('/api/engagement/ab', { name: 'Nope', kind: 'smoke-signals' });
  assert.equal(badKind.status, 400);
  assert.equal(badKind.json.error, 'invalid_kind');

  // tenant isolation: the other tenant sees none of my tests and cannot sync them
  const list = await other.get('/api/engagement/ab');
  assert.equal(list.json.tests.length, 0);
});

test('video auto-apply crowns the winner on sync once both sides have 25+ engagements', async () => {
  const c = await registeredClient('ab-auto@example.org');
  const pa = await logPost(c, 'https://instagram.com/reel/WIN', { clicks: 20, likes: 10, shares: 0, comments: 0 }); // total 30, score 70
  const pb = await logPost(c, 'https://instagram.com/reel/LOSE', { clicks: 2, likes: 20, shares: 3, comments: 1 }); // total 26, score 30

  const cr = await c.post('/api/engagement/ab', {
    name: 'Auto test', kind: 'video', variant_a_post_id: pa.id, variant_b_post_id: pb.id,
  });
  assert.equal(cr.status, 201);
  const id = cr.json.test.id;

  const ap = await c.patch(`/api/engagement/ab/${id}/auto-apply`, { auto_apply: true });
  assert.equal(ap.status, 200, 'auto-apply patch failed: ' + JSON.stringify(ap.json));

  const sy = await c.post(`/api/engagement/ab/${id}/sync`, {});
  assert.equal(sy.status, 200);
  assert.equal(sy.json.auto_winner, 'a');
  assert.equal(sy.json.test.winner, 'a');
  assert.equal(sy.json.test.status, 'done');
});

test('kind guards: /results refuses video tests, /sync refuses email tests', async () => {
  const c = await registeredClient('ab-guards@example.org');
  const pa = await logPost(c, 'https://instagram.com/reel/G1', {});
  const pb = await logPost(c, 'https://instagram.com/reel/G2', {});
  const v = await c.post('/api/engagement/ab', {
    name: 'V', kind: 'video', variant_a_post_id: pa.id, variant_b_post_id: pb.id,
  });
  const res = await c.post(`/api/engagement/ab/${v.json.test.id}/results`, { clicks_a: 5 });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'video_tests_use_sync');

  const e = await c.post('/api/engagement/ab', {
    name: 'E', variant_a_template: 'welcome-a', variant_b_template: 'welcome-b', split_pct: 50,
  });
  assert.equal(e.status, 201);
  assert.equal(e.json.test.kind, 'email');
  const sy = await c.post(`/api/engagement/ab/${e.json.test.id}/sync`, {});
  assert.equal(sy.status, 400);
  assert.equal(sy.json.error, 'not_a_video_test');
});

test('email A/B flow unchanged (create + results + rates)', async () => {
  const c = await registeredClient('ab-email@example.org');
  const cr = await c.post('/api/engagement/ab', {
    name: 'Subject lines', variant_a_template: 'subj-a', variant_b_template: 'subj-b', split_pct: 60,
  });
  assert.equal(cr.status, 201);
  const id = cr.json.test.id;
  const r = await c.post(`/api/engagement/ab/${id}/results`, {
    sent_a: 200, sent_b: 200, opens_a: 80, opens_b: 60, clicks_a: 30, clicks_b: 12,
  });
  assert.equal(r.status, 200, 'results failed: ' + JSON.stringify(r.json));
  assert.equal(r.json.test.status, 'running');
  assert.equal(r.json.rates.a.click_rate, 15);
  assert.equal(r.json.rates.b.click_rate, 6);
});
