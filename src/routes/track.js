'use strict';
/**
 * PR email tracking routes — PUBLIC, no auth, mounted at the root by
 * server.js so the paths are exactly:
 *
 *   GET /t/o/:token        open pixel (1x1 transparent GIF)
 *   GET /t/c/:token?u=...  click redirect
 *
 * Press emails sent through Amazon SES embed these URLs on the Manna
 * public domain. The token (src/lib/prTracking.js) is HMAC-signed
 * and names the outlet, recipient email, and release version; a
 * valid token writes one row to pr_events (migration 033) and the
 * PR tab reads the aggregate back via GET /api/pr/tracking.
 *
 * Failure posture: these routes must never break a reader's mail
 * client. An invalid or unsigned token records nothing, but the
 * pixel still serves the GIF and the click route still redirects —
 * to https://faithshield.ai when there is nowhere legitimate to go.
 * A click is recorded only when it actually redirects to the target:
 * a rejected u is not a click.
 */
const express = require('express');
const { db } = require('../db');
const { verify } = require('../lib/prTracking');

const router = express.Router();

// 1x1 transparent GIF89a.
const PIXEL = Buffer.from(
  'R0lGODlhAQABAPAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');

const FALLBACK_URL = 'https://faithshield.ai';

function record(payload, kind, targetUrl, req) {
  try {
    db.prepare(`
      INSERT INTO pr_events (token, outlet, email, version, kind, target_url, ua, ip, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        typeof req.params.token === 'string' ? req.params.token.slice(0, 500) : null,
        payload.o != null ? String(payload.o).slice(0, 300) : null,
        payload.e != null ? String(payload.e).slice(0, 300) : null,
        payload.v != null ? String(payload.v).slice(0, 40) : null,
        kind,
        targetUrl != null ? String(targetUrl).slice(0, 2000) : null,
        (req.get('user-agent') || '').slice(0, 500) || null,
        req.ip || null,
        Math.floor(Date.now() / 1000),
      );
  } catch (e) {
    // Tracking is attribution, never a reader-facing failure.
    // eslint-disable-next-line no-console
    console.error('[track] event insert failed', e);
  }
}

router.get('/t/o/:token', (req, res) => {
  const payload = verify(req.params.token);
  if (payload) record(payload, 'open', null, req);
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Content-Length', PIXEL.length);
  res.end(PIXEL);
});

router.get('/t/c/:token', (req, res) => {
  const payload = verify(req.params.token);
  if (!payload) return res.redirect(302, FALLBACK_URL);
  const u = typeof req.query.u === 'string' ? req.query.u : '';
  let target = null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') target = u;
  } catch (e) { /* not a URL: falls through to the fallback */ }
  if (!target) return res.redirect(302, FALLBACK_URL);
  record(payload, 'click', target, req);
  return res.redirect(302, target);
});

module.exports = router;
