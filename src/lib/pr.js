'use strict';
/**
 * PR section: shared enums and the admin gate.
 *
 * Michael (2026-11-01): the PR tab lives in the D2RM dashboard only,
 * "not for Manna yet, although it may migrate." So every /api/pr route
 * is gated to the house, using the two mechanisms this codebase
 * already trusts for admin-only surfaces:
 *
 *   1. The hard owner allowlist from src/routes/admin.js
 *      (michael@faithshield.ai, leon@faithshield.ai). The private
 *      D2RM data is theirs; the pattern is copied, not reinvented.
 *   2. The whitelist rule from src/middleware/auth.js: an email on
 *      src/lib/whitelist.js whose address is verified is treated as
 *      admin (requireAuth elevates it to role 'admin' before any
 *      route runs).
 *
 * The gate deliberately does NOT trust the role alone: a tenant
 * owner can grant a team member the 'admin' role inside their own
 * tenant (src/routes/team.js), and that must never open this
 * section. A plain tenant account does NOT pass, and neither does a
 * whitelisted address whose email is unverified, matching the
 * 2026-10-29 audit fix B6 in the auth middleware.
 *
 * When the section migrates into Manna, this gate is the one thing
 * that changes; the tables are already tenant-scoped.
 */
const { isWhitelisted } = require('./whitelist');

// HARD-CODED, mirroring routes/admin.js. Do not widen without
// Michael's approval.
const PR_OWNER_EMAILS = new Set([
  'michael@faithshield.ai',
  'leon@faithshield.ai',
]);

const PR_TIERS = ['faith_major', 'tech', 'niche'];
const PR_TIER_LABELS = {
  faith_major: 'Faith press majors',
  tech: 'Tech and mainstream',
  niche: 'Faith-tech niche',
};
const TARGET_STATUSES = ['active', 'archived'];
const RELEASE_STATUSES = ['draft', 'approved', 'sent', 'archived'];
const PITCH_STATUSES = ['drafted', 'approved', 'sent', 'replied', 'covered', 'declined', 'no_response'];

function isPrAdmin(user) {
  if (!user || !user.email) return false;
  const email = String(user.email).toLowerCase().trim();
  if (PR_OWNER_EMAILS.has(email)) return true;
  if (isWhitelisted(email) && user.email_verified_at) return true;
  return false;
}

/** Express middleware: 403 unless isPrAdmin(req.user). Mount after requireAuth. */
function requirePrAdmin(req, res, next) {
  if (!isPrAdmin(req.user)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  next();
}

module.exports = {
  PR_OWNER_EMAILS,
  PR_TIERS,
  PR_TIER_LABELS,
  TARGET_STATUSES,
  RELEASE_STATUSES,
  PITCH_STATUSES,
  isPrAdmin,
  requirePrAdmin,
};
