'use strict';
/**
 * Video generation — STUB (2026-10-20, worker D).
 *
 * Stable interface reserved for the future video-gen provider hookup
 * (Manna Heavy $99/$189 tiers — video generation is the tier's core
 * deliverable). This module returns a `status: 'stub'` payload today so
 * the dashboard UI, routes, and tiers code can wire against
 * `generateVideo(opts)` now; flipping to a real provider later means
 * replacing the internals here without touching any callers.
 *
 * Intended final contract:
 *   await generateVideo({ prompt, duration_s, product, language, aspect })
 *   -> { status: 'ok', video_url, duration_s, created_at }
 */
async function generateVideo(opts = {}) {
  return {
    status: 'stub',
    message: 'video generation not connected',
    requested: {
      prompt: typeof opts.prompt === 'string' ? opts.prompt.slice(0, 500) : '',
      duration_s: Number.isFinite(opts.duration_s) ? opts.duration_s : null,
      product: opts.product || null,
      language: opts.language || null,
      aspect: opts.aspect || null,
    },
    video_url: null,
    created_at: new Date().toISOString(),
  };
}

module.exports = { generateVideo };
