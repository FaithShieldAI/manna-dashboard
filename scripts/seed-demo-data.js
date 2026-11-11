'use strict';
/**
 * Populate a tenant's Manna account with starter data.
 *
 * FIRST-RUN ONLY: every write below is insert-if-missing, so this script
 * is safe to run at every server boot and at signup (src/server.js boot
 * loop, src/routes/auth.js) — it fills gaps for new tenants and NEVER
 * overwrites a row that already exists. An earlier version upserted on
 * every run, which re-planted retired goals, reset live counters
 * (including the Stripe-fed FaithShield goal) and re-froze the email
 * snapshots on every restart; that behavior was retired 2026-11-10.
 *
 * Populates:
 *   1. goals            — the D2RM portfolio goal set, imported from
 *                         src/lib/syncD2rm.js (GOALS there is the single
 *                         source of truth — no 'sustained': Sustained
 *                         left the suite 2026-10-28)
 *   2. email_campaigns  — real campaigns from the Oct 2026 outreach
 *   3. email_snapshots  — zeroed starter rows for the four windows.
 *                         Real email windows are owned by the live
 *                         mail-truth chain (email-snapshots-sync); the
 *                         frozen 2026-10-14 capture (1042/223/19 in
 *                         every window) that used to be upserted here
 *                         was retired 2026-11-10 and must not come back.
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
// Single source of truth for the goal set (see header). Importing is
// side-effect-free: syncD2rm only touches a DB when a sync is invoked.
const { GOALS } = require('../src/lib/syncD2rm');

const TENANT_SLUG = (process.argv[2] || 'd2rm-media').toLowerCase();

// Email snapshot windows. Starter rows are zeroed; the mail-truth chain
// posts the real combined windows over them.
const SNAPSHOT_WINDOWS = ['24h', '7d', '30d', 'all'];

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

function main(tenantSlug) {
  migrate();

  const slug = (tenantSlug || TENANT_SLUG).toLowerCase();
  const tenant = unscoped.getTenantBySlug(slug);
  if (!tenant) {
    // NOTE: throw (don't process.exit) so this module is safe to require
    // from the signup route. The CLI wrapper below converts to exit code 1.
    throw new Error(`[seed-demo] tenant not found: "${slug}" — the account must be created first (via /signup).`);
  }
  const tenantId = Number(tenant.id);
  console.log(`[seed-demo] tenant: ${tenant.name} (id=${tenantId}, slug=${tenant.slug})`);

  // --- goals (insert-only: never overwrite an existing goal's progress) ---
  const insGoal = db.prepare(`
    INSERT INTO goals (tenant_id, goal_key, label, current_value, goal_value, unit)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (tenant_id, goal_key) DO NOTHING
  `);
  let goalNew = 0;
  for (const g of GOALS) {
    // GOALS in syncD2rm leaves email_collection's current_value null (the
    // sync fills it from the live contact count; GET /api/goals overrides
    // it at read time). The column is NOT NULL, so a starter row stores 0.
    const current = g.current_value == null ? 0 : g.current_value;
    goalNew += insGoal.run(tenantId, g.goal_key, g.label, current, g.goal_value, g.unit).changes;
  }
  console.log(`[seed-demo] goals: ${goalNew} inserted, ${GOALS.length - goalNew} already present`);

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

  // --- email_snapshots (zeroed starter rows, insert-only) ---
  const insSnap = db.prepare(`
    INSERT INTO email_snapshots (tenant_id, window_key)
    VALUES (?, ?)
    ON CONFLICT (tenant_id, window_key) DO NOTHING
  `);
  let snapNew = 0;
  for (const key of SNAPSHOT_WINDOWS) {
    snapNew += insSnap.run(tenantId, key).changes;
  }
  console.log(`[seed-demo] email_snapshots: ${snapNew} zeroed starter rows inserted, ${SNAPSHOT_WINDOWS.length - snapNew} already present`);

  // --- summary: influencer contact count (seeded automatically on boot) ---
  const infCount = db.prepare(
    'SELECT COUNT(*) AS n FROM influencers WHERE tenant_id = ?'
  ).get(tenantId);
  console.log(`[seed-demo] influencers in tenant: ${infCount.n} (auto-seeded from CSV on startup)`);

  console.log('[seed-demo] done');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { seedDemoData: main, GOALS, SNAPSHOT_WINDOWS };
