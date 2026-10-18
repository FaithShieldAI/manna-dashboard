'use strict';
/**
 * First-party visit tracking middleware.
 *
 * Logs one row per page view into site_visits. Skips static assets, API
 * calls, and known bots. IPs are SHA256-hashed before storage — we track
 * behavior, not people. Sets a 30-day anonymous session cookie so a later
 * signup can be attributed back to the visit session (see signup_events).
 *
 * Server-side logging bypasses ad blockers entirely: no client JS needed.
 */

const crypto = require('crypto');

const SESSION_COOKIE = 'manna_vs';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

// Paths we never log: static assets, API, health checks, webhooks.
const SKIP_PREFIXES = [
  '/css', '/js', '/images', '/img', '/fonts', '/favicon',
  '/api', '/health', '/webhooks', '/.well-known',
];
const SKIP_EXACT = new Set(['/', '']);

// Cheap bot detection on the User-Agent.
const BOT_RE = /bot|crawl|spider|slurp|mediapartners|baidu|yandex|bingpreview|facebookexternalhit|twitterbot|linkedinbot|embedly|quora|pinterest|slackbot|whatsapp|telegrambot|discordbot|google-inspectiontool/i;

function hashIp(ip) {
  return crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex');
}

function shouldSkip(req) {
  const p = req.path || '';
  if (SKIP_EXACT.has(p)) return false; // we DO want the homepage
  for (const pre of SKIP_PREFIXES) {
    if (p === pre || p.startsWith(pre + '/')) return true;
  }
  // Skip file-ish requests (has an extension) except .html
  if (/\.[a-z0-9]{2,5}$/i.test(p) && !p.endsWith('.html')) return true;
  const ua = req.get('user-agent') || '';
  if (BOT_RE.test(ua)) return true;
  return false;
}

function visitTracking(getDb) {
  return (req, res, next) => {
    // Only track GET page views.
    if (req.method !== 'GET' || shouldSkip(req)) return next();

    let sessionId = req.cookies && req.cookies[SESSION_COOKIE];
    if (!sessionId) {
      sessionId = crypto.randomBytes(16).toString('hex');
      res.cookie(SESSION_COOKIE, sessionId, {
        maxAge: SESSION_MAX_AGE,
        httpOnly: true,
        sameSite: 'lax',
      });
    }

    // Log after the response finishes so tracking never slows the page.
    res.on('finish', () => {
      // Only count successful page views.
      if (res.statusCode < 200 || res.statusCode >= 400) return;
      try {
        const db = getDb();
        const tenantId = (req.tdb && req.tdb.tenantId) || (req.user && req.user.tenant_id) || null;
        db.prepare(`
          INSERT INTO site_visits (tenant_id, path, referrer, user_agent, ip_hash, session_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          tenantId,
          (req.path || '/').slice(0, 500),
          (req.get('referer') || '').slice(0, 500),
          (req.get('user-agent') || '').slice(0, 300),
          hashIp(req.ip),
          sessionId
        );
      } catch (e) {
        // Tracking must never break the site.
        // eslint-disable-next-line no-console
        console.error('[visits] log failed:', e.message);
      }
    });

    // Make the session id available to the signup handler for attribution.
    req.visitSessionId = sessionId;
    next();
  };
}

module.exports = { visitTracking, SESSION_COOKIE, hashIp };
