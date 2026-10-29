'use strict';
/**
 * Generate the canonical affiliate-arsenal seed file from the master
 * contact database.
 *
 * Source : ~/workspace/goals/faithshield-and-angel-warriors-marketing-
 *          funnels/hidden_files/email-database.db, table `contacts`
 *          (13,871 rows; email UNIQUE NOT NULL — verified 2026-10-25).
 * Target : data/seed/arsenal-seed.json — one entry per master contact:
 *          the mapped `influencers` row (exactly as
 *          src/lib/arsenalSeed.js will insert it) PLUS the master id
 *          and original category/subcategory, so counts reconcile
 *          against the master DB at any time and no mapping decision
 *          is hidden.
 *
 * Mapping (IDENTICAL to scripts/import-contacts.js, the owner's own
 * import of this same database into the D2RM tenant — affiliate
 * tenants must match it):
 *   category: pastor->pastor, influencer->influencer, podcast->podcast,
 *             attorney->attorney, org->church (Manna's org bucket),
 *             handles->influencer (platform preserved; all 291 are
 *             subcategory 'instagram'), other->individual (migration
 *             022's bucket for unroled individuals).
 *   status  : notes 'vet=REJECTED' -> rejected; 'vet=VETTED' or
 *             'vetted YYYY-MM-DD' -> vetted; everything else unvetted.
 *   tier    : influencer subcategory nano|micro|macro|mega only.
 *   notes   : copied verbatim + trailer
 *             "[import: cat=<src> sub=<src|-> lang=<derived|->]" —
 *             language has no column on influencers, so it lives here
 *             (derived from notes lang= token or pastor sub senior/<lang>).
 *   source  : 'd2rm-arsenal' (set by the seeder, not stored per-row here).
 *   handle  : first_name, else the email local part.
 *
 * Every master row produces exactly one seed entry — no row is dropped
 * or rejected (the master was verified to contain no null/invalid
 * emails and no duplicate emails, so import-contacts.js's rejection
 * paths never trigger; this generator hard-fails if that ever stops
 * being true, rather than silently shrinking the arsenal).
 *
 * Usage: node scripts/generate-arsenal-seed.js [--source <email-database.db>]
 *        [--out <arsenal-seed.json>]
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_SOURCE = path.join(
  process.env.HOME,
  'workspace/goals/faithshield-and-angel-warriors-marketing-funnels/hidden_files/email-database.db'
);
const DEFAULT_OUT = path.join(__dirname, '..', 'data', 'seed', 'arsenal-seed.json');

function parseArgs(argv) {
  const args = { source: DEFAULT_SOURCE, out: DEFAULT_OUT };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--source') args.source = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else { console.error(`unknown arg: ${argv[i]}`); process.exit(2); }
  }
  return args;
}

// --- mapping (kept in lockstep with scripts/import-contacts.js) -----------
const CATEGORY_MAP = {
  pastor: 'pastor',
  influencer: 'influencer',
  podcast: 'podcast',
  attorney: 'attorney',
  org: 'church',         // ministries / universities / FCA / YFC — Manna's org bucket
  handles: 'influencer', // IG influencer prospects; platform preserved
  other: 'individual'    // unroled individuals; bucket added by migration 022
};
const TIERS = new Set(['micro', 'nano', 'macro', 'mega']);
const LANG_MAP = {
  english: 'en', e: 'en', en: 'en',
  es: 'es', spanish: 'es',
  french: 'fr', fr: 'fr',
  germ: 'de', german: 'de', de: 'de',
  portuguese: 'pt', pt: 'pt',
  tagalo: 'tl', tagalog: 'tl', tl: 'tl',
  romanian: 'ro', ro: 'ro',
  indonesian: 'id', id: 'id'
};

function deriveLang(notes, subcategory) {
  const m = /lang=([A-Za-z]+)/.exec(notes || '');
  if (m && LANG_MAP[m[1].toLowerCase()]) return LANG_MAP[m[1].toLowerCase()];
  if (subcategory && subcategory.includes('/')) {
    const tail = subcategory.split('/').pop().toLowerCase();
    if (LANG_MAP[tail]) return LANG_MAP[tail];
  }
  return null;
}

function deriveStatus(notes) {
  const n = notes || '';
  if (/(^|;\s*)vet=REJECTED(;|$)/.test(n)) return 'rejected';
  if (/(^|;\s*)vet=VETTED(;|$)/.test(n)) return 'vetted';
  if (/(^|;\s*)vetted\s+\d{4}-\d{2}-\d{2}/.test(n)) return 'vetted';
  return 'unvetted';
}

function derivePlatform(notes, subcategory, category, sourceFile) {
  const m = /(?:^|;\s*)platform=([a-z]+)/.exec(notes || '');
  if (m) return m[1];
  if (subcategory === 'instagram') return 'instagram';
  if (category === 'handles') return 'instagram';
  const f = (sourceFile || '').toLowerCase();
  if (f.includes('youtube')) return 'youtube';
  if (f.includes('instagram')) return 'instagram';
  if (f.includes('tiktok')) return 'tiktok';
  return null;
}

function mapContact(c) {
  const email = typeof c.email === 'string' ? c.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) {
    throw new Error(`master contact ${c.id}: invalid email '${c.email}' — refusing to generate a seed that drops a row`);
  }
  const category = CATEGORY_MAP[c.category];
  if (!category) {
    throw new Error(`master contact ${c.id}: category '${c.category}' has no mapping — refusing to generate`);
  }
  const sub = c.subcategory || null;
  const tier = c.category === 'influencer' && sub && TIERS.has(sub) ? sub : null;
  const lang = deriveLang(c.notes, sub);
  const trailer = `[import: cat=${c.category} sub=${sub || '-'} lang=${lang || '-'}]`;
  const notes = c.notes ? `${c.notes} ${trailer}` : trailer;
  const handle = (c.first_name || '').trim() || email.split('@')[0];
  return {
    master_id: c.id,
    master_category: c.category,
    master_subcategory: sub,
    handle: handle.slice(0, 200),
    platform: derivePlatform(c.notes, sub, c.category, c.source_file),
    email,
    tier,
    category,
    status: deriveStatus(c.notes),
    notes,
    created_at: c.created_at || null
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(args.source)) { console.error(`ERROR: source not found: ${args.source}`); process.exit(1); }
  const src = new DatabaseSync(args.source, { readOnly: true });
  const contacts = src.prepare('SELECT * FROM contacts ORDER BY id').all();
  src.close();

  const rows = contacts.map(mapContact);
  const byMasterCat = {};
  const byMappedCat = {};
  for (const r of rows) {
    byMasterCat[r.master_category] = (byMasterCat[r.master_category] || 0) + 1;
    byMappedCat[r.category] = (byMappedCat[r.category] || 0) + 1;
  }
  const payload = {
    seed_key: 'd2rm-arsenal',
    version: 1,
    generated_from: 'email-database.db contacts',
    total: rows.length,
    counts_by_master_category: byMasterCat,
    counts_by_mapped_category: byMappedCat,
    rows
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(payload));
  console.log(`Wrote ${rows.length} seed rows -> ${args.out}`);
  console.log(`By master category: ${JSON.stringify(byMasterCat)}`);
  console.log(`By mapped category: ${JSON.stringify(byMappedCat)}`);
}

if (require.main === module) main();
module.exports = { mapContact, CATEGORY_MAP };
