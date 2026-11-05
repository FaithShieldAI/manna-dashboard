'use strict';
/**
 * Live windows: the house tenant's outgoing-mail windows, computed on
 * the analytics VM from fresh pipe pulls (see live_compute.py /
 * live_windows.py in the funnels goal's email_analytics folder) and
 * pushed here every ~60s. The payload is the private dashboard
 * builder's EMAIL_WINDOWS shape plus { as_of, sources }.
 *
 * Read rule (Michael, 2026-11-05: no surface may present stored
 * snapshots as live): a payload counts as live only while it is
 * FRESH (received within FRESH_MS). Read paths must label what they
 * served — source 'live' with the payload's as_of, or 'snapshot' for
 * the email_snapshots fallback — never blur the two.
 */
const { db } = require('../db');

const FRESH_MS = 180 * 1000;
const WINDOW_KEYS = ['24h', '7d', '30d', 'all'];

function storeLiveWindows(tenantId, payload) {
  const receivedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO live_windows (tenant_id, payload_json, received_at)
    VALUES (?, ?, ?)
    ON CONFLICT (tenant_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      received_at = excluded.received_at
  `).run(tenantId, JSON.stringify(payload), receivedAt);
  return receivedAt;
}

/** -> { payload, received_at, fresh } | null (never throws on bad JSON). */
function readLiveWindows(tenantId) {
  let row;
  try {
    row = db.prepare(
      'SELECT payload_json, received_at FROM live_windows WHERE tenant_id = ?'
    ).get(tenantId);
  } catch (e) {
    return null; // table absent (pre-migration-035 DB): treat as no live data
  }
  if (!row) return null;
  let payload;
  try { payload = JSON.parse(row.payload_json); } catch (e) { return null; }
  if (!payload || typeof payload !== 'object' || !payload.windows) return null;
  const age = Date.now() - Date.parse(row.received_at);
  return { payload, received_at: row.received_at, fresh: Number.isFinite(age) && age <= FRESH_MS };
}

/** Map the builder-shaped payload to the GET /api/email/windows shape. */
function shapeForEmailRoute(payload) {
  const out = {};
  for (const key of WINDOW_KEYS) {
    const w = (payload.windows || {})[key];
    if (!w) continue;
    out[key] = {
      sent: w.sent || 0, opens: w.opens || 0, clicks: w.clicks || 0,
      unsubs: w.unsub || 0, opt_outs: w.unsub || 0,
      bounces: w.bounces || 0, replies: w.replies || 0,
      open_rate: w.open_rate || 0, click_rate: w.click_rate || 0,
      optout_rate: w.optout_rate || 0,
      reply_rate: w.sent > 0 ? +(100 * (w.replies || 0) / w.sent).toFixed(2) : 0,
      warm: w.warm || { total: 0, by_lang: {} },
      captured_at: payload.as_of || null,
    };
  }
  return out;
}

module.exports = { FRESH_MS, WINDOW_KEYS, storeLiveWindows, readLiveWindows, shapeForEmailRoute };
