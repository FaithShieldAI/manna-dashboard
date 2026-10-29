'use strict';
/**
 * FaithShield subscription tracking — data layer.
 *
 * FaithShield's $8.99 Stripe price lives in the shared D2RM Stripe account,
 * but nothing sells it on the web (real FaithShield sales are Apple/Google
 * IAP) and, until now, nothing listened for its events. The one meaningful
 * consumer is subscription-STATE tracking: rows in faithshield_subscriptions
 * (migration 021) feed the D2RM goal counter
 *   { goal_key: 'faithshield', label: 'FaithShield paying users',
 *     goal_value: 100 }
 * that src/lib/syncD2rm.js seeds into the owner tenant's goals — a counter
 * that used to be hand-updated and sat at 0.
 *
 * The HTTP/signature half lives in src/routes/faithshieldWebhook.js; this
 * module is pure DB logic so it can be unit-tested and reused by a manual
 * resync (see resyncFaithshieldGoal, exported for exactly that).
 *
 * Price identification is server-side only: STRIPE_FS_PRICE_ID env var,
 * defaulting to the known live FaithShield price. Never trust client input.
 */

const DEFAULT_FS_PRICE_ID = 'price_1UQtKcHKZQIpdYgs';

/** The Stripe price ID that identifies a FaithShield subscription. */
function fsPriceId() {
  return process.env.STRIPE_FS_PRICE_ID || DEFAULT_FS_PRICE_ID;
}

/** All price IDs on a Stripe subscription object (one per item). */
function subscriptionPriceIds(subscription) {
  if (!subscription || !subscription.items || !Array.isArray(subscription.items.data)) {
    return [];
  }
  return subscription.items.data
    .map(item => item && item.price && item.price.id)
    .filter(Boolean);
}

/** True when any item on the subscription is priced as FaithShield. */
function matchesFaithshield(subscription) {
  return subscriptionPriceIds(subscription).includes(fsPriceId());
}

/**
 * current_period_end as an ISO string. Older Stripe API versions put it on
 * the subscription; newer ones put it on the first item. Accept either, and
 * accept a unix-seconds number or an already-ISO string. Null when absent.
 */
function periodEndIso(subscription) {
  if (!subscription) return null;
  let raw = subscription.current_period_end;
  if (raw == null && subscription.items && Array.isArray(subscription.items.data)
      && subscription.items.data[0]) {
    raw = subscription.items.data[0].current_period_end;
  }
  if (raw == null) return null;
  if (typeof raw === 'number') {
    return new Date(raw * 1000).toISOString();
  }
  return String(raw);
}

/**
 * Insert or update the tracking row for one FaithShield subscription.
 * Keyed on stripe_subscription_id (UNIQUE). Returns the stored row.
 */
function upsertFaithshieldSubscription(db, { customerId, subscriptionId, status, currentPeriodEnd }) {
  if (!subscriptionId) return null;
  db.prepare(`
    INSERT INTO faithshield_subscriptions
      (stripe_customer_id, stripe_subscription_id, status, current_period_end)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (stripe_subscription_id) DO UPDATE SET
      stripe_customer_id = excluded.stripe_customer_id,
      status = excluded.status,
      current_period_end = excluded.current_period_end,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(customerId || null, subscriptionId, status || '', currentPeriodEnd || null);
  return db.prepare(
    'SELECT * FROM faithshield_subscriptions WHERE stripe_subscription_id = ?'
  ).get(subscriptionId);
}

/** Paying FaithShield users = subscriptions active or in trial. */
function countFaithshieldPaying(db) {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM faithshield_subscriptions
     WHERE status IN ('active', 'trialing')`
  ).get();
  return row ? row.n : 0;
}

/**
 * Recompute the paying-user count from faithshield_subscriptions and write
 * it as current_value on every 'faithshield' goal row (syncD2rm seeds that
 * goal into the D2RM owner tenant only, so in practice this is one row).
 * Called after each handled webhook event; also exported for a manual
 * resync (e.g. after seeding rows by hand or repairing drift).
 * Returns { count, rowsUpdated }.
 */
function resyncFaithshieldGoal(db) {
  const count = countFaithshieldPaying(db);
  const info = db.prepare(
    `UPDATE goals SET current_value = ? WHERE goal_key = 'faithshield'`
  ).run(count);
  return { count, rowsUpdated: info.changes };
}

module.exports = {
  DEFAULT_FS_PRICE_ID,
  fsPriceId,
  subscriptionPriceIds,
  matchesFaithshield,
  periodEndIso,
  upsertFaithshieldSubscription,
  countFaithshieldPaying,
  resyncFaithshieldGoal,
};
