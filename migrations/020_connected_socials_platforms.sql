-- Migration 020: widen connected_socials platform CHECK for the
-- social-connection feature (src/routes/socialConnect.js).
--
-- Migration 004 created connected_socials with platform IN
-- ('instagram','tiktok','youtube','x','facebook'). The connect feature adds
-- Truth Social ('truth', Mastodon-API OAuth) and Rumble ('rumble',
-- manual handle registration — Rumble has no public posting API), so the
-- CHECK must accept both. SQLite cannot alter a CHECK in place: rebuild
-- the table, copy rows, swap names. Runs inside the migration runner's
-- transaction; no other table references connected_socials.

CREATE TABLE connected_socials_new (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform         TEXT NOT NULL CHECK (platform IN
                     ('instagram','tiktok','youtube','x','facebook','truth','rumble')),
  handle           TEXT NOT NULL CHECK (length(handle) BETWEEN 1 AND 80),
  access_token_enc TEXT,  -- encrypted; NULL when the tenant only gave a handle
  refresh_token_enc TEXT, -- encrypted
  expires_at       TEXT,  -- ISO-8601 UTC; NULL when unknown
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, platform)
);

INSERT INTO connected_socials_new
  (id, tenant_id, platform, handle, access_token_enc, refresh_token_enc, expires_at, created_at)
SELECT id, tenant_id, platform, handle, access_token_enc, refresh_token_enc, expires_at, created_at
FROM connected_socials;

DROP TABLE connected_socials;
ALTER TABLE connected_socials_new RENAME TO connected_socials;

CREATE INDEX idx_connected_socials_tenant ON connected_socials(tenant_id);
