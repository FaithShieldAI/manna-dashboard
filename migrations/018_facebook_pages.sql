-- Migration 018: Facebook Pages — per-Page encrypted access tokens.
-- connected_socials holds ONE row per (tenant, platform); Facebook needs one
-- token per Page, so Pages get their own table. Tokens are stored encrypted
-- (AES-256-GCM blob via src/lib/socialTokens.js); plain text never hits disk.
-- Times are UTC ISO-8601 strings (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
-- fixed width so lexicographic comparison matches chronological order.

CREATE TABLE IF NOT EXISTS facebook_pages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  page_id        TEXT NOT NULL,
  page_name      TEXT NOT NULL DEFAULT '',
  page_token_enc TEXT,
  ig_user_id     TEXT,
  ig_username    TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, page_id)
);

CREATE INDEX IF NOT EXISTS idx_facebook_pages_tenant ON facebook_pages (tenant_id);
