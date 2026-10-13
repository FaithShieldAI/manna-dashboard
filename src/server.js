'use strict';
/**
 * D2RM Dashboard SaaS — API server (Phase 1).
 *
 * Middleware order matters:
 *   helmet -> json parser -> cookies -> request log -> /api/auth (public,
 *   own limiter) -> /api/* (auth, csrf, api limiter) -> 404 -> error handler
 */
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const { migrate, db } = require('./db');
const sessions = require('./lib/sessions');
const { requireAuth } = require('./middleware/auth');
const { csrfCheck } = require('./middleware/csrf');
const { apiLimiter, beaconLimiter } = require('./middleware/rateLimit');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

app.disable('x-powered-by');
app.set('trust proxy', 1); // correct req.ip behind one reverse proxy

app.use(helmet({
  contentSecurityPolicy: false, // frontend served separately in Phase 2
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// Minimal request log (method, path, status, ms) — no bodies, no cookies.
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    // eslint-disable-next-line no-console
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`);
  });
  next();
});

// --- frontend ---------------------------------------------------------------
// Static assets (CSS/JS/wordmarks). Auth pages use external files only so
// they can carry a strict Content-Security-Policy.
const path = require('path');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const STRICT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; "
  + "img-src 'self' data:; font-src 'self'; connect-src 'self'; "
  + "frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

function strictCsp(req, res, next) {
  res.set('Content-Security-Policy', STRICT_CSP);
  next();
}

app.use('/css', strictCsp, express.static(path.join(PUBLIC_DIR, 'css'), { maxAge: '1h' }));
app.use('/js', strictCsp, express.static(path.join(PUBLIC_DIR, 'js'), { maxAge: '1h' }));
// Wordmark + any other root-level public assets (dashboard template refs).
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: false }));

function sendPage(file) {
  return (req, res) => {
    res.set('Content-Security-Policy', STRICT_CSP);
    res.sendFile(path.join(PUBLIC_DIR, file));
  };
}
app.get('/login', sendPage('login.html'));
app.get('/signup', sendPage('signup.html'));
app.get('/forgot', sendPage('forgot.html'));
app.get('/reset', sendPage('reset.html'));
app.get('/verify', sendPage('verify.html'));
app.get('/leads', sendPage('leads.html'));
app.get('/onboarding', requireAuth, sendPage('onboarding.html'));

// /app — the dashboard, auth-gated, per-tenant data injected at serve time.
const { serveApp } = require('./app-serve');
app.get('/app', requireAuth, (req, res) => serveApp(req, res));

// Root -> app (which bounces to /login when unauthenticated).
app.get('/', (req, res) => res.redirect('/app'));

// --- public ----------------------------------------------------------------
app.get('/health', (req, res) => res.json({ ok: true, service: 'd2rm-dashboard-saas', version: '0.1.0' }));
// Auth endpoints also require the X-Requested-With header on mutations:
// uniform CSRF posture, no pre-auth token dance needed since we control the
// frontend and always send the header.
app.use('/api/auth', csrfCheck, require('./routes/auth'));

// Public realtime beacon: POST /api/collect/:siteKey
// Keyed by per-site collect_key (NOT the session cookie) so third-party
// pages can beacon in. CSRF-exempt by design — the collect_key is the auth.
app.post('/api/collect/:siteKey', beaconLimiter, (req, res) => {
  try {
    const siteKey = String(req.params.siteKey || '').toLowerCase();
    const { collect_key, event_name, session_key, metadata } = req.body || {};
    if (!collect_key || typeof event_name !== 'string' || !event_name.trim()) {
      return res.status(400).json({ ok: false, error: 'invalid_beacon' });
    }
    if (event_name.length > 80) {
      return res.status(400).json({ ok: false, error: 'event_name_too_long' });
    }
    const site = db.prepare('SELECT id, tenant_id FROM sites WHERE site_key = ? AND collect_key = ?')
      .get(siteKey, String(collect_key));
    if (!site) {
      // Same shape as bad input — the key is a secret, don't oracle it.
      return res.status(400).json({ ok: false, error: 'invalid_beacon' });
    }
    let metaJson = null;
    if (metadata !== undefined) {
      try { metaJson = JSON.stringify(metadata).slice(0, 2000); }
      catch (e) { metaJson = null; }
    }
    db.prepare(`
      INSERT INTO site_events (tenant_id, site_id, event_name, occurred_at, session_key, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(site.tenant_id, site.id, event_name.trim(),
        new Date().toISOString(),
        typeof session_key === 'string' ? session_key.slice(0, 128) : null,
        metaJson);
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[beacon]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- protected ---------------------------------------------------------------
const api = express.Router();
api.use(requireAuth);
api.use(csrfCheck);
api.use(apiLimiter);

api.use('/overview', require('./routes/overview'));
api.use('/sites', require('./routes/sites'));
api.use('/email', require('./routes/email'));
api.use('/funnels', require('./routes/funnels'));
api.use('/influencers', require('./routes/influencers'));
api.use('/ip-registry', require('./routes/ipRegistry'));
api.use('/billing', require('./routes/billing'));
api.use('/leads', require('./routes/leads'));
api.use('/onboarding', require('./routes/onboarding'));
api.use('/assistant', require('./routes/assistant'));

// Compat shim: query-param style tracker endpoints the dashboard HTML calls
// (API_BASE + '/api/stats?site=KEY'). Same tenant-scoped data, tracker shape.
const { activeNow } = require('./routes/sites');
api.get('/stats', (req, res) => {
  const key = String(req.query.site || '').toLowerCase();
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const site = req.tdb.getSite(key);
  if (!site) return res.status(404).json({ ok: false, error: 'site_not_found' });
  const rows = req.tdb.siteMetrics(site.id, days);
  const sum = rows.reduce((a, r) => ({ visitors: a.visitors + r.visitors, pageviews: a.pageviews + r.pageviews }), { visitors: 0, pageviews: 0 });
  const half = Math.ceil(days / 2);
  const cur = rows.slice(0, half).reduce((a, r) => a + r.visitors, 0);
  const prev = rows.slice(half).reduce((a, r) => a + r.visitors, 0);
  const changePct = prev > 0 ? +(((cur - prev) / prev) * 100).toFixed(1) : null;
  const latest = rows[0] || {};
  res.json({
    ok: true, site: site.site_key, days,
    metrics: {
      visitors: { value: sum.visitors, change_pct: changePct },
      views: { value: sum.pageviews, change_pct: null },
      bounce_rate: { value: latest.bounce_rate ?? null, change_pct: null },
      avg_duration_s: { value: latest.avg_duration_s ?? null, change_pct: null },
    },
    daily: rows,
  });
});
api.get('/realtime', (req, res) => {
  const key = String(req.query.site || '').toLowerCase();
  const site = req.tdb.getSite(key);
  if (!site) return res.status(404).json({ ok: false, error: 'site_not_found' });
  res.json({ ok: true, site: site.site_key, active_now: activeNow(req.tenant.id, site.id, 5) });
});
api.get('/breakdown', (req, res) => {
  const key = String(req.query.site || '').toLowerCase();
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const site = req.tdb.getSite(key);
  if (!site) return res.status(404).json({ ok: false, error: 'site_not_found' });
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const events = db.prepare(`
    SELECT event_name AS label, COUNT(*) AS count FROM site_events
    WHERE tenant_id = ? AND site_id = ? AND occurred_at >= ?
    GROUP BY event_name ORDER BY count DESC`).all(req.tenant.id, site.id, since);
  res.json({ ok: true, site: site.site_key, events, countries: [], referrers: [], utm_sources: [], utm_campaigns: [], devices: [] });
});

const { social, goals } = require('./routes/socialGoals');
api.use('/social', social);
api.use('/goals', goals);

app.use('/api', api);

// --- 404 + error handler -------------------------------------------------------
app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error('[unhandled]', err);
  res.status(500).json({ ok: false, error: 'server_error' });
});

// --- boot ----------------------------------------------------------------------
migrate();

// Seed Michael's real contacts on startup (if not already present)
try {
  const { seedInfluencers } = require('../scripts/seed-contacts');
  Promise.resolve(seedInfluencers()).catch(e => {
    console.error('[seed] Startup seed failed:', e.message);
  });
} catch (e) {
  console.error('[seed] Startup seed failed:', e.message);
}

sessions.purgeExpired();
setInterval(() => sessions.purgeExpired(), 60 * 60 * 1000).unref(); // hourly

if (require.main === module) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[d2rm-dashboard-saas] listening on :${PORT} (env=${process.env.NODE_ENV || 'development'})`);
  });
}

module.exports = app; // for tests
