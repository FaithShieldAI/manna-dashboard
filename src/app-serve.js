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
 *   6. Assistant chat widget injected before </body>
 *
 * Source file: DASHBOARD_HTML_PATH or ~/workspace/your_files/d2rm-live-dashboard.html
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DASHBOARD_PATH = process.env.DASHBOARD_HTML_PATH
  || path.join(os.homedir(), 'workspace', 'your_files', 'd2rm-live-dashboard.html');

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

function serveApp(req, res) {
  let html;
  try {
    html = loadDashboardHtml();
  } catch (e) {
    return res.status(500).send('Dashboard template unavailable.');
  }

  const tdb = req.tdb;
  const tenant = req.tenant;

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

  // 6. Boot script: goals re-render + logout + assistant widget.
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
<link rel="stylesheet" href="/css/auth.css">
<button id="d2rm-assistant-fab" title="Ask the marketing co-pilot">💬</button>
<div id="d2rm-assistant-panel" role="dialog" aria-label="Marketing co-pilot">
  <div id="d2rm-assistant-head"><span>🤖 Marketing co-pilot</span><span class="prov" id="d2rm-assistant-prov"></span></div>
  <div id="d2rm-assistant-msgs"></div>
  <form id="d2rm-assistant-form"><input id="d2rm-assistant-input" type="text" placeholder="Ask about your data, or &quot;what should I do next?&quot;" maxlength="2000" autocomplete="off"><button type="submit">Send</button></form>
</div>
<script src="/js/assistant-widget.js"></script>
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

module.exports = { serveApp, mapWindows };
