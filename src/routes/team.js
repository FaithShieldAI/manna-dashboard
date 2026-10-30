'use strict';
/**
 * Team API — list a tenant's logins and add new ones, seat-enforced.
 *
 * GET  /api/team
 *   -> { ok, members: [{ id, email, display_name, role, created_at }],
 *        seats: { included, extra, total, used, remaining, price_label } }
 * POST /api/team  { email, displayName?, role?: 'admin'|'viewer' }
 *   -> 201 { ok, user, seats }
 *   Owner/admin only (requireRole('admin') — owners rank above admins).
 *   The new login is created with an unguessable random password and a
 *   single-use set-password link is emailed (the forgot-password flow:
 *   password_reset_tokens + mailer.passwordResetEmail), so the member
 *   chooses their own password — the owner never knows it.
 *   Refusals:
 *     400 invalid_email / invalid_role
 *     409 email_unavailable (emails are globally unique across tenants)
 *     403 seat_limit_reached — the tenant has used every seat
 *         (plan-included + purchased extras). Carries the purchase-prompt
 *         contract (upgrade_required, limit_name 'seats', limit, used,
 *         remaining) plus a plain-language message, matching the project
 *         and email limit refusals elsewhere in the API.
 *
 * Seats: see src/lib/seats.js. Every plan includes the owner's seat;
 * extra seats are $25/mo via POST /api/billing/seats/checkout.
 */
const express = require('express');
const crypto = require('crypto');
const { db, unscoped } = require('../db');
const password = require('../lib/password');
const mailer = require('../lib/mailer');
const seats = require('../lib/seats');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
// 'owner' is never grantable here — a tenant gets exactly one owner login
// at registration; team logins are admins or viewers.
const TEAM_ROLES = ['admin', 'viewer'];
const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days to accept

function appBaseUrl(req) {
  // Same rule as src/routes/auth.js: APP_BASE_URL in production, else the
  // request host — emailed links must point at the public app.
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
}

function publicMember(u) {
  return { id: u.id, email: u.email, display_name: u.display_name, role: u.role, created_at: u.created_at || null };
}

router.get('/', (req, res) => {
  const members = db.prepare(
    'SELECT id, email, display_name, role, created_at FROM users WHERE tenant_id = ? ORDER BY id'
  ).all(req.tenant.id);
  res.json({ ok: true, members: members.map(publicMember), seats: seats.getSeatState(req.tenant.id) });
});

router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const { email, displayName, role } = req.body || {};
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(cleanEmail) || cleanEmail.length > 254) {
      return res.status(400).json({ ok: false, error: 'invalid_email' });
    }
    const cleanRole = role === undefined ? 'viewer' : String(role).toLowerCase();
    if (!TEAM_ROLES.includes(cleanRole)) {
      return res.status(400).json({ ok: false, error: 'invalid_role', valid: TEAM_ROLES });
    }
    if (unscoped.getUserByEmail(cleanEmail)) {
      // Generic message — do not confirm which tenant the email sits on.
      return res.status(409).json({ ok: false, error: 'email_unavailable' });
    }

    // Seat enforcement: total = plan-included (owner's seat) + purchased
    // extras. A full house is refused BEFORE anything is created.
    const state = seats.getSeatState(req.tenant.id);
    if (state.total != null && state.used >= state.total) {
      return res.status(403).json({
        ok: false,
        error: 'seat_limit_reached',
        message:
          `All ${state.total} of your seats are in use (your plan includes ${state.included}; `
          + `${state.extra} extra purchased). Extra seats are ${state.price_label} each — `
          + 'add seats from Billing to add more team members.',
        upgrade_required: true,
        limit_name: 'seats',
        limit: state.total,
        used: state.used,
        remaining: 0,
        seats: state,
      });
    }

    // Unguessable placeholder password — never returned, never usable for
    // login in practice; the member replaces it via the emailed link.
    const placeholderHash = await password.hash(crypto.randomBytes(32).toString('hex'));
    const created = unscoped.createUser(
      req.tenant.id, cleanEmail, placeholderHash,
      (typeof displayName === 'string' && displayName.trim().slice(0, 80)) || null,
      cleanRole
    );
    const userId = Number(created.lastInsertRowid);

    // Set-password invite: same single-use token machinery as
    // forgot-password (src/routes/auth.js), longer TTL for an invite.
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    db.prepare(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
    ).run(userId, tokenHash, new Date(Date.now() + INVITE_TOKEN_TTL_MS).toISOString());
    const link = `${appBaseUrl(req)}/reset?token=${rawToken}`;
    mailer.passwordResetEmail(cleanEmail, link)
      .catch((e) => console.error('[team] invite email failed:', e.message));

    const user = unscoped.getUserById(userId);
    res.status(201).json({ ok: true, user: publicMember(user), seats: seats.getSeatState(req.tenant.id) });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[team] add member failed:', e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
