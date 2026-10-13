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
