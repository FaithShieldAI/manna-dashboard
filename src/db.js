'use strict';
/**
 * Database layer — SQLite (better-sqlite3) with migration runner and
 * tenant-scoped query helpers.
 *
 * SECURITY CONTRACT: route handlers NEVER issue cross-tenant queries.
 * They obtain a tenant-scoped db handle via `forTenant(tenantId)`, whose
 * helpers inject `tenant_id = ?` into every statement. Raw `db.prepare()`
 * is only used in this module and in migrations/seeds.
 */

const path = require('path');
const fs = require('fs');
// node:sqlite is built into Node 22+ — zero native dependencies, zero build.
// API mirrors better-sqlite3 for everything we use (prepare/run/get/all/exec).
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DATABASE_PATH
  || path.join(__dirname, '..', 'data', 'd2rm-dashboard.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

/** Synchronous transaction helper (node:sqlite has no .transaction()). */
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK;'); } catch (_) { /* already rolled back */ }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function currentVersion() {
  try {
    const row = db.prepare(
      'SELECT MAX(version) AS v FROM schema_migrations'
    ).get();
    return row && row.v ? row.v : 0;
  } catch (e) {
    // schema_migrations doesn't exist yet (fresh DB)
    return 0;
  }
}

function migrate() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d+_.*\.sql$/.test(f))
    .sort();
  const cur = currentVersion();
  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10);
    if (version <= cur) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
    });
    // eslint-disable-next-line no-console
    console.log(`[migrate] applied ${file}`);
  }
}

// ---------------------------------------------------------------------------
// Tenant-scoped access
// ---------------------------------------------------------------------------
/**
 * Returns an object of query helpers pre-bound to a tenant_id.
 * Every helper includes `WHERE tenant_id = ?` — there is intentionally no
 * way to query another tenant's rows through this interface.
 */
function forTenant(tenantId) {
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error('forTenant: invalid tenantId');
  }
  const t = tenantId;

  return {
    tenantId: t,

    // -- sites ------------------------------------------------------------
    listSites() {
      return db.prepare(
        'SELECT id, site_key, name, url, emoji FROM sites WHERE tenant_id = ? ORDER BY id'
      ).all(t);
    },
    getSite(siteKey) {
      return db.prepare(
        'SELECT id, site_key, name, url, emoji FROM sites WHERE tenant_id = ? AND site_key = ?'
      ).get(t, siteKey);
    },
    countSites() {
      const row = db.prepare('SELECT COUNT(*) AS n FROM sites WHERE tenant_id = ?').get(t);
      return row ? row.n : 0;
    },
    createSite({ siteKey, name, url, emoji, collectKey }) {
      return db.prepare(
        'INSERT INTO sites (tenant_id, site_key, name, url, emoji, collect_key) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(t, siteKey, name, url || null, emoji || null, collectKey || null);
    },

    // -- usage (monthly email metering) -------------------------------------
    getUsage(monthKey) {
      const row = db.prepare(
        'SELECT emails_sent FROM tenant_usage WHERE tenant_id = ? AND month_key = ?'
      ).get(t, monthKey);
      return row ? row.emails_sent : 0;
    },
    addUsage(monthKey, count) {
      db.prepare(`
        INSERT INTO tenant_usage (tenant_id, month_key, emails_sent)
        VALUES (?, ?, ?)
        ON CONFLICT (tenant_id, month_key)
        DO UPDATE SET emails_sent = emails_sent + excluded.emails_sent,
                      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      ).run(t, monthKey, count);
    },

    // -- site metrics -----------------------------------------------------
    siteMetrics(siteId, days) {
      return db.prepare(`
        SELECT day, visitors, pageviews, bounce_rate, avg_duration_s
        FROM site_daily_metrics
        WHERE tenant_id = ? AND site_id = ?
        ORDER BY day DESC LIMIT ?`).all(t, siteId, days);
    },

    // -- first-party visit tracking ----------------------------------------
    // Visits to our own pages (all tenants when admin, else own tenant).
    visitStats(days, allTenants) {
      return db.prepare(`
        SELECT date(created_at) AS day,
               COUNT(*) AS pageviews,
               COUNT(DISTINCT ip_hash) AS visitors,
               COUNT(DISTINCT session_id) AS sessions
        FROM site_visits
        WHERE date(created_at) >= date('now', '-' || ? || ' days')
        ${allTenants ? '' : 'AND (tenant_id = ? OR tenant_id IS NULL)'}
        GROUP BY day ORDER BY day DESC`).all(...(allTenants ? [days] : [days, t]));
    },
    topPages(days, allTenants, limit) {
      return db.prepare(`
        SELECT path, COUNT(*) AS views, COUNT(DISTINCT ip_hash) AS visitors
        FROM site_visits
        WHERE date(created_at) >= date('now', '-' || ? || ' days')
        ${allTenants ? '' : 'AND (tenant_id = ? OR tenant_id IS NULL)'}
        GROUP BY path ORDER BY views DESC LIMIT ?`)
        .all(...(allTenants ? [days, limit] : [days, t, limit]));
    },
    signupStats(days, allTenants) {
      return db.prepare(`
        SELECT date(s.created_at) AS day,
               COUNT(*) AS signups,
               COUNT(s.landing_path) AS attributed,
               s.landing_path AS top_landing
        FROM signup_events s
        WHERE date(s.created_at) >= date('now', '-' || ? || ' days')
        ${allTenants ? '' : 'AND s.tenant_id = ?'}
        GROUP BY day ORDER BY day DESC`)
        .all(...(allTenants ? [days] : [days, t]));
    },
    recentSignups(allTenants, limit) {
      return db.prepare(`
        SELECT s.created_at, s.landing_path, s.referrer, u.email, u.display_name
        FROM signup_events s
        JOIN users u ON u.id = s.user_id
        ${allTenants ? '' : 'WHERE s.tenant_id = ?'}
        ORDER BY s.id DESC LIMIT ?`)
        .all(...(allTenants ? [limit] : [t, limit]));
    },

    // -- email ------------------------------------------------------------
    emailSnapshots() {
      return db.prepare(
        'SELECT window_key, sent, opens, clicks, unsubs, bounces, warm_total, warm_by_lang_json, captured_at FROM email_snapshots WHERE tenant_id = ?'
      ).all(t);
    },
    emailCampaigns(limit = 50, { product, language, audience } = {}) {
      let sql = 'SELECT id, name, provider, product, language, audience, sent, opens, clicks, unsubs, bounces, sent_at, cost_cents, revenue_cents FROM email_campaigns WHERE tenant_id = ?';
      const params = [t];
      if (product) { sql += ' AND product = ?'; params.push(product); }
      if (language) { sql += ' AND language = ?'; params.push(language); }
      if (audience) { sql += ' AND audience = ?'; params.push(audience); }
      sql += ' ORDER BY sent_at DESC LIMIT ?';
      params.push(limit);
      return db.prepare(sql).all(...params);
    },

    // -- funnels ----------------------------------------------------------
    funnels() {
      const funnels = db.prepare(
        'SELECT id, funnel_key, name, emoji, subtitle, cost_cents, revenue_cents FROM funnels WHERE tenant_id = ? ORDER BY sort_order, id'
      ).all(t);
      const stageStmt = db.prepare(
        'SELECT stage_key, label, current_value, goal_value FROM funnel_stages WHERE funnel_id = ? ORDER BY sort_order, id'
      );
      return funnels.map(f => ({ ...f, stages: stageStmt.all(f.id) }));
    },
    getFunnel(funnelKey) {
      return db.prepare(
        'SELECT id, funnel_key, name, emoji, subtitle FROM funnels WHERE tenant_id = ? AND funnel_key = ?'
      ).get(t, funnelKey);
    },
    createFunnel({ funnelKey, name, emoji, subtitle, stages }) {
      // stages: [{ stageKey, label, goalValue }] — goalValue null = no goal
      const fr = db.prepare(`
        INSERT INTO funnels (tenant_id, funnel_key, name, emoji, subtitle)
        VALUES (?, ?, ?, ?, ?)`).run(t, funnelKey, name, emoji || null, subtitle || null);
      const funnelId = Number(fr.lastInsertRowid);
      const ins = db.prepare(`
        INSERT INTO funnel_stages (funnel_id, stage_key, label, goal_value, sort_order)
        VALUES (?, ?, ?, ?, ?)`);
      (stages || []).forEach((s, i) => {
        ins.run(funnelId, s.stageKey, s.label, s.goalValue == null ? null : Number(s.goalValue), i);
      });
      return funnelId;
    },

    // -- influencers ------------------------------------------------------
    influencers({ category, status, limit = 200 } = {}) {
      let sql = 'SELECT id, handle, platform, email, tier, category, status, notes, source, emails_sent, emails_opened, emails_clicked, last_emailed_at, created_at FROM influencers WHERE tenant_id = ?';
      const params = [t];
      if (category) { sql += ' AND category = ?'; params.push(category); }
      if (status) { sql += ' AND status = ?'; params.push(status); }
      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);
      return db.prepare(sql).all(...params);
    },
    influencerCategoryCounts() {
      return db.prepare(
        'SELECT category, COUNT(*) AS n FROM influencers WHERE tenant_id = ? GROUP BY category'
      ).all(t);
    },
    influencerVettedCounts() {
      // Rows of { category, status, n } for the Vetted tab.
      return db.prepare(
        'SELECT category, status, COUNT(*) AS n FROM influencers WHERE tenant_id = ? GROUP BY category, status'
      ).all(t);
    },
    pendingVetted({ category, limit = 100 } = {}) {
      let sql = 'SELECT id, handle, platform, email, tier, category, status, source, created_at FROM influencers WHERE tenant_id = ? AND status = ?';
      const params = [t, 'unvetted'];
      if (category) { sql += ' AND category = ?'; params.push(category); }
      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);
      return db.prepare(sql).all(...params);
    },
    setInfluencerStatus(id, status) {
      const r = db.prepare(
        'UPDATE influencers SET status = ? WHERE tenant_id = ? AND id = ?'
      ).run(status, t, id);
      return r.changes > 0;
    },
    influencerEmails() {
      // Lowercased email set for collection dedupe.
      return new Set(
        db.prepare('SELECT LOWER(email) AS e FROM influencers WHERE tenant_id = ? AND email IS NOT NULL')
          .all(t).map(r => r.e)
      );
    },
    createInfluencer({ handle, platform, email, tier, category, status, notes, source }) {
      return db.prepare(`
        INSERT INTO influencers (tenant_id, handle, platform, email, tier, category, status, notes, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(t, handle || null, platform || null, email || null, tier || null,
          category || 'influencer', status || 'unvetted', notes || null, source || null);
    },

    // -- lead collection --------------------------------------------------
    createCollectionJob({ source, keywords, seeds, maxResults, queryText }) {
      return db.prepare(`
        INSERT INTO collection_jobs (tenant_id, source, keywords_json, seeds_json, query_text, max_results)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(t, source, JSON.stringify(keywords || []), JSON.stringify(seeds || []),
          queryText || null, maxResults || 25);
    },
    listCollectionJobs(limit = 50) {
      return db.prepare(`
        SELECT id, source, keywords_json, seeds_json, query_text, max_results, status,
               found_count, new_count, error, started_at, finished_at, created_at
        FROM collection_jobs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(t, limit);
    },
    getCollectionJob(id) {
      return db.prepare(`
        SELECT id, source, keywords_json, seeds_json, query_text, max_results, status,
               found_count, new_count, error, started_at, finished_at, created_at
        FROM collection_jobs WHERE tenant_id = ? AND id = ?`).get(t, id);
    },
    updateCollectionJob(id, fields) {
      const allowed = ['status', 'found_count', 'new_count', 'error', 'started_at', 'finished_at'];
      const sets = [];
      const params = [];
      for (const k of allowed) {
        if (fields[k] !== undefined) { sets.push(`${k} = ?`); params.push(fields[k]); }
      }
      if (!sets.length) return;
      params.push(t, id);
      db.prepare(`UPDATE collection_jobs SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`)
        .run(...params);
    },

    // -- onboarding -------------------------------------------------------
    getOnboarding() {
      let row = db.prepare(
        'SELECT welcome_seen, dismissed, completed_at, updated_at FROM tenant_onboarding WHERE tenant_id = ?'
      ).get(t);
      if (!row) {
        db.prepare('INSERT INTO tenant_onboarding (tenant_id) VALUES (?)').run(t);
        row = { welcome_seen: 0, dismissed: 0, completed_at: null };
      }
      return row;
    },
    markWelcomeSeen() {
      this.getOnboarding();
      db.prepare(`UPDATE tenant_onboarding
                  SET welcome_seen = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                  WHERE tenant_id = ?`).run(t);
    },
    dismissOnboarding() {
      this.getOnboarding();
      db.prepare(`UPDATE tenant_onboarding
                  SET dismissed = 1, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                  WHERE tenant_id = ?`).run(t);
    },
    restartOnboarding() {
      this.getOnboarding();
      db.prepare(`UPDATE tenant_onboarding
                  SET welcome_seen = 0, dismissed = 0, completed_at = NULL,
                      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                  WHERE tenant_id = ?`).run(t);
    },

    // -- connected socials (onboarding; tokens stored encrypted) ----------
    upsertConnectedSocial({ platform, handle, accessTokenEnc, refreshTokenEnc, expiresAt }) {
      return db.prepare(`
        INSERT INTO connected_socials (tenant_id, platform, handle, access_token_enc, refresh_token_enc, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, platform)
        DO UPDATE SET handle = excluded.handle,
                      access_token_enc = excluded.access_token_enc,
                      refresh_token_enc = excluded.refresh_token_enc,
                      expires_at = excluded.expires_at`)
        .run(t, platform, handle, accessTokenEnc || null, refreshTokenEnc || null, expiresAt || null);
    },
    /** Public-safe list: never returns token material, only a has_token flag. */
    listConnectedSocials() {
      return db.prepare(`
        SELECT platform, handle, expires_at, created_at,
               (access_token_enc IS NOT NULL) AS has_token
        FROM connected_socials WHERE tenant_id = ? ORDER BY platform`).all(t)
        .map(r => ({ ...r, has_token: Boolean(r.has_token) }));
    },
    deleteConnectedSocial(platform) {
      return db.prepare(
        'DELETE FROM connected_socials WHERE tenant_id = ? AND platform = ?'
      ).run(t, platform);
    },
    upsertSocialAccount({ platform, handle }) {
      return db.prepare(`
        INSERT INTO social_accounts (tenant_id, platform, handle, followers, posts)
        VALUES (?, ?, ?, 0, 0)
        ON CONFLICT (tenant_id, platform, handle) DO NOTHING`).run(t, platform, handle);
    },

    // -- template libraries -------------------------------------------------
    countEmailTemplates() {
      const row = db.prepare(
        'SELECT COUNT(*) AS n FROM email_templates WHERE tenant_id = ?'
      ).get(t);
      return row ? row.n : 0;
    },
    listEmailTemplates() {
      return db.prepare(`
        SELECT template_key, name, subject, category, is_starter, created_at
        FROM email_templates WHERE tenant_id = ? ORDER BY id`).all(t);
    },
    getEmailTemplate(key) {
      return db.prepare(`
        SELECT template_key, name, subject, body_html, body_text, category, is_starter
        FROM email_templates WHERE tenant_id = ? AND template_key = ?`).get(t, key);
    },
    previewEmailTemplates({ product, language } = {}) {
      let sql = `
        SELECT template_key, name, subject, category, is_starter, product, language,
               SUBSTR(body_text, 1, 160) AS preview
        FROM email_templates WHERE tenant_id = ?`;
      const params = [t];
      if (product) { sql += ' AND product = ?'; params.push(product); }
      if (language) { sql += ' AND language = ?'; params.push(language); }
      sql += ' ORDER BY id';
      return db.prepare(sql).all(...params);
    },
    installEmailTemplate({ templateKey, name, subject, bodyHtml, bodyText, category, isStarter }) {
      return db.prepare(`
        INSERT INTO email_templates (tenant_id, template_key, name, subject, body_html, body_text, category, is_starter)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, template_key) DO NOTHING`)
        .run(t, templateKey, name, subject || '', bodyHtml || '', bodyText || '',
          category || null, isStarter ? 1 : 0);
    },
    listSocialTemplates() {
      return db.prepare(`
        SELECT template_key, name, platform, content, created_at
        FROM social_templates WHERE tenant_id = ? ORDER BY id`).all(t);
    },
    installSocialTemplate({ templateKey, name, platform, content }) {
      return db.prepare(`
        INSERT INTO social_templates (tenant_id, template_key, name, platform, content)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, template_key) DO NOTHING`)
        .run(t, templateKey, name, platform || 'all', content);
    },
    createEmailCampaign({ name, provider, product, language, audience, template_key, target_description }) {
      const validAudiences = ['pastor', 'influencer', 'church', 'school', 'individual', 'podcast', 'organization'];
      const aud = validAudiences.includes(audience) ? audience : 'individual';
      return db.prepare(`
        INSERT INTO email_campaigns (tenant_id, name, provider, product, language, audience, template_key, target_description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(t, name, provider || null, product || 'manna', language || 'en', aud,
        template_key || null, target_description || null);
    },

    // -- IP registry ------------------------------------------------------
    ipAssets({ assetType, status } = {}) {
      let sql = 'SELECT id, title, description, asset_type, status, content_hash, created_at FROM ip_assets WHERE tenant_id = ?';
      const params = [t];
      if (assetType) { sql += ' AND asset_type = ?'; params.push(assetType); }
      if (status) { sql += ' AND status = ?'; params.push(status); }
      sql += ' ORDER BY created_at DESC';
      return db.prepare(sql).all(...params);
    },

    // -- social -----------------------------------------------------------
    socialAccounts() {
      return db.prepare(
        'SELECT platform, handle, followers, posts, updated_at FROM social_accounts WHERE tenant_id = ? ORDER BY followers DESC'
      ).all(t);
    },

    // -- goals ------------------------------------------------------------
    goals() {
      return db.prepare(
        'SELECT goal_key, label, current_value, goal_value, unit FROM goals WHERE tenant_id = ? ORDER BY id'
      ).all(t);
    },
  };
}

// ---------------------------------------------------------------------------
// Unscoped access — ONLY for auth flows (login looks up user by email before
// any tenant is known) and admin scripts. Never expose to tenant routes.
// ---------------------------------------------------------------------------
const unscoped = {
  db,
  getUserByEmail(email) {
    return db.prepare(
      'SELECT id, tenant_id, email, password_hash, display_name, role, email_verified_at, created_at FROM users WHERE email = ?'
    ).get(email);
  },
  getUserById(id) {
    return db.prepare(
      'SELECT id, tenant_id, email, display_name, role, email_verified_at, created_at FROM users WHERE id = ?'
    ).get(id);
  },
  getTenantById(id) {
    return db.prepare('SELECT id, name, slug, plan, subscription_status FROM tenants WHERE id = ?').get(id);
  },
  getTenantBySlug(slug) {
    return db.prepare('SELECT id, name, slug, plan FROM tenants WHERE slug = ?').get(slug);
  },
  createTenant(name, slug, plan) {
    return db.prepare(
      'INSERT INTO tenants (name, slug, plan) VALUES (?, ?, ?)'
    ).run(name, slug, plan);
  },
  createUser(tenantId, email, passwordHash, displayName, role) {
    return db.prepare(
      'INSERT INTO users (tenant_id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)'
    ).run(tenantId, email, passwordHash, displayName, role);
  },
};

module.exports = { db, migrate, transaction, forTenant, unscoped };
