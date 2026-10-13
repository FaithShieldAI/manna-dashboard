'use strict';
/**
 * Social + Goals APIs.
 * GET /api/social
 * GET /api/goals
 */
const express = require('express');

const social = express.Router();
social.get('/', (req, res) => {
  res.json({ ok: true, accounts: req.tdb.socialAccounts() });
});

const goals = express.Router();
goals.get('/', (req, res) => {
  const list = req.tdb.goals().map(g => ({
    key: g.goal_key,
    label: g.label,
    current: g.current_value,
    goal: g.goal_value,
    unit: g.unit,
    pct: g.goal_value > 0 ? +(100 * g.current_value / g.goal_value).toFixed(1) : 0,
  }));
  res.json({ ok: true, goals: list });
});

module.exports = { social, goals };
