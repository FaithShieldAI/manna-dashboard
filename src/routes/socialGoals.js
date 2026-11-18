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
  // Goal values are resolved at READ time by src/lib/goalValues.js:
  // a goal reports a number only when the app's own data can measure
  // it today (email_collection from the tenant's live lead count,
  // faithshield from faithshield_subscriptions, mannaai from the
  // users table). Goals with no live source (armor_bearer, k_punk,
  // two_fishes) come back with current null and live_feed false, and
  // the Overview renders them as targets with a "No live feed" label.
  // The stored current_value rows froze at seed time (identical in
  // every tenant) and are never served as measurements again.
  const { presentGoals } = require('../lib/goalValues');
  res.json({ ok: true, goals: presentGoals(req.tdb) });
});

module.exports = { social, goals };
