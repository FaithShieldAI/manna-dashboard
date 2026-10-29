'use strict';
/**
 * FaithShield Stripe webhook handler.
 *
 * Mounted in server.js next to the Manna billing webhook, BEFORE
 * express.json() with express.raw(), because Stripe signature verification
 * requires the exact raw request body. No auth, no CSRF — the
 * Stripe-Signature header IS the authentication.
 *
 * This is a SEPARATE endpoint from /api/billing/webhook with its OWN signing
 * secret (STRIPE_FS_WEBHOOK_SECRET). It exists because FaithShield's $8.99
 * price (STRIPE_FS_PRICE_ID, default price_1UQtKcHKZQIpdYgs) sits in the
 * shared Stripe account with no consumer: the Manna billing webhook only
 * maps Manna tenant prices and drops everything else. Here, FaithShield
 * subscription state is tracked in faithshield_subscriptions (migration
 * 020) and fed into the D2RM 'faithshield' goal counter
 * (FaithShield paying users / 100) — see src/lib/faithshieldSubs.js.
 *
 * FAIL CLOSED: when STRIPE_FS_WEBHOOK_SECRET is unset (or Stripe itself is
 * unconfigured) the handler returns 503 and processes nothing. Invalid
 * signatures get a 400; we never process unsigned events.
 *
 * Events handled (ONLY when the subscription's price matches FaithShield):
 *   checkout.session.completed    -> upsert subscription state
 *   customer.subscription.updated -> upsert subscription state
 *   customer.subscription.deleted -> upsert with status 'canceled'
 * After each handled event the goal counter is recomputed from the table.
 * Events for any other price (e.g. Manna plans) are acknowledged and
 * ignored — the billing webhook owns those.
 */
const stripeLib = require('../lib/stripe');
const fsSubs = require('../lib/faithshieldSubs');
const { db } = require('../db');

function customerIdOf(obj) {
  if (!obj) return null;
  if (typeof obj.customer === 'string') return obj.customer;
  if (obj.customer && obj.customer.id) return obj.customer.id;
  return null;
}

/** Track one matched subscription, then refresh the goal counter. */
function trackSubscription(subscription, { forceCanceled = false } = {}) {
  fsSubs.upsertFaithshieldSubscription(db, {
    customerId: customerIdOf(subscription),
    subscriptionId: subscription.id,
    status: forceCanceled ? (subscription.status || 'canceled') : subscription.status,
    currentPeriodEnd: fsSubs.periodEndIso(subscription),
  });
  return fsSubs.resyncFaithshieldGoal(db);
}

async function webhookHandler(req, res) {
  const stripe = stripeLib.getStripe();
  // Dedicated secret for THIS endpoint — never fall back to the billing
  // webhook's secret. Unset means "not configured": fail closed.
  const secret = process.env.STRIPE_FS_WEBHOOK_SECRET || null;
  if (!stripe || !secret) {
    return res.status(503).json({ ok: false, error: 'stripe_not_configured' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[fs-webhook] signature verification failed:', e.message);
    return res.status(400).json({ ok: false, error: 'invalid_signature' });
  }

  try {
    let tracked = false;
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        // The subscription arrives as an ID (normal case — retrieve it to
        // get price + status) or, when the event was created with
        // expansions, as a full object (use it directly).
        let subscription = null;
        if (session.subscription && typeof session.subscription === 'object') {
          subscription = session.subscription;
        } else if (session.subscription) {
          subscription = await stripe.subscriptions.retrieve(session.subscription);
        }
        if (subscription && fsSubs.matchesFaithshield(subscription)) {
          trackSubscription(subscription);
          tracked = true;
        }
        break;
      }
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        if (fsSubs.matchesFaithshield(subscription)) {
          trackSubscription(subscription);
          tracked = true;
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        if (fsSubs.matchesFaithshield(subscription)) {
          trackSubscription(subscription, { forceCanceled: true });
          tracked = true;
        }
        break;
      }
      default:
        // Unhandled event type — acknowledge so Stripe doesn't retry.
        break;
    }
    res.json({ ok: true, received: event.type, tracked });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[fs-webhook] handler error:', e.message);
    // Return 500 so Stripe retries; the event wasn't applied.
    res.status(500).json({ ok: false, error: 'handler_failed' });
  }
}

module.exports = webhookHandler;
// Manual resync entry point: recompute the 'faithshield' goal counter from
// faithshield_subscriptions without waiting for a webhook event.
module.exports.resyncFaithshieldGoal = () => fsSubs.resyncFaithshieldGoal(db);
