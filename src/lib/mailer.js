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
 *   sendMail({ to, subject, text, html }) -> { ok, stubbed, id }
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

async function sendViaSes({ to, subject, text, html }) {
  const { SendEmailCommand } = require('@aws-sdk/client-ses');
  const cmd = new SendEmailCommand({
    Source: config.sesFromEmail,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: {
        Text: { Data: text || '', Charset: 'UTF-8' },
        ...(html ? { Html: { Data: html, Charset: 'UTF-8' } } : {}),
      },
    },
  });
  const resp = await getSesClient().send(cmd);
  const msg = recordOutbox({ id: resp.MessageId, to, subject, text, html, stubbed: false });
  // eslint-disable-next-line no-console
  console.log(`[mailer:ses] to=${to} subject="${subject}" messageId=${resp.MessageId}`);
  return { ok: true, stubbed: false, id: msg.id };
}

function sendViaStub({ to, subject, text, html }) {
  seq += 1;
  const msg = recordOutbox({
    id: `stub-${Date.now()}-${seq}`,
    to, subject, text, html, stubbed: true,
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
async function sendViaBrevo({ to, subject, text, html }) {
  const fromEmail = process.env.BREVO_FROM_EMAIL || config.sesFromEmail;
  if (!fromEmail) throw new Error('[mailer:brevo] no from-address (set BREVO_FROM_EMAIL or SES_FROM_EMAIL)');
  const payload = {
    sender: { email: fromEmail },
    to: [{ email: to }],
    subject,
    textContent: text || '',
    ...(html ? { htmlContent: html } : {}),
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
    to, subject, text, html, stubbed: false,
  });
  // eslint-disable-next-line no-console
  console.log(`[mailer:brevo] to=${to} subject="${subject}" messageId=${msg.id}`);
  return { ok: true, stubbed: false, id: msg.id, provider: 'brevo' };
}

async function sendMail({ to, subject, text, html }) {
  if (!to || !subject) throw new Error('sendMail: to and subject are required');
  // 1) SES when configured — but never let one broken provider eat the mail.
  if (isSesConfigured()) {
    try {
      return await sendViaSes({ to, subject, text, html });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[mailer] SES send failed for to=${to}: ${e.message} — trying fallback`);
    }
  }
  // 2) Brevo transactional fallback when configured.
  if (isBrevoConfigured()) {
    try {
      return await sendViaBrevo({ to, subject, text, html });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[mailer] Brevo send failed for to=${to}: ${e.message} — falling back to stub`);
    }
  }
  // 3) Stub: logs + in-memory outbox, zero emails sent.
  // eslint-disable-next-line no-console
  console.error(`[mailer] NO working provider for to=${to} subject="${subject}" — stubbed (check SES/Brevo config)`);
  return sendViaStub({ to, subject, text, html });
}

function getOutbox() {
  return outbox.slice();
}

function clearOutbox() {
  outbox.length = 0;
}

function verificationEmail(to, link) {
  return sendMail({
    to,
    subject: 'Verify your D2RM Dashboard email',
    text: `Welcome to D2RM Dashboard — big agency data, little guy money.\n\nVerify your email: ${link}\n\nThis link expires in 24 hours.`,
    html: `<p>Welcome to <strong>D2RM Dashboard</strong> — big agency data, little guy money.</p>`
      + `<p><a href="${link}">Verify your email address</a></p>`
      + `<p>This link expires in 24 hours.</p>`,
  });
}

function passwordResetEmail(to, link) {
  return sendMail({
    to,
    subject: 'Reset your D2RM Dashboard password',
    text: `Reset your password: ${link}\n\nThis link expires in 1 hour. If you didn't ask for this, ignore it.`,
    html: `<p><a href="${link}">Reset your D2RM Dashboard password</a></p>`
      + `<p>This link expires in 1 hour. If you didn't ask for this, ignore this email.</p>`,
  });
}

module.exports = {
  sendMail,
  getOutbox,
  clearOutbox,
  verificationEmail,
  passwordResetEmail,
  isSesConfigured,
  isBrevoConfigured,
  describeProvider,
  _resetSesClient,
};
