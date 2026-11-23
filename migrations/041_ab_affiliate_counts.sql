-- D2RM Dashboard SaaS — Migration 041: Armor Bearer affiliate counts
--
-- Armor Bearer affiliates live in the separate Armor Bearer app (on
-- PythonAnywhere); Manna holds no affiliate table. The affiliates
-- goal on the Overview therefore had no live source and rendered as
-- a target with a "No live feed" label (see src/lib/goalValues.js).
--
-- This table holds the latest classified counts pushed here by the
-- AB affiliates sync (POST /api/auth/ab-affiliates-sync, token-gated,
-- same MIGRATION_TOKEN pattern as the other sync doors): a local
-- script reads the Armor Bearer dashboard-read door, posts the
-- account list, and src/lib/abAffiliates.js classifies it under the
-- owner's counting rule (2026-11-22: test accounts and second
-- accounts are not counted) and stores the result here.
--
-- One row only (id = 1): the counts are platform-wide, like the
-- faithshield and mannaai goal values. The goal reads the row only
-- while it is fresh (received within the sync's freshness window);
-- a stale or absent row returns the goal to the honest no-feed
-- state instead of presenting an old number as a measurement.
--
--   approved / pending / rejected — real accounts by status, after
--     the counting rule's exclusions.
--   excluded  — accounts the counting rule left out (test, second,
--     and support accounts), kept visible so the raw door total
--     reconciles: approved + pending + rejected + excluded =
--     raw_total.
--   audit_json — one entry per door account: email, status, whether
--     it was counted, and the exclusion reason when it was not.

CREATE TABLE IF NOT EXISTS ab_affiliate_counts (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  approved INTEGER NOT NULL,
  pending INTEGER NOT NULL,
  rejected INTEGER NOT NULL,
  excluded INTEGER NOT NULL,
  raw_total INTEGER NOT NULL,
  audit_json TEXT NOT NULL DEFAULT '[]',
  source_generated_at TEXT,
  received_at TEXT NOT NULL
);
