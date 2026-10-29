'use strict';
/**
 * Plan definitions + limit enforcement.
 *
 * Pricing (Michael, 2026-10-20 — FINAL two-tier model):
 *   starter    — $29.99/mo SALE ($49.99/mo regular): the emailer/scraper/data
 *                tier. 2 projects, 5,000 emails/mo. No video, no social
 *                media tracking.
 *   pro        — $69.99/mo SALE ($99.99/mo regular): adds VIDEO + SOCIAL
 *                MEDIA TRACKING. 10 projects, 50,000 emails/mo, full social.
 *   heavy10    — $99/mo:  10 AI videos/mo, otherwise Pro-level limits
 *                (10 projects, 50,000 emails/mo).
 *   heavy30    — $189/mo: 30 AI videos/mo, otherwise Pro-level limits
 *                (10 projects, 50,000 emails/mo).
 *   influencer — Pro FREE FOR LIFE (Armor Bearer perk). Not purchasable,
 *                not public — assigned manually/API-side only. Same limits
 *                as Pro.
 *   agency     — custom: invite-only, NOT advertised publicly. Kept in the
 *                plan enum so D2RM can assign it manually for custom deals
 *                (the "takeaway sale": prospects must call and ask).
 *
 * Feature gating: starter gets the emailer/scraper/data feature set only.
 * 'video' (AI video generation) and 'social' (social media tracking) unlock
 * at Pro and above. Use hasFeature(planKey, 'video' | 'social') anywhere
 * that needs to gate a feature — do not hardcode plan key lists at call
 * sites.
 *
 * FIX 2026-10-29 (audit S1): this comment previously claimed "Stripe
 * billing is STUBBED in this build" — that is stale. src/routes/billing.js
 * implements real Stripe Checkout (checkout sessions, customer portal,
 * webhook-driven subscription state) using the price IDs in
 * src/lib/stripe.js. This module defines the plans and enforces limits.
 */

const PLANS = {
  starter: {
    key: 'starter',
    name: 'Starter',
    tagline: 'The emailer/scraper/data tier — everything you need to start.',
    price_cents: 2999,          // $29.99/mo sale
    price_label: '$29.99/mo',
    regular_price_cents: 4999,  // $49.99/mo regular
    regular_price_label: '$49.99/mo',
    special_offer: true,
    projects: 2,                // max sites/projects
    emails_per_month: 5000,
    public: true,               // shown on the signup plan picker
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    tagline: 'Adds video + social media tracking to everything in Starter.',
    price_cents: 6999,          // $69.99/mo sale
    price_label: '$69.99/mo',
    regular_price_cents: 9999, // $99.99/mo regular
    regular_price_label: '$99.99/mo',
    special_offer: true,
    projects: 10,
    emails_per_month: 50000,
    public: true,               // shown on the signup plan picker
  },
  heavy10: {
    key: 'heavy10',
    name: 'Heavy 10',
    tagline: 'For video-first creators: 10 AI videos a month.',
    price_cents: 9900,          // $99/mo
    price_label: '$99/mo',
    special_offer: false,
    projects: 10,               // full-featured: Pro-level limits
    emails_per_month: 50000,    // full-featured: Pro-level limits
    videos_per_month: 10,       // the limit that differentiates Heavy
    public: true,               // shown on the signup plan picker
  },
  heavy30: {
    key: 'heavy30',
    name: 'Heavy 30',
    tagline: 'For video-first creators: 30 AI videos a month.',
    price_cents: 18900,         // $189/mo
    price_label: '$189/mo',
    special_offer: false,
    projects: 10,               // full-featured: Pro-level limits
    emails_per_month: 50000,    // full-featured: Pro-level limits
    videos_per_month: 30,       // the limit that differentiates Heavy
    public: true,               // shown on the signup plan picker
  },
  influencer: {
    key: 'influencer',
    name: 'Influencer',
    tagline: 'Pro free for life — the Armor Bearer perk.',
    price_cents: 0,             // free for life, never billed
    price_label: 'Free for life',
    special_offer: false,
    projects: 10,               // Pro-level limits
    emails_per_month: 50000,    // Pro-level limits
    public: false,              // NEVER shown on the public plan picker or signup
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

/**
 * Feature gating matrix. Plans listed under a feature have it; others
 * (notably 'starter') do not. Unknown plans/features -> false.
 *
 *   'video'  — AI video generation (incl. Manna Heavy video quota)
 *   'social' — social media tracking (IG, FB, X, LinkedIn, TikTok, ...)
 */
const FEATURES = {
  video: ['pro', 'heavy10', 'heavy30', 'influencer', 'agency'],
  social: ['pro', 'heavy10', 'heavy30', 'influencer', 'agency'],
};

function hasFeature(planKey, feature) {
  return (FEATURES[feature] || []).includes(planKey);
}

function getPlan(key) {
  return PLANS[key] || null;
}

/** month_key 'YYYY-MM' in UTC for quota bucketing. */
function currentMonthKey(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

module.exports = { PLANS, PUBLIC_PLANS, FEATURES, hasFeature, getPlan, currentMonthKey };
