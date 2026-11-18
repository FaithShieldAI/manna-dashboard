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
const signinRecord = require('../lib/signinRecord');
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
    // Sign-in record (2026-11-14): stamps ONLY the two
    // keyed accounts; a no-op for everyone else.
    // This is also the stamp for the post-reset flow: reset-password
    // creates no session, so a reset is always followed by this sign-in.
    signinRecord.stampSignIn(user);
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
  // Finalize the sign-in record's visit duration before the session
  // goes away (keyed accounts only; no-op for everyone else).
  try {
    const v = sessions.verifySession(token);
    if (v && v.user) signinRecord.stampActivity(v.user);
  } catch (e) { /* record is additive; never break logout */ }
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
  const meUser = publicUser(req.user);
  // Sign-in record (2026-11-14): the two keyed users
  // see their own record on their own payload; the fields are absent
  // entirely for every other user.
  const rec = signinRecord.signinRecordFor(req.user);
  if (rec) {
    meUser.last_login_at = rec.last_login_at;
    meUser.last_session_seconds = rec.last_session_seconds;
  }
  res.json({ ok: true, user: meUser, tenant });
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
    // COMPLETENESS RULE (2026-11-18): this list must cover EVERY table
    // the product uses. The 2026-11-18 audit found the export silently
    // missing 30 tables (ab_tests, social_postings, video_jobs, drip_*,
    // scribe_*, scheduled_sends, facebook_pages, pr_* and more) — a
    // restore would have lost exactly the engagement data, and no
    // snapshot could verify those features' production state.
    // tests/migrationExport.test.js asserts every live table (except
    // schema_migrations, which the migration runner rebuilds) is here.
    const tables = ['tenants', 'users', 'sites', 'site_daily_metrics', 'site_events',
      'site_visits', 'signup_events', 'email_snapshots', 'email_campaigns',
      'funnels', 'funnel_stages', 'influencers', 'ip_assets', 'social_accounts',
      'goals', 'tenant_usage', 'collection_jobs', 'tenant_onboarding',
      'connected_socials', 'email_templates', 'social_templates',
      'content_items', 'content_postings', 'pr_events',
      'warm_lead_segments', 'warm_leads', 'warm_lead_sync_state',
      'ab_tests', 'social_postings', 'star_of_day',
      'drip_campaigns', 'drip_steps', 'drip_enrollments', 'drip_send_log',
      'scheduled_sends',
      'scribe_analyses', 'scribe_drafts', 'scribe_followups',
      'video_jobs', 'video_postings', 'facebook_pages',
      'pr_targets', 'pr_releases', 'pr_pitches',
      'podcast_outreach', 'dm_log', 'revenue_ledger', 'cost_ledger',
      'intake_daily', 'live_windows', 'dashboard_payloads',
      'faithshield_subscriptions', 'provisioning_log',
      'email_verification_tokens', 'password_reset_tokens', 'sessions',
      'tenant_seed_state'];
    
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

// ---------------------------------------------------------------------------
// Site visits read (token-gated, same MIGRATION_TOKEN pattern as the sync
// endpoints above). Added 2026-11-14 (both surfaces): the
// private D2RM dashboard's Sites and Visits tabs carry a MannaAi card, and
// Manna's own first-party page-view log (site_visits, written server-side
// by src/middleware/visitTracking.js) is the source of record for
// mannaforinfluencers.com traffic. This read-only door lets the dashboard
// chain fetch the log's aggregates and recent rows at build time. It
// returns counts, paths and referrers only: no IPs (stored hashed, never
// returned), no raw user agents, no session ids.
//
// Extended 2026-11-14 (the dashboard must show the TRUE picture):
// the raw log is mostly our own machinery (the keep-warm cron pings /login
// with curl every ~10 minutes, and PR-tracker /t/ pings pass through this
// domain), so the door now classifies every row and returns the split:
//   machine_curl  - curl user agents (keep-warm / probe pings)
//   machine_bot   - bot / preview-fetcher user agents
//   pr_tracker    - /t/ paths (PR mailing open/click pings)
//   human         - everything else (browser page views)
// Only the class leaves the server, never the raw user agent. The door
// also returns the signup record (tenants, their users, signup_events)
// with names, dates and trial status, so the dashboard can show who
// actually signed up. Same no-IP / no-session rule applies there.
// ---------------------------------------------------------------------------
const VISIT_CLASS_SQL = `
  CASE
    WHEN LOWER(COALESCE(user_agent, '')) LIKE 'curl%' THEN 'machine_curl'
    WHEN LOWER(COALESCE(user_agent, '')) LIKE '%facebookexternalhit%'
      OR LOWER(COALESCE(user_agent, '')) LIKE '%bot%'
      OR LOWER(COALESCE(user_agent, '')) LIKE '%crawl%'
      OR LOWER(COALESCE(user_agent, '')) LIKE '%spider%'
      OR LOWER(COALESCE(user_agent, '')) LIKE '%headless%'
      OR LOWER(COALESCE(user_agent, '')) LIKE 'wget%'
      OR LOWER(COALESCE(user_agent, '')) LIKE 'python-requests%'
      OR LOWER(COALESCE(user_agent, '')) LIKE 'go-http-client%'
    THEN 'machine_bot'
    WHEN path LIKE '/t/%' OR path = '/t' THEN 'pr_tracker'
    ELSE 'human'
  END`;

router.get('/site-visits-read/:token', requireMigrationToken, (req, res) => {
  try {
    const agg = (where) => db.prepare(`
      SELECT COUNT(*) AS pageviews,
             COUNT(DISTINCT ip_hash) AS visitors,
             COUNT(DISTINCT session_id) AS sessions
      FROM site_visits ${where}`).get();
    const last30 = agg("WHERE date(created_at) >= date('now', '-30 days')");
    const allTime = agg('');
    const topPages = db.prepare(`
      SELECT path, COUNT(*) AS views, COUNT(DISTINCT ip_hash) AS visitors
      FROM site_visits
      WHERE date(created_at) >= date('now', '-30 days')
      GROUP BY path ORDER BY views DESC LIMIT 10`).all();
    const daily = db.prepare(`
      SELECT date(created_at) AS day, COUNT(*) AS pageviews,
             COUNT(DISTINCT ip_hash) AS visitors, COUNT(DISTINCT session_id) AS sessions,
             SUM(CASE WHEN (${VISIT_CLASS_SQL}) = 'human' THEN 1 ELSE 0 END) AS human_pageviews,
             SUM(CASE WHEN (${VISIT_CLASS_SQL}) = 'human' THEN 0 ELSE 1 END) AS other_pageviews
      FROM site_visits
      WHERE date(created_at) >= date('now', '-30 days')
      GROUP BY day ORDER BY day DESC`).all();
    const recent = db.prepare(`
      SELECT created_at, path, referrer
      FROM site_visits ORDER BY id DESC LIMIT 50`).all();

    // Human / machine split per window.
    const emptyClass = () => ({ pageviews: 0, visitors: 0, sessions: 0 });
    const classAgg = (where) => {
      const out = { human: emptyClass(), machine_curl: emptyClass(),
                    machine_bot: emptyClass(), pr_tracker: emptyClass() };
      const rows = db.prepare(`
        SELECT (${VISIT_CLASS_SQL}) AS cls, COUNT(*) AS pageviews,
               COUNT(DISTINCT ip_hash) AS visitors,
               COUNT(DISTINCT session_id) AS sessions
        FROM site_visits ${where} GROUP BY cls`).all();
      for (const r of rows) {
        if (out[r.cls]) out[r.cls] = { pageviews: r.pageviews, visitors: r.visitors, sessions: r.sessions };
      }
      return out;
    };
    const classes30 = classAgg("WHERE date(created_at) >= date('now', '-30 days')");
    const classesAll = classAgg('');
    const topPagesHuman = db.prepare(`
      SELECT path, COUNT(*) AS views, COUNT(DISTINCT ip_hash) AS visitors
      FROM site_visits
      WHERE date(created_at) >= date('now', '-30 days')
        AND (${VISIT_CLASS_SQL}) = 'human'
      GROUP BY path ORDER BY views DESC LIMIT 10`).all();
    const recentHuman = db.prepare(`
      SELECT created_at, path, referrer
      FROM site_visits
      WHERE (${VISIT_CLASS_SQL}) = 'human'
      ORDER BY id DESC LIMIT 50`).all();

    // Signup record: tenants with their users, plus the signup_events log.
    const signupCounts = {
      tenants: db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n,
      users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
      signup_events: db.prepare('SELECT COUNT(*) AS n FROM signup_events').get().n,
    };
    const tenantRows = db.prepare(`
      SELECT id, name, plan, subscription_status, trial_ends_at, created_at
      FROM tenants ORDER BY id`).all();
    const userRows = db.prepare(`
      SELECT tenant_id, display_name, email, role, email_verified_at, created_at
      FROM users ORDER BY id`).all();
    const tenants = tenantRows.map((t) => ({
      ...t,
      users: userRows.filter((u) => u.tenant_id === t.id)
        .map(({ tenant_id, ...u }) => u),
    }));
    const signupEvents = db.prepare(`
      SELECT s.created_at, t.name AS tenant_name, u.display_name, u.email,
             s.landing_path
      FROM signup_events s
      JOIN tenants t ON t.id = s.tenant_id
      JOIN users u ON u.id = s.user_id
      ORDER BY s.id`).all();

    return res.json({
      ok: true,
      source: 'manna_site_visits',
      generated_at: new Date().toISOString(),
      windows: { last_30d: last30, all_time: allTime },
      classes: { last_30d: classes30, all_time: classesAll },
      windows_human: { last_30d: classes30.human, all_time: classesAll.human },
      top_pages_30d: topPages,
      top_pages_30d_human: topPagesHuman,
      daily_30d: daily,
      recent,
      recent_human: recentHuman,
      signups: { counts: signupCounts, tenants, events: signupEvents },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
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

// Warm leads sync (token-gated, same MIGRATION_TOKEN pattern as the IP
// registry sync above): the mail-truth chain computes the per-recipient
// warm list (warm = opened or clicked) from the sources that actually
// hold per-person engagement — the PR tracking export and the
// preserved Kit per-subscriber records — segmented by line, and posts
// it here. Replace-all per sync: the chain stays the single source of
// truth and this app holds its copy (migration 039 tables), so the
// Warm Leads tab and the Overview warm count show the same people and
// counts as the private dashboard instead of the email windows'
// retired by-language warm fields.
function _cleanWarmLead(l, i, j) {
  const bad = (field) => {
    const err = new Error(`invalid_segment:${i}.lead:${j}.${field}`);
    err.status = 400;
    throw err;
  };
  if (!l || typeof l !== 'object' || Array.isArray(l)) bad('lead');
  const email = typeof l.email === 'string' ? l.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !email.includes('@') || /\s/.test(email)) bad('email');
  let name = null;
  if (l.name !== undefined && l.name !== null) {
    if (typeof l.name !== 'string' || l.name.length > 200) bad('name');
    name = l.name.trim() || null;
  }
  const count = (v, field) => {
    if (v === undefined || v === null) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 100000000) bad(field);
    return n;
  };
  const opens = count(l.opens, 'opens');
  const clicks = count(l.clicks, 'clicks');
  if (!((opens || 0) > 0 || (clicks || 0) > 0)) bad('not_warm');
  let lastActivity = null;
  if (l.last_activity !== undefined && l.last_activity !== null) {
    if (typeof l.last_activity !== 'string' || l.last_activity.length > 40) bad('last_activity');
    lastActivity = l.last_activity || null;
  }
  return { email, name, opens, clicks, lastActivity };
}

function _cleanWarmSegment(s, i) {
  const bad = (field) => {
    const err = new Error(`invalid_segment:${i}.${field}`);
    err.status = 400;
    throw err;
  };
  if (!s || typeof s !== 'object' || Array.isArray(s)) bad('segment');
  if (typeof s.key !== 'string' || !/^[a-z0-9_]{1,40}$/.test(s.key)) bad('key');
  const label = typeof s.label === 'string' ? s.label.trim() : '';
  if (!label || label.length > 80) bad('label');
  let note = null;
  if (s.note !== undefined && s.note !== null) {
    if (typeof s.note !== 'string' || s.note.length > 500) bad('note');
    note = s.note;
  }
  const tracked = _snapshotCount(s.tracked);
  if (tracked === null) bad('tracked');
  if (!Array.isArray(s.leads) || s.leads.length > 5000) bad('leads');
  const leads = s.leads.map((l, j) => _cleanWarmLead(l, i, j));
  return { key: s.key, label, note, tracked, leads };
}

function _warmTotalsForTenant(tenantId) {
  const seg = db.prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(tracked), 0) AS tracked FROM warm_lead_segments WHERE tenant_id = ?'
  ).get(tenantId);
  const warm = db.prepare(
    'SELECT COUNT(DISTINCT email) AS n FROM warm_leads WHERE tenant_id = ?'
  ).get(tenantId);
  const clickers = db.prepare(
    'SELECT COUNT(DISTINCT email) AS n FROM warm_leads WHERE tenant_id = ? AND clicks > 0'
  ).get(tenantId);
  const per = {};
  for (const r of db.prepare(
    'SELECT segment_key, COUNT(*) AS n FROM warm_leads WHERE tenant_id = ? GROUP BY segment_key'
  ).all(tenantId)) {
    per[r.segment_key] = r.n;
  }
  return {
    totals: { warm: warm.n, clickers: clickers.n, tracked: seg.tracked },
    segments: per,
  };
}

router.post('/warm-leads-sync/:token', requireMigrationToken, express.json({ limit: '5mb' }), (req, res) => {
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

    if (!Array.isArray(body.segments) || body.segments.length === 0 || body.segments.length > 20) {
      return res.status(400).json({ ok: false, error: 'segments_required' });
    }
    const segments = body.segments.map((s, i) => _cleanWarmSegment(s, i));
    const seenKeys = new Set();
    for (const s of segments) {
      if (seenKeys.has(s.key)) {
        return res.status(400).json({ ok: false, error: `duplicate_segment:${s.key}` });
      }
      seenKeys.add(s.key);
    }
    let computedAt = null;
    if (body.computed_at !== undefined && body.computed_at !== null) {
      if (typeof body.computed_at !== 'string' || body.computed_at.length > 40) {
        return res.status(400).json({ ok: false, error: 'invalid_computed_at' });
      }
      computedAt = body.computed_at;
    }
    let unwiredNote = null;
    if (body.unwired_note !== undefined && body.unwired_note !== null) {
      if (typeof body.unwired_note !== 'string' || body.unwired_note.length > 1000) {
        return res.status(400).json({ ok: false, error: 'invalid_unwired_note' });
      }
      unwiredNote = body.unwired_note;
    }

    const insSeg = db.prepare(`
      INSERT INTO warm_lead_segments (tenant_id, segment_key, label, note, tracked)
      VALUES (?, ?, ?, ?, ?)`);
    const insLead = db.prepare(`
      INSERT INTO warm_leads (tenant_id, segment_key, email, name, opens, clicks, last_activity)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    transaction(() => {
      db.prepare('DELETE FROM warm_leads WHERE tenant_id = ?').run(tenantId);
      db.prepare('DELETE FROM warm_lead_segments WHERE tenant_id = ?').run(tenantId);
      for (const s of segments) {
        insSeg.run(tenantId, s.key, s.label, s.note, s.tracked);
        for (const l of s.leads) {
          insLead.run(tenantId, s.key, l.email, l.name, l.opens, l.clicks, l.lastActivity);
        }
      }
      db.prepare(`
        INSERT INTO warm_lead_sync_state (tenant_id, computed_at, unwired_note)
        VALUES (?, ?, ?)
        ON CONFLICT (tenant_id) DO UPDATE SET
          computed_at = excluded.computed_at,
          unwired_note = excluded.unwired_note`
      ).run(tenantId, computedAt, unwiredNote);
    });

    const stored = _warmTotalsForTenant(tenantId);
    res.json({ ok: true, tenant_id: tenantId, totals: stored.totals, segments: stored.segments });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// Send lock proof verification for the send-mail door (2026-11-17).
// The lock lives in ~/workspace/press/send_lock.py: every house send runs
// against a locked order record whose recipients list, body words and
// subject are SHA-256 locked at order time. Until now those checks ran
// only in the sender script, so a caller that skipped the script skipped
// the checks (the 2026-11-16 sends went out a day early and tracked under
// an inherited campaign code that way). The door now verifies a proof on
// EVERY request, with no flag to turn it off. Hashing matches send_lock.py
// exactly: SHA-256 hex over the UTF-8 bytes (its sha() over .encode() for
// subject and body text, over the raw recipients.csv file bytes for the
// list). The door receives one email at a time, so the caller hashes the
// exact subject and body strings on the wire for that recipient (in a
// single-body, single-subject order these are the order record's own
// hashes; in a per-recipient order they are that recipient's slice of the
// locked aggregate, which send_lock.py verifies in full before sending).
// For the list, the proof carries the raw recipients.csv text so the door
// can recompute recipients_sha256 itself and confirm the recipient in
// hand is on the locked list.
function _sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// Minimal CSV parser (RFC 4180 style quoting). Returns the lowercased
// values of the email column, or null when there is no email column.
function _csvEmails(csvText) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(csvText);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter(r => r.some(c => String(c).trim() !== ''));
  if (!nonEmpty.length) return null;
  const header = nonEmpty[0].map(h => String(h).trim().toLowerCase());
  const idx = header.indexOf('email');
  if (idx === -1) return null;
  return nonEmpty.slice(1)
    .map(r => String(r[idx] || '').trim().toLowerCase())
    .filter(Boolean);
}

// Returns a lock_proof_* error string, or null when the proof is valid
// for the mail in hand.
function _lockProofError(body, to, subject, text) {
  const proof = body.lockProof;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    return 'lock_proof_missing';
  }
  if (typeof proof.order_id !== 'string' || !proof.order_id.trim()) {
    return 'lock_proof_missing';
  }
  if (typeof proof.version !== 'string' || !proof.version.trim()) {
    return 'lock_proof_version_empty';
  }
  const nb = typeof proof.not_before === 'string'
    ? Date.parse(proof.not_before) : NaN;
  if (Number.isNaN(nb)) return 'lock_proof_invalid';
  if (Date.now() < nb) return 'lock_proof_too_early';
  const hex = /^[0-9a-f]{64}$/;
  if (!hex.test(proof.subject_sha256 || '')
      || _sha256Hex(subject) !== proof.subject_sha256) {
    return 'lock_proof_subject_mismatch';
  }
  if (!hex.test(proof.body_sha256 || '')
      || _sha256Hex(text) !== proof.body_sha256) {
    return 'lock_proof_body_mismatch';
  }
  if (!hex.test(proof.recipients_sha256 || '')
      || typeof proof.recipients_csv !== 'string'
      || _sha256Hex(proof.recipients_csv) !== proof.recipients_sha256) {
    return 'lock_proof_recipients_mismatch';
  }
  const emails = _csvEmails(proof.recipients_csv);
  if (!emails || !emails.includes(String(to).trim().toLowerCase())) {
    return 'lock_proof_recipients_mismatch';
  }
  return null;
}

// Metering for the send-mail door (2026-11-18). Until now the door —
// the path the house's real sends actually use — performed no quota
// check and wrote no usage, so tenant_usage stayed empty for every
// tenant and the advertised monthly email cap never limited a real
// send. The door now meters exactly like POST /api/email/log-send:
// the tenant's effective limit (trial = 100 when subscription_status
// is not 'active', else the plan cap) is checked before sending, and
// one unit of usage is recorded for every email actually sent.
// Tenant resolution: explicit tenant_email / tenant_id in the body,
// else the house tenant (the owner account the admin allowlist and
// the sync doors key on). If no tenant can be resolved the send still
// proceeds — the door's callers are locked house jobs — but the miss
// is logged loudly rather than silently unmetered.
const DOOR_HOUSE_OWNER_EMAIL = 'michael@faithshield.ai';

function _doorTenant(body) {
  if (body && typeof body.tenant_email === 'string' && body.tenant_email.trim()) {
    const user = db.prepare('SELECT tenant_id FROM users WHERE LOWER(email) = LOWER(?)')
      .get(body.tenant_email.trim());
    if (user) return db.prepare('SELECT * FROM tenants WHERE id = ?').get(Number(user.tenant_id)) || null;
    return null;
  }
  if (body && body.tenant_id !== undefined && body.tenant_id !== null) {
    const id = Number(body.tenant_id);
    if (Number.isInteger(id) && id > 0) {
      return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) || null;
    }
    return null;
  }
  const owner = db.prepare('SELECT tenant_id FROM users WHERE LOWER(email) = LOWER(?)')
    .get(DOOR_HOUSE_OWNER_EMAIL);
  if (owner) return db.prepare('SELECT * FROM tenants WHERE id = ?').get(Number(owner.tenant_id)) || null;
  return null;
}

function _effectiveEmailLimit(tenant) {
  const { getPlan } = require('../lib/plans');
  if (!tenant) return null;
  if (tenant.subscription_status !== 'active') return 100; // trial cap, as in log-send
  const plan = getPlan(tenant.plan) || getPlan('starter');
  return plan ? plan.emails_per_month : null; // null = unlimited (agency)
}

// Send mail door (token-gated, same MIGRATION_TOKEN pattern as the sync
// doors above): house send jobs that run without a live session (scheduled
// sends) post one email here and Manna sends it through its own SES
// configuration, so the SES keys never leave this app's environment.
// Body: { to, subject, text, html?, from?, replyTo?, campaign?,
// templateKey?, lockProof, tenant_email?, tenant_id? }. lockProof is
// REQUIRED (see _lockProofError above): a request without a valid
// locked-order proof is refused 403 before any field validation or
// sending. A stubbed result (SES not configured, or SES refused and
// the mailer fell back to the stub) is returned as 502 so the caller
// never mistakes a non-send for a send.
router.post('/send-mail/:token', requireMigrationToken, express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const to = typeof body.to === 'string' ? body.to.trim() : '';
    const subject = typeof body.subject === 'string' ? body.subject : '';
    const text = typeof body.text === 'string' ? body.text : '';
    const lockErr = _lockProofError(body, to, subject, text);
    if (lockErr) {
      return res.status(403).json({ ok: false, error: lockErr });
    }
    if (!to || to.length > 254 || !to.includes('@') || /\s/.test(to)) {
      return res.status(400).json({ ok: false, error: 'invalid_to' });
    }
    if (!subject || subject.length > 500) {
      return res.status(400).json({ ok: false, error: 'invalid_subject' });
    }
    if (!text || text.length > 200000) {
      return res.status(400).json({ ok: false, error: 'invalid_text' });
    }
    // Quota check (2026-11-18): same effective-limit rule as log-send.
    const { currentMonthKey } = require('../lib/plans');
    const doorTenant = _doorTenant(body);
    const monthKey = currentMonthKey();
    if (doorTenant) {
      const limit = _effectiveEmailLimit(doorTenant);
      const used = forTenant(doorTenant.id).getUsage(monthKey);
      if (limit != null && used + 1 > limit) {
        return res.status(403).json({
          ok: false,
          error: doorTenant.subscription_status !== 'active'
            ? 'trial_email_limit_reached' : 'email_quota_exceeded',
          upgrade_required: true,
          plan: doorTenant.plan,
          limit, used, requested: 1,
          remaining: Math.max(0, limit - used),
        });
      }
    } else {
      // eslint-disable-next-line no-console
      console.error('[send-mail door] no tenant resolved — send proceeds UNMETERED');
    }
    const opt = (v, max) => (typeof v === 'string' && v.length <= max ? v : undefined);
    const result = await mailer.sendMail({
      to, subject, text,
      html: opt(body.html, 400000),
      from: opt(body.from, 254),
      replyTo: opt(body.replyTo, 254),
      campaign: opt(body.campaign, 120),
      templateKey: opt(body.templateKey, 120),
    });
    if (!result.ok || result.stubbed) {
      return res.status(502).json({ ok: false, error: 'send_stubbed', id: result.id });
    }
    // Record the send against the tenant's monthly meter (real sends
    // only — a stubbed result means zero emails left the building).
    if (doorTenant) {
      try {
        forTenant(doorTenant.id).addUsage(monthKey, 1);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[send-mail door] usage write failed:', e.message);
      }
    }
    return res.json({ ok: true, stubbed: false, id: result.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Tenant plan door (token-gated, 2026-11-18): the staff activation
// mechanism. Quota paths key off subscription_status, not just plan —
// a tenant left 'trialing' is capped at 100 emails and 5 videos no
// matter what plan it carries (the audit's activation trap). Activating
// a customer (e.g. the hackathon prize winner) means setting BOTH the
// plan and subscription_status='active' here, then reading the
// entitlements back from this response (and from the tenant's own
// /api/billing/ + /api/videos/catalogue) as proof.
// Body: { tenant_email | tenant_id, plan?, subscription_status?,
//         extra_seats? } — at least one field to change is required.
const TENANT_PLAN_STATUSES = ['trialing', 'active', 'past_due', 'canceled', 'incomplete'];
router.post('/tenant-plan/:token', requireMigrationToken, express.json({ limit: '64kb' }), (req, res) => {
  try {
    const body = req.body || {};
    let tenant = null;
    if (typeof body.tenant_email === 'string' && body.tenant_email.trim()) {
      const user = db.prepare('SELECT tenant_id FROM users WHERE LOWER(email) = LOWER(?)')
        .get(body.tenant_email.trim());
      if (user) tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(Number(user.tenant_id));
    } else if (body.tenant_id !== undefined && body.tenant_id !== null) {
      const id = Number(body.tenant_id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_tenant_id' });
      }
      tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
    } else {
      return res.status(400).json({ ok: false, error: 'tenant_required' });
    }
    if (!tenant) return res.status(404).json({ ok: false, error: 'tenant_not_found' });

    const { PLANS, getPlan } = require('../lib/plans');
    const sets = [];
    const vals = [];
    if (body.plan !== undefined) {
      if (typeof body.plan !== 'string' || !PLANS[body.plan]) {
        return res.status(400).json({ ok: false, error: 'invalid_plan', valid: Object.keys(PLANS) });
      }
      sets.push('plan = ?'); vals.push(body.plan);
    }
    if (body.subscription_status !== undefined) {
      if (!TENANT_PLAN_STATUSES.includes(body.subscription_status)) {
        return res.status(400).json({ ok: false, error: 'invalid_status', valid: TENANT_PLAN_STATUSES });
      }
      sets.push('subscription_status = ?'); vals.push(body.subscription_status);
    }
    if (body.extra_seats !== undefined) {
      const n = Number(body.extra_seats);
      if (!Number.isInteger(n) || n < 0 || n > 100) {
        return res.status(400).json({ ok: false, error: 'invalid_extra_seats' });
      }
      sets.push('extra_seats = ?'); vals.push(n);
    }
    if (!sets.length) {
      return res.status(400).json({ ok: false, error: 'nothing_to_update' });
    }
    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...vals, tenant.id);
    const updated = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant.id);
    const plan = getPlan(updated.plan);
    return res.json({
      ok: true,
      tenant: {
        id: updated.id, name: updated.name, slug: updated.slug,
        plan: updated.plan, subscription_status: updated.subscription_status,
        extra_seats: updated.extra_seats,
      },
      entitlements: plan ? {
        projects: plan.projects,
        emails_per_month: plan.emails_per_month,
        videos_per_month: plan.videos_per_month || null,
        seats_included: plan.seats_included,
        // What the quota paths will actually enforce for this tenant:
        effective_emails_per_month: _effectiveEmailLimit(updated),
      } : null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
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
// record the tenant sees on the Leads page). Scope (2026-11-08):
// family office investor lead collection runs through MannaAi instead
// of external browser work (keeps approvals in one place and
// exercises the product).
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
// the family office funnel (2026-11-08: job-inbox addresses are
// excluded — the Blue Trust row the collector found is an HR
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
              // FIX 2026-11-12: for social_accounts ONLY, an explicit
              // tenant_id on the payload row is honored (verified against
              // the tenants table) so house channels can be registered
              // under the correct tenant; every other table keeps the
              // legacy force-map to the first tenant, unchanged.
              let targetTenantId = newTenantId;
              if (table === 'social_accounts' && Number.isInteger(row.tenant_id) && row.tenant_id > 0) {
                const t = db.prepare('SELECT id FROM tenants WHERE id = ?').get(row.tenant_id);
                if (t) targetTenantId = t.id;
              }
              values.push(targetTenantId);
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
    
    // FIX 2026-10-29 (audit B1): ensure the two owner accounts exist — passwords come
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

// FIX 2026-11-12: standalone, narrowly scoped delete for social_accounts
// rows by explicit id list. Exists to undo the two YouTube rows that landed
// under the wrong tenant before migration-import learned to honor an
// explicit social_accounts tenant_id. Deliberately NOT folded into
// migration-cleanup: that endpoint also dedupes email_campaigns, and this
// door must never touch any other table. Token-gated like the other
// migration doors; no id list in the body, no deletion; the rows removed
// are reported back in the response for an audit trail.
router.post('/social-accounts-delete/:token', requireMigrationToken, express.json(), (req, res) => {
  try {
    const ids = req.body && Array.isArray(req.body.ids)
      ? req.body.ids.filter(n => Number.isInteger(n) && n > 0)
      : [];
    if (ids.length === 0) {
      return res.json({ ok: true, skipped: 'no ids', deleted: 0 });
    }
    const marks = ids.map(() => '?').join(',');
    const found = db.prepare(
      `SELECT id, tenant_id, platform, handle FROM social_accounts WHERE id IN (${marks})`
    ).all(...ids);
    const del = db.prepare(
      `DELETE FROM social_accounts WHERE id IN (${marks})`
    ).run(...ids);
    res.json({ ok: true, requested: ids, found, deleted: del.changes });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// HeyGen voice door + server config read (token-gated, same MIGRATION_TOKEN
// pattern as the sync endpoints above). Added 2026-11-11: the HeyGen API
// key lives ONLY in this server's env (house rule), which made every
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
