'use strict';
/**
 * Guided onboarding tests.
 *  - fresh tenant: 5 steps, welcome current, 0% complete
 *  - welcome / dismiss / restart transitions
 *  - social connect: validation, encrypted token storage, isolation
 *  - starter templates: library shape, install, idempotent reinstall
 *  - first lead job + first campaign complete their steps
 *  - full walk-through reaches 100% / is_complete
 *  - assistant is onboarding-aware (greeting guides; next-actions intact)
 *  - socialTokens encrypt/decrypt round-trip
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

// Require AFTER setupTestEnv so modules pick up the test DATABASE_PATH.
const { db } = require('../src/db');
const socialTokens = require('../src/lib/socialTokens');
const starter = require('../src/lib/starterTemplates');

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

async function register(email, company) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: company || ('Onboard Co ' + email), email, password: 'onboard-secret-1234',
  });
  assert.equal(r.status, 201);
  return { c, tenantId: r.json.tenant.id };
}

async function status(c) {
  const r = await c.get('/api/onboarding/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  return r.json.onboarding;
}

test('fresh tenant starts at step 1, 0% complete', async () => {
  const { c } = await register('fresh-ob@example.org');
  const ob = await status(c);
  assert.equal(ob.steps.length, 5);
  assert.deepEqual(ob.steps.map(s => s.id),
    ['welcome', 'connect_socials', 'starter_content', 'first_lead_job', 'first_campaign']);
  assert.ok(ob.steps.every(s => s.done === false));
  assert.equal(ob.current_step, 'welcome');
  assert.equal(ob.progress_pct, 0);
  assert.equal(ob.is_complete, false);
  assert.ok(ob.next_step && ob.next_step.id === 'welcome');
});

test('welcome / dismiss / restart transitions', async () => {
  const { c } = await register('trans-ob@example.org');
  let ob = (await c.post('/api/onboarding/welcome', {})).json.onboarding;
  assert.equal(ob.steps[0].done, true);
  assert.equal(ob.current_step, 'connect_socials');
  assert.equal(ob.progress_pct, 20);

  ob = (await c.post('/api/onboarding/dismiss', {})).json.onboarding;
  assert.equal(ob.is_complete, true);
  assert.equal(ob.dismissed, true);

  ob = (await c.post('/api/onboarding/restart', {})).json.onboarding;
  assert.equal(ob.is_complete, false);
  assert.equal(ob.dismissed, false);
  assert.equal(ob.current_step, 'welcome');
  assert.equal(ob.progress_pct, 0);
});

test('social connect validates input and stores encrypted tokens', async () => {
  const { c, tenantId } = await register('soc-ob@example.org');

  const badPlat = await c.post('/api/onboarding/socials', { platform: 'myspace', handle: 'x' });
  assert.equal(badPlat.status, 400);
  assert.equal(badPlat.json.error, 'invalid_platform');

  const badHandle = await c.post('/api/onboarding/socials', { platform: 'instagram', handle: '   ' });
  assert.equal(badHandle.status, 400);

  const badChars = await c.post('/api/onboarding/socials', { platform: 'instagram', handle: 'a b!' });
  assert.equal(badChars.status, 400);

  // Handle-only connect (no token yet).
  const r1 = await c.post('/api/onboarding/socials', { platform: 'instagram', handle: '@creatorjane' });
  assert.equal(r1.status, 201);
  assert.equal(r1.json.social.platform, 'instagram');
  assert.equal(r1.json.social.handle, 'creatorjane'); // leading @ stripped
  assert.equal(r1.json.social.has_token, false);
  // No token material anywhere in the API response.
  assert.ok(!('access_token_enc' in r1.json.social));
  assert.ok(!('refresh_token_enc' in r1.json.social));

  // Token connect: encrypted at rest, round-trips through decrypt.
  const r2 = await c.post('/api/onboarding/socials', {
    platform: 'youtube', handle: 'CreatorJane', access_token: 'sekrit-token-123',
  });
  assert.equal(r2.status, 201);
  assert.equal(r2.json.social.has_token, true);

  const row = db.prepare(
    'SELECT access_token_enc FROM connected_socials WHERE tenant_id = ? AND platform = ?'
  ).get(tenantId, 'youtube');
  assert.ok(row.access_token_enc.startsWith('gcm:'));
  assert.ok(!row.access_token_enc.includes('sekrit-token-123'));
  assert.equal(socialTokens.decryptToken(row.access_token_enc), 'sekrit-token-123');

  // Onboarding step completes; dashboard social_accounts mirrored.
  const ob = await status(c);
  const step = ob.steps.find(s => s.id === 'connect_socials');
  assert.equal(step.done, true);
  const acct = db.prepare(
    'SELECT handle FROM social_accounts WHERE tenant_id = ? AND platform = ?'
  ).get(tenantId, 'instagram');
  assert.equal(acct.handle, 'creatorjane');

  // Disconnect works; unknown platform 404s.
  const del = await c.del('/api/onboarding/socials/instagram');
  assert.equal(del.status, 200);
  const gone = await c.del('/api/onboarding/socials/instagram');
  assert.equal(gone.status, 404);
});

test('connected socials are tenant-isolated', async () => {
  const { c: cA } = await register('iso-soc-a@example.org', 'Iso A');
  await cA.post('/api/onboarding/socials', { platform: 'tiktok', handle: 'secret_tiktoker' });
  const { c: cB } = await register('iso-soc-b@example.org', 'Iso B');
  const list = await cB.get('/api/onboarding/socials');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.socials, []);
  const obB = await status(cB);
  assert.equal(obB.steps.find(s => s.id === 'connect_socials').done, false);
});

test('starter template library installs and completes the step', async () => {
  const { c } = await register('tpl-ob@example.org');

  const lib = await c.get('/api/onboarding/templates');
  assert.equal(lib.status, 200);
  assert.equal(lib.json.library.email.length, 8);
  assert.equal(lib.json.library.social.length, 6);
  assert.ok(lib.json.library.email.every(t => t.subject && t.body_html && t.body_text));

  const inst = await c.post('/api/onboarding/templates/install', { email: ['welcome-1', 'launch', 'nope'], social: ['launch-post'] });
  assert.equal(inst.status, 201);
  assert.equal(inst.json.installed.email, 2); // 'nope' ignored
  assert.equal(inst.json.installed.social, 1);

  // Reinstalling the same keys installs nothing new (idempotent).
  const again = await c.post('/api/onboarding/templates/install', { email: ['welcome-1'], social: [] });
  assert.equal(again.json.installed.email, 0);

  const bad = await c.post('/api/onboarding/templates/install', {});
  assert.equal(bad.status, 400);

  const ob = await status(c);
  assert.equal(ob.steps.find(s => s.id === 'starter_content').done, true);

  // Starter content is actually usable copy.
  const tpl = db.prepare(
    'SELECT subject FROM email_templates WHERE tenant_id = (SELECT tenant_id FROM users WHERE email = ?) AND template_key = ?'
  ).get('tpl-ob@example.org', 'welcome-1');
  assert.match(tpl.subject, /Welcome/);
});

test('install-all installs the whole library', async () => {
  const { c } = await register('all-ob@example.org');
  const r = await c.post('/api/onboarding/templates/install-all', {});
  assert.equal(r.status, 201);
  assert.equal(r.json.installed.email, 8);
  assert.equal(r.json.installed.social, 6);
});

test('first lead job and first campaign complete their steps', async () => {
  const { c } = await register('job-ob@example.org');

  // Campaign validation first.
  const bad = await c.post('/api/email/campaigns', { name: '  ' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_name');

  const camp = await c.post('/api/email/campaigns', { name: 'November launch', provider: 'ses' });
  assert.equal(camp.status, 201);
  assert.equal(camp.json.campaign.name, 'November launch');

  // Lead job: create only (no auto_run — no network in tests).
  const job = await c.post('/api/leads/jobs', { source: 'youtube', keywords: ['fitness coach'] });
  assert.equal(job.status, 201);

  const ob = await status(c);
  assert.equal(ob.steps.find(s => s.id === 'first_lead_job').done, true);
  assert.equal(ob.steps.find(s => s.id === 'first_campaign').done, true);
});

test('full walk-through reaches 100% complete', async () => {
  const { c } = await register('full-ob@example.org');
  await c.post('/api/onboarding/welcome', {});
  await c.post('/api/onboarding/socials', { platform: 'instagram', handle: 'fullwalk' });
  await c.post('/api/onboarding/templates/install-all', {});
  await c.post('/api/leads/jobs', { source: 'weblist', seeds: ['https://example.com'] });
  await c.post('/api/email/campaigns', { name: 'First blast' });

  const ob = await status(c);
  assert.ok(ob.steps.every(s => s.done));
  assert.equal(ob.progress_pct, 100);
  assert.equal(ob.is_complete, true);
  assert.equal(ob.current_step, null);
  assert.equal(ob.next_step, null);
});

test('assistant greeting guides a fresh tenant through setup', async () => {
  const { c } = await register('greet-ob@example.org');
  const r = await c.post('/api/assistant/chat', { message: 'hi' });
  assert.equal(r.status, 200);
  assert.match(r.json.reply, /set up/i);
  assert.match(r.json.reply, /step 1 of 5/i);
  assert.match(r.json.reply, /Welcome/);
});

test('assistant next-actions still work mid-onboarding (regression)', async () => {
  const { c, tenantId } = await register('next-ob@example.org');
  db.prepare(`INSERT INTO email_snapshots (tenant_id, window_key, sent, opens, clicks)
              VALUES (?, 'all', 2000, 300, 20)`).run(tenantId);
  const r = await c.post('/api/assistant/chat', { message: 'what should I do next?' });
  assert.equal(r.status, 200);
  assert.match(r.json.reply, /next actions/i);
  assert.match(r.json.reply, /subject/i); // open rate 15% -> subject-line action
  assert.match(r.json.reply, /Setup:/); // onboarding nudge present
});

test('assistant briefing nudges setup when onboarding is incomplete', async () => {
  const { c } = await register('brief-ob@example.org');
  const r = await c.post('/api/assistant/chat', { message: 'give me an overview of things' });
  assert.equal(r.status, 200);
  assert.match(r.json.reply, /Setup:/);
  assert.match(r.json.reply, /Quick briefing/);
});

test('unauthenticated onboarding endpoints are rejected', async () => {
  const c = client(base);
  const s = await c.get('/api/onboarding/status');
  assert.equal(s.status, 401);
  const p = await c.post('/api/onboarding/welcome', {});
  assert.equal(p.status, 401);
});

test('socialTokens encrypt/decrypt round-trip; malformed blobs rejected', () => {
  const pt = 'token-abc-123 !@#';
  const blob = socialTokens.encryptToken(pt);
  assert.ok(blob.startsWith('gcm:'));
  assert.equal(socialTokens.decryptToken(blob), pt);
  // Random IV => different blobs for the same plaintext.
  assert.notEqual(socialTokens.encryptToken(pt), blob);
  assert.throws(() => socialTokens.decryptToken('not-a-blob'), /malformed/);
  assert.throws(() => socialTokens.decryptToken('gcm:aa:bb'), /malformed/);
});
