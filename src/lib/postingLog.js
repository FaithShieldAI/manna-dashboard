'use strict';
/**
 * Posting log — the single writer for posting attribution.
 *
 * Two tables describe a post that went out:
 *   social_postings  — the tracking board (Social Posting Tracking):
 *                      one row per published post with a real URL, plus
 *                      its engagement metrics.
 *   content_postings — the attribution record (migration 008): every
 *                      posting traced to its content item and contact,
 *                      including posts whose URL is not known yet.
 *
 * Until 2026-11-18 nothing wrote content_postings at all (dead table),
 * and social_postings was fed only by the manual log form — posts made
 * through Manna's own posting routes never landed on the board. Every
 * posting path now funnels through here:
 *   - routes/engagement.js POST /social (manual log) writes both.
 *   - routes/socialConnect.js POST /post (YouTube / Truth Social) and
 *     routes/facebook.js page + Instagram posts call recordPosting()
 *     after a successful publish.
 *
 * recordPosting is fail-soft by contract: callers invoke it AFTER the
 * post is already published, and a logging failure must never turn a
 * published post into an API error. It logs and returns nulls instead.
 */
const { db } = require('../db');

// Platforms the tracking board accepts (mirrors the social_postings
// CHECK after migration 040, which added 'youtube').
const TRACKING_PLATFORMS = [
  'instagram', 'facebook', 'x', 'linkedin', 'tiktok', 'telegram',
  'rumble', 'truthsocial', 'youtube',
];

// Posting routes name some platforms differently from the board
// (socialConnect calls Truth Social 'truth').
const PLATFORM_ALIASES = { truth: 'truthsocial' };

function normalizePlatform(platform) {
  const p = String(platform || '').trim().toLowerCase();
  return PLATFORM_ALIASES[p] || p;
}

function nonNegInt(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Insert ONLY the attribution row (content_postings). Used by the
 * manual log endpoint, which has already written its social_postings
 * row, and available to any flow that knows a posting happened.
 * Throws on DB error — callers decide whether that is fatal.
 */
function insertAttribution({ tenantId, contentId = null, platform, accountHandle = null,
  postUrl = null, contactId = null, campaignName = null, postedAt = null,
  metrics = {}, notes = null }) {
  const r = db.prepare(
    `INSERT INTO content_postings
       (tenant_id, content_id, platform, account_handle, post_url, contact_id,
        campaign_name, posted_at, views, likes, comments, shares, clicks, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
             ?, ?, ?, ?, ?, ?)`
  ).run(
    tenantId,
    contentId != null ? contentId : null,
    normalizePlatform(platform),
    accountHandle || null,
    postUrl || null,
    contactId != null ? contactId : null,
    campaignName || null,
    postedAt || null,
    metrics.views != null ? nonNegInt(metrics.views) : null,
    metrics.likes != null ? nonNegInt(metrics.likes) : null,
    metrics.comments != null ? nonNegInt(metrics.comments) : null,
    metrics.shares != null ? nonNegInt(metrics.shares) : null,
    metrics.clicks != null ? nonNegInt(metrics.clicks) : null,
    notes || null
  );
  return Number(r.lastInsertRowid);
}

/**
 * Record a post that was just published through a Manna posting route.
 * Writes the attribution row always, and the tracking-board row when
 * the platform is tracked and a real http(s) URL is known.
 * Returns { content_posting_id, social_posting_id } (either may be
 * null); never throws.
 */
function recordPosting({ tenantId, platform, postUrl = null, contentItemId = null,
  accountHandle = null, contactId = null, campaignName = null, notes = null,
  metrics = {} }) {
  const out = { content_posting_id: null, social_posting_id: null };
  try {
    const p = normalizePlatform(platform);
    // A content link counts only when the item is this tenant's own.
    let cid = null;
    if (contentItemId != null && contentItemId !== '') {
      const n = parseInt(contentItemId, 10);
      if (Number.isInteger(n) && n >= 1) {
        const item = db.prepare(
          'SELECT id FROM content_items WHERE tenant_id = ? AND id = ?'
        ).get(tenantId, n);
        if (item) cid = n;
      }
    }
    out.content_posting_id = insertAttribution({
      tenantId, contentId: cid, platform: p, accountHandle,
      postUrl, contactId, campaignName, metrics, notes,
    });
    const url = typeof postUrl === 'string' ? postUrl.trim() : '';
    if (TRACKING_PLATFORMS.includes(p) && /^https?:\/\//i.test(url) && url.length <= 2000) {
      const r = db.prepare(
        `INSERT INTO social_postings
           (tenant_id, platform, post_url, content_item_id, likes, shares, comments, clicks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(tenantId, p, url, cid,
        nonNegInt(metrics.likes), nonNegInt(metrics.shares),
        nonNegInt(metrics.comments), nonNegInt(metrics.clicks));
      out.social_posting_id = Number(r.lastInsertRowid);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[postingLog] recordPosting failed:', e.message);
  }
  return out;
}

module.exports = { TRACKING_PLATFORMS, normalizePlatform, insertAttribution, recordPosting };
