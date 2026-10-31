'use strict';
/**
 * Engagement API — Star of the Day, A/B testing, social posting tracking.
 *
 * GET  /api/engagement/star            (today's star: computed + snapshotted)
 * POST /api/engagement/star/:id/adapt  {name?} (duplicate the winning
 *                                       campaign as a new draft for the
 *                                       user to edit)
 * POST /api/engagement/ab              {name, variant_a_template,
 *                                       variant_b_template, split_pct}
 *                                       A/B tests do BOTH kinds (Michael,
 *                                       2026-10-31): kind 'email' (default,
 *                                       template variants, as above) or
 *                                       kind 'video' {name, kind: 'video',
 *                                       variant_a_post_id,
 *                                       variant_b_post_id} — the variants
 *                                       are two social_postings rows.
 * GET  /api/engagement/ab
 * POST /api/engagement/ab/:id/winner   {variant: 'a'|'b'}
 * POST /api/engagement/ab/:id/results {sent_a, sent_b, opens_a, opens_b,
 *                                       clicks_a, clicks_b} (auto-declares
 *                                       winner when auto_apply is on;
 *                                       email tests only)
 * POST /api/engagement/ab/:id/sync     (video tests only: pulls clicks,
 *                                       likes, shares, comments from the
 *                                       two linked postings into the
 *                                       scoreboard; auto-declares winner
 *                                       when auto_apply is on)
 * PATCH /api/engagement/ab/:id/auto-apply {auto_apply: bool}
 * POST /api/engagement/social          {platform, post_url, content_item_id?,
 *                                       posted_at?, likes?, shares?,
 *                                       comments?, clicks?}
 * GET  /api/engagement/social
 * PUT  /api/engagement/social/:id/metrics {likes, shares, comments, clicks}
 *
 * Everything is tenant-scoped via req.tenant.id (never db-wide).
 * Mounted by the coordinator (server.js) — do NOT self-mount here.
 */
const express = require('express');
const { db } = require('../db');
const { fireFollowup } = require('../lib/scribeFollowup');

// The loop (Michael, 2026-10-31): every recorded move below fires a
// Scribe follow-up — analysis, dictated next move, prepared drafts,
// and the operator's ask. Fire-and-forget: it never blocks or breaks
// the move itself.
function followup(req, event) {
  if (req.tdb) void fireFollowup(req.tdb, req.tenant.id, event);
}

const router = express.Router();

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

const CAMPAIGN_COLS = 'id, name, provider, product, language, audience, template_key, target_description, sent, opens, clicks, unsubs, bounces, sent_at';

function campaignById(t, id) {
  return db.prepare(
    `SELECT ${CAMPAIGN_COLS} FROM email_campaigns WHERE tenant_id = ? AND id = ?`
  ).get(t, id);
}

// --- Star of the Day -------------------------------------------------------

router.get('/star', (req, res) => {
  const t = req.tenant.id;
  const date = todayKey();
  let star = db.prepare(
    'SELECT id, date, campaign_id, score, created_at FROM star_of_day WHERE tenant_id = ? AND date = ?'
  ).get(t, date);
  if (!star) {
    // Score = clicks*3 + opens (Michael's engagement weighting); only
    // campaigns that actually sent anything qualify.
    const best = db.prepare(
      `SELECT ${CAMPAIGN_COLS} FROM email_campaigns
       WHERE tenant_id = ? AND sent > 0
       ORDER BY (clicks * 3 + opens) DESC, id DESC LIMIT 1`
    ).get(t);
    if (!best) {
      return res.json({ ok: true, star: null, reason: 'no_campaigns_with_sends' });
    }
    const score = (best.clicks || 0) * 3 + (best.opens || 0);
    const r = db.prepare(
      'INSERT INTO star_of_day (tenant_id, date, campaign_id, score) VALUES (?, ?, ?, ?)'
    ).run(t, date, best.id, score);
    star = {
      id: Number(r.lastInsertRowid),
      date,
      campaign_id: best.id,
      score,
      created_at: new Date().toISOString(),
      campaign: best,
    };
    return res.json({ ok: true, star, computed: true });
  }
  star.campaign = campaignById(t, star.campaign_id);
  res.json({ ok: true, star, computed: false });
});

// POST /star/:id/adapt {name?} — duplicate-and-adapt: copies the star's
// campaign row as a NEW draft (zeroed counters, no sent_at) so the user
// edits it before sending. (Michael 2026-10-16: user EDITS before send.)
router.post('/star/:id/adapt', (req, res) => {
  const t = req.tenant.id;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ ok: false, error: 'invalid_id' });
  }
  const star = db.prepare(
    'SELECT campaign_id FROM star_of_day WHERE tenant_id = ? AND id = ?'
  ).get(t, id);
  if (!star || !star.campaign_id) {
    return res.status(404).json({ ok: false, error: 'star_not_found' });
  }
  const src = db.prepare(
    `SELECT name, provider, product, language, audience, template_key, target_description
     FROM email_campaigns WHERE tenant_id = ? AND id = ?`
  ).get(t, star.campaign_id);
  if (!src) {
    return res.status(404).json({ ok: false, error: 'campaign_not_found' });
  }
  const name = String((req.body && req.body.name) || '').trim().slice(0, 120);
  const newName = name || `${String(src.name || '').slice(0, 108)} (adapted)`;
  const r = db.prepare(
    `INSERT INTO email_campaigns
       (tenant_id, name, provider, product, language, audience, template_key, target_description,
        sent, opens, clicks, unsubs, bounces, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, NULL)`
  ).run(t, newName, src.provider, src.product, src.language, src.audience,
    src.template_key, src.target_description);
  res.status(201).json({ ok: true, campaign: campaignById(t, Number(r.lastInsertRowid)) });
});

// --- A/B testing ------------------------------------------------------------
// Two kinds, one board (Michael, 2026-10-31): 'email' tests compare two
// email templates (results entered via /results); 'video' tests compare
// two logged social posts (scoreboard pulled from the postings via /sync).

function getTest(t, id) {
  return db.prepare('SELECT * FROM ab_tests WHERE tenant_id = ? AND id = ?').get(t, id);
}

// Video score: Michael's engagement weighting (Star of the Day: clicks*3)
// extended with the other public engagement counts.
function videoScore(test, side) {
  return test['clicks_' + side] * 3 + test['likes_' + side] +
    test['shares_' + side] + test['comments_' + side];
}

function decorate(t, test) {
  if (!test || test.kind !== 'video') return test;
  const post = (pid) => pid == null ? null : db.prepare(
    `SELECT id, platform, post_url, content_item_id, posted_at
     FROM social_postings WHERE tenant_id = ? AND id = ?`
  ).get(t, pid) || null;
  return {
    ...test,
    variant_a_post: post(test.variant_a_post_id),
    variant_b_post: post(test.variant_b_post_id),
    scores: { a: videoScore(test, 'a'), b: videoScore(test, 'b') },
  };
}

router.post('/ab', (req, res) => {
  const t = req.tenant.id;
  const body = req.body || {};
  const { name, variant_a_template, variant_b_template, split_pct } = body;
  const n = String(name || '').trim();
  if (n.length < 1 || n.length > 120) {
    return res.status(400).json({ ok: false, error: 'invalid_name' });
  }
  const kind = String(body.kind || 'email').trim().toLowerCase();
  if (kind !== 'email' && kind !== 'video') {
    return res.status(400).json({ ok: false, error: 'invalid_kind' });
  }
  const split = Math.min(Math.max(parseInt(split_pct, 10) || 50, 1), 99);
  if (kind === 'video') {
    const pa = parseInt(body.variant_a_post_id, 10);
    const pb = parseInt(body.variant_b_post_id, 10);
    if (!Number.isInteger(pa) || pa < 1 || !Number.isInteger(pb) || pb < 1 || pa === pb) {
      return res.status(400).json({ ok: false, error: 'invalid_variant_posts' });
    }
    // Both variants must be this tenant's own logged posts (attribution).
    for (const pid of [pa, pb]) {
      const p = db.prepare('SELECT id FROM social_postings WHERE tenant_id = ? AND id = ?').get(t, pid);
      if (!p) {
        return res.status(400).json({ ok: false, error: 'invalid_variant_posts' });
      }
    }
    const r = db.prepare(
      `INSERT INTO ab_tests (tenant_id, name, kind, variant_a_post_id, variant_b_post_id, split_pct, status)
       VALUES (?, ?, 'video', ?, ?, ?, 'draft')`
    ).run(t, n, pa, pb, split);
    return res.status(201).json({ ok: true, test: decorate(t, getTest(t, Number(r.lastInsertRowid))) });
  }
  const r = db.prepare(
    `INSERT INTO ab_tests (tenant_id, name, variant_a_template, variant_b_template, split_pct, status)
     VALUES (?, ?, ?, ?, ?, 'draft')`
  ).run(t, n,
    String(variant_a_template || '').slice(0, 80) || null,
    String(variant_b_template || '').slice(0, 80) || null,
    split);
  res.status(201).json({
    ok: true,
    test: getTest(t, Number(r.lastInsertRowid)),
  });
});

router.get('/ab', (req, res) => {
  const t = req.tenant.id;
  const tests = db.prepare(
    'SELECT * FROM ab_tests WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100'
  ).all(t);
  res.json({ ok: true, tests: tests.map((x) => decorate(t, x)) });
});

// POST /ab/:id/sync — video tests only. Copies the two linked postings'
// current metrics into the scoreboard. With auto_apply on, the winner is
// declared once BOTH posts have at least 25 total engagements
// (clicks+likes+shares+comments) and the scores differ.
router.post('/ab/:id/sync', (req, res) => {
  const t = req.tenant.id;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ ok: false, error: 'invalid_id' });
  }
  const test = getTest(t, id);
  if (!test) {
    return res.status(404).json({ ok: false, error: 'test_not_found' });
  }
  if (test.kind !== 'video') {
    return res.status(400).json({ ok: false, error: 'not_a_video_test' });
  }
  if (test.status === 'done') {
    return res.status(400).json({ ok: false, error: 'test_already_done' });
  }
  const post = (pid) => pid == null ? null : db.prepare(
    'SELECT * FROM social_postings WHERE tenant_id = ? AND id = ?'
  ).get(t, pid);
  const pa = post(test.variant_a_post_id);
  const pb = post(test.variant_b_post_id);
  if (!pa || !pb) {
    return res.status(400).json({ ok: false, error: 'variant_post_missing' });
  }
  db.prepare(
    `UPDATE ab_tests
     SET clicks_a = ?, likes_a = ?, shares_a = ?, comments_a = ?,
         clicks_b = ?, likes_b = ?, shares_b = ?, comments_b = ?,
         status = CASE WHEN status = 'draft' THEN 'running' ELSE status END
     WHERE tenant_id = ? AND id = ?`
  ).run(pa.clicks, pa.likes, pa.shares, pa.comments,
        pb.clicks, pb.likes, pb.shares, pb.comments, t, id);

  let autoWinner = null;
  const updated = getTest(t, id);
  if (updated.auto_apply) {
    const total = (x, s) => x['clicks_' + s] + x['likes_' + s] + x['shares_' + s] + x['comments_' + s];
    const sa = videoScore(updated, 'a');
    const sb = videoScore(updated, 'b');
    if (total(updated, 'a') >= 25 && total(updated, 'b') >= 25 && sa !== sb) {
      autoWinner = sa > sb ? 'a' : 'b';
      db.prepare(
        `UPDATE ab_tests SET winner = ?, status = 'done', decided_at = ?
         WHERE tenant_id = ? AND id = ?`
      ).run(autoWinner, new Date().toISOString(), t, id);
    }
  }
  const synced = getTest(t, id);
  followup(req, {
    type: 'ab_synced',
    ref: String(id),
    summary: `Video A/B "${test.name}" synced from its postings: A scores ${videoScore(synced, 'a')}, B scores ${videoScore(synced, 'b')}` +
      (autoWinner ? ` — auto-crowned: variant ${autoWinner.toUpperCase()}.` : '.'),
    direction: null,
  });
  res.json({ ok: true, test: decorate(t, synced), auto_winner: autoWinner });
});

router.post('/ab/:id/winner', (req, res) => {
  const t = req.tenant.id;
  const id = parseInt(req.params.id, 10);
  const variant = String((req.body && req.body.variant) || '').trim().toLowerCase();
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ ok: false, error: 'invalid_id' });
  }
  if (variant !== 'a' && variant !== 'b') {
    return res.status(400).json({ ok: false, error: 'invalid_variant' });
  }
  const test = db.prepare('SELECT id, name FROM ab_tests WHERE tenant_id = ? AND id = ?').get(t, id);
  if (!test) {
    return res.status(404).json({ ok: false, error: 'test_not_found' });
  }
  db.prepare(
    `UPDATE ab_tests SET winner = ?, status = 'done', decided_at = ?
     WHERE tenant_id = ? AND id = ?`
  ).run(variant, new Date().toISOString(), t, id);
  followup(req, {
    type: 'ab_decided',
    ref: String(id),
    summary: `A/B test "${test.name}" decided: variant ${variant.toUpperCase()} won.`,
    direction: null,
  });
  res.json({
    ok: true,
    test: decorate(t, getTest(t, id)),
  });
});

// POST /ab/:id/results {sent_a, sent_b, opens_a, opens_b, clicks_a, clicks_b}
// Records per-variant performance. When auto_apply is on and one variant has
// a strictly better click rate with >= 100 sends per side, the winner is
// declared automatically (status -> done).
function nonNegInt(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

router.post('/ab/:id/results', (req, res) => {
  const t = req.tenant.id;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ ok: false, error: 'invalid_id' });
  }
  const test = db.prepare('SELECT * FROM ab_tests WHERE tenant_id = ? AND id = ?').get(t, id);
  if (!test) {
    return res.status(404).json({ ok: false, error: 'test_not_found' });
  }
  if (test.status === 'done') {
    return res.status(400).json({ ok: false, error: 'test_already_done' });
  }
  if (test.kind === 'video') {
    return res.status(400).json({ ok: false, error: 'video_tests_use_sync' });
  }
  const b = req.body || {};
  const vals = {
    sent_a: nonNegInt(b.sent_a), sent_b: nonNegInt(b.sent_b),
    opens_a: nonNegInt(b.opens_a), opens_b: nonNegInt(b.opens_b),
    clicks_a: nonNegInt(b.clicks_a), clicks_b: nonNegInt(b.clicks_b),
  };
  db.prepare(
    `UPDATE ab_tests
     SET sent_a = ?, sent_b = ?, opens_a = ?, opens_b = ?, clicks_a = ?, clicks_b = ?,
         status = CASE WHEN status = 'draft' THEN 'running' ELSE status END
     WHERE tenant_id = ? AND id = ?`
  ).run(vals.sent_a, vals.sent_b, vals.opens_a, vals.opens_b, vals.clicks_a, vals.clicks_b, t, id);

  // Auto-apply: click-rate winner with a minimum sample.
  let autoWinner = null;
  if (test.auto_apply) {
    const rateA = vals.sent_a >= 100 ? vals.clicks_a / vals.sent_a : -1;
    const rateB = vals.sent_b >= 100 ? vals.clicks_b / vals.sent_b : -1;
    if (rateA >= 0 && rateB >= 0 && rateA !== rateB) {
      autoWinner = rateA > rateB ? 'a' : 'b';
      db.prepare(
        `UPDATE ab_tests SET winner = ?, status = 'done', decided_at = ?
         WHERE tenant_id = ? AND id = ?`
      ).run(autoWinner, new Date().toISOString(), t, id);
    }
  }
  const updated = db.prepare('SELECT * FROM ab_tests WHERE tenant_id = ? AND id = ?').get(t, id);
  const rate = (c, s) => (s > 0 ? +(100 * c / s).toFixed(2) : 0);
  followup(req, {
    type: 'ab_results',
    ref: String(id),
    summary: `Email A/B "${test.name}": results in. Click rates: A ${rate(updated.clicks_a, updated.sent_a)}%, B ${rate(updated.clicks_b, updated.sent_b)}%` +
      (autoWinner ? ` — auto-crowned: variant ${autoWinner.toUpperCase()}.` : '.'),
    direction: null,
  });
  res.json({
    ok: true,
    test: updated,
    auto_winner: autoWinner,
    rates: {
      a: { sent: updated.sent_a, open_rate: rate(updated.opens_a, updated.sent_a), click_rate: rate(updated.clicks_a, updated.sent_a) },
      b: { sent: updated.sent_b, open_rate: rate(updated.opens_b, updated.sent_b), click_rate: rate(updated.clicks_b, updated.sent_b) },
    },
  });
});

// PATCH /ab/:id/auto-apply {auto_apply: true|false}
router.patch('/ab/:id/auto-apply', (req, res) => {
  const t = req.tenant.id;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ ok: false, error: 'invalid_id' });
  }
  const test = db.prepare('SELECT id FROM ab_tests WHERE tenant_id = ? AND id = ?').get(t, id);
  if (!test) {
    return res.status(404).json({ ok: false, error: 'test_not_found' });
  }
  const flag = req.body && req.body.auto_apply ? 1 : 0;
  db.prepare('UPDATE ab_tests SET auto_apply = ? WHERE tenant_id = ? AND id = ?').run(flag, t, id);
  res.json({ ok: true, test: decorate(t, getTest(t, id)) });
});

// --- Social posting tracking ------------------------------------------------

const PLATFORMS = ['instagram', 'facebook', 'x', 'linkedin', 'tiktok', 'telegram', 'rumble', 'truthsocial'];

function toNonNegInt(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

router.post('/social', (req, res) => {
  const t = req.tenant.id;
  const { platform, post_url, content_item_id, posted_at, likes, shares, comments, clicks } = req.body || {};
  const p = String(platform || '').trim().toLowerCase();
  if (!PLATFORMS.includes(p)) {
    return res.status(400).json({ ok: false, error: 'invalid_platform' });
  }
  const url = String(post_url || '').trim();
  if (!/^https?:\/\//i.test(url) || url.length > 2000) {
    return res.status(400).json({ ok: false, error: 'invalid_post_url' });
  }
  let cid = null;
  if (content_item_id !== undefined && content_item_id !== null && content_item_id !== '') {
    cid = parseInt(content_item_id, 10);
    if (!Number.isInteger(cid) || cid < 1) {
      return res.status(400).json({ ok: false, error: 'invalid_content_item' });
    }
    // The linked content item must belong to this tenant (attribution).
    const item = db.prepare('SELECT id FROM content_items WHERE tenant_id = ? AND id = ?').get(t, cid);
    if (!item) {
      return res.status(400).json({ ok: false, error: 'invalid_content_item' });
    }
  }
  let posted = new Date().toISOString();
  if (posted_at !== undefined && posted_at !== null && String(posted_at).trim() !== '') {
    const d = new Date(String(posted_at));
    if (Number.isNaN(d.getTime())) {
      return res.status(400).json({ ok: false, error: 'invalid_posted_at' });
    }
    posted = d.toISOString();
  }
  const r = db.prepare(
    `INSERT INTO social_postings
       (tenant_id, platform, post_url, content_item_id, posted_at, likes, shares, comments, clicks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(t, p, url, cid, posted,
    toNonNegInt(likes), toNonNegInt(shares), toNonNegInt(comments), toNonNegInt(clicks));
  followup(req, {
    type: 'posting_logged',
    ref: String(r.lastInsertRowid),
    summary: `New ${p} posting logged: ${url}` + (cid ? ' (linked to a library film)' : ''),
    direction: null,
  });
  res.status(201).json({
    ok: true,
    posting: db.prepare('SELECT * FROM social_postings WHERE tenant_id = ? AND id = ?').get(t, r.lastInsertRowid),
  });
});

router.get('/social', (req, res) => {
  const t = req.tenant.id;
  const { platform } = req.query;
  let sql = `SELECT s.*, c.title AS content_title
             FROM social_postings s LEFT JOIN content_items c ON c.id = s.content_item_id
             WHERE s.tenant_id = ?`;
  const params = [t];
  if (platform) {
    const p = String(platform).trim().toLowerCase();
    if (!PLATFORMS.includes(p)) {
      return res.status(400).json({ ok: false, error: 'invalid_platform' });
    }
    sql += ' AND s.platform = ?';
    params.push(p);
  }
  sql += ' ORDER BY s.posted_at DESC LIMIT 200';
  res.json({ ok: true, postings: db.prepare(sql).all(...params) });
});

router.put('/social/:id/metrics', (req, res) => {
  const t = req.tenant.id;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ ok: false, error: 'invalid_id' });
  }
  const posting = db.prepare('SELECT id, platform, likes, shares, comments, clicks FROM social_postings WHERE tenant_id = ? AND id = ?').get(t, id);
  if (!posting) {
    return res.status(404).json({ ok: false, error: 'posting_not_found' });
  }
  const { likes, shares, comments, clicks } = req.body || {};
  db.prepare(
    `UPDATE social_postings
     SET likes = ?, shares = ?, comments = ?, clicks = ?
     WHERE tenant_id = ? AND id = ?`
  ).run(toNonNegInt(likes), toNonNegInt(shares), toNonNegInt(comments), toNonNegInt(clicks), t, id);
  const beforeTotal = posting.likes + posting.shares + posting.comments + posting.clicks;
  const afterTotal = toNonNegInt(likes) + toNonNegInt(shares) + toNonNegInt(comments) + toNonNegInt(clicks);
  const dir = afterTotal > beforeTotal ? 'up' : afterTotal < beforeTotal ? 'down' : 'flat';
  followup(req, {
    type: 'metrics_updated',
    ref: String(id),
    summary: `${posting.platform} posting: audience reaction moved ${dir} — total engagement ${beforeTotal} to ${afterTotal} (likes, shares, comments, clicks).`,
    direction: dir,
  });
  res.json({
    ok: true,
    posting: db.prepare('SELECT * FROM social_postings WHERE tenant_id = ? AND id = ?').get(t, id),
  });
});

module.exports = router;
