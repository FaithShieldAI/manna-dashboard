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
const { unscoped, db, transaction, forTenant } = require('../db');
const password = require('../lib/password');
const sessions = require('../lib/sessions');
const { referralLinkFor } = require('../lib/referral');
const { authLimiter, loginLimiter } = require('../middleware/rateLimit');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
// FIX 2026-10-29 (audit S3): authLimiter is NO LONGER router-wide. It used to
// cover GET /me and /logout too, so a household/office behind one NAT IP
// exhausted the shared 20/15min auth bucket just by using the dashboard
// (load test phase F: 30% of /me calls returned 429). The limiter now applies
// only to the credential routes below (register, login, verify-email,
// resend-verification, forgot-password, reset-password); session routes
// (/me, /logout, /logout-everywhere) sit outside the bucket.

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const MIN_PASSWORD_LEN = 12;
const PLANS = ['starter', 'pro', 'heavy10', 'heavy30', 'agency', 'influencer'];
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
router.post('/register', authLimiter, async (req, res) => {
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
    // Self-serve registration may only pick purchasable plans. 'influencer'
    // (Armor Bearer free-for-life) and 'agency' (invite-only) are assigned
    // server-side / by admin — never via public signup. 'pro' is retired
    // from public sale (2026-10-29): the plan key survives for existing
    // tenants, but new signups cannot pick it — this list must match the
    // self-serve checkout shelf in src/lib/plans.js (PUBLIC_PLANS).
    const SELF_SERVE_PLANS = ['starter', 'heavy10', 'heavy30'];
    const cleanPlan = SELF_SERVE_PLANS.includes(plan) ? plan : (plan === undefined ? 'starter' : null);
    if (cleanPlan === null) {
      return res.status(400).json({ ok: false, error: 'invalid_plan', valid: PLANS });
    }

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

    // Seed demo data for the NEW tenant (tenant-scoped: only this tenant is
    // touched). A new signup must land in a populated dashboard — the
    // boot-time seeder only covers tenants that exist at server start.
    // Skipped when MANNA_SKIP_SIGNUP_SEED=1 (test harness sets this; the
    // dedicated tests/signup-seed.test.js exercises the real path).
    // A seed failure must never break registration, so errors are logged.
    //
    // FIX 2026-10-29 (audit B2): the seeds used to run SYNCHRONOUSLY here,
    // before the response — seeding ~9.5k contacts per tenant serialized on
    // the request, so 50 concurrent signups took p50 ~60s each. The seeds
    // still run in full (the loaded-guns contact preload is unchanged), but
    // AFTER the 201 response, in the background (see setImmediate below).
    // Both seeds are idempotent — seedTenantInfluencers skips a tenant that
    // already has influencers, seedDemoData skips rows already present — so
    // a retried signup or a race with the boot-time seeder cannot
    // double-seed. If the process restarts before the background run fires,
    // the boot-time seeders in src/server.js cover this tenant at next boot.
    const runSignupSeeds = () => {
      if (process.env.MANNA_SKIP_SIGNUP_SEED === '1') return;
      try {
        const { seedDemoData } = require('../../scripts/seed-demo-data');
        seedDemoData(slug);
        const { seedTenantInfluencers } = require('../../scripts/seed-contacts');
        seedTenantInfluencers(created.tenantId);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[auth/register] demo seed failed for tenant', slug, ':', e.message);
      }
    };

    // Signup attribution: link the new account back to its visit session so
    // we know which landing page converted. Fire-and-forget, never breaks
    // registration.
    try {
      const { SESSION_COOKIE } = require('../middleware/visitTracking');
      const sessionId = req.cookies && req.cookies[SESSION_COOKIE];
      let landingPath = null;
      if (sessionId) {
        const v = db.prepare(
          'SELECT path FROM site_visits WHERE session_id = ? ORDER BY id ASC LIMIT 1'
        ).get(sessionId);
        if (v) landingPath = v.path;
      }
      db.prepare(`
        INSERT INTO signup_events (tenant_id, user_id, session_id, landing_path, referrer)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        created.tenantId, created.userId,
        sessionId || null, landingPath,
        (req.get('referer') || '').slice(0, 500)
      );
    } catch (e) {
      console.error('[auth/register] signup attribution failed:', e.message);
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
    // FIX 2026-10-29 (audit B2): fire the (idempotent) tenant seeds in the
    // background now that the 201 is on the wire — signup answers in
    // well under a second instead of after ~9.5k seed inserts.
    setImmediate(runSignupSeeds);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[auth/register]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------------------------------------------------------------------------
router.post('/login', authLimiter, loginLimiter, async (req, res) => {
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
  const tenant = { ...req.tenant };
  // Armor Bearer affiliates (provisioned via the AB -> Manna webhook) get
  // their personal referral link, constructed server-side from the ref
  // code stored on the tenant (migration 024). The stored code is
  // re-validated at construction (src/lib/referral.js): a missing or
  // poisoned value yields NO referral_link field at all, and the
  // dashboard card keeps its honest empty state.
  try {
    const row = db.prepare('SELECT armor_bearer_id FROM tenants WHERE id = ?').get(req.tenant.id);
    const link = referralLinkFor(row && row.armor_bearer_id);
    if (link) tenant.referral_link = link;
  } catch (e) { /* unmigrated DB: no link field, card empty state stands */ }
  res.json({ ok: true, user: publicUser(req.user), tenant });
});

// ---------------------------------------------------------------------------
// Self-service account deletion. Deletes the user, revokes all their
// sessions, and removes the tenant if they were its last user.
router.delete('/me', requireAuth, (req, res) => {
  try {
    const userId = req.user.id;
    const tenantId = req.user.tenant_id;
    const { db } = require('../db');

    sessions.revokeAllUserSessions(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);

    const remaining = db.prepare('SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?').get(tenantId);
    if (remaining.n === 0) {
      db.prepare('DELETE FROM tenants WHERE id = ?').run(tenantId);
    }

    res.clearCookie(sessions.COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'delete_failed' });
  }
});

// ---------------------------------------------------------------------------
router.post('/verify-email', authLimiter, async (req, res) => {
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
router.post('/resend-verification', authLimiter, requireAuth, (req, res) => {
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
router.post('/forgot-password', authLimiter, async (req, res) => {
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
router.post('/reset-password', authLimiter, async (req, res) => {
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

// ---------------------------------------------------------------------------
// FIX 2026-10-29 (audit B1 — security): the emergency/migration block below
// was gated by a HARDCODED token literal in source, and emergency-login
// created/logged-in an owner account with a HARDCODED password behind a
// module-level used-flag that reset on every restart.
//   - GET /emergency-debug (unauthenticated, leaked user emails): DELETED.
//   - GET /emergency-login/:token (owner login, hardcoded password): DELETED.
//   - The hardcoded token, the used-flag, and every hardcoded password are
//     gone from this file.
// The three migration routes REMAIN only because the 30-minute backup /
// self-heal script (hidden_files/manna_backup/backup_manna.py) depends on
// export/import/cleanup for wipe recovery. They are now gated by the
// MIGRATION_TOKEN environment variable, read at call time and compared in
// constant time, FAILING CLOSED (503) when the env var is unset. The backup
// script reads the same value from its own token file
// (hidden_files/manna_backup/.migration_token); the deploy must set
// MIGRATION_TOKEN on Render to match it. Owner-account seeding in
// import/cleanup no longer invents a password: it reads
// OWNER_SEED_PASSWORD_MICHAEL / OWNER_SEED_PASSWORD_LEON and SKIPS creation
// (with a warning) when the relevant variable is unset.
// ---------------------------------------------------------------------------
function requireMigrationToken(req, res, next) {
  const expected = process.env.MIGRATION_TOKEN;
  if (!expected) {
    return res.status(503).json({ ok: false, error: 'migration_not_configured' });
  }
  const provided = Buffer.from(String(req.params.token || ''));
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length || !crypto.timingSafeEqual(provided, wanted)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  return next();
}

// Ensure an owner account exists for `email`, using ONLY the password from
// the named env var. Never invents a password: returns 'skipped_no_password'
// when the env var is unset so the caller can log/skip safely.
async function ensureOwnerFromEnv(email, envVar, tenantId) {
  const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email);
  if (existing) return 'exists';
  const pw = process.env[envVar];
  if (!pw) {
    // eslint-disable-next-line no-console
    console.warn(`[auth/migration] ${envVar} is not set — skipping owner account creation for ${email}`);
    return 'skipped_no_password';
  }
  const hash = await password.hash(pw);
  db.prepare("INSERT INTO users (tenant_id, email, password_hash, role) VALUES (?, ?, ?, 'owner')")
    .run(tenantId, email, hash);
  return 'created';
}

// Migration: export tenant data (backup/self-heal only — token-gated, B1)
router.get('/migration-export/:token', requireMigrationToken, (req, res) => {
  try {
    const tables = ['tenants', 'users', 'sites', 'site_daily_metrics', 'site_events',
      'site_visits', 'signup_events', 'email_snapshots', 'email_campaigns',
      'funnels', 'funnel_stages', 'influencers', 'ip_assets', 'social_accounts',
      'goals', 'tenant_usage', 'collection_jobs', 'tenant_onboarding',
      'connected_socials', 'email_templates', 'social_templates',
      'content_items', 'content_postings', 'pr_events'];
    
    const result = {};
    for (const t of tables) {
      try {
        const exists = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
        ).get(t);
        if (!exists) { result[t] = { skipped: 'no table' }; continue; }
        const rows = db.prepare(`SELECT * FROM ${t}`).all();
        result[t] = rows;
      } catch (e) {
        result[t] = { error: e.message };
      }
    }
    res.json({ ok: true, exported_at: new Date().toISOString(), data: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Email snapshot sync (token-gated, same MIGRATION_TOKEN pattern as the
// migration routes above): the external mail-truth chain
// (hidden_files/email_analytics/manna_snapshot_refresh.py) computes the
// combined outgoing-mail windows from every sending pipe — the four
// provider APIs, the Amazon SES ledgers, Outlook sends, the mailbox
// bounce/reply harvest, and Manna's own pr_events export — using the same
// math as the private dashboard generator, and posts them here. This
// endpoint validates and upserts them into email_snapshots for ONE tenant
// (resolved by tenant_email or tenant_id) so GET /api/email/windows and
// the private dashboard show identical combined numbers on the same
// cycle. It deliberately does NOT add this app's email_campaigns rows on
// top: those rows are a seeded subset and do not reconcile to the
// provider totals (verified 2026-11-04 against a live export), so adding
// them would double-count. As an independent check, the response carries
// pr_events window totals computed from this app's own pr_events table.
const EMAIL_WINDOW_KEYS = ['24h', '7d', '30d', 'all'];
const EMAIL_WINDOW_DAYS = { '24h': 1, '7d': 7, '30d': 30, 'all': null };

function _snapshotCount(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 100000000 ? n : null;
}

function _prEventWindows() {
  const cutoff = (days) => (days == null ? null : Math.floor(Date.now() / 1000) - days * 86400);
  const out = {};
  for (const key of EMAIL_WINDOW_KEYS) {
    const since = cutoff(EMAIL_WINDOW_DAYS[key]);
    const row = db.prepare(`
      SELECT COALESCE(SUM(kind = 'open'), 0) AS opens,
             COALESCE(SUM(kind = 'click'), 0) AS clicks
      FROM pr_events
      WHERE email IS NOT NULL AND (? IS NULL OR ts >= ?)`).get(since, since);
    out[key] = { opens: row.opens, clicks: row.clicks };
  }
  return out;
}

router.post('/email-snapshots-sync/:token', requireMigrationToken, express.json({ limit: '1mb' }), (req, res) => {
  try {
    const body = req.body || {};
    let tenantId = null;
    if (body.tenant_email) {
      const user = db.prepare('SELECT tenant_id FROM users WHERE LOWER(email) = LOWER(?)')
        .get(String(body.tenant_email));
      if (!user) return res.status(404).json({ ok: false, error: 'tenant_not_found' });
      tenantId = Number(user.tenant_id);
    } else if (body.tenant_id !== undefined) {
      tenantId = Number(body.tenant_id);
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_tenant_id' });
      }
    } else {
      return res.status(400).json({ ok: false, error: 'tenant_required' });
    }
    const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: 'tenant_not_found' });

    const windows = body.windows;
    if (!windows || typeof windows !== 'object') {
      return res.status(400).json({ ok: false, error: 'windows_required' });
    }
    const cleaned = {};
    for (const key of EMAIL_WINDOW_KEYS) {
      const w = windows[key];
      if (!w || typeof w !== 'object') {
        return res.status(400).json({ ok: false, error: `window_missing:${key}` });
      }
      const unsubs = w.unsubs !== undefined ? w.unsubs : w.opt_outs;
      const metrics = {
        sent: _snapshotCount(w.sent),
        opens: _snapshotCount(w.opens),
        clicks: _snapshotCount(w.clicks),
        unsubs: _snapshotCount(unsubs),
        bounces: _snapshotCount(w.bounces),
        replies: _snapshotCount(w.replies),
      };
      for (const [field, value] of Object.entries(metrics)) {
        if (value === null) {
          return res.status(400).json({ ok: false, error: `invalid_metric:${key}.${field}` });
        }
      }
      let warmTotal = null;
      let warmByLangJson = null;
      if (w.warm_total !== undefined) {
        warmTotal = _snapshotCount(w.warm_total);
        if (warmTotal === null) {
          return res.status(400).json({ ok: false, error: `invalid_metric:${key}.warm_total` });
        }
      }
      if (w.warm_by_lang !== undefined) {
        if (!w.warm_by_lang || typeof w.warm_by_lang !== 'object' || Array.isArray(w.warm_by_lang)) {
          return res.status(400).json({ ok: false, error: `invalid_metric:${key}.warm_by_lang` });
        }
        const byLang = {};
        for (const [lang, count] of Object.entries(w.warm_by_lang)) {
          const c = _snapshotCount(count);
          if (c === null) {
            return res.status(400).json({ ok: false, error: `invalid_metric:${key}.warm_by_lang` });
          }
          byLang[String(lang).slice(0, 40)] = c;
        }
        warmByLangJson = JSON.stringify(byLang);
        if (warmTotal === null) warmTotal = Object.values(byLang).reduce((a, b) => a + b, 0);
      }
      cleaned[key] = { ...metrics, warmTotal, warmByLangJson };
    }

    const existing = {};
    for (const r of db.prepare('SELECT window_key, warm_total, warm_by_lang_json FROM email_snapshots WHERE tenant_id = ?').all(tenantId)) {
      existing[r.window_key] = r;
    }
    const upsert = db.prepare(`
      INSERT INTO email_snapshots
        (tenant_id, window_key, sent, opens, clicks, unsubs, bounces, replies, warm_total, warm_by_lang_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, window_key) DO UPDATE SET
        sent = excluded.sent, opens = excluded.opens, clicks = excluded.clicks,
        unsubs = excluded.unsubs, bounces = excluded.bounces, replies = excluded.replies,
        warm_total = excluded.warm_total, warm_by_lang_json = excluded.warm_by_lang_json,
        captured_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
    transaction(() => {
      for (const key of EMAIL_WINDOW_KEYS) {
        const c = cleaned[key];
        upsert.run(tenantId, key, c.sent, c.opens, c.clicks, c.unsubs, c.bounces, c.replies,
          c.warmTotal !== null ? c.warmTotal : (existing[key] ? existing[key].warm_total : 0),
          c.warmByLangJson !== null ? c.warmByLangJson : (existing[key] ? existing[key].warm_by_lang_json : '{}'));
      }
    });

    const rows = db.prepare(
      'SELECT window_key, sent, opens, clicks, unsubs, bounces, replies, warm_total, warm_by_lang_json, captured_at FROM email_snapshots WHERE tenant_id = ?'
    ).all(tenantId);
    const stored = {};
    for (const r of rows) {
      stored[r.window_key] = {
        sent: r.sent, opens: r.opens, clicks: r.clicks,
        unsubs: r.unsubs, opt_outs: r.unsubs,
        bounces: r.bounces, replies: r.replies,
        open_rate: r.sent > 0 ? +(100 * r.opens / r.sent).toFixed(1) : 0,
        click_rate: r.sent > 0 ? +(100 * r.clicks / r.sent).toFixed(1) : 0,
        optout_rate: r.sent > 0 ? +(100 * r.unsubs / r.sent).toFixed(2) : 0,
        captured_at: r.captured_at,
      };
    }
    res.json({
      ok: true,
      tenant_id: tenantId,
      windows: stored,
      server_pr_event_windows: _prEventWindows(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// IP registry sync (token-gated, same MIGRATION_TOKEN pattern as the
// snapshot sync above): the house IP registry file
// (files/ip-registry/registry.json, the same source the private
// dashboard reads) is mirrored into the tenant's ip_assets so Manna's
// IP Registry tab shows the real registry instead of an empty table.
// Replace-all per sync: the file stays the single source of truth and
// Manna holds its copy. Validation mirrors the IP registry route's
// type/status vocabularies and the ip_assets column checks.
const IP_ASSET_TYPES = ['copyright', 'trademark', 'patent', 'trade_secret', 'domain', 'other'];
const IP_ASSET_STATUSES = ['idea', 'created-unregistered', 'filed-pending', 'registered', 'licensed'];

function _cleanIpAsset(a, i) {
  const bad = (field) => {
    const err = new Error(`invalid_asset:${i}.${field}`);
    err.status = 400;
    throw err;
  };
  if (!a || typeof a !== 'object' || Array.isArray(a)) bad('asset');
  const title = typeof a.title === 'string' ? a.title.trim() : '';
  if (!title || title.length > 300) bad('title');
  let description = null;
  if (a.description !== undefined && a.description !== null) {
    if (typeof a.description !== 'string' || a.description.length > 4000) bad('description');
    description = a.description;
  }
  if (!IP_ASSET_TYPES.includes(a.asset_type)) bad('asset_type');
  if (!IP_ASSET_STATUSES.includes(a.status)) bad('status');
  let contentHash = null;
  if (a.content_hash !== undefined && a.content_hash !== null) {
    if (typeof a.content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(a.content_hash)) bad('content_hash');
    contentHash = a.content_hash;
  }
  let createdAt = null;
  if (a.created_at !== undefined && a.created_at !== null) {
    if (typeof a.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(a.created_at)) bad('created_at');
    createdAt = a.created_at.slice(0, 10);
  }
  return { title, description, assetType: a.asset_type, status: a.status, contentHash, createdAt };
}

router.post('/ip-registry-sync/:token', requireMigrationToken, express.json({ limit: '1mb' }), (req, res) => {
  try {
    const body = req.body || {};
    let tenantId = null;
    if (body.tenant_email) {
      const user = db.prepare('SELECT tenant_id FROM users WHERE LOWER(email) = LOWER(?)')
        .get(String(body.tenant_email));
      if (!user) return res.status(404).json({ ok: false, error: 'tenant_not_found' });
      tenantId = Number(user.tenant_id);
    } else if (body.tenant_id !== undefined) {
      tenantId = Number(body.tenant_id);
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_tenant_id' });
      }
    } else {
      return res.status(400).json({ ok: false, error: 'tenant_required' });
    }
    const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: 'tenant_not_found' });

    if (!Array.isArray(body.assets) || body.assets.length === 0 || body.assets.length > 500) {
      return res.status(400).json({ ok: false, error: 'assets_required' });
    }
    const cleaned = body.assets.map((a, i) => _cleanIpAsset(a, i));

    const insert = db.prepare(`
      INSERT INTO ip_assets (tenant_id, title, description, asset_type, status, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
    transaction(() => {
      db.prepare('DELETE FROM ip_assets WHERE tenant_id = ?').run(tenantId);
      for (const a of cleaned) {
        insert.run(tenantId, a.title, a.description, a.assetType, a.status, a.contentHash, a.createdAt);
      }
    });

    const rows = db.prepare(
      'SELECT id, title, description, asset_type, status, content_hash, created_at FROM ip_assets WHERE tenant_id = ? ORDER BY created_at DESC'
    ).all(tenantId);
    res.json({ ok: true, tenant_id: tenantId, count: rows.length, assets: rows });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// Contacts mirror sync (token-gated, same MIGRATION_TOKEN pattern as the
// IP registry sync above): the collectors' email database
// (hidden_files/email-database.db) stays the single source of truth for
// the house contact list; the chain mirrors it into the D2RM tenant's
// influencers table so Manna's collected counts and lead pipelines show
// the real list instead of only the rows typed into Manna by hand.
// Unlike the IP registry's replace-all, this mirror UPSERTS by
// (tenant_id, LOWER(email)) and never deletes: rows the mirror does not
// know about (hand-curated rows, family-office seeds) stay untouched.
// Category/tier/status mapping reuses src/lib/syncD2rm.js, the same
// mapping the one-shot admin import uses; rows this mirror inserts or
// refreshes carry source 'd2rm-email-mirror'.
const { mapCategory, mapTier, mapStatus, GOALS } = require('../lib/syncD2rm');
const CONTACT_SOURCE_CATEGORIES = [
  'influencer', 'podcast', 'pastor', 'org', 'attorney', 'other', 'handles', 'family_office',
];
const CONTACTS_MIRROR_SOURCE = 'd2rm-email-mirror';

function _cleanContact(c, i) {
  const bad = (field) => {
    const err = new Error(`invalid_contact:${i}.${field}`);
    err.status = 400;
    throw err;
  };
  if (!c || typeof c !== 'object' || Array.isArray(c)) bad('contact');
  if (typeof c.email !== 'string' || !c.email.includes('@') || c.email.length > 320) bad('email');
  if (!CONTACT_SOURCE_CATEGORIES.includes(c.category)) bad('category');
  const optStr = (v, field, max) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || v.length > max) bad(field);
    return v;
  };
  return {
    email: c.email.trim(),
    name: optStr(c.name, 'name', 500),
    category: c.category,
    subcategory: optStr(c.subcategory, 'subcategory', 200),
    notes: optStr(c.notes, 'notes', 8000),
    sourceFile: optStr(c.source_file, 'source_file', 500),
  };
}

router.post('/contacts-sync/:token', requireMigrationToken, express.json({ limit: '5mb' }), (req, res) => {
  try {
    const body = req.body || {};
    let tenantId = null;
    if (body.tenant_email) {
      const user = db.prepare('SELECT tenant_id FROM users WHERE LOWER(email) = LOWER(?)')
        .get(String(body.tenant_email));
      if (!user) return res.status(404).json({ ok: false, error: 'tenant_not_found' });
      tenantId = Number(user.tenant_id);
    } else if (body.tenant_id !== undefined) {
      tenantId = Number(body.tenant_id);
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_tenant_id' });
      }
    } else {
      return res.status(400).json({ ok: false, error: 'tenant_required' });
    }
    const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: 'tenant_not_found' });

    if (!Array.isArray(body.contacts) || body.contacts.length === 0 || body.contacts.length > 1000) {
      return res.status(400).json({ ok: false, error: 'contacts_required' });
    }
    const cleaned = body.contacts.map((c, i) => _cleanContact(c, i));

    const findByEmail = db.prepare(
      'SELECT id FROM influencers WHERE tenant_id = ? AND LOWER(email) = LOWER(?)');
    const insertStmt = db.prepare(`
      INSERT INTO influencers
        (tenant_id, handle, platform, email, tier, category, status, notes, source)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`);
    const updateStmt = db.prepare(`
      UPDATE influencers SET
        handle = ?, tier = ?, category = ?, status = ?, notes = ?, source = ?
      WHERE id = ? AND tenant_id = ?`);

    let inserted = 0, updated = 0;
    transaction(() => {
      for (const c of cleaned) {
        const category = c.category === 'family_office'
          ? 'family_office'
          : mapCategory(c.category);
        const tier = mapTier(c.subcategory);
        const status = mapStatus(c.notes);
        const handle = (c.name && c.name.trim())
          ? c.name.trim().slice(0, 200)
          : c.email.split('@')[0];
        const existing = findByEmail.get(tenantId, c.email);
        if (existing) {
          updateStmt.run(handle, tier, category, status, c.notes,
            CONTACTS_MIRROR_SOURCE, existing.id, tenantId);
          updated++;
        } else {
          insertStmt.run(tenantId, handle, c.email, tier, category, status,
            c.notes, CONTACTS_MIRROR_SOURCE);
          inserted++;
        }
      }
    });

    res.json({
      ok: true,
      tenant_id: tenantId,
      received: cleaned.length,
      inserted,
      updated,
      total_in_tenant: forTenant(tenantId).leadTotal(),
    });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// Goals cleanup (token-gated, same MIGRATION_TOKEN pattern as the
// contacts mirror above): the retired D2RM import planted a 'sustained'
// goal row in the house tenant before Sustained left the suite on
// 2026-10-28. The import no longer seeds that goal (see GOALS in
// src/lib/syncD2rm.js); this endpoint removes the already-planted row.
// It deletes ONLY goal_key = 'sustained' for the named tenant, and in
// the same pass inserts-if-missing the two suite goals the import now
// seeds ('mannaai', 'two_fishes', definitions taken from GOALS there)
// so the tenant's grid is complete without an admin sync. Existing
// rows are never overwritten. Idempotent: a second call reports
// removed: 0 and added: [].
router.post('/goals-cleanup/:token', requireMigrationToken, express.json({ limit: '64kb' }), (req, res) => {
  try {
    const body = req.body || {};
    let tenantId = null;
    if (body.tenant_email) {
      const user = db.prepare('SELECT tenant_id FROM users WHERE LOWER(email) = LOWER(?)')
        .get(String(body.tenant_email));
      if (!user) return res.status(404).json({ ok: false, error: 'tenant_not_found' });
      tenantId = Number(user.tenant_id);
    } else if (body.tenant_id !== undefined) {
      tenantId = Number(body.tenant_id);
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_tenant_id' });
      }
    } else {
      return res.status(400).json({ ok: false, error: 'tenant_required' });
    }
    const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: 'tenant_not_found' });

    const info = db.prepare(
      "DELETE FROM goals WHERE tenant_id = ? AND goal_key = 'sustained'"
    ).run(tenantId);

    const added = [];
    const findGoal = db.prepare(
      'SELECT id FROM goals WHERE tenant_id = ? AND goal_key = ?');
    const insertGoal = db.prepare(`
      INSERT INTO goals (tenant_id, goal_key, label, current_value, goal_value, unit)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const g of GOALS) {
      if (g.goal_key !== 'mannaai' && g.goal_key !== 'two_fishes') continue;
      if (findGoal.get(tenantId, g.goal_key)) continue;
      insertGoal.run(tenantId, g.goal_key, g.label, g.current_value, g.goal_value, g.unit);
      added.push(g.goal_key);
    }

    res.json({ ok: true, tenant_id: tenantId, removed: Number(info.changes), added });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// Migration: import migrated data (backup/self-heal only — token-gated, B1)
// Live windows sync (token-gated, same MIGRATION_TOKEN pattern as the
// snapshot sync above): the analytics VM's live service
// (email_analytics/live_windows.py) computes the combined outgoing-mail
// windows from fresh pipe pulls every ~60s and pushes the payload here.
// Stored per tenant in live_windows (migration 035). Read paths serve
// it while fresh and label it 'live' with its as_of; the snapshot rows
// stay as the labeled fallback. Validation mirrors the snapshot sync:
// the standard column set must be present and numeric per window.
router.post('/live-windows-sync/:token', requireMigrationToken, express.json({ limit: '1mb' }), (req, res) => {
  try {
    const body = req.body || {};
    let tenantId = null;
    if (body.tenant_email) {
      const user = db.prepare('SELECT tenant_id FROM users WHERE LOWER(email) = LOWER(?)')
        .get(String(body.tenant_email));
      if (!user) return res.status(404).json({ ok: false, error: 'tenant_not_found' });
      tenantId = Number(user.tenant_id);
    } else if (body.tenant_id !== undefined) {
      tenantId = Number(body.tenant_id);
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_tenant_id' });
      }
    } else {
      return res.status(400).json({ ok: false, error: 'tenant_required' });
    }
    const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: 'tenant_not_found' });

    const payload = body.payload;
    if (!payload || typeof payload !== 'object' || !payload.windows || typeof payload.windows !== 'object') {
      return res.status(400).json({ ok: false, error: 'payload_required' });
    }
    for (const key of EMAIL_WINDOW_KEYS) {
      const w = payload.windows[key];
      if (!w || typeof w !== 'object') {
        return res.status(400).json({ ok: false, error: `window_missing:${key}` });
      }
      for (const field of ['sent', 'opens', 'clicks', 'unsub', 'bounces', 'replies']) {
        if (_snapshotCount(w[field]) === null) {
          return res.status(400).json({ ok: false, error: `invalid_metric:${key}.${field}` });
        }
      }
    }
    const { storeLiveWindows } = require('../lib/liveWindows');
    const receivedAt = storeLiveWindows(tenantId, {
      as_of: typeof payload.as_of === 'string' ? payload.as_of : null,
      windows: payload.windows,
      sources: (payload.sources && typeof payload.sources === 'object') ? payload.sources : {},
    });
    res.json({ ok: true, tenant_id: tenantId, received_at: receivedAt, as_of: payload.as_of || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Public live-windows read for the private dashboard page: a static
// page on another origin, holding no session, so it is guarded by its
// own read token (LIVE_WINDOWS_READ_TOKEN) and serves aggregate house
// counts only. The stored payload is served as-is with its as_of: the
// page displays that as_of as data, so staleness is visible, never
// hidden. 404 (not 403) on any token problem, same don't-oracle rule
// as the tracker beacon.
router.get('/live-windows', (req, res) => {
  const expected = process.env.LIVE_WINDOWS_READ_TOKEN;
  if (!expected) return res.status(404).json({ ok: false, error: 'not_found' });
  const provided = Buffer.from(String(req.query.k || ''));
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length || !crypto.timingSafeEqual(provided, wanted)) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }
  const email = process.env.LIVE_WINDOWS_TENANT_EMAIL || 'michael@faithshield.ai';
  const user = db.prepare('SELECT tenant_id FROM users WHERE LOWER(email) = LOWER(?)').get(email);
  if (!user) return res.status(404).json({ ok: false, error: 'not_found' });
  const { readLiveWindows } = require('../lib/liveWindows');
  const live = readLiveWindows(Number(user.tenant_id));
  if (!live) return res.status(404).json({ ok: false, error: 'no_live_windows' });
  res.set('Access-Control-Allow-Origin', 'https://dashboard.d2rmmedia.com');
  res.json({
    ok: true,
    as_of: live.payload.as_of || null,
    received_at: live.received_at,
    fresh: live.fresh,
    windows: live.payload.windows,
    sources: live.payload.sources || {},
  });
});

// Dashboard payload sync (token-gated, same MIGRATION_TOKEN pattern as
// the snapshot sync above): the analytics VM's mail-truth chain rebuilds
// the private dashboard's tab panels every ~10 minutes and pushes them
// here (publish_dashboard_payload.py). The static dashboard page
// fetches the payload at view time and swaps each panel's contents, so
// a failed git push in the old chain can no longer stale the page. The
// payload is exactly what the baked page already shows, nothing more.
// Stored per tenant in dashboard_payloads (migration 036).
router.post('/dashboard-payload-sync/:token', requireMigrationToken, express.json({ limit: '8mb' }), (req, res) => {
  try {
    const body = req.body || {};
    let tenantId = null;
    if (body.tenant_email) {
      const user = db.prepare('SELECT tenant_id FROM users WHERE LOWER(email) = LOWER(?)')
        .get(String(body.tenant_email));
      if (!user) return res.status(404).json({ ok: false, error: 'tenant_not_found' });
      tenantId = Number(user.tenant_id);
    } else if (body.tenant_id !== undefined) {
      tenantId = Number(body.tenant_id);
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_tenant_id' });
      }
    } else {
      return res.status(400).json({ ok: false, error: 'tenant_required' });
    }
    const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: 'tenant_not_found' });

    const payload = body.payload;
    if (!payload || typeof payload !== 'object' || !payload.sections || typeof payload.sections !== 'object') {
      return res.status(400).json({ ok: false, error: 'payload_required' });
    }
    const sectionIds = Object.keys(payload.sections);
    if (!sectionIds.length) {
      return res.status(400).json({ ok: false, error: 'sections_empty' });
    }
    for (const id of sectionIds) {
      if (typeof payload.sections[id] !== 'string') {
        return res.status(400).json({ ok: false, error: `section_not_string:${id}` });
      }
    }
    const { storeDashboardPayload } = require('../lib/dashboardPayload');
    const receivedAt = storeDashboardPayload(tenantId, {
      generated_at: typeof payload.generated_at === 'string' ? payload.generated_at : null,
      sections: payload.sections,
    });
    res.json({ ok: true, tenant_id: tenantId, received_at: receivedAt, generated_at: payload.generated_at || null, sections: sectionIds.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Public dashboard-payload read for the private dashboard page: same
// read-token guard and don't-oracle rule as the live-windows read
// above. Serves the stored payload as-is with its generated_at: the
// page displays that stamp as data, so staleness is visible, never
// hidden.
router.get('/dashboard-payload', (req, res) => {
  const expected = process.env.LIVE_WINDOWS_READ_TOKEN;
  if (!expected) return res.status(404).json({ ok: false, error: 'not_found' });
  const provided = Buffer.from(String(req.query.k || ''));
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length || !crypto.timingSafeEqual(provided, wanted)) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }
  const email = process.env.LIVE_WINDOWS_TENANT_EMAIL || 'michael@faithshield.ai';
  const user = db.prepare('SELECT tenant_id FROM users WHERE LOWER(email) = LOWER(?)').get(email);
  if (!user) return res.status(404).json({ ok: false, error: 'not_found' });
  const { readDashboardPayload } = require('../lib/dashboardPayload');
  const stored = readDashboardPayload(Number(user.tenant_id));
  if (!stored) return res.status(404).json({ ok: false, error: 'no_dashboard_payload' });
  res.set('Access-Control-Allow-Origin', 'https://dashboard.d2rmmedia.com');
  res.json({
    ok: true,
    as_of: stored.payload.generated_at || null,
    received_at: stored.received_at,
    fresh: stored.fresh,
    sections: stored.payload.sections,
  });
});

// Lead collect sync (token-gated, same MIGRATION_TOKEN pattern as the
// sync routes above): runs one of Manna's own lead collectors on the
// server for one tenant, so VM-side automation collects exactly the
// way the in-app Leads page does (same job pipeline: validation, the
// active-job cap, the collector, deduped ingest, a collection_jobs
// record the tenant sees on the Leads page). Michael (2026-11-08):
// family office investor lead collection runs through MannaAi instead
// of Muse-side browser work ("Use MannaAi to do this. Saves me
// approving cards and gets us using MannaAi").
//
// The 'family_office' source (migration 037) runs the web-list
// collector over published seed URLs and files the leads under the
// family_office category. Run in background like
// POST /api/leads/jobs/:id/run: acknowledge with the job, then ingest;
// poll GET /api/auth/lead-collect-sync/:token/jobs/:id for the result.
// NOTE: this path must skip the global 256kb JSON parser exactly like
// dashboard-payload-sync (see src/server.js): the route mounts its
// own parser below, and seed payloads stay small regardless.
router.post('/lead-collect-sync/:token', requireMigrationToken, express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const body = req.body || {};
    let tenantId = null;
    if (body.tenant_email) {
      const user = db.prepare('SELECT tenant_id FROM users WHERE LOWER(email) = LOWER(?)')
        .get(String(body.tenant_email));
      if (!user) return res.status(404).json({ ok: false, error: 'tenant_not_found' });
      tenantId = Number(user.tenant_id);
    } else if (body.tenant_id !== undefined) {
      tenantId = Number(body.tenant_id);
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_tenant_id' });
      }
    } else {
      return res.status(400).json({ ok: false, error: 'tenant_required' });
    }
    const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: 'tenant_not_found' });

    const source = String(body.source || '');
    if (source !== 'family_office') {
      return res.status(400).json({ ok: false, error: 'invalid_source', valid: ['family_office'] });
    }
    const seeds = Array.isArray(body.seeds)
      ? body.seeds.map(String).map(s => s.trim()).filter(Boolean).slice(0, 25)
      : [];
    if (!seeds.length) {
      return res.status(400).json({ ok: false, error: 'seeds_required' });
    }
    const maxResults = Math.min(Math.max(parseInt(body.max_results, 10) || 25, 1), 100);

    const leadsRoute = require('./leads');
    const tdb = forTenant(tenantId);
    const created = leadsRoute.createJob(tdb, { source, seeds, maxResults });
    if (created.error) return res.status(created.error.status).json(created.error.body);
    const row = tdb.getCollectionJob(created.job.id);
    tdb.updateCollectionJob(created.job.id, { status: 'running', started_at: new Date().toISOString(), error: null });
    setImmediate(() => {
      leadsRoute.runJob(tdb, { ...row, status: 'running' }).catch(e => {
        console.error('[lead-collect-sync] background error:', e);
      });
    });
    res.status(202).json({ ok: true, tenant_id: tenantId, job: created.job });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Poll a lead-collect-sync job (same token gate). Serves the job
// status plus the tenant's family_office census, so the caller can
// verify the collection landed without a session.
router.get('/lead-collect-sync/:token/jobs/:id', requireMigrationToken, (req, res) => {
  try {
    const email = process.env.LIVE_WINDOWS_TENANT_EMAIL || 'michael@faithshield.ai';
    const user = db.prepare('SELECT tenant_id FROM users WHERE LOWER(email) = LOWER(?)').get(email);
    if (!user) return res.status(404).json({ ok: false, error: 'tenant_not_found' });
    const tdb = forTenant(Number(user.tenant_id));
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'invalid_job_id' });
    const leadsRoute = require('./leads');
    const job = leadsRoute.publicJob(tdb.getCollectionJob(id));
    if (!job) return res.status(404).json({ ok: false, error: 'job_not_found' });
    const counts = tdb.influencerCategoryCounts();
    const fo = counts.find(r => r.category === 'family_office');
    res.json({ ok: true, job, family_office_count: fo ? fo.n : 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Reject one collected lead (same token gate): the vetting stage of
// the family office funnel (Michael, 2026-11-08: "No job emails. Keep
// those out." — the Blue Trust row the collector found is an HR
// inbox, not an investor route). Reversible, same as the in-app
// Vetted tab's reject: status flips to 'rejected', the row and its
// provenance stay on record, and the dedupe set keeps the address
// out of future runs.
router.post('/lead-collect-sync/:token/reject', requireMigrationToken, express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const email = String(body.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ ok: false, error: 'email_required' });
    let tenantId = null;
    if (body.tenant_email) {
      const user = db.prepare('SELECT tenant_id FROM users WHERE LOWER(email) = LOWER(?)')
        .get(String(body.tenant_email));
      if (!user) return res.status(404).json({ ok: false, error: 'tenant_not_found' });
      tenantId = Number(user.tenant_id);
    } else if (body.tenant_id !== undefined) {
      tenantId = Number(body.tenant_id);
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_tenant_id' });
      }
    } else {
      return res.status(400).json({ ok: false, error: 'tenant_required' });
    }
    const tdb = forTenant(tenantId);
    const row = db.prepare('SELECT id FROM influencers WHERE tenant_id = ? AND LOWER(email) = ?')
      .get(tenantId, email);
    if (!row) return res.status(404).json({ ok: false, error: 'lead_not_found' });
    tdb.setInfluencerStatus(row.id, 'rejected');
    const counts = tdb.influencerCategoryCounts();
    const fo = counts.find(r => r.category === 'family_office');
    res.json({ ok: true, id: row.id, email, status: 'rejected', family_office_count: fo ? fo.n : 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/migration-import/:token', requireMigrationToken, express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const importData = req.body.data;
    if (!importData) return res.status(400).json({ ok: false, error: 'No data' });
    
    // Get or create the production tenant
    let tenant = db.prepare('SELECT id FROM tenants LIMIT 1').get();
    if (!tenant) {
      const t = db.prepare("INSERT INTO tenants (name, slug) VALUES ('D2RM', 'd2rm')").run();
      tenant = { id: t.lastInsertRowid };
    }
    const newTenantId = tenant.id;
    const oldTenantId = 1; // staging tenant id
    
    const results = {};
    
    // Tables to migrate (skip sessions, password_reset_tokens, email_verification_tokens - ephemeral)
    // content_items handled separately via video loader; users/tenants handled below
    const tables = {
      'email_campaigns': ['name', 'provider', 'sent', 'opens', 'clicks', 'unsubs', 'bounces', 'sent_at', 'created_at', 'cost_cents', 'revenue_cents', 'product', 'language', 'audience', 'template_key', 'target_description'],
      'email_snapshots': ['window_key', 'sent', 'opens', 'clicks', 'unsubs', 'bounces', 'replies', 'warm_total', 'warm_by_lang_json', 'captured_at'],
      'goals': null, // get columns dynamically
      'site_visits': null,
      'sites': null,
      'site_daily_metrics': null,
      'site_events': null,
      'signup_events': null,
      'funnels': null,
      'funnel_stages': null,
      'influencers': null,
      'ip_assets': null,
      'social_accounts': null,
      'connected_socials': null,
      'email_templates': null,
      'social_templates': null,
      'collection_jobs': null,
      'tenant_onboarding': null,
      'tenant_usage': null,
      'content_items': null,
      'content_postings': null,
    };
    
    for (const [table, cols] of Object.entries(tables)) {
      try {
        const rows = importData[table];
        if (!rows || !Array.isArray(rows) || rows.length === 0) {
          results[table] = { skipped: 'no data' };
          continue;
        }
        
        // Get actual columns from the table
        const tableInfo = db.prepare(`PRAGMA table_info(${table})`).all();
        const actualCols = tableInfo.map(c => c.name).filter(c => c !== 'id');
        
        let imported = 0;
        for (const row of rows) {
          // Build insert with tenant_id mapped
          const insertCols = [];
          const values = [];
          for (const col of actualCols) {
            if (col === 'tenant_id') {
              insertCols.push(col);
              values.push(newTenantId);
            } else if (row[col] !== undefined) {
              insertCols.push(col);
              values.push(row[col]);
            }
          }
          if (insertCols.length === 0) continue;
          const placeholders = insertCols.map(() => '?').join(',');
          db.prepare(`INSERT INTO ${table} (${insertCols.join(',')}) VALUES (${placeholders})`).run(...values);
          imported++;
        }
        results[table] = { imported };
      } catch (e) {
        results[table] = { error: e.message };
      }
    }
    
    // FIX 2026-10-29 (audit B1): ensure Leon has an account — password comes
    // ONLY from OWNER_SEED_PASSWORD_LEON; skipped when unset (never invent
    // a password).
    try {
      results['leon_user'] = {
        status: await ensureOwnerFromEnv('leon@faithshield.ai', 'OWNER_SEED_PASSWORD_LEON', newTenantId),
      };
    } catch (e) {
      results['leon_user'] = { error: e.message };
    }
    
    res.json({ ok: true, tenant_id: newTenantId, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Migration: cleanup duplicates and ensure users (backup/self-heal — B1)
router.post('/migration-cleanup/:token', requireMigrationToken, express.json(), async (req, res) => {
  try {
    const results = {};
    
    // Delete duplicate campaigns (keep lowest IDs)
    try {
      const dupes = db.prepare(`
        DELETE FROM email_campaigns WHERE id IN (
          SELECT id FROM email_campaigns 
          WHERE (name, sent) IN (
            SELECT name, sent FROM email_campaigns 
            GROUP BY name, sent HAVING COUNT(*) > 1
          )
          AND id NOT IN (
            SELECT MIN(id) FROM email_campaigns GROUP BY name, sent
          )
        )
      `).run();
      results['deduped_campaigns'] = { deleted: dupes.changes };
    } catch (e) {
      results['deduped_campaigns'] = { error: e.message };
    }
    
    // FIX 2026-10-29 (audit B1): ensure Michael + Leon exist — passwords come
    // ONLY from OWNER_SEED_PASSWORD_MICHAEL / OWNER_SEED_PASSWORD_LEON;
    // creation is skipped (with a logged warning) when the variable is
    // unset. The hardcoded password these blocks used is deleted.
    try {
      const tenant = db.prepare('SELECT id FROM tenants LIMIT 1').get();
      results['michael'] = { status: await ensureOwnerFromEnv('michael@faithshield.ai', 'OWNER_SEED_PASSWORD_MICHAEL', tenant.id) };
    } catch (e) {
      results['michael'] = { error: e.message };
    }

    try {
      const tenant = db.prepare('SELECT id FROM tenants LIMIT 1').get();
      results['leon'] = { status: await ensureOwnerFromEnv('leon@faithshield.ai', 'OWNER_SEED_PASSWORD_LEON', tenant.id) };
    } catch (e) {
      results['leon'] = { error: e.message };
    }
    
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// HeyGen voice door + server config read (token-gated, same MIGRATION_TOKEN
// pattern as the sync endpoints above). Added 2026-11-11: the HeyGen API
// key lives ONLY in this server's env (Michael's rule), which made every
// voice job depend on a human sign-in to Render or HeyGen. These doors let
// the house tooling run narration from outside with the migration token
// while the key never leaves the server. The config read reports SPARK raw
// env next to the effective values and key set/length only, never a value.
// ---------------------------------------------------------------------------
const config = require('../config');
const HEYGEN_TTS_VOICE_DEFAULT = '0eed7849898e4362885098f714784920'; // "Michael Faber" clone

async function heygenDoorFetch(pathname, { method = 'GET', body } = {}) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 180000);
  try {
    const res = await fetch(`${String(config.heygenApiBase).replace(/\/+$/, '')}${pathname}`, {
      method,
      signal: ctl.signal,
      headers: {
        'X-Api-Key': config.heygenApiKey,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* provider returned non-JSON */ }
    return { status: res.status, json };
  } finally {
    clearTimeout(to);
  }
}

router.get('/heygen-balance/:token', requireMigrationToken, async (req, res) => {
  if (!config.heygenConfigured) {
    return res.status(503).json({ ok: false, error: 'heygen_not_configured' });
  }
  try {
    const r = await heygenDoorFetch('/v3/users/me');
    if (r.status < 200 || r.status >= 300) {
      return res.status(502).json({ ok: false, error: 'heygen_provider_error', provider_status: r.status });
    }
    return res.json({ ok: true, provider: r.json });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.name === 'AbortError' ? 'heygen_timeout' : 'heygen_network_error' });
  }
});

router.post('/heygen-tts/:token', requireMigrationToken, express.json({ limit: '64kb' }), async (req, res) => {
  if (!config.heygenConfigured) {
    return res.status(503).json({ ok: false, error: 'heygen_not_configured' });
  }
  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text || text.length > 5000) {
    return res.status(400).json({ ok: false, error: 'text_required' });
  }
  const voiceId = typeof body.voice_id === 'string' && body.voice_id ? body.voice_id : HEYGEN_TTS_VOICE_DEFAULT;
  const model = typeof body.model === 'string' && body.model ? body.model : 'heygen-voice-1';
  try {
    const r = await heygenDoorFetch('/v3/models/audio/tts', {
      method: 'POST',
      body: { model, voice_id: voiceId, text },
    });
    if (r.status < 200 || r.status >= 300) {
      return res.status(502).json({
        ok: false, error: 'heygen_provider_error', provider_status: r.status,
        provider: r.json || undefined,
      });
    }
    const p = r.json || {};
    const audioUrl = p.audio_url || (p.data && p.data.audio_url) || p.url || null;
    const duration = p.duration ?? (p.data && p.data.duration) ?? null;
    return res.json({ ok: true, audio_url: audioUrl, duration, provider: p });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.name === 'AbortError' ? 'heygen_timeout' : 'heygen_network_error' });
  }
});

router.get('/server-config/:token', requireMigrationToken, (req, res) => {
  const sparkKey = process.env.SPARK_API_KEY || '';
  res.json({
    ok: true,
    spark: {
      base_url_env: process.env.SPARK_BASE_URL || null,
      model_env: process.env.SPARK_MODEL || null,
      timeout_ms_env: process.env.SPARK_TIMEOUT_MS || null,
      api_key_set: Boolean(sparkKey),
      api_key_length: sparkKey.length,
      effective_base_url: config.sparkBaseUrl,
      effective_model: config.sparkModel,
    },
    heygen: {
      api_key_set: Boolean(config.heygenApiKey),
      api_base: config.heygenApiBase,
    },
  });
});

module.exports = router;
