'use strict';
/**
 * requireAuth — protects all /api/* routes (except /api/auth/*).
 *
 * Loads the session from the httpOnly cookie, attaches:
 *   req.user   — { id, tenant_id, email, display_name, role }
 *   req.tenant — { id, name, slug, plan, subscription_status }
 *   req.tdb    — tenant-scoped query helpers (src/db.js forTenant)
 *
 * Route handlers MUST use req.tdb for all data access. There is no
 * unscoped access on the request object by design.
 */
const { COOKIE_NAME, verifySession } = require('../lib/sessions');
const { unscoped } = require('../db');

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  const verified = verifySession(token);
  if (!verified) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const tenant = unscoped.getTenantById(verified.user.tenant_id);
  if (!tenant) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  req.user = verified.user;
  // Whitelisted partners (Michael's rule 2026-10-18) get full visibility:
  // treat as admin so they see all tenants' data, like owners do.
  // FIX 2026-10-29 (audit B6): elevation now ALSO requires the account's
  // email to be verified (email_verified_at set). Previously any session
  // under a whitelisted address was promoted to admin unverified, so a
  // first-come unverified registration under a whitelisted address (if it
  // had no existing user row) would have become admin. Whitelist MEMBERSHIP
  // is unchanged — see src/lib/whitelist.js.
  try {
    const { isWhitelisted } = require('../lib/whitelist');
    if (isWhitelisted(verified.user.email) && verified.user.email_verified_at && req.user.role !== 'owner') {
      req.user = { ...verified.user, role: 'admin' };
    }
  } catch (e) { /* whitelist is additive; never break auth */ }
  req.tenant = tenant;
  // Lazy-require to avoid circular import (db.js doesn't import middleware).
  req.tdb = require('../db').forTenant(tenant.id);
  next();
}

/**
 * requireAuthPage — page-route variant of requireAuth.
 *
 * Same session/tenant loading, but unauthenticated visitors are 302-redirected
 * to /login instead of receiving a 401 JSON body (a raw JSON error is a poor
 * experience for a full-page navigation). Use for HTML page routes; keep
 * requireAuth for /api/* JSON endpoints.
 */
function requireAuthPage(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  const verified = verifySession(token);
  if (!verified) {
    return res.redirect('/login');
  }
  const tenant = unscoped.getTenantById(verified.user.tenant_id);
  if (!tenant) {
    return res.redirect('/login');
  }
  req.user = verified.user;
  // Whitelisted partners get full visibility (same as API auth).
  // FIX 2026-10-29 (audit B6): same verified-email requirement as
  // requireAuth above — no admin elevation for unverified addresses.
  try {
    const { isWhitelisted } = require('../lib/whitelist');
    if (isWhitelisted(verified.user.email) && verified.user.email_verified_at && req.user.role !== 'owner') {
      req.user = { ...verified.user, role: 'admin' };
    }
  } catch (e) { /* additive only */ }
  req.tenant = tenant;
  // Lazy-require to avoid circular import (db.js doesn't import middleware).
  req.tdb = require('../db').forTenant(tenant.id);
  next();
}

/** Role guard factory: requireRole('owner'), requireRole('admin'), ... */
function requireRole(...roles) {
  const rank = { viewer: 0, admin: 1, owner: 2 };
  return (req, res, next) => {
    const need = Math.max(...roles.map(r => rank[r] ?? 99));
    const have = rank[req.user.role] ?? -1;
    if (have < need) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    next();
  };
}

module.exports = { requireAuth, requireAuthPage, requireRole };
