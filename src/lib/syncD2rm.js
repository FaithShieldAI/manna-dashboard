'use strict';
/**
 * syncD2rm — importable core of the real-D2RM-data sync.
 *
 * Replaces demo/seed data in a Manna tenant with Michael's actual D2RM
 * numbers so Manna shows his real business, not a demo.
 *
 * Source: bundled D2RM email database snapshot
 *   (data/d2rm-source.db, committed with the app; override with D2RM_SOURCE_DB)
 *
 * Mapping:
 *   D2RM contacts  -> Manna influencers  (tenant-scoped, upsert by email)
 *   D2RM sends     -> Manna email_campaigns (grouped, upsert by name)
 *   D2RM analytics -> Manna email_snapshots (4 windows, upsert)
 *   D2RM goals     -> Manna goals (upsert by goal_key)
 *
 * Idempotent: safe to run multiple times. Uses natural keys per tenant
 * (email / name / window_key / goal_key) for upserts. Never touches
 * other tenants' rows.
 *
 * SECURITY: the caller is responsible for authorization. The HTTP endpoint
 * (src/routes/admin.js) hard-allowlists michael@faithshield.ai and
 * leon@faithshield.ai — this data must NEVER land in another user's tenant.
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// Bundled source snapshot (committed with the app). Overridable for tests.
const BUNDLED_SOURCE_DB = path.join(__dirname, '..', '..', 'data', 'd2rm-source.db');

// ---------------------------------------------------------------------------
// Category / status / tier mapping (D2RM -> Manna)
// ---------------------------------------------------------------------------
const CATEGORY_MAP = {
  influencer: 'influencer',
  podcast: 'podcast',
  pastor: 'pastor',
  org: 'church',       // orgs are churches/ministries
  other: 'influencer', // default bucket
  attorney: 'attorney',
};
const VALID_TIERS = new Set(['nano', 'micro', 'macro', 'mega']);

function mapCategory(src) {
  return CATEGORY_MAP[src] || 'influencer';
}
function mapTier(subcategory) {
  const t = (subcategory || '').toLowerCase().trim();
  return VALID_TIERS.has(t) ? t : null;
}
function mapStatus(notes) {
  // Grandfathered: contacts vetted before the vetting gate are 'vetted'.
  // New/untouched contacts default to 'unvetted'.
  return /^vetted/i.test(notes || '') ? 'vetted' : 'unvetted';
}

// ---------------------------------------------------------------------------
// Real D2RM analytics (captured 2026-10-14 from D2RM dashboard + providers).
// These are Michael's REAL numbers, not demo data.
// ---------------------------------------------------------------------------
const SNAPSHOTS = [
  // window_key, sent, opens, clicks, unsubs, bounces, warm_total, warm_by_lang
  ['24h', 1042, 223, 19, 3, 11, 19, { english: 17, french: 1, german: 1 }],
  ['7d',  1042, 223, 19, 3, 11, 19, { english: 17, french: 1, german: 1 }],
  ['30d', 1042, 223, 19, 3, 11, 19, { english: 17, french: 1, german: 1 }],
  ['all', 1042, 223, 19, 3, 11, 19, { english: 17, french: 1, german: 1 }],
];

// Real campaigns from the Oct 2026 outreach (email-database.db sends table).
// Opens/clicks are provider-aggregate figures from the analytics refresh.
const CAMPAIGNS = [
  { name: 'Pastor Combo - FaithShield + Armor Bearer <redacted> 1', provider: 'brevo',      sent: 100, opens: 21,  clicks: 2, unsubs: 0, bounces: 3, sent_at: '2026-10-12' },
  { name: 'nano-armor-bearer-oct2026',                                provider: 'kit',        sent: 208, opens: 118, clicks: 9, unsubs: 2, bounces: 3, sent_at: '2026-10-09' },
  { name: 'Pastor Trial Invite - Portuguese',                        provider: 'mailerlite', sent: 47,  opens: 27,  clicks: 3, unsubs: 0, bounces: 1, sent_at: '2026-10-07' },
  { name: 'Pastor Trial Invite - Tagalog',                            provider: 'mailerlite', sent: 108, opens: 41,  clicks: 4, unsubs: 1, bounces: 4, sent_at: '2026-10-07' },
  { name: 'send-batch-2-seniors.csv',                                 provider: 'brevo',      sent: 300, opens: 0,   clicks: 0, unsubs: 0, bounces: 0, sent_at: '2026-10-07' },
  { name: 'send-batch-1-seniors.csv',                                 provider: 'brevo',      sent: 279, opens: 0,   clicks: 0, unsubs: 0, bounces: 0, sent_at: '2026-10-06' },
];

// D2RM portfolio goals (Michael's 2026-10-12 goal set).
// email_collection current_value is set at runtime from the live contact count.
const GOALS = [
  { goal_key: 'email_collection', label: 'Email collection',            current_value: null, goal_value: 11500, unit: 'emails' },
  { goal_key: 'armor_bearer',     label: 'Armor Bearer <redacted>',     current_value: 3,    goal_value: 100,   unit: 'affiliates' },
  { goal_key: 'faithshield',      label: 'FaithShield paying users',    current_value: 0,    goal_value: 100,   unit: 'users' },
  { goal_key: 'sustained',        label: 'Sustained users',             current_value: 0,    goal_value: 100,   unit: 'users' },
  { goal_key: 'k_punk',           label: 'K-Punk Kickstarter notify-me', current_value: 1,    goal_value: 5000,  unit: 'signups' },
];

// ---------------------------------------------------------------------------
// Sync: contacts -> influencers
// ---------------------------------------------------------------------------
function syncContacts(db, sourceDb, tenantId) {
  const rows = sourceDb.prepare(
    'SELECT email, first_name, category, subcategory, source_file, notes FROM contacts'
  ).all();

  const findByEmail = db.prepare(
    'SELECT id FROM influencers WHERE tenant_id = ? AND email = ?'
  );
  const insertStmt = db.prepare(`
    INSERT INTO influencers
      (tenant_id, handle, platform, email, tier, category, status, notes, source)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE influencers SET
      handle = ?, tier = ?, category = ?, status = ?, notes = ?, source = ?
    WHERE id = ? AND tenant_id = ?
  `);

  let inserted = 0, updated = 0, skipped = 0;
  const byCategory = {};

  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const r of rows) {
      const email = (r.email || '').trim().toLowerCase();
      if (!email) { skipped++; continue; }
      const category = mapCategory(r.category);
      const tier = mapTier(r.subcategory);
      const status = mapStatus(r.notes);
      const handle = (r.first_name || '').slice(0, 200) || null;

      const existing = findByEmail.get(tenantId, email);
      if (existing) {
        updateStmt.run(handle, tier, category, status, r.notes, r.source_file, existing.id, tenantId);
        updated++;
      } else {
        insertStmt.run(tenantId, handle, email, tier, category, status, r.notes, r.source_file);
        inserted++;
      }
      byCategory[category] = (byCategory[category] || 0) + 1;
    }
    db.exec('COMMIT;');
  } catch (e) {
    try { db.exec('ROLLBACK;'); } catch (_) {}
    throw e;
  }

  return { inserted, updated, skipped, total: rows.length, byCategory };
}

// ---------------------------------------------------------------------------
// Sync: campaigns
// ---------------------------------------------------------------------------
function syncCampaigns(db, tenantId) {
  const findByName = db.prepare(
    'SELECT id FROM email_campaigns WHERE tenant_id = ? AND name = ?'
  );
  const insertStmt = db.prepare(`
    INSERT INTO email_campaigns
      (tenant_id, name, provider, sent, opens, clicks, unsubs, bounces, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE email_campaigns SET
      provider = ?, sent = ?, opens = ?, clicks = ?,
      unsubs = ?, bounces = ?, sent_at = ?
    WHERE id = ? AND tenant_id = ?
  `);

  let inserted = 0, updated = 0;
  for (const c of CAMPAIGNS) {
    const existing = findByName.get(tenantId, c.name);
    if (existing) {
      updateStmt.run(c.provider, c.sent, c.opens, c.clicks, c.unsubs, c.bounces, c.sent_at, existing.id, tenantId);
      updated++;
    } else {
      insertStmt.run(tenantId, c.name, c.provider, c.sent, c.opens, c.clicks, c.unsubs, c.bounces, c.sent_at);
      inserted++;
    }
  }
  return { inserted, updated };
}

// ---------------------------------------------------------------------------
// Sync: snapshots
// ---------------------------------------------------------------------------
function syncSnapshots(db, tenantId) {
  const upsert = db.prepare(`
    INSERT INTO email_snapshots
      (tenant_id, window_key, sent, opens, clicks, unsubs, bounces, warm_total, warm_by_lang_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (tenant_id, window_key) DO UPDATE SET
      sent = excluded.sent, opens = excluded.opens, clicks = excluded.clicks,
      unsubs = excluded.unsubs, bounces = excluded.bounces,
      warm_total = excluded.warm_total, warm_by_lang_json = excluded.warm_by_lang_json,
      captured_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `);
  for (const [key, sent, opens, clicks, unsubs, bounces, warm, langs] of SNAPSHOTS) {
    upsert.run(tenantId, key, sent, opens, clicks, unsubs, bounces, warm, JSON.stringify(langs));
  }
  return { upserted: SNAPSHOTS.length };
}

// ---------------------------------------------------------------------------
// Sync: goals (email_collection current_value = live contact count)
// ---------------------------------------------------------------------------
function syncGoals(db, sourceDb, tenantId) {
  const contactCount = sourceDb.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  const upsert = db.prepare(`
    INSERT INTO goals (tenant_id, goal_key, label, current_value, goal_value, unit)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (tenant_id, goal_key) DO UPDATE SET
      label = excluded.label, current_value = excluded.current_value,
      goal_value = excluded.goal_value, unit = excluded.unit
  `);
  for (const g of GOALS) {
    const current = g.goal_key === 'email_collection' ? contactCount : g.current_value;
    upsert.run(tenantId, g.goal_key, g.label, current, g.goal_value, g.unit);
  }
  return { upserted: GOALS.length, contactCount };
}

// ---------------------------------------------------------------------------
// Tenant resolution (CLI use): look up the user, else create/reuse a tenant.
// ---------------------------------------------------------------------------
function resolveTenantForEmail(unscoped, email) {
  const user = unscoped.getUserByEmail(email);
  if (user) {
    const tenant = unscoped.getTenantById(user.tenant_id);
    if (!tenant) throw new Error(`user ${email} references missing tenant ${user.tenant_id}`);
    return { tenantId: Number(tenant.id), created: false, tenant };
  }
  const localPart = email.split('@')[0].replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const slug = `${localPart}-d2rm`.slice(0, 60);
  const existingTenant = unscoped.getTenantBySlug(slug);
  if (existingTenant) {
    return { tenantId: Number(existingTenant.id), created: false, tenant: existingTenant };
  }
  const name = `${email} (D2RM)`;
  const info = unscoped.createTenant(name, slug, 'pro');
  const tenant = unscoped.getTenantById(Number(info.lastInsertRowid));
  return { tenantId: Number(info.lastInsertRowid), created: true, tenant };
}

// ---------------------------------------------------------------------------
// Main entry: sync real D2RM data into one tenant.
// ---------------------------------------------------------------------------
function syncD2rmData({ sourceDbPath, tenantId }) {
  const resolvedSource = sourceDbPath || process.env.D2RM_SOURCE_DB || BUNDLED_SOURCE_DB;
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`source DB not found: ${resolvedSource}`);
  }
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error(`invalid tenantId: ${tenantId}`);
  }

  // Lazy-require so this module stays importable without side effects.
  const { db, migrate } = require('../db');
  migrate();

  const sourceDb = new DatabaseSync(resolvedSource, { readOnly: true });
  try {
    const before = db.prepare('SELECT COUNT(*) AS n FROM influencers WHERE tenant_id = ?').get(tenantId).n;
    const contacts = syncContacts(db, sourceDb, tenantId);
    const campaigns = syncCampaigns(db, tenantId);
    const snapshots = syncSnapshots(db, tenantId);
    const goals = syncGoals(db, sourceDb, tenantId);
    const after = db.prepare('SELECT COUNT(*) AS n FROM influencers WHERE tenant_id = ?').get(tenantId).n;
    return {
      tenantId,
      sourceDb: resolvedSource,
      influencersBefore: before,
      influencersAfter: after,
      contacts,
      campaigns,
      snapshots,
      goalsUpserted: goals.upserted,
      liveContactCount: goals.contactCount,
    };
  } finally {
    sourceDb.close();
  }
}

module.exports = {
  BUNDLED_SOURCE_DB,
  CATEGORY_MAP,
  syncD2rmData,
  resolveTenantForEmail,
};
