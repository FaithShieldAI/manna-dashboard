'use strict';
/**
 * Billing whitelist (Michael's order, 2026-11-22: "Leon's Manna to
 * look exactly like mine"). Leon Sievers is co-owner of the house
 * tenant; his account must bypass the same billing/subscription
 * checks Michael's does. Strangers stay off the list.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isWhitelisted } = require('../src/lib/whitelist');

test('both house owners are whitelisted', () => {
  assert.equal(isWhitelisted('michael@faithshield.ai'), true);
  assert.equal(isWhitelisted('leon@faithshield.ai'), true);
  assert.equal(isWhitelisted('LEON@faithshield.ai'), true); // case-insensitive
});

test('non-house addresses are not whitelisted', () => {
  assert.equal(isWhitelisted('someone@example.com'), false);
  assert.equal(isWhitelisted('leon@example.com'), false);
  assert.equal(isWhitelisted(''), false);
  assert.equal(isWhitelisted(undefined), false);
});
