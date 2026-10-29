'use strict';
/**
 * Armor Bearer referral links for Manna tenants.
 *
 * An Armor Bearer affiliate's public referral link is
 *   <AB base>/r/<ref_code>
 * (AB canonical app.py: make_ref_code() + the GET /r/<code> route; the
 * card in public/dashboard-template.html links to the same AB base).
 * The ref_code reaches Manna as `armor_bearer_id` on the provisioning
 * webhook and is persisted on the tenant (migration 024).
 *
 * The stored value is UNTRUSTED. AB generates codes server-side as
 * [A-Za-z0-9]{8} (token_urlsafe with - and _ substituted out), but Manna
 * does not rely on that: a value is only ever turned into a URL if it
 * matches REF_CODE_PATTERN — letters and digits only, 4–32 chars. That
 * alphabet contains no colon, slash, quote, or whitespace, so a poisoned
 * value ('javascript:…', 'a/b', '" onclick=…') can never become a
 * javascript:/data: URL, break out of an href attribute, or alter the
 * path. Validation happens at store time (webhook) AND again here at
 * construction time (defense in depth for rows written any other way).
 */

function abBase() {
  return (process.env.ARMOR_BEARER_BASE_URL || 'https://armorbearer.d2rmmedia.com')
    .replace(/\/+$/, '');
}

const REF_CODE_PATTERN = /^[A-Za-z0-9]{4,32}$/;

function isValidRefCode(v) {
  return typeof v === 'string' && REF_CODE_PATTERN.test(v);
}

/** Trim + validate a raw incoming/stored value. Returns the code or null. */
function normalizeRefCode(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return isValidRefCode(s) ? s : null;
}

/** Build the referral URL for a stored ref code, or null if not linkable. */
function referralLinkFor(refCode) {
  const code = normalizeRefCode(refCode);
  return code ? `${abBase()}/r/${code}` : null;
}

module.exports = { abBase, REF_CODE_PATTERN, isValidRefCode, normalizeRefCode, referralLinkFor };
