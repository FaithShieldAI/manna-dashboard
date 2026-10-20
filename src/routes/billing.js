'use strict';
/**
 * Billing API — plan, limits, usage, Stripe checkout + customer portal.
 *
 * GET  /api/billing
 *   -> { ok, plan, subscription_status, trial_ends_at,
 *        limits: { projects, emails_per_month, price_label },
 *        usage:  { projects_used, emails_sent_this_month, emails_remaining },
 *        stripe: { configured, has_subscription } }
 * POST /api/billing/checkout  { plan: 'starter'|'pro'|'heavy10'|'heavy30' }
 *   -> { ok, url }  (Stripe Checkout Session URL; 400 on bad plan,
 *                    503 when Stripe is not configured)
 *   Checkout uses the SALE Stripe price when its env var is set —
 *   see priceIdForPlan() in src/lib/stripe.js.
 *   'influencer' (free for life, assigned manually/API-side) and 'agency'
 *   (invite-only) are never purchasable self-serve.
 * POST /api/billing/portal
 *   -> { ok, url }  (Stripe Customer Portal session; 404 when the tenant
 *                    has no Stripe customer yet)
 *
 * Webhook (POST /api/billing/webhook) is mounted separately in server.js —
 * it must skip auth/CSRF and receive the raw body for signature verification.
 */
const express = require('express');
const { getPlan, PUBLIC_PLANS, hasFeature } = require('../lib/plans');
const { currentMonthKey } = require('../lib/plans');
const mailer = require('../lib/mailer');
const stripeLib = require('../lib/stripe');
const { db } = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const plan = getPlan(req.tenant.plan) || getPlan('starter');
  const monthKey = currentMonthKey();
  const emailsSent = req.tdb.getUsage(monthKey);
  const projectsUsed = req.tdb.countSites();
  const stripeRow = db.prepare(
    'SELECT stripe_customer_id, stripe_subscription_id, trial_ends_at FROM tenants WHERE id = ?'
  ).get(req.tenant.id);

  res.json({
    ok: true,
    plan: plan.key,
    plan_name: plan.name,
    price_label: plan.price_label,
    /* Public plans for the dashboard plan picker — single source of truth
       is src/lib/plans.js so the UI can never drift from real pricing. */
    plans: PUBLIC_PLANS.map(p => ({
      key: p.key,
      name: p.name,
      tagline: p.tagline,
      price_label: p.price_label,
      regular_price_label: p.regular_price_label || null,
      special_offer: !!p.special_offer,
      projects: p.projects,
      emails_per_month: p.emails_per_month,
      videos_per_month: p.videos_per_month || null,
      // Feature gates (see hasFeature() in src/lib/plans.js) so the UI can
      // show/hide video + social features per plan without hardcoding keys.
      has_video: hasFeature(p.key, 'video'),
      has_social: hasFeature(p.key, 'social'),
    })),
    tagline: 'Big agency data, little guy money.',
    subscription_status: req.tenant.subscription_status,
    trial_ends_at: (stripeRow && stripeRow.trial_ends_at) || null,
    limits: {
      projects: plan.projects,            // null = unlimited (custom tier)
      emails_per_month: plan.emails_per_month,
    },
    usage: {
      projects_used: projectsUsed,
      projects_remaining: plan.projects == null ? null : Math.max(0, plan.projects - projectsUsed),
      emails_sent_this_month: emailsSent,
      emails_remaining: plan.emails_per_month == null ? null : Math.max(0, plan.emails_per_month - emailsSent),
      month_key: monthKey,
    },
    stripe: {
      configured: stripeLib.isConfigured(),
      has_subscription: Boolean(stripeRow && stripeRow.stripe_subscription_id),
    },
    email_delivery: mailer.isSesConfigured()
      ? { provider: 'ses', from: require('../config').sesFromEmail }
      : { provider: 'stub', note: 'Set AWS keys + SES_FROM_EMAIL to send real email.' },
  });
});

/**
 * Create a Stripe Checkout Session for a plan upgrade/downgrade.
 * Price IDs are server-side only (env vars) — the client only names the plan.
 * Purchasable plans are derived from src/lib/plans.js (public + priced > 0),
 * so a new advertised tier is sellable without touching this route.
 * 'influencer' (price_cents 0) and 'agency' (price_cents null) can never
 * be purchased self-serve.
 */
const PURCHASABLE_PLANS = PUBLIC_PLANS.filter(p => p.price_cents != null && p.price_cents > 0).map(p => p.key);
router.post('/checkout', async (req, res) => {
  try {
    const stripe = stripeLib.getStripe();
    if (!stripe) {
      return res.status(503).json({ ok: false, error: 'stripe_not_configured' });
    }
    const planKey = String((req.body && req.body.plan) || '').toLowerCase();
    if (!PURCHASABLE_PLANS.includes(planKey)) {
      return res.status(400).json({ ok: false, error: 'invalid_plan', valid: PURCHASABLE_PLANS });
    }
    // priceIdForPlan prefers the SALE price ID when its env var is set.
    const priceId = stripeLib.priceIdForPlan(planKey);
    if (!priceId) {
      return res.status(503).json({ ok: false, error: 'price_not_configured', plan: planKey });
    }

    const tenantId = req.tenant.id;
    const row = db.prepare(
      'SELECT stripe_customer_id, stripe_subscription_id FROM tenants WHERE id = ?'
    ).get(tenantId);

    const baseUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
    const successUrl = baseUrl ? `${baseUrl}/app#billing` : '/app#billing';
    const cancelUrl = baseUrl ? `${baseUrl}/app#billing` : '/app#billing';

    const sessionParams = {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      // Cards + ACH (US bank debit). ACH costs ~0.8% vs ~2.9% for cards.
      payment_method_types: ['card', 'us_bank_account'],
      payment_method_options: {
        us_bank_account: { financial_connections: { permissions: ['payment_method'] } },
      },
      success_url: successUrl + '?checkout=success',
      cancel_url: cancelUrl + '?checkout=cancelled',
      // Tie the session back to the tenant so the webhook can activate it.
      metadata: { tenant_id: String(tenantId), plan: planKey },
      subscription_data: { metadata: { tenant_id: String(tenantId), plan: planKey } },
      customer_email: req.user.email || undefined,
    };
    // Reuse the existing Stripe customer when we have one (avoids dupes).
    if (row && row.stripe_customer_id) {
      sessionParams.customer = row.stripe_customer_id;
      delete sessionParams.customer_email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ ok: true, url: session.url });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[billing/checkout]', e.message);
    res.status(500).json({ ok: false, error: 'checkout_failed' });
  }
});

/**
 * Customer Portal — lets paying customers manage/cancel their subscription.
 */
router.post('/portal', async (req, res) => {
  try {
    const stripe = stripeLib.getStripe();
    if (!stripe) {
      return res.status(503).json({ ok: false, error: 'stripe_not_configured' });
    }
    const row = db.prepare(
      'SELECT stripe_customer_id FROM tenants WHERE id = ?'
    ).get(req.tenant.id);
    if (!row || !row.stripe_customer_id) {
      return res.status(404).json({ ok: false, error: 'no_stripe_customer' });
    }
    const baseUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
    const returnUrl = baseUrl ? `${baseUrl}/app#billing` : '/app#billing';
    const session = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: returnUrl,
    });
    res.json({ ok: true, url: session.url });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[billing/portal]', e.message);
    res.status(500).json({ ok: false, error: 'portal_failed' });
  }
});

module.exports = router;
