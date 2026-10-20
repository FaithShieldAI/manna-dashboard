-- Migration 017: growth suite — goal tracking, DM log, podcast outreach,
-- A/B result metrics, sender health, financials, intake trends, video postings.
-- Every table carries tenant_id (dashboard security contract: no cross-tenant reads).
-- Times are UTC ISO-8601 strings (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
-- fixed width so lexicographic comparison matches chronological order.

-- ---------------------------------------------------------------------------
-- 1. Goal tracking: user-defined goals with deadlines (90-day scoreboard).
-- goals table already has goal_key/label/current_value/goal_value/unit.
-- ---------------------------------------------------------------------------
ALTER TABLE goals ADD COLUMN deadline_at TEXT;      -- ISO date, e.g. 2027-01-28
ALTER TABLE goals ADD COLUMN notes TEXT;
ALTER TABLE goals ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'paused', 'done', 'archived'));

-- ---------------------------------------------------------------------------
-- 2. Pipeline funnel: inter-stage conversion is computed in the route from
-- funnel_stages.current_value (no schema change). Seed a default pipeline
-- funnel per tenant is a product decision, not a migration.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 3. Podcast outreach: guest-pitch workflow on top of influencers(category='podcast').
-- pitch_status: identified -> pitched -> responded -> booked -> recorded -> aired
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS podcast_outreach (
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
CREATE INDEX IF NOT EXISTS idx_podcast_outreach_tenant ON podcast_outreach (tenant_id, pitch_status);

-- ---------------------------------------------------------------------------
-- 4. DM log: manual DM tracking (who, when, platform, replied?).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dm_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  handle       TEXT NOT NULL,
  platform     TEXT NOT NULL DEFAULT 'instagram'
               CHECK (platform IN ('instagram','x','tiktok','facebook','linkedin','truthsocial','telegram')),
  sent_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  script_used  TEXT,
  replied      INTEGER NOT NULL DEFAULT 0 CHECK (replied IN (0,1)),
  replied_at   TEXT,
  notes        TEXT
);
CREATE INDEX IF NOT EXISTS idx_dm_log_tenant ON dm_log (tenant_id, sent_at DESC);

-- ---------------------------------------------------------------------------
-- 5. A/B tests: per-variant result metrics + auto-apply winner.
-- ---------------------------------------------------------------------------
ALTER TABLE ab_tests ADD COLUMN sent_a INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ab_tests ADD COLUMN sent_b INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ab_tests ADD COLUMN opens_a INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ab_tests ADD COLUMN opens_b INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ab_tests ADD COLUMN clicks_a INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ab_tests ADD COLUMN clicks_b INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ab_tests ADD COLUMN auto_apply INTEGER NOT NULL DEFAULT 0 CHECK (auto_apply IN (0,1));
ALTER TABLE ab_tests ADD COLUMN decided_at TEXT;

-- ---------------------------------------------------------------------------
-- 6. Sender health: complaint counts on campaigns (thresholds in route).
-- ---------------------------------------------------------------------------
ALTER TABLE email_campaigns ADD COLUMN complaints INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 7. Financials: revenue + cost ledgers; MRR and P&L computed in route.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS revenue_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  date         TEXT NOT NULL, -- YYYY-MM-DD
  source       TEXT NOT NULL, -- 'faithshield' | 'manna' | 'sustained' | 'armor_bearer' | 'other'
  amount_cents INTEGER NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'mrr' CHECK (kind IN ('mrr','one_time','refund')),
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_revenue_tenant_date ON revenue_ledger (tenant_id, date DESC);

CREATE TABLE IF NOT EXISTS cost_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  date         TEXT NOT NULL, -- YYYY-MM-DD
  category     TEXT NOT NULL, -- 'saas' | 'ads' | 'email' | 'infra' | 'other'
  amount_cents INTEGER NOT NULL,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_cost_tenant_date ON cost_ledger (tenant_id, date DESC);

-- ---------------------------------------------------------------------------
-- 8. Collection intake: daily new leads per category with trends.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intake_daily (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  date       TEXT NOT NULL, -- YYYY-MM-DD
  category   TEXT NOT NULL, -- 'influencer' | 'pastor' | 'church' | 'podcast' | 'attorney' | 'handles' | 'other'
  new_count  INTEGER NOT NULL DEFAULT 0 CHECK (new_count >= 0),
  UNIQUE (tenant_id, date, category)
);
CREATE INDEX IF NOT EXISTS idx_intake_tenant_date ON intake_daily (tenant_id, date DESC);

-- ---------------------------------------------------------------------------
-- 9. Video postings log: "never throwing air again" — every video that goes
-- out is logged with its performance metrics (manual now, auto when APIs land).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS video_postings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  video_name    TEXT NOT NULL,
  product       TEXT NOT NULL DEFAULT 'manna'
                CHECK (product IN ('armor_bearer','faithshield','manna','sustained','k_punk','other')),
  platform      TEXT NOT NULL CHECK (platform IN ('instagram','facebook','x','linkedin','tiktok','telegram','rumble','truthsocial','youtube')),
  account_handle TEXT,
  post_url      TEXT,
  posted_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  views         INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
  likes         INTEGER NOT NULL DEFAULT 0 CHECK (likes >= 0),
  comments      INTEGER NOT NULL DEFAULT 0 CHECK (comments >= 0),
  shares        INTEGER NOT NULL DEFAULT 0 CHECK (shares >= 0),
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS idx_video_postings_tenant ON video_postings (tenant_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_postings_product ON video_postings (tenant_id, product);
