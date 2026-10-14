'use strict';
/**
 * Populate a tenant's Manna staging account with Michael's demo data.
 *
 * Populates (idempotently — safe to re-run):
 *   1. email_snapshots  — 24h / 7d / 30d / all-time windows mirroring D2RM numbers
 *   2. email_campaigns  — real campaigns from the Oct 2026 outreach
 *   3. goals            — the five D2RM portfolio goals with current progress
 *
 * NOTE: influencer contacts (9,295 rows) are auto-seeded on server startup
 * from data/seed/influencers.csv for every tenant that has none — this script
 * does NOT touch the influencers table.
 *
 * Usage:
 *   node scripts/seed-demo-data.js [tenant-slug]
 *   node scripts/seed-demo-data.js d2rm-media        # Michael (default)
 *   node scripts/seed-demo-data.js <leon-tenant-slug> # Leon
 *
 * Exit codes: 0 = ok, 1 = tenant not found, 2 = usage/other error.
 */
const { db, migrate, unscoped } = require('../src/db');

const TENANT_SLUG = (process.argv[2] || 'd2rm-media').toLowerCase();

// ---------------------------------------------------------------------------
// Source numbers (captured 2026-10-14 from D2RM dashboard + email database).
// ---------------------------------------------------------------------------
const SNAPSHOTS = [
  // window_key, sent, opens, clicks, unsubs, bounces, warm_total, warm_by_lang
  ['24h',  1042, 223,  19, 3, 11, 19, { english: 17, french: 1, german: 1 }],
  ['7d',   1042, 223,  19, 3, 11, 19, { english: 17, french: 1, german: 1 }],
  ['30d',  1042, 223,  19, 3, 11, 19, { english: 17, french: 1, german: 1 }],
  ['all',  1042, 223,  19, 3, 11, 19, { english: 17, french: 1, german: 1 }],
];

// Real campaigns from the Oct 2026 outreach (email-database.db sends table).
// Opens/clicks are provider-aggregate figures from the analytics refresh.
const CAMPAIGNS = [
  { name: 'Pastor Combo — FaithShield + Armor Bearer <redacted> 1', provider: 'brevo',      sent: 100, opens: 21,  clicks: 2, unsubs: 0, bounces: 1, sent_at: '2026-10-12' },
  { name: 'nano-armor-bearer-oct2026',                                provider: 'kit',        sent: 208, opens: 118, clicks: 9, unsubs: 2, bounces: 3, sent_at: '2026-10-09' },
  { name: 'Pastor Trial Invite — Portuguese',                        provider: 'mailerlite', sent: 47,  opens: 27,  clicks: 3, unsubs: 0, bounces: 1, sent_at: '2026-10-07' },
  { name: 'Pastor Trial Invite — Tagalog',                            provider: 'mailerlite', sent: 108, opens: 41,  clicks: 4, unsubs: 1, bounces: 4, sent_at: '2026-10-07' },
  { name: 'send-batch-2-seniors.csv',                                 provider: 'brevo',      sent: 300, opens: 0,   clicks: 0, unsubs: 0, bounces: 0, sent_at: '2026-10-07' },
  { name: 'send-batch-1-seniors.csv',                                 provider: 'brevo',      sent: 279, opens: 0,   clicks: 0, unsubs: 0, bounces: 0, sent_at: '2026-10-06' },
];

// D2RM portfolio goals (Michael's 2026-10-12 goal set).
const GOALS = [
  { goal_key: 'email_collection', label: 'Email collection',            current_value: 1578, goal_value: 11500, unit: 'emails' },
  { goal_key: 'armor_bearer',     label: 'Armor Bearer affiliates',     current_value: 3,    goal_value: 100,   unit: 'affiliates' },
  { goal_key: 'faithshield',      label: 'FaithShield paying users',    current_value: 0,    goal_value: 100,   unit: 'users' },
  { goal_key: 'sustained',        label: 'Sustained users',             current_value: 0,    goal_value: 100,   unit: 'users' },
  { goal_key: 'k_punk',           label: 'K-Punk Kickstarter notify-me', current_value: 1,    goal_value: 5000,  unit: 'signups' },
];

function main() {
  migrate();

  const tenant = unscoped.getTenantBySlug(TENANT_SLUG);
  if (!tenant) {
    console.error(`[seed-demo] tenant not found: "${TENANT_SLUG}"`);
    console.error('[seed-demo] The account must be created first (via /signup on the staging app).');
    process.exit(1);
  }
  const tenantId = Number(tenant.id);
  console.log(`[seed-demo] tenant: ${tenant.name} (id=${tenantId}, slug=${tenant.slug})`);

  // --- email_snapshots (upsert per window) ---
  const upsertSnap = db.prepare(`
    INSERT INTO email_snapshots
      (tenant_id, window_key, sent, opens, clicks, unsubs, bounces, warm_total, warm_by_lang_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (tenant_id, window_key) DO UPDATE SET
      sent = excluded.sent, opens = excluded.opens, clicks = excluded.clicks,
      unsubs = excluded.unsubs, bounces = excluded.bounces,
      warm_total = excluded.warm_total, warm_by_lang_json = excluded.warm_by_lang_json,
      captured_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `);
  let snapCount = 0;
  for (const [key, sent, opens, clicks, unsubs, bounces, warm, langs] of SNAPSHOTS) {
    upsertSnap.run(tenantId, key, sent, opens, clicks, unsubs, bounces, warm, JSON.stringify(langs));
    snapCount++;
  }
  console.log(`[seed-demo] email_snapshots: ${snapCount} windows upserted`);

  // --- email_campaigns (insert-if-missing by name) ---
  const findCampaign = db.prepare(
    'SELECT id FROM email_campaigns WHERE tenant_id = ? AND name = ?'
  );
  const insCampaign = db.prepare(`
    INSERT INTO email_campaigns
      (tenant_id, name, provider, sent, opens, clicks, unsubs, bounces, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let campNew = 0, campSkip = 0;
  for (const c of CAMPAIGNS) {
    if (findCampaign.get(tenantId, c.name)) { campSkip++; continue; }
    insCampaign.run(tenantId, c.name, c.provider, c.sent, c.opens, c.clicks,
      c.unsubs, c.bounces, c.sent_at);
    campNew++;
  }
  console.log(`[seed-demo] email_campaigns: ${campNew} inserted, ${campSkip} already present`);

  // --- goals (upsert per goal_key) ---
  const upsertGoal = db.prepare(`
    INSERT INTO goals (tenant_id, goal_key, label, current_value, goal_value, unit)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (tenant_id, goal_key) DO UPDATE SET
      label = excluded.label, current_value = excluded.current_value,
      goal_value = excluded.goal_value, unit = excluded.unit
  `);
  let goalCount = 0;
  for (const g of GOALS) {
    upsertGoal.run(tenantId, g.goal_key, g.label, g.current_value, g.goal_value, g.unit);
    goalCount++;
  }
  console.log(`[seed-demo] goals: ${goalCount} upserted`);

  // --- summary: influencer contact count (seeded automatically on boot) ---
  const infCount = db.prepare(
    'SELECT COUNT(*) AS n FROM influencers WHERE tenant_id = ?'
  ).get(tenantId);
  console.log(`[seed-demo] influencers in tenant: ${infCount.n} (auto-seeded from CSV on startup)`);

  console.log('[seed-demo] done');
}

main();
