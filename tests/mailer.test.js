'use strict';
/**
 * Mailer tests:
 *  - Stub mode (no AWS env): sendMail/verificationEmail/passwordResetEmail
 *    log + record to the outbox, return { ok, stubbed: true }.
 *  - Config: sesConfigured flag reflects env; production refuses to boot
 *    without SES configured (fail-fast, so signup email can't silently die).
 *
 * Real SES delivery is NOT exercised here (needs credentials + network).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

process.env.NODE_ENV = 'test';

const MAILER_PATH = require.resolve('../src/lib/mailer');
const CONFIG_PATH = require.resolve('../src/config');

/** Re-require mailer+config after changing env (config reads env at load). */
function freshMailer() {
  delete require.cache[CONFIG_PATH];
  delete require.cache[MAILER_PATH];
  return require(MAILER_PATH);
}

function clearAwsEnv() {
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.SES_FROM_EMAIL;
  delete process.env.AWS_REGION;
}

function nodeEval(js) {
  return execFileSync(process.execPath, ['-e', js], { encoding: 'utf8' });
}

test('stub mode: sendMail records to outbox, sends nothing', async () => {
  clearAwsEnv();
  const mailer = freshMailer();
  assert.equal(mailer.isSesConfigured(), false);
  mailer.clearOutbox();

  const r = await mailer.sendMail({ to: 'a@example.org', subject: 'Hi', text: 'hello' });
  assert.equal(r.ok, true);
  assert.equal(r.stubbed, true);
  assert.match(r.id, /^stub-/);

  const out = mailer.getOutbox();
  assert.equal(out.length, 1);
  assert.equal(out[0].to, 'a@example.org');
  assert.equal(out[0].subject, 'Hi');
  assert.equal(out[0].text, 'hello');
  assert.equal(out[0].stubbed, true);
  assert.ok(out[0].at, 'timestamp recorded');

  mailer.clearOutbox();
  assert.equal(mailer.getOutbox().length, 0);
});

test('stub mode: sendMail requires to and subject', async () => {
  clearAwsEnv();
  const mailer = freshMailer();
  await assert.rejects(() => mailer.sendMail({ to: '', subject: 'x' }), /to and subject are required/);
  await assert.rejects(() => mailer.sendMail({ to: 'a@example.org' }), /to and subject are required/);
});

test('stub mode: verification + reset emails carry the link', async () => {
  clearAwsEnv();
  const mailer = freshMailer();
  mailer.clearOutbox();

  await mailer.verificationEmail('v@example.org', 'https://x.test/verify?token=abc');
  await mailer.passwordResetEmail('p@example.org', 'https://x.test/reset?token=def');

  const out = mailer.getOutbox();
  assert.equal(out.length, 2);
  assert.equal(out[0].to, 'v@example.org');
  assert.equal(out[0].subject, 'Verify your D2RM Dashboard email');
  assert.ok(out[0].text.includes('https://x.test/verify?token=abc'));
  assert.ok(out[0].html.includes('https://x.test/verify?token=abc'));
  assert.equal(out[1].to, 'p@example.org');
  assert.equal(out[1].subject, 'Reset your D2RM Dashboard password');
  assert.ok(out[1].text.includes('https://x.test/reset?token=def'));
});

test('config: sesConfigured true when all three SES vars set (region defaults)', () => {
  const out = nodeEval(`
    process.env.AWS_ACCESS_KEY_ID='AKID';
    process.env.AWS_SECRET_ACCESS_KEY='SECRET';
    process.env.SES_FROM_EMAIL='noreply@example.com';
    const c = require(${JSON.stringify(CONFIG_PATH)});
    console.log(JSON.stringify({ ses: c.sesConfigured, region: c.awsRegion }));
  `);
  const j = JSON.parse(out);
  assert.equal(j.ses, true);
  assert.equal(j.region, 'us-east-1');
});

test('config: sesConfigured false when any SES var missing', () => {
  const out = nodeEval(`
    process.env.AWS_ACCESS_KEY_ID='AKID';
    process.env.AWS_SECRET_ACCESS_KEY='SECRET';
    const c = require(${JSON.stringify(CONFIG_PATH)});
    console.log(JSON.stringify({ ses: c.sesConfigured }));
  `);
  assert.equal(JSON.parse(out).ses, false);
});

test('config: production refuses to boot without SES (fail fast)', () => {
  assert.throws(() => {
    nodeEval(`
      process.env.NODE_ENV='production';
      process.env.APP_BASE_URL='https://example.com';
      require(${JSON.stringify(CONFIG_PATH)});
    `);
  }, /SES is not configured/);
});

test('config: production boots fine with SES configured', () => {
  const out = nodeEval(`
    process.env.NODE_ENV='production';
    process.env.APP_BASE_URL='https://example.com';
    process.env.AWS_ACCESS_KEY_ID='AKID';
    process.env.AWS_SECRET_ACCESS_KEY='SECRET';
    process.env.SES_FROM_EMAIL='noreply@example.com';
    const c = require(${JSON.stringify(CONFIG_PATH)});
    console.log(JSON.stringify({ ses: c.sesConfigured }));
  `);
  assert.equal(JSON.parse(out).ses, true);
});
