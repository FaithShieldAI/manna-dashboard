-- Migration 021: FaithShield subscription tracking (Stripe).
-- FaithShield's $8.99 Stripe price exists in the shared Stripe account but
-- nothing sold it on the web and nothing listened for its events (real
-- FaithShield sales are Apple/Google IAP). This table is the consumer for
-- the one signal worth tracking: subscription STATE for any FaithShield
-- Stripe subscription, so the D2RM 'faithshield' goal counter
-- (FaithShield paying users, goal 100 — seeded by src/lib/syncD2rm.js)
-- can be fed by Stripe events instead of being hand-updated.
-- Rows are written only by src/routes/faithshieldWebhook.js, and only for
-- subscriptions whose price matches STRIPE_FS_PRICE_ID.
-- NOT tenant-scoped: FaithShield is a D2RM portfolio product, not a tenant
-- product; the counter derived from this table is a portfolio-level number.
-- Times are UTC ISO-8601 strings (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
-- fixed width so lexicographic comparison matches chronological order.

CREATE TABLE IF NOT EXISTS faithshield_subscriptions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT '',
  current_period_end     TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (stripe_subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_faithshield_subs_status
  ON faithshield_subscriptions (status);
