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
    // server-side / by admin — never via public signup.
    const SELF_SERVE_PLANS = ['starter', 'pro', 'heavy10', 'heavy30'];
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
      'content_items', 'content_postings'];
    
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

// Migration: import migrated data (backup/self-heal only — token-gated, B1)
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
      'email_snapshots': ['window_key', 'sent', 'opens', 'clicks', 'unsubs', 'bounces', 'warm_total', 'warm_by_lang_json', 'captured_at'],
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

module.exports = router;
