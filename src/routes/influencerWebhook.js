'use strict';
/**
 * Influencer auto-provision webhook.
 *
 * Mounted in server.js as POST /api/webhooks/influencer-provision, BEFORE
 * the authenticated /api router. No session auth, no CSRF — the
 * X-Webhook-Secret header IS the authentication (timing-safe compare
 * against INFLUENCER_WEBHOOK_SECRET). Missing/mismatched secret -> 401.
 * Never reveal in logs or responses whether the secret or the body was bad
 * beyond the status code.
 *
 * Called by Armor Bearer when an influencer is approved. Idempotent: safe
 * to call twice for the same email — the second call ensures the plan and
 * returns already_provisioned (or plan_upgraded) instead of duplicating.
 *
 * Body: { email, name?, armor_bearer_id? }
 *
 * New influencer: creates a tenant (plan='influencer', subscription
 * 'active' — free for life, never billed, never trialing) + an owner user
 * with a random unguessable password (they sign in via password reset).
 * Existing email: ensures their tenant carries plan='influencer'.
 * Every outcome is written to provisioning_log.
 */
const crypto = require('crypto');
const { db, transaction } = require('../db');
const password = require('../lib/password');

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim());
}

/** tenant slug from the email local part; unique via random suffix. */
function makeSlug(email) {
  const local = String(email).split('@')[0].toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'influencer';
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${local}-${suffix}`;
}

function logEvent(eventType, email, tenantId, userId, detail) {
  db.prepare(`
    INSERT INTO provisioning_log (event_type, email, tenant_id, user_id, detail)
    VALUES (?, ?, ?, ?, ?)
  `).run(eventType, email, tenantId || null, userId || null, detail || null);
}

async function handler(req, res) {
  const secret = process.env.INFLUENCER_WEBHOOK_SECRET;
  if (!secret) {
    // eslint-disable-next-line no-console
    console.error('[influencer-webhook] INFLUENCER_WEBHOOK_SECRET not configured');
    return res.status(500).json({ ok: false, error: 'webhook_not_configured' });
  }
  const provided = req.get('X-Webhook-Secret');
  if (!secretsMatch(provided, secret)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const { email, name, armor_bearer_id } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!isValidEmail(cleanEmail)) {
    return res.status(400).json({ ok: false, error: 'invalid_email' });
  }
  const displayName = String(name || '').trim().slice(0, 80) || null;
  const abId = armor_bearer_id === undefined || armor_bearer_id === null
    ? null : String(armor_bearer_id).slice(0, 80);

  try {
    // Idempotency: email is globally unique in users.
    const existing = db.prepare(
      'SELECT u.id AS user_id, u.tenant_id, t.plan FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.email = ?'
    ).get(cleanEmail);

    if (existing) {
      if (existing.plan === 'influencer') {
        logEvent('already_provisioned', cleanEmail, existing.tenant_id, existing.user_id,
          abId ? `armor_bearer_id=${abId}` : null);
        return res.json({ ok: true, result: 'already_provisioned', email: cleanEmail, tenant_id: existing.tenant_id });
      }
      // Existing customer upgraded to the free-for-life influencer plan.
      const out = transaction(() => {
        db.prepare("UPDATE tenants SET plan = 'influencer', subscription_status = 'active', updated_at = ? WHERE id = ?")
          .run(utcNow(), existing.tenant_id);
        if (displayName) {
          db.prepare('UPDATE users SET display_name = COALESCE(display_name, ?) WHERE id = ?')
            .run(displayName, existing.user_id);
        }
        logEvent('plan_upgraded', cleanEmail, existing.tenant_id, existing.user_id,
          `previous_plan=${existing.plan}${abId ? ` armor_bearer_id=${abId}` : ''}`);
        return { tenant_id: existing.tenant_id, user_id: existing.user_id };
      });
      // eslint-disable-next-line no-console
      console.log(`[influencer-webhook] plan_upgraded email=${cleanEmail} tenant=${out.tenant_id}`);
      return res.json({ ok: true, result: 'plan_upgraded', email: cleanEmail, tenant_id: out.tenant_id });
    }

    // New influencer: tenant + owner user, plan free for life.
    const randomPassword = crypto.randomBytes(32).toString('hex');
    const hash = await password.hash(randomPassword);
    const out = transaction(() => {
      const t = db.prepare(
        `INSERT INTO tenants (name, slug, plan, subscription_status)
         VALUES (?, ?, 'influencer', 'active')`
      ).run(displayName || cleanEmail, makeSlug(cleanEmail));
      const tenantId = Number(t.lastInsertRowid);
      const u = db.prepare(
        'INSERT INTO users (tenant_id, email, password_hash, display_name, role, email_verified_at) VALUES (?, ?, ?, ?, \'owner\', ?)'
      ).run(tenantId, cleanEmail, hash, displayName, utcNow());
      const userId = Number(u.lastInsertRowid);
      logEvent('provisioned', cleanEmail, tenantId, userId,
        abId ? `armor_bearer_id=${abId}` : 'new influencer tenant');
      return { tenant_id: tenantId, user_id: userId };
    });
    // eslint-disable-next-line no-console
    console.log(`[influencer-webhook] provisioned email=${cleanEmail} tenant=${out.tenant_id}`);
    return res.status(201).json({ ok: true, result: 'provisioned', email: cleanEmail, tenant_id: out.tenant_id });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[influencer-webhook] error for email=${cleanEmail}: ${e.message}`);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}

module.exports = handler;
