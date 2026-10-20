-- D2RM Dashboard SaaS — Migration 015: engagement backlog
--
-- Star of the Day (daily best-campaign snapshot), A/B tests, and social
-- posting tracking. Part of the Manna expansion (2026-10-16); built by
-- worker D on the feature/manna-tiers-automation branch (2026-10-20).
-- All tables tenant-scoped; rows belong to the tenant that created them.

-- ---------------------------------------------------------------------------
-- star_of_day: one snapshot per tenant per day — the best campaign so far.
-- score = clicks*3 + opens at snapshot time (campaign must have sent > 0).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS star_of_day (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  date        TEXT NOT NULL, -- YYYY-MM-DD (tenant-local calendar day)
  campaign_id INTEGER REFERENCES email_campaigns(id) ON DELETE SET NULL,
  score       REAL NOT NULL,  -- clicks*3 + opens at the time of the snapshot
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_star_tenant_date ON star_of_day(tenant_id, date);
CREATE INDEX IF NOT EXISTS idx_star_tenant ON star_of_day(tenant_id, date DESC);

-- ---------------------------------------------------------------------------
-- ab_tests: template A/B tests. Variant templates are email template keys;
-- split_pct is the % of the audience that gets variant A (1-99).
-- winner is 'a' or 'b' once declared (status moves draft->running->done).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ab_tests (
  id                 INTEGER PRIMARY KEY,
  tenant_id          INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  variant_a_template TEXT, -- email template_key for variant A
  variant_b_template TEXT, -- email template_key for variant B
  split_pct          INTEGER NOT NULL DEFAULT 50 CHECK (split_pct BETWEEN 1 AND 99),
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','done')),
  winner             TEXT CHECK (winner IS NULL OR winner IN ('a','b')),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ab_tenant ON ab_tests(tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- social_postings: log of social posts the tenant published (pasted links or
-- auto-posted), with per-post metrics. content_item_id links back to the
-- content library item that was posted (attribution), may be NULL for
-- free-form posts. Platforms mirror the Manna social tracking set
-- (2026-10-16): instagram, facebook, x, linkedin, tiktok, telegram,
-- rumble, truthsocial.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS social_postings (
  id              INTEGER PRIMARY KEY,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL CHECK (platform IN ('instagram','facebook','x','linkedin','tiktok','telegram','rumble','truthsocial')),
  post_url        TEXT NOT NULL,
  content_item_id INTEGER REFERENCES content_items(id) ON DELETE SET NULL,
  posted_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  likes           INTEGER NOT NULL DEFAULT 0 CHECK (likes >= 0),
  shares          INTEGER NOT NULL DEFAULT 0 CHECK (shares >= 0),
  comments        INTEGER NOT NULL DEFAULT 0 CHECK (comments >= 0),
  clicks          INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0)
);
CREATE INDEX IF NOT EXISTS idx_social_tenant ON social_postings(tenant_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_platform ON social_postings(tenant_id, platform);
