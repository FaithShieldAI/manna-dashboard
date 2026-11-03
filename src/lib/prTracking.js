'use strict';
/**
 * PR email tracking tokens.
 *
 * A token carries the attribution for one press email in the URL
 * itself: { o: outlet, e: recipient email, v: release version }.
 * The tracking routes (src/routes/track.js) are public and pre-auth
 * — a mail client fetching a pixel has no session — so the payload
 * is HMAC-signed instead: token = base64url(JSON) + '.' +
 * base64url(HMAC-SHA256(key, base64url(JSON))). Anyone can read a
 * token; nobody without the key can mint or alter one, so events in
 * pr_events can only be recorded for sends we actually made.
 *
 * Key: process.env.PR_TRACKING_KEY. A hex string (>= 2 even chars of
 * [0-9a-fA-F]) is decoded as hex bytes; anything else is taken as
 * utf8. When the variable is unset, signing is DISABLED: sign()
 * returns null and verify() returns null for every token, so the
 * tracking routes serve the pixel / fallback redirect and record
 * nothing rather than accepting unsigned attribution.
 */
const crypto = require('crypto');

function keyBytes() {
  const raw = process.env.PR_TRACKING_KEY;
  if (!raw || typeof raw !== 'string') return null;
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    return Buffer.from(raw, 'hex');
  }
  return Buffer.from(raw, 'utf8');
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** Sign {o, e, v} into a token string, or null when no key is set. */
function sign(payload) {
  const key = keyBytes();
  if (!key) return null;
  const body = b64url(JSON.stringify({
    o: payload && payload.o != null ? String(payload.o) : null,
    e: payload && payload.e != null ? String(payload.e) : null,
    v: payload && payload.v != null ? String(payload.v) : null,
  }));
  const sig = crypto.createHmac('sha256', key).update(body).digest();
  return body + '.' + b64url(sig);
}

/**
 * Verify a token and return its payload {o, e, v}, or null for a
 * malformed token, a bad signature, or no key configured.
 */
function verify(token) {
  const key = keyBytes();
  if (!key || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (sig.includes('.')) return null;
  const expected = b64url(crypto.createHmac('sha256', key).update(body).digest());
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    return payload;
  } catch (e) {
    return null;
  }
}

module.exports = { sign, verify, makeToken: sign };
