'use strict';
/**
 * Seed influencer contacts on startup (if not already present).
 * Reads data/seed/influencers.csv and inserts for tenant_id=1.
 * Idempotent: skips entirely if influencers already exist for tenant 1.
 */
const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');

const CSV_PATH = path.join(__dirname, '..', 'data', 'seed', 'influencers.csv');

const VALID_TIERS = new Set(['nano', 'micro', 'macro', 'mega']);
const VALID_CATEGORIES = new Set(['influencer', 'podcast', 'pastor', 'church', 'attorney']);
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

function seedInfluencers() {
  // Ensure tenant 1 exists (fresh DBs have no tenants until signup).
  const tenant = db.prepare('SELECT id FROM tenants WHERE id = 1').get();
  if (!tenant) {
    db.prepare(
      "INSERT INTO tenants (id, name, slug, plan) VALUES (1, 'D2RM', 'd2rm', 'pro')"
    ).run();
    // eslint-disable-next-line no-console
    console.log('[seed] created default tenant 1');
  }

  const existing = db.prepare(
    'SELECT COUNT(*) AS c FROM influencers WHERE tenant_id = 1'
  ).get().c;
  if (existing > 0) {
    // eslint-disable-next-line no-console
    console.log(`[seed] influencers already seeded (${existing} records for tenant 1), skipping`);
    return { skipped: true, count: existing };
  }

  if (!fs.existsSync(CSV_PATH)) {
    // eslint-disable-next-line no-console
    console.log('[seed] no influencers.csv found, skipping');
    return { skipped: true, count: 0 };
  }

  // eslint-disable-next-line no-console
  console.log('[seed] seeding influencers from CSV...');
  const text = fs.readFileSync(CSV_PATH, 'utf8');
  // Strip BOM if present
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) {
    // eslint-disable-next-line no-console
    console.log('[seed] CSV has no data rows, skipping');
    return { skipped: true, count: 0 };
  }

  const header = rows[0].map(h => String(h).trim().toLowerCase());
  const idx = name => header.indexOf(name);
  const required = ['handle', 'platform', 'email', 'tier', 'category', 'status', 'notes', 'source'];
  for (const name of required) {
    if (idx(name) === -1) throw new Error(`[seed] CSV missing column: ${name}`);
  }

  const stmt = db.prepare(`
    INSERT INTO influencers (tenant_id, handle, platform, email, tier, category, status, notes, source)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seenEmails = new Set();
  let inserted = 0;
  let skippedDup = 0;

  db.exec('BEGIN IMMEDIATE;');
  try {
    for (let r = 1; r < rows.length; r++) {
      const cols = rows[r];
      if (cols.length < header.length) continue; // malformed row

      const email = clean(cols[idx('email')]);
      const emailKey = email ? email.toLowerCase() : `__noemail_${r}`;
      if (seenEmails.has(emailKey)) { skippedDup++; continue; }
      seenEmails.add(emailKey);

      const tierRaw = clean(cols[idx('tier')]);
      const tier = tierRaw && VALID_TIERS.has(tierRaw.toLowerCase())
        ? tierRaw.toLowerCase() : null;

      const catRaw = clean(cols[idx('category')]);
      const category = catRaw && VALID_CATEGORIES.has(catRaw.toLowerCase())
        ? catRaw.toLowerCase() : 'influencer';

      const statusRaw = clean(cols[idx('status')]);
      const status = statusRaw && VALID_STATUSES.has(statusRaw.toLowerCase())
        ? statusRaw.toLowerCase() : 'unvetted';

      stmt.run(
        clean(cols[idx('handle')]),
        clean(cols[idx('platform')]),
        email,
        tier,
        category,
        status,
        clean(cols[idx('notes')]),
        clean(cols[idx('source')])
      );
      inserted++;
    }
    db.exec('COMMIT;');
  } catch (e) {
    try { db.exec('ROLLBACK;'); } catch (_) { /* already rolled back */ }
    throw e;
  }

  // eslint-disable-next-line no-console
  console.log(`[seed] inserted ${inserted} influencers for tenant 1` +
    (skippedDup ? ` (${skippedDup} duplicate emails skipped)` : ''));
  return { skipped: false, count: inserted };
}

if (require.main === module) {
  const { migrate } = require('../src/db');
  migrate();
  seedInfluencers();
}

module.exports = { seedInfluencers };
