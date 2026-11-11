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
  // email_collection is a live count, not a stored counter: its stored
  // current_value froze at the 2026-10 D2RM import (1,578) while the
  // tenant's book kept growing. Override it at READ time with the same
  // live lead count the Overview's "Emails collected" card uses
  // (tdb.leadTotal); the stored row is left untouched.
  const liveCollected = req.tdb.leadTotal();
  const list = req.tdb.goals().map(g => {
    const current = g.goal_key === 'email_collection' ? liveCollected : g.current_value;
    return {
      key: g.goal_key,
      label: g.label,
      current,
      goal: g.goal_value,
      unit: g.unit,
      pct: g.goal_value > 0 ? +(100 * current / g.goal_value).toFixed(1) : 0,
    };
  });
  res.json({ ok: true, goals: list });
});

module.exports = { social, goals };
