-- Migration 037: family_office leads (Michael, 2026-11-08).
--
-- Michael directed family office investor lead collection to run
-- through MannaAi ("Use MannaAi to do this. Saves me approving cards
-- and gets us using MannaAi"), first pass: faith-based family offices
-- interested in faith tech. Two schema widenings make that collection
-- a first-class Manna flow instead of a side import:
--
--   1. influencers.category gains 'family_office', so collected
--      offices land in their own bucket in the tenant's lead list
--      (category counts, the vetted review queue, the category
--      filter), never mixed into the influencer pile.
--   2. collection_jobs.source gains 'family_office': Manna's web-list
--      collector run under a dedicated job source, so the run shows
--      on the tenant's Leads page as its own kind of job while the
--      leads carry category 'family_office' (see
--      POST /api/auth/lead-collect-sync/:token in src/routes/auth.js,
--      which runs the server's own collector and ingests the result).
--
-- SQLite cannot alter a CHECK in place: both tables are rebuilt.
-- influencers uses migration 022's rename-aside sequence verbatim
-- (podcast_outreach's FK hazard is documented there: a naive DROP
-- would cascade-delete its rows). collection_jobs has no FK
-- children, so it uses migration 005's plain rebuild.
-- Column sets below are the live tables exactly: influencers per
-- 022 (001 + source 003 + engagement counters 012/013) PLUS
-- external_id (027, the arsenal seed's idempotency key) — the live
-- table carries it and arsenalSeed.js queries it, so the rebuild
-- must carry it across or the arsenal seed breaks on every fresh
-- database (found by the suite on this migration's first run);
-- collection_jobs per 005 (003 + query_text).

-- ============================================================
-- 1. influencers: category CHECK gains 'family_office'
-- ============================================================

-- Orphan sweep (022, F-A1): a podcast_outreach row pointing at a
-- nonexistent influencer makes the copy step throw; sweep first.
DELETE FROM podcast_outreach
WHERE influencer_id NOT IN (SELECT id FROM influencers);

ALTER TABLE influencers RENAME TO influencers_old;

CREATE TABLE influencers (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  handle           TEXT,
  platform         TEXT, -- 'youtube' | 'instagram' | 'tiktok' | 'rumble' | ...
  email            TEXT,
  tier             TEXT CHECK (tier IS NULL OR tier IN ('nano','micro','macro','mega')),
  category         TEXT NOT NULL DEFAULT 'influencer'
                   CHECK (category IN ('influencer','podcast','pastor','church','attorney','individual','family_office')),
  status           TEXT NOT NULL DEFAULT 'unvetted'
                   CHECK (status IN ('unvetted','vetted','contacted','active','rejected')),
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source           TEXT,
  emails_sent      INTEGER NOT NULL DEFAULT 0,
  emails_opened    INTEGER NOT NULL DEFAULT 0,
  emails_clicked   INTEGER NOT NULL DEFAULT 0,
  last_emailed_at  TEXT,
  emails_queued    INTEGER NOT NULL DEFAULT 0,
  external_id      INTEGER
);

INSERT INTO influencers
  (id, tenant_id, handle, platform, email, tier, category, status, notes,
   created_at, source, emails_sent, emails_opened, emails_clicked,
   last_emailed_at, emails_queued, external_id)
SELECT id, tenant_id, handle, platform, email, tier, category, status, notes,
   created_at, source, emails_sent, emails_opened, emails_clicked,
   last_emailed_at, emails_queued, external_id
FROM influencers_old;

-- podcast_outreach: identical rebuild (017 definition verbatim, same
-- as 022) so its influencer_id FK points at the new influencers table.
CREATE TABLE podcast_outreach_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  influencer_id  INTEGER NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
  pitch_status   TEXT NOT NULL DEFAULT 'identified'
                 CHECK (pitch_status IN ('identified','pitched','responded','booked','recorded','aired','declined')),
  pitched_at     TEXT,
  responded_at   TEXT,
  booked_at      TEXT,
  episode_url    TEXT,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, influencer_id)
);

INSERT INTO podcast_outreach_new
  (id, tenant_id, influencer_id, pitch_status, pitched_at, responded_at,
   booked_at, episode_url, notes, created_at)
SELECT id, tenant_id, influencer_id, pitch_status, pitched_at, responded_at,
   booked_at, episode_url, notes, created_at
FROM podcast_outreach;

DROP TABLE podcast_outreach;
ALTER TABLE podcast_outreach_new RENAME TO podcast_outreach;

DROP TABLE influencers_old;

CREATE INDEX idx_influencers_tenant ON influencers(tenant_id, category, status);
CREATE UNIQUE INDEX idx_influencers_tenant_external
  ON influencers (tenant_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX idx_podcast_outreach_tenant ON podcast_outreach (tenant_id, pitch_status);

-- ============================================================
-- 2. collection_jobs: source CHECK gains 'family_office'
-- ============================================================

CREATE TABLE collection_jobs_new (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source           TEXT NOT NULL CHECK (source IN ('youtube', 'weblist', 'aisearch', 'family_office')),
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
  (id, tenant_id, source, keywords_json, seeds_json, query_text,
   max_results, status, found_count, new_count, error, started_at,
   finished_at, created_at)
SELECT id, tenant_id, source, keywords_json, seeds_json, query_text,
   max_results, status, found_count, new_count, error, started_at,
   finished_at, created_at
FROM collection_jobs;

DROP TABLE collection_jobs;
ALTER TABLE collection_jobs_new RENAME TO collection_jobs;
CREATE INDEX idx_collection_jobs_tenant ON collection_jobs(tenant_id, created_at DESC);

-- ============================================================
-- 3. pr_targets + pr_releases: category shelf gains 'family_office'
-- ============================================================
-- The connections list carries the faith-based family offices on
-- their own shelf ("Family Offices", src/lib/pr.js) until the
-- investor list gets a home of its own. pr_targets is a foreign-key
-- parent (pr_pitches.target_id), so this is migration 032's
-- rename-aside sequence: orphan pitches swept first, pr_pitches
-- rebuilt identically so its FK points at the new pr_targets.
-- pr_releases has no children: plain rebuild (its category column
-- came from 032's ADD COLUMN, so it is part of the table now).

DELETE FROM pr_pitches
WHERE target_id NOT IN (SELECT id FROM pr_targets);

ALTER TABLE pr_targets RENAME TO pr_targets_old;

CREATE TABLE pr_targets (
  id             INTEGER PRIMARY KEY,
  tenant_id      INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  publication    TEXT NOT NULL,
  contact_name   TEXT,
  role           TEXT,
  beat           TEXT,
  contact_route  TEXT,
  route_verified INTEGER NOT NULL DEFAULT 0 CHECK (route_verified IN (0, 1)),
  tier           TEXT NOT NULL DEFAULT 'niche' CHECK (tier IN ('faith_major', 'tech', 'niche')),
  category       TEXT NOT NULL DEFAULT 'faith_based' CHECK (category IN ('faith_based', 'mainstream', 'family_office')),
  fit_note       TEXT,
  source         TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'do_not_pitch')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO pr_targets
  (id, tenant_id, publication, contact_name, role, beat, contact_route,
   route_verified, tier, category, fit_note, source, status, created_at, updated_at)
SELECT id, tenant_id, publication, contact_name, role, beat, contact_route,
   route_verified, tier, category, fit_note, source, status, created_at, updated_at
FROM pr_targets_old;

CREATE TABLE pr_pitches_new (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target_id     INTEGER NOT NULL REFERENCES pr_targets(id) ON DELETE CASCADE,
  release_id    INTEGER REFERENCES pr_releases(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'drafted'
                CHECK (status IN ('drafted', 'approved', 'sent', 'replied', 'covered', 'declined', 'no_response')),
  sent_at       TEXT,
  reply_at      TEXT,
  follow_up_due TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO pr_pitches_new
  (id, tenant_id, target_id, release_id, status, sent_at, reply_at,
   follow_up_due, notes, created_at, updated_at)
SELECT id, tenant_id, target_id, release_id, status, sent_at, reply_at,
   follow_up_due, notes, created_at, updated_at
FROM pr_pitches;

DROP TABLE pr_pitches;
ALTER TABLE pr_pitches_new RENAME TO pr_pitches;

DROP TABLE pr_targets_old;

CREATE INDEX idx_pr_targets_tenant ON pr_targets(tenant_id, category, tier, id);
CREATE UNIQUE INDEX idx_pr_targets_dedup
  ON pr_targets(tenant_id, publication, ifnull(contact_name, ''));
CREATE INDEX idx_pr_pitches_tenant ON pr_pitches(tenant_id, status, id DESC);
CREATE INDEX idx_pr_pitches_target ON pr_pitches(target_id);

CREATE TABLE pr_releases_new (
  id           INTEGER PRIMARY KEY,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  subject_line TEXT,
  body         TEXT,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sent', 'archived')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  category     TEXT NOT NULL DEFAULT 'faith_based'
               CHECK (category IN ('faith_based', 'mainstream', 'family_office'))
);

INSERT INTO pr_releases_new
  (id, tenant_id, title, subject_line, body, status, created_at, updated_at, category)
SELECT id, tenant_id, title, subject_line, body, status, created_at, updated_at, category
FROM pr_releases;

DROP TABLE pr_releases;
ALTER TABLE pr_releases_new RENAME TO pr_releases;
CREATE INDEX idx_pr_releases_category ON pr_releases(tenant_id, category, id DESC);
