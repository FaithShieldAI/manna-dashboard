'use strict';
/**
 * Stripe client wrapper.
 *
 * Returns null from getStripe() when STRIPE_SECRET_KEY is not set, so
 * billing routes degrade gracefully (checkout endpoints return
 * stripe_not_configured instead of crashing).
 *
 * Price IDs come from env vars — never from client input:
 *   STRIPE_PRICE_STARTER  -> plans.js 'starter'
 *   STRIPE_PRICE_PRO      -> plans.js 'pro'
 * ('agency' is invite-only and can never be purchased self-serve.)
 */

let stripeInstance = null;

function getStripe() {
  if (stripeInstance) return stripeInstance;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  stripeInstance = require('stripe')(key);
  return stripeInstance;
}

function isConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function webhookSecret() {
  return process.env.STRIPE_WEBHOOK_SECRET || null;
}

/** Map a Stripe price ID back to our plan key. Returns null if unknown. */
function planForPriceId(priceId) {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_STARTER) return 'starter';
  if (priceId === process.env.STRIPE_PRICE_PRO) return 'pro';
  return null;
}

/** Our plan key -> configured Stripe price ID. Null if unconfigured. */
function priceIdForPlan(planKey) {
  if (planKey === 'starter') return process.env.STRIPE_PRICE_STARTER || null;
  if (planKey === 'pro') return process.env.STRIPE_PRICE_PRO || null;
  return null; // agency and anything else: not purchasable self-serve
}

module.exports = { getStripe, isConfigured, webhookSecret, planForPriceId, priceIdForPlan };
