'use strict';
/**
 * Goal values: which of the seeded portfolio goals have a live source
 * in the app's own data, and what each source reads.
 *
 * The finding (red-team walk, 2026-11-18): seedDemoData plants the
 * same goal set into every tenant with current_values frozen at seed
 * time (armor_bearer 3, k_punk 1, mannaai 0, identical across tenants
 * 1, 2, 3, 6, and 7 in the production snapshot), and the Overview
 * rendered those stored numbers as if they were measurements. Only
 * email_collection was ever overridden at read time.
 *
 * The rule now: a goal reports a number only when the app's own data
 * can measure it today, read at request time, never the stored row.
 *
 *   email_collection — the tenant's own live lead count
 *     (tdb.leadTotal), the pre-existing override.
 *   faithshield — paying FaithShield users: rows in
 *     faithshield_subscriptions with status active or trialing,
 *     counted by src/lib/faithshieldSubs.js (the table the Stripe
 *     webhook keeps current). Platform-wide by nature: the goal is
 *     the house's FaithShield user target, not one tenant's slice.
 *   mannaai — MannaAi users: the count of user accounts in the app
 *     (the users table). Platform-wide for the same reason.
 *
 * The remaining seeded goals have no live source in the app's data:
 *
 *   armor_bearer — affiliates live in the separate Armor Bearer app;
 *     Manna holds no affiliate table and nothing syncs one in.
 *   k_punk — notify-me signups are collected by the Netlify form on
 *     the K-Punk landing page; Manna holds no row for them (the
 *     stored 1 came from the form's CSV export).
 *   two_fishes — households cannot exist yet: the product's deploy
 *     is held and its billing is off, and Manna holds no household
 *     table.
 *
 * Those goals are presented as targets with live_feed false and
 * current null, and the Overview renders them as a target with a
 * "No live feed" label instead of a measured count. The stored
 * current_value rows are left untouched; nothing here writes goals.
 */
const { db } = require('../db');
const { countFaithshieldPaying } = require('./faithshieldSubs');

const LIVE_FEED_KEYS = new Set(['email_collection', 'faithshield', 'mannaai']);

function hasLiveFeed(goalKey) {
  return LIVE_FEED_KEYS.has(goalKey);
}

/** Live current value for a goal, or null when it has no live feed. */
function goalCurrent(goalKey, tdb) {
  switch (goalKey) {
    case 'email_collection':
      return tdb.leadTotal();
    case 'faithshield':
      return countFaithshieldPaying(db);
    case 'mannaai': {
      const row = db.prepare('SELECT COUNT(*) AS n FROM users').get();
      return row ? row.n : 0;
    }
    default:
      return null;
  }
}

/**
 * The tenant's goals in the GET /api/goals and GET /api/overview
 * shape: live goals carry their read-time value; goals without a
 * live feed carry current null and live_feed false.
 */
function presentGoals(tdb) {
  return tdb.goals().map(g => {
    const live = hasLiveFeed(g.goal_key);
    const current = live ? goalCurrent(g.goal_key, tdb) : null;
    return {
      key: g.goal_key,
      label: g.label,
      current,
      goal: g.goal_value,
      unit: g.unit,
      pct: live && g.goal_value > 0 ? +(100 * current / g.goal_value).toFixed(1) : 0,
      live_feed: live,
    };
  });
}

module.exports = { presentGoals, goalCurrent, hasLiveFeed, LIVE_FEED_KEYS };
