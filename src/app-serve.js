'use strict';
/**
 * Serves the dashboard HTML per-tenant at GET /app (auth-gated).
 *
 * Serve-time injection — the 949-line dashboard file stays untouched on
 * disk; we transform a copy per request:
 *   1. API_BASE -> '' (same origin; hits the /api/* compat shim)
 *   2. var SITES -> the tenant's live projects (drives the Sites tab)
 *   3. var EMAIL_WINDOWS -> live /api/email/windows mapped to the
 *      dashboard's expected shape (Email tab range switching)
 *   4. Goals grid gets id="d2rm-goals-grid"; an injected boot script
 *      re-renders it from /api/goals (generic per-tenant cards)
 *   5. Nav gets a tenant chip + links (Leads, Log out)
 *   6. Boot script: goals re-render from /api/goals + logout handler.
 *      (The AI instructor panel lives in the template itself.)
 *
 * Source file: DASHBOARD_HTML_PATH or ~/workspace/your_files/d2rm-live-dashboard.html
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DASHBOARD_PATH = process.env.DASHBOARD_HTML_PATH
  || path.join(__dirname, '..', 'public', 'dashboard-template.html');

let cachedHtml = null;
let cachedMtime = 0;

function loadDashboardHtml() {
  const st = fs.statSync(DASHBOARD_PATH);
  if (!cachedHtml || st.mtimeMs !== cachedMtime) {
    cachedHtml = fs.readFileSync(DASHBOARD_PATH, 'utf8');
    cachedMtime = st.mtimeMs;
  }
  return cachedHtml;
}

const WINDOW_LABELS = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', 'all': 'all time' };

function mapWindows(snapshots) {
  const out = {};
  for (const r of snapshots) {
    let warmByLang = {};
    try { warmByLang = JSON.parse(r.warm_by_lang_json || '{}'); } catch (e) { /* keep {} */ }
    const openRate = r.sent > 0 ? +(100 * r.opens / r.sent).toFixed(1) : 0;
    const clickRate = r.sent > 0 ? +(100 * r.clicks / r.sent).toFixed(1) : 0;
    const optoutRate = r.sent > 0 ? +(100 * r.unsubs / r.sent).toFixed(2) : 0;
    out[r.window_key] = {
      sent: r.sent, opens: r.opens, clicks: r.clicks, unsub: r.unsubs,
      open_rate: openRate, click_rate: clickRate, optout_rate: optoutRate,
      // SaaS v1 has no provider split — map everything to the ml_* fields
      // the dashboard template reads, zero the kit_* fields.
      kit_sent: 0, kit_opens: 0, kit_clicks: 0, kit_unsub: 0, kit_optout_rate: 0,
      ml_sent: r.sent, ml_opens: r.opens, ml_clicks: r.clicks, ml_unsub: r.unsubs,
      ml_bounce: r.bounces, ml_optout_rate: optoutRate,
      warm: { total: r.warm_total, by_lang: warmByLang },
      label: WINDOW_LABELS[r.window_key] || r.window_key,
    };
  }
  return out;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- serve-time transform safety net ----------------------------------------
// The dashboard template is patched per request by string/regex replacement
// (see serveApp below). If a template edit changes or removes one of the
// target strings, the corresponding feature dies SILENTLY in production.
// This section exists so that never happens quietly again.
//
// TRANSFORM_TARGETS declares every replacement target in one place. The
// startup self-check (runs automatically when this module loads, i.e. at
// server boot) verifies each target exists in the template and logs LOUDLY
// if one is missing. GET /api/transform-health exposes the same check at
// runtime. If you intentionally rename a target in the template, update the
// pattern here AND the corresponding replace() call in serveApp.
const TRANSFORM_TARGETS = [
  {
    name: 'api-base',
    kind: 'string',
    pattern: "var API_BASE = 'https://muse4.pythonanywhere.com';",
    breaks: 'Sites tab would call the wrong API origin (compat shim breaks).',
  },
  {
    name: 'sites-data',
    kind: 'regex',
    pattern: /var SITES = \[[\s\S]*?\];/,
    breaks: 'Sites tab never loads existing sites (loadSites exits on empty SITES).',
  },
  {
    name: 'email-windows',
    kind: 'regex',
    pattern: /var EMAIL_WINDOWS = \{[\s\S]*?\};/,
    breaks: 'Email range tabs (24h/7d/30d/All) do nothing; warm clickers never render.',
  },
  {
    name: 'goals-grid',
    kind: 'string',
    pattern: '<div class="stats-grid" style="grid-template-columns:repeat(3,1fr)">',
    breaks: 'Goals section shows "Loading goals…" forever (boot script cannot find its grid).',
  },
  {
    name: 'nav-right',
    kind: 'string',
    pattern: '<div class="nav-right">',
    breaks: 'Tenant chip + Setup/Leads/Log out links never injected into nav.',
  },
  {
    name: 'body-close',
    kind: 'string',
    pattern: '</body>',
    breaks: 'Boot script (goals re-render + logout handler) never injected.',
  },
  {
    name: 'i18n-loader',
    kind: 'string',
    pattern: '<script src="/js/i18n.js"></script>',
    breaks: 'i18n dictionary injection target missing; dashboard stays English-only.',
  },
];

// --- i18n (transform #7) ----------------------------------------------------
// Resolves the dashboard language per request and injects the translation
// dictionary + loader script before </head>. Dictionaries live in
// <repo>/translations/<lang>.json (876 keys each, 8 languages).
const I18N_SUPPORTED = ['en', 'es', 'fr', 'de', 'pt', 'tl', 'ro', 'id'];
const i18nDictCache = {}; // lang -> { dict, mtimeMs }

function resolveI18nLang(req) {
  const q = String((req.query && req.query.lang) || '').toLowerCase();
  if (I18N_SUPPORTED.includes(q)) return q;
  const ck = /(?:^|;\s*)manna_lang=([a-z]{2})/i.exec(req.headers.cookie || '');
  if (ck && I18N_SUPPORTED.includes(ck[1].toLowerCase())) return ck[1].toLowerCase();
  const al = String(req.headers['accept-language'] || '').slice(0, 2).toLowerCase();
  if (I18N_SUPPORTED.includes(al)) return al;
  return 'en';
}

function loadI18nDict(lang) {
  try {
    const p = path.join(__dirname, '..', 'translations', lang + '.json');
    const st = fs.statSync(p);
    const hit = i18nDictCache[lang];
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.dict;
    const dict = JSON.parse(fs.readFileSync(p, 'utf8'));
    i18nDictCache[lang] = { dict, mtimeMs: st.mtimeMs };
    return dict;
  } catch (e) { return {}; }
}

function targetMatches(html, t) {
  // NOTE: patterns carry no /g flag, so regex .test() is stateless here.
  return t.kind === 'regex' ? t.pattern.test(html) : html.includes(t.pattern);
}

// Pure check: returns [{ name, ok, breaks }] for every transform target.
// Pass an html string to check a candidate template; omit to check the live one.
function checkTransforms(html) {
  const src = html == null ? loadDashboardHtml() : html;
  return TRANSFORM_TARGETS.map(t => ({
    name: t.name,
    ok: targetMatches(src, t),
    breaks: t.breaks,
  }));
}

function logTransformReport(failures) {
  const line = '='.repeat(72);
  console.error('\n' + line);
  console.error('!! MANNA SERVE-TIME TRANSFORM CHECK FAILED !!');
  console.error(line);
  console.error('The dashboard template is MISSING serve-time replacement targets.');
  console.error('Features WILL break silently in production until this is fixed:');
  for (const f of failures) {
    console.error('  [MISSING] ' + f.name);
    console.error('            -> ' + f.breaks);
  }
  console.error('Template: ' + DASHBOARD_PATH);
  console.error('Fix: restore the target string(s) in the template, or update BOTH');
  console.error('TRANSFORM_TARGETS and the replace() call in serveApp if the rename');
  console.error('was intentional.');
  console.error(line + '\n');
}

// Startup self-check: runs once when this module is required (server boot).
// Never throws — a broken template must not prevent the server from starting
// (serveApp already 500s with a clear message); it must only be LOUD.
(function startupTransformCheck() {
  try {
    const failures = checkTransforms().filter(c => !c.ok);
    if (failures.length) {
      logTransformReport(failures);
    } else {
      console.log('[transforms] OK — all ' + TRANSFORM_TARGETS.length +
        ' serve-time replacement targets verified in template');
    }
  } catch (e) {
    const line = '='.repeat(72);
    console.error('\n' + line);
    console.error('!! MANNA SERVE-TIME TRANSFORM CHECK FAILED !!');
    console.error('Could not load dashboard template: ' + e.message);
    console.error('Template: ' + DASHBOARD_PATH);
    console.error(line + '\n');
  }
})();

function serveApp(req, res) {
  let html;
  try {
    html = loadDashboardHtml();
  } catch (e) {
    return res.status(500).send('Dashboard template unavailable.');
  }

  const tdb = req.tdb;
  const tenant = req.tenant;

  // NOTE: every replacement target below is declared in TRANSFORM_TARGETS
  // (safety-net block above). Keep them in sync — the startup self-check and
  // GET /api/transform-health verify the targets, not these replacements.

  // 1. Same-origin API for the Sites tab (compat shim in server.js).
  html = html.replace(
    "var API_BASE = 'https://muse4.pythonanywhere.com';",
    "var API_BASE = '';"
  );

  // 2. Live project list.
  const sites = tdb.listSites().map(s => ({
    key: s.site_key,
    emoji: s.emoji || '🌐',
    name: s.name,
    url: s.url || '#',
  }));
  html = html.replace(
    /var SITES = \[[\s\S]*?\];/,
    'var SITES = ' + JSON.stringify(sites) + ';'
  );

  // 3. Live email windows.
  const windows = mapWindows(tdb.emailSnapshots());
  html = html.replace(
    /var EMAIL_WINDOWS = \{[\s\S]*?\};/,
    'var EMAIL_WINDOWS = ' + JSON.stringify(windows) + ';'
  );

  // 4. Goals grid: tag it for client-side re-render from /api/goals.
  html = html.replace(
    '<div class="stats-grid" style="grid-template-columns:repeat(3,1fr)">',
    '<div class="stats-grid" id="d2rm-goals-grid" style="grid-template-columns:repeat(3,1fr)">'
  );

  // 5. Nav: tenant chip + product links.
  const chip = '<span class="live-badge" style="background:rgba(201,162,39,.15);color:var(--gold)">'
    + escHtml(tenant.name) + ' · ' + escHtml(tenant.plan) + '</span>'
    + '<a href="/onboarding" style="color:var(--gold);text-decoration:none;font-size:13px">🚀 Setup</a>'
    + '<a href="/leads" style="color:var(--gold);text-decoration:none;font-size:13px">🎯 Leads</a>'
    + '<a href="#" id="d2rm-logout" style="color:var(--text2);text-decoration:none;font-size:13px">Log out</a>';
  html = html.replace('<div class="nav-right">', '<div class="nav-right">' + chip);

  // 7. i18n: inject translation dictionary BEFORE the loader script.
  // i18n.js picks up window.__MANNA_I18N__ synchronously — no fetch race.
  const dashLang = resolveI18nLang(req);
  const dashDict = loadI18nDict(dashLang);
  const dashFallback = dashLang === 'en' ? {} : loadI18nDict('en');
  const i18nInject = '<script>window.__MANNA_I18N__='
    + JSON.stringify({ lang: dashLang, dict: dashDict, fallback: dashFallback }).replace(/</g, '\\u003c')
    + ';</script><script src="/js/i18n.js"></script>';
  html = html.replace('<script src="/js/i18n.js"></script>', i18nInject);

  // 6. Boot script: goals re-render + logout.
  // (The AI instructor panel is built into the template itself; the old
  // floating widget was removed in favor of the prominent top-of-page panel.)
  const boot = `
<script>
(function(){
  // Goals: re-render from the live tenant API (generic per-tenant cards).
  function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  fetch('/api/goals',{headers:{'X-Requested-With':'XMLHttpRequest'}}).then(function(r){return r.json();}).then(function(j){
    var grid=document.getElementById('d2rm-goals-grid'); if(!grid||!j||!j.ok) return;
    var goals=j.goals||[];
    if(!goals.length){grid.innerHTML='<div class="stat-card"><div class="stat-label">No goals yet</div><div style="font-size:13px;color:var(--text3)">Set goals to track progress here.</div></div>';return;}
    grid.innerHTML=goals.map(function(g){
      var pct=g.goal>0?Math.min(100,(100*g.current/g.goal)):0;
      return '<div class="stat-card" style="text-align:left"><div class="stat-label">'+esc(g.label)+'</div>'
        +'<div class="stat-value">'+Number(g.current).toLocaleString()+' <span style="font-size:13px;color:var(--text3)">/ '+Number(g.goal).toLocaleString()+(g.unit?' '+esc(g.unit):'')+'</span></div>'
        +'<div class="sharebar" style="height:10px;margin:8px 0 4px"><div style="width:'+pct.toFixed(1)+'%;background:var(--green)"></div></div>'
        +'<div style="font-size:11px;color:var(--text3)">'+pct.toFixed(1)+'% of goal</div></div>';
    }).join('');
  }).catch(function(){});
  // Logout
  var lo=document.getElementById('d2rm-logout');
  if(lo){lo.addEventListener('click',function(e){e.preventDefault();fetch('/api/auth/logout',{method:'POST',headers:{'X-Requested-With':'XMLHttpRequest'}}).then(function(){location.href='/login';});});}
})();
</script>
</body>`;
  html = html.replace('</body>', boot);

  res.set('Content-Type', 'text/html; charset=utf-8');
  // Looser CSP: the dashboard template is inline-script/style heavy.
  // Auth pages get the strict policy (see server.js).
  res.set('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
  res.send(html);
}

module.exports = { serveApp, mapWindows, checkTransforms, TRANSFORM_TARGETS };
