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
 * Two shapes are understood:
 *
 *   1. Markdown tables whose header row names the columns
 *      (Publication | Contact | Role | Beat | Contact route |
 *      Verified | Tier | Fit | Source, in any order, extra columns
 *      ignored).
 *   2. Headed sections in the researched file's own format: a ##
 *      heading names the tier, a ### heading names the publication
 *      (a leading "12." number and a trailing "(parenthetical)" are
 *      part of the file's formatting, not the name), followed by
 *      bullets in plain or bold-keyed form:
 *        - **Why it fits:** ...        -> fit_note
 *        - **Named editor:** Name, Role...  (also Named reporter /
 *          Named contact / Named columnist) -> contact_name + role;
 *          a value starting "None" means no contact on file
 *        - **Pitch route:** ...        -> contact_route
 *        - **Verified from:** ...      -> source, and the entry's
 *          verification provenance (see below)
 *      Plain "- Key: value" bullets (Contact, Role, Beat, Tier,
 *      Verified, Source) are understood too.
 *
 * CATEGORIES (Michael, 2026-11-01: "Faith-Based" and "Mainstream"):
 * every entry lands on a shelf derived from its tier: tech ->
 * mainstream; faith_major and the faith-tech niche -> faith_based.
 *
 * OWNER RULE (same date): "The ones that don't publish don't get
 * the story." The file's OWNER RULE section names the excluded
 * outlets (bullets ending in EXCLUDED); an entry whose publication
 * matches one, or whose own text says DO NOT PITCH, imports with
 * status 'do_not_pitch': on the list, parked, never pitchable.
 * Every other entry imports 'active'.
 *
 * Verification stays conservative. A route counts as verified ONLY
 * when the entry explicitly supports it: a "Verified: yes" marker,
 * or a "Verified from" provenance bullet (the researched file's
 * header states every route was verified from the outlet's own
 * pages except where marked unverified). Any text saying
 * "unverified" wins over everything and the route lands
 * route_verified = 0, marked, never silently trusted.
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

/** The shelf a tier sits on (Michael's categories, 2026-11-01). */
function categoryFromTier(tier) {
  return tier === 'tech' ? 'mainstream' : 'faith_based';
}

/** Name matching for the OWNER RULE list: case, punctuation and
 *  parenthetical suffixes ("Ministry Tech (MinistryTech Magazine)")
 *  are formatting, not identity. */
function normalizePubName(s) {
  return String(s || '').toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The targets file names the shelf in some section headings
// ("Supplement 2 ... (Faith-Based)"): that heading governs every
// entry under it until the next tiered section.
function shelfFromHeading(text) {
  if (/faith-based/i.test(text)) return 'faith_based';
  if (/mainstream/i.test(text)) return 'mainstream';
  return null;
}

/** Display cleanup for a heading: "12. TechCrunch" -> "TechCrunch",
 *  "Ministry Tech (MinistryTech Magazine)" -> "Ministry Tech". */
function cleanPublicationName(s) {
  return String(s || '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}

/**
 * "Erik Petrik, Chief Content Officer and incoming Editor in Chief
 * (announced by CT...)" -> { contact_name: 'Erik Petrik', role:
 * 'Chief Content Officer and incoming Editor in Chief' }. The role
 * runs to the first ';', '(' or sentence end. A value starting with
 * "None" (the file's way of saying no contact could be verified)
 * yields no contact at all.
 */
function parseNamedContact(value) {
  const v = String(value || '').trim();
  if (!v || /^none\b/i.test(v)) return { contact_name: null, role: null };
  const comma = v.indexOf(',');
  if (comma === -1) {
    return { contact_name: v.replace(/\.$/, '').trim() || null, role: null };
  }
  const name = v.slice(0, comma).trim();
  let role = v.slice(comma + 1);
  const cut = role.search(/[;(]|\.\s/);
  if (cut !== -1) role = role.slice(0, cut);
  role = role.trim().replace(/\.$/, '').trim();
  return { contact_name: name || null, role: role || null };
}

function verifiedFromEntry(e) {
  const route = String(e.contact_route || '');
  const flag = String(e._verifiedText || '');
  if (/unverified/i.test(route) || /unverified/i.test(flag)) return 0;
  if (/^(yes|true|verified)\b/i.test(flag.trim())) return 1;
  if (e._verifiedFrom) return 1;
  if (/\bverified\b/i.test(route)) return 1;
  return 0;
}

const KEYMAP = [
  [/^(publication|outlet)$/, 'publication'],
  [/^(contact|contact name|name)$/, 'contact_name'],
  [/^(named editor|named editors|named reporter|named reporters|named contact|named columnist)$/, '_named'],
  [/^(role|title)$/, 'role'],
  [/^(beat)$/, 'beat'],
  [/^(contact route|route|email|pitch route|how to pitch)$/, 'contact_route'],
  [/^(tier)$/, 'tier'],
  [/^(fit|fit note|why|why it fits)$/, 'fit_note'],
  [/^(verified from)$/, '_verifiedFrom'],
  [/^(source)$/, 'source'],
  [/^(verified|route verified)$/, '_verified'],
];

function cleanCell(s) {
  return String(s || '').replace(/\*\*/g, '').replace(/`/g, '').trim();
}

/** Bullet keys arrive as "Why it fits" or "**Why it fits" depending
 *  on the file's formatting; both mean the same key. */
function cleanKey(s) {
  return String(s || '').replace(/\*+/g, '').trim().toLowerCase();
}

function parseTable(lines, startIdx, entries, tierContext) {
  const header = lines[startIdx].split('|').map(cleanCell);
  const colIdx = {};
  header.forEach((h, i) => {
    for (const [re, field] of KEYMAP) {
      if (re.test(cleanKey(h))) { colIdx[field] = i; break; }
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
    const publication = cleanPublicationName(get('publication'));
    if (!publication) continue;
    const named = colIdx._named !== undefined
      ? parseNamedContact(get('_named'))
      : { contact_name: get('contact_name') || null, role: get('role') || null };
    entries.push({
      publication,
      contact_name: named.contact_name,
      role: named.role,
      beat: get('beat') || null,
      contact_route: get('contact_route') || null,
      _verifiedText: get('_verified'),
      _verifiedFrom: get('_verifiedFrom') || null,
      tier: tierFromText(get('tier')) || tierContext || 'niche',
      fit_note: get('fit_note') || null,
      source: get('source') || null,
    });
  }
  return i - 1;
}

function parsePrTargetsMarkdown(md) {
  const entries = [];
  const excludedNames = new Set();
  const lines = String(md || '').split(/\r?\n/);
  let tierContext = null;
  let shelfContext = null;
  let current = null;
  let inOwnerRule = false;

  const flush = () => {
    // Section entries count only when at least one bullet filled a
    // field; a bare heading (a notes section, a stray title) is not a
    // connection and is never imported as one.
    if (current && current.publication && current._hasField) entries.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('|')) {
      flush();
      i = parseTable(lines, i, entries, tierContext);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      // An H1 is the document title, never a publication.
      if (heading[1].length === 1) { flush(); inOwnerRule = false; continue; }
      const text = cleanCell(heading[2]);
      // The OWNER RULE section is a ruling, not a publication: its
      // bullets name the outlets the rule parks (see below).
      if (/owner rule/i.test(text)) {
        flush();
        inOwnerRule = true;
        continue;
      }
      inOwnerRule = false;
      const asTier = tierFromText(text);
      // A heading that reads as a tier label sets context, not a target.
      if (/(tier|majors|mainstream|niche)/i.test(text) && asTier) {
        flush();
        tierContext = asTier;
        shelfContext = null;
        continue;
      }
      // A heading that names its shelf ("Supplement 2 ... (Faith-Based)")
      // governs every entry under it. With no tier marker of its own,
      // the small Christian press shelf sits in the niche tier
      // underneath (the majors were the earlier pass).
      const asShelf = shelfFromHeading(text);
      if (asShelf) {
        flush();
        shelfContext = asShelf;
        if (asShelf === 'faith_based') tierContext = 'niche';
        continue;
      }
      flush();
      current = {
        publication: cleanPublicationName(text),
        contact_name: null, role: null, beat: null, contact_route: null,
        _verifiedText: '', _verifiedFrom: null, _shelf: shelfContext,
        tier: tierContext || 'niche', fit_note: null, source: null,
      };
      continue;
    }

    const bullet = line.match(/^[-*]\s+([^:]+):\s*(.+)$/);
    if (bullet) {
      const key = cleanKey(bullet[1]);
      const value = cleanCell(bullet[2]);
      // OWNER RULE bullets: "- Axios: no published route. EXCLUDED."
      // The name before the colon joins the parked list.
      if (inOwnerRule && /excluded/i.test(value)) {
        excludedNames.add(normalizePubName(key));
        continue;
      }
      if (!current) continue;
      for (const [re, field] of KEYMAP) {
        if (re.test(key)) {
          if (field === '_verified') current._verifiedText = value;
          else if (field === '_verifiedFrom') {
            current._verifiedFrom = value;
            if (!current.source) current.source = value;
          } else if (field === '_named') {
            const named = parseNamedContact(value);
            if (named.contact_name) current.contact_name = named.contact_name;
            if (named.role) current.role = named.role;
          } else if (field === 'tier') current.tier = tierFromText(value) || current.tier;
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
    e.route_verified = verifiedFromEntry(e);
    // A shelf named by the entry's own section heading wins; otherwise
    // the shelf derives from the tier (tech is Mainstream, the faith
    // tiers are Faith-Based).
    e.category = e._shelf || categoryFromTier(e.tier);
    const parked = excludedNames.has(normalizePubName(e.publication))
      || /\bdo not pitch\b/i.test(e.contact_route || '')
      || /\bdo not pitch\b/i.test(e.fit_note || '');
    e.status = parked ? 'do_not_pitch' : 'active';
    delete e._verifiedText;
    delete e._verifiedFrom;
    delete e._hasField;
    delete e._shelf;
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
       route_verified, tier, category, fit_note, source, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  let skipped = 0;
  for (const e of entries) {
    if (exists.get(t, e.publication, e.contact_name)) { skipped++; continue; }
    insert.run(t, e.publication, e.contact_name, e.role, e.beat,
      e.contact_route, e.route_verified ? 1 : 0, e.tier,
      e.category || categoryFromTier(e.tier), e.fit_note, e.source,
      e.status || 'active');
    inserted++;
  }
  return { inserted, skipped, total: entries.length };
}

module.exports = {
  seedPrTargets,
  parsePrTargetsMarkdown,
  parseNamedContact,
  categoryFromTier,
  normalizePubName,
  defaultTargetsPath,
  DEFAULT_TARGETS_PATH,
};
