'use strict';
/**
 * Funnels API — conversion funnels with stage goals.
 * GET /api/funnels   (now with cost/revenue/ROI per funnel)
 * POST /api/funnels  create a funnel with stages
 */
const express = require('express');
const { roi } = require('../lib/roi');
const { transaction } = require('../db');

const FUNNEL_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

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

// POST /api/funnels — create a funnel with stages.
// Body: { funnelKey, name, emoji?, subtitle?, stages: [{ stageKey?, label, goalValue? }] }
router.post('/', (req, res) => {
  const { funnelKey, name, emoji, subtitle, stages } = req.body || {};

  const key = typeof funnelKey === 'string' ? funnelKey.trim().toLowerCase() : '';
  if (!FUNNEL_KEY_RE.test(key)) {
    return res.status(400).json({ ok: false, error: 'invalid_funnel_key' });
  }
  if (!name || typeof name !== 'string' || name.trim().length < 2 || name.length > 120) {
    return res.status(400).json({ ok: false, error: 'invalid_funnel_name' });
  }
  if (!Array.isArray(stages) || stages.length < 1 || stages.length > 12) {
    return res.status(400).json({ ok: false, error: 'invalid_stages' });
  }
  const cleanStages = [];
  const seen = new Set();
  for (const s of stages) {
    const label = s && typeof s.label === 'string' ? s.label.trim() : '';
    if (label.length < 1 || label.length > 80) {
      return res.status(400).json({ ok: false, error: 'invalid_stage_label' });
    }
    let sk = s.stageKey && typeof s.stageKey === 'string' ? s.stageKey.trim().toLowerCase() : '';
    if (!FUNNEL_KEY_RE.test(sk)) {
      sk = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
      if (!sk) sk = 'stage-' + (cleanStages.length + 1);
    }
    if (seen.has(sk)) {
      return res.status(400).json({ ok: false, error: 'duplicate_stage_key' });
    }
    seen.add(sk);
    let gv = null;
    if (s.goalValue !== undefined && s.goalValue !== null && s.goalValue !== '') {
      gv = Number(s.goalValue);
      if (!Number.isFinite(gv) || gv < 0 || gv > 1e12) {
        return res.status(400).json({ ok: false, error: 'invalid_stage_goal' });
      }
    }
    cleanStages.push({ stageKey: sk, label, goalValue: gv });
  }
  if (req.tdb.getFunnel(key)) {
    return res.status(409).json({ ok: false, error: 'funnel_key_taken' });
  }

  try {
    const funnelId = transaction(() => req.tdb.createFunnel({
      funnelKey: key,
      name: name.trim(),
      emoji: typeof emoji === 'string' ? emoji.trim().slice(0, 8) : null,
      subtitle: typeof subtitle === 'string' ? subtitle.trim().slice(0, 200) : null,
      stages: cleanStages,
    }));
    res.status(201).json({ ok: true, funnel_id: Number(funnelId), funnel_key: key });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[funnels/create]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
