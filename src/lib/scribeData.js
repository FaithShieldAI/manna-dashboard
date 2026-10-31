'use strict';
/**
 * Scribe data-read layer.
 *
 * Pulls exactly the numbers Scribe reasons from — nothing else — through
 * the tenant-scoped query handle (req.tdb), so Scribe can only ever see
 * the calling tenant's rows. READ-ONLY: no writes, no sends, no posts.
 *
 * Output is a plain JSON-able "signals" object. Every number Scribe later
 * cites in an observation comes from here, which is what makes its
 * observations checkable against the dashboard.
 *
 * "Trending" note: there is no external trend feed connected to Manna.
 * Trending signals are DERIVED from data Manna already holds — recent
 * lead-collection intake by category and the tenant's own top-performing
 * videos/posts — and are labelled as derived, with their evidence. When
 * there is no underlying data, trending.available is false rather than
 * a fabricated trend list.
 */

function rate(n, d) {
  return d > 0 ? +((100 * n / d).toFixed(1)) : 0;
}

function engagementOf(v) {
  return (Number(v.likes) || 0) + (Number(v.comments) || 0) + (Number(v.shares) || 0);
}

/**
 * @param {object} tdb tenant-scoped handle from db.forTenant()
 * @returns signals object (see header). Sections degrade to empty/null
 *          individually if a table has no rows yet — never throws on
 *          missing data.
 */
function collectSignals(tdb) {
  const signals = {
    generated_at: new Date().toISOString(),
    email: null,
    content: { top_videos: [], recent_postings: [], top_posts: [] },
    library: { films_total: 0, films: [] },
    trending: { available: false, source: null, signals: [] },
    social: [],
    goals: [],
  };

  // --- email: sends / opens / clicks (snapshots + per-campaign) --------
  try {
    const snaps = tdb.emailSnapshots();
    const windows = {};
    for (const s of snaps) {
      windows[s.window_key] = {
        sent: s.sent || 0, opens: s.opens || 0, clicks: s.clicks || 0,
        unsubs: s.unsubs || 0, bounces: s.bounces || 0,
        open_rate: rate(s.opens, s.sent), click_rate: rate(s.clicks, s.sent),
      };
    }
    const campaigns = tdb.emailCampaigns(50).map(c => ({
      name: c.name, product: c.product || null, language: c.language || null,
      audience: c.audience || null, provider: c.provider || null,
      sent: c.sent || 0, opens: c.opens || 0, clicks: c.clicks || 0,
      open_rate: rate(c.opens, c.sent), click_rate: rate(c.clicks, c.sent),
      sent_at: c.sent_at || null,
    }));
    const topCampaigns = [...campaigns]
      .filter(c => c.sent > 0)
      .sort((a, b) => (b.clicks - a.clicks) || (b.opens - a.opens))
      .slice(0, 5);
    signals.email = { windows, campaigns_total: campaigns.length, top_campaigns: topCampaigns };
  } catch (e) { /* keep null */ }

  // --- content performance: videos + social postings -------------------
  try {
    const videos = tdb.videoPostings(50).map(v => ({
      video_name: v.video_name, product: v.product, platform: v.platform,
      account_handle: v.account_handle || null, posted_at: v.posted_at,
      views: v.views || 0, likes: v.likes || 0, comments: v.comments || 0,
      shares: v.shares || 0, engagement: engagementOf(v),
    }));
    signals.content.top_videos = [...videos]
      .sort((a, b) => (b.views - a.views) || (b.engagement - a.engagement))
      .slice(0, 5);
    signals.content.recent_postings = videos.slice(0, 5);
  } catch (e) { /* keep empty */ }
  try {
    const posts = tdb.socialPostings(50).map(p => ({
      platform: p.platform, post_url: p.post_url, posted_at: p.posted_at,
      likes: p.likes || 0, shares: p.shares || 0, comments: p.comments || 0,
      clicks: p.clicks || 0, engagement: engagementOf(p) + (p.clicks || 0),
    }));
    signals.content.top_posts = [...posts]
      .sort((a, b) => b.engagement - a.engagement)
      .slice(0, 5);
  } catch (e) { /* keep empty */ }

  // --- content library: the films themselves (Michael, 2026-10-31) -----
  // Scribe watches the library, not just postings: a film counts before
  // it is ever posted (posts: 0), and once postings link back through
  // social_postings.content_item_id, their numbers roll up to the film,
  // so Scribe can say which FILM is working and direct what comes next.
  try {
    const films = tdb.libraryFilms(50).map(f => ({
      title: f.title, product: f.product, category: f.category,
      language: f.language, views: f.view_count || 0,
      score: f.performance_score == null ? null : f.performance_score,
      posts: f.posts || 0, clicks: f.post_clicks || 0,
      likes: f.post_likes || 0, shares: f.post_shares || 0,
      comments: f.post_comments || 0,
      engagement: (f.post_likes || 0) + (f.post_shares || 0) +
        (f.post_comments || 0) + (f.post_clicks || 0),
    }));
    signals.library = {
      films_total: films.length,
      films: [...films].sort((a, b) => b.engagement - a.engagement).slice(0, 10),
    };
  } catch (e) { /* keep empty */ }

  // --- social accounts + goals -----------------------------------------
  try {
    signals.social = tdb.socialAccounts().map(a => ({
      platform: a.platform, handle: a.handle,
      followers: a.followers || 0, posts: a.posts || 0,
    }));
  } catch (e) { /* keep [] */ }
  try {
    signals.goals = tdb.goals().map(g => ({
      label: g.label, current: g.current_value, goal: g.goal_value,
      pct: g.goal_value > 0 ? +((100 * g.current_value / g.goal_value).toFixed(1)) : 0,
    }));
  } catch (e) { /* keep [] */ }

  // --- trending (derived; labelled as such) -----------------------------
  const trendSignals = [];
  try {
    const intake = tdb.intakeDaily(14);
    const byCategory = {};
    for (const r of intake) {
      byCategory[r.category] = (byCategory[r.category] || 0) + (r.new_count || 0);
    }
    const cats = Object.entries(byCategory)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    for (const [category, n] of cats.slice(0, 3)) {
      trendSignals.push({
        signal: `Lead intake is concentrated in "${category}"`,
        evidence: `${n} new ${category} contacts collected in the last 14 days`,
        source: 'intake_daily',
      });
    }
  } catch (e) { /* no intake data */ }
  if (signals.content.top_videos.length) {
    const top = signals.content.top_videos[0];
    if (top.views > 0) {
      trendSignals.push({
        signal: `Top-performing video format: "${top.video_name}" on ${top.platform}`,
        evidence: `${top.views} views, ${top.engagement} engagements — the tenant's best video on record`,
        source: 'video_postings',
      });
    }
  }
  const libTop = (signals.library.films || []).find(f => f.posts > 0 && f.engagement > 0);
  if (libTop) {
    trendSignals.push({
      signal: `Top library film: "${libTop.title}"`,
      evidence: `${libTop.engagement} engagements across ${libTop.posts} posting(s) — clicks ${libTop.clicks}, likes ${libTop.likes}, shares ${libTop.shares}, comments ${libTop.comments}`,
      source: 'content_items',
    });
  }
  if (trendSignals.length) {
    signals.trending = {
      available: true,
      source: 'derived from Manna data (collection intake + own content performance); no external trend feed connected',
      signals: trendSignals,
    };
  }

  return signals;
}

/**
 * Flatten a signals object into a label -> [values] map of EVERY number
 * Scribe could legitimately cite: each numeric leaf is registered under
 * its leaf name ('sent'), its dotted path ('email.windows.all.sent'), and
 * the index-free path ('content.top_videos.views'), so a citation verifies
 * if the number exists anywhere in the tenant's data under that label.
 * Rates are also citable with a '_pct' suffix. Two derived labels Scribe
 * uses are added explicitly (top video, trending-signal count). When the
 * tenant has no email snapshots at all, the email totals are genuinely
 * zero and are registered as such. Used by scribe.verifyCitations (F2):
 * a cited number that is not in this map — or does not match — is
 * fabrication, and the advice carrying it is rejected whole.
 */
function metricMap(signals) {
  const map = new Map();
  const add = (label, value) => {
    if (!label || typeof value !== 'number' || !Number.isFinite(value)) return;
    const arr = map.get(label);
    if (arr) arr.push(value); else map.set(label, [value]);
  };
  const walk = (node, path) => {
    if (typeof node === 'number') {
      add([...path].reverse().find(s => !/^\d+$/.test(s)), node);
      add(path.join('.'), node);
      add(path.filter(s => !/^\d+$/.test(s)).join('.'), node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, [...path, String(i)]));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
    }
  };
  walk(signals || {}, []);
  for (const [a, b] of [['open_rate', 'open_rate_pct'], ['click_rate', 'click_rate_pct']]) {
    if (map.has(a) && !map.has(b)) map.set(b, [...map.get(a)]);
    if (map.has(b) && !map.has(a)) map.set(a, [...map.get(b)]);
  }
  const content = (signals && signals.content) || {};
  const top = Array.isArray(content.top_videos) ? content.top_videos[0] : null;
  if (top) {
    add('top_video_views', top.views);
    add('top_video_engagement', top.engagement);
  }
  if (signals && signals.trending && Array.isArray(signals.trending.signals)) {
    add('trending_signals', signals.trending.signals.length);
  }
  const windows = signals && signals.email ? signals.email.windows : null;
  if (!windows || Object.keys(windows).length === 0) {
    // No email snapshot windows at all: the tenant's email totals are
    // genuinely zero (this is what lets the stub's zero-citation verify
    // for a brand-new tenant instead of failing label-existence).
    for (const k of ['sent', 'opens', 'clicks', 'open_rate', 'open_rate_pct', 'click_rate', 'click_rate_pct']) {
      add(k, 0);
    }
  }
  return map;
}

module.exports = { collectSignals, metricMap };
