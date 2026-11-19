'use strict';
/**
 * Seed influencer contacts on startup (if not already present).
 * Reads data/seed/influencers.csv (or the arsenal-seed.json fallback in
 * production) and inserts the full dataset for GRANTED tenants only —
 * the house tenant (id 1) and tenants with a recorded 'd2rm-arsenal'
 * grant in tenant_seed_state. A standalone Manna signup starts from
 * scratch and is never seeded here (2026-11-19 full-package rule).
 * Idempotent: any tenant that already has influencers is skipped.
 *
 * The CSV is parsed once and shared across tenants; per-tenant inserts
 * run as independent tasks via Promise.all (concurrent structure).
 * NOTE: node:sqlite is a synchronous driver, so the driver serializes
 * execution — the concurrency here is structural (independent per-tenant
 * units of work + per-tenant logging), and the shared single parse is
 * the real speedup over re-parsing per tenant.
 */
const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');

const CSV_PATH = path.join(__dirname, '..', 'data', 'seed', 'influencers.csv');

const VALID_TIERS = new Set(['nano', 'micro', 'macro', 'mega']);
const VALID_CATEGORIES = new Set(['influencer', 'podcast', 'pastor', 'church', 'attorney', 'family_office']);
const VALID_STATUSES = new Set(['unvetted', 'vetted', 'contacted', 'active', 'rejected']);

/**
 * Minimal RFC-4180 CSV parser: handles quoted fields containing commas,
 * double-quotes (""), and embedded newlines. Returns array of rows,
 * each row an array of field strings.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++;
      } else {
        field += c; i++;
      }
    } else if (c === '"') {
      inQuotes = true; i++;
    } else if (c === ',') {
      row.push(field); field = ''; i++;
    } else if (c === '\r') {
      i++; // ignore CR, LF handles the break
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      i++;
    } else {
      field += c; i++;
    }
  }
  // trailing field without newline
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function clean(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

const ARSENAL_PATH = path.join(__dirname, '..', 'data', 'seed', 'arsenal-seed.json');

/**
 * The rows every tenant seed task inserts, from the first source that
 * has them:
 *   1. data/seed/influencers.csv — the original signup seed file. It is
 *      gitignored (data/seed/*.csv), so it exists in a developer tree
 *      but NEVER in the deployed service.
 *   2. data/seed/arsenal-seed.json — the canonical shipped seed
 *      (committed; generated from the master DB by
 *      scripts/generate-arsenal-seed.js). This is the only source the
 *      production service has, and until 2026-11-18 the loader never
 *      looked at it: in production loadSeedRows() returned null and
 *      the signup/boot contact preload silently seeded nobody (found
 *      by the Heavy 30 walk: a fresh production signup carried demo
 *      data but zero contacts). The JSON rows carry the same fields;
 *      source is stamped 'd2rm-arsenal' because that is the file they
 *      came from. The arsenal top-up path (src/lib/arsenalSeed.js)
 *      adopts same-email rows without an external_id, so a tenant
 *      seeded here and topped up there is never duplicated.
 */
function loadSeedRows() {
  const csv = loadCsvRows();
  if (csv && csv.length) return csv;
  return loadArsenalRows();
}

function loadArsenalRows() {
  if (!fs.existsSync(ARSENAL_PATH)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(ARSENAL_PATH, 'utf8'));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('[seed] arsenal seed unreadable:', e.message);
    return null;
  }
  const raw = Array.isArray(parsed) ? parsed : parsed.rows;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const cleaned = [];
  for (const r of raw) {
    const tierRaw = clean(r.tier);
    const tier = tierRaw && VALID_TIERS.has(tierRaw.toLowerCase())
      ? tierRaw.toLowerCase() : null;
    const catRaw = clean(r.category);
    const category = catRaw && VALID_CATEGORIES.has(catRaw.toLowerCase())
      ? catRaw.toLowerCase() : 'influencer';
    const statusRaw = clean(r.status);
    const status = statusRaw && VALID_STATUSES.has(statusRaw.toLowerCase())
      ? statusRaw.toLowerCase() : 'unvetted';
    cleaned.push({
      handle: clean(r.handle),
      platform: clean(r.platform),
      email: clean(r.email),
      tier,
      category,
      status,
      notes: clean(r.notes),
      source: 'd2rm-arsenal',
    });
  }
  return cleaned.length ? cleaned : null;
}

/**
 * Parse + validate the CSV once. Returns an array of cleaned row objects
 * shared by all tenant seed tasks, or null when there is nothing to seed.
 */
function loadCsvRows() {
  if (!fs.existsSync(CSV_PATH)) {
    // eslint-disable-next-line no-console
    console.log('[seed] no influencers.csv found, skipping');
    return null;
  }
  const text = fs.readFileSync(CSV_PATH, 'utf8');
  // Strip BOM if present
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) {
    // eslint-disable-next-line no-console
    console.log('[seed] CSV has no data rows, skipping');
    return null;
  }

  const header = rows[0].map(h => String(h).trim().toLowerCase());
  const idx = name => header.indexOf(name);
  const required = ['handle', 'platform', 'email', 'tier', 'category', 'status', 'notes', 'source'];
  for (const name of required) {
    if (idx(name) === -1) throw new Error(`[seed] CSV missing column: ${name}`);
  }

  const cleaned = [];
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    if (cols.length < header.length) continue; // malformed row

    const tierRaw = clean(cols[idx('tier')]);
    const tier = tierRaw && VALID_TIERS.has(tierRaw.toLowerCase())
      ? tierRaw.toLowerCase() : null;

    const catRaw = clean(cols[idx('category')]);
    const category = catRaw && VALID_CATEGORIES.has(catRaw.toLowerCase())
      ? catRaw.toLowerCase() : 'influencer';

    const statusRaw = clean(cols[idx('status')]);
    const status = statusRaw && VALID_STATUSES.has(statusRaw.toLowerCase())
      ? statusRaw.toLowerCase() : 'unvetted';

    cleaned.push({
      handle: clean(cols[idx('handle')]),
      platform: clean(cols[idx('platform')]),
      email: clean(cols[idx('email')]),
      tier,
      category,
      status,
      notes: clean(cols[idx('notes')]),
      source: clean(cols[idx('source')]),
    });
  }
  return cleaned;
}

/**
 * Seed one tenant. Independent unit of work: own idempotency check,
 * own transaction, own dedupe set, own logging.
 */
function seedTenant(tenantId, rows) {
  const existing = db.prepare(
    'SELECT COUNT(*) AS c FROM influencers WHERE tenant_id = ?'
  ).get(tenantId).c;
  if (existing > 0) {
    // eslint-disable-next-line no-console
    console.log(`[seed] tenant ${tenantId}: already seeded (${existing} records), skipping`);
    return { tenantId, skipped: true, count: existing };
  }

  const stmt = db.prepare(`
    INSERT INTO influencers (tenant_id, handle, platform, email, tier, category, status, notes, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seenEmails = new Set();
  let inserted = 0;
  let skippedDup = 0;

  db.exec('BEGIN IMMEDIATE;');
  try {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const emailKey = r.email ? r.email.toLowerCase() : `__noemail_${i}`;
      if (seenEmails.has(emailKey)) { skippedDup++; continue; }
      seenEmails.add(emailKey);

      stmt.run(
        tenantId,
        r.handle,
        r.platform,
        r.email,
        r.tier,
        r.category,
        r.status,
        r.notes,
        r.source
      );
      inserted++;
    }
    db.exec('COMMIT;');
  } catch (e) {
    try { db.exec('ROLLBACK;'); } catch (_) { /* already rolled back */ }
    throw e;
  }

  // eslint-disable-next-line no-console
  console.log(`[seed] tenant ${tenantId}: inserted ${inserted} influencers` +
    (skippedDup ? ` (${skippedDup} duplicate emails skipped)` : ''));
  return { tenantId, skipped: false, count: inserted };
}

/**
 * Seed every tenant that has no influencers yet.
 * Returns a promise resolving to a per-tenant summary.
 */
async function seedInfluencers() {
  // Ensure the default tenant exists (fresh DBs have no tenants until signup).
  const tenant1 = db.prepare('SELECT id FROM tenants WHERE id = 1').get();
  if (!tenant1) {
    db.prepare(
      "INSERT INTO tenants (id, name, slug, plan) VALUES (1, 'D2RM', 'd2rm', 'pro')"
    ).run();
    // eslint-disable-next-line no-console
    console.log('[seed] created default tenant 1');
  }

  // 2026-11-19 (full-package rule): top up ONLY granted tenants — the
  // house tenant (id 1) and tenants with a recorded 'd2rm-arsenal' grant
  // in tenant_seed_state (Armor Bearer affiliates, granted deliberately
  // by the influencer webhook or the affiliate script). The old query
  // seeded EVERY empty tenant, copying 13,871 house contacts into each
  // new signup and growing the migration export until it 502'd.
  let tenants;
  try {
    tenants = db.prepare(`
      SELECT id FROM tenants WHERE id = 1
        OR id IN (SELECT tenant_id FROM tenant_seed_state WHERE seed_key = 'd2rm-arsenal')
      ORDER BY id
    `).all();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('[seed] tenant_seed_state unavailable, seeding house tenant only');
    tenants = [{ id: 1 }];
  }
  if (tenants.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[seed] no tenants found, skipping');
    return { tenants: [], totalInserted: 0 };
  }

  const rows = loadSeedRows();
  if (!rows || rows.length === 0) {
    return { tenants: [], totalInserted: 0 };
  }

  // eslint-disable-next-line no-console
  console.log(`[seed] seeding ${rows.length} contacts across ${tenants.length} tenant(s)...`);

  // Concurrent structure: one independent task per tenant.
  const results = await Promise.all(
    tenants.map(t => Promise.resolve().then(() => seedTenant(t.id, rows)))
  );

  const totalInserted = results
    .filter(r => !r.skipped)
    .reduce((sum, r) => sum + r.count, 0);
  const seededCount = results.filter(r => !r.skipped).length;
  const skippedCount = results.filter(r => r.skipped).length;
  // eslint-disable-next-line no-console
  console.log(`[seed] done: seeded ${seededCount} tenant(s), ` +
    `skipped ${skippedCount} tenant(s), ${totalInserted} total inserts`);
  return { tenants: results, totalInserted };
}

if (require.main === module) {
  const { migrate } = require('../src/db');
  migrate();
  Promise.resolve(seedInfluencers()).catch(e => {
    // eslint-disable-next-line no-console
    console.error('[seed] failed:', e.message);
    process.exit(1);
  });
}

/**
 * Seed influencer contacts for ONE tenant only (used by the signup route so
 * a brand-new account gets demo data immediately, without a server restart).
 * Tenant-scoped: only the given tenant_id is touched. Idempotent: a tenant
 * that already has influencers is skipped.
 * Returns the per-tenant summary from seedTenant.
 */
function seedTenantInfluencers(tenantId) {
  const rows = loadSeedRows();
  if (!rows || rows.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[seed] no seed rows available, skipping');
    return { tenantId, skipped: true, count: 0 };
  }
  return seedTenant(Number(tenantId), rows);
}

module.exports = { seedInfluencers, seedTenantInfluencers, loadSeedRows, loadArsenalRows };
