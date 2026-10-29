-- Migration 023: Scribe draft artifacts (act-layer).
--
-- Scribe (Manna's AI co-pilot, Muse Spark via the Meta Model API) turns
-- approved-shaped recommendations into DRAFT artifacts inside Manna:
-- drafted video briefs, drafted social posts, drafted email campaigns.
-- A draft in this table is NEVER a send and NEVER a post — it is a row a
-- human reviews and approves (status 'approved') or dismisses in the UI.
-- Sending/posting flows (existing email + social routes) stay exactly as
-- they are; nothing reads this table to send anything.
--
-- payload_json holds the full structured recommendation the draft was
-- created from (including the observations/metrics it cited), so every
-- draft is traceable back to the numbers that produced it (full
-- attribution). source distinguishes live Scribe output ('scribe') from
-- stub-mode sample output ('scribe-stub') created while SPARK_API_KEY
-- was unset.
--
-- Times are UTC ISO-8601 strings, matching the rest of the schema.

CREATE TABLE IF NOT EXISTS scribe_drafts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  draft_type   TEXT NOT NULL CHECK (draft_type IN ('video_brief','social_post','email_campaign')),
  title        TEXT NOT NULL,
  body         TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  source       TEXT NOT NULL DEFAULT 'scribe' CHECK (source IN ('scribe','scribe-stub')),
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','dismissed')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_scribe_drafts_tenant
  ON scribe_drafts (tenant_id, status, id DESC);
