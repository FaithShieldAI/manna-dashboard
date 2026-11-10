'use strict';
/**
 * House tracker client (muse4.pythonanywhere.com).
 *
 * The dashboard's Visits view has always said "live from tracker" (see
 * dash.js.sites.card_sub): the PythonAnywhere tracker is the source of
 * record for house-site analytics. Manna's own site_daily_metrics /
 * site_events tables were the wrong source — nothing populates
 * site_daily_metrics at all, and house sites beacon to the tracker, not
 * to Manna's /api/collect. These helpers fetch the tracker's
 * /api/stats | /api/realtime | /api/breakdown and map the responses into
 * the JSON shape Manna's sites endpoints have always returned.
 *
 * Failure contract (Michael's LIVE MEANS LIVE rule, 2026-11-10): a
 * network error, timeout, 5xx or unparseable body throws TrackerDown and
 * callers turn that into a 502, so the UI renders a plain "feed down"
 * state instead of zeros — a broken feed and a true zero must never look
 * alike. The one non-failure negative answer is the tracker's
 * 400 {"error":"unknown site"}: the tracker is up and has simply never
 * heard of the site. Callers map that to an honest empty result
 * (nothing recorded), not an error.
 *
 * Base URL override (tests): TRACKER_BASE_URL, read per call.
 */
const DEFAULT_BASE = 'https://muse4.pythonanywhere.com';
const TIMEOUT_MS = 15000;

class TrackerDown extends Error {
  constructor(message) {
    super(message);
    this.name = 'TrackerDown';
  }
}

function base() {
  return (process.env.TRACKER_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
}

async function trackerGet(pathname, params) {
  const qs = new URLSearchParams(params).toString();
  let res;
  try {
    res = await fetch(`${base()}${pathname}?${qs}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new TrackerDown(`tracker fetch failed: ${e && e.message ? e.message : e}`);
  }
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON: handled below */ }
  if (res.status === 400 && body && body.error === 'unknown site') {
    return { unknownSite: true };
  }
  if (!res.ok || !body || body.ok !== true) {
    throw new TrackerDown(`tracker answered HTTP ${res.status}`);
  }
  return body;
}

function metric(m, key) {
  const v = (m && m[key]) || {};
  return { value: v.value ?? null, change_pct: v.change_pct ?? null };
}

function emptyStats(siteKey, days) {
  return {
    ok: true, site: siteKey, days,
    metrics: {
      visitors: { value: 0, change_pct: null },
      views: { value: 0, change_pct: null },
      bounce_rate: { value: null, change_pct: null },
      avg_duration_s: { value: null, change_pct: null },
    },
    daily: [],
  };
}

// GET tracker /api/stats -> Manna stats shape. (`daily` stays []: the
// tracker's stats endpoint exposes no daily series, and the dashboard
// template does not render one — no series is invented here.)
async function fetchStats(siteKey, days) {
  const j = await trackerGet('/api/stats', { site: siteKey, days });
  if (j.unknownSite) return emptyStats(siteKey, days);
  const m = j.metrics || {};
  return {
    ok: true, site: siteKey, days,
    metrics: {
      visitors: metric(m, 'visitors'),
      views: metric(m, 'views'),
      bounce_rate: metric(m, 'bounce_rate'),
      avg_duration_s: metric(m, 'avg_duration_s'),
    },
    daily: [],
  };
}

// GET tracker /api/realtime -> { active_now }. unknownSite is flagged so
// callers can fall back to Manna-beacon actives for Manna-native sites.
async function fetchRealtime(siteKey) {
  const j = await trackerGet('/api/realtime', { site: siteKey });
  if (j.unknownSite) return { unknownSite: true, active_now: 0 };
  return { unknownSite: false, active_now: j.active_now || 0 };
}

function labelCounts(a) {
  if (!Array.isArray(a)) return [];
  return a.map(x => ({ label: x.label, count: x.count }));
}

function emptyBreakdown(siteKey, days) {
  return {
    ok: true, site: siteKey, days,
    events: [], countries: [], referrers: [],
    utm_sources: [], utm_campaigns: [], devices: [],
  };
}

// GET tracker /api/breakdown -> Manna breakdown shape, with the tracker's
// real countries / referrers / utm arrays (previously hardcoded []).
async function fetchBreakdown(siteKey, days) {
  const j = await trackerGet('/api/breakdown', { site: siteKey, days });
  if (j.unknownSite) return emptyBreakdown(siteKey, days);
  return {
    ok: true, site: siteKey, days,
    events: labelCounts(j.events),
    countries: labelCounts(j.countries),
    referrers: labelCounts(j.referrers),
    utm_sources: labelCounts(j.utm_sources),
    utm_campaigns: labelCounts(j.utm_campaigns),
    devices: labelCounts(j.devices),
  };
}

// Shared route tail: TrackerDown -> 502 tracker_unavailable (the UI's
// feed-down state keys on it); anything else is a plain server error.
function sendTrackerError(res, e, tag) {
  if (e instanceof TrackerDown) {
    return res.status(502).json({ ok: false, error: 'tracker_unavailable' });
  }
  // eslint-disable-next-line no-console
  console.error(tag || '[tracker]', e);
  return res.status(500).json({ ok: false, error: 'server_error' });
}

module.exports = {
  TrackerDown,
  fetchStats,
  fetchRealtime,
  fetchBreakdown,
  sendTrackerError,
};
