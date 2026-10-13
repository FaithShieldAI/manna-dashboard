'use strict';
/**
 * Seed script — creates a demo tenant ("Acme Ministries") with realistic
 * dashboard data mirroring the current D2RM dashboard's shape, plus a
 * second tenant ("Other Org") with a single marker row per table to prove
 * tenant isolation in tests.
 *
 * Usage: SEED_OWNER_EMAIL=you@example.com SEED_OWNER_PASSWORD=<12+ chars>
 *        node scripts/seed.js
 *
 * The script is idempotent-ish: it skips tenants whose slug already exists.
 */
const { db, migrate, unscoped, forTenant } = require('../src/db');
const password = require('../src/lib/password');

const EMAIL = process.env.SEED_OWNER_EMAIL || 'owner@acme.example';
const PW = process.env.SEED_OWNER_PASSWORD || 'change-me-please-123';

async function main() {
  migrate();

  if (PW.length < 12) {
    console.error('SEED_OWNER_PASSWORD must be >= 12 chars (or set a real one via env).');
    process.exit(1);
  }

  // ------------------------------------------------------------------ tenant 1
  if (!unscoped.getTenantBySlug('acme-ministries')) {
    const t = unscoped.createTenant('Acme Ministries', 'acme-ministries', 'pro');
    const tenantId = Number(t.lastInsertRowid);
    const hash = await password.hash(PW);
    unscoped.createUser(tenantId, EMAIL.toLowerCase(), hash, 'Acme Owner', 'owner');

    const tdb = () => forTenant(tenantId); // scoped helpers need raw inserts here
    const ins = (sql, ...p) => db.prepare(sql).run(tenantId, ...p);

    // sites
    const siteIds = {};
    for (const [key, name, url, emoji] of [
      ['main', 'Main Site', 'https://example.org', '🌐'],
      ['blog', 'Blog', 'https://example.org/blog', '✍️'],
    ]) {
      const r = ins('INSERT INTO sites (tenant_id, site_key, name, url, emoji, collect_key) VALUES (?, ?, ?, ?, ?, ?)',
        key, name, url, emoji, `demo-collect-key-${key}`);
      siteIds[key] = Number(r.lastInsertRowid);
    }

    // 30 days of site metrics (deterministic-ish, no randomness in tests)
    const today = new Date();
    for (let d = 0; d < 30; d++) {
      const dt = new Date(today);
      dt.setDate(dt.getDate() - d);
      const day = dt.toISOString().slice(0, 10);
      for (const [key, base] of [['main', 120], ['blog', 45]]) {
        const visitors = base + ((d * 7) % 40);
        ins(`INSERT INTO site_daily_metrics
             (tenant_id, site_id, day, visitors, pageviews, bounce_rate, avg_duration_s)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          siteIds[key], day, visitors, visitors * 2, 42.5, 95);
      }
    }

    // conversion events
    for (const [key, evts] of [['main', [['signup', 12], ['donate_click', 5]]], ['blog', [['newsletter_signup', 8]]]]) {
      for (const [name, n] of evts) {
        for (let i = 0; i < n; i++) {
          ins(`INSERT INTO site_events (tenant_id, site_id, event_name, occurred_at, session_key)
               VALUES (?, ?, ?, ?, ?)`,
            siteIds[key], name, new Date(Date.now() - i * 36e5).toISOString(), `${key}-${name}-${i}`);
        }
      }
    }

    // email snapshots (mirrors EMAIL_WINDOWS shape)
    for (const [w, sent, opens, clicks] of [['24h', 438, 60, 2], ['7d', 1519, 326, 33], ['30d', 1519, 326, 33], ['all', 1768, 397, 35]]) {
      ins(`INSERT INTO email_snapshots
           (tenant_id, window_key, sent, opens, clicks, unsubs, bounces, warm_total, warm_by_lang_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        w, sent, opens, clicks, 2, 47, 19, JSON.stringify({ english: 17, french: 1, german: 1 }));
    }

    // campaigns (with ROI: $50 spend -> $210 revenue)
    ins(`INSERT INTO email_campaigns (tenant_id, name, provider, sent, opens, clicks, unsubs, bounces, sent_at, cost_cents, revenue_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'Weekly Update #42', 'brevo', 500, 110, 12, 1, 8, new Date().toISOString(), 5000, 21000);

    // funnels (with ROI figures)
    let order = 0;
    for (const [fkey, name, emoji, subtitle, stages, cost, revenue] of [
      ['newsletter', 'Newsletter Growth', '📬', 'Email → subscribers', [
        ['sent', 'Emails sent', 1519, 43700],
        ['opened', 'Opened', 326, 8200],
        ['clicked', 'Clicked', 33, 826],
        ['subscribed', 'Subscribed', 4, 100],
      ], 5000, 21000],
      ['course', 'Course Launch', '🎓', 'Visitors → buyers', [
        ['visitors', 'Visitors', 120000, 120000],
        ['leads', 'Email leads', 15000, 15000],
        ['buyers', 'Buyers', 120, 5000],
      ], 20000, 60000],
    ]) {
      const fr = ins('INSERT INTO funnels (tenant_id, funnel_key, name, emoji, subtitle, sort_order, cost_cents, revenue_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        fkey, name, emoji, subtitle, order++, cost, revenue);
      const fid = Number(fr.lastInsertRowid);
      let sord = 0;
      for (const [skey, label, cur, goal] of stages) {
        db.prepare(`INSERT INTO funnel_stages (funnel_id, stage_key, label, current_value, goal_value, sort_order)
                    VALUES (?, ?, ?, ?, ?, ?)`)
          .run(fid, skey, label, cur, goal, sord++);
      }
    }

    // influencers (incl. podcast category)
    const inf = [
      ['graceTalks', 'youtube', 'grace@example.org', 'micro', 'influencer', 'vetted'],
      ['faithPod', 'spotify', 'host@faithpod.example', null, 'podcast', 'contacted'],
      ['hopeDaily', 'instagram', null, 'nano', 'influencer', 'unvetted'],
    ];
    for (const [handle, platform, email, tier, category, status] of inf) {
      ins(`INSERT INTO influencers (tenant_id, handle, platform, email, tier, category, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`, handle, platform, email, tier, category, status);
    }

    // IP assets
    ins(`INSERT INTO ip_assets (tenant_id, title, description, asset_type, status, content_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      'Brand Playbook', 'Internal brand guide', 'copyright', 'created-unregistered',
      'abc123def456');

    // social
    ins(`INSERT INTO social_accounts (tenant_id, platform, handle, followers, posts)
         VALUES (?, ?, ?, ?, ?)`, 'instagram', '@acme.ministries', 12500, 340);

    // demo collection job (completed) + one collected lead
    ins(`INSERT INTO collection_jobs (tenant_id, source, keywords_json, seeds_json, max_results, status, found_count, new_count, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'youtube', JSON.stringify(['faith podcast']), JSON.stringify([]), 25, 'done', 2, 1,
      new Date(Date.now() - 36e5).toISOString(), new Date(Date.now() - 33e5).toISOString());
    ins(`INSERT INTO influencers (tenant_id, handle, platform, email, tier, category, status, notes, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'demo-creator', 'youtube', 'hello@democreator.example', 'micro', 'influencer', 'unvetted',
      'Collected for keyword "faith podcast" from YouTube channel "Demo Creator"', 'lead-collect:youtube');

    // goals
    ins(`INSERT INTO goals (tenant_id, goal_key, label, current_value, goal_value, unit)
         VALUES (?, ?, ?, ?, ?, ?)`,
      'email_collection', 'Emails collected', 1578, 11500, 'emails');

    console.log(`[seed] tenant "acme-ministries" created (owner: ${EMAIL.toLowerCase()})`);
  } else {
    console.log('[seed] tenant "acme-ministries" already exists — skipping');
  }

  // ------------------------------------------------------------------ tenant 2
  // Marker tenant: exactly one row per table, used by tenancy tests to prove
  // tenant A can never see tenant B's rows.
  if (!unscoped.getTenantBySlug('other-org')) {
    const t = unscoped.createTenant('Other Org', 'other-org', 'starter');
    const tid = Number(t.lastInsertRowid);
    const hash = await password.hash('other-org-password-123');
    unscoped.createUser(tid, 'owner@other.example', hash, 'Other Owner', 'owner');
    const ins = (sql, ...p) => db.prepare(sql).run(tid, ...p);
    const sr = ins('INSERT INTO sites (tenant_id, site_key, name) VALUES (?, ?, ?)', 'site', 'Other Site');
    ins(`INSERT INTO site_daily_metrics (tenant_id, site_id, day, visitors, pageviews)
         VALUES (?, ?, ?, ?, ?)`, Number(sr.lastInsertRowid), '2026-10-01', 999, 999);
    ins(`INSERT INTO email_snapshots (tenant_id, window_key, sent) VALUES (?, ?, ?)`, 'all', 999);
    ins(`INSERT INTO influencers (tenant_id, handle, category) VALUES (?, ?, ?)`, 'other-guy', 'influencer');
    ins(`INSERT INTO ip_assets (tenant_id, title, asset_type) VALUES (?, ?, ?)`, 'Other Asset', 'copyright');
    ins(`INSERT INTO social_accounts (tenant_id, platform, handle) VALUES (?, ?, ?)`, 'tiktok', '@other');
    ins(`INSERT INTO goals (tenant_id, goal_key, label, current_value, goal_value) VALUES (?, ?, ?, ?, ?)`,
      'g', 'Other Goal', 999, 1000);
    const fr = ins('INSERT INTO funnels (tenant_id, funnel_key, name) VALUES (?, ?, ?)', 'f', 'Other Funnel');
    db.prepare('INSERT INTO funnel_stages (funnel_id, stage_key, label, current_value) VALUES (?, ?, ?, ?)')
      .run(Number(fr.lastInsertRowid), 's', 'Stage', 999);
    console.log('[seed] tenant "other-org" created (isolation marker)');
  } else {
    console.log('[seed] tenant "other-org" already exists — skipping');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
