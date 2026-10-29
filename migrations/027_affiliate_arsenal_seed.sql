-- Migration 027: affiliate arsenal preload ("loaded guns", 2026-10-25).
--
-- When an Armor Bearer affiliate's Manna tenant is provisioned
-- (plan='influencer'), it must arrive PRELOADED with the full D2RM
-- contact arsenal (13,871 master contacts) inside the app — the data
-- equivalent of the Content Library's preloaded media. Seeded rows live
-- in `influencers` (the one table behind the Leads / Vetted /
-- Influencers surfaces) with source='d2rm-arsenal'.
--
-- 1. influencers.external_id: the master contact id (email-database.db
--    contacts.id) for arsenal-seeded rows; NULL for every other row.
--    Together with tenant_id it is the seed's idempotency key: a
--    re-run finds every master id already represented and inserts 0.
--    The partial UNIQUE index enforces one row per master contact
--    per tenant at the database level.
-- 2. tenant_seed_state: per-tenant seeded flag + version for named
--    seed sets ('d2rm-arsenal'), so the provisioning webhook can
--    fast-path replays and the backfill script can report coverage
--    without scanning 13,871 rows.

PRAGMA foreign_keys = ON;

ALTER TABLE influencers ADD COLUMN external_id INTEGER;

CREATE UNIQUE INDEX idx_influencers_tenant_external
  ON influencers (tenant_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tenant_seed_state (
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  seed_key   TEXT NOT NULL,
  version    INTEGER NOT NULL,
  row_count  INTEGER NOT NULL DEFAULT 0,
  seeded_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, seed_key)
);
