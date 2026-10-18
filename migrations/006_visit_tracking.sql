-- D2RM Dashboard SaaS — Migration 006: visit + signup tracking
--
-- Adds first-party visit tracking so we know what landing pages work and
-- can attribute signups to visits. IPs are SHA256-hashed, never stored raw.
-- Also raises collection_jobs.max_results cap from 100 to 1000.

-- Raw visit log (one row per page view; bots and static assets excluded by middleware)
CREATE TABLE IF NOT EXISTS site_visits (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  path             TEXT NOT NULL,
  referrer         TEXT,
  user_agent       TEXT,
  ip_hash          TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_visits_day ON site_visits(date(created_at));
CREATE INDEX IF NOT EXISTS idx_visits_session ON site_visits(session_id);
CREATE INDEX IF NOT EXISTS idx_visits_path ON site_visits(path);

-- Signup attribution (links the new account back to its visit session)
CREATE TABLE IF NOT EXISTS signup_events (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id       TEXT,
  landing_path     TEXT,
  referrer         TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_signups_day ON signup_events(date(created_at));

-- Raise lead collection cap 100 -> 1000 (SQLite cannot ALTER a CHECK constraint)
PRAGMA foreign_keys = OFF;

CREATE TABLE collection_jobs_new (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source           TEXT NOT NULL CHECK (source IN ('youtube', 'weblist', 'aisearch')),
  keywords_json    TEXT NOT NULL DEFAULT '[]',
  seeds_json       TEXT NOT NULL DEFAULT '[]',
  query_text       TEXT,
  max_results      INTEGER NOT NULL DEFAULT 25 CHECK (max_results BETWEEN 1 AND 1000),
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
  (id, tenant_id, source, keywords_json, seeds_json, query_text, max_results,
   status, found_count, new_count, error, started_at, finished_at, created_at)
SELECT
  id, tenant_id, source, keywords_json, seeds_json, query_text, max_results,
  status, found_count, new_count, error, started_at, finished_at, created_at
FROM collection_jobs;

DROP TABLE collection_jobs;
ALTER TABLE collection_jobs_new RENAME TO collection_jobs;

PRAGMA foreign_keys = ON;
