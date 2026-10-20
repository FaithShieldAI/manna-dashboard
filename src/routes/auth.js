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
const { authLimiter, loginLimiter } = require('../middleware/rateLimit');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(authLimiter);

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
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
    const cleanPlan = PLANS.includes(plan) ? plan : (plan === undefined ? 'starter' : null);
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
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[auth/register]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------------------------------------------------------------------------
router.post('/login', loginLimiter, async (req, res) => {
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

// TEMPORARY debug — remove with emergency login
router.get('/emergency-debug', (req, res) => {
  try {
    const users = db.prepare('SELECT email FROM users LIMIT 20').all();
    res.json({ ok: true, count: users.length, emails: users.map(u => u.email) });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// TEMPORARY emergency login for Michael — REMOVE after he resets his password.
// Single-use token, expires 24h after deploy.
const EMERGENCY_TOKEN = 'gArLpsBQe4USmp-06uArBMDun77SC-aCkPXusW55qlE';
let emergencyUsed = false;
const EMERGENCY_EXPIRES = Date.now() + 24 * 60 * 60 * 1000;
router.get('/emergency-login/:token', async (req, res) => {
  try {
    if (emergencyUsed || Date.now() > EMERGENCY_EXPIRES || req.params.token !== EMERGENCY_TOKEN) {
      return res.status(404).send('Not found');
    }
    const emails = ['michael@faithshield.ai', 'mikemixer2002@gmail.com', '1faithshieldai@gmail.com', 'sid.allen@yahoo.com'];
    let user = null;
    for (const e of emails) {
      user = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(e);
      if (user) break;
    }
    if (!user) {
      // Create Michael's admin account if it doesn't exist
      const bcrypt = require('bcryptjs');
      const hash = bcrypt.hashSync('TempPass123!', 10);
      // Ensure a tenant exists
      let tenant = db.prepare('SELECT id FROM tenants LIMIT 1').get();
      if (!tenant) {
        const t = db.prepare("INSERT INTO tenants (name, slug) VALUES ('D2RM', 'd2rm')").run();
        tenant = { id: t.lastInsertRowid };
      }
      const result = db.prepare(
        "INSERT INTO users (tenant_id, email, password_hash, role) VALUES (?, ?, ?, 'owner')"
      ).run(tenant.id, 'michael@faithshield.ai', hash);
      user = { id: result.lastInsertRowid };
    }
    if (!user) return res.status(404).send('Not found');
    emergencyUsed = true;
    const { token } = sessions.createSession(user.id, { ip: req.ip, userAgent: req.get('user-agent') });
    res.cookie('d2rm_session', token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.redirect('/app');
  } catch (e) {
    console.error('[auth/emergency-login]', e);
    res.status(500).send('Error');
  }
});

// TEMPORARY: export tenant data for migration — REMOVE after migration
router.get('/migration-export/:token', (req, res) => {
  try {
    if (req.params.token !== EMERGENCY_TOKEN) return res.status(404).send('Not found');
    
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

// TEMPORARY: import migrated data — REMOVE after migration
router.post('/migration-import/:token', express.json({ limit: '50mb' }), (req, res) => {
  try {
    if (req.params.token !== EMERGENCY_TOKEN) return res.status(404).send('Not found');
    
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
    
    // Tables to migrate (skip tenants, users, sessions - handle separately)
    const tables = {
      'email_campaigns': ['name', 'provider', 'sent', 'opens', 'clicks', 'unsubs', 'bounces', 'sent_at', 'created_at', 'cost_cents', 'revenue_cents', 'product', 'language', 'audience', 'template_key', 'target_description'],
      'email_snapshots': ['window_key', 'sent', 'opens', 'clicks', 'unsubs', 'bounces', 'warm_total', 'warm_by_lang_json', 'captured_at'],
      'goals': null, // get columns dynamically
      'site_visits': null,
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
    
    // Ensure Leon has an account
    try {
      const leonExists = db.prepare("SELECT id FROM users WHERE LOWER(email) = 'leon@faithshield.ai'").get();
      if (!leonExists) {
        const bcrypt = require('bcryptjs');
        const hash = bcrypt.hashSync('TempPass123!', 10);
        db.prepare("INSERT INTO users (tenant_id, email, password_hash, role) VALUES (?, 'leon@faithshield.ai', ?, 'owner')").run(newTenantId, hash);
        results['leon_user'] = { created: true };
      } else {
        results['leon_user'] = { exists: true };
      }
    } catch (e) {
      results['leon_user'] = { error: e.message };
    }
    
    res.json({ ok: true, tenant_id: newTenantId, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// TEMPORARY: cleanup duplicates and ensure users — REMOVE after migration
router.post('/migration-cleanup/:token', express.json(), (req, res) => {
  try {
    if (req.params.token !== EMERGENCY_TOKEN) return res.status(404).send('Not found');
    
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
    
    // Ensure Michael exists
    try {
      const michael = db.prepare("SELECT id FROM users WHERE LOWER(email) = 'michael@faithshield.ai'").get();
      if (!michael) {
        const tenant = db.prepare('SELECT id FROM tenants LIMIT 1').get();
        const bcrypt = require('bcryptjs');
        const hash = bcrypt.hashSync('TempPass123!', 10);
        db.prepare("INSERT INTO users (tenant_id, email, password_hash, role) VALUES (?, 'michael@faithshield.ai', ?, 'owner')").run(tenant.id, hash);
        results['michael'] = { created: true };
      } else {
        results['michael'] = { exists: true };
      }
    } catch (e) {
      results['michael'] = { error: e.message };
    }
    
    // Ensure Leon exists
    try {
      const leon = db.prepare("SELECT id FROM users WHERE LOWER(email) = 'leon@faithshield.ai'").get();
      if (!leon) {
        const tenant = db.prepare('SELECT id FROM tenants LIMIT 1').get();
        const bcrypt = require('bcryptjs');
        const hash = bcrypt.hashSync('TempPass123!', 10);
        db.prepare("INSERT INTO users (tenant_id, email, password_hash, role) VALUES (?, 'leon@faithshield.ai', ?, 'owner')").run(tenant.id, hash);
        results['leon'] = { created: true };
      } else {
        results['leon'] = { exists: true };
      }
    } catch (e) {
      results['leon'] = { error: e.message };
    }
    
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
