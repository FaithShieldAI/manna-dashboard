'use strict';
/**
 * Scribe send-time optimization interface — STUBBED until the Anthropic key
 * lands (see config.anthropicApiKey, same pattern as src/lib/assistant.js).
 *
 * PURPOSE: pick the best wall-clock time to send a campaign/drip step for
 * each recipient, so scheduled sends go out at the moment the recipient is
 * most likely to engage. The REAL implementation (post-Anthropic) will be
 * Scribe: it reads the tenant's send history + recipient engagement signals
 * from the dashboard and returns a data-backed sendAt per recipient.
 *
 * STABLE INTERFACE — callers (src/routes/drips.js, scheduled-send workers)
 * must not change when the real Scribe implementation drops in. The shape
 * below is the contract:
 *
 *   await optimalSendTime({ tenantId, audience, product, history })
 *     -> Promise<{ sendAt, confidence, reason }>
 *
 *     tenantId   string|number — tenant owning the send
 *     audience   string|null   — audience key: 'influencer' | 'pastor' |
 *                               'church' | 'school' | 'individual' |
 *                               'podcast' | 'organization'
 *     product    string|null   — product key: 'faithshield' | 'manna' |
 *                               'sustained' | 'armor-bearer'
 *     history    array|null    — per-recipient engagement history; the real
 *                               Scribe consumes this, the stub ignores it.
 *
 *     sendAt     ISO 8601 string (UTC) — when to send
 *     confidence 'stub' | 'low' | 'medium' | 'high'
 *     reason     human-readable one-liner explaining the choice
 */

/**
 * Placeholder timezone. The stub uses America/New_York for the "recipient
 * local" 09:00 default. The real Scribe implementation will pick the
 * recipient's own timezone from their profile/enrichment data instead.
 */
const PLACEHOLDER_TIMEZONE = 'America/New_York';
const PLACEHOLDER_HOUR = 9; // 09:00 local

/** Mirror of the Scribe wiring state (same source as assistant.js). */
function isScribeConnected() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Offset in minutes between UTC and the given IANA timezone at `date`. */
function tzOffsetMinutes(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

/**
 * Stub default: next occurrence of 09:00 in PLACEHOLDER_TIMEZONE, returned
 * as a UTC ISO string. If 09:00 today has already passed (plus a 30-minute
 * buffer so we never schedule in the past), rolls to tomorrow. Recomputes
 * the timezone offset at the target time so DST boundaries are handled.
 */
function stubNextNineAmUtc() {
  const now = new Date();
  const offNow = tzOffsetMinutes(now, PLACEHOLDER_TIMEZONE);
  // Represent "current time in the placeholder timezone" as a UTC timestamp.
  const tzNow = new Date(now.getTime() + offNow * 60000);
  let targetTz = Date.UTC(
    tzNow.getUTCFullYear(), tzNow.getUTCMonth(), tzNow.getUTCDate(),
    PLACEHOLDER_HOUR, 0, 0
  );
  if (targetTz <= tzNow.getTime() + 30 * 60000) {
    targetTz += 24 * 3600 * 1000; // already past 09:00 — send tomorrow
  }
  const offTarget = tzOffsetMinutes(new Date(targetTz - offNow * 60000), PLACEHOLDER_TIMEZONE);
  return new Date(targetTz - offTarget * 60000).toISOString();
}

async function optimalSendTime({ tenantId, audience, product, history } = {}) {
  // Keep the caller's inputs visible in debug logs without leaking PII.
  // eslint-disable-next-line no-console
  if (process.env.DEBUG_SENDTIME) {
    console.log('[sendtime:stub] optimalSendTime',
      JSON.stringify({ tenantId, audience, product, historyLen: Array.isArray(history) ? history.length : 0 }));
  }
  // STUB: Scribe is not connected — deterministic default, no network,
  // no per-recipient learning. Safe for any caller to use today.
  return {
    sendAt: stubNextNineAmUtc(),
    confidence: 'stub',
    reason: 'Scribe not connected — using default 09:00 recipient-local',
  };
}

/**
 * ------------------------------------------------------------------
 * DRIP / SCHEDULING HOOK — call this from src/routes/drips.js.
 *
 * DO NOT edit drips.js in this file (another worker owns it). The hook
 * is ready; wire it into the drip step scheduler like this:
 *
 *   const { suggestSendAt } = require('../lib/sendtime');
 *
 *   // when a drip step (or scheduled campaign) is due:
 *   const { sendAt, confidence, reason } = await suggestSendAt({
 *     tenantId,                 // tenant owning the drip
 *     audience,                 // audience key, e.g. 'influencer'
 *     product,                  // product key, e.g. 'manna'
 *     history,                  // optional: recipient engagement history
 *   });
 *   // `sendAt` is an ISO 8601 UTC string — schedule the send job for it.
 *   // `confidence` is 'stub' until the Anthropic key lands and the real
 *   // Scribe implementation is dropped in; callers need not change.
 *
 * Today this routes straight to optimalSendTime (same signature); the
 * indirection keeps drips.js decoupled from the Scribe interface and
 * lets future logic (e.g. per-audience overrides) live here.
 * ------------------------------------------------------------------
 */
async function suggestSendAt(opts) {
  return optimalSendTime(opts);
}

module.exports = {
  optimalSendTime,
  suggestSendAt,
  isScribeConnected,
  // exported for tests/debug only — not part of the caller contract
  _placeholder: { PLACEHOLDER_TIMEZONE, PLACEHOLDER_HOUR },
};
