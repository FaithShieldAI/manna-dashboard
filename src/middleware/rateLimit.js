'use strict';
/**
 * Rate limiters. Auth endpoints are the brute-force surface — keep them
 * tight. General API gets a generous bucket.
 */
const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                 // 20 attempts per IP per window
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'too_many_requests' },
});

// Login gets its own tighter bucket — it's the brute-force target.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                 // 10 login attempts per IP per window
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'too_many_requests' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'too_many_requests' },
});

// Public realtime beacon: keyed by per-site collect_key, so the bucket can
// stay generous without opening an abuse vector.
const beaconLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 600,            // 10 hits/sec per IP is plenty for a beacon
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'too_many_requests' },
});

module.exports = { authLimiter, loginLimiter, apiLimiter, beaconLimiter };
