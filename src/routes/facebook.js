'use strict';
/**
 * Facebook + Instagram OAuth and posting API.
 *
 *   GET    /api/facebook/auth-url                  OAuth dialog URL (authed user)
 *   GET    /api/facebook/callback?code=..&state=.. Meta redirects here; stores Page tokens
 *   GET    /api/facebook/pages                     pages for this tenant (no tokens)
 *   DELETE /api/facebook/pages/:pageId             disconnect a Page
 *   POST   /api/facebook/pages/:pageId/post         { message, link?, image_url? } -> Page feed
 *   POST   /api/facebook/pages/:pageId/instagram   { image_url, caption? } -> IG publish
 *   GET    /api/facebook/pages/:pageId/insights    read-only Page insights
 *
 * All routes are tenant-scoped via req.tdb (requireAuth is applied where the
 * router is mounted in server.js). Page access tokens are AES-256-GCM
 * encrypted (src/lib/socialTokens.js) before they touch the database and are
 * NEVER returned in a response or written to logs.
 *
 * Requires env: FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, FACEBOOK_REDIRECT_URI.
 * Requires migration 018 (facebook_pages) + db.js tenant methods:
 *   upsertFacebookPage({pageId, pageName, pageTokenEnc, igUserId, igUsername})
 *   listFacebookPages()            — public-safe, no token material
 *   getFacebookPage(pageId)        — row WITH page_token_enc
 *   deleteFacebookPage(pageId)
 * If those methods are absent the storage-dependent endpoints answer 503.
 *
 * OAuth state: crypto-random, single-use, bound to the tenant, 10-minute
 * expiry, held in memory. (Single-instance assumption — matches the rest of
 * this service on Render; revisit if the app ever runs multi-instance.)
 */
const crypto = require('crypto');
const express = require('express');
const { encryptToken, decryptToken } = require('../lib/socialTokens');

const router = express.Router();

const GRAPH = 'https://graph.facebook.com/v21.0';
const OAUTH_DIALOG = 'https://www.facebook.com/v21.0/dialog/oauth';
const SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
].join(',');
const FETCH_TIMEOUT_MS = 20000;
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_MESSAGE = 5000;
const MAX_CAPTION = 2200;
const MAX_URL = 2048;

// --- OAuth state store (in-memory, single-use) ------------------------------
const oauthStates = new Map(); // state -> { tenantId, userId, expires }

function pruneStates() {
  const now = Date.now();
  for (const [k, v] of oauthStates) {
    if (v.expires <= now) oauthStates.delete(k);
  }
}

function issueState(tenantId, userId) {
  pruneStates();
  const state = crypto.randomBytes(32).toString('hex');
  oauthStates.set(state, { tenantId, userId, expires: Date.now() + STATE_TTL_MS });
  return state;
}

/** Consumes the state (single-use). Returns the record or null. */
function consumeState(state, tenantId) {
  if (typeof state !== 'string' || !/^[0-9a-f]{64}$/.test(state)) return null;
  const rec = oauthStates.get(state);
  oauthStates.delete(state);
  if (!rec || rec.expires <= Date.now()) return null;
  if (rec.tenantId !== tenantId) return null;
  return rec;
}

// --- config -----------------------------------------------------------------
function fbConfig() {
  const appId = (process.env.FACEBOOK_APP_ID || '').trim();
  const appSecret = (process.env.FACEBOOK_APP_SECRET || '').trim();
  const redirectUri = (process.env.FACEBOOK_REDIRECT_URI || '').trim();
  if (!appId || !appSecret || !redirectUri) return null;
  return { appId, appSecret, redirectUri };
}

// --- storage guard ------------------------------------------------------------
const STORE_METHODS = ['upsertFacebookPage', 'listFacebookPages', 'getFacebookPage', 'deleteFacebookPage'];

function fbStore(tdb) {
  if (!tdb) return null;
  for (const m of STORE_METHODS) {
    if (typeof tdb[m] !== 'function') return null;
  }
  return tdb;
}

// --- validation ---------------------------------------------------------------
function validPageId(v) {
  return typeof v === 'string' && /^\d{1,32}$/.test(v);
}

function validHttpUrl(v, { httpsOnly = false } = {}) {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_URL) return false;
  const re = httpsOnly ? /^https:\/\//i : /^https?:\/\//i;
  if (!re.test(v)) return false;
  if (/\s/.test(v)) return false;
  return true;
}

// --- Meta API helpers (never log tokens) --------------------------------------
class MetaError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'MetaError';
    this.status = status;
  }
}

async function metaFetch(url, { method = 'GET', params = null, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  let resp;
  try {
    if (method === 'GET') {
      const u = new URL(url);
      if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      resp = await fetch(u.toString(), { signal: AbortSignal.timeout(timeoutMs) });
    } else {
      const body = new URLSearchParams();
      if (params) for (const [k, v] of Object.entries(params)) body.set(k, v);
      resp = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
  } catch (e) {
    throw new MetaError(`meta_request_failed: ${e.name || 'fetch_error'}`, 502);
  }
  let data = null;
  try {
    data = await resp.json();
  } catch (e) {
    throw new MetaError('meta_bad_response', 502);
  }
  if (!resp.ok || (data && data.error)) {
    const msg = data && data.error && data.error.message
      ? String(data.error.message).slice(0, 300)
      : `http_${resp.status}`;
    throw new MetaError(msg, 502);
  }
  return data;
}

function metaError(res, e, pageId) {
  // eslint-disable-next-line no-console
  console.error(`[facebook] operation failed page=${pageId || '-'}: ${e.message}`);
  const status = e instanceof MetaError ? e.status : 500;
  res.status(status).json({ ok: false, error: status === 502 ? 'meta_error' : 'server_error', detail: e.message });
}

// --- 1. OAuth dialog URL --------------------------------------------------------
router.get('/auth-url', (req, res) => {
  const cfg = fbConfig();
  if (!cfg) return res.status(503).json({ ok: false, error: 'facebook_not_configured' });
  const state = issueState(req.tenant.id, req.user.id);
  const u = new URL(OAUTH_DIALOG);
  u.searchParams.set('client_id', cfg.appId);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('response_type', 'code');
  res.json({ ok: true, url: u.toString() });
});

// --- 2. OAuth callback ------------------------------------------------------------
router.get('/callback', async (req, res) => {
  const cfg = fbConfig();
  if (!cfg) return res.status(503).json({ ok: false, error: 'facebook_not_configured' });
  const store = fbStore(req.tdb);
  if (!store) return res.status(503).json({ ok: false, error: 'facebook_storage_unavailable' });

  const { code, state } = req.query;
  if (typeof code !== 'string' || code.length === 0 || code.length > 1024) {
    return res.status(400).json({ ok: false, error: 'missing_code' });
  }
  const rec = consumeState(state, req.tenant.id);
  if (!rec) {
    return res.status(400).json({ ok: false, error: 'invalid_state' });
  }

  try {
    // Short-lived user token.
    const tok1 = await metaFetch(`${GRAPH}/oauth/access_token`, {
      params: {
        client_id: cfg.appId,
        client_secret: cfg.appSecret,
        redirect_uri: cfg.redirectUri,
        code,
      },
    });
    if (!tok1.access_token) throw new MetaError('token_exchange_failed', 502);

    // Long-lived user token (~60 days).
    const tok2 = await metaFetch(`${GRAPH}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: cfg.appId,
        client_secret: cfg.appSecret,
        fb_exchange_token: tok1.access_token,
      },
    });
    if (!tok2.access_token) throw new MetaError('long_lived_exchange_failed', 502);

    // Pages this user manages, with Page tokens + linked IG accounts.
    const accounts = await metaFetch(`${GRAPH}/me/accounts`, {
      params: {
        fields: 'id,name,access_token,instagram_business_account{id,username}',
        access_token: tok2.access_token,
      },
    });

    const pages = [];
    for (const p of (accounts && accounts.data) || []) {
      if (!p || !validPageId(String(p.id)) || typeof p.access_token !== 'string') continue;
      const ig = p.instagram_business_account || null;
      store.upsertFacebookPage({
        pageId: String(p.id),
        pageName: String(p.name || ''),
        pageTokenEnc: encryptToken(p.access_token),
        igUserId: ig && ig.id ? String(ig.id) : null,
        igUsername: ig && ig.username ? String(ig.username) : null,
      });
      pages.push({
        page_id: String(p.id),
        page_name: String(p.name || ''),
        ig_username: ig && ig.username ? String(ig.username) : null,
      });
    }
    res.json({ ok: true, pages });
  } catch (e) {
    metaError(res, e, null);
  }
});

// --- 3. List pages (public-safe) --------------------------------------------------
router.get('/pages', (req, res) => {
  const store = fbStore(req.tdb);
  if (!store) return res.status(503).json({ ok: false, error: 'facebook_storage_unavailable' });
  try {
    res.json({ ok: true, pages: store.listFacebookPages() });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[facebook] list pages failed:', e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- 4. Disconnect a page -----------------------------------------------------------
router.delete('/pages/:pageId', (req, res) => {
  const store = fbStore(req.tdb);
  if (!store) return res.status(503).json({ ok: false, error: 'facebook_storage_unavailable' });
  const { pageId } = req.params;
  if (!validPageId(pageId)) return res.status(400).json({ ok: false, error: 'invalid_page_id' });
  try {
    store.deleteFacebookPage(pageId);
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[facebook] delete page failed:', e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- helpers for posting --------------------------------------------------------------
async function loadPageToken(store, pageId) {
  const row = store.getFacebookPage(pageId);
  if (!row) return { error: 'page_not_found', status: 404 };
  let token;
  try {
    token = decryptToken(row.page_token_enc);
  } catch (e) {
    return { error: 'token_decrypt_failed', status: 500 };
  }
  if (!token) return { error: 'token_decrypt_failed', status: 500 };
  return { row, token };
}

// --- 5. Post to Page feed ------------------------------------------------------------------
router.post('/pages/:pageId/post', async (req, res) => {
  const store = fbStore(req.tdb);
  if (!store) return res.status(503).json({ ok: false, error: 'facebook_storage_unavailable' });
  const { pageId } = req.params;
  if (!validPageId(pageId)) return res.status(400).json({ ok: false, error: 'invalid_page_id' });

  const { message, link, image_url } = req.body || {};
  if (typeof message !== 'string' || message.trim().length === 0 || message.length > MAX_MESSAGE) {
    return res.status(400).json({ ok: false, error: 'invalid_message' });
  }
  if (link !== undefined && link !== null && link !== '' && !validHttpUrl(link)) {
    return res.status(400).json({ ok: false, error: 'invalid_link' });
  }
  if (image_url !== undefined && image_url !== null && image_url !== '' && !validHttpUrl(image_url)) {
    return res.status(400).json({ ok: false, error: 'invalid_image_url' });
  }

  const loaded = await loadPageToken(store, pageId);
  if (loaded.error) return res.status(loaded.status).json({ ok: false, error: loaded.error });

  try {
    const params = { message, access_token: loaded.token };
    if (link) params.link = link;
    if (image_url) params.url = image_url;
    const data = await metaFetch(`${GRAPH}/${pageId}/feed`, { method: 'POST', params });
    res.json({ ok: true, post_id: String(data.id || '') });
  } catch (e) {
    metaError(res, e, pageId);
  }
});

// --- 6. Publish to Instagram -------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

router.post('/pages/:pageId/instagram', async (req, res) => {
  const store = fbStore(req.tdb);
  if (!store) return res.status(503).json({ ok: false, error: 'facebook_storage_unavailable' });
  const { pageId } = req.params;
  if (!validPageId(pageId)) return res.status(400).json({ ok: false, error: 'invalid_page_id' });

  const { image_url, caption } = req.body || {};
  if (!validHttpUrl(image_url, { httpsOnly: true })) {
    return res.status(400).json({ ok: false, error: 'invalid_image_url' });
  }
  if (caption !== undefined && caption !== null && caption !== '' &&
      (typeof caption !== 'string' || caption.length > MAX_CAPTION)) {
    return res.status(400).json({ ok: false, error: 'invalid_caption' });
  }

  const loaded = await loadPageToken(store, pageId);
  if (loaded.error) return res.status(loaded.status).json({ ok: false, error: loaded.error });
  const igUserId = loaded.row.ig_user_id;
  if (!igUserId) {
    return res.status(404).json({ ok: false, error: 'no_instagram_account' });
  }

  try {
    // Step 1: create the media container.
    const containerParams = { image_url, access_token: loaded.token };
    if (caption) containerParams.caption = caption;
    const container = await metaFetch(`${GRAPH}/${igUserId}/media`, { method: 'POST', params: containerParams });
    const creationId = container && container.id ? String(container.id) : null;
    if (!creationId) throw new MetaError('media_container_failed', 502);

    // Step 2: publish. The container may need a moment (video/thumbnail
    // processing) — one retry after 20s if Meta says it is not ready.
    let published = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        published = await metaFetch(`${GRAPH}/${igUserId}/media_publish`, {
          method: 'POST',
          params: { creation_id: creationId, access_token: loaded.token },
        });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const notReady = /not ready|not_available|processing/i.test(e.message || '');
        if (attempt === 0 && notReady) {
          await sleep(20000);
          continue;
        }
        throw e;
      }
    }
    if (!published) throw lastErr || new MetaError('media_publish_failed', 502);
    res.json({ ok: true, media_id: String(published.id || '') });
  } catch (e) {
    metaError(res, e, pageId);
  }
});

// --- 7. Page insights (read-only) ------------------------------------------------------------------
router.get('/pages/:pageId/insights', async (req, res) => {
  const store = fbStore(req.tdb);
  if (!store) return res.status(503).json({ ok: false, error: 'facebook_storage_unavailable' });
  const { pageId } = req.params;
  if (!validPageId(pageId)) return res.status(400).json({ ok: false, error: 'invalid_page_id' });

  const loaded = await loadPageToken(store, pageId);
  if (loaded.error) return res.status(loaded.status).json({ ok: false, error: loaded.error });

  try {
    const data = await metaFetch(`${GRAPH}/${pageId}/insights`, {
      params: {
        metric: 'page_impressions,page_engaged_users',
        period: 'day',
        access_token: loaded.token,
      },
    });
    res.json({ ok: true, insights: data.data || [] });
  } catch (e) {
    metaError(res, e, pageId);
  }
});

module.exports = router;
