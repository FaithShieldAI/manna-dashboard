'use strict';
/**
 * Billing whitelist — these emails bypass all billing/subscription checks
 * across all products. House rule: they see everything, pay nothing.
 */
const WHITELIST = new Set([
  'michael@faithshield.ai',  // house owner — sees all tenants
  'leon@faithshield.ai',  // co-owner — his Manna matches Michael's exactly (Michael's order, 2026-11-22)
  'mikemixer2002@gmail.com',  // house owner
  '1faithshieldai@gmail.com',  // house owner
  'sid.allen@yahoo.com',  // Sid Allen
  'basedinfaith@mail.com',  // Sid Allen (added 2026-10-31)
  'support@faithshield.ai',  // Hunter Raines (added 2026-11-14)
  'seanhallavtech@gmail.com',  // Sean Hall — full house account (Michael's order, 2026-11-24)
]);

function isWhitelisted(email) {
  if (!email) return false;
  return WHITELIST.has(String(email).toLowerCase().trim());
}

module.exports = { isWhitelisted, WHITELIST: [...WHITELIST] };
