'use strict';
/**
 * Mailer tests:
 *  - Stub mode (no AWS env): sendMail/verificationEmail/passwordResetEmail
 *    log + record to the outbox, return { ok, stubbed: true }.
 *  - Config: sesConfigured flag reflects env; production refuses to boot
 *    without the SES trio configured (fail-fast, so signup email can't
 *    silently die). SES is Manna's ONLY mail provider: Brevo was removed
 *    entirely on 2026-10-29 by Michael's decision (an earlier audit-B4
 *    revision had accepted BREVO_API_KEY as an alternative — that contract
 *    is gone; BREVO_API_KEY alone must NOT boot production).
 *  - SES send failure: sendMail falls to the stub and reports
 *    stubbed=true — a failed send is never reported as a real send.
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

// SES-only contract (2026-10-29): production refuses to boot when the SES
// trio is not configured. BREVO_API_KEY is not a mail path anymore.
test('config: production refuses to boot without the SES trio (fail fast)', () => {
  assert.throws(() => {
    nodeEval(`
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.SES_FROM_EMAIL;
      process.env.NODE_ENV='production';
      process.env.APP_BASE_URL='https://example.com';
      require(${JSON.stringify(CONFIG_PATH)});
    `);
  }, /No transactional mail provider is configured/);
});

// SES-only contract (2026-10-29): a leftover BREVO_API_KEY must NOT satisfy
// the production boot gate — Brevo is not a Manna dependency.
test('config: production refuses to boot with BREVO_API_KEY only (SES-only rule)', () => {
  assert.throws(() => {
    nodeEval(`
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.SES_FROM_EMAIL;
      process.env.NODE_ENV='production';
      process.env.APP_BASE_URL='https://example.com';
      process.env.BREVO_API_KEY='leftover-key';
      require(${JSON.stringify(CONFIG_PATH)});
    `);
  }, /No transactional mail provider is configured/);
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

// SES-only contract (2026-10-29): the Brevo provider is gone from the
// mailer entirely — no export, and describeProvider never names it.
test('mailer: no Brevo provider remains (SES-only)', () => {
  clearAwsEnv();
  const mailer = freshMailer();
  assert.equal(mailer.isBrevoConfigured, undefined);
  assert.equal(mailer.describeProvider(), 'stub');
});

// SES failure contract: when the SES send throws, sendMail must fall to the
// stub and report stubbed=true — never a fake success. The AWS SDK is
// replaced in the module cache with a test double whose send() throws, so
// no network or real credentials are involved.
test('SES failure: sendMail falls to stub and reports stubbed=true (never fake success)', async () => {
  process.env.AWS_ACCESS_KEY_ID = 'AKID';
  process.env.AWS_SECRET_ACCESS_KEY = 'SECRET';
  process.env.SES_FROM_EMAIL = 'noreply@example.com';
  const sesPath = require.resolve('@aws-sdk/client-ses');
  const realSesEntry = require.cache[sesPath];
  require.cache[sesPath] = {
    id: sesPath,
    filename: sesPath,
    loaded: true,
    exports: {
      SESClient: class {
        async send() { throw new Error('SES boom (test double)'); }
      },
      SendEmailCommand: class {
        constructor(input) { this.input = input; }
      },
    },
  };
  try {
    const mailer = freshMailer();
    assert.equal(mailer.isSesConfigured(), true);
    assert.equal(mailer.describeProvider(), 'ses');
    mailer.clearOutbox();

    const r = await mailer.sendMail({ to: 'f@example.org', subject: 'Failover', text: 'x' });
    assert.equal(r.ok, true);
    assert.equal(r.stubbed, true, 'failed SES send must be reported as stubbed, not sent');
    assert.match(r.id, /^stub-/);

    const out = mailer.getOutbox();
    assert.equal(out.length, 1);
    assert.equal(out[0].stubbed, true);
  } finally {
    if (realSesEntry) require.cache[sesPath] = realSesEntry;
    else delete require.cache[sesPath];
    delete require.cache[MAILER_PATH];
    delete require.cache[CONFIG_PATH];
    clearAwsEnv();
  }
});
