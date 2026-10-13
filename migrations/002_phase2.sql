-- D2RM Dashboard SaaS — Migration 002: Phase 2 additions
--
-- 1. password_reset_tokens: forgot-password flow (hash stored, raw token emailed).
-- 2. tenant_usage: monthly email-send metering per tenant (quota enforcement).
-- 3. sites.collect_key: per-site write key for the public realtime beacon.
-- 4. ROI columns on email_campaigns + funnels (cost/revenue in cents).

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Password reset tokens (single-use, 1h expiry).
-- ---------------------------------------------------------------------------
CREATE TABLE password_reset_tokens (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash       TEXT NOT NULL UNIQUE,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_pwreset_user ON password_reset_tokens(user_id);

-- ---------------------------------------------------------------------------
-- Tenant usage: monthly email-send metering. One row per tenant per month.
-- month_key format: 'YYYY-MM' (UTC).
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_usage (
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  month_key        TEXT NOT NULL CHECK (month_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  emails_sent      INTEGER NOT NULL DEFAULT 0 CHECK (emails_sent >= 0),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, month_key)
);

-- ---------------------------------------------------------------------------
-- Sites: collect_key for the public realtime beacon (POST /api/collect/:siteKey).
-- ---------------------------------------------------------------------------
ALTER TABLE sites ADD COLUMN collect_key TEXT;

-- ---------------------------------------------------------------------------
-- ROI: cost and revenue (cents) on campaigns and funnels.
-- roi_pct = revenue>0 ? (revenue-cost)/cost*100 : null (null when cost = 0
-- and revenue = 0 to avoid divide-by-zero; computed in route code).
-- ---------------------------------------------------------------------------
ALTER TABLE email_campaigns ADD COLUMN cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (cost_cents >= 0);
ALTER TABLE email_campaigns ADD COLUMN revenue_cents INTEGER NOT NULL DEFAULT 0 CHECK (revenue_cents >= 0);
ALTER TABLE funnels ADD COLUMN cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (cost_cents >= 0);
ALTER TABLE funnels ADD COLUMN revenue_cents INTEGER NOT NULL DEFAULT 0 CHECK (revenue_cents >= 0);
