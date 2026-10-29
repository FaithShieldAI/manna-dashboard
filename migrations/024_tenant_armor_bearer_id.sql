-- Migration 024: tenants.armor_bearer_id — the tenant's Armor Bearer
-- affiliate identity.
--
-- When Armor Bearer approves an influencer it calls Manna's provisioning
-- webhook (src/routes/influencerWebhook.js, migration 016) with
-- armor_bearer_id = the affiliate's AB ref_code (the token in their
-- public referral link, AB route GET /r/<code>). Until now the receiver
-- only wrote that value into provisioning_log.detail, so Manna could not
-- show the affiliate their own referral link — the "Grow with Armor
-- Bearer" dashboard card sat in its empty state forever.
--
-- The value is stored verbatim-ish (validated) on the tenant so it
-- survives and is queryable. It is UNTRUSTED input: src/lib/referral.js
-- validates it against a strict pattern both when storing and again when
-- constructing the referral URL for GET /api/auth/me, so a poisoned
-- value can never become a link. NULL = tenant has no AB identity.

ALTER TABLE tenants ADD COLUMN armor_bearer_id TEXT;
