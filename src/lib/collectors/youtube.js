'use strict';
/**
 * YouTube lead collector (credential-free).
 *
 * Port of the proven logic in D2RM's internal
 * youtube-influencer-scraper.py:
 *   1. Public channel search:  /results?search_query=<kw>&sp=EgIQAg%253D%253D
 *      (type=channel filter), parse ytInitialData for channel renderers.
 *   2. About page per channel: description + external links.
 *   3. Follow up to N external links, extract public contact emails.
 *
 * No API key, no login. Polite by design: 1.5s+ delay between page hits,
 * bounded channels per keyword, bounded external links per channel.
 *
 * Returns: [{ channel_id, name, handle, subscribers, emails: [...] }]
 */

const { fetchText, extractEmails, visibleText, sleep } = require('./common');

const SEARCH_DELAY_MS = 1500;
const ABOUT_DELAY_MS = 1200;
const MAX_LINKS_PER_CHANNEL = 2;

function getYtInitialData(html) {
  if (!html) return null;
  const m = html.match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*(?:var|<\/script>)/)
    || html.match(/var ytInitialData\s*=\s*(\{.*\});/s);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

function findChannelRenderers(node, found = []) {
  if (!node) return found;
  if (Array.isArray(node)) {
    for (const v of node) findChannelRenderers(v, found);
  } else if (typeof node === 'object') {
    if (node.channelRenderer) found.push(node.channelRenderer);
    for (const v of Object.values(node)) findChannelRenderers(v, found);
  }
  return found;
}

function simpleText(d) {
  return (d && typeof d === 'object' && d.simpleText) ? d.simpleText : '';
}

async function searchChannels(keyword, maxResults = 10, opts = {}) {
  const url = 'https://www.youtube.com/results?search_query='
    + encodeURIComponent(keyword) + '&sp=EgIQAg%253D%253D';
  const html = await fetchText(url, opts);
  const data = getYtInitialData(html);
  const out = [];
  if (data) {
    for (const cr of findChannelRenderers(data)) {
      const cid = cr.channelId || '';
      const title = cr.title || {};
      const name = simpleText(title);
      let handle = '';
      try {
        handle = (((cr.navigationEndpoint || {}).commandMetadata || {}).webCommandMetadata || {}).url || '';
      } catch (e) { /* keep '' */ }
      const subs = simpleText(cr.videoCountText || {});
      if (cid && name) out.push({ channel_id: cid, name, handle, subscribers: subs });
      if (out.length >= maxResults) break;
    }
  }
  if (!opts.noDelay) await sleep(SEARCH_DELAY_MS + Math.random() * 800);
  return out;
}

/** Walk an object tree, collecting values of nodes keyed `key`. */
function walkKey(node, key, found = []) {
  if (!node) return found;
  if (Array.isArray(node)) {
    for (const v of node) walkKey(v, key, found);
  } else if (typeof node === 'object') {
    if (Object.prototype.hasOwnProperty.call(node, key)) found.push(node[key]);
    for (const v of Object.values(node)) walkKey(v, key, found);
  }
  return found;
}

async function getChannelLeads(channel, opts = {}) {
  const { channel_id, name, handle, subscribers } = channel;
  const html = await fetchText(`https://www.youtube.com/channel/${channel_id}/about`, opts);
  const emails = new Set();
  let websites = [];
  if (html) {
    const data = getYtInitialData(html);
    if (data) {
      // description
      for (const meta of walkKey(data, 'channelAboutFullMetadataRenderer')) {
        const desc = simpleText(meta.description || {});
        for (const e of extractEmails(visibleText(desc))) emails.add(e);
      }
      // external links
      for (const vm of walkKey(data, 'channelExternalLinkViewModel')) {
        let link = ((vm.link || {}).content) || '';
        if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
        if (link) websites.push(link);
      }
    }
    // emails directly on the about page HTML
    for (const e of extractEmails(visibleText(html))) emails.add(e);
  }
  websites = [...new Set(websites)].slice(0, MAX_LINKS_PER_CHANNEL);
  for (const site of websites) {
    const page = await fetchText(site, opts);
    for (const e of extractEmails(visibleText(page))) emails.add(e);
    if (!opts.noDelay) await sleep(800 + Math.random() * 600);
  }
  if (!opts.noDelay) await sleep(ABOUT_DELAY_MS);
  return {
    channel_id,
    name,
    handle: handle || '',
    subscribers: subscribers || '',
    websites,
    emails: [...emails],
  };
}

/**
 * Run a full YouTube collection pass.
 * opts: { maxPerKeyword=10, maxLeads=25, keywords=[...], noDelay, fetch }
 * Stops early once maxLeads leads with emails are found.
 * onProgress({ stage, keyword, done, total }) — optional progress callback.
 */
async function collect({ keywords, maxPerKeyword = 10, maxLeads = 25, onProgress, ...opts } = {}) {
  const leads = [];
  const kws = (keywords || []).slice(0, 5); // hard cap: 5 keywords/job
  for (let i = 0; i < kws.length; i++) {
    const kw = kws[i];
    if (onProgress) onProgress({ stage: 'search', keyword: kw, done: i, total: kws.length });
    const channels = await searchChannels(kw, Math.min(maxPerKeyword, 15), opts);
    for (const ch of channels) {
      const lead = await getChannelLeads(ch, opts);
      if (lead.emails.length > 0) {
        leads.push({ ...lead, keyword: kw });
        if (leads.length >= maxLeads) return leads;
      }
    }
    if (onProgress) onProgress({ stage: 'search', keyword: kw, done: i + 1, total: kws.length });
  }
  return leads;
}

module.exports = { searchChannels, getChannelLeads, collect };
