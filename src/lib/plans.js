'use strict';
/**
 * Plan definitions + limit enforcement.
 *
 * Pricing (Michael, 2026-10-12):
 *   starter — $50/mo:  2 projects,  5,000 emails/mo
 *   pro     — $100/mo: 10 projects, 20,000 emails/mo
 *   agency  — custom:  invite-only, NOT advertised publicly. Kept in the
 *             plan enum so D2RM can assign it manually for custom deals
 *             (the "takeaway sale": prospects must call and ask).
 *
 * Stripe billing is STUBBED in this build (per Michael: wire payments later,
 * once everything works). This module enforces the limits; the billing
 * route reports subscription state without touching Stripe.
 */

const PLANS = {
  starter: {
    key: 'starter',
    name: 'Starter',
    tagline: 'For the solo creator getting started.',
    price_cents: 5000,          // $50/mo
    price_label: '$50/mo',
    projects: 2,                // max sites/projects
    emails_per_month: 5000,
    public: true,               // shown on the signup plan picker
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    tagline: 'For serious operators running multiple projects.',
    price_cents: 10000,         // $100/mo
    price_label: '$100/mo',
    projects: 10,
    emails_per_month: 20000,
    public: true,
  },
  agency: {
    key: 'agency',
    name: 'Custom',
    tagline: 'Built for smaller creators — talk to us.',
    price_cents: null,          // negotiated
    price_label: 'Custom',
    projects: null,             // unlimited (negotiated)
    emails_per_month: null,     // unlimited (negotiated)
    public: false,              // NEVER shown on the public plan picker
  },
};

const PUBLIC_PLANS = Object.values(PLANS).filter(p => p.public);

function getPlan(key) {
  return PLANS[key] || null;
}

/** month_key 'YYYY-MM' in UTC for quota bucketing. */
function currentMonthKey(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

module.exports = { PLANS, PUBLIC_PLANS, getPlan, currentMonthKey };
