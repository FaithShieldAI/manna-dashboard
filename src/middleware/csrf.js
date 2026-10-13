'use strict';
/**
 * CSRF protection for cookie-authenticated mutating requests.
 *
 * The session cookie is SameSite=Strict, which already blocks cross-site
 * form/cookie sends in modern browsers. Defense in depth: mutating
 * requests (POST/PUT/PATCH/DELETE) must also carry the
 * `X-Requested-With: XMLHttpRequest` header, which browsers do not send
 * cross-origin without a preflight the attacker cannot satisfy for
 * credentialed simple requests.
 *
 * Safe methods (GET/HEAD/OPTIONS) are exempt — they must never mutate state.
 */
function csrfCheck(req, res, next) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next();
  }
  if (req.get('X-Requested-With') === 'XMLHttpRequest') {
    return next();
  }
  return res.status(403).json({ ok: false, error: 'csrf_check_failed' });
}

module.exports = { csrfCheck };
