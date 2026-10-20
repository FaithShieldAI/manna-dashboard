-- Migration 016: influencer provisioning support.
--
-- 1. Widen tenants.plan CHECK: the plans.js model now defines
--    starter/pro/heavy10/heavy30/influencer/agency, but the 001 CHECK only
--    allowed ('starter','pro','agency') — inserting an influencer tenant
--    would fail. SQLite cannot ALTER a CHECK, so the table is recreated and
--    existing rows are copied over (pattern from migration 005).
-- 2. Add 'failed' to drip_enrollments.status so the drip worker can mark
--    enrollments that exhausted retries without silently dropping them.
-- 3. provisioning_log: audit trail for influencer auto-provisioning events
--    (Michael: log the provisioning event).

PRAGMA foreign_keys = OFF;

-- --- tenants: widen plan CHECK -------------------------------------------
CREATE TABLE tenants_new (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  slug             TEXT NOT NULL UNIQUE CHECK (slug GLOB '[a-z0-9][a-z0-9-]*'),
  plan             TEXT NOT NULL DEFAULT 'starter'
                   CHECK (plan IN ('starter', 'pro', 'heavy10', 'heavy30',
                                   'influencer', 'agency')),
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

INSERT INTO tenants_new
  (id, name, slug, plan, stripe_customer_id, stripe_subscription_id,
   subscription_status, trial_ends_at, created_at, updated_at)
SELECT
  id, name, slug, plan, stripe_customer_id, stripe_subscription_id,
  subscription_status, trial_ends_at, created_at, updated_at
FROM tenants;

DROP TABLE tenants;
ALTER TABLE tenants_new RENAME TO tenants;

-- --- drip_enrollments: add 'failed' status --------------------------------
CREATE TABLE drip_enrollments_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL,
  drip_id       INTEGER NOT NULL REFERENCES drip_campaigns (id) ON DELETE CASCADE,
  contact_email TEXT NOT NULL,
  current_step  INTEGER NOT NULL DEFAULT 0,
  next_send_at  TEXT NOT NULL,
  send_attempts INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'completed', 'failed', 'unsubscribed')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (drip_id, contact_email)
);

INSERT INTO drip_enrollments_new
  (id, tenant_id, drip_id, contact_email, current_step, next_send_at,
   send_attempts, status, created_at)
SELECT
  id, tenant_id, drip_id, contact_email, current_step, next_send_at,
  0, status, created_at
FROM drip_enrollments;

DROP TABLE drip_enrollments;
ALTER TABLE drip_enrollments_new RENAME TO drip_enrollments;
CREATE INDEX IF NOT EXISTS idx_drip_enrollments_tenant ON drip_enrollments (tenant_id);
CREATE INDEX IF NOT EXISTS idx_drip_enrollments_due ON drip_enrollments (tenant_id, status, next_send_at);

-- --- provisioning_log: audit trail ----------------------------------------
CREATE TABLE IF NOT EXISTS provisioning_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type     TEXT NOT NULL,  -- 'provisioned' | 'already_provisioned' | 'plan_upgraded'
  email          TEXT NOT NULL,
  tenant_id      INTEGER REFERENCES tenants (id) ON DELETE SET NULL,
  user_id        INTEGER REFERENCES users (id) ON DELETE SET NULL,
  source         TEXT NOT NULL DEFAULT 'armor-bearer-webhook',
  detail         TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_provisioning_log_email ON provisioning_log (email);

-- --- drip_send_log: per-send audit (template_key always recorded) ----------
CREATE TABLE IF NOT EXISTS drip_send_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL,
  drip_id         INTEGER NOT NULL,
  enrollment_id   INTEGER NOT NULL,
  contact_email   TEXT NOT NULL,
  template_key    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped_quota')),
  provider        TEXT,          -- 'ses' | 'brevo' | 'stub'
  provider_msg_id TEXT,
  error           TEXT,
  attempt         INTEGER NOT NULL DEFAULT 1,
  sent_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_drip_send_log_tenant ON drip_send_log (tenant_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_drip_send_log_enrollment ON drip_send_log (enrollment_id);

PRAGMA foreign_keys = ON;
