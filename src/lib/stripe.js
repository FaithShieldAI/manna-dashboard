'use strict';
/**
 * Stripe client wrapper.
 *
 * Returns null from getStripe() when STRIPE_SECRET_KEY is not set, so
 * billing routes degrade gracefully (checkout endpoints return
 * stripe_not_configured instead of crashing).
 *
 * Price IDs come from env vars — never from client input:
 *   STRIPE_PRICE_STARTER (+ _SALE)  -> plans.js 'starter' ($29.99 sale / $49.99 regular)
 *   STRIPE_PRICE_PRO (+ _SALE)      -> plans.js 'pro' ($69.99 sale / $99.99 regular)
 *                                      (Pro retired from public sale 2026-10-29;
 *                                       mapping kept for existing tenants)
 *   STRIPE_PRICE_HEAVY10 (+ _SALE)  -> plans.js 'heavy10' ($69.99 sale / $99 regular)
 *   STRIPE_PRICE_HEAVY30 (+ _SALE)  -> plans.js 'heavy30' ($129.99 sale / $189 regular)
 *   STRIPE_PRICE_SEAT               -> extra team seat, $25/mo on any plan
 *                                      (plans.js SEAT_PRICING; seat checkout /
 *                                       portal flow is a separate pass — only
 *                                       the price accessor exists so far)
 * ('agency' is invite-only and 'influencer' is a free-for-life perk — both
 *  can never be purchased self-serve, so they have no price ID mapping.)
 *
 * When a SALE price env var is set, it takes precedence over the regular
 * price ID for checkout — sale prices map back to the same plan key.
 * Create the sale Price objects in the Stripe Dashboard and set the
 * corresponding _SALE env var to put a tier on sale; unset it to sell at
 * the regular price.
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

/**
 * Map a Stripe price ID back to our plan key — including SALE price IDs.
 * Returns null if unknown.
 */
function planForPriceId(priceId) {
  if (!priceId) return null;
  const mapping = {
    starter: [process.env.STRIPE_PRICE_STARTER, process.env.STRIPE_PRICE_STARTER_SALE],
    pro: [process.env.STRIPE_PRICE_PRO, process.env.STRIPE_PRICE_PRO_SALE],
    heavy10: [process.env.STRIPE_PRICE_HEAVY10, process.env.STRIPE_PRICE_HEAVY10_SALE],
    heavy30: [process.env.STRIPE_PRICE_HEAVY30, process.env.STRIPE_PRICE_HEAVY30_SALE],
  };
  for (const [planKey, ids] of Object.entries(mapping)) {
    if (ids.some(id => id && id === priceId)) return planKey;
  }
  return null;
}

/**
 * Our plan key -> configured Stripe price ID.
 * Prefers the SALE price ID when set; falls back to the regular price ID.
 * Null if unconfigured.
 */
function priceIdForPlan(planKey) {
  const regular = {
    starter: process.env.STRIPE_PRICE_STARTER,
    pro: process.env.STRIPE_PRICE_PRO,
    heavy10: process.env.STRIPE_PRICE_HEAVY10,
    heavy30: process.env.STRIPE_PRICE_HEAVY30,
  }[planKey] || null;
  const sale = {
    starter: process.env.STRIPE_PRICE_STARTER_SALE,
    pro: process.env.STRIPE_PRICE_PRO_SALE,
    heavy10: process.env.STRIPE_PRICE_HEAVY10_SALE,
    heavy30: process.env.STRIPE_PRICE_HEAVY30_SALE,
  }[planKey] || null;
  return sale || regular || null; // agency and anything else: not purchasable self-serve
}

/**
 * Stripe price ID for ONE extra team seat ($25/mo, plans.js SEAT_PRICING).
 * Null if unconfigured. NOTE: no checkout/portal flow consumes this yet —
 * selling seats is a separate pass; this accessor only centralizes the
 * env name so that pass (and ops verification) has one source of truth.
 */
function seatPriceId() {
  return process.env.STRIPE_PRICE_SEAT || null;
}

module.exports = { getStripe, isConfigured, webhookSecret, planForPriceId, priceIdForPlan, seatPriceId };
