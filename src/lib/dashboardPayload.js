'use strict';
/**
 * Dashboard payload: the private D2RM dashboard's per-tab panel HTML,
 * computed on the analytics VM by the same builder that bakes the
 * static page (build_live_dashboard.py) and pushed here every
 * ~10 minutes by the mail-truth chain (publish_dashboard_payload.py).
 * The static page fetches it at view time and swaps each tab panel's
 * contents, falling back to its baked panels when the fetch fails, so
 * a failed git push can no longer stale the page.
 *
 * Read rule (Michael, 2026-11-05: no surface may present stored data
 * as live): the payload carries its own generated_at (the build's
 * compute time). Read paths serve it with that stamp and the page
 * displays it, so staleness is visible, never hidden. FRESH_MS is set
 * against the chain's 10-minute cadence: a payload received more than
 * 25 minutes ago means the chain has missed cycles.
 */
const { db } = require('../db');

const FRESH_MS = 25 * 60 * 1000;

function storeDashboardPayload(tenantId, payload) {
  const receivedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO dashboard_payloads (tenant_id, payload_json, received_at)
    VALUES (?, ?, ?)
    ON CONFLICT (tenant_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      received_at = excluded.received_at
  `).run(tenantId, JSON.stringify(payload), receivedAt);
  return receivedAt;
}

/** -> { payload, received_at, fresh } | null (never throws on bad JSON). */
function readDashboardPayload(tenantId) {
  let row;
  try {
    row = db.prepare(
      'SELECT payload_json, received_at FROM dashboard_payloads WHERE tenant_id = ?'
    ).get(tenantId);
  } catch (e) {
    return null; // table absent (pre-migration-036 DB): treat as no payload
  }
  if (!row) return null;
  let payload;
  try { payload = JSON.parse(row.payload_json); } catch (e) { return null; }
  if (!payload || typeof payload !== 'object' || !payload.sections) return null;
  const age = Date.now() - Date.parse(row.received_at);
  return { payload, received_at: row.received_at, fresh: Number.isFinite(age) && age <= FRESH_MS };
}

module.exports = { FRESH_MS, storeDashboardPayload, readDashboardPayload };
