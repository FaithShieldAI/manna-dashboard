'use strict';
/**
 * Billing API — plan, limits, usage. Stripe is STUBBED in this build.
 *
 * GET /api/billing
 *   -> { ok, plan, subscription_status, trial_ends_at,
 *        limits: { projects, emails_per_month, price_label },
 *        usage:  { projects_used, emails_sent_this_month, emails_remaining },
 *        checkout: { stubbed: true, note } }
 *
 * Plan changes / checkout sessions are NOT implemented yet (per Michael:
 * wire Stripe later, once everything works). Upgrading today = D2RM
 * assigns the plan manually (the "takeaway sale": custom tier by request).
 */
const express = require('express');
const { getPlan, PUBLIC_PLANS } = require('../lib/plans');
const { currentMonthKey } = require('../lib/plans');
const mailer = require('../lib/mailer');

const router = express.Router();

router.get('/', (req, res) => {
  const plan = getPlan(req.tenant.plan) || getPlan('starter');
  const monthKey = currentMonthKey();
  const emailsSent = req.tdb.getUsage(monthKey);
  const projectsUsed = req.tdb.countSites();

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
    })),
    tagline: 'Big agency data, little guy money.',
    subscription_status: req.tenant.subscription_status,
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
    checkout: {
      stubbed: true,
      note: 'Online checkout is not enabled in this build. To change plans, contact D2RM.',
    },
    email_delivery: mailer.isSesConfigured()
      ? { provider: 'ses', from: require('../config').sesFromEmail }
      : { provider: 'stub', note: 'Set AWS keys + SES_FROM_EMAIL to send real email.' },
  });
});

module.exports = router;
