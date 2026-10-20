-- Migration 014: drip campaigns + scheduled sends automation tables.
-- Every table carries tenant_id (dashboard security contract: no cross-tenant reads).
-- Times are UTC ISO-8601 strings (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
-- fixed width so lexicographic comparison matches chronological order.

CREATE TABLE IF NOT EXISTS drip_campaigns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL,
  name        TEXT NOT NULL,
  product     TEXT NOT NULL DEFAULT 'manna',
  language    TEXT NOT NULL DEFAULT 'en',
  audience    TEXT,
  status      TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('active', 'paused', 'draft')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_drip_campaigns_tenant ON drip_campaigns (tenant_id);

CREATE TABLE IF NOT EXISTS drip_steps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL,
  drip_id      INTEGER NOT NULL REFERENCES drip_campaigns (id) ON DELETE CASCADE,
  step_order   INTEGER NOT NULL DEFAULT 0,
  delay_hours  INTEGER NOT NULL DEFAULT 24,
  template_key TEXT NOT NULL,
  subject      TEXT,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'paused', 'draft')),
  UNIQUE (drip_id, step_order)
);
CREATE INDEX IF NOT EXISTS idx_drip_steps_tenant ON drip_steps (tenant_id);
CREATE INDEX IF NOT EXISTS idx_drip_steps_drip ON drip_steps (drip_id);

CREATE TABLE IF NOT EXISTS drip_enrollments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL,
  drip_id       INTEGER NOT NULL REFERENCES drip_campaigns (id) ON DELETE CASCADE,
  contact_email TEXT NOT NULL,
  current_step  INTEGER NOT NULL DEFAULT 0,
  next_send_at  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'completed', 'unsubscribed')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (drip_id, contact_email)
);
CREATE INDEX IF NOT EXISTS idx_drip_enrollments_tenant ON drip_enrollments (tenant_id);
CREATE INDEX IF NOT EXISTS idx_drip_enrollments_due ON drip_enrollments (tenant_id, status, next_send_at);

CREATE TABLE IF NOT EXISTS scheduled_sends (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL,
  campaign_id  INTEGER REFERENCES email_campaigns (id) ON DELETE SET NULL,
  scheduled_at TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'sent', 'cancelled')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_sends_tenant ON scheduled_sends (tenant_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_sends_due ON scheduled_sends (tenant_id, status, scheduled_at);
