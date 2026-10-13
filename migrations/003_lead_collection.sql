-- D2RM Dashboard SaaS — Migration 003: lead collection module
--
-- Turnkey lead collection: tenants run collection jobs (YouTube keyword
-- search, seed-URL email extraction) whose results feed the tenant's
-- influencers table (status='unvetted') — the dashboard's email list.
--
-- 1. collection_jobs: one row per collection run, tenant-scoped.
-- 2. influencers.source: provenance ('lead-collect:youtube', etc.).

PRAGMA foreign_keys = ON;

CREATE TABLE collection_jobs (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source           TEXT NOT NULL CHECK (source IN ('youtube', 'weblist')),
  keywords_json    TEXT NOT NULL DEFAULT '[]',  -- ["fitness coach", ...]
  seeds_json       TEXT NOT NULL DEFAULT '[]',  -- ["https://...", ...]
  max_results      INTEGER NOT NULL DEFAULT 25 CHECK (max_results BETWEEN 1 AND 100),
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','done','failed','canceled')),
  found_count      INTEGER NOT NULL DEFAULT 0,  -- total leads found
  new_count        INTEGER NOT NULL DEFAULT 0,  -- deduped new leads inserted
  error            TEXT,
  started_at       TEXT,
  finished_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_collection_jobs_tenant ON collection_jobs(tenant_id, created_at DESC);

ALTER TABLE influencers ADD COLUMN source TEXT;
