'use strict';
/**
 * Import the master contact database (email-database.db) into Manna.
 *
 * Source : the funnels goal's email-database.db — tables contacts + sends,
 *          built by build_email_db.py (13,863 contacts / 1,042 sends).
 * Target : Manna's `influencers` table (the dashboard's email list, mig. 003)
 *          + aggregate rows in `email_campaigns` for the historical sends.
 *
 * This replaces scripts/import-contacts.py, which imported only pastors and
 * YouTube influencers from raw CSVs and ignored org / attorney / podcast /
 * handles / other contacts and all send history.
 *
 * Idempotent: contacts are keyed on (tenant_id, LOWER(email)); campaigns on
 * (tenant_id, name, provider). Re-running inserts nothing twice, and a
 * contact's send stats are only ever SET at the moment its row is inserted
 * (never incremented, never reset on later runs).
 *
 * Mapping decisions (original values are preserved in a notes trailer,
 * so nothing is lost even where Manna's schema is narrower):
 *   category: pastor->pastor, influencer->influencer, podcast->podcast,
 *             attorney->attorney, org->church (Manna's org bucket),
 *             handles->influencer (platform preserved),
 *             other->individual (migration 022 added the bucket; the
 *             schema guard hard-refuses any target whose LIVE influencers
 *             table SQL lacks 'individual' — probing the schema itself,
 *             not the version table, which can claim 22+ while a gap left
 *             022 unapplied; run migrations first).
 *   status  : notes 'vet=REJECTED' -> rejected;
 *             'vet=VETTED' or 'vetted YYYY-MM-DD' -> vetted;
 *             everything else (incl. vet=UNVETTED, PRE-VETTED,
 *             FLAGGED-MISCLASSIFIED, no info) -> unvetted.
 *   tier    : influencer subcategory micro|nano|macro|mega only.
 *   notes   : copied verbatim + trailer
 *             "[import: cat=<src> sub=<src|-> lang=<derived|->]".
 *             Language has no column on influencers, so it lives here
 *             (derived from notes lang= token or pastor sub senior/<lang>).
 *
 * Sends history: Manna has no per-send contact table for non-drip mail
 * (drip_send_log requires a drip enrollment), so history lands as
 * (a) one email_campaigns aggregate per (campaign_name, provider), and
 * (b) per-contact influencers.emails_sent + last_emailed_at.
 * Source sends carry no subject/opens/clicks (columns empty/absent), so
 * emails_opened / emails_clicked stay 0 — there is nothing to lose there.
 *
 * Usage:
 *   node scripts/import-contacts.js --db <manna.db> [--source <email-database.db>]
 *        [--tenant-email michael@faithshield.ai | --tenant-id N] [--dry-run]
 *
 * Deploy day (against the real DB, after Render disk is live):
 *   DATABASE backup first, then:
 *   node scripts/import-contacts.js --db /app/data/d2rm-dashboard.db
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_SOURCE = path.join(
  process.env.HOME,
  'workspace/goals/faithshield-and-angel-warriors-marketing-funnels/hidden_files/email-database.db'
);

function parseArgs(argv) {
  const args = { source: DEFAULT_SOURCE, tenantEmail: 'michael@faithshield.ai', dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') args.db = argv[++i];
    else if (a === '--source') args.source = argv[++i];
    else if (a === '--tenant-email') { args.tenantEmail = argv[++i]; args.tenantId = null; }
    else if (a === '--tenant-id') { args.tenantId = parseInt(argv[++i], 10); args.tenantEmail = null; }
    else if (a === '--dry-run') args.dryRun = true;
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  if (!args.db) { console.error('ERROR: --db <target Manna DB> is required'); process.exit(2); }
  return args;
}

// ---------------------------------------------------------------- mapping ---
const CATEGORY_MAP = {
  pastor: 'pastor',
  influencer: 'influencer',
  podcast: 'podcast',
  attorney: 'attorney',
  org: 'church',        // ministries / universities / FCA / YFC — Manna's org bucket
  handles: 'influencer', // IG influencer prospects; platform preserved
  other: 'individual'   // unroled individuals; bucket added by migration 022
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
  // Email first (red-team round 1, F-A5): a NULL email used to throw a
  // TypeError on .trim() INSIDE the import transaction — total rollback,
  // nothing imported. An empty string imported as a junk row and then
  // swallowed every later contact as a phantom duplicate of ''. Validate
  // up front and route bad rows to the rejected bucket with a reason.
  const email = typeof c.email === 'string' ? c.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) {
    return { rejected: `invalid email '${c.email == null ? '(null)' : c.email}' (empty or missing '@')` };
  }
  const category = CATEGORY_MAP[c.category];
  if (!category) {
    return { rejected: `category '${c.category}' has no Manna bucket (influencers.category CHECK)` };
  }
  const sub = c.subcategory || null;
  const tier = c.category === 'influencer' && sub && TIERS.has(sub) ? sub : null;
  const lang = deriveLang(c.notes, sub);
  const trailer = `[import: cat=${c.category} sub=${sub || '-'} lang=${lang || '-'}]`;
  const notes = c.notes ? `${c.notes} ${trailer}` : trailer;
  const handle = (c.first_name || '').trim() || email.split('@')[0];
  return {
    row: {
      handle: handle.slice(0, 200),
      platform: derivePlatform(c.notes, sub, c.category, c.source_file),
      email,
      tier,
      category,
      status: deriveStatus(c.notes),
      notes,
      source: `import:email-database.db:${c.source_file || 'unknown'}`,
      created_at: c.created_at || null
    }
  };
}

// Campaign-level inference for the historical sends aggregates.
function campaignMeta(name, provider) {
  const n = (name || '').toLowerCase();
  let product = 'manna'; // schema default; overridden below when the name says so
  // Pastor signals win first: the 'Pastor Combo — FaithShield + Armor Bearer'
  // campaign was mailed to pastors even though its name mentions Armor Bearer.
  if (n.includes('pastor') || n.includes('send-batch') || n.includes('faithshield')) product = 'faithshield';
  else if (n.includes('armor')) product = 'armor-bearer';
  let language = 'en';
  if (n.includes('portuguese')) language = 'pt';
  else if (n.includes('tagalog')) language = 'tl';
  const audience = product === 'armor-bearer' ? 'influencer' : 'pastor';
  return { product, language, audience, provider: provider || null };
}

// ------------------------------------------------------------------- main ---
function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(args.source)) { console.error(`ERROR: source not found: ${args.source}`); process.exit(1); }
  if (!fs.existsSync(args.db)) { console.error(`ERROR: target DB not found: ${args.db}`); process.exit(1); }

  const src = new DatabaseSync(args.source, { readOnly: true });
  const tgt = new DatabaseSync(args.db);
  tgt.exec('PRAGMA foreign_keys = ON;');

  // --- schema guard: never write into a half-migrated DB ---
  const tables = new Set(
    tgt.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
  );
  for (const t of ['influencers', 'email_campaigns', 'tenants', 'users']) {
    if (!tables.has(t)) { console.error(`ERROR: target DB is missing table ${t} — run migrations first`); process.exit(1); }
  }
  let maxMig = 0;
  try {
    const r = tgt.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
    maxMig = r && r.v ? r.v : 0;
  } catch (_) { /* treated as 0 */ }
  if (maxMig < 13) {
    console.error(`ERROR: target DB at migration ${maxMig}; import needs >= 13 (influencers.source + email stats columns). Run migrations first.`);
    process.exit(1);
  }
  // Probe the ACTUAL schema, never just the version table (red-team
  // round 1, F-A2): a DB can be stamped >= 22 while migration 022 never
  // ran (the old MAX()-based runner hid gaps), and then every 'other'
  // insert would die on the category CHECK mid-run, after earlier rows
  // were already written. The live table SQL is the only truth here.
  const infRow = tgt.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='influencers'"
  ).get();
  const infSql = infRow && infRow.sql ? infRow.sql : '';
  if (!infSql.includes("'individual'")) {
    console.error(`ERROR: target DB schema predates migration 022 — the influencers category CHECK has no 'individual' bucket (schema_migrations MAX reports ${maxMig}, but the live table SQL governs). Run migrations first; refusing to write any rows.`);
    process.exit(1);
  }

  // --- tenant resolution (mirrors migration 019: the tenant owning the email) ---
  let tenantId = null;
  if (args.tenantId) {
    const t = tgt.prepare('SELECT id FROM tenants WHERE id = ?').get(args.tenantId);
    if (t) tenantId = t.id;
  } else {
    const u = tgt.prepare('SELECT tenant_id FROM users WHERE email = ? LIMIT 1').get(args.tenantEmail);
    if (u) tenantId = u.tenant_id;
  }
  if (!tenantId) {
    console.error(`ERROR: could not resolve tenant (email=${args.tenantEmail || '-'} id=${args.tenantId || '-'}). Aborting — imports land under the owner tenant only.`);
    process.exit(1);
  }
  console.log(`Target: ${args.db} (migration ${maxMig}), tenant_id=${tenantId}${args.dryRun ? ' — DRY RUN' : ''}`);

  // --- read source ---
  const contacts = src.prepare('SELECT * FROM contacts ORDER BY id').all();
  const sends = src.prepare('SELECT * FROM sends ORDER BY id').all();
  console.log(`Source: ${contacts.length} contacts, ${sends.length} sends (${args.source})`);

  const sendStats = new Map(); // source contact_id -> {n, last}
  for (const s of sends) {
    const cur = sendStats.get(s.contact_id) || { n: 0, last: null };
    cur.n += 1;
    if (!cur.last || s.sent_at > cur.last) cur.last = s.sent_at;
    sendStats.set(s.contact_id, cur);
  }

  const existing = new Set(
    tgt.prepare('SELECT LOWER(email) AS e FROM influencers WHERE tenant_id = ? AND email IS NOT NULL')
      .all(tenantId).map(r => r.e)
  );

  const insContact = tgt.prepare(`
    INSERT INTO influencers
      (tenant_id, handle, platform, email, tier, category, status, notes, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))
  `);
  const updStats = tgt.prepare(
    'UPDATE influencers SET emails_sent = ?, last_emailed_at = ? WHERE tenant_id = ? AND LOWER(email) = ?'
  );

  const report = {
    sourceByCat: {}, importedByCat: {}, inserted: 0, alreadyPresent: 0,
    duplicatesInSource: [], rejected: [], sendsLinked: 0, statsApplied: 0
  };
  // email -> source contact id that won it in the SOURCE (first by id).
  // In-source duplication is a property of the source data, so it is
  // classified on every run — including idempotent re-runs, where the
  // winner is already in the target. Distinguishes a true duplicate from
  // a contact that was already present before this run (red-team round 1,
  // F-A4: duplicates used to vanish into alreadyPresent together with
  // their classification and sends).
  const seenInRun = new Map();
  const rejectedIds = new Set();

  tgt.exec('BEGIN IMMEDIATE;');
  try {
    for (const c of contacts) {
      report.sourceByCat[c.category] = (report.sourceByCat[c.category] || 0) + 1;
      const mapped = mapContact(c);
      if (mapped.rejected) {
        report.rejected.push({ email: c.email, category: c.category, reason: mapped.rejected });
        rejectedIds.add(c.id);
        continue;
      }
      const r = mapped.row;
      if (seenInRun.has(r.email)) {
        const st = sendStats.get(c.id);
        report.duplicatesInSource.push({
          email: r.email, category: c.category,
          keptContactId: seenInRun.get(r.email), dupContactId: c.id,
          sends: st ? st.n : 0
        });
        continue;
      }
      if (existing.has(r.email)) {
        report.alreadyPresent += 1;
        seenInRun.set(r.email, c.id);
        continue;
      }
      if (!args.dryRun) {
        insContact.run(tenantId, r.handle, r.platform, r.email, r.tier,
          r.category, r.status, r.notes, r.source, r.created_at);
        const st = sendStats.get(c.id);
        if (st) {
          updStats.run(st.n, st.last, tenantId, r.email);
          report.sendsLinked += st.n;
          report.statsApplied += 1;
        }
      } else {
        const st = sendStats.get(c.id);
        if (st) { report.sendsLinked += st.n; report.statsApplied += 1; }
      }
      existing.add(r.email);
      seenInRun.set(r.email, c.id);
      report.inserted += 1;
      report.importedByCat[c.category] = (report.importedByCat[c.category] || 0) + 1;
    }
    tgt.exec('COMMIT;');
  } catch (e) {
    tgt.exec('ROLLBACK;');
    throw e;
  }
  // --- historical sends as campaign aggregates ---
  const campGroups = new Map();
  for (const s of sends) {
    const key = `${s.campaign_name} ${s.provider}`;
    const g = campGroups.get(key) || { name: s.campaign_name, provider: s.provider, n: 0, last: null };
    g.n += 1;
    if (!g.last || s.sent_at > g.last) g.last = s.sent_at;
    campGroups.set(key, g);
  }
  const existingCamps = new Set(
    tgt.prepare('SELECT name || \' \' || COALESCE(provider, \'\') AS k FROM email_campaigns WHERE tenant_id = ?')
      .all(tenantId).map(r => r.k)
  );
  const insCamp = tgt.prepare(`
    INSERT INTO email_campaigns
      (tenant_id, name, provider, sent, sent_at, product, language, audience, target_description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let campsInserted = 0;
  if (!args.dryRun) {
    tgt.exec('BEGIN IMMEDIATE;');
    try {
      for (const g of campGroups.values()) {
        if (existingCamps.has(`${g.name} ${g.provider || ''}`)) continue;
        const meta = campaignMeta(g.name, g.provider);
        insCamp.run(tenantId, g.name, g.provider, g.n, g.last, meta.product,
          meta.language, meta.audience,
          `imported history from email-database.db (${g.n} sends)`);
        campsInserted += 1;
      }
      tgt.exec('COMMIT;');
    } catch (e) {
      tgt.exec('ROLLBACK;');
      throw e;
    }
  } else {
    campsInserted = [...campGroups.values()]
      .filter(g => !existingCamps.has(`${g.name} ${g.provider || ''}`)).length;
  }

  // --- final counts + report ---
  const finalCounts = {};
  for (const r of tgt.prepare(
    'SELECT category, COUNT(*) AS n FROM influencers WHERE tenant_id = ? GROUP BY category'
  ).all(tenantId)) finalCounts[r.category] = r.n;
  const totalFinal = tgt.prepare(
    'SELECT COUNT(*) AS n FROM influencers WHERE tenant_id = ?'
  ).get(tenantId).n;

  console.log('\n=== IMPORT REPORT ===');
  console.log(`Source contacts by category:  ${JSON.stringify(report.sourceByCat)}`);
  console.log(`Imported this run by source category: ${JSON.stringify(report.importedByCat)}`);
  console.log(`Inserted: ${report.inserted}  | already present (skipped): ${report.alreadyPresent}  | in-source duplicates (skipped): ${report.duplicatesInSource.length}  | rejected: ${report.rejected.length}`);
  const rejByReason = {};
  for (const r of report.rejected) rejByReason[r.reason] = (rejByReason[r.reason] || 0) + 1;
  for (const [reason, n] of Object.entries(rejByReason)) console.log(`  REJECTED x${n}: ${reason}`);
  for (const d of report.duplicatesInSource) {
    console.log(`  DUPLICATE in source: ${d.email} (${d.category} contact ${d.dupContactId}) — first occurrence (contact ${d.keptContactId}) kept; its ${d.sends} send(s) are aggregate-only, tallied below`);
  }
  console.log(`Campaign aggregates inserted: ${campsInserted} (of ${campGroups.size} in source)`);
  console.log(`Sends linked per-contact (emails_sent set on insert): ${report.sendsLinked} across ${report.statsApplied} contacts`);
  // Every source send is accounted for exactly once: linked per-contact
  // at insert, belonging to an in-source duplicate, belonging to a
  // rejected contact (both aggregate-only), or belonging to a contact
  // already present before this run (its stats were set at ITS insert).
  const dupSends = report.duplicatesInSource.reduce((a, d) => a + d.sends, 0);
  let rejectedSends = 0;
  for (const cid of rejectedIds) {
    const st = sendStats.get(cid);
    if (st) rejectedSends += st.n;
  }
  const presentSends = sends.length - report.sendsLinked - dupSends - rejectedSends;
  console.log(`Sends belonging to in-source duplicates (aggregate-only, first occurrence kept): ${dupSends}`);
  console.log(`Sends whose contact was rejected (aggregate-only, no per-contact home): ${rejectedSends}`);
  console.log(`Sends belonging to already-present contacts (stats set at their original insert): ${presentSends}`);
  console.log(`Target influencers for tenant now (incl. pre-existing): ${totalFinal} ${JSON.stringify(finalCounts)}`);
  if (args.dryRun) console.log('DRY RUN — no rows were written.');

  src.close();
  tgt.close();
}

main();
