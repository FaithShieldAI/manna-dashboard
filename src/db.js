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

// FIX 2026-10-29 (audit B3): state the resolved database path in the boot
// log, and whether an existing file was found or a NEW empty database is
// about to be created. The deploy flips DATABASE_PATH to the persistent
// disk (/var/data); this line is the proof in the logs of which file the
// process actually opened — the failure mode being guarded against is a
// quiet boot against a fresh empty DB while the real data sits elsewhere.
const DB_FILE_EXISTED = fs.existsSync(DB_PATH);
// eslint-disable-next-line no-console
console.log(
  `[db] DATABASE_PATH=${DB_PATH} (${process.env.DATABASE_PATH ? 'from env' : 'default'}) — `
  + (DB_FILE_EXISTED ? 'existing database file found, opening it' : 'no file found, creating a NEW empty database')
);
if (!process.env.DATABASE_PATH && process.env.NODE_ENV === 'production') {
  // eslint-disable-next-line no-console
  console.warn('[db] WARNING: DATABASE_PATH is unset in production — the default path lives inside the app directory and may be EPHEMERAL storage that a redeploy can wipe.');
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

/** Parse a JSON column value; null on missing/malformed (never throws). */
function safeJson(v) {
  if (v == null) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}

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

function appliedVersions() {
  try {
    return new Set(
      db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version)
    );
  } catch (e) {
    // schema_migrations doesn't exist yet (fresh DB)
    return new Set();
  }
}

function migrate() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d+_.*\.sql$/.test(f))
    .sort();
  const fileVersions = new Map();
  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10);
    if (fileVersions.has(version)) {
      throw new Error(
        `[migrate] duplicate migration version ${version}: ${fileVersions.get(version)} and ${file}`
      );
    }
    fileVersions.set(version, file);
  }
  const applied = appliedVersions();
  // Fail loud on a recorded version with no file on disk: the DB claims a
  // migration ran that this codebase cannot account for (wrong tree,
  // backup restored from a newer build). Never guess past it.
  for (const v of [...applied].sort((a, b) => a - b)) {
    if (!fileVersions.has(v)) {
      throw new Error(
        `[migrate] schema_migrations records version ${v} but no migration file for it exists in ${MIGRATIONS_DIR} — refusing to migrate a database this build cannot account for`
      );
    }
  }
  // Apply by SET DIFFERENCE, not "version > MAX(applied)" (red-team round
  // 1, F-A2): a DB stamped with a higher version while an earlier file was
  // absent must still receive the missing migration, in version order —
  // the MAX() test silently skipped it forever.
  const pending = [...fileVersions.keys()]
    .filter(v => !applied.has(v))
    .sort((a, b) => a - b);
  for (const version of pending) {
    const file = fileVersions.get(version);
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
      let sql = 'SELECT id, handle, platform, email, tier, category, status, notes, source, emails_queued, emails_sent, emails_opened, emails_clicked, last_emailed_at, created_at FROM influencers WHERE tenant_id = ?';
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

    // -- video generation jobs (migration 026) ---------------------------
    createVideoJob({ script, avatarKey, voiceKey, engine, provider }) {
      return db.prepare(`
        INSERT INTO video_jobs (tenant_id, script, avatar_key, voice_key, engine, provider)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(t, script, avatarKey, voiceKey, engine || 'standard', provider || 'heygen');
    },
    listVideoJobs(limit = 50) {
      return db.prepare(`
        SELECT id, script, avatar_key, voice_key, engine, provider, status,
               video_url, duration_s, error, created_at, updated_at, finished_at
        FROM video_jobs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(t, limit);
    },
    getVideoJob(id) {
      return db.prepare(`
        SELECT id, script, avatar_key, voice_key, engine, provider, provider_job_id, status,
               video_url, duration_s, error, created_at, updated_at, finished_at
        FROM video_jobs WHERE tenant_id = ? AND id = ?`).get(t, id);
    },
    updateVideoJob(id, fields) {
      const allowed = ['provider_job_id', 'status', 'video_url', 'duration_s', 'error', 'finished_at'];
      const sets = [];
      const params = [];
      for (const k of allowed) {
        if (fields[k] !== undefined) { sets.push(`${k} = ?`); params.push(fields[k]); }
      }
      if (!sets.length) return;
      sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      params.push(t, id);
      db.prepare(`UPDATE video_jobs SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`)
        .run(...params);
    },
    /**
     * Allowance accounting: jobs that consumed (or are consuming) a render.
     * 'failed' rows never rendered, so they never count. `sinceIso` null
     * counts all-time (trial cap); a month-start ISO counts that month
     * (Heavy monthly caps).
     */
    countVideoJobs(sinceIso) {
      const row = sinceIso
        ? db.prepare(`
            SELECT COUNT(*) AS n FROM video_jobs
            WHERE tenant_id = ? AND status IN ('queued','processing','completed')
              AND created_at >= ?`).get(t, sinceIso)
        : db.prepare(`
            SELECT COUNT(*) AS n FROM video_jobs
            WHERE tenant_id = ? AND status IN ('queued','processing','completed')`).get(t);
      return row ? row.n : 0;
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
    /** Internal: returns the row WITH token material for server-side decrypt. */
    getConnectedSocial(platform) {
      return db.prepare(
        `SELECT platform, handle, access_token_enc, refresh_token_enc, expires_at, created_at
         FROM connected_socials WHERE tenant_id = ? AND platform = ?`
      ).get(t, platform) || null;
    },
    upsertSocialAccount({ platform, handle }) {
      return db.prepare(`
        INSERT INTO social_accounts (tenant_id, platform, handle, followers, posts)
        VALUES (?, ?, ?, 0, 0)
        ON CONFLICT (tenant_id, platform, handle) DO NOTHING`).run(t, platform, handle);
    },
    /** Update tracked follower/post counts for a connected platform account. */
    updateSocialStats({ platform, handle, followers, posts }) {
      return db.prepare(`
        UPDATE social_accounts SET followers = ?, posts = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE tenant_id = ? AND platform = ? AND handle = ?`)
        .run(followers || 0, posts || 0, t, platform, handle);
    },

    // -- facebook pages (per-Page tokens; tokens stored encrypted) -----------
    upsertFacebookPage({ pageId, pageName, pageTokenEnc, igUserId, igUsername }) {
      return db.prepare(`
        INSERT INTO facebook_pages (tenant_id, page_id, page_name, page_token_enc, ig_user_id, ig_username)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, page_id)
        DO UPDATE SET page_name = excluded.page_name,
                      page_token_enc = excluded.page_token_enc,
                      ig_user_id = excluded.ig_user_id,
                      ig_username = excluded.ig_username`)
        .run(t, pageId, pageName || '', pageTokenEnc || null, igUserId || null, igUsername || '');
    },
    /** Public-safe list: never returns token material, only a has_token flag. */
    listFacebookPages() {
      return db.prepare(`
        SELECT id, page_id, page_name, ig_user_id, ig_username, created_at,
               (page_token_enc IS NOT NULL) AS has_token
        FROM facebook_pages WHERE tenant_id = ? ORDER BY page_name`).all(t)
        .map(r => ({ ...r, has_token: Boolean(r.has_token) }));
    },
    /** Internal: returns the row WITH page_token_enc for server-side decrypt. */
    getFacebookPage(pageId) {
      return db.prepare(`
        SELECT id, page_id, page_name, page_token_enc, ig_user_id, ig_username, created_at
        FROM facebook_pages WHERE tenant_id = ? AND page_id = ?`).get(t, pageId);
    },
    deleteFacebookPage(pageId) {
      return db.prepare(
        'DELETE FROM facebook_pages WHERE tenant_id = ? AND page_id = ?'
      ).run(t, pageId);
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
    installEmailTemplate({ templateKey, name, subject, bodyHtml, bodyText, category, isStarter, product, language }) {
      return db.prepare(`
        INSERT INTO email_templates (tenant_id, template_key, name, subject, body_html, body_text, category, is_starter, product, language)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, template_key) DO NOTHING`)
        .run(t, templateKey, name, subject || '', bodyHtml || '', bodyText || '',
          category || null, isStarter ? 1 : 0, product || 'manna', language || 'en');
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

    // -- video / social post performance (Scribe data-read layer) --------
    videoPostings(limit = 50) {
      return db.prepare(`
        SELECT id, video_name, product, platform, account_handle, post_url, posted_at,
               views, likes, comments, shares, notes
        FROM video_postings WHERE tenant_id = ? ORDER BY posted_at DESC LIMIT ?`)
        .all(t, limit);
    },
    socialPostings(limit = 50) {
      return db.prepare(`
        SELECT id, platform, post_url, content_item_id, posted_at,
               likes, shares, comments, clicks
        FROM social_postings WHERE tenant_id = ? ORDER BY posted_at DESC LIMIT ?`)
        .all(t, limit);
    },
    intakeDaily(days = 14) {
      return db.prepare(`
        SELECT date, category, new_count FROM intake_daily
        WHERE tenant_id = ? AND date >= date('now', '-' || ? || ' days')
        ORDER BY date DESC, category`).all(t, days);
    },

    // -- Scribe analyses (server-side store of validated advice) ---------
    // /analyze persists its validated advice here and returns only the
    // opaque id; drafts are created from the stored record, so provenance
    // (mode/transport) is server-side truth — never client input (F1).
    createScribeAnalysis({ id, mode, transport, advice, signals, expiresAt }) {
      return db.prepare(`
        INSERT INTO scribe_analyses (id, tenant_id, mode, transport, advice_json, signals_json, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, t, mode, transport,
          JSON.stringify(advice || {}), JSON.stringify(signals || {}), expiresAt);
    },
    getScribeAnalysis(id) {
      // Tenant-scoped AND unexpired; missing, foreign, and expired ids are
      // indistinguishable (all null) so ids can't be probed across tenants.
      const r = db.prepare(`
        SELECT id, mode, transport, advice_json, signals_json, created_at, expires_at
        FROM scribe_analyses
        WHERE tenant_id = ? AND id = ?
          AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`).get(t, id);
      if (!r) return null;
      return {
        id: r.id, mode: r.mode, transport: r.transport,
        advice: safeJson(r.advice_json), signals: safeJson(r.signals_json),
        created_at: r.created_at, expires_at: r.expires_at,
      };
    },

    // -- Scribe drafts (act-layer artifacts; status starts 'draft') -------
    insertScribeDrafts(rows) {
      // One transaction for the whole batch (F11): a failure mid-batch
      // leaves zero drafts, never a partial set.
      return transaction(() => rows.map(row => Number(db.prepare(`
        INSERT INTO scribe_drafts (tenant_id, draft_type, title, body, payload_json, source, analysis_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(t, row.draftType, row.title, row.body || null,
          JSON.stringify(row.payload || {}), row.source, row.analysisId || null)
        .lastInsertRowid)));
    },
    listScribeDraftsByAnalysis(analysisId) {
      return db.prepare(`
        SELECT id, draft_type, title, status, source, analysis_id
        FROM scribe_drafts WHERE tenant_id = ? AND analysis_id = ? ORDER BY id`)
        .all(t, analysisId);
    },
    countScribeDrafts({ status } = {}) {
      let sql = 'SELECT COUNT(*) AS n FROM scribe_drafts WHERE tenant_id = ?';
      const params = [t];
      if (status) { sql += ' AND status = ?'; params.push(status); }
      return db.prepare(sql).get(...params).n;
    },
    listScribeDrafts({ status, limit = 100 } = {}) {
      let sql = `SELECT id, draft_type, title, body, payload_json, source, status, analysis_id, decided_by, decided_at, created_at, updated_at
                 FROM scribe_drafts WHERE tenant_id = ?`;
      const params = [t];
      if (status) { sql += ' AND status = ?'; params.push(status); }
      sql += ' ORDER BY id DESC LIMIT ?';
      params.push(limit);
      return db.prepare(sql).all(...params)
        .map(r => ({ ...r, payload: safeJson(r.payload_json), payload_json: undefined }));
    },
    getScribeDraft(id) {
      const r = db.prepare(`
        SELECT id, draft_type, title, body, payload_json, source, status, analysis_id, decided_by, decided_at, created_at, updated_at
        FROM scribe_drafts WHERE tenant_id = ? AND id = ?`).get(t, id);
      if (!r) return null;
      return { ...r, payload: safeJson(r.payload_json), payload_json: undefined };
    },
    setScribeDraftStatus(id, status, decidedBy) {
      // State machine (F5): only a row still in 'draft' may transition, and
      // the decision is audited (decided_by / decided_at). 0 changes means
      // the draft was already decided — terminal states are final.
      const r = db.prepare(`
        UPDATE scribe_drafts
        SET status = ?, decided_by = ?,
            decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE tenant_id = ? AND id = ? AND status = 'draft'`)
        .run(status, decidedBy || null, t, id);
      return r.changes > 0;
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
