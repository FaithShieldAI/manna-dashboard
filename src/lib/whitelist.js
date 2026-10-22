'use strict';
/**
 * Billing whitelist — these emails bypass all billing/subscription checks
 * across all products. Michael's rule: they see everything, pay nothing.
 */
const WHITELIST = new Set([
  'michael@faithshield.ai',  // Michael — sees all tenants
  'mikemixer2002@gmail.com',  // Michael
  '1faithshieldai@gmail.com',  // Michael
  'sid.allen@yahoo.com',
]);

function isWhitelisted(email) {
  if (!email) return false;
  return WHITELIST.has(String(email).toLowerCase().trim());
}

module.exports = { isWhitelisted, WHITELIST: [...WHITELIST] };
