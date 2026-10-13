'use strict';
/**
 * Transactional mailer — Amazon SES when configured, stub otherwise.
 *
 * This module is the single choke point for all transactional mail
 * (verification, password reset).
 *
 * - SES mode: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + SES_FROM_EMAIL
 *   are all set  -> sends via @aws-sdk/client-ses (SendEmail).
 * - Stub mode: any of the above missing -> logs + records to an in-memory
 *   outbox (visible in dev/test). Zero emails sent.
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

async function sendMail({ to, subject, text, html }) {
  if (!to || !subject) throw new Error('sendMail: to and subject are required');
  if (isSesConfigured()) {
    return sendViaSes({ to, subject, text, html });
  }
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
  _resetSesClient,
};
