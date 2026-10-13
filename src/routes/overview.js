'use strict';
/**
 * GET /api/overview — stat cards + top-level goals for the Overview tab.
 * Phase 2: adds an ROI rollup across funnels + email campaigns.
 */
const express = require('express');
const { rollup } = require('../lib/roi');

const router = express.Router();

router.get('/', (req, res) => {
  const tdb = req.tdb;
  const goals = tdb.goals();
  const snapshots = tdb.emailSnapshots();
  const all = snapshots.find(s => s.window_key === 'all') || {};
  const sites = tdb.listSites();
  const social = tdb.socialAccounts();
  const influencerCounts = tdb.influencerCategoryCounts();
  const ipCount = tdb.ipAssets().length;

  // ROI rollup: funnels + campaigns together.
  const funnelRows = tdb.funnels();
  const campaignRows = tdb.emailCampaigns(200);
  const roiTotal = rollup([
    ...funnelRows.map(f => ({ cost_cents: f.cost_cents, revenue_cents: f.revenue_cents })),
    ...campaignRows.map(c => ({ cost_cents: c.cost_cents, revenue_cents: c.revenue_cents })),
  ]);

  res.json({
    ok: true,
    goals: goals.map(g => ({
      key: g.goal_key,
      label: g.label,
      current: g.current_value,
      goal: g.goal_value,
      unit: g.unit,
      pct: g.goal_value > 0 ? +(100 * g.current_value / g.goal_value).toFixed(1) : 0,
    })),
    email: {
      sent: all.sent || 0,
      opens: all.opens || 0,
      clicks: all.clicks || 0,
      openRate: all.sent ? +((100 * all.opens / all.sent).toFixed(1)) : 0,
      clickRate: all.sent ? +((100 * all.clicks / all.sent).toFixed(1)) : 0,
      warmTotal: all.warm_total || 0,
    },
    roi: roiTotal,
    counts: {
      sites: sites.length,
      socialAccounts: social.length,
      ipAssets: ipCount,
      influencers: influencerCounts.reduce((a, c) => a + c.n, 0),
      influencersByCategory: Object.fromEntries(influencerCounts.map(c => [c.category, c.n])),
    },
  });
});

module.exports = router;
