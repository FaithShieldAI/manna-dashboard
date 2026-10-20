'use strict';
/**
 * Origami-style AI lead finder (credential-free).
 *
 * The customer describes their ideal customer in plain English —
 *   "AV integrators in Texas"
 * — and the collector:
 *   1. Parses the query into { business_type, location }. When
 *      ANTHROPIC_API_KEY is set, Muse does the parsing (strict JSON);
 *      otherwise a local regex/state-list fallback handles it.
 *   2. Searches the live web (DuckDuckGo HTML, Bing fallback) for
 *      matching business sites.
 *   3. Visits each site (homepage + one contact/about page when needed)
 *      and extracts public contact emails.
 *   4. Returns { leads, parsed } where leads are
 *      [{ name, url, emails, location, source: 'ai-search' }].
 *
 * No API keys, no login. Polite by design: bounded search queries,
 * bounded sites per query, bounded pages per site, delays between
 * hits, hard timeouts. Like the other collectors, fetchText never
 * throws — missing pages are "no data", not errors.
 *
 * collect() is injectable (opts.fetch) so tests run without network.
 */

const { fetchText, extractEmails, visibleText, sleep, excludeKnownEmails } = require('./common');

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = process.env.ASSISTANT_MODEL || 'claude-haiku-4-5';

const SEARCH_DELAY_MS = 800;
const SITE_DELAY_MS = 700;
const MAX_SITES = 12;
const MAX_SEARCH_QUERIES = 2;
const MAX_PAGES_PER_SITE = 4; // result page, homepage, + up to 2 contact-ish pages

const CONTACT_PATHS = ['/contact', '/contact-us', '/contact.html', '/about', '/about-us'];

// Search-result junk: directories, social, and the engines themselves.
// We want the businesses' own sites, not aggregator listings.
const SKIP_DOMAINS = [
  'youtube.com', 'facebook.com', 'instagram.com', 'linkedin.com',
  'twitter.com', 'x.com', 'tiktok.com', 'pinterest.com',
  'yelp.com', 'yellowpages.com', 'bbb.org', 'manta.com',
  'thumbtack.com', 'homeadvisor.com', 'angi.com', 'mapquest.com',
  'chamberofcommerce.com', 'wikipedia.org', 'wikidata.org',
  'duckduckgo.com', 'bing.com', 'microsoft.com', 'google.com',
  'amazon.com', 'reddit.com', 'quora.com',
];

const GENERIC_TITLE_WORDS = /^(home|homepage|welcome|official site|default|index)$/i;

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

const US_STATES = {
  alabama: 'Alabama', alaska: 'Alaska', arizona: 'Arizona', arkansas: 'Arkansas',
  california: 'California', colorado: 'Colorado', connecticut: 'Connecticut',
  delaware: 'Delaware', florida: 'Florida', georgia: 'Georgia', hawaii: 'Hawaii',
  idaho: 'Idaho', illinois: 'Illinois', indiana: 'Indiana', iowa: 'Iowa',
  kansas: 'Kansas', kentucky: 'Kentucky', louisiana: 'Louisiana', maine: 'Maine',
  maryland: 'Maryland', massachusetts: 'Massachusetts', michigan: 'Michigan',
  minnesota: 'Minnesota', mississippi: 'Mississippi', missouri: 'Missouri',
  montana: 'Montana', nebraska: 'Nebraska', nevada: 'Nevada',
  'new hampshire': 'New Hampshire', 'new jersey': 'New Jersey',
  'new mexico': 'New Mexico', 'new york': 'New York',
  'north carolina': 'North Carolina', 'north dakota': 'North Dakota',
  ohio: 'Ohio', oklahoma: 'Oklahoma', oregon: 'Oregon',
  pennsylvania: 'Pennsylvania', 'rhode island': 'Rhode Island',
  'south carolina': 'South Carolina', 'south dakota': 'South Dakota',
  tennessee: 'Tennessee', texas: 'Texas', utah: 'Utah', vermont: 'Vermont',
  virginia: 'Virginia', washington: 'Washington',
  'west virginia': 'West Virginia', wisconsin: 'Wisconsin', wyoming: 'Wyoming',
  'district of columbia': 'District of Columbia',
};
const STATE_ABBR = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};

const FILLER_RE = /^(?:please\s+)?(?:find(?:\s+me)?|get(?:\s+me)?|show(?:\s+me)?|search(?:\s+for)?|look(?:\s+for)?|i\s+(?:need|want)|looking\s+for)\s+/i;
const GENERIC_NOUN_RE = /\s+(companies|businesses|firms|agencies|vendors|services|providers)$/i;

function titleCaseLocation(s) {
  return String(s).split(/([\s,\-]+)/).map(part => {
    if (/^[\s,\-]+$/.test(part) || !part) return part;
    const up = part.toUpperCase();
    if (STATE_ABBR[up]) return STATE_ABBR[up].split(' ').map(w => w).join(' ');
    if (/^[a-z]{2}$/i.test(part)) return up;
    return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  }).join('');
}

function looksLikeLocation(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  const low = t.toLowerCase();
  if (US_STATES[low] || STATE_ABBR[t.toUpperCase()]) return true;
  // "Austin", "Austin, TX", "New York City"
  if (/^[A-Z][a-z]+(?:[\s\-][A-Z][a-z]+)*(?:,\s*[A-Z]{2})?$/.test(t)) return true;
  return false;
}

/** Local regex fallback — no network, no keys. */
function parseQueryLocal(raw) {
  let q = String(raw || '').trim().replace(/\s+/g, ' ');
  q = q.replace(FILLER_RE, '').trim();
  let businessType = q;
  let location = '';
  let m = q.match(/^(.+?)\s+(?:in|near|around|at)\s+(.+)$/i);
  if (m) {
    businessType = m[1].trim();
    location = m[2].trim();
  } else {
    m = q.match(/^(.+?),\s*([A-Za-z][A-Za-z .\-]*)$/);
    if (m && looksLikeLocation(m[2])) {
      businessType = m[1].trim();
      location = m[2].trim();
    }
  }
  businessType = businessType.replace(GENERIC_NOUN_RE, '').trim() || q;
  if (location) location = titleCaseLocation(location);
  return { business_type: businessType, location };
}

/** Muse parsing when ANTHROPIC_API_KEY is set. Null on any failure. */
async function claudeParse(query, opts = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || opts.skipClaude) return null;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await (opts.fetch || fetch)(CLAUDE_URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 150,
        system: 'Extract the business type and location from the user\'s lead-search query. '
          + 'Reply with ONLY a JSON object like {"business_type": "...", "location": "..."}. '
          + 'Use "" for location when none is given. Examples: '
          + '"AV integrators in Texas" -> {"business_type":"AV integrators","location":"Texas"}; '
          + '"plumbers near Austin" -> {"business_type":"plumbers","location":"Austin"}; '
          + '"dentists" -> {"business_type":"dentists","location":""}.',
        messages: [{ role: 'user', content: String(query).slice(0, 200) }],
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const jm = text.match(/\{[\s\S]*\}/);
    if (!jm) return null;
    const p = JSON.parse(jm[1]);
    if (!p || !p.business_type) return null;
    return {
      business_type: String(p.business_type).slice(0, 120),
      location: String(p.location || '').slice(0, 120),
    };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(to);
  }
}

/**
 * Parse a plain-English query into { business_type, location }.
 * opts: { skipClaude, fetch } — fetch is passed to the Muse call in tests.
 */
async function parseQuery(query, opts = {}) {
  const ai = await claudeParse(query, opts);
  if (ai) return ai;
  return parseQueryLocal(query);
}

// ---------------------------------------------------------------------------
// Web search (no keys)
// ---------------------------------------------------------------------------

function ddgSearchUrl(q) {
  return 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
}
function bingSearchUrl(q) {
  return 'https://www.bing.com/search?q=' + encodeURIComponent(q);
}

function skipHost(host) {
  return SKIP_DOMAINS.some(d => host === d || host.endsWith('.' + d));
}

/**
 * Pull candidate business-site links out of a search-results page.
 * Returns [{ url, host }] deduped by host, in result order.
 */
function pickLinks(html, engine) {
  const raws = engine === 'bing'
    ? [...String(html || '').matchAll(/<h2><a[^>]*href="(https?:\/\/[^"]+)"/gi)].map(m => m[1])
    : [...String(html || '').matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"/gi)].map(m => m[1]);
  const seen = new Set();
  const out = [];
  for (let href of raws) {
    try {
      if (/^\/\//.test(href)) href = 'https:' + href;
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) href = decodeURIComponent(uddg[1]);
      const u = new URL(href);
      if (!['http:', 'https:'].includes(u.protocol)) continue;
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      if (skipHost(host) || seen.has(host)) continue;
      seen.add(host);
      out.push({ url: u.toString(), host });
      if (out.length >= MAX_SITES) break;
    } catch (e) { /* skip malformed */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Site enrichment
// ---------------------------------------------------------------------------

function cleanName(html, fallbackHost) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let t = m ? m[1].replace(/\s+/g, ' ').trim() : '';
  if (t) {
    const parts = t.split(/\s*[-|–—:]\s*/).map(s => s.trim()).filter(Boolean);
    t = parts.find(p => !GENERIC_TITLE_WORDS.test(p)) || parts[0] || '';
  }
  if (!t || t.length < 2) return fallbackHost;
  return t.slice(0, 80);
}

/**
 * Fetch a business site and extract public contact emails.
 * Tries the found URL, then the homepage, then contact/about pages —
 * stops at the first page that yields emails. Returns null when the
 * site exposes no public email.
 */
async function enrichSite(site, opts = {}) {
  const fetchImpl = opts.fetch;
  let origin;
  try { origin = new URL(site.url).origin; } catch (e) { return null; }
  const candidates = [site.url];
  if (new URL(site.url).href !== origin + '/') candidates.push(origin + '/');
  for (const p of CONTACT_PATHS) candidates.push(origin + p);

  const tried = new Set();
  let name = null;
  let pages = 0;
  for (const url of candidates) {
    if (tried.has(url) || pages >= MAX_PAGES_PER_SITE) break;
    tried.add(url);
    pages += 1;
    const html = await fetchText(url, { fetch: fetchImpl });
    if (!html) continue;
    if (!name) name = cleanName(html, site.host);
    const emails = extractEmails(visibleText(html));
    if (emails.length) return { name: name || site.host, url: origin, emails };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Run an AI-search collection pass.
 * opts: { query, parsed, maxLeads=25, onProgress, noDelay, fetch, skipClaude, knownEmails }
 * Returns { leads, parsed }.
 */
async function collect({ query, parsed, maxLeads = 25, onProgress, noDelay = false, fetch, skipClaude, knownEmails } = {}) {
  const p = parsed || await parseQuery(query, { fetch, skipClaude });
  const base = [p.business_type, p.location].filter(Boolean).join(' ').trim() || String(query || '').trim();
  const queries = [base, `${base} contact email`.trim()].slice(0, MAX_SEARCH_QUERIES);
  const progress = (stage, done, total, message) => {
    if (onProgress) { try { onProgress({ stage, done, total, message }); } catch (e) { /* ignore */ } }
  };

  // 1. web search
  const sites = [];
  for (let i = 0; i < queries.length && sites.length < MAX_SITES; i++) {
    progress('search', i, queries.length, `Searching the web for "${queries[i]}"…`);
    let links = [];
    const ddg = await fetchText(ddgSearchUrl(queries[i]), { fetch });
    if (ddg) links = pickLinks(ddg, 'ddg');
    if (!links.length) {
      const bing = await fetchText(bingSearchUrl(queries[i]), { fetch });
      if (bing) links = pickLinks(bing, 'bing');
    }
    for (const l of links) {
      if (!sites.some(s => s.host === l.host)) sites.push(l);
      if (sites.length >= MAX_SITES) break;
    }
    if (!noDelay) await sleep(SEARCH_DELAY_MS);
  }

  // 2. enrich each site
  const leads = [];
  const cap = Math.min(Math.max(parseInt(maxLeads, 10) || 25, 1), 100);
  for (let i = 0; i < sites.length && leads.length < cap; i++) {
    progress('enrich', i, sites.length, `Checking ${sites[i].host}…`);
    const lead = await enrichSite(sites[i], { fetch });
    if (lead) {
      // NEW-unique fix (2026-10-20): drop already-known emails BEFORE the
      // cap is applied, so the cap fills with NEW uniques instead of
      // total-found that later dedupes down to nothing.
      const fresh = excludeKnownEmails(lead.emails, knownEmails);
      if (fresh.length > 0) leads.push({ ...lead, emails: fresh, location: p.location, source: 'ai-search' });
    }
    if (!noDelay) await sleep(SITE_DELAY_MS + Math.random() * 400);
  }
  progress('done', sites.length, sites.length,
    leads.length ? `Found ${leads.length} businesses with public emails.` : 'No business emails found — try a broader query.');

  return { leads, parsed: p };
}

module.exports = {
  collect, enrichSite, parseQuery, parseQueryLocal, pickLinks, cleanName,
};
