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
 *
 * The armor_bearer_id (the affiliate's AB ref_code) is also persisted on
 * the tenant (migration 024) so GET /api/auth/me can hand the affiliate
 * their referral link. Only pattern-valid codes are stored
 * (src/lib/referral.js) — a poisoned value stores NULL. Re-provisioning
 * with a different valid code updates the stored value; a call WITHOUT a
 * code never clears an existing one.
 *
 * Every outcome additionally runs the affiliate arsenal seed
 * (src/lib/arsenalSeed.js): the tenant is topped up to the full 13,871
 * master contacts, idempotently. Synchronous — measured ~0.3s for the
 * full 13,871-row transaction, well inside the caller's retry window,
 * and it guarantees the arsenal is present before the affiliate's
 * first login. Seed errors are logged, never fail the provisioning
 * response.
 */
const crypto = require('crypto');
const { db, transaction } = require('../db');
const password = require('../lib/password');
const { normalizeRefCode } = require('../lib/referral');

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

/**
 * "Loaded guns" (Michael, 2026-10-25): an influencer tenant arrives
 * PRELOADED with the full D2RM contact arsenal (src/lib/arsenalSeed.js).
 * Runs after provisioning commits, on EVERY outcome — a replay therefore
 * also repairs a tenant whose earlier seed failed. Idempotent: a fully
 * seeded tenant fast-paths and inserts 0. A seed failure must never fail
 * provisioning (the tenant + login already exist; the seed tops up on
 * the next webhook call or via scripts/seed_affiliate_arsenal.js), so
 * errors are logged, never thrown.
 */
function seedArsenal(tenantId, email) {
  try {
    const { seedArsenalForTenant } = require('../lib/arsenalSeed');
    const started = Date.now();
    const r = seedArsenalForTenant(db, tenantId);
    // eslint-disable-next-line no-console
    console.log(`[influencer-webhook] arsenal seed email=${email} tenant=${tenantId} ` +
      `inserted=${r.inserted} adopted=${r.adopted} already=${r.already} total=${r.total} ` +
      `complete=${r.complete} (${Date.now() - started}ms)`);
    return r.complete;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[influencer-webhook] arsenal seed FAILED email=${email} tenant=${tenantId}: ${e.message}`);
    return false;
  }
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
  // The value persisted on the tenant: strictly validated (letters/digits
  // only). Anything else — quotes, slashes, a scheme — stores as NULL so
  // it can never be turned into a referral link later.
  const storedAbId = normalizeRefCode(armor_bearer_id);

  try {
    // Idempotency: email is globally unique in users.
    const existing = db.prepare(
      'SELECT u.id AS user_id, u.tenant_id, t.plan FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.email = ?'
    ).get(cleanEmail);

    if (existing) {
      if (existing.plan === 'influencer') {
        transaction(() => {
          if (storedAbId) {
            db.prepare('UPDATE tenants SET armor_bearer_id = ?, updated_at = ? WHERE id = ?')
              .run(storedAbId, utcNow(), existing.tenant_id);
          }
          logEvent('already_provisioned', cleanEmail, existing.tenant_id, existing.user_id,
            abId ? `armor_bearer_id=${abId}` : null);
        });
        seedArsenal(existing.tenant_id, cleanEmail);
        return res.json({ ok: true, result: 'already_provisioned', email: cleanEmail, tenant_id: existing.tenant_id });
      }
      // Existing customer upgraded to the free-for-life influencer plan.
      const out = transaction(() => {
        db.prepare("UPDATE tenants SET plan = 'influencer', subscription_status = 'active', updated_at = ? WHERE id = ?")
          .run(utcNow(), existing.tenant_id);
        if (storedAbId) {
          db.prepare('UPDATE tenants SET armor_bearer_id = ? WHERE id = ?')
            .run(storedAbId, existing.tenant_id);
        }
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
      seedArsenal(out.tenant_id, cleanEmail);
      return res.json({ ok: true, result: 'plan_upgraded', email: cleanEmail, tenant_id: out.tenant_id });
    }

    // New influencer: tenant + owner user, plan free for life.
    const randomPassword = crypto.randomBytes(32).toString('hex');
    const hash = await password.hash(randomPassword);
    const out = transaction(() => {
      const t = db.prepare(
        `INSERT INTO tenants (name, slug, plan, subscription_status, armor_bearer_id)
         VALUES (?, ?, 'influencer', 'active', ?)`
      ).run(displayName || cleanEmail, makeSlug(cleanEmail), storedAbId);
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
    seedArsenal(out.tenant_id, cleanEmail);
    return res.status(201).json({ ok: true, result: 'provisioned', email: cleanEmail, tenant_id: out.tenant_id });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[influencer-webhook] error for email=${cleanEmail}: ${e.message}`);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}

module.exports = handler;
