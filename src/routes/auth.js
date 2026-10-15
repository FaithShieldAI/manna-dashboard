'use strict';
/**
 * Auth routes: POST /api/auth/register | /login | /logout | /verify-email
 *              GET  /api/auth/me
 *
 * Register creates a NEW tenant + owner user (self-serve signup).
 * Login is email+password with a timing-safe dummy compare for unknown users.
 */
const express = require('express');
const crypto = require('crypto');
const { unscoped, db, transaction } = require('../db');
const password = require('../lib/password');
const sessions = require('../lib/sessions');
const { authLimiter } = require('../middleware/rateLimit');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(authLimiter);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD_LEN = 12;
const PLANS = ['starter', 'pro', 'agency'];
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

const mailer = require('../lib/mailer');

function appBaseUrl(req) {
  // Used to build emailed links. Override with APP_BASE_URL in production
  // (must be the public https URL); falls back to the request host.
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
}

function slugify(name) {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'tenant';
}

function publicUser(u) {
  return { id: u.id, email: u.email, display_name: u.display_name, role: u.role, created_at: u.created_at || null };
}

// ---------------------------------------------------------------------------
router.post('/register', async (req, res) => {
  try {
    const { companyName, email, password: pw, displayName, plan } = req.body || {};

    // -- validation --------------------------------------------------------
    if (!companyName || typeof companyName !== 'string' || companyName.trim().length < 2 || companyName.length > 120) {
      return res.status(400).json({ ok: false, error: 'invalid_company_name' });
    }
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(cleanEmail) || cleanEmail.length > 254) {
      return res.status(400).json({ ok: false, error: 'invalid_email' });
    }
    if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LEN || pw.length > 128) {
      return res.status(400).json({ ok: false, error: 'password_too_short', minLength: MIN_PASSWORD_LEN });
    }
    const cleanPlan = PLANS.includes(plan) ? plan : 'starter';

    if (unscoped.getUserByEmail(cleanEmail)) {
      // Generic message — do not confirm whether the email is registered.
      return res.status(409).json({ ok: false, error: 'email_unavailable' });
    }

    // Unique slug (append suffix on collision).
    let slug = slugify(companyName);
    let attempt = 0;
    while (unscoped.getTenantBySlug(attempt ? `${slug}-${attempt}` : slug)) {
      attempt += 1;
      if (attempt > 99) return res.status(500).json({ ok: false, error: 'server_error' });
    }
    if (attempt) slug = `${slug}-${attempt}`;

    const passwordHash = await password.hash(pw);
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

    const created = transaction(() => {
      const t = unscoped.createTenant(companyName.trim(), slug, cleanPlan);
      db.prepare('UPDATE tenants SET trial_ends_at = ? WHERE id = ?').run(trialEndsAt, Number(t.lastInsertRowid));
      const u = unscoped.createUser(
        Number(t.lastInsertRowid), cleanEmail, passwordHash,
        (typeof displayName === 'string' && displayName.trim().slice(0, 80)) || null,
        'owner'
      );
      return { tenantId: Number(t.lastInsertRowid), userId: Number(u.lastInsertRowid) };
    });

    // Seed demo data for the NEW tenant immediately (tenant-scoped: only this
    // tenant is touched). A new signup must land in a populated dashboard —
    // the boot-time seeder only covers tenants that exist at server start.
    // Skipped when MANNA_SKIP_SIGNUP_SEED=1 (test harness sets this; the
    // dedicated tests/signup-seed.test.js exercises the real path).
    // A seed failure must never break registration, so errors are logged.
    if (process.env.MANNA_SKIP_SIGNUP_SEED !== '1') {
      try {
        const { seedDemoData } = require('../../scripts/seed-demo-data');
        seedDemoData(slug);
        const { seedTenantInfluencers } = require('../../scripts/seed-contacts');
        seedTenantInfluencers(created.tenantId);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[auth/register] demo seed failed for tenant', slug, ':', e.message);
      }
    }

    // Email verification token (Phase 1: returned in dev only; Phase 2: emailed).
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    db.prepare(
      'INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
    ).run(created.userId, tokenHash, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());

    // Session-fixation defense: the session identifier must change at the
    // privilege boundary. Revoke any session the client presented before
    // minting the post-registration session (no-op when none was presented).
    sessions.revokeSession(req.cookies && req.cookies[sessions.COOKIE_NAME]);
    const sess = sessions.createSession(created.userId, { ip: req.ip, userAgent: req.get('User-Agent') });
    res.cookie(sessions.COOKIE_NAME, sess.token, sessions.cookieOptions());

    // Transactional email via mailer.js — SES when configured, stub otherwise.
    // Fire-and-forget: a transient mail failure must not break registration.
    const verifyLink = `${appBaseUrl(req)}/verify?token=${rawToken}`;
    mailer.verificationEmail(cleanEmail, verifyLink)
      .catch((e) => console.error('[auth/register] verification email failed:', e.message));

    const user = unscoped.getUserById(created.userId);
    const tenant = unscoped.getTenantById(created.tenantId);
    res.status(201).json({
      ok: true,
      user: publicUser(user),
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, plan: tenant.plan },
      // DEV ONLY — never expose in production. Phase 2 sends this by email.
      ...(process.env.NODE_ENV !== 'production' ? { devVerificationToken: rawToken } : {}),
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[auth/register]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------------------------------------------------------------------------
router.post('/login', async (req, res) => {
  try {
    const { email, password: pw } = req.body || {};
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

    const user = unscoped.getUserByEmail(cleanEmail);
    // Timing-safe: always run a bcrypt compare, even for unknown users.
    const ok = user
      ? await password.verify(String(pw || ''), user.password_hash)
      : await password.verify(String(pw || ''), password.DUMMY_HASH);

    if (!ok || !user) {
      return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }

    // Session-fixation defense: revoke any session the client presented so
    // the post-login session identifier is always fresh (no-op when the
    // client presented none).
    sessions.revokeSession(req.cookies && req.cookies[sessions.COOKIE_NAME]);
    const sess = sessions.createSession(user.id, { ip: req.ip, userAgent: req.get('User-Agent') });
    res.cookie(sessions.COOKIE_NAME, sess.token, sessions.cookieOptions());
    const tenant = unscoped.getTenantById(user.tenant_id);
    res.json({
      ok: true,
      user: publicUser(user),
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, plan: tenant.plan },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[auth/login]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------------------------------------------------------------------------
router.post('/logout', (req, res) => {
  const token = req.cookies && req.cookies[sessions.COOKIE_NAME];
  sessions.revokeSession(token);
  res.clearCookie(sessions.COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
router.post('/logout-everywhere', requireAuth, (req, res) => {
  sessions.revokeAllUserSessions(req.user.id);
  res.clearCookie(sessions.COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
router.get('/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: publicUser(req.user), tenant: req.tenant });
});

// ---------------------------------------------------------------------------
router.post('/verify-email', async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ ok: false, error: 'invalid_token' });
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const row = db.prepare(
      'SELECT id, user_id, expires_at FROM email_verification_tokens WHERE token_hash = ?'
    ).get(tokenHash);
    if (!row || new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ ok: false, error: 'invalid_token' });
    }
    transaction(() => {
      db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?')
        .run(new Date().toISOString(), row.user_id);
      db.prepare('DELETE FROM email_verification_tokens WHERE id = ?').run(row.id);
    });
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[auth/verify-email]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/resend-verification — re-send the verification email.
// Requires auth (the user is logged in right after register).
// ---------------------------------------------------------------------------
router.post('/resend-verification', requireAuth, (req, res) => {
  try {
    if (req.user.email_verified_at) {
      return res.json({ ok: true, already_verified: true });
    }
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    transaction(() => {
      db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(req.user.id);
      db.prepare(
        'INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
      ).run(req.user.id, tokenHash, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
    });
    const link = `${appBaseUrl(req)}/verify?token=${rawToken}`;
    mailer.verificationEmail(req.user.email, link)
      .catch((e) => console.error('[auth/resend-verification] email failed:', e.message));
    res.json({
      ok: true,
      // DEV ONLY — never expose in production. Phase: provider sends this.
      ...(process.env.NODE_ENV !== 'production' ? { devVerificationToken: rawToken } : {}),
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[auth/resend-verification]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/forgot-password { email }
// Always returns { ok: true } — never reveals whether the email exists.
// Rate-limited by the auth limiter (shared with login/register).
// ---------------------------------------------------------------------------
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const user = EMAIL_RE.test(cleanEmail) ? unscoped.getUserByEmail(cleanEmail) : null;

    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      transaction(() => {
        db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id);
        db.prepare(
          'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
        ).run(user.id, tokenHash, new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString());
      });
      const link = `${appBaseUrl(req)}/reset?token=${rawToken}`;
      mailer.passwordResetEmail(user.email, link)
        .catch((e) => console.error('[auth/forgot-password] email failed:', e.message));
      if (process.env.NODE_ENV !== 'production') {
        return res.json({ ok: true, devResetToken: rawToken });
      }
    }
    // Identical response whether or not the account exists (no enumeration).
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[auth/forgot-password]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/reset-password { token, password }
// Single-use token, 1h expiry. On success all sessions are revoked.
// ---------------------------------------------------------------------------
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password: pw } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ ok: false, error: 'invalid_token' });
    }
    if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LEN || pw.length > 128) {
      return res.status(400).json({ ok: false, error: 'password_too_short', minLength: MIN_PASSWORD_LEN });
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const row = db.prepare(
      'SELECT id, user_id, expires_at FROM password_reset_tokens WHERE token_hash = ?'
    ).get(tokenHash);
    if (!row || new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ ok: false, error: 'invalid_token' });
    }
    const passwordHash = await password.hash(pw);
    transaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, row.user_id);
      db.prepare('DELETE FROM password_reset_tokens WHERE id = ?').run(row.id);
      // Invalidate every session — a password reset logs the user out everywhere.
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
    });
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[auth/reset-password]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
