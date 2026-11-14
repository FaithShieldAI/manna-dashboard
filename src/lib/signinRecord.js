'use strict';
/**
 * Sign-in record — Michael's order, 2026-11-14, narrowed twice in his
 * own words: "just his and mine", "but only those two."
 *
 * For exactly TWO accounts, Manna keeps a sign-in record:
 *   - Michael Faber  (michael@faithshield.ai, house tenant 1)
 *   - Hunter Raines  (support@faithshield.ai, tenant 5)
 *
 * What is recorded (users columns, migration 038):
 *   last_login_at        — stamped at a successful password sign-in.
 *   last_activity_at     — stamped on authenticated requests.
 *   last_session_seconds — the most recent visit's length so far
 *                          (activity minus sign-in, whole seconds),
 *                          refreshed on activity, finalized at logout.
 *
 * Every function here no-ops for any other account: no other user's
 * row is ever written, and the record is only ever exposed on the
 * keyed user's own /api/auth/me payload (their own screen). There is
 * no cross-tenant view and no admin view of it.
 *
 * The stamp is additive and fail-soft: on an unmigrated database (or
 * any DB error) it silently does nothing, so it can never break a
 * sign-in or a request.
 */
const { db } = require('../db');

// THE keyed accounts. This set is the whole scope of the feature:
// two email addresses, named here and nowhere else.
const SIGNIN_RECORD_EMAILS = new Set([
  'michael@faithshield.ai', // Michael Faber
  'support@faithshield.ai', // Hunter Raines
]);

function isSigninRecordUser(email) {
  if (!email) return false;
  return SIGNIN_RECORD_EMAILS.has(String(email).toLowerCase().trim());
}

/**
 * Stamp a fresh sign-in. Call ONLY at the moment a new authenticated
 * session is created by a password sign-in. A new visit has not
 * accumulated time yet, so the duration resets to NULL; activity and
 * logout fill it in for this visit.
 */
function stampSignIn(user) {
  if (!user || !isSigninRecordUser(user.email)) return false;
  const now = new Date().toISOString();
  try {
    db.prepare(
      'UPDATE users SET last_login_at = ?, last_activity_at = ?, last_session_seconds = NULL WHERE id = ?'
    ).run(now, now, user.id);
    return true;
  } catch (e) { return false; } // unmigrated DB: never break sign-in
}

/**
 * Stamp activity on an authenticated request and refresh the current
 * visit's duration. Ordinary session requests call this; it writes
 * ONLY for the two keyed users, and only once they have a sign-in
 * stamp to measure from.
 */
function stampActivity(user) {
  if (!user || !isSigninRecordUser(user.email)) return false;
  try {
    const row = db.prepare('SELECT last_login_at FROM users WHERE id = ?').get(user.id);
    if (!row || !row.last_login_at) return false;
    const now = new Date();
    const secs = Math.max(0, Math.floor((now.getTime() - new Date(row.last_login_at).getTime()) / 1000));
    db.prepare(
      'UPDATE users SET last_activity_at = ?, last_session_seconds = ? WHERE id = ?'
    ).run(now.toISOString(), secs, user.id);
    return true;
  } catch (e) { return false; } // unmigrated DB: never break a request
}

/**
 * The record for the keyed user's OWN profile payload. Returns null
 * for everyone else, and null until the keyed user has signed in.
 */
function signinRecordFor(user) {
  if (!user || !isSigninRecordUser(user.email)) return null;
  try {
    const row = db.prepare(
      'SELECT last_login_at, last_session_seconds FROM users WHERE id = ?'
    ).get(user.id);
    if (!row || !row.last_login_at) return null;
    return { last_login_at: row.last_login_at, last_session_seconds: row.last_session_seconds };
  } catch (e) { return null; }
}

module.exports = {
  isSigninRecordUser,
  stampSignIn,
  stampActivity,
  signinRecordFor,
  SIGNIN_RECORD_EMAILS: [...SIGNIN_RECORD_EMAILS],
};
