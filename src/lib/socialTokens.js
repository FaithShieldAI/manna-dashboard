'use strict';
/**
 * Social token encryption — AES-256-GCM with a random 96-bit IV per token.
 *
 * Stored format: 'gcm:<iv hex>:<ciphertext hex>:<tag hex>'.
 * The key comes from SOCIAL_TOKEN_KEY (64 hex chars = 32 bytes).
 * Production fails fast without it; dev/test fall back to an ephemeral
 * in-memory key with a one-time warning (tokens won't survive restart).
 *
 * The DB never holds a plaintext token — encryption happens at the route
 * boundary, before the write.
 */
const crypto = require('crypto');

let warned = false;
let ephemeralKey = null;

function getKey() {
  const hex = process.env.SOCIAL_TOKEN_KEY;
  if (hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('[socialTokens] SOCIAL_TOKEN_KEY must be 64 hex characters (32 bytes)');
    }
    return Buffer.from(hex, 'hex');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[socialTokens] SOCIAL_TOKEN_KEY is required when NODE_ENV=production');
  }
  if (!warned) {
    // eslint-disable-next-line no-console
    console.warn('[socialTokens] no SOCIAL_TOKEN_KEY set — using ephemeral key (encrypted tokens will not survive restart)');
    warned = true;
  }
  if (!ephemeralKey) ephemeralKey = crypto.randomBytes(32);
  return ephemeralKey;
}

function encryptToken(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `gcm:${iv.toString('hex')}:${ct.toString('hex')}:${tag.toString('hex')}`;
}

function decryptToken(blob) {
  const parts = String(blob || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'gcm') {
    throw new Error('[socialTokens] malformed token blob');
  }
  const key = getKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'hex'));
  decipher.setAuthTag(Buffer.from(parts[3], 'hex'));
  const pt = Buffer.concat([decipher.update(Buffer.from(parts[2], 'hex')), decipher.final()]);
  return pt.toString('utf8');
}

module.exports = { encryptToken, decryptToken };
