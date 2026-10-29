'use strict';
/**
 * Social connections for YouTube, Truth Social and Rumble.
 *
 *   GET    /api/social/platforms            platform catalogue + capabilities
 *   GET    /api/social/accounts             connected rows (no token material)
 *   GET    /api/social/connect/:platform    OAuth dialog URL (youtube, truth)
 *   GET    /api/social/callback/:platform   OAuth redirect target; stores tokens
 *   POST   /api/social/accounts             manual register (rumble handle)
 *   DELETE /api/social/accounts/:platform   disconnect
 *   POST   /api/social/post                 publish (youtube video, truth status)
 *   POST   /api/social/track                refresh follower/post counts
 *
 * All routes are tenant-scoped via req.tdb (requireAuth is applied where the
 * router is mounted in server.js). Access/refresh tokens are AES-256-GCM
 * encrypted (src/lib/socialTokens.js) before they touch the database and are
 * NEVER returned in a response or written to logs.
 *
 * Mirrors the OAuth pattern of src/routes/facebook.js: crypto-random,
 * single-use state, bound to the tenant (and here also to the platform),
 * 10-minute expiry, held in memory. (Single-instance assumption — matches
 * the rest of this service on Render.)
 *
 * Platform notes (kept honest on purpose):
 *   - YouTube: Google OAuth2 (scopes youtube.upload + youtube.readonly).
 *     Requires env GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and optionally
 *     GOOGLE_REDIRECT_URI (default: the production callback below).
 *     Video upload uses the resumable protocol over raw node:https.
 *   - Truth Social: Mastodon API on truthsocial.com. The app registration is
 *     created lazily via POST /api/v1/apps (or supplied via TRUTH_CLIENT_ID /
 *     TRUTH_CLIENT_SECRET) and held in memory; only the resulting USER token
 *     is stored, encrypted. Statuses are capped at 500 characters.
 *   - Rumble: there is NO public posting API. Rumble is manual-register +
 *     stats tracking only; POST /post answers 400 manual_upload_only.
 *
 * Storage (db.js tenant methods, migration 004 + 020 for the platform list):
 *   listConnectedSocials()   — public-safe, no token material
 *   getConnectedSocial(p)    — row WITH token material (server-side only)
 *   upsertConnectedSocial({platform, handle, accessTokenEnc, refreshTokenEnc, expiresAt})
 *   deleteConnectedSocial(platform)
 *   upsertSocialAccount({platform, handle}) / updateSocialStats({platform, handle, followers, posts})
 * If those methods are absent the storage-dependent endpoints answer 503.
 */
const crypto = require('crypto');
const https = require('https');
const express = require('express');
const { encryptToken, decryptToken } = require('../lib/socialTokens');

const router = express.Router();

const FETCH_TIMEOUT_MS = 20000;
const UPLOAD_TIMEOUT_MS = 120000;
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_HANDLE = 80;
const MAX_TITLE = 100;
const MAX_DESCRIPTION = 5000;
const TRUTH_MAX_CHARS = 500;
const MAX_VIDEO_BYTES = 256 * 1024 * 1024; // buffered upload ceiling

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';
const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
].join(' ');

const TRUTH_BASE = 'https://truthsocial.com';
const RUMBLE_BASE = 'https://rumble.com';
const TRUTH_SCOPES = 'read write';

const DEFAULT_REDIRECT_BASE = 'https://manna-production.onrender.com';

// --- platform catalogue -------------------------------------------------------
function platformCatalogue() {
  const g = googleConfig();
  return [
    {
      platform: 'youtube',
      name: 'YouTube',
      connect: 'oauth',
      configured: Boolean(g),
      can_post: true,
      post_types: ['video'],
      can_track: true,
      track_method: 'api',
    },
    {
      platform: 'truth',
      name: 'Truth Social',
      connect: 'oauth',
      configured: true, // app registration is created lazily via the Mastodon API
      can_post: true,
      post_types: ['text', 'media'],
      can_track: true,
      track_method: 'api',
    },
    {
      platform: 'rumble',
      name: 'Rumble',
      connect: 'manual',
      configured: true,
      can_post: false,
      post_types: [],
      posting_note: 'Rumble has no public posting API — videos are uploaded manually in Rumble. Manna tracks channel stats only.',
      can_track: true,
      track_method: 'scrape_best_effort',
    },
  ];
}

const PLATFORM_IDS = new Set(platformCatalogue().map(p => p.platform));

function validPlatform(v) {
  return typeof v === 'string' && PLATFORM_IDS.has(v);
}

// --- OAuth state store (in-memory, single-use) — mirrors facebook.js ----------
const oauthStates = new Map(); // state -> { tenantId, userId, platform, expires }

function pruneStates() {
  const now = Date.now();
  for (const [k, v] of oauthStates) {
    if (v.expires <= now) oauthStates.delete(k);
  }
}

function issueState(tenantId, userId, platform) {
  pruneStates();
  const state = crypto.randomBytes(32).toString('hex');
  oauthStates.set(state, { tenantId, userId, platform, expires: Date.now() + STATE_TTL_MS });
  return state;
}

/** Consumes the state (single-use). Returns the record or null. */
function consumeState(state, tenantId, platform) {
  if (typeof state !== 'string' || !/^[0-9a-f]{64}$/.test(state)) return null;
  const rec = oauthStates.get(state);
  oauthStates.delete(state);
  if (!rec || rec.expires <= Date.now()) return null;
  if (rec.tenantId !== tenantId) return null;
  if (rec.platform !== platform) return null;
  return rec;
}

// --- config -------------------------------------------------------------------
function googleConfig() {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  const redirectUri = (process.env.GOOGLE_REDIRECT_URI || '').trim()
    || `${DEFAULT_REDIRECT_BASE}/api/social/callback/youtube`;
  return { clientId, clientSecret, redirectUri };
}

function truthRedirectUri() {
  return (process.env.TRUTH_REDIRECT_URI || '').trim()
    || `${DEFAULT_REDIRECT_BASE}/api/social/callback/truth`;
}

// Truth/Mastodon app credentials: env override, else lazily self-registered
// once per process and held in memory only (never logged, never in the DB).
let truthAppCache = null;

async function truthApp() {
  const envId = (process.env.TRUTH_CLIENT_ID || '').trim();
  const envSecret = (process.env.TRUTH_CLIENT_SECRET || '').trim();
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret };
  if (truthAppCache) return truthAppCache;
  const data = await providerFetch(`${TRUTH_BASE}/api/v1/apps`, {
    method: 'POST',
    json: {
      client_name: 'Manna AI',
      redirect_uris: truthRedirectUri(),
      scopes: TRUTH_SCOPES,
      website: DEFAULT_REDIRECT_BASE,
    },
  });
  if (!data || !data.client_id || !data.client_secret) {
    throw new ProviderError('truth_app_registration_failed', 502);
  }
  truthAppCache = { clientId: String(data.client_id), clientSecret: String(data.client_secret) };
  return truthAppCache;
}

// --- storage guard --------------------------------------------------------------
const STORE_METHODS = [
  'listConnectedSocials', 'getConnectedSocial', 'upsertConnectedSocial',
  'deleteConnectedSocial', 'upsertSocialAccount', 'updateSocialStats',
];

function socialStore(tdb) {
  if (!tdb) return null;
  for (const m of STORE_METHODS) {
    if (typeof tdb[m] !== 'function') return null;
  }
  return tdb;
}

// --- validation -------------------------------------------------------------------
function cleanHandle(v) {
  if (typeof v !== 'string') return null;
  const h = v.trim().replace(/^@+/, '');
  if (h.length === 0 || h.length > MAX_HANDLE) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(h)) return null;
  return h;
}

function validHttpsUrl(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 2048) return false;
  if (!/^https:\/\//i.test(v) || /\s/.test(v)) return false;
  return true;
}

// --- provider HTTP helpers (never log tokens) --------------------------------------
class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

async function providerFetch(url, { method = 'GET', params = null, json = null, form = null, token = null, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  let resp;
  try {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let body;
    let u = url;
    if (params) {
      const uu = new URL(url);
      for (const [k, v] of Object.entries(params)) uu.searchParams.set(k, v);
      u = uu.toString();
    }
    if (json !== null) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form !== null) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    resp = await fetch(u, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new ProviderError(`provider_request_failed: ${e.name || 'fetch_error'}`, 502);
  }
  let data = null;
  try {
    data = await resp.json();
  } catch (e) {
    if (!resp.ok) throw new ProviderError(`http_${resp.status}`, 502);
    return null;
  }
  if (!resp.ok) {
    const msg = data && (data.error_description || data.error || (data.errors && data.errors.join('; ')))
      ? String(data.error_description || data.error || data.errors.join('; ')).slice(0, 300)
      : `http_${resp.status}`;
    throw new ProviderError(msg, 502);
  }
  return data;
}

/** Minimal raw-https request — used for the YouTube resumable upload (spec). */
function httpsRequest(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = UPLOAD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = https.request(urlStr, { method, headers, timeout: timeoutMs }, (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
        resp.on('error', reject);
      });
    } catch (e) {
      reject(new ProviderError(`provider_request_failed: ${e.message}`, 502));
      return;
    }
    req.on('timeout', () => req.destroy(new Error('request_timeout')));
    req.on('error', (e) => reject(new ProviderError(`provider_request_failed: ${e.message}`, 502)));
    if (body) req.write(body);
    req.end();
  });
}

function providerError(res, e, platform) {
  // eslint-disable-next-line no-console
  console.error(`[social] operation failed platform=${platform || '-'}: ${e.message}`);
  const status = e instanceof ProviderError ? e.status : 500;
  res.status(status).json({ ok: false, error: status === 502 ? 'provider_error' : 'server_error', detail: e.message });
}

// --- token loading -------------------------------------------------------------------
function loadToken(store, platform) {
  const row = store.getConnectedSocial(platform);
  if (!row) return { error: 'not_connected', status: 404 };
  if (!row.access_token_enc) return { error: 'no_token_stored', status: 409 };
  let token;
  try {
    token = decryptToken(row.access_token_enc);
  } catch (e) {
    return { error: 'token_decrypt_failed', status: 500 };
  }
  if (!token) return { error: 'token_decrypt_failed', status: 500 };
  return { row, token };
}

/** YouTube access token, refreshed (and re-persisted) when expired. */
async function loadYouTubeToken(store) {
  const loaded = loadToken(store, 'youtube');
  if (loaded.error) return loaded;
  const { row } = loaded;
  let { token } = loaded;
  const expired = row.expires_at && Date.parse(row.expires_at) <= Date.now() + 60000;
  if (!expired) return { row, token };
  if (!row.refresh_token_enc) return { row, token }; // best effort with the old token
  const cfg = googleConfig();
  if (!cfg) return { error: 'google_not_configured', status: 503 };
  let refresh;
  try {
    refresh = decryptToken(row.refresh_token_enc);
  } catch (e) {
    return { error: 'token_decrypt_failed', status: 500 };
  }
  const data = await providerFetch(GOOGLE_TOKEN, {
    method: 'POST',
    form: {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    },
  });
  if (!data || !data.access_token) throw new ProviderError('token_refresh_failed', 502);
  token = String(data.access_token);
  const expiresAt = data.expires_in
    ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString()
    : row.expires_at;
  store.upsertConnectedSocial({
    platform: 'youtube',
    handle: row.handle,
    accessTokenEnc: encryptToken(token),
    refreshTokenEnc: row.refresh_token_enc,
    expiresAt,
  });
  return { row, token };
}

// --- 1. Platform catalogue ------------------------------------------------------
router.get('/platforms', (req, res) => {
  res.json({ ok: true, platforms: platformCatalogue() });
});

// --- 2. Connected accounts (public-safe) -----------------------------------------
router.get('/accounts', (req, res) => {
  const store = socialStore(req.tdb);
  if (!store) return res.status(503).json({ ok: false, error: 'social_storage_unavailable' });
  try {
    const meta = {};
    for (const p of platformCatalogue()) meta[p.platform] = p;
    const accounts = store.listConnectedSocials()
      .filter(r => meta[r.platform]) // this feature's platforms only
      .map(r => ({
        platform: r.platform,
        name: meta[r.platform].name,
        handle: r.handle,
        has_token: r.has_token,
        connect: meta[r.platform].connect,
        expires_at: r.expires_at || null,
        created_at: r.created_at || null,
      }));
    res.json({ ok: true, accounts });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[social] list accounts failed:', e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- 3. Start OAuth (youtube, truth) ------------------------------------------------
router.get('/connect/:platform', async (req, res) => {
  const { platform } = req.params;
  if (!validPlatform(platform)) return res.status(404).json({ ok: false, error: 'unknown_platform' });
  if (platform === 'rumble') {
    return res.status(400).json({
      ok: false,
      error: 'manual_only',
      detail: 'Rumble has no OAuth or posting API. Register the channel handle with POST /api/social/accounts.',
    });
  }
  try {
    const state = issueState(req.tenant.id, req.user.id, platform);
    let url;
    if (platform === 'youtube') {
      const cfg = googleConfig();
      if (!cfg) return res.status(503).json({ ok: false, error: 'google_not_configured' });
      const u = new URL(GOOGLE_AUTH);
      u.searchParams.set('client_id', cfg.clientId);
      u.searchParams.set('redirect_uri', cfg.redirectUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', YOUTUBE_SCOPES);
      u.searchParams.set('access_type', 'offline');
      u.searchParams.set('prompt', 'consent');
      u.searchParams.set('state', state);
      url = u.toString();
    } else { // truth
      const app = await truthApp();
      const u = new URL(`${TRUTH_BASE}/oauth/authorize`);
      u.searchParams.set('client_id', app.clientId);
      u.searchParams.set('redirect_uri', truthRedirectUri());
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', TRUTH_SCOPES);
      u.searchParams.set('state', state);
      url = u.toString();
    }
    res.json({ ok: true, url });
  } catch (e) {
    providerError(res, e, platform);
  }
});

// --- 4. OAuth callback -----------------------------------------------------------------
router.get('/callback/:platform', async (req, res) => {
  const { platform } = req.params;
  if (!validPlatform(platform)) return res.status(404).json({ ok: false, error: 'unknown_platform' });
  if (platform === 'rumble') return res.status(400).json({ ok: false, error: 'manual_only' });
  const store = socialStore(req.tdb);
  if (!store) return res.status(503).json({ ok: false, error: 'social_storage_unavailable' });

  const { code, state } = req.query;
  if (typeof code !== 'string' || code.length === 0 || code.length > 2048) {
    return res.status(400).json({ ok: false, error: 'missing_code' });
  }
  const rec = consumeState(state, req.tenant.id, platform);
  if (!rec) return res.status(400).json({ ok: false, error: 'invalid_state' });

  try {
    if (platform === 'youtube') {
      const cfg = googleConfig();
      if (!cfg) return res.status(503).json({ ok: false, error: 'google_not_configured' });
      const tok = await providerFetch(GOOGLE_TOKEN, {
        method: 'POST',
        form: {
          code,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          redirect_uri: cfg.redirectUri,
          grant_type: 'authorization_code',
        },
      });
      if (!tok || !tok.access_token) throw new ProviderError('token_exchange_failed', 502);
      const accessToken = String(tok.access_token);

      const ch = await providerFetch(`${YOUTUBE_API}/channels`, {
        params: { part: 'snippet', mine: 'true' },
        token: accessToken,
      });
      const item = ch && Array.isArray(ch.items) ? ch.items[0] : null;
      if (!item) throw new ProviderError('youtube_channel_not_found', 502);
      const handle = String((item.snippet && (item.snippet.customUrl || item.snippet.title)) || item.id || '').slice(0, MAX_HANDLE);
      const expiresAt = tok.expires_in
        ? new Date(Date.now() + Number(tok.expires_in) * 1000).toISOString()
        : null;
      store.upsertConnectedSocial({
        platform: 'youtube',
        handle,
        accessTokenEnc: encryptToken(accessToken),
        refreshTokenEnc: tok.refresh_token ? encryptToken(String(tok.refresh_token)) : null,
        expiresAt,
      });
      store.upsertSocialAccount({ platform: 'youtube', handle });
      return res.json({ ok: true, account: { platform: 'youtube', handle } });
    }

    // truth
    const app = await truthApp();
    const tok = await providerFetch(`${TRUTH_BASE}/oauth/token`, {
      method: 'POST',
      form: {
        grant_type: 'authorization_code',
        code,
        client_id: app.clientId,
        client_secret: app.clientSecret,
        redirect_uri: truthRedirectUri(),
      },
    });
    if (!tok || !tok.access_token) throw new ProviderError('token_exchange_failed', 502);
    const accessToken = String(tok.access_token);
    const me = await providerFetch(`${TRUTH_BASE}/api/v1/accounts/verify_credentials`, { token: accessToken });
    if (!me || !me.username) throw new ProviderError('truth_verify_failed', 502);
    const handle = String(me.username).slice(0, MAX_HANDLE);
    store.upsertConnectedSocial({
      platform: 'truth',
      handle,
      accessTokenEnc: encryptToken(accessToken),
      refreshTokenEnc: null, // Mastodon OAuth2 issues no refresh token here
      expiresAt: null,
    });
    store.upsertSocialAccount({ platform: 'truth', handle });
    res.json({ ok: true, account: { platform: 'truth', handle } });
  } catch (e) {
    providerError(res, e, platform);
  }
});

// --- 5. Manual register (rumble) ----------------------------------------------------------
router.post('/accounts', (req, res) => {
  const store = socialStore(req.tdb);
  if (!store) return res.status(503).json({ ok: false, error: 'social_storage_unavailable' });
  const { platform } = req.body || {};
  if (!validPlatform(platform)) return res.status(404).json({ ok: false, error: 'unknown_platform' });
  if (platform !== 'rumble') {
    return res.status(400).json({
      ok: false,
      error: 'oauth_required',
      detail: `${platform} connects with OAuth — use GET /api/social/connect/${platform}.`,
    });
  }
  const handle = cleanHandle((req.body || {}).handle);
  if (!handle) return res.status(400).json({ ok: false, error: 'invalid_handle' });
  try {
    store.upsertConnectedSocial({
      platform: 'rumble', handle, accessTokenEnc: null, refreshTokenEnc: null, expiresAt: null,
    });
    store.upsertSocialAccount({ platform: 'rumble', handle });
    res.json({ ok: true, account: { platform: 'rumble', handle, has_token: false } });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[social] manual register failed:', e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- 6. Disconnect ------------------------------------------------------------------------------
router.delete('/accounts/:platform', (req, res) => {
  const store = socialStore(req.tdb);
  if (!store) return res.status(503).json({ ok: false, error: 'social_storage_unavailable' });
  const { platform } = req.params;
  if (!validPlatform(platform)) return res.status(404).json({ ok: false, error: 'unknown_platform' });
  try {
    store.deleteConnectedSocial(platform);
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[social] disconnect failed:', e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- 7. Publish --------------------------------------------------------------------------------------
async function postToYouTube(store, body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > MAX_TITLE) return { status: 400, payload: { ok: false, error: 'invalid_title' } };
  const description = body.description === undefined || body.description === null ? '' : body.description;
  if (typeof description !== 'string' || description.length > MAX_DESCRIPTION) {
    return { status: 400, payload: { ok: false, error: 'invalid_description' } };
  }
  if (!validHttpsUrl(body.video_url)) return { status: 400, payload: { ok: false, error: 'invalid_video_url' } };
  const privacy = ['public', 'unlisted', 'private'].includes(body.privacy_status) ? body.privacy_status : 'unlisted';

  const loaded = await loadYouTubeToken(store);
  if (loaded.error) return { status: loaded.status, payload: { ok: false, error: loaded.error } };

  // Download the source video (https only), buffered up to the cap.
  const src = await httpsRequest(body.video_url, { method: 'GET', timeoutMs: UPLOAD_TIMEOUT_MS });
  if (src.status !== 200) throw new ProviderError(`video_download_http_${src.status}`, 502);
  if (src.body.length === 0 || src.body.length > MAX_VIDEO_BYTES) {
    return { status: 400, payload: { ok: false, error: 'video_size_out_of_range' } };
  }
  const contentType = String(src.headers['content-type'] || 'video/mp4').split(';')[0];

  // Resumable upload, step 1: open the session.
  const metadata = JSON.stringify({
    snippet: { title, description },
    status: { privacyStatus: privacy },
  });
  const init = await httpsRequest(`${YOUTUBE_UPLOAD}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${loaded.token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(src.body.length),
      'X-Upload-Content-Type': contentType,
    },
    body: Buffer.from(metadata, 'utf8'),
  });
  if (init.status !== 200 || !init.headers.location) {
    throw new ProviderError(`upload_init_http_${init.status}`, 502);
  }

  // Resumable upload, step 2: send the bytes to the session URI.
  const put = await httpsRequest(String(init.headers.location), {
    method: 'PUT',
    headers: { 'Content-Type': contentType, 'Content-Length': String(src.body.length) },
    body: src.body,
  });
  if (put.status !== 200 && put.status !== 201) {
    throw new ProviderError(`upload_http_${put.status}`, 502);
  }
  let video = null;
  try { video = JSON.parse(put.body.toString('utf8')); } catch (e) { /* non-JSON body */ }
  if (!video || !video.id) throw new ProviderError('upload_bad_response', 502);
  return { status: 200, payload: { ok: true, platform: 'youtube', video_id: String(video.id), url: `https://www.youtube.com/watch?v=${video.id}` } };
}

async function postToTruth(store, body) {
  const text = typeof body.text === 'string' ? body.text : '';
  if (text.trim().length === 0) return { status: 400, payload: { ok: false, error: 'invalid_text' } };
  if (text.length > TRUTH_MAX_CHARS) {
    return { status: 400, payload: { ok: false, error: 'text_too_long', limit: TRUTH_MAX_CHARS } };
  }
  const loaded = loadToken(store, 'truth');
  if (loaded.error) return { status: loaded.status, payload: { ok: false, error: loaded.error } };

  const mediaIds = [];
  if (body.media_url !== undefined && body.media_url !== null && body.media_url !== '') {
    if (!validHttpsUrl(body.media_url)) return { status: 400, payload: { ok: false, error: 'invalid_media_url' } };
    const dl = await httpsRequest(body.media_url, { method: 'GET' });
    if (dl.status !== 200 || dl.body.length === 0) throw new ProviderError(`media_download_http_${dl.status}`, 502);
    const contentType = String(dl.headers['content-type'] || 'application/octet-stream').split(';')[0];
    const form = new FormData();
    form.append('file', new Blob([dl.body], { type: contentType }), 'upload');
    let mediaResp;
    try {
      mediaResp = await fetch(`${TRUTH_BASE}/api/v1/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${loaded.token}` },
        body: form,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      throw new ProviderError(`provider_request_failed: ${e.name || 'fetch_error'}`, 502);
    }
    const media = await mediaResp.json().catch(() => null);
    if (!mediaResp.ok || !media || !media.id) throw new ProviderError('truth_media_upload_failed', 502);
    mediaIds.push(String(media.id));
  }

  const data = await providerFetch(`${TRUTH_BASE}/api/v1/statuses`, {
    method: 'POST',
    token: loaded.token,
    json: mediaIds.length ? { status: text, media_ids: mediaIds } : { status: text },
  });
  if (!data || !data.id) throw new ProviderError('truth_post_failed', 502);
  return { status: 200, payload: { ok: true, platform: 'truth', post_id: String(data.id), url: data.url ? String(data.url) : null } };
}

router.post('/post', async (req, res) => {
  const store = socialStore(req.tdb);
  if (!store) return res.status(503).json({ ok: false, error: 'social_storage_unavailable' });
  const body = req.body || {};
  const { platform } = body;
  if (!validPlatform(platform)) return res.status(404).json({ ok: false, error: 'unknown_platform' });
  if (platform === 'rumble') {
    return res.status(400).json({
      ok: false,
      error: 'manual_upload_only',
      detail: 'Rumble has no public posting API. Upload the video in Rumble itself; Manna tracks the channel stats.',
    });
  }
  try {
    const out = platform === 'youtube' ? await postToYouTube(store, body) : await postToTruth(store, body);
    res.status(out.status).json(out.payload);
  } catch (e) {
    providerError(res, e, platform);
  }
});

// --- 8. Tracking ----------------------------------------------------------------------------------------
function parseCount(numStr, suffix) {
  let n = parseFloat(String(numStr).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  if (suffix) {
    const s = suffix.toUpperCase();
    if (s === 'K') n *= 1000;
    else if (s === 'M') n *= 1000000;
  }
  return Math.round(n);
}

async function trackOne(store, platform) {
  const row = store.getConnectedSocial(platform);
  if (!row) return { platform, tracked: false, error: 'not_connected' };
  const handle = row.handle;
  store.upsertSocialAccount({ platform, handle }); // ensure the stats row exists

  if (platform === 'youtube') {
    const loaded = await loadYouTubeToken(store);
    if (loaded.error) return { platform, handle, tracked: false, error: loaded.error };
    const ch = await providerFetch(`${YOUTUBE_API}/channels`, {
      params: { part: 'statistics', mine: 'true' },
      token: loaded.token,
    });
    const item = ch && Array.isArray(ch.items) ? ch.items[0] : null;
    if (!item || !item.statistics) throw new ProviderError('youtube_stats_not_found', 502);
    const followers = Number(item.statistics.subscriberCount) || 0;
    const posts = Number(item.statistics.videoCount) || 0;
    store.updateSocialStats({ platform, handle, followers, posts });
    return { platform, handle, tracked: true, followers, posts };
  }

  if (platform === 'truth') {
    const loaded = loadToken(store, 'truth');
    if (loaded.error) return { platform, handle, tracked: false, error: loaded.error };
    const me = await providerFetch(`${TRUTH_BASE}/api/v1/accounts/verify_credentials`, { token: loaded.token });
    if (!me) throw new ProviderError('truth_verify_failed', 502);
    const followers = Number(me.followers_count) || 0;
    const posts = Number(me.statuses_count) || 0;
    store.updateSocialStats({ platform, handle, followers, posts });
    return { platform, handle, tracked: true, followers, posts };
  }

  // rumble — best-effort public page scrape. Never throws for parse misses.
  let html = '';
  try {
    const resp = await fetch(`${RUMBLE_BASE}/c/${encodeURIComponent(handle)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MannaStats/1.0)', Accept: 'text/html' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return { platform, handle, tracked: false, error: `scrape_http_${resp.status}` };
    html = await resp.text();
  } catch (e) {
    return { platform, handle, tracked: false, error: 'scrape_request_failed' };
  }
  const subMatch = html.match(/([\d.,]+)\s*([KM])?\s*(?:subscribers|Subscribers)/)
    || html.match(/"subscriberCount"\s*:\s*"?([\d.,]+)"?/);
  const followers = subMatch ? parseCount(subMatch[1], subMatch[2]) : null;
  if (followers === null) return { platform, handle, tracked: false, error: 'scrape_no_match' };
  const vidMatch = html.match(/([\d.,]+)\s*([KM])?\s*(?:videos|Videos)/);
  let posts = vidMatch ? parseCount(vidMatch[1], vidMatch[2]) : null;
  if (posts === null) {
    const existing = (store.socialAccounts ? store.socialAccounts() : [])
      .find(a => a.platform === 'rumble' && a.handle === handle);
    posts = existing ? Number(existing.posts) || 0 : 0;
  }
  store.updateSocialStats({ platform, handle, followers, posts });
  return { platform, handle, tracked: true, followers, posts, method: 'scrape_best_effort' };
}

router.post('/track', async (req, res) => {
  const store = socialStore(req.tdb);
  if (!store) return res.status(503).json({ ok: false, error: 'social_storage_unavailable' });
  const body = req.body || {};
  let platforms;
  if (body.platform !== undefined) {
    if (!validPlatform(body.platform)) return res.status(404).json({ ok: false, error: 'unknown_platform' });
    platforms = [body.platform];
  } else {
    platforms = [...PLATFORM_IDS].filter(p => store.getConnectedSocial(p));
  }
  const results = [];
  for (const p of platforms) {
    try {
      results.push(await trackOne(store, p));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[social] track failed platform=${p}: ${e.message}`);
      results.push({ platform: p, tracked: false, error: e instanceof ProviderError ? 'provider_error' : 'server_error', detail: e.message });
    }
  }
  res.json({ ok: true, results });
});

module.exports = router;
