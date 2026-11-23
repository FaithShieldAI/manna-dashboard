'use strict';
/**
 * Armor Bearer affiliates: the counting rule and the stored feed.
 *
 * Affiliates live in the separate Armor Bearer app; this app holds
 * no affiliate table. A local sync script reads the Armor Bearer
 * dashboard-read door and posts the account list to
 * POST /api/auth/ab-affiliates-sync (token-gated); this module
 * classifies the list and stores the counts in ab_affiliate_counts
 * (migration 041, one platform-wide row).
 *
 * The counting rule (owner, 2026-11-22): test accounts and second
 * accounts are not counted. The verified census that day: 20 door
 * accounts = 6 approved real people and 14 pending that are not
 * prospects (10 October security and red-team test accounts, 3
 * second accounts, 1 house support account). Classification runs
 * from the door data itself so the count stays right as accounts
 * change:
 *
 *   1. An explicit exclusion list: the 14 known junk emails from
 *      the 2026-11-22 census (second accounts, the support account,
 *      and the October test accounts, named in the list below).
 *   2. Test-style patterns for future junk: reserved example
 *      domains, a domain with no dot (not a deliverable address),
 *      and test markers (test, redteam, xss, rapid, longtest,
 *      weaktest) appearing as whole words in the email local part
 *      or the account name. Whole-word matching is deliberate: it
 *      must not swallow real addresses that merely contain the
 *      letters, such as latest@ or contest@.
 *
 * Anything not excluded counts under its door status, so a real
 * pending prospect (none on 2026-11-22) counts as pending the day
 * one appears.
 *
 * Freshness (LIVE MEANS LIVE): the sync posts every 10 minutes.
 * A stored row counts as the live feed only while it is at most
 * FRESH_MS old (three cycles, so two missed runs are tolerated);
 * older or absent, the goal falls back to its no-feed state rather
 * than presenting a stale number as a measurement.
 */
const { db } = require('../db');

const FRESH_MS = 30 * 60 * 1000;
const STATUSES = ['approved', 'pending', 'rejected'];

// The 2026-11-22 census: accounts that are not prospects and never
// count, whatever status the door later gives them.
const EXCLUDED_EMAILS = new Set([
  // Second accounts of real affiliates (their first accounts count).
  'mikemixer2002@gmail.com', // Michael Faber
  'itsme@leonsievers.com', // Leon Sievers
  'basedinfaith@mail.com', // Sid Allen
  // House support account.
  'support@faithshield.ai', // Nyxx
  // October 2026 security and red-team test accounts.
  'xss-test@example.com',
  'longtest@example.com',
  'weaktest@example.com',
  'rapid1@example.com',
  'rapid2@example.com',
  'redteam-armorbearer-1@example.com',
  'redteam-armorbearer-2@example.com',
  'redteam-armorbearer-3@example.com',
  'redteam-oct24@example.com',
  'a@b', // BadEmail test entry
]);

const TEST_WORD = /(^|[^a-z])(test|redteam|red-team|red team|xss|rapid)([^a-z]|$)/;
const TEST_COMPOUND = /longtest|weaktest/;

/** Exclusion reason for one door account, or null when it counts. */
function exclusionReason(email, name) {
  if (EXCLUDED_EMAILS.has(email)) return 'known_excluded';
  const at = email.lastIndexOf('@');
  if (at <= 0) return 'invalid_email';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain) return 'invalid_email';
  if (domain === 'example.com' || domain === 'example.org' || domain === 'example.net'
      || domain.endsWith('.example')) {
    return 'test_domain';
  }
  if (!domain.includes('.')) return 'invalid_email';
  // Strip zero-width characters the red-team accounts hide in names.
  const cleanName = String(name || '').replace(/[\u200b\u200c\u200d\ufeff]/g, ' ').toLowerCase();
  const hay = `${local} ${cleanName}`;
  if (TEST_WORD.test(hay) || TEST_COMPOUND.test(hay)) return 'test_pattern';
  return null;
}

/**
 * Classify a door account list ([{ name, email, status }]) under
 * the counting rule. Returns the real counts by status, how many
 * were excluded, the raw total, and a per-account audit trail.
 */
function classifyAffiliates(list) {
  const out = { approved: 0, pending: 0, rejected: 0, excluded: 0, raw_total: 0, audit: [] };
  for (const entry of list) {
    const email = String((entry && entry.email) || '').trim().toLowerCase();
    const name = entry && entry.name !== undefined && entry.name !== null ? String(entry.name) : '';
    const status = String((entry && entry.status) || '').trim().toLowerCase();
    out.raw_total += 1;
    const reason = exclusionReason(email, name);
    if (reason) {
      out.excluded += 1;
      out.audit.push({ email, status, counted: false, reason });
    } else if (STATUSES.includes(status)) {
      out[status] += 1;
      out.audit.push({ email, status, counted: true, reason: null });
    } else {
      out.excluded += 1;
      out.audit.push({ email, status, counted: false, reason: 'unknown_status' });
    }
  }
  return out;
}

/** Store a classified result as the single platform-wide row. */
function storeAbCounts(classified, sourceGeneratedAt) {
  const receivedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO ab_affiliate_counts
      (id, approved, pending, rejected, excluded, raw_total, audit_json, source_generated_at, received_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      approved = excluded.approved,
      pending = excluded.pending,
      rejected = excluded.rejected,
      excluded = excluded.excluded,
      raw_total = excluded.raw_total,
      audit_json = excluded.audit_json,
      source_generated_at = excluded.source_generated_at,
      received_at = excluded.received_at
  `).run(
    classified.approved, classified.pending, classified.rejected,
    classified.excluded, classified.raw_total,
    JSON.stringify(classified.audit),
    typeof sourceGeneratedAt === 'string' ? sourceGeneratedAt : null,
    receivedAt,
  );
  return receivedAt;
}

/** The stored feed plus its freshness, or null when never synced. */
function readAbCounts() {
  let row;
  try {
    row = db.prepare('SELECT * FROM ab_affiliate_counts WHERE id = 1').get();
  } catch (e) {
    return null; // table absent (pre-migration-041 DB): no feed, not an error
  }
  if (!row) return null;
  const age = Date.now() - Date.parse(row.received_at);
  return {
    approved: row.approved,
    pending: row.pending,
    rejected: row.rejected,
    excluded: row.excluded,
    raw_total: row.raw_total,
    source_generated_at: row.source_generated_at,
    received_at: row.received_at,
    fresh: Number.isFinite(age) && age <= FRESH_MS,
  };
}

module.exports = {
  FRESH_MS, STATUSES, EXCLUDED_EMAILS,
  exclusionReason, classifyAffiliates, storeAbCounts, readAbCounts,
};
