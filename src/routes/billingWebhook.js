'use strict';
/**
 * Stripe webhook handler.
 *
 * Mounted in server.js BEFORE express.json() with express.raw(), because
 * Stripe signature verification requires the exact raw request body.
 * No auth, no CSRF — the Stripe-Signature header IS the authentication.
 * Invalid signatures get a 400; we never process unsigned events.
 *
 * Events handled:
 *   checkout.session.completed   -> link customer+subscription to tenant,
 *                                   set plan (from server-side price mapping),
 *                                   subscription_status = 'active'
 *   customer.subscription.updated -> sync status/plan from the subscription
 *   customer.subscription.deleted -> subscription_status = 'canceled',
 *                                   purchased seats reset to 0
 *   invoice.payment_failed        -> subscription_status = 'past_due'
 *
 * Seats: a subscription can carry TWO items — the plan item and the seat
 * item ($25/mo, env STRIPE_PRICE_SEAT). Every subscription-bearing event
 * reconciles tenants.extra_seats + stripe_seat_item_id from the seat item
 * (src/lib/seats.js), so quantity changes made in Stripe (portal,
 * dashboard) land on the tenant. The plan is read from whichever item
 * maps to a plan — never from items[0] by position, since the seat item
 * can sit first.
 *
 * Tenant lookup order: subscription metadata tenant_id -> checkout session
 * metadata tenant_id -> stripe_customer_id match. Nothing is trusted from
 * the client; price->plan mapping uses server-side env vars only.
 */
const stripeLib = require('../lib/stripe');
const seatsLib = require('../lib/seats');
const { db } = require('../db');

/** Stripe subscription status -> our tenant subscription_status enum. */
function mapStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return stripeStatus;
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    case 'incomplete':
    default:
      return 'incomplete';
  }
}

function findTenantId(event, session, subscription) {
  const meta = (subscription && subscription.metadata) || (session && session.metadata) || {};
  if (meta.tenant_id) {
    const row = db.prepare('SELECT id FROM tenants WHERE id = ?').get(Number(meta.tenant_id));
    if (row) return row.id;
  }
  const customerId = (subscription && subscription.customer) || (session && session.customer);
  if (customerId) {
    const cid = typeof customerId === 'string' ? customerId : customerId.id;
    const row = db.prepare('SELECT id FROM tenants WHERE stripe_customer_id = ?').get(cid);
    if (row) return row.id;
  }
  return null;
}

function applySubscription(tenantId, { customerId, subscriptionId, stripeStatus, items }) {
  const itemList = Array.isArray(items) ? items : [];
  // Plan comes from the item whose price maps to a plan (the seat price
  // maps to none); a seats-only subscription therefore never moves the plan.
  const planItem = itemList.find(it => it && it.price && stripeLib.planForPriceId(it.price.id));
  const plan = planItem ? stripeLib.planForPriceId(planItem.price.id) : null;
  const status = mapStatus(stripeStatus);
  // Seat reconciliation: the seat item's quantity IS the purchased count.
  const seatItem = seatsLib.seatItemFor({ items: { data: itemList } });
  const extraSeats = seatItem && Number.isInteger(seatItem.quantity) ? seatItem.quantity : 0;
  const seatItemId = seatItem ? seatItem.id : null;
  if (plan) {
    db.prepare(
      `UPDATE tenants SET stripe_customer_id = ?, stripe_subscription_id = ?,
        plan = ?, subscription_status = ?, extra_seats = ?, stripe_seat_item_id = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`
    ).run(customerId, subscriptionId, plan, status, extraSeats, seatItemId, tenantId);
  } else {
    // No plan item — still record billing state + seats, never change the plan.
    db.prepare(
      `UPDATE tenants SET stripe_customer_id = ?, stripe_subscription_id = ?,
        subscription_status = ?, extra_seats = ?, stripe_seat_item_id = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`
    ).run(customerId, subscriptionId, status, extraSeats, seatItemId, tenantId);
  }
}

async function webhookHandler(req, res) {
  const stripe = stripeLib.getStripe();
  const secret = stripeLib.webhookSecret();
  if (!stripe || !secret) {
    return res.status(503).json({ ok: false, error: 'stripe_not_configured' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[webhook] signature verification failed:', e.message);
    return res.status(400).json({ ok: false, error: 'invalid_signature' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        // Expand the subscription to get price + status in one object.
        let subscription = null;
        if (session.subscription) {
          subscription = await stripe.subscriptions.retrieve(session.subscription);
        }
        const tenantId = findTenantId(event, session, subscription);
        if (!tenantId) break;
        applySubscription(tenantId, {
          customerId: typeof session.customer === 'string' ? session.customer : session.customer.id,
          subscriptionId: typeof session.subscription === 'string' ? session.subscription : null,
          stripeStatus: subscription ? subscription.status : 'active',
          items: subscription && subscription.items ? subscription.items.data : [],
        });
        break;
      }
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const tenantId = findTenantId(event, null, subscription);
        if (!tenantId) break;
        applySubscription(tenantId, {
          customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id,
          subscriptionId: subscription.id,
          stripeStatus: subscription.status,
          items: subscription.items ? subscription.items.data : [],
        });
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const tenantId = findTenantId(event, null, subscription);
        if (!tenantId) break;
        const customerId = typeof subscription.customer === 'string'
          ? subscription.customer : subscription.customer.id;
        db.prepare(
          `UPDATE tenants SET stripe_subscription_id = NULL, subscription_status = 'canceled',
            extra_seats = 0, stripe_seat_item_id = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
        ).run(tenantId);
        // Keep stripe_customer_id so they can resubscribe without a duplicate.
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer.id;
        const row = db.prepare('SELECT id FROM tenants WHERE stripe_customer_id = ?').get(customerId);
        if (row) {
          db.prepare(
            `UPDATE tenants SET subscription_status = 'past_due',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
          ).run(row.id);
        }
        break;
      }
      default:
        // Unhandled event type — acknowledge so Stripe doesn't retry.
        break;
    }
    res.json({ ok: true, received: event.type });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[webhook] handler error:', e.message);
    // Return 500 so Stripe retries; the event wasn't applied.
    res.status(500).json({ ok: false, error: 'handler_failed' });
  }
}

module.exports = webhookHandler;
