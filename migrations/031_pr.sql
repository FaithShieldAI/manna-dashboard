-- D2RM Dashboard SaaS — Migration 031: PR (press connections, releases, pitches)
--
-- Michael (2026-11-01): "This will require a PR tab in D2RM dashboard,
-- not for Manna yet, although it may migrate." And: "The list of
-- connections goes there."
--
-- The PR section lives in the private D2RM dashboard view only. Every
-- API route under /api/pr is gated to admin/whitelisted users (see
-- src/lib/pr.js), and no tenant-facing surface links here. Rows still
-- carry tenant_id exactly like every other entity in this codebase, so
-- the whole section can migrate into Manna as a per-tenant feature
-- later by lifting the gate, with no schema change.
--
-- pr_targets: the connections list. One row per publication contact:
-- who they are, their role and beat, how a pitch reaches them
-- (contact_route), and whether that route was verified from the
-- outlet's own pages (route_verified). Unverified routes are kept and
-- marked, never silently trusted.
-- pr_releases: the releases themselves (title, subject line, body).
-- pr_pitches: one row per pitch of a release to a target, with the
-- status flow and follow-up bookkeeping.
CREATE TABLE IF NOT EXISTS pr_targets (
  id             INTEGER PRIMARY KEY,
  tenant_id      INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  publication    TEXT NOT NULL,
  contact_name   TEXT,
  role           TEXT,
  beat           TEXT,
  contact_route  TEXT,
  route_verified INTEGER NOT NULL DEFAULT 0 CHECK (route_verified IN (0, 1)),
  tier           TEXT NOT NULL DEFAULT 'niche' CHECK (tier IN ('faith_major', 'tech', 'niche')),
  fit_note       TEXT,
  source         TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pr_targets_tenant ON pr_targets(tenant_id, tier, id);
-- Seeder dedup: one row per (publication, contact) per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_targets_dedup
  ON pr_targets(tenant_id, publication, ifnull(contact_name, ''));

CREATE TABLE IF NOT EXISTS pr_releases (
  id           INTEGER PRIMARY KEY,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  subject_line TEXT,
  body         TEXT,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sent', 'archived')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pr_releases_tenant ON pr_releases(tenant_id, id DESC);

CREATE TABLE IF NOT EXISTS pr_pitches (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target_id     INTEGER NOT NULL REFERENCES pr_targets(id) ON DELETE CASCADE,
  release_id    INTEGER REFERENCES pr_releases(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'drafted'
                CHECK (status IN ('drafted', 'approved', 'sent', 'replied', 'covered', 'declined', 'no_response')),
  sent_at       TEXT,
  reply_at      TEXT,
  follow_up_due TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pr_pitches_tenant ON pr_pitches(tenant_id, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_pr_pitches_target ON pr_pitches(target_id);
