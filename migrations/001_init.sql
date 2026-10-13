-- D2RM Dashboard SaaS — Migration 001: initial multi-tenant schema
--
-- Tenancy model: SHARED SCHEMA with tenant_id discriminator.
-- Every tenant-scoped table carries tenant_id NOT NULL, and every application
-- query MUST filter on it. The data-access layer (src/db.js) exposes only
-- tenant-scoped helpers; raw cross-tenant queries are never issued from
-- route handlers. See ARCHITECTURE.md for the full rationale.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Tenants: one row per paying customer (company / creator / ministry).
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  slug             TEXT NOT NULL UNIQUE CHECK (slug GLOB '[a-z0-9][a-z0-9-]*'),
  plan             TEXT NOT NULL DEFAULT 'starter'
                   CHECK (plan IN ('starter', 'pro', 'agency')),
  -- Billing (Phase 2 — Stripe). Columns exist now so no schema change later.
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT,
  subscription_status     TEXT NOT NULL DEFAULT 'trialing'
                   CHECK (subscription_status IN
                     ('trialing','active','past_due','canceled','incomplete')),
  trial_ends_at    TEXT, -- ISO-8601 UTC
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- Users: login identities. Email is globally unique (one login across tenants
-- is not supported in v1 — a user belongs to exactly one tenant).
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email            TEXT NOT NULL UNIQUE CHECK (length(email) BETWEEN 5 AND 254),
  password_hash    TEXT NOT NULL, -- bcrypt, cost 12
  display_name     TEXT CHECK (display_name IS NULL OR length(display_name) <= 80),
  role             TEXT NOT NULL DEFAULT 'owner'
                   CHECK (role IN ('owner', 'admin', 'viewer')),
  email_verified_at TEXT, -- ISO-8601 UTC; NULL until verified
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_users_tenant ON users(tenant_id);

-- ---------------------------------------------------------------------------
-- Sessions: server-side sessions. Only the SHA-256 hash of the token is
-- stored; the raw token lives in the httpOnly cookie only. Sessions can be
-- revoked instantly by deleting the row (logout / "log out everywhere").
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash       TEXT NOT NULL UNIQUE, -- hex SHA-256 of the 256-bit token
  expires_at       TEXT NOT NULL,         -- ISO-8601 UTC
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ip               TEXT,
  user_agent       TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Email verification tokens (signup flow). Hash stored, raw token emailed.
-- ---------------------------------------------------------------------------
CREATE TABLE email_verification_tokens (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash       TEXT NOT NULL UNIQUE,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- Sites: websites tracked by a tenant (mirrors the dashboard's SITES list).
-- ---------------------------------------------------------------------------
CREATE TABLE sites (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_key         TEXT NOT NULL, -- e.g. 'kpunk', 'faithshield'
  name             TEXT NOT NULL,
  url              TEXT,
  emoji            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, site_key)
);
CREATE INDEX idx_sites_tenant ON sites(tenant_id);

-- ---------------------------------------------------------------------------
-- Site daily metrics: pre-aggregated rollups (visitors, pageviews, ...).
-- Raw hits are not stored in v1 — the tracker posts daily aggregates.
-- ---------------------------------------------------------------------------
CREATE TABLE site_daily_metrics (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id          INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  day              TEXT NOT NULL, -- YYYY-MM-DD (tenant's timezone, stored as given)
  visitors         INTEGER NOT NULL DEFAULT 0 CHECK (visitors >= 0),
  pageviews        INTEGER NOT NULL DEFAULT 0 CHECK (pageviews >= 0),
  bounce_rate      REAL CHECK (bounce_rate IS NULL OR (bounce_rate >= 0 AND bounce_rate <= 100)),
  avg_duration_s   REAL CHECK (avg_duration_s IS NULL OR avg_duration_s >= 0),
  UNIQUE (tenant_id, site_id, day)
);
CREATE INDEX idx_metrics_lookup ON site_daily_metrics(tenant_id, site_id, day);

-- ---------------------------------------------------------------------------
-- Site events: conversion events (signup, notify-me click, ...).
-- ---------------------------------------------------------------------------
CREATE TABLE site_events (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id          INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  event_name       TEXT NOT NULL CHECK (length(event_name) BETWEEN 1 AND 80),
  occurred_at      TEXT NOT NULL, -- ISO-8601 UTC
  session_key      TEXT,           -- dedupe key from the tracker
  metadata_json    TEXT            -- optional JSON blob (validated as JSON on write)
);
CREATE INDEX idx_events_lookup ON site_events(tenant_id, site_id, event_name, occurred_at);

-- ---------------------------------------------------------------------------
-- Email snapshots: windowed aggregates (24h / 7d / 30d / all) — the
-- EMAIL_WINDOWS structure from the current dashboard, persisted per tenant.
-- ---------------------------------------------------------------------------
CREATE TABLE email_snapshots (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  window_key       TEXT NOT NULL CHECK (window_key IN ('24h','7d','30d','all')),
  sent             INTEGER NOT NULL DEFAULT 0,
  opens            INTEGER NOT NULL DEFAULT 0,
  clicks           INTEGER NOT NULL DEFAULT 0,
  unsubs           INTEGER NOT NULL DEFAULT 0,
  bounces          INTEGER NOT NULL DEFAULT 0,
  warm_total       INTEGER NOT NULL DEFAULT 0,
  warm_by_lang_json TEXT NOT NULL DEFAULT '{}', -- {"english":17,...}
  captured_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, window_key)
);

-- ---------------------------------------------------------------------------
-- Email campaigns: individual sends (Brevo/Kit/MailerLite rows on the Email tab).
-- ---------------------------------------------------------------------------
CREATE TABLE email_campaigns (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  provider         TEXT, -- 'brevo' | 'kit' | 'mailerlite' | ...
  sent             INTEGER NOT NULL DEFAULT 0,
  opens            INTEGER NOT NULL DEFAULT 0,
  clicks           INTEGER NOT NULL DEFAULT 0,
  unsubs           INTEGER NOT NULL DEFAULT 0,
  bounces          INTEGER NOT NULL DEFAULT 0,
  sent_at          TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_campaigns_tenant ON email_campaigns(tenant_id, sent_at DESC);

-- ---------------------------------------------------------------------------
-- Funnels + stages: conversion funnels with goals (Armor Bearer, FaithShield,
-- Sustained, K-Punk in the D2RM tenant; arbitrary funnels for customers).
-- ---------------------------------------------------------------------------
CREATE TABLE funnels (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  funnel_key       TEXT NOT NULL,
  name             TEXT NOT NULL,
  emoji            TEXT,
  subtitle         TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, funnel_key)
);

CREATE TABLE funnel_stages (
  id               INTEGER PRIMARY KEY,
  funnel_id        INTEGER NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  stage_key        TEXT NOT NULL, -- 'sent' | 'opened' | 'clicked' | 'signups' | ...
  label            TEXT NOT NULL,
  current_value    INTEGER NOT NULL DEFAULT 0,
  goal_value       INTEGER,       -- NULL = no goal set
  sort_order       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (funnel_id, stage_key)
);
CREATE INDEX idx_funnel_stages ON funnel_stages(funnel_id, sort_order);

-- ---------------------------------------------------------------------------
-- Influencers / creators (incl. podcast hosts as category='podcast').
-- ---------------------------------------------------------------------------
CREATE TABLE influencers (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  handle           TEXT,
  platform         TEXT, -- 'youtube' | 'instagram' | 'tiktok' | 'rumble' | ...
  email            TEXT,
  tier             TEXT CHECK (tier IS NULL OR tier IN ('nano','micro','macro','mega')),
  category         TEXT NOT NULL DEFAULT 'influencer'
                   CHECK (category IN ('influencer','podcast','pastor','church','attorney')),
  status           TEXT NOT NULL DEFAULT 'unvetted'
                   CHECK (status IN ('unvetted','vetted','contacted','active','rejected')),
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_influencers_tenant ON influencers(tenant_id, category, status);

-- ---------------------------------------------------------------------------
-- IP registry assets.
-- ---------------------------------------------------------------------------
CREATE TABLE ip_assets (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT,
  asset_type       TEXT NOT NULL CHECK (asset_type IN
                     ('copyright','trademark','patent','trade_secret','domain','other')),
  status           TEXT NOT NULL DEFAULT 'created-unregistered' CHECK (status IN
                     ('idea','created-unregistered','filed-pending','registered','licensed')),
  content_hash     TEXT, -- SHA-256 of the registered work
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_ip_tenant ON ip_assets(tenant_id, asset_type, status);

-- ---------------------------------------------------------------------------
-- Social accounts.
-- ---------------------------------------------------------------------------
CREATE TABLE social_accounts (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform         TEXT NOT NULL, -- 'instagram' | 'tiktok' | 'youtube' | ...
  handle           TEXT NOT NULL,
  followers        INTEGER NOT NULL DEFAULT 0,
  posts            INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, platform, handle)
);

-- ---------------------------------------------------------------------------
-- Goals: top-level tenant goals with progress (email collection 11.5k etc.).
-- ---------------------------------------------------------------------------
CREATE TABLE goals (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  goal_key         TEXT NOT NULL,
  label            TEXT NOT NULL,
  current_value    INTEGER NOT NULL DEFAULT 0,
  goal_value       INTEGER NOT NULL,
  unit             TEXT, -- 'emails' | 'users' | 'signups' | ...
  UNIQUE (tenant_id, goal_key)
);

-- ---------------------------------------------------------------------------
-- Migration bookkeeping.
-- ---------------------------------------------------------------------------
CREATE TABLE schema_migrations (
  version          INTEGER PRIMARY KEY,
  applied_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
