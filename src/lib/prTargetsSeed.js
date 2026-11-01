'use strict';
/**
 * PR targets seed: imports the press connections list into pr_targets.
 *
 * The canonical list is researched and kept as a markdown file at
 * ~/workspace/press/targets-2026-11-01.md (PR_TARGETS_FILE overrides
 * the path). This seeder parses it conservatively and inserts any
 * entry that has no pr_targets row yet, exactly like the media
 * library seeder: the file is the whole job, re-running is a no-op.
 *
 * Parsing is deliberately conservative. Two shapes are understood:
 *
 *   1. Markdown tables whose header row names the columns
 *      (Publication | Contact | Role | Beat | Contact route |
 *      Verified | Tier | Fit | Source, in any order, extra columns
 *      ignored).
 *   2. Headed sections: a ## or ### heading names the publication,
 *      followed by "- Key: value" bullets (Contact, Role, Beat,
 *      Contact route, Tier, Fit, Source, Verified).
 *
 * Anything that does not parse into at least a publication name is
 * skipped, never guessed at. A contact route counts as verified ONLY
 * when the entry explicitly says so and does not say "unverified";
 * everything else lands with route_verified = 0, marked, not trusted.
 *
 * Rows are tenant-scoped. At startup the seeder targets the house
 * tenant (the tenant holding michael@faithshield.ai, the D2RM
 * owners' account); POST /api/pr/targets/import seeds the caller's
 * own tenant instead. Set MANNA_SKIP_PR_SEED=1 to skip the startup
 * run (the test harness covers this module directly).
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_TARGETS_PATH = path.join(__dirname, '..', '..', '..', 'press', 'targets-2026-11-01.md');

function defaultTargetsPath() {
  return process.env.PR_TARGETS_FILE || DEFAULT_TARGETS_PATH;
}

function tierFromText(s) {
  const v = String(s || '').toLowerCase();
  if (/faith/.test(v) && /(major|tier\s*1)/.test(v)) return 'faith_major';
  if (/tier\s*1/.test(v)) return 'faith_major';
  // Niche before tech: a "faith-tech niche" label names the niche
  // tier even though it also contains the word tech.
  if (/(niche|tier\s*3)/.test(v)) return 'niche';
  if (/(tech|mainstream|tier\s*2)/.test(v)) return 'tech';
  if (/faith/.test(v)) return 'faith_major';
  return null;
}

function verifiedFromText(routeCell, verifiedCell) {
  const route = String(routeCell || '').toLowerCase();
  const flag = String(verifiedCell || '').toLowerCase();
  if (/unverified/.test(route) || /unverified/.test(flag)) return 0;
  if (/^(yes|true|verified)\b/.test(flag.trim())) return 1;
  if (/\bverified\b/.test(route)) return 1;
  return 0;
}

const KEYMAP = [
  [/^(publication|outlet)$/, 'publication'],
  [/^(contact|contact name|name)$/, 'contact_name'],
  [/^(role|title)$/, 'role'],
  [/^(beat)$/, 'beat'],
  [/^(contact route|route|email|pitch route|how to pitch|contact)$/, 'contact_route'],
  [/^(tier)$/, 'tier'],
  [/^(fit|fit note|why|why it fits)$/, 'fit_note'],
  [/^(source)$/, 'source'],
  [/^(verified|route verified)$/, '_verified'],
];

function cleanCell(s) {
  return String(s || '').replace(/\*\*/g, '').replace(/`/g, '').trim();
}

function parseTable(lines, startIdx, entries, tierContext) {
  const header = lines[startIdx].split('|').map(cleanCell);
  const colIdx = {};
  header.forEach((h, i) => {
    for (const [re, field] of KEYMAP) {
      if (re.test(h.toLowerCase())) { colIdx[field] = i; break; }
    }
  });
  if (colIdx.publication === undefined) return startIdx; // not our table
  let i = startIdx + 1;
  // Skip the separator row (|---|---|) if present.
  if (i < lines.length && /^\|[\s:|-]+\|$/.test(lines[i].trim())) i++;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    const cells = line.split('|').map(cleanCell);
    const get = (f) => (colIdx[f] !== undefined ? (cells[colIdx[f]] || '') : '');
    const publication = get('publication');
    if (!publication) continue;
    const tierText = get('tier');
    entries.push({
      publication,
      contact_name: get('contact_name') || null,
      role: get('role') || null,
      beat: get('beat') || null,
      contact_route: get('contact_route') || null,
      route_verified: verifiedFromText(get('contact_route'), get('_verified')),
      tier: tierFromText(tierText) || tierContext || 'niche',
      fit_note: get('fit_note') || null,
      source: get('source') || null,
    });
  }
  return i - 1;
}

function parsePrTargetsMarkdown(md) {
  const entries = [];
  const lines = String(md || '').split(/\r?\n/);
  let tierContext = null;
  let current = null;

  const flush = () => {
    // Section entries count only when at least one bullet filled a
    // field; a bare heading (a notes section, a stray title) is not a
    // connection and is never imported as one.
    if (current && current.publication && current._hasField) entries.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('|')) {
      flush();
      i = parseTable(lines, i, entries, tierContext);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      // An H1 is the document title, never a publication.
      if (heading[1].length === 1) { flush(); continue; }
      const text = cleanCell(heading[2]);
      const asTier = tierFromText(text);
      // A heading that reads as a tier label sets context, not a target.
      if (/(tier|majors|mainstream|niche)/i.test(text) && asTier) {
        flush();
        tierContext = asTier;
        continue;
      }
      flush();
      current = {
        publication: text,
        contact_name: null, role: null, beat: null, contact_route: null,
        route_verified: 0, tier: tierContext || 'niche', fit_note: null, source: null,
        _verifiedText: '',
      };
      continue;
    }

    const bullet = line.match(/^[-*]\s+([^:]+):\s*(.+)$/);
    if (bullet && current) {
      const key = bullet[1].trim().toLowerCase();
      const value = cleanCell(bullet[2]);
      for (const [re, field] of KEYMAP) {
        if (re.test(key)) {
          if (field === '_verified') current._verifiedText = value;
          else if (field === 'tier') current.tier = tierFromText(value) || current.tier;
          else if (field !== 'publication') current[field] = value || null;
          current._hasField = true;
          break;
        }
      }
      continue;
    }
  }
  flush();

  for (const e of entries) {
    e.route_verified = verifiedFromText(e.contact_route, e._verifiedText || (e.route_verified ? 'verified' : ''));
    delete e._verifiedText;
    delete e._hasField;
  }
  return entries;
}

function houseTenantId(db) {
  const row = db.prepare('SELECT tenant_id FROM users WHERE email = ?')
    .get('michael@faithshield.ai');
  return row ? row.tenant_id : null;
}

function seedPrTargets(db, { tenantId, filePath, text } = {}) {
  const t = tenantId || houseTenantId(db);
  if (!t) return { inserted: 0, skipped: 0, total: 0, reason: 'no_house_tenant' };

  let md = text;
  if (md === undefined) {
    const p = filePath || defaultTargetsPath();
    if (!fs.existsSync(p)) return { inserted: 0, skipped: 0, total: 0, reason: 'file_missing' };
    md = fs.readFileSync(p, 'utf8');
  }

  const entries = parsePrTargetsMarkdown(md);
  const exists = db.prepare(
    "SELECT id FROM pr_targets WHERE tenant_id = ? AND publication = ? AND ifnull(contact_name, '') = ifnull(?, '')"
  );
  const insert = db.prepare(`
    INSERT INTO pr_targets
      (tenant_id, publication, contact_name, role, beat, contact_route,
       route_verified, tier, fit_note, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  let skipped = 0;
  for (const e of entries) {
    if (exists.get(t, e.publication, e.contact_name)) { skipped++; continue; }
    insert.run(t, e.publication, e.contact_name, e.role, e.beat,
      e.contact_route, e.route_verified ? 1 : 0, e.tier, e.fit_note, e.source);
    inserted++;
  }
  return { inserted, skipped, total: entries.length };
}

module.exports = { seedPrTargets, parsePrTargetsMarkdown, defaultTargetsPath, DEFAULT_TARGETS_PATH };
