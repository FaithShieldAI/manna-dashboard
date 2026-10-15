'use strict';
/**
 * Server-side session management.
 *
 * Design: 256-bit random token -> cookie. Only SHA-256(token) is stored in
 * the DB. Sessions are revoked by deleting the row (logout, "log out
 * everywhere", admin revoke). Sliding expiration: last_seen_at is refreshed
 * on each authenticated request; absolute expiry is 30 days.
 *
 * Why not JWT: server-side sessions allow instant revocation and carry no
 * trust in client-held claims beyond the opaque token.
 */
const crypto = require('crypto');
const { db } = require('../db');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = 'd2rm_session';

function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function createSession(userId, { ip, userAgent } = {}) {
  const token = crypto.randomBytes(32).toString('hex'); // 256-bit
  const tokenHash = sha256hex(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(
    'INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, tokenHash, expiresAt, ip || null, userAgent || null);
  return { token, expiresAt };
}

/** Returns { user, session } or null. Refreshes last_seen_at. */
function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const tokenHash = sha256hex(token);
  const row = db.prepare(`
    SELECT s.id AS session_id, s.expires_at,
           u.id AS user_id, u.tenant_id, u.email, u.display_name, u.role, u.email_verified_at, u.created_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(tokenHash);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id);
    return null;
  }
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
    .run(new Date().toISOString(), row.session_id);
  return {
    session: { id: row.session_id },
    user: {
      id: row.user_id,
      tenant_id: row.tenant_id,
      email: row.email,
      display_name: row.display_name,
      role: row.role,
      email_verified_at: row.email_verified_at,
      created_at: row.created_at || null,
    },
  };
}

function revokeSession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256hex(token));
}

function revokeAllUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** Delete expired sessions. Called on a schedule (and at startup). */
function purgeExpired() {
  const info = db.prepare("DELETE FROM sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')").run();
  return info.changes;
}

function cookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd, // Secure cookies require HTTPS; dev runs on http
    // 'lax' (not 'strict'): the cookie is still never sent cross-site on
    // POST/subresource requests, but top-level navigations from external
    // links (email verification, links shared in chat) arrive authenticated
    // instead of appearing logged-out until the next in-site navigation.
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  createSession,
  verifySession,
  revokeSession,
  revokeAllUserSessions,
  purgeExpired,
  cookieOptions,
};
