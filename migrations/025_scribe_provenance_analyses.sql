-- Migration 025: Scribe provenance, server-side analyses, draft audit.
--
-- F1 (provenance forgery fix): /analyze now stores its validated advice
-- SERVER-SIDE in scribe_analyses and returns only an opaque id; drafts
-- are created from the stored record, never from a client-supplied
-- advice object. The record carries the mode and TRANSPORT that produced
-- it, and the draft's source stamp derives from that server-side truth.
--
-- Transports: 'spark-api' (production Meta Model API client), 'stub'
-- (built-in no-key samples), 'substituted' (any injected/undeclared
-- client — test harnesses, substituted models). Stamps: spark-api ->
-- source 'scribe', stub -> 'scribe-stub', substituted ->
-- 'scribe-substituted' (new in this migration; 023's CHECK knew only
-- the first two, hence the table rebuild below).
--
-- F5: drafts gain decided_by / decided_at (who decided, when).
-- F6: drafts gain analysis_id, the idempotency + attribution key
-- (one analysis creates one set of drafts).
--
-- Times are UTC ISO-8601 strings, matching the rest of the schema.

CREATE TABLE IF NOT EXISTS scribe_analyses (
  id           TEXT PRIMARY KEY,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mode         TEXT NOT NULL CHECK (mode IN ('live','stub')),
  transport    TEXT NOT NULL CHECK (transport IN ('spark-api','stub','substituted')),
  advice_json  TEXT NOT NULL,
  signals_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scribe_analyses_tenant
  ON scribe_analyses (tenant_id, created_at DESC);

-- Rebuild scribe_drafts: widen the source CHECK, fail-safe the default,
-- add analysis_id + decision audit columns. SQLite cannot alter a CHECK
-- in place, so: copy into the new shape, swap, recreate indexes. Runs
-- inside the migration runner's transaction; existing rows keep their
-- ids, payloads, sources, statuses, and timestamps verbatim.
CREATE TABLE scribe_drafts_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  draft_type   TEXT NOT NULL CHECK (draft_type IN ('video_brief','social_post','email_campaign')),
  title        TEXT NOT NULL,
  body         TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  source       TEXT NOT NULL DEFAULT 'scribe-substituted' CHECK (source IN ('scribe','scribe-stub','scribe-substituted')),
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','dismissed')),
  analysis_id  TEXT,
  decided_by   INTEGER,
  decided_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO scribe_drafts_new
  (id, tenant_id, draft_type, title, body, payload_json, source, status, created_at, updated_at)
SELECT id, tenant_id, draft_type, title, body, payload_json, source, status, created_at, updated_at
FROM scribe_drafts;

DROP TABLE scribe_drafts;
ALTER TABLE scribe_drafts_new RENAME TO scribe_drafts;

CREATE INDEX IF NOT EXISTS idx_scribe_drafts_tenant
  ON scribe_drafts (tenant_id, status, id DESC);

CREATE INDEX IF NOT EXISTS idx_scribe_drafts_analysis
  ON scribe_drafts (tenant_id, analysis_id);
