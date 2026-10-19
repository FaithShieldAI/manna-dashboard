'use strict';
/**
 * Billing whitelist — these emails bypass all billing/subscription checks
 * across all products. Michael's rule: they see everything, pay nothing.
 */
const WHITELIST = new Set([
  'michael@faithshield.ai',  // Michael — sees all tenants
  'sid.allen@yahoo.com',
  'support@faithshield.ai',  // Hunter Raines
]);

function isWhitelisted(email) {
  if (!email) return false;
  return WHITELIST.has(String(email).toLowerCase().trim());
}

module.exports = { isWhitelisted, WHITELIST: [...WHITELIST] };
