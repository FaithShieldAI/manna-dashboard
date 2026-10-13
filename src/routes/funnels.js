'use strict';
/**
 * Funnels API — conversion funnels with stage goals.
 * GET /api/funnels   (now with cost/revenue/ROI per funnel)
 */
const express = require('express');
const { roi } = require('../lib/roi');

const router = express.Router();

router.get('/', (req, res) => {
  const funnels = req.tdb.funnels().map(f => ({
    key: f.funnel_key,
    name: f.name,
    emoji: f.emoji,
    subtitle: f.subtitle,
    ...roi(f.cost_cents, f.revenue_cents),
    stages: f.stages.map(s => ({
      key: s.stage_key,
      label: s.label,
      current: s.current_value,
      goal: s.goal_value,
      pct: s.goal_value > 0 ? +(100 * s.current_value / s.goal_value).toFixed(1) : null,
    })),
  }));
  res.json({ ok: true, funnels });
});

module.exports = router;
