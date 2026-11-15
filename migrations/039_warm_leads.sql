-- D2RM Dashboard SaaS — Migration 039: warm leads (per-recipient, by line)
--
-- The Warm Leads tab used to read only the email windows' warm fields
-- (email_snapshots.warm_total / warm_by_lang_json): a by-language count
-- of Kit clickers computed from a CSV that a later pull overwrote
-- empty in Oct 2026, so the tab showed "No warm clickers yet" while
-- real per-recipient engagement existed outside this app (the PR
-- tracking export and the preserved Kit per-subscriber records).
--
-- These tables hold the per-recipient warm list itself, segmented by
-- line, mirrored from the mail-truth chain (POST
-- /api/auth/warm-leads-sync, token-gated, replace-all per sync — the
-- chain stays the single source of truth and this app holds its copy,
-- same pattern as the IP registry mirror in migration-less tables
-- ip_assets). Warm = a person who opened or clicked; the chain ranks
-- each segment by clicks, then opens, then most recent activity, and
-- the read path preserves that order.
--
--   warm_lead_segments  — one row per line: label, source note, and
--                         the tracked count (people mailed, engaged
--                         or not) the warm count is read against.
--   warm_leads          — one row per warm person per segment.
--   warm_lead_sync_state— when the chain last computed the list, plus
--                         its note about lines with no per-recipient
--                         source yet (shown verbatim on the tab).

CREATE TABLE warm_lead_segments (
  tenant_id   INTEGER NOT NULL,
  segment_key TEXT NOT NULL,
  label       TEXT NOT NULL,
  note        TEXT,
  tracked     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, segment_key)
);

CREATE TABLE warm_leads (
  tenant_id     INTEGER NOT NULL,
  segment_key   TEXT NOT NULL,
  email         TEXT NOT NULL,
  name          TEXT,
  opens         INTEGER,
  clicks        INTEGER,
  last_activity TEXT,
  PRIMARY KEY (tenant_id, segment_key, email)
);

CREATE INDEX idx_warm_leads_tenant ON warm_leads (tenant_id, segment_key);

CREATE TABLE warm_lead_sync_state (
  tenant_id   INTEGER PRIMARY KEY,
  computed_at TEXT,
  unwired_note TEXT
);
