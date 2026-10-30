'use strict';
/**
 * Seat accounting — the single source of truth for "how many logins may
 * this tenant have, and how many does it have?"
 *
 * Model (Michael, 2026-10-29; see src/lib/plans.js SEAT_PRICING):
 *   every plan includes ONE seat — the owner's login.
 *   extra seats are $25/seat/mo, sold as a quantity-bearing item on the
 *   tenant's Stripe subscription (price env STRIPE_PRICE_SEAT), and they
 *   SHARE the plan's quotas — a seat is an extra login, never its own
 *   quotas or project slot.
 *
 *   total seats = plan.seats_included + tenants.extra_seats
 *   used seats  = COUNT(users WHERE tenant_id = ?)
 *
 * A plan with seats_included = null (agency — negotiated) has no seat
 * limit: total/remaining come back null, same convention as the other
 * nullable limits in plans.js.
 *
 * Stripe stays the source of truth for extra_seats: the billing webhook
 * reconciles tenants.extra_seats from the subscription's seat item on
 * every subscription event (seatItemFor / seatQuantityFor below), and
 * the billing routes write it optimistically after a successful call.
 */
const { db } = require('../db');
const { getPlan, SEAT_PRICING } = require('./plans');
const stripeLib = require('./stripe');

function countUsers(tenantId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?').get(tenantId);
  return row ? row.n : 0;
}

/**
 * Full seat picture for a tenant:
 *   { included, extra, total, used, remaining, price_label }
 * total/remaining are null when the plan carries no seat limit (agency).
 */
function getSeatState(tenantId) {
  const tenant = db.prepare('SELECT plan, extra_seats FROM tenants WHERE id = ?').get(tenantId);
  const plan = tenant ? getPlan(tenant.plan) : null;
  // seats_included is null only on agency (negotiated = no seat limit).
  const included = plan ? plan.seats_included : SEAT_PRICING.includedPerPlan;
  const extra = tenant && tenant.extra_seats ? tenant.extra_seats : 0;
  const used = countUsers(tenantId);
  const total = included == null ? null : included + extra;
  return {
    included,
    extra,
    total,
    used,
    remaining: total == null ? null : Math.max(0, total - used),
    price_label: SEAT_PRICING.extraSeatPriceLabel,
  };
}

/** True when the tenant may add one more login right now. */
function canAddUser(tenantId) {
  const state = getSeatState(tenantId);
  return state.total == null || state.used < state.total;
}

/**
 * The seat line item on a Stripe subscription object, or null.
 * Identified by price ID (env STRIPE_PRICE_SEAT) — never by position:
 * a subscription can carry the plan item and the seat item in any order.
 */
function seatItemFor(subscription) {
  const seatPrice = stripeLib.seatPriceId();
  if (!subscription || !seatPrice || !subscription.items || !Array.isArray(subscription.items.data)) {
    return null;
  }
  return subscription.items.data.find(
    it => it && it.price && it.price.id === seatPrice
  ) || null;
}

/** Purchased extra seats carried by a Stripe subscription (0 when none). */
function seatQuantityFor(subscription) {
  const item = seatItemFor(subscription);
  return item && Number.isInteger(item.quantity) ? item.quantity : 0;
}

module.exports = { getSeatState, canAddUser, countUsers, seatItemFor, seatQuantityFor };
