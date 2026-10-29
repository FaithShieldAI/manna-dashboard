-- Migration 026: video generation jobs (HeyGen wiring, 2026-10-25).
--
-- Manna's video feature goes live: a tenant submits a script + an
-- avatar/voice choice from the server-defined catalogue, the server
-- creates a provider job (HeyGen, standard engine), and the finished
-- video URL is stored back here against the tenant.
--
-- One row per generation request. Rows are tenant-scoped like every
-- other table; routes only ever reach them through forTenant() helpers.
--
-- Allowance accounting counts rows whose status is NOT 'failed'
-- (queued / processing / completed): a provider failure never consumed
-- a render, so it must never consume the tenant's allowance either.
--   trial tenants : 5 videos TOTAL (Michael, 2026-10-25)
--   heavy10/heavy30: 10 / 30 per calendar month (src/lib/plans.js)
--
-- provider_job_id is internal bookkeeping for status polling and is
-- never exposed to clients. avatar_key / voice_key are the stable
-- server-catalogue keys the user picked — provider ids are resolved
-- server-side at creation time and never stored or sent to the client.
--
-- Times are UTC ISO-8601 strings, matching the rest of the schema.

CREATE TABLE IF NOT EXISTS video_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  script          TEXT NOT NULL,
  avatar_key      TEXT NOT NULL,
  voice_key       TEXT NOT NULL,
  engine          TEXT NOT NULL DEFAULT 'standard',
  provider        TEXT NOT NULL DEFAULT 'heygen',
  provider_job_id TEXT,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','processing','completed','failed')),
  video_url       TEXT,
  duration_s      REAL,
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_video_jobs_tenant
  ON video_jobs (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_jobs_tenant_status
  ON video_jobs (tenant_id, status);
