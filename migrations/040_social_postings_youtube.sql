-- Migration 040: add 'youtube' to the social_postings platform CHECK.
--
-- The 2026-11-18 Heavy 30 audit found Social Posting Tracking rejected
-- YouTube outright (400 invalid_platform): migration 015's platform
-- list mirrored the social tracking set of 2026-10-16, before the
-- house's films became YouTube-first. The house's primary video
-- platform could not even be logged manually.
--
-- SQLite cannot alter a CHECK in place: rebuild the table, copy rows,
-- swap names (pattern from migrations 016/020). ab_tests references
-- social_postings(id) (migration 029), so foreign keys are turned off
-- for the swap exactly as migration 016 did for tenants; row ids are
-- copied verbatim, so existing references stay valid.

PRAGMA foreign_keys = OFF;

CREATE TABLE social_postings_new (
  id              INTEGER PRIMARY KEY,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL CHECK (platform IN ('instagram','facebook','x','linkedin','tiktok','telegram','rumble','truthsocial','youtube')),
  post_url        TEXT NOT NULL,
  content_item_id INTEGER REFERENCES content_items(id) ON DELETE SET NULL,
  posted_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  likes           INTEGER NOT NULL DEFAULT 0 CHECK (likes >= 0),
  shares          INTEGER NOT NULL DEFAULT 0 CHECK (shares >= 0),
  comments        INTEGER NOT NULL DEFAULT 0 CHECK (comments >= 0),
  clicks          INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0)
);

INSERT INTO social_postings_new
  (id, tenant_id, platform, post_url, content_item_id, posted_at, likes, shares, comments, clicks)
SELECT id, tenant_id, platform, post_url, content_item_id, posted_at, likes, shares, comments, clicks
FROM social_postings;

DROP TABLE social_postings;
ALTER TABLE social_postings_new RENAME TO social_postings;

CREATE INDEX idx_social_tenant ON social_postings(tenant_id, posted_at DESC);
CREATE INDEX idx_social_platform ON social_postings(tenant_id, platform);

PRAGMA foreign_keys = ON;
