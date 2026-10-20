'use strict';
/**
 * Seed-URL lead collector.
 *
 * The customer pastes seed URLs (creator homepages, link-in-bio pages,
 * directories, "contact" pages). We fetch each page, extract public
 * contact emails, and record the page title as the lead name.
 *
 * No credentials needed. Same polite fetching as the YouTube collector.
 *
 * Returns: [{ url, title, emails: [...] }]
 */

const { fetchText, extractEmails, visibleText, sleep, excludeKnownEmails } = require('./common');

function pageTitle(html) {
  if (!html) return '';
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function normalizeUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch (e) {
    return null;
  }
}

async function collectUrl(url, opts = {}) {
  const html = await fetchText(url, opts);
  if (!html) return { url, title: '', emails: [] };
  const text = visibleText(html);
  return { url, title: pageTitle(html), emails: extractEmails(text) };
}

/**
 * Run a seed-URL collection pass.
 * opts: { seeds=[...], noDelay, fetch, onProgress, knownEmails }
 */
async function collect({ seeds, onProgress, knownEmails, ...opts } = {}) {
  const urls = [...new Set((seeds || []).map(normalizeUrl).filter(Boolean))].slice(0, 25); // cap 25/job
  const leads = [];
  for (let i = 0; i < urls.length; i++) {
    if (onProgress) onProgress({ stage: 'fetch', url: urls[i], done: i, total: urls.length });
    const lead = await collectUrl(urls[i], opts);
    // NEW-unique fix (2026-10-20): drop already-known emails from the
    // candidate set BEFORE the downstream cap is applied, so the cap
    // fills with NEW uniques.
    const fresh = excludeKnownEmails(lead.emails, knownEmails);
    if (fresh.length > 0) leads.push({ ...lead, emails: fresh });
    if (!opts.noDelay) await sleep(900 + Math.random() * 700);
    if (onProgress) onProgress({ stage: 'fetch', url: urls[i], done: i + 1, total: urls.length });
  }
  return leads;
}

module.exports = { collect, collectUrl, normalizeUrl };
