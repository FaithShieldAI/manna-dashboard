'use strict';
/**
 * Sites API — mirrors the shape of the existing D2RM tracker endpoints
 * (GET /api/stats?site=KEY&days=30, /api/realtime?site=KEY,
 *  /api/breakdown?site=KEY&days=30) so the current dashboard frontend can
 * point at this backend with only an API_BASE change.
 *
 * Phase 2:
 *  - POST /api/sites — create a project/site (plan project-limit enforced)
 *  - GET /api/sites/:key/realtime — REAL: active_now from recent site_events
 *  - GET /api/sites/:key/stream — Server-Sent Events live feed
 *  - Public beacon: POST /api/collect/:siteKey (defined in server.js,
 *    keyed by per-site collect_key) feeds site_events -> realtime/SSE.
 */
const express = require('express');
const crypto = require('crypto');
const { getPlan } = require('../lib/plans');

const router = express.Router();

const SITE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function getSiteOr404(tdb, siteKey, res) {
  const site = tdb.getSite(siteKey);
  if (!site) {
    res.status(404).json({ ok: false, error: 'site_not_found' });
    return null;
  }
  return site;
}

// Distinct visitors seen in the last N minutes (the "active now" signal).
function activeNow(tenantId, siteId, minutes = 5) {
  const { db } = require('../db');
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const row = db.prepare(`
    SELECT COUNT(DISTINCT session_key) AS n
    FROM site_events
    WHERE tenant_id = ? AND site_id = ? AND occurred_at >= ? AND session_key IS NOT NULL
  `).get(tenantId, siteId, since);
  return row ? row.n : 0;
}

function recentEvents(tenantId, siteId, limit = 20) {
  const { db } = require('../db');
  return db.prepare(`
    SELECT event_name, occurred_at, session_key
    FROM site_events
    WHERE tenant_id = ? AND site_id = ?
    ORDER BY occurred_at DESC LIMIT ?
  `).all(tenantId, siteId, limit);
}

router.get('/', (req, res) => {
  res.json({ ok: true, sites: req.tdb.listSites() });
});

// POST /api/sites — create a project. Enforces the plan's project limit.
router.post('/', (req, res) => {
  const plan = getPlan(req.tenant.plan) || getPlan('starter');
  const used = req.tdb.countSites();
  if (plan.projects != null && used >= plan.projects) {
    return res.status(403).json({
      ok: false,
      error: 'project_limit_reached',
      plan: plan.key,
      limit: plan.projects,
      used,
      note: 'Upgrade your plan to add more projects.',
    });
  }

  const { siteKey, name, url, emoji } = req.body || {};
  const key = typeof siteKey === 'string' ? siteKey.trim().toLowerCase() : '';
  if (!SITE_KEY_RE.test(key)) {
    return res.status(400).json({ ok: false, error: 'invalid_site_key' });
  }
  if (!name || typeof name !== 'string' || name.trim().length < 2 || name.length > 120) {
    return res.status(400).json({ ok: false, error: 'invalid_site_name' });
  }
  if (req.tdb.getSite(key)) {
    return res.status(409).json({ ok: false, error: 'site_key_taken' });
  }

  const collectKey = crypto.randomBytes(24).toString('hex');
  try {
    const r = req.tdb.createSite({
      siteKey: key,
      name: name.trim(),
      url: typeof url === 'string' ? url.trim().slice(0, 500) : null,
      emoji: typeof emoji === 'string' ? emoji.trim().slice(0, 8) : null,
      collectKey,
    });
    res.status(201).json({
      ok: true,
      site: req.tdb.getSite(key),
      // Show once: the beacon key for this site's tracking snippet.
      collect_key: collectKey,
      site_id: Number(r.lastInsertRowid),
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[sites/create]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// GET /api/sites/:key/stats?days=30
router.get('/:key/stats', (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const site = getSiteOr404(req.tdb, req.params.key, res);
  if (!site) return;

  const rows = req.tdb.siteMetrics(site.id, days);
  const sum = rows.reduce((a, r) => ({
    visitors: a.visitors + r.visitors,
    pageviews: a.pageviews + r.pageviews,
  }), { visitors: 0, pageviews: 0 });

  // Prior-period comparison: split the window in half.
  const half = Math.ceil(days / 2);
  const cur = rows.slice(0, half).reduce((a, r) => a + r.visitors, 0);
  const prev = rows.slice(half).reduce((a, r) => a + r.visitors, 0);
  const changePct = prev > 0 ? +(((cur - prev) / prev) * 100).toFixed(1) : null;

  const latest = rows[0] || {};
  res.json({
    ok: true,
    site: site.site_key,
    days,
    metrics: {
      visitors: { value: sum.visitors, change_pct: changePct },
      views: { value: sum.pageviews, change_pct: null },
      bounce_rate: { value: latest.bounce_rate ?? null, change_pct: null },
      avg_duration_s: { value: latest.avg_duration_s ?? null, change_pct: null },
    },
    daily: rows,
  });
});

// GET /api/sites/:key/realtime — REAL (Phase 2): derived from site_events.
router.get('/:key/realtime', (req, res) => {
  const site = getSiteOr404(req.tdb, req.params.key, res);
  if (!site) return;
  const n = activeNow(req.tenant.id, site.id, 5);
  res.json({
    ok: true,
    site: site.site_key,
    active_now: n,
    window_minutes: 5,
    recent_events: recentEvents(req.tenant.id, site.id, 10),
  });
});

// GET /api/sites/:key/stream — Server-Sent Events live feed.
// Emits { active_now, recent } every 5s + heartbeat comments.
router.get('/:key/stream', (req, res) => {
  const site = getSiteOr404(req.tdb, req.params.key, res);
  if (!site) return;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx buffering if proxied
  });
  res.write(': connected\n\n');

  let closed = false;
  req.on('close', () => { closed = true; clearInterval(timer); });

  const push = () => {
    if (closed) return;
    try {
      const payload = JSON.stringify({
        site: site.site_key,
        active_now: activeNow(req.tenant.id, site.id, 5),
        recent: recentEvents(req.tenant.id, site.id, 5),
        at: new Date().toISOString(),
      });
      res.write(`event: tick\ndata: ${payload}\n\n`);
    } catch (e) { /* client gone */ }
  };
  const timer = setInterval(push, 5000);
  timer.unref();
  push();
});

// GET /api/sites/:key/breakdown?days=30 — event counts per event_name.
router.get('/:key/breakdown', (req, res) => {
  const site = getSiteOr404(req.tdb, req.params.key, res);
  if (!site) return;
  const { db } = require('../db');
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const events = db.prepare(`
    SELECT event_name AS label, COUNT(*) AS count
    FROM site_events
    WHERE tenant_id = ? AND site_id = ? AND occurred_at >= ?
    GROUP BY event_name ORDER BY count DESC`).all(req.tenant.id, site.id, since);
  res.json({
    ok: true,
    site: site.site_key,
    events,
    countries: [],
    referrers: [],
    utm_sources: [],
    utm_campaigns: [],
    devices: [],
  });
});

module.exports = router;
module.exports.activeNow = activeNow;
