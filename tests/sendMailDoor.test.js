'use strict';
/**
 * Send mail door: POST /api/auth/send-mail/:token is guarded by the
 * MIGRATION_TOKEN pattern AND, since 2026-11-17, by a send lock proof.
 * The door refuses (403, lock_proof_*) any request whose lockProof is
 * missing, whose subject/body/list hashes do not match the mail in
 * hand, whose tracking version is empty, or whose not-before time has
 * not arrived. The proof scheme matches ~/workspace/press/send_lock.py:
 * SHA-256 hex over the UTF-8 bytes of the subject string, the body
 * string, and the raw recipients.csv text. SES is not configured in
 * tests, so a request the door ACCEPTS reaches the mailer stub and
 * comes back 502 send_stubbed, with the message in the mailer outbox;
 * that is how acceptance is asserted without sending real mail.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
process.env.MIGRATION_TOKEN = ['door', 'test', 'token'].join('-');

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const CSV = [
  'outlet,email,version,body_file,subject',
  'Example Outlet,person@example.org,V1,body-1.txt,Hello there',
  'Other Outlet,other@example.org,V1,body-2.txt,Hello there',
  '',
].join('\n');

const MAIL = {
  to: 'person@example.org',
  subject: 'Hello there',
  text: 'This is the locked body text.',
  campaign: 'door-test-campaign',
  templateKey: 'door-test-campaign',
};

function validProof(overrides = {}) {
  return {
    order_id: 'door-test-order',
    recipients_sha256: sha(CSV),
    recipients_csv: CSV,
    body_sha256: sha(MAIL.text),
    subject_sha256: sha(MAIL.subject),
    version: 'V1',
    not_before: '2020-01-01T00:00:00Z',
    ...overrides,
  };
}

function post(body, token = process.env.MIGRATION_TOKEN) {
  return client(base).post(`/api/auth/send-mail/${token}`, body);
}

test('send-mail door still refuses a wrong migration token first', async () => {
  const r = await post({ ...MAIL, lockProof: validProof() }, 'wrong-token');
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'forbidden');
});

test('send-mail door refuses a request with no lock proof', async () => {
  const r = await post({ ...MAIL });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'lock_proof_missing');
});

test('send-mail door refuses an empty tracking version', async () => {
  const r = await post({ ...MAIL, lockProof: validProof({ version: '  ' }) });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'lock_proof_version_empty');
});

test('send-mail door refuses a send before its not-before time', async () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const r = await post({ ...MAIL, lockProof: validProof({ not_before: future }) });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'lock_proof_too_early');
});

test('send-mail door refuses a subject that differs from the proof', async () => {
  const r = await post({
    ...MAIL,
    subject: 'A different subject entirely',
    lockProof: validProof(),
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'lock_proof_subject_mismatch');
});

test('send-mail door refuses a body that differs from the proof', async () => {
  const r = await post({
    ...MAIL,
    text: 'Tampered words that were never locked.',
    lockProof: validProof(),
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'lock_proof_body_mismatch');
});

test('send-mail door refuses a recipients list that differs from its hash', async () => {
  const tampered = CSV.replace('person@example.org', 'attacker@example.org');
  const r = await post({
    ...MAIL,
    lockProof: validProof({ recipients_csv: tampered }),
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'lock_proof_recipients_mismatch');
});

test('send-mail door refuses a recipient who is not on the locked list', async () => {
  const r = await post({
    ...MAIL,
    to: 'stranger@example.org',
    lockProof: validProof(),
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'lock_proof_recipients_mismatch');
});

test('send-mail door accepts a valid proof and hands the mail to the mailer', async () => {
  const mailer = require('../src/lib/mailer');
  mailer.clearOutbox();
  const r = await post({ ...MAIL, lockProof: validProof() });
  // SES is unconfigured in tests: acceptance shows as the mailer stub
  // result (502 send_stubbed), never as a lock refusal.
  assert.equal(r.status, 502);
  assert.equal(r.json.error, 'send_stubbed');
  const out = mailer.getOutbox();
  assert.equal(out.length, 1);
  assert.equal(out[0].to, MAIL.to);
  assert.equal(out[0].subject, MAIL.subject);
  assert.equal(out[0].text, MAIL.text);
  assert.equal(out[0].stubbed, true);
});

test('a refused request never reaches the mailer outbox', async () => {
  const mailer = require('../src/lib/mailer');
  mailer.clearOutbox();
  const r = await post({ ...MAIL });
  assert.equal(r.status, 403);
  assert.equal(mailer.getOutbox().length, 0);
});
