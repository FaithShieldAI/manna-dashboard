-- D2RM Dashboard SaaS — Migration 004: guided onboarding
--
-- 1. tenant_onboarding: per-tenant setup checklist state (one row per tenant,
--    created lazily). Step completion is DERIVED from real tenant data
--    (socials connected, templates installed, jobs run, campaigns created)
--    so the checklist can never get out of sync with reality. Only the
--    welcome-seen flag and the dismissed/completed markers are stored.
-- 2. connected_socials: social accounts the tenant connected during setup.
--    Tokens are AES-256-GCM encrypted (see src/lib/socialTokens.js) — the
--    DB never holds a plaintext token.
-- 3. email_templates / social_templates: the tenant's template library.
--    Starter templates are copied in from src/lib/starterTemplates.js.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Onboarding state: one row per tenant.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_onboarding (
  tenant_id        INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  welcome_seen     INTEGER NOT NULL DEFAULT 0 CHECK (welcome_seen IN (0, 1)),
  dismissed        INTEGER NOT NULL DEFAULT 0 CHECK (dismissed IN (0, 1)),
  completed_at     TEXT, -- ISO-8601 UTC; set when the user finishes or dismisses
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- Connected socials: platform + handle (+ optional encrypted API tokens).
-- Tokens are stored as 'gcm:<iv hex>:<ciphertext hex>:<tag hex>' blobs.
-- ---------------------------------------------------------------------------
CREATE TABLE connected_socials (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform         TEXT NOT NULL CHECK (platform IN
                     ('instagram','tiktok','youtube','x','facebook')),
  handle           TEXT NOT NULL CHECK (length(handle) BETWEEN 1 AND 80),
  access_token_enc TEXT,  -- encrypted; NULL when the tenant only gave a handle
  refresh_token_enc TEXT, -- encrypted
  expires_at       TEXT,  -- ISO-8601 UTC; NULL when unknown
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, platform)
);
CREATE INDEX idx_connected_socials_tenant ON connected_socials(tenant_id);

-- ---------------------------------------------------------------------------
-- Template libraries (per tenant). Starter templates are installed from the
-- bundled library; tenants can add their own later (v1: install only).
-- ---------------------------------------------------------------------------
CREATE TABLE email_templates (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_key     TEXT NOT NULL CHECK (length(template_key) BETWEEN 1 AND 80),
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  subject          TEXT NOT NULL DEFAULT '',
  body_html        TEXT NOT NULL DEFAULT '',
  body_text        TEXT NOT NULL DEFAULT '',
  category         TEXT, -- 'welcome' | 'launch' | 'newsletter' | ...
  is_starter       INTEGER NOT NULL DEFAULT 0 CHECK (is_starter IN (0, 1)),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, template_key)
);
CREATE INDEX idx_email_templates_tenant ON email_templates(tenant_id);

CREATE TABLE social_templates (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_key     TEXT NOT NULL CHECK (length(template_key) BETWEEN 1 AND 80),
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  platform         TEXT, -- 'all' | 'instagram' | 'tiktok' | 'youtube' | 'x'
  content          TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, template_key)
);
CREATE INDEX idx_social_templates_tenant ON social_templates(tenant_id);
