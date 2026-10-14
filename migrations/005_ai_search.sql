-- D2RM Dashboard SaaS — Migration 005: AI search lead source
--
-- Adds the Origami-style AI lead finder ("AV integrators in Texas") as a
-- third collection_jobs source, plus query_text to store the raw
-- plain-English query. SQLite cannot ALTER a CHECK constraint, so the
-- table is recreated and existing rows are copied over.

PRAGMA foreign_keys = OFF;

CREATE TABLE collection_jobs_new (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source           TEXT NOT NULL CHECK (source IN ('youtube', 'weblist', 'aisearch')),
  keywords_json    TEXT NOT NULL DEFAULT '[]',
  seeds_json       TEXT NOT NULL DEFAULT '[]',
  query_text       TEXT,
  max_results      INTEGER NOT NULL DEFAULT 25 CHECK (max_results BETWEEN 1 AND 100),
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','done','failed','canceled')),
  found_count      INTEGER NOT NULL DEFAULT 0,
  new_count        INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  started_at       TEXT,
  finished_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO collection_jobs_new
  (id, tenant_id, source, keywords_json, seeds_json, max_results,
   status, found_count, new_count, error, started_at, finished_at, created_at)
SELECT
  id, tenant_id, source, keywords_json, seeds_json, max_results,
  status, found_count, new_count, error, started_at, finished_at, created_at
FROM collection_jobs;

DROP TABLE collection_jobs;
ALTER TABLE collection_jobs_new RENAME TO collection_jobs;
CREATE INDEX idx_collection_jobs_tenant ON collection_jobs(tenant_id, created_at DESC);

PRAGMA foreign_keys = ON;
