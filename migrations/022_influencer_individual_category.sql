-- Migration 022: add 'individual' to the influencers.category CHECK.
--
-- Migration 001 defined category IN
-- ('influencer','podcast','pastor','church','attorney') — no bucket for
-- unroled individuals. scripts/import-contacts.js therefore REJECTS every
-- source contact with category 'other' (1,129 held-back rows in
-- email-database.db at deploy-day dry-run). With 'individual' added, the
-- import maps other->individual and a re-run lands exactly those rows.
--
-- SQLite cannot alter a CHECK in place: rebuild the table (020 pattern).
-- Column set below is the live table exactly: 001 columns, + source (003),
-- + emails_sent/opened/clicked/last_emailed_at (012), + emails_queued (013).
--
-- FK HAZARD (why this is NOT the plain 020 create/copy/drop): the runner
-- (src/db.js) applies migrations inside a transaction on a connection with
-- PRAGMA foreign_keys = ON, and podcast_outreach (017) holds
-- influencer_id REFERENCES influencers(id) ON DELETE CASCADE. The naive
-- create/copy/DROP sequence does NOT error here — it is worse than that:
-- DROP TABLE influencers performs an implicit DELETE of the old table's
-- rows, the ON DELETE CASCADE fires, and every podcast_outreach child row
-- is SILENTLY DELETED along with its parent (verified empirically against
-- node:sqlite by red-team round 1, 2026-10-25). The true hazard is silent
-- child-data destruction, not a constraint error — which is why this
-- migration uses the rename-aside sequence below instead.
--
-- PRE-DEPLOY GATE (red-team round 1, F-A1): before running this migration
-- against any database that was restored from backup or otherwise
-- hand-touched, run `PRAGMA foreign_key_check;` against it first and
-- resolve every reported row. The orphan sweep below covers
-- podcast_outreach — the FK child this rebuild puts at risk; violations
-- in OTHER tables are outside this migration's scope and must be cleaned
-- up before boot, because a failed migration aborts server startup by
-- design (fail loud; never serve a half-migrated database).
--
-- Safe sequence used here:
--   1. RENAME the live table aside — SQLite rewrites podcast_outreach's
--      FK to reference the renamed table, so its rows stay valid.
--   2. CREATE the widened table under the original name; copy rows (ids
--      preserved, so podcast_outreach links remain correct).
--   3. Rebuild podcast_outreach identically (017 definition) so its FK
--      references the NEW influencers table; copy its rows across.
--   4. DROP the renamed old table — nothing references it any more.
-- Indexes: idx_influencers_tenant rides along with the renamed table and
-- is dropped with it, so it is recreated on the new table (same for
-- idx_podcast_outreach_tenant). Index creation comes AFTER the drops
-- because SQLite index names are database-global.
--
-- Idempotency: the runner records version 022 in schema_migrations and
-- applies this file exactly once; the rebuild itself preserves all rows
-- and converges to the same schema.

-- Orphan sweep (red-team round 1, F-A1): a podcast_outreach row whose
-- influencer_id points at a nonexistent influencer is garbage by
-- definition (e.g. left behind by a backup restore). Left in place, it
-- makes the copy step below throw FOREIGN KEY constraint failed; the
-- rollback is clean, but an uncaught migration failure at boot kills the
-- server process, so one junk row becomes a crash-loop. Sweep orphans
-- first — valid rows are untouched by this DELETE.
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
                   CHECK (category IN ('influencer','podcast','pastor','church','attorney','individual')),
  status           TEXT NOT NULL DEFAULT 'unvetted'
                   CHECK (status IN ('unvetted','vetted','contacted','active','rejected')),
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source           TEXT,
  emails_sent      INTEGER NOT NULL DEFAULT 0,
  emails_opened    INTEGER NOT NULL DEFAULT 0,
  emails_clicked   INTEGER NOT NULL DEFAULT 0,
  last_emailed_at  TEXT,
  emails_queued    INTEGER NOT NULL DEFAULT 0
);

INSERT INTO influencers
  (id, tenant_id, handle, platform, email, tier, category, status, notes,
   created_at, source, emails_sent, emails_opened, emails_clicked,
   last_emailed_at, emails_queued)
SELECT id, tenant_id, handle, platform, email, tier, category, status, notes,
   created_at, source, emails_sent, emails_opened, emails_clicked,
   last_emailed_at, emails_queued
FROM influencers_old;

-- podcast_outreach: identical rebuild (017 definition verbatim) so its
-- influencer_id FK points at the new influencers table.
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
CREATE INDEX idx_podcast_outreach_tenant ON podcast_outreach (tenant_id, pitch_status);
