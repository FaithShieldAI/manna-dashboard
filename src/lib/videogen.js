'use strict';
/**
 * Video generation — HeyGen API (pay-as-you-go), wired 2026-10-25.
 *
 * This module is the ONLY place that knows anything about the provider.
 * Routes and UI talk in Manna terms (catalogue keys, job states); every
 * HeyGen specific — endpoint shapes, the X-Api-Key header, provider id
 * resolution, status vocabulary — lives here, so swapping providers
 * later means replacing this file's internals only.
 *
 * Fail-closed by design (mirrors Scribe / socialConnect): the key comes
 * from env HEYGEN_API_KEY. When it is absent, isConfigured() is false,
 * routes answer 503 heygen_not_configured, and NO video is ever faked.
 * The API key is never logged, returned, or put in an error message.
 *
 * Engine: 'standard' (the Avatar III class, ~$1/min). Trial tenants run
 * on the standard engine ONLY. PREMIUM SLOT: paid tiers may later get
 * the Avatar IV/V-class engine — that is a second engine constant plus
 * a per-plan pick at create time in the route, and provider payload
 * differences belong in heygenProvider below. Not built now (Michael,
 * 2026-10-25: standard for trials; premium is a later paid-tier step).
 *
 * Provider interface (also what tests inject via _setProviderForTests):
 *   createVideo({ script, avatarKey, voiceKey })
 *     -> { providerJobId }
 *   getVideoStatus(providerJobId)
 *     -> { status: 'processing' }
 *      | { status: 'completed', videoUrl, durationS }
 *      | { status: 'failed', error }
 */

const config = require('../config');

const ENGINE_STANDARD = 'standard';
// const ENGINE_PREMIUM = 'premium'; // <- paid-tier slot, not built.

/**
 * Server-defined catalogue. Clients only ever see keys + display names;
 * provider ids are resolved server-side at creation time (see
 * resolveProviderId) and are never stored on the job or sent to clients.
 */
const CATALOGUE = {
  avatars: [
    { key: 'presenter-a', name: 'Presenter A — studio' },
    { key: 'presenter-b', name: 'Presenter B — studio' },
    { key: 'presenter-c', name: 'Presenter C — casual' },
  ],
  voices: [
    { key: 'narrator-warm', name: 'Warm narrator' },
    { key: 'narrator-bright', name: 'Bright narrator' },
    { key: 'narrator-calm', name: 'Calm narrator' },
  ],
};

function catalogueKeys(kind) {
  return CATALOGUE[kind].map(e => e.key);
}

class VideoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VideoError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// HeyGen provider (the default). v2 generate + v1 status pattern:
//   POST /v2/video/generate            -> { data: { video_id } }
//   GET  /v1/video_status.get?video_id -> { data: { status, video_url,
//                                                  duration, error } }
// ---------------------------------------------------------------------------

function heygenFetch(pathname, { method = 'GET', body } = {}) {
  const url = `${String(config.heygenApiBase).replace(/\/+$/, '')}${pathname}`;
  const ctl = new AbortController();
  // HeyGen authenticated list calls measured at ~41s (Oct 30, 2026); 30s aborted every job.
  const to = setTimeout(() => ctl.abort(), 120000);
  return fetch(url, {
    method,
    signal: ctl.signal,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': config.heygenApiKey,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => {
    let json = null;
    try { json = await res.json(); } catch (e) { /* non-JSON error body */ }
    if (!res.ok) {
      throw new VideoError('heygen_provider_error',
        `HeyGen request failed (HTTP ${res.status}).`);
    }
    if (json && json.error) {
      throw new VideoError('heygen_provider_error',
        `HeyGen request failed (${(json.error && json.error.code) || 'provider error'}).`);
    }
    return json;
  }).catch((e) => {
    if (e instanceof VideoError) throw e;
    const code = e && e.name === 'AbortError' ? 'heygen_timeout' : 'heygen_network_error';
    throw new VideoError(code, `HeyGen request failed before a response was received (${code}).`);
  }).finally(() => clearTimeout(to));
}

/**
 * Catalogue key -> provider id resolution. Order of sources:
 *   1. Env override: HEYGEN_AVATAR_<KEY> / HEYGEN_VOICE_<KEY>
 *      (e.g. HEYGEN_AVATAR_PRESENTER_A) — pins exact provider ids.
 *   2. The provider's own lists (GET /v2/avatars, GET /v2/voices),
 *      mapped in catalogue order; English voices preferred. Cached for
 *      the process lifetime — the catalogue is small and stable.
 */
const idCache = { avatars: null, voices: null };

function envOverride(kind, key) {
  const name = `HEYGEN_${kind === 'avatars' ? 'AVATAR' : 'VOICE'}_${key.toUpperCase().replace(/-/g, '_')}`;
  return process.env[name] || null;
}

async function resolveProviderId(kind, key) {
  const override = envOverride(kind, key);
  if (override) return override;
  if (!idCache[kind]) {
    const json = kind === 'avatars'
      ? await heygenFetch('/v2/avatars')
      : await heygenFetch('/v2/voices');
    const rows = (json && json.data && (json.data.avatars || json.data.voices)) || [];
    const usable = kind === 'voices'
      ? rows.filter(v => !v.language || /^en/i.test(v.language))
      : rows;
    const list = (usable.length ? usable : rows);
    const map = {};
    catalogueKeys(kind).forEach((k, i) => {
      const row = list[i];
      if (row) map[k] = kind === 'avatars' ? row.avatar_id : row.voice_id;
    });
    idCache[kind] = map;
  }
  const id = idCache[kind][key];
  if (!id) {
    throw new VideoError('heygen_catalogue_unavailable',
      `No ${kind === 'avatars' ? 'avatar' : 'voice'} available for catalogue key "${key}".`);
  }
  return id;
}

const heygenProvider = {
  name: 'heygen',
  async createVideo({ script, avatarKey, voiceKey }) {
    const avatarId = await resolveProviderId('avatars', avatarKey);
    const voiceId = await resolveProviderId('voices', voiceKey);
    const json = await heygenFetch('/v2/video/generate', {
      method: 'POST',
      body: {
        video_inputs: [{
          character: { type: 'avatar', avatar_id: avatarId, scale: 1 },
          voice: { type: 'text', input_text: script, voice_id: voiceId, speed: 1 },
        }],
        dimension: { width: 1280, height: 720 },
      },
    });
    const videoId = json && json.data && json.data.video_id;
    if (!videoId) {
      throw new VideoError('heygen_provider_error', 'HeyGen accepted the request but returned no video id.');
    }
    return { providerJobId: String(videoId) };
  },
  async getVideoStatus(providerJobId) {
    const json = await heygenFetch(`/v1/video_status.get?video_id=${encodeURIComponent(providerJobId)}`);
    const data = (json && json.data) || {};
    if (data.status === 'completed') {
      return {
        status: 'completed',
        videoUrl: data.video_url || null,
        durationS: data.duration != null ? Number(data.duration) : null,
      };
    }
    if (data.status === 'failed' || data.status === 'error') {
      const msg = (data.error && (data.error.message || data.error.detail)) || 'provider reported failure';
      return { status: 'failed', error: String(msg).slice(0, 500) };
    }
    return { status: 'processing' };
  },
};

// ---------------------------------------------------------------------------
// Provider selection + test injection
// ---------------------------------------------------------------------------

let testProvider = null;

function activeProvider() {
  return testProvider || heygenProvider;
}

function isConfigured() {
  return Boolean(testProvider) || Boolean(config.heygenConfigured);
}

function providerName() {
  return activeProvider().name || 'heygen';
}

/** Test-only: inject a mock provider (must implement the interface above). */
function _setProviderForTests(p) {
  if (!p || typeof p.createVideo !== 'function' || typeof p.getVideoStatus !== 'function') {
    throw new Error('_setProviderForTests: provider must implement createVideo + getVideoStatus');
  }
  testProvider = p;
}

/** Test-only: restore the real provider and clear catalogue id cache. */
function _resetProvider() {
  testProvider = null;
  idCache.avatars = null;
  idCache.voices = null;
}

// ---------------------------------------------------------------------------
// Public API used by routes
// ---------------------------------------------------------------------------

function getCatalogue() {
  return {
    avatars: CATALOGUE.avatars.map(a => ({ ...a })),
    voices: CATALOGUE.voices.map(v => ({ ...v })),
  };
}

function isValidAvatarKey(key) { return catalogueKeys('avatars').includes(key); }
function isValidVoiceKey(key) { return catalogueKeys('voices').includes(key); }

async function createVideo({ script, avatarKey, voiceKey }) {
  if (!isConfigured()) {
    throw new VideoError('heygen_not_configured', 'HEYGEN_API_KEY is not set; video generation is not configured.');
  }
  return activeProvider().createVideo({ script, avatarKey, voiceKey });
}

async function getVideoStatus(providerJobId) {
  if (!isConfigured()) {
    throw new VideoError('heygen_not_configured', 'HEYGEN_API_KEY is not set; video generation is not configured.');
  }
  return activeProvider().getVideoStatus(providerJobId);
}

function status() {
  return {
    ok: true,
    provider: providerName(),
    configured: isConfigured(),
    engine: ENGINE_STANDARD,
  };
}

/**
 * Back-compat shim for the original stub contract (no current callers):
 * creates a provider job with the default catalogue picks and returns
 * its processing handle instead of a fabricated video.
 */
async function generateVideo(opts = {}) {
  const script = typeof opts.prompt === 'string' ? opts.prompt.slice(0, 1000) : '';
  if (!isConfigured()) {
    return { status: 'not_configured', message: 'video generation not connected', video_url: null, created_at: new Date().toISOString() };
  }
  const { providerJobId } = await createVideo({
    script,
    avatarKey: CATALOGUE.avatars[0].key,
    voiceKey: CATALOGUE.voices[0].key,
  });
  return { status: 'processing', provider_job_id: providerJobId, video_url: null, created_at: new Date().toISOString() };
}

module.exports = {
  CATALOGUE,
  ENGINE_STANDARD,
  VideoError,
  getCatalogue,
  isValidAvatarKey,
  isValidVoiceKey,
  isConfigured,
  providerName,
  createVideo,
  getVideoStatus,
  status,
  generateVideo,
  _setProviderForTests,
  _resetProvider,
};
