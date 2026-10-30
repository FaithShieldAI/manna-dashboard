'use strict';
/**
 * Video generation tests (HeyGen wiring, 2026-10-25) — MOCKED provider
 * only: no real HeyGen calls, no key. The mock is injected through
 * videogen._setProviderForTests and reset after every test.
 *
 * Coverage:
 *  - no key + no mock -> 503 heygen_not_configured (fail closed)
 *  - trial tenants: 5 videos TOTAL; the 6th is refused with the
 *    purchase-prompt contract (upgrade_required, limit_name 'videos')
 *  - failed provider creations never consume allowance
 *  - heavy10 paid: 10/month cap with the purchase-prompt contract
 *  - starter paid: feature refused with the purchase-prompt contract
 *  - pro paid: plans.js grants the feature with NO numeric cap —
 *    enforced exactly that way (12 creations pass heavy10's cap)
 *  - job lifecycle: processing -> completed with the provider URL,
 *    via poll-on-read refresh
 *  - tenant isolation: foreign job id is a 404, lists are separate
 *  - input validation: script cap, catalogue keys
 */
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

const { db } = require('../src/db');
const videogen = require('../src/lib/videogen');

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });
afterEach(() => { videogen._resetProvider(); });

function makeMock() {
  const state = { seq: 0, jobs: new Map(), failCreate: false };
  const provider = {
    name: 'mock',
    async createVideo() {
      if (state.failCreate) throw new Error('mock provider boom');
      state.seq += 1;
      const id = 'mock-' + state.seq;
      state.jobs.set(id, { polls: 0 });
      return { providerJobId: id };
    },
    async getVideoStatus(id) {
      const j = state.jobs.get(id);
      j.polls += 1;
      if (j.polls >= 2) {
        return { status: 'completed', videoUrl: 'https://videos.example/' + id + '.mp4', durationS: 42 };
      }
      return { status: 'processing' };
    },
  };
  return { provider, state };
}

function useMock() {
  const m = makeMock();
  videogen._setProviderForTests(m.provider);
  return m;
}

async function register(email, plan) {
  const c = client(base);
  // 'pro' was retired from self-serve signup (2026-10-29), so a legacy pro
  // tenant is simulated the way one exists in production: registered on a
  // public plan, then carrying plan='pro' on the tenant row.
  const r = await c.post('/api/auth/register', {
    companyName: 'Video Co ' + email,
    email,
    password: 'password1234',
    plan: plan === 'pro' ? 'heavy10' : plan,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  if (plan === 'pro') {
    const u = db.prepare('SELECT tenant_id FROM users WHERE email=?').get(email);
    db.prepare("UPDATE tenants SET plan='pro' WHERE id=?").run(u.tenant_id);
  }
  return c;
}

function setActive(email) {
  const u = db.prepare('SELECT tenant_id FROM users WHERE email=?').get(email);
  db.prepare("UPDATE tenants SET subscription_status='active' WHERE id=?").run(u.tenant_id);
}

const SCRIPT = { script: 'Hello from Manna — this is a thirty second promo for your business.' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('no key configured: creation fails closed with 503, catalogue says so', async () => {
  const c = await register('vid-none@example.org', 'pro');
  const cat = await c.get('/api/videos/catalogue');
  assert.equal(cat.status, 200);
  assert.equal(cat.json.configured, false);
  assert.ok(cat.json.avatars.length >= 1 && cat.json.voices.length >= 1);
  const r = await c.post('/api/videos/jobs', SCRIPT);
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'heygen_not_configured');
});

test('trial tenant: 5 videos total, 6th refused with purchase-prompt contract', async () => {
  useMock();
  const c = await register('vid-trial@example.org', 'pro'); // trialing by default
  for (let i = 0; i < 5; i++) {
    const r = await c.post('/api/videos/jobs', SCRIPT);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.job.status, 'processing');
  }
  const over = await c.post('/api/videos/jobs', SCRIPT);
  assert.equal(over.status, 403);
  assert.equal(over.json.error, 'trial_video_limit_reached');
  assert.equal(over.json.upgrade_required, true);
  assert.equal(over.json.limit_name, 'videos');
  assert.equal(over.json.trial, true);
  assert.equal(over.json.limit, 5);
  assert.equal(over.json.used, 5);
  assert.equal(over.json.remaining, 0);
});

test('failed provider creations do not consume the trial allowance', async () => {
  const m = useMock();
  const c = await register('vid-fail@example.org', 'pro');
  m.state.failCreate = true;
  const bad = await c.post('/api/videos/jobs', SCRIPT);
  assert.equal(bad.status, 502);
  assert.equal(bad.json.error, 'video_provider_error');
  m.state.failCreate = false;
  for (let i = 0; i < 5; i++) {
    const r = await c.post('/api/videos/jobs', SCRIPT);
    assert.equal(r.status, 201, 'creation ' + (i + 1) + ' after the failure must succeed');
  }
  const over = await c.post('/api/videos/jobs', SCRIPT);
  assert.equal(over.status, 403);
  assert.equal(over.json.used, 5);
});

test('job lifecycle: processing -> completed with provider URL via poll-on-read', async () => {
  useMock();
  const c = await register('vid-life@example.org', 'heavy10');
  const created = await c.post('/api/videos/jobs', SCRIPT);
  assert.equal(created.status, 201);
  const jobId = created.json.job.id;
  assert.equal(created.json.job.video_url, null);
  // Poll-on-read skips provider calls inside 2s of the last update;
  // wait it out, then two reads drive the mock to completion.
  await sleep(2100);
  const first = await c.get('/api/videos/jobs/' + jobId);
  assert.equal(first.json.job.status, 'processing');
  const second = await c.get('/api/videos/jobs/' + jobId);
  assert.equal(second.status, 200);
  assert.equal(second.json.job.status, 'completed');
  assert.match(second.json.job.video_url, /^https:\/\/videos\.example\/mock-\d+\.mp4$/);
  assert.equal(second.json.job.duration_s, 42);
  assert.ok(second.json.job.finished_at);
});

test('heavy10 paid: 10/month cap with purchase-prompt contract', async () => {
  useMock();
  const c = await register('vid-heavy@example.org', 'heavy10');
  setActive('vid-heavy@example.org');
  for (let i = 0; i < 10; i++) {
    const r = await c.post('/api/videos/jobs', SCRIPT);
    assert.equal(r.status, 201, JSON.stringify(r.json));
  }
  const over = await c.post('/api/videos/jobs', SCRIPT);
  assert.equal(over.status, 403);
  assert.equal(over.json.error, 'video_limit_reached');
  assert.equal(over.json.upgrade_required, true);
  assert.equal(over.json.limit_name, 'videos');
  assert.equal(over.json.trial, false);
  assert.equal(over.json.limit, 10);
  assert.equal(over.json.used, 10);
});

test('starter paid: video feature refused with purchase-prompt contract', async () => {
  useMock();
  const c = await register('vid-starter@example.org', 'starter');
  setActive('vid-starter@example.org');
  const r = await c.post('/api/videos/jobs', SCRIPT);
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'video_not_available');
  assert.equal(r.json.upgrade_required, true);
  assert.equal(r.json.limit_name, 'videos');
});

test('pro paid: feature granted with NO numeric cap (plans.js as written)', async () => {
  useMock();
  const c = await register('vid-pro@example.org', 'pro');
  setActive('vid-pro@example.org');
  const cat = await c.get('/api/videos/catalogue');
  assert.equal(cat.json.entitlement.feature, true);
  assert.equal(cat.json.entitlement.limit, null);
  assert.equal(cat.json.entitlement.remaining, null);
  // 12 > heavy10's monthly cap: all must pass — no cap was invented.
  for (let i = 0; i < 12; i++) {
    const r = await c.post('/api/videos/jobs', SCRIPT);
    assert.equal(r.status, 201, 'pro creation ' + (i + 1));
  }
});

test('tenant isolation: foreign job is 404 and lists stay separate', async () => {
  useMock();
  const a = await register('vid-a@example.org', 'pro');
  const b = await register('vid-b@example.org', 'pro');
  const created = await a.post('/api/videos/jobs', SCRIPT);
  assert.equal(created.status, 201);
  const foreign = await b.get('/api/videos/jobs/' + created.json.job.id);
  assert.equal(foreign.status, 404);
  assert.equal(foreign.json.error, 'job_not_found');
  const bList = await b.get('/api/videos/jobs');
  assert.equal(bList.json.jobs.length, 0);
  const aList = await a.get('/api/videos/jobs');
  assert.equal(aList.json.jobs.length, 1);
  // The provider job id is internal bookkeeping — never exposed.
  assert.equal(aList.json.jobs[0].provider_job_id, undefined);
});

test('validation: script required + capped at 1000 chars, catalogue keys enforced', async () => {
  useMock();
  const c = await register('vid-val@example.org', 'pro');
  const empty = await c.post('/api/videos/jobs', { script: '   ' });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error, 'invalid_script');
  const long = await c.post('/api/videos/jobs', { script: 'x'.repeat(1001) });
  assert.equal(long.status, 400);
  assert.equal(long.json.error, 'script_too_long');
  assert.equal(long.json.max, 1000);
  const badAvatar = await c.post('/api/videos/jobs', { ...SCRIPT, avatar: 'nope' });
  assert.equal(badAvatar.status, 400);
  assert.equal(badAvatar.json.error, 'invalid_avatar');
  const badVoice = await c.post('/api/videos/jobs', { ...SCRIPT, voice: 'nope' });
  assert.equal(badVoice.status, 400);
  assert.equal(badVoice.json.error, 'invalid_voice');
});
