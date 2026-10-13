'use strict';
/**
 * Shared collection utilities: polite HTTP fetching + public email extraction.
 *
 * Reuses the proven logic from D2RM's internal collectors
 * (instagram-influencer-collector.py / youtube-influencer-scraper.py):
 *   - EMAIL_RE extraction with bad-domain / masked-address filtering
 *   - polite delays, hard timeouts, response size caps
 *
 * fetchText is injectable (opts.fetch) so tests can run without network.
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BAD_DOMAINS = ['example.com', 'email.com', 'sentry.io', 'instagram.com', 'youtube.com', 'facebook.com'];
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB cap per page

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function validEmail(raw) {
  if (!raw) return null;
  let e = String(raw).trim().toLowerCase().replace(/[.,;:]+$/, '');
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(e)) return null;
  if (e.includes('*')) return null; // masked address
  const domain = e.split('@')[1] || '';
  if (BAD_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) return null;
  if (e.length > 254) return null;
  return e;
}

/** Extract unique valid emails from arbitrary text/HTML. */
function extractEmails(text) {
  const found = new Set();
  if (!text) return [];
  // Strip common obfuscation: "name [at] domain [dot] com"
  const normalized = String(text)
    .replace(/\s*\[at\]\s*/gi, '@')
    .replace(/\s*\(at\)\s*/gi, '@')
    .replace(/\s*\[dot\]\s*/gi, '.')
    .replace(/\s*\(dot\)\s*/gi, '.');
  for (const m of normalized.matchAll(EMAIL_RE)) {
    const e = validEmail(m[0]);
    if (e) found.add(e);
  }
  return [...found];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Fetch a URL as text with timeout + size cap. Returns null on any failure
 * (never throws) — collectors treat missing pages as "no data", not errors.
 */
async function fetchText(url, { timeoutMs = 15000, fetch: fetchImpl = fetch } = {}) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BODY_BYTES) return null;
    return buf.toString('utf8');
  } catch (e) {
    return null;
  } finally {
    clearTimeout(to);
  }
}

/** Strip tags crudely for email mining in visible text. */
function visibleText(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
}

module.exports = { validEmail, extractEmails, fetchText, visibleText, sleep, UA };
