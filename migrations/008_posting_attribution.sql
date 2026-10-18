-- D2RM Dashboard SaaS — Migration 008: content posting attribution
--
-- Every video/ad posting (Facebook, Instagram, TikTok, YouTube, etc.)
-- traced to its content item and initial contact. Emails already link
-- via the sends table (contact_id); this covers everything else.

CREATE TABLE IF NOT EXISTS content_postings (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  content_id       INTEGER REFERENCES content_items(id) ON DELETE SET NULL,
  platform         TEXT NOT NULL,
  account_handle   TEXT,
  post_url         TEXT,
  contact_id       INTEGER,
  campaign_name    TEXT,
  posted_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  views            INTEGER,
  likes            INTEGER,
  comments         INTEGER,
  shares           INTEGER,
  clicks           INTEGER,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_postings_content ON content_postings(content_id);
CREATE INDEX IF NOT EXISTS idx_postings_platform ON content_postings(platform);
CREATE INDEX IF NOT EXISTS idx_postings_contact ON content_postings(contact_id);
CREATE INDEX IF NOT EXISTS idx_postings_day ON content_postings(date(posted_at));
