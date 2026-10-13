'use strict';
/**
 * Password helpers — bcrypt with cost factor 12.
 * Minimum password length enforced at the route layer (12 chars).
 */
const bcrypt = require('bcryptjs');

const COST = 12;

async function hash(password) {
  return bcrypt.hash(password, COST);
}

/**
 * Compare using bcrypt's built-in constant-time comparison.
 * Always runs the hash even for unknown users is handled at the route
 * layer (dummy compare) to avoid user-enumeration timing leaks.
 */
async function verify(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

/** Pre-computed dummy hash for timing-safe "user not found" path. */
const DUMMY_HASH = bcrypt.hashSync('d2rm-dummy-password-for-timing-safety', COST);

module.exports = { hash, verify, DUMMY_HASH, COST };
