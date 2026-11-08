-- D2RM Dashboard SaaS — Migration 036: dashboard payload store
--
-- The private D2RM dashboard's tab panels are computed on the analytics
-- VM by the same builder that bakes the static page
-- (build_live_dashboard.py) and pushed here every ~10 minutes by
-- POST /api/auth/dashboard-payload-sync/:token (mail-truth chain step,
-- publish_dashboard_payload.py; see src/lib/dashboardPayload.js). One
-- row per tenant: the full payload ({generated_at, sections}) plus when
-- it was received. The static page fetches the payload at view time via
-- GET /api/auth/dashboard-payload and swaps each panel's contents,
-- falling back to its baked panels when the fetch fails; the payload's
-- generated_at is displayed on the page, so staleness is visible.

CREATE TABLE IF NOT EXISTS dashboard_payloads (
  tenant_id INTEGER PRIMARY KEY,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
