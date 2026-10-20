'use strict';
/**
 * Growth suite API — the 10 dashboard sections as Manna product features.
 *
 *   Goals:            POST/GET /api/growth/goals, PATCH/DELETE /api/growth/goals/:id
 *   Podcast outreach: GET/POST /api/growth/podcasts/outreach, PATCH /:id
 *   DM log:           GET/POST /api/growth/dm-log, PATCH /:id/reply
 *   Sender health:    GET /api/growth/sender-health
 *   Financials:       GET /api/growth/financials, POST /revenue, POST /costs
 *   Intake:           GET/POST /api/growth/intake
 *   Video postings:   GET/POST /api/growth/videos, PATCH /:id/metrics
 *
 * Everything is tenant-scoped via req.tenant.id (never db-wide).
 * Mounted by server.js — do NOT self-mount here.
 */
const express = require('express');
const { db } = require('../db');

const router = express.Router();

function nowIso() {
  return new Date().toISOString();
}
function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}
function toNonNegInt(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}
function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

// ---------------------------------------------------------------------------
// Goals — user-defined goals with deadlines (90-day scoreboard).
// ---------------------------------------------------------------------------

const GOAL_STATUSES = ['active', 'paused', 'done', 'archived'];

router.get('/goals', (req, res) => {
  const t = req.tenant.id;
  const rows = db.prepare(
    `SELECT * FROM goals WHERE tenant_id = ? ORDER BY
     CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
     deadline_at IS NULL, deadline_at ASC`
  ).all(t);
  res.json({
    ok: true,
    goals: rows.map(g => ({
      id: g.id,
      key: g.goal_key,
      label: g.label,
      current: g.current_value,
      goal: g.goal_value,
      unit: g.unit,
      deadline: g.deadline_at,
      notes: g.notes,
      status: g.status,
      pct: g.goal_value > 0 ? +(100 * g.current_value / g.goal_value).toFixed(1) : 0,
      days_left: g.deadline_at
        ? Math.max(0, Math.ceil((Date.parse(g.deadline_at) - Date.now()) / 86400000))
        : null,
    })),
  });
});

router.post('/goals', (req, res) => {
  const t = req.tenant.id;
  const { key, label, goal_value, unit, deadline_at, notes } = req.body || {};
  const k = String(key || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
  const l = String(label || '').trim();
  const gv = parseInt(goal_value, 10);
  if (!k || l.length < 2 || l.length > 120 || !Number.isInteger(gv) || gv < 1) {
    return res.status(400).json({ ok: false, error: 'invalid_goal' });
  }
  if (deadline_at && !isIsoDate(deadline_at)) {
    return res.status(400).json({ ok: false, error: 'invalid_deadline' });
  }
  try {
    const r = db.prepare(
      `INSERT INTO goals (tenant_id, goal_key, label, goal_value, unit, deadline_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(t, k, l, gv, String(unit || '').slice(0, 40) || null,
      deadline_at || null, String(notes || '').slice(0, 500) || null);
    const g = db.prepare('SELECT * FROM goals WHERE tenant_id = ? AND id = ?').get(t, r.lastInsertRowid);
    res.status(201).json({ ok: true, goal: g });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ ok: false, error: 'duplicate_key' });
    }
    throw e;
  }
});

router.patch('/goals/:id', (req, res) => {
  const t = req.tenant.id;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const g = db.prepare('SELECT id FROM goals WHERE tenant_id = ? AND id = ?').get(t, id);
  if (!g) return res.status(404).json({ ok: false, error: 'goal_not_found' });
  const sets = [], vals = [];
  const { current_value, status, deadline_at, notes, label } = req.body || {};
  if (current_value !== undefined) {
    const cv = parseInt(current_value, 10);
    if (!Number.isInteger(cv) || cv < 0) return res.status(400).json({ ok: false, error: 'invalid_current' });
    sets.push('current_value = ?'); vals.push(cv);
  }
  if (status !== undefined) {
    if (!GOAL_STATUSES.includes(status)) return res.status(400).json({ ok: false, error: 'invalid_status' });
    sets.push('status = ?'); vals.push(status);
  }
  if (deadline_at !== undefined) {
    if (deadline_at !== null && !isIsoDate(deadline_at)) return res.status(400).json({ ok: false, error: 'invalid_deadline' });
    sets.push('deadline_at = ?'); vals.push(deadline_at);
  }
  if (notes !== undefined) { sets.push('notes = ?'); vals.push(String(notes).slice(0, 500) || null); }
  if (label !== undefined) {
    const l = String(label).trim();
    if (l.length < 2 || l.length > 120) return res.status(400).json({ ok: false, error: 'invalid_label' });
    sets.push('label = ?'); vals.push(l);
  }
  if (!sets.length) return res.status(400).json({ ok: false, error: 'nothing_to_update' });
  vals.push(t, id);
  db.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`).run(...vals);
  res.json({ ok: true, goal: db.prepare('SELECT * FROM goals WHERE tenant_id = ? AND id = ?').get(t, id) });
});

// ---------------------------------------------------------------------------
// Podcast outreach — guest-pitch workflow on influencers(category='podcast').
// ---------------------------------------------------------------------------

const PITCH_STATUSES = ['identified', 'pitched', 'responded', 'booked', 'recorded', 'aired', 'declined'];

router.get('/podcasts/outreach', (req, res) => {
  const t = req.tenant.id;
  const rows = db.prepare(
    `SELECT po.*, i.handle, i.email, i.platform, i.notes AS influencer_notes
     FROM podcast_outreach po
     JOIN influencers i ON i.id = po.influencer_id
     WHERE po.tenant_id = ?
     ORDER BY po.created_at DESC LIMIT 200`
  ).all(t);
  res.json({ ok: true, outreach: rows });
});

router.post('/podcasts/outreach', (req, res) => {
  const t = req.tenant.id;
  const { influencer_id, pitch_status, notes } = req.body || {};
  const iid = parseInt(influencer_id, 10);
  if (!Number.isInteger(iid) || iid < 1) return res.status(400).json({ ok: false, error: 'invalid_influencer' });
  const inf = db.prepare(
    `SELECT id FROM influencers WHERE tenant_id = ? AND id = ? AND category = 'podcast'`
  ).get(t, iid);
  if (!inf) return res.status(404).json({ ok: false, error: 'podcast_not_found' });
  const ps = PITCH_STATUSES.includes(pitch_status) ? pitch_status : 'identified';
  try {
    const r = db.prepare(
      `INSERT INTO podcast_outreach (tenant_id, influencer_id, pitch_status, notes)
       VALUES (?, ?, ?, ?)`
    ).run(t, iid, ps, String(notes || '').slice(0, 500) || null);
    res.status(201).json({
      ok: true,
      outreach: db.prepare('SELECT * FROM podcast_outreach WHERE tenant_id = ? AND id = ?').get(t, r.lastInsertRowid),
    });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ ok: false, error: 'already_tracked' });
    }
    throw e;
  }
});

router.patch('/podcasts/outreach/:id', (req, res) => {
  const t = req.tenant.id;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const row = db.prepare('SELECT * FROM podcast_outreach WHERE tenant_id = ? AND id = ?').get(t, id);
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  const sets = [], vals = [];
  const { pitch_status, episode_url, notes } = req.body || {};
  if (pitch_status !== undefined) {
    if (!PITCH_STATUSES.includes(pitch_status)) return res.status(400).json({ ok: false, error: 'invalid_status' });
    sets.push('pitch_status = ?'); vals.push(pitch_status);
    // auto-stamp lifecycle dates on forward transitions
    if (pitch_status === 'pitched' && !row.pitched_at) { sets.push('pitched_at = ?'); vals.push(nowIso()); }
    if (pitch_status === 'responded' && !row.responded_at) { sets.push('responded_at = ?'); vals.push(nowIso()); }
    if (pitch_status === 'booked' && !row.booked_at) { sets.push('booked_at = ?'); vals.push(nowIso()); }
  }
  if (episode_url !== undefined) { sets.push('episode_url = ?'); vals.push(String(episode_url).slice(0, 500) || null); }
  if (notes !== undefined) { sets.push('notes = ?'); vals.push(String(notes).slice(0, 500) || null); }
  if (!sets.length) return res.status(400).json({ ok: false, error: 'nothing_to_update' });
  vals.push(t, id);
  db.prepare(`UPDATE podcast_outreach SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`).run(...vals);
  res.json({ ok: true, outreach: db.prepare('SELECT * FROM podcast_outreach WHERE tenant_id = ? AND id = ?').get(t, id) });
});

// ---------------------------------------------------------------------------
// DM log — manual DM tracking.
// ---------------------------------------------------------------------------

const DM_PLATFORMS = ['instagram', 'x', 'tiktok', 'facebook', 'linkedin', 'truthsocial', 'telegram'];

router.get('/dm-log', (req, res) => {
  const t = req.tenant.id;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const rows = db.prepare(
    'SELECT * FROM dm_log WHERE tenant_id = ? ORDER BY sent_at DESC LIMIT ?'
  ).all(t, limit);
  const stats = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN replied = 1 THEN 1 ELSE 0 END) AS replied_count
     FROM dm_log WHERE tenant_id = ?`
  ).get(t);
  res.json({
    ok: true,
    log: rows,
    stats: {
      total: stats.total || 0,
      replied: stats.replied_count || 0,
      reply_rate: stats.total ? +((100 * (stats.replied_count || 0)) / stats.total).toFixed(1) : 0,
    },
  });
});

router.post('/dm-log', (req, res) => {
  const t = req.tenant.id;
  const { handle, platform, script_used, notes, sent_at } = req.body || {};
  const h = String(handle || '').trim().replace(/^@/, '').slice(0, 80);
  if (!h) return res.status(400).json({ ok: false, error: 'invalid_handle' });
  const p = DM_PLATFORMS.includes(platform) ? platform : 'instagram';
  const r = db.prepare(
    `INSERT INTO dm_log (tenant_id, handle, platform, sent_at, script_used, notes)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(t, h, p,
    (typeof sent_at === 'string' && sent_at) || nowIso(),
    String(script_used || '').slice(0, 200) || null,
    String(notes || '').slice(0, 500) || null);
  res.status(201).json({
    ok: true,
    entry: db.prepare('SELECT * FROM dm_log WHERE tenant_id = ? AND id = ?').get(t, r.lastInsertRowid),
  });
});

router.patch('/dm-log/:id/reply', (req, res) => {
  const t = req.tenant.id;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const row = db.prepare('SELECT id FROM dm_log WHERE tenant_id = ? AND id = ?').get(t, id);
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  const { notes } = req.body || {};
  db.prepare(
    `UPDATE dm_log SET replied = 1, replied_at = ?, notes = COALESCE(?, notes)
     WHERE tenant_id = ? AND id = ?`
  ).run(nowIso(), notes ? String(notes).slice(0, 500) : null, t, id);
  res.json({ ok: true, entry: db.prepare('SELECT * FROM dm_log WHERE tenant_id = ? AND id = ?').get(t, id) });
});

// ---------------------------------------------------------------------------
// Sender health — per-campaign unsubscribe/complaint/bounce rates + thresholds.
// Thresholds: complaint > 0.1% = warn, > 0.3% = critical; unsub > 1% = warn.
// ---------------------------------------------------------------------------

router.get('/sender-health', (req, res) => {
  const t = req.tenant.id;
  const rows = db.prepare(
    `SELECT id, name, provider, sent, opens, clicks, unsubs, bounces, complaints, sent_at
     FROM email_campaigns WHERE tenant_id = ? ORDER BY sent_at DESC LIMIT 100`
  ).all(t);
  const campaigns = rows.map(c => {
    const sent = c.sent || 0;
    const rate = v => sent > 0 ? +(100 * v / sent).toFixed(2) : 0;
    const unsubRate = rate(c.unsubs), complaintRate = rate(c.complaints), bounceRate = rate(c.bounces);
    let health = 'ok';
    if (complaintRate > 0.3 || unsubRate > 2 || bounceRate > 5) health = 'critical';
    else if (complaintRate > 0.1 || unsubRate > 1 || bounceRate > 2) health = 'warn';
    return {
      id: c.id, name: c.name, provider: c.provider, sent,
      opens: c.opens, clicks: c.clicks,
      unsubs: c.unsubs, bounces: c.bounces, complaints: c.complaints,
      unsub_rate: unsubRate, complaint_rate: complaintRate, bounce_rate: bounceRate,
      health, sent_at: c.sent_at,
    };
  });
  const totals = rows.reduce((a, c) => ({
    sent: a.sent + (c.sent || 0),
    unsubs: a.unsubs + (c.unsubs || 0),
    bounces: a.bounces + (c.bounces || 0),
    complaints: a.complaints + (c.complaints || 0),
  }), { sent: 0, unsubs: 0, bounces: 0, complaints: 0 });
  res.json({ ok: true, campaigns, totals });
});

// ---------------------------------------------------------------------------
// Financials — revenue + cost ledgers, MRR, monthly P&L.
// ---------------------------------------------------------------------------

const REVENUE_SOURCES = ['faithshield', 'manna', 'sustained', 'armor_bearer', 'other'];
const REVENUE_KINDS = ['mrr', 'one_time', 'refund'];
const COST_CATEGORIES = ['saas', 'ads', 'email', 'infra', 'other'];

router.get('/financials', (req, res) => {
  const t = req.tenant.id;
  const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month)
    ? req.query.month : todayKey().slice(0, 7);
  const rev = db.prepare(
    `SELECT source, kind, SUM(amount_cents) AS total
     FROM revenue_ledger WHERE tenant_id = ? AND substr(date, 1, 7) = ?
     GROUP BY source, kind`
  ).all(t, month);
  const costs = db.prepare(
    `SELECT category, SUM(amount_cents) AS total
     FROM cost_ledger WHERE tenant_id = ? AND substr(date, 1, 7) = ?
     GROUP BY category`
  ).all(t, month);
  const mrr = db.prepare(
    `SELECT source, SUM(amount_cents) AS total FROM revenue_ledger
     WHERE tenant_id = ? AND kind = 'mrr' GROUP BY source`
  ).all(t);
  const revTotal = rev.reduce((a, r) => a + (r.kind === 'refund' ? -(r.total || 0) : (r.total || 0)), 0);
  const costTotal = costs.reduce((a, c) => a + (c.total || 0), 0);
  res.json({
    ok: true,
    month,
    revenue: rev,
    costs,
    revenue_total_cents: revTotal,
    cost_total_cents: costTotal,
    profit_cents: revTotal - costTotal,
    mrr_by_source: mrr,
    mrr_total_cents: mrr.reduce((a, r) => a + (r.total || 0), 0),
  });
});

router.post('/financials/revenue', (req, res) => {
  const t = req.tenant.id;
  const { date, source, amount_cents, kind, note } = req.body || {};
  if (!isIsoDate(date)) return res.status(400).json({ ok: false, error: 'invalid_date' });
  if (!REVENUE_SOURCES.includes(source)) return res.status(400).json({ ok: false, error: 'invalid_source' });
  const amt = parseInt(amount_cents, 10);
  if (!Number.isInteger(amt) || amt < 0) return res.status(400).json({ ok: false, error: 'invalid_amount' });
  const k = REVENUE_KINDS.includes(kind) ? kind : 'mrr';
  const r = db.prepare(
    `INSERT INTO revenue_ledger (tenant_id, date, source, amount_cents, kind, note)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(t, date, source, amt, k, String(note || '').slice(0, 300) || null);
  res.status(201).json({
    ok: true,
    entry: db.prepare('SELECT * FROM revenue_ledger WHERE tenant_id = ? AND id = ?').get(t, r.lastInsertRowid),
  });
});

router.post('/financials/costs', (req, res) => {
  const t = req.tenant.id;
  const { date, category, amount_cents, note } = req.body || {};
  if (!isIsoDate(date)) return res.status(400).json({ ok: false, error: 'invalid_date' });
  if (!COST_CATEGORIES.includes(category)) return res.status(400).json({ ok: false, error: 'invalid_category' });
  const amt = parseInt(amount_cents, 10);
  if (!Number.isInteger(amt) || amt < 0) return res.status(400).json({ ok: false, error: 'invalid_amount' });
  const r = db.prepare(
    `INSERT INTO cost_ledger (tenant_id, date, category, amount_cents, note)
     VALUES (?, ?, ?, ?, ?)`
  ).run(t, date, category, amt, String(note || '').slice(0, 300) || null);
  res.status(201).json({
    ok: true,
    entry: db.prepare('SELECT * FROM cost_ledger WHERE tenant_id = ? AND id = ?').get(t, r.lastInsertRowid),
  });
});

// ---------------------------------------------------------------------------
// Intake — daily new leads per category with trends.
// ---------------------------------------------------------------------------

const INTAKE_CATEGORIES = ['influencer', 'pastor', 'church', 'podcast', 'attorney', 'handles', 'other'];

router.get('/intake', (req, res) => {
  const t = req.tenant.id;
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90);
  const rows = db.prepare(
    `SELECT date, category, new_count FROM intake_daily
     WHERE tenant_id = ? AND date >= date('now', ?)
     ORDER BY date ASC`
  ).all(t, `-${days} days`);
  const byDate = {};
  for (const r of rows) {
    (byDate[r.date] = byDate[r.date] || {})[r.category] = r.new_count;
  }
  const dates = Object.keys(byDate).sort();
  const totals = {};
  for (const r of rows) totals[r.category] = (totals[r.category] || 0) + r.new_count;
  const grand = Object.values(totals).reduce((a, b) => a + b, 0);
  res.json({
    ok: true,
    days,
    daily: dates.map(d => ({ date: d, categories: byDate[d], total: Object.values(byDate[d]).reduce((a, b) => a + b, 0) })),
    totals,
    grand_total: grand,
    avg_per_day: dates.length ? +(grand / dates.length).toFixed(1) : 0,
  });
});

router.post('/intake', (req, res) => {
  const t = req.tenant.id;
  const { date, category, new_count } = req.body || {};
  const d = isIsoDate(date) ? date : todayKey();
  if (!INTAKE_CATEGORIES.includes(category)) return res.status(400).json({ ok: false, error: 'invalid_category' });
  const n = toNonNegInt(new_count, null);
  if (n === null) return res.status(400).json({ ok: false, error: 'invalid_count' });
  db.prepare(
    `INSERT INTO intake_daily (tenant_id, date, category, new_count)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (tenant_id, date, category) DO UPDATE SET new_count = excluded.new_count`
  ).run(t, d, category, n);
  res.json({ ok: true, date: d, category, new_count: n });
});

// ---------------------------------------------------------------------------
// Video postings — "never throwing air again": log every video that goes out.
// ---------------------------------------------------------------------------

const VIDEO_PRODUCTS = ['armor_bearer', 'faithshield', 'manna', 'sustained', 'k_punk', 'other'];
const VIDEO_PLATFORMS = ['instagram', 'facebook', 'x', 'linkedin', 'tiktok', 'telegram', 'rumble', 'truthsocial', 'youtube'];

router.get('/videos', (req, res) => {
  const t = req.tenant.id;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const product = req.query.product;
  let sql = 'SELECT * FROM video_postings WHERE tenant_id = ?';
  const args = [t];
  if (product && VIDEO_PRODUCTS.includes(product)) { sql += ' AND product = ?'; args.push(product); }
  sql += ' ORDER BY posted_at DESC LIMIT ?';
  args.push(limit);
  const rows = db.prepare(sql).all(...args);
  const agg = db.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(views), 0) AS views,
            COALESCE(SUM(likes), 0) AS likes,
            COALESCE(SUM(comments), 0) AS comments,
            COALESCE(SUM(shares), 0) AS shares
     FROM video_postings WHERE tenant_id = ?`
  ).get(t);
  res.json({ ok: true, videos: rows, totals: agg });
});

router.post('/videos', (req, res) => {
  const t = req.tenant.id;
  const { video_name, product, platform, account_handle, post_url, posted_at, notes } = req.body || {};
  const vn = String(video_name || '').trim().slice(0, 200);
  if (!vn) return res.status(400).json({ ok: false, error: 'invalid_video_name' });
  if (!VIDEO_PRODUCTS.includes(product)) return res.status(400).json({ ok: false, error: 'invalid_product' });
  if (!VIDEO_PLATFORMS.includes(platform)) return res.status(400).json({ ok: false, error: 'invalid_platform' });
  const r = db.prepare(
    `INSERT INTO video_postings (tenant_id, video_name, product, platform, account_handle, post_url, posted_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(t, vn, product, platform,
    String(account_handle || '').replace(/^@/, '').slice(0, 80) || null,
    String(post_url || '').slice(0, 500) || null,
    (typeof posted_at === 'string' && posted_at) || nowIso(),
    String(notes || '').slice(0, 500) || null);
  res.status(201).json({
    ok: true,
    video: db.prepare('SELECT * FROM video_postings WHERE tenant_id = ? AND id = ?').get(t, r.lastInsertRowid),
  });
});

router.patch('/videos/:id/metrics', (req, res) => {
  const t = req.tenant.id;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const row = db.prepare('SELECT id FROM video_postings WHERE tenant_id = ? AND id = ?').get(t, id);
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  const { views, likes, comments, shares, post_url, notes } = req.body || {};
  const sets = [], vals = [];
  for (const [k, v] of [['views', views], ['likes', likes], ['comments', comments], ['shares', shares]]) {
    if (v !== undefined) { sets.push(`${k} = ?`); vals.push(toNonNegInt(v)); }
  }
  if (post_url !== undefined) { sets.push('post_url = ?'); vals.push(String(post_url).slice(0, 500) || null); }
  if (notes !== undefined) { sets.push('notes = ?'); vals.push(String(notes).slice(0, 500) || null); }
  if (!sets.length) return res.status(400).json({ ok: false, error: 'nothing_to_update' });
  vals.push(t, id);
  db.prepare(`UPDATE video_postings SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`).run(...vals);
  res.json({ ok: true, video: db.prepare('SELECT * FROM video_postings WHERE tenant_id = ? AND id = ?').get(t, id) });
});

module.exports = router;
