-- D2RM Dashboard SaaS — Migration 032: PR categories + do-not-pitch
--
-- Michael (2026-11-01), two rulings that arrived while migration 031
-- was being built:
--
-- 1. CATEGORIES. The connections list sits on two shelves, his labels:
--    "Faith-Based" and "Mainstream" (he first said "Regular," then
--    ruled it "kinda plain"). pr_targets gains category
--    ('faith_based' | 'mainstream'); the finer tier field stays
--    underneath it. pr_releases gains the same category, because:
--    "Those releases are different" — a Faith-Based release leads
--    with the ministry angle, a Mainstream release leads with the
--    tech/agent story, and a pitch pairs a target with a release
--    from its own shelf by default.
--
-- 2. DO NOT PITCH. His press rule: "The ones that don't publish
--    don't get the story." Targets whose pitch route is not published
--    (Axios, CBN News, Religion Unplugged, Ministry Tech, TIME in the
--    2026-11-01 list) are parked with status 'do_not_pitch': visible
--    on the list, never pitchable. The pr_targets status CHECK widens
--    to say so, which needs the table rebuild below.
--
-- pr_targets is a foreign-key parent (pr_pitches.target_id), so this
-- uses migration 022's rename-aside sequence, NOT the naive
-- create/copy/DROP: dropping the parent would fire ON DELETE CASCADE
-- into pr_pitches and silently delete pitch history. Orphan pitches
-- are swept first for the same reason 022 swept orphans: a junk row
-- would make the copy steps throw and crash-loop the boot.
--
-- Existing targets backfill category from tier: tech -> mainstream,
-- faith_major and niche -> faith_based (the niche tier on file is
-- the faith-tech niche, which sits on the Faith-Based shelf).

DELETE FROM pr_pitches
WHERE target_id NOT IN (SELECT id FROM pr_targets);

ALTER TABLE pr_targets RENAME TO pr_targets_old;

CREATE TABLE pr_targets (
  id             INTEGER PRIMARY KEY,
  tenant_id      INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  publication    TEXT NOT NULL,
  contact_name   TEXT,
  role           TEXT,
  beat           TEXT,
  contact_route  TEXT,
  route_verified INTEGER NOT NULL DEFAULT 0 CHECK (route_verified IN (0, 1)),
  tier           TEXT NOT NULL DEFAULT 'niche' CHECK (tier IN ('faith_major', 'tech', 'niche')),
  category       TEXT NOT NULL DEFAULT 'faith_based' CHECK (category IN ('faith_based', 'mainstream')),
  fit_note       TEXT,
  source         TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'do_not_pitch')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO pr_targets
  (id, tenant_id, publication, contact_name, role, beat, contact_route,
   route_verified, tier, category, fit_note, source, status, created_at, updated_at)
SELECT id, tenant_id, publication, contact_name, role, beat, contact_route,
   route_verified, tier,
   CASE WHEN tier = 'tech' THEN 'mainstream' ELSE 'faith_based' END,
   fit_note, source, status, created_at, updated_at
FROM pr_targets_old;

-- pr_pitches: identical rebuild (031 definition verbatim) so its
-- target_id FK points at the new pr_targets table.
CREATE TABLE pr_pitches_new (
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

INSERT INTO pr_pitches_new
  (id, tenant_id, target_id, release_id, status, sent_at, reply_at,
   follow_up_due, notes, created_at, updated_at)
SELECT id, tenant_id, target_id, release_id, status, sent_at, reply_at,
   follow_up_due, notes, created_at, updated_at
FROM pr_pitches;

DROP TABLE pr_pitches;
ALTER TABLE pr_pitches_new RENAME TO pr_pitches;

DROP TABLE pr_targets_old;

CREATE INDEX idx_pr_targets_tenant ON pr_targets(tenant_id, category, tier, id);
-- Seeder dedup: one row per (publication, contact) per tenant.
CREATE UNIQUE INDEX idx_pr_targets_dedup
  ON pr_targets(tenant_id, publication, ifnull(contact_name, ''));

CREATE INDEX idx_pr_pitches_tenant ON pr_pitches(tenant_id, status, id DESC);
CREATE INDEX idx_pr_pitches_target ON pr_pitches(target_id);

-- pr_releases: category only. No CHECK widens here, so a plain
-- ADD COLUMN suffices; existing rows take the default and can be
-- re-shelved from the tab.
ALTER TABLE pr_releases ADD COLUMN category TEXT NOT NULL DEFAULT 'faith_based'
  CHECK (category IN ('faith_based', 'mainstream'));
CREATE INDEX idx_pr_releases_category ON pr_releases(tenant_id, category, id DESC);
