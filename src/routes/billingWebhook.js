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
 *   customer.subscription.deleted -> subscription_status = 'canceled'
 *   invoice.payment_failed        -> subscription_status = 'past_due'
 *
 * Tenant lookup order: subscription metadata tenant_id -> checkout session
 * metadata tenant_id -> stripe_customer_id match. Nothing is trusted from
 * the client; price->plan mapping uses server-side env vars only.
 */
const stripeLib = require('../lib/stripe');
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

function applySubscription(tenantId, { customerId, subscriptionId, stripeStatus, priceId }) {
  const plan = stripeLib.planForPriceId(priceId);
  const status = mapStatus(stripeStatus);
  if (plan) {
    db.prepare(
      `UPDATE tenants SET stripe_customer_id = ?, stripe_subscription_id = ?,
        plan = ?, subscription_status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`
    ).run(customerId, subscriptionId, plan, status, tenantId);
  } else {
    // Unknown price — still record billing state, never change the plan.
    db.prepare(
      `UPDATE tenants SET stripe_customer_id = ?, stripe_subscription_id = ?,
        subscription_status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`
    ).run(customerId, subscriptionId, status, tenantId);
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
        const priceId = subscription && subscription.items.data[0]
          ? subscription.items.data[0].price.id : null;
        applySubscription(tenantId, {
          customerId: typeof session.customer === 'string' ? session.customer : session.customer.id,
          subscriptionId: typeof session.subscription === 'string' ? session.subscription : null,
          stripeStatus: subscription ? subscription.status : 'active',
          priceId,
        });
        break;
      }
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const tenantId = findTenantId(event, null, subscription);
        if (!tenantId) break;
        const priceId = subscription.items.data[0] ? subscription.items.data[0].price.id : null;
        applySubscription(tenantId, {
          customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id,
          subscriptionId: subscription.id,
          stripeStatus: subscription.status,
          priceId,
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
