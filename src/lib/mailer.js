'use strict';
/**
 * Transactional mailer — Amazon SES when configured, stub otherwise.
 *
 * This module is the single choke point for all transactional mail
 * (verification, password reset).
 *
 * - SES mode: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + SES_FROM_EMAIL
 *   are all set  -> sends via @aws-sdk/client-ses (SendEmail).
 * - Brevo fallback mode: when SES is missing OR a SES send fails, and
 *   BREVO_API_KEY is set -> sends via Brevo's transactional SMTP API.
 *   (Brevo free tier: 300 emails/day — plenty for password resets.)
 * - Stub mode: neither configured -> logs + records to an in-memory
 *   outbox (visible in dev/test). Zero emails sent.
 *
 * Provider chain in sendMail(): SES -> Brevo -> stub.
 * A provider failure is logged loudly and the next provider is tried,
 * so a single broken provider never silently eats transactional mail.
 *
 * API (all async):
 *   sendMail({ to, subject, text, html, campaign, templateKey }) -> { ok, stubbed, id }
 *     campaign/templateKey optional: UTM tags applied to all hrefs before send
 *     (utm_source=manna, utm_medium=email, utm_campaign=campaign|'manna',
 *      utm_content=templateKey). Applies on every provider branch.
 *   tagUtm(html, campaign, templateKey) -> html with UTM-tagged hrefs
 *     (purely additive; skips mailto:/tel:/anchors/already-tagged links)
 *     stubbed=true  -> id is `stub-<ts>-<seq>`
 *     stubbed=false -> id is the SES MessageId
 *   verificationEmail(to, link), passwordResetEmail(to, link)
 *   getOutbox() -> [{ id, to, subject, text, html, at, stubbed }]
 *   clearOutbox()
 *   isSesConfigured() -> bool
 *
 * NOTE: new SES accounts start in the SES SANDBOX — they can only send to
 * verified identities. Request production access in the SES console before
 * expecting mail to reach real users. SES_FROM_EMAIL must be a verified
 * identity (or domain) in the configured AWS_REGION.
 */

const config = require('../config');

const outbox = [];
let seq = 0;
let sesClient = null; // lazily created, resettable for tests

function isSesConfigured() {
  return config.sesConfigured === true;
}

function isBrevoConfigured() {
  return Boolean(process.env.BREVO_API_KEY);
}

/**
 * ------------------------------------------------------------------
 * AUTO UTM TAGGING (Michael's rule: auto UTM tags on ALL outbound).
 *
 * Every outbound email HTML passes through tagUtm() before it leaves,
 * regardless of provider (SES, Brevo, stub). The tagging is purely
 * ADDITIVE — it never rewrites, removes, or breaks existing links:
 *
 *   - appends utm_source=manna, utm_medium=email,
 *     utm_campaign=<campaign key or 'manna'>,
 *     utm_content=<template_key when known>
 *   - preserves existing query strings (?a=1 becomes ?a=1&utm_source=...)
 *   - preserves URL fragments (#section stays at the end)
 *   - SKIPS: mailto:, tel:, javascript:, data:, bare anchors (#...)
 *   - SKIPS links that already carry utm_source/utm_campaign
 *     (idempotent: calling tagUtm twice never double-tags)
 *   - RELATIVE URLs (/verify/abc, verify/abc): resolved against
 *     APP_BASE_URL when set; left untouched when no base is known
 *     (better to leave them than to break them).
 *
 * Usage: tagUtm(html, campaign, templateKey)
 *   campaign    — campaign key, e.g. 'wave4', 'welcome-drip'
 *                 (falls back to 'manna')
 *   templateKey — optional template key, e.g. 'verification'
 *                 (utm_content omitted when unknown)
 * ------------------------------------------------------------------
 */
const UTM_SOURCE = 'manna';
const UTM_MEDIUM = 'email';
const UTM_PARAM_RE = /[?&](utm_source|utm_campaign)=/i;
const SKIPPED_SCHEMES = ['mailto:', 'tel:', 'javascript:', 'data:'];

function buildUtmQuery(campaign, templateKey) {
  const params = [
    `utm_source=${encodeURIComponent(UTM_SOURCE)}`,
    `utm_medium=${encodeURIComponent(UTM_MEDIUM)}`,
    `utm_campaign=${encodeURIComponent(campaign || UTM_SOURCE)}`,
  ];
  if (templateKey) params.push(`utm_content=${encodeURIComponent(templateKey)}`);
  return params.join('&');
}

/** Append UTM query params to one href; returns the href unchanged when it
 *  must not be tagged (skipped scheme, anchor, or already tagged). */
function tagUtmHref(href, campaign, templateKey) {
  if (!href || typeof href !== 'string') return href;
  const raw = href.trim();
  if (!raw) return href;
  const lower = raw.toLowerCase();
  // Skip anchors and non-http schemes — tagging these would corrupt them.
  if (raw.startsWith('#')) return href;
  if (SKIPPED_SCHEMES.some(s => lower.startsWith(s))) return href;
  // Split off the fragment so params land in the query string, not after #.
  const hashIdx = raw.indexOf('#');
  const fragment = hashIdx >= 0 ? raw.slice(hashIdx) : '';
  const withoutFragment = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  // Idempotent: never double-tag a link that already has UTM params.
  if (UTM_PARAM_RE.test(withoutFragment)) return href;
  // Relative URLs: resolve against APP_BASE_URL when available, otherwise
  // leave them alone (don't guess a host — that would break the link).
  let target = withoutFragment;
  const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith('//');
  if (!isAbsolute) {
    if (!config.appBaseUrl) return href;
    try {
      target = new URL(raw, config.appBaseUrl).toString();
    } catch (e) {
      return href; // unparseable relative href — leave untouched
    }
    // new URL() keeps the fragment in place already; strip the one we
    // split off earlier so we don't duplicate it.
    const reHashIdx = target.indexOf('#');
    if (reHashIdx >= 0) target = target.slice(0, reHashIdx);
  }
  const sep = target.includes('?') ? '&' : '?';
  return target + sep + buildUtmQuery(campaign, templateKey) + fragment;
}

/** Rewrite every href in outbound HTML to carry auto UTM tags. */
function tagUtm(html, campaign, templateKey) {
  if (!html || typeof html !== 'string') return html;
  return html.replace(
    /(<a\b[^>]*\bhref\s*=\s*)(["'])(.*?)\2/gi,
    (match, prefix, quote, href) => prefix + quote + tagUtmHref(href, campaign, templateKey) + quote
  );
}

/** No secrets — safe to log at boot. e.g. "ses+brevo", "brevo", "stub". */
function describeProvider() {
  const parts = [];
  if (isSesConfigured()) parts.push('ses');
  if (isBrevoConfigured()) parts.push('brevo');
  if (parts.length === 0) parts.push('stub');
  return parts.join('+');
}

function getSesClient() {
  if (!isSesConfigured()) return null;
  if (!sesClient) {
    const { SESClient } = require('@aws-sdk/client-ses');
    sesClient = new SESClient({
      region: config.awsRegion,
      credentials: {
        accessKeyId: config.awsAccessKeyId,
        secretAccessKey: config.awsSecretAccessKey,
      },
      // Keep request overhead low; SDK defaults are fine otherwise.
      maxAttempts: 3,
    });
  }
  return sesClient;
}

/** Test-only: drop the cached client so env changes take effect. */
function _resetSesClient() {
  sesClient = null;
}

function recordOutbox({ id, to, subject, text, html, stubbed }) {
  const msg = {
    id,
    to,
    subject,
    text: text || '',
    html: html || '',
    at: new Date().toISOString(),
    stubbed,
  };
  outbox.push(msg);
  return msg;
}

async function sendViaSes({ to, subject, text, html, campaign, templateKey }) {
  // Auto-UTM: every SES email leaves tagged — purely additive, never breaks
  // existing links. tagUtm() is idempotent, so no double-tagging on retries.
  const taggedHtml = tagUtm(html, campaign, templateKey);
  const { SendEmailCommand } = require('@aws-sdk/client-ses');
  const cmd = new SendEmailCommand({
    Source: config.sesFromEmail,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: {
        Text: { Data: text || '', Charset: 'UTF-8' },
        ...(taggedHtml ? { Html: { Data: taggedHtml, Charset: 'UTF-8' } } : {}),
      },
    },
  });
  const resp = await getSesClient().send(cmd);
  const msg = recordOutbox({ id: resp.MessageId, to, subject, text, html: taggedHtml, stubbed: false });
  // eslint-disable-next-line no-console
  console.log(`[mailer:ses] to=${to} subject="${subject}" messageId=${resp.MessageId}`);
  return { ok: true, stubbed: false, id: msg.id };
}

function sendViaStub({ to, subject, text, html, campaign, templateKey }) {
  // Auto-UTM on the stub branch too — the outbox mirrors what a real
  // provider would send, so tagged links are testable end-to-end.
  const taggedHtml = tagUtm(html, campaign, templateKey);
  seq += 1;
  const msg = recordOutbox({
    id: `stub-${Date.now()}-${seq}`,
    to, subject, text, html: taggedHtml, stubbed: true,
  });
  // eslint-disable-next-line no-console
  console.log(`[mailer:stub] to=${to} subject="${subject}" id=${msg.id}`);
  return { ok: true, stubbed: true, id: msg.id };
}

/**
 * Brevo transactional fallback (https://api.brevo.com/v3/smtp/email).
 * Env: BREVO_API_KEY (required), BREVO_FROM_EMAIL (optional, falls back
 * to SES_FROM_EMAIL). Free tier = 300 emails/day.
 */
async function sendViaBrevo({ to, subject, text, html, campaign, templateKey }) {
  // Auto-UTM on the Brevo branch — same rule as every other branch.
  const taggedHtml = tagUtm(html, campaign, templateKey);
  const fromEmail = process.env.BREVO_FROM_EMAIL || config.sesFromEmail;
  if (!fromEmail) throw new Error('[mailer:brevo] no from-address (set BREVO_FROM_EMAIL or SES_FROM_EMAIL)');
  const payload = {
    sender: { email: fromEmail },
    to: [{ email: to }],
    subject,
    textContent: text || '',
    ...(taggedHtml ? { htmlContent: taggedHtml } : {}),
  };
  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`[mailer:brevo] HTTP ${resp.status}: ${String(errText).slice(0, 200)}`);
  }
  const data = await resp.json().catch(() => ({}));
  const msg = recordOutbox({
    id: data.messageId || `brevo-${Date.now()}`,
    to, subject, text, html: taggedHtml, stubbed: false,
  });
  // eslint-disable-next-line no-console
  console.log(`[mailer:brevo] to=${to} subject="${subject}" messageId=${msg.id}`);
  return { ok: true, stubbed: false, id: msg.id, provider: 'brevo' };
}

async function sendMail({ to, subject, text, html, campaign, templateKey }) {
  if (!to || !subject) throw new Error('sendMail: to and subject are required');
  // UTM tagging applies to every provider branch below (SES, Brevo, stub):
  // each branch tags its own HTML copy via tagUtm() before sending, so no
  // email leaves untagged. campaign/templateKey are optional — defaults
  // fall back to utm_campaign=manna and no utm_content.
  // 1) SES when configured — but never let one broken provider eat the mail.
  if (isSesConfigured()) {
    try {
      return await sendViaSes({ to, subject, text, html, campaign, templateKey });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[mailer] SES send failed for to=${to}: ${e.message} — trying fallback`);
    }
  }
  // 2) Brevo transactional fallback when configured.
  if (isBrevoConfigured()) {
    try {
      return await sendViaBrevo({ to, subject, text, html, campaign, templateKey });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[mailer] Brevo send failed for to=${to}: ${e.message} — falling back to stub`);
    }
  }
  // 3) Stub: logs + in-memory outbox, zero emails sent.
  // eslint-disable-next-line no-console
  console.error(`[mailer] NO working provider for to=${to} subject="${subject}" — stubbed (check SES/Brevo config)`);
  return sendViaStub({ to, subject, text, html, campaign, templateKey });
}

function getOutbox() {
  return outbox.slice();
}

function clearOutbox() {
  outbox.length = 0;
}

function verificationEmail(to, link, opts = {}) {
  return sendMail({
    to,
    subject: 'Verify your D2RM Dashboard email',
    text: `Welcome to D2RM Dashboard — big agency data, little guy money.\n\nVerify your email: ${link}\n\nThis link expires in 24 hours.`,
    html: `<p>Welcome to <strong>D2RM Dashboard</strong> — big agency data, little guy money.</p>`
      + `<p><a href="${link}">Verify your email address</a></p>`
      + `<p>This link expires in 24 hours.</p>`,
    campaign: opts.campaign || 'verification',
    templateKey: opts.templateKey || 'verification',
  });
}

function passwordResetEmail(to, link, opts = {}) {
  return sendMail({
    to,
    subject: 'Reset your D2RM Dashboard password',
    text: `Reset your password: ${link}\n\nThis link expires in 1 hour. If you didn't ask for this, ignore it.`,
    html: `<p><a href="${link}">Reset your D2RM Dashboard password</a></p>`
      + `<p>This link expires in 1 hour. If you didn't ask for this, ignore this email.</p>`,
    campaign: opts.campaign || 'password-reset',
    templateKey: opts.templateKey || 'password-reset',
  });
}

module.exports = {
  sendMail,
  tagUtm,
  getOutbox,
  clearOutbox,
  verificationEmail,
  passwordResetEmail,
  isSesConfigured,
  isBrevoConfigured,
  describeProvider,
  _resetSesClient,
};
