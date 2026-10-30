-- Migration 028: purchased extra team seats (seat purchase flow, 2026-10-29).
--
-- Every plan includes ONE seat — the owner's login (src/lib/plans.js
-- SEAT_PRICING). Extra team seats are $25/seat/mo (Stripe product
-- "Manna Seat", price in env STRIPE_PRICE_SEAT) and are sold as a
-- quantity-bearing subscription item on the tenant's Stripe subscription.
--
--   extra_seats          — how many PAID extra seats the tenant's
--                          subscription currently carries. The webhook
--                          (src/routes/billingWebhook.js) reconciles this
--                          from the subscription's seat item on every
--                          subscription event, so Stripe stays the source
--                          of truth; the billing routes also write it
--                          optimistically after a successful Stripe call.
--   stripe_seat_item_id  — the subscription item id of the seat line, so
--                          quantity changes update the existing item
--                          instead of stacking duplicate seat lines.
--
-- Total seats for a tenant = plan seats_included (1) + extra_seats.
-- Enforcement lives in src/lib/seats.js + src/routes/team.js.

ALTER TABLE tenants ADD COLUMN extra_seats INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN stripe_seat_item_id TEXT;
