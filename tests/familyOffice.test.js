'use strict';
/**
 * Family office leads (Michael, 2026-11-08): investor lead collection
 * runs through MannaAi — the token-gated operator sync
 * (POST /api/auth/lead-collect-sync/:token) runs Manna's own web-list
 * collector on the server and files the leads under the new
 * family_office category (migration 037), so they show in the
 * tenant's lead list and vetting queue as their own bucket.
 *
 * Covers: migration 037 (category + job source + PR shelf CHECKs,
 * podcast_outreach FK survival), the token gate and input validation,
 * an end-to-end collection against a local fixture site, dedupe, the
 * poll endpoint's census, and the dashboard category surfaces
 * (influencers list filter, counts, vetted pending + stats).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
process.env.MIGRATION_TOKEN = 'test-migration-token-fo';
process.env.LIVE_WINDOWS_TENANT_EMAIL = 'fo@family.example';

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

// --- local fixture: a family office homepage with a public email ----
let fixture, fixtureBase;
before(async () => {
  fixture = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><title>Acme Family Office — Home</title></head>
        <body><h1>Acme Family Office</h1>
        <p>For inquiries: hello@acmefamily.example</p>
        <p>Work with us: jobs@acmefamily.example, careers@acmefamily.example</p>
        <p>Fake: test@example.com</p>
        </body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise(r => fixture.listen(0, '127.0.0.1', r));
  fixtureBase = `http://127.0.0.1:${fixture.address().port}`;
});
after(async () => { fixture.close(); });

async function register(email) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'FO Co ' + email, email, password: 'fo-secret-pw-12345',
  });
  assert.equal(r.status, 201, 'register failed: ' + JSON.stringify(r.json));
  return c;
}

async function pollJob(id, tries = 60) {
  const c = client(base);
  for (let i = 0; i < tries; i++) {
    const r = await c.get(`/api/auth/lead-collect-sync/${process.env.MIGRATION_TOKEN}/jobs/${id}`);
    assert.equal(r.status, 200);
    if (r.json.job.status === 'done' || r.json.job.status === 'failed') return r.json;
    await new Promise(res => setTimeout(res, 250));
  }
  throw new Error('job did not finish in time');
}

test('migration 037: family_office accepted in leads, jobs and PR shelves; bogus still rejected', async () => {
  const c = await register('fo-mig@example.org');
  const me = await c.get('/api/auth/me');
  const tid = me.json.tenant.id;
  const { db, forTenant } = require('../src/db');
  const tdb = forTenant(tid);

  const ins = tdb.createInfluencer({ handle: 'Acme Family Office', category: 'family_office', email: 'a@acme.example' });
  assert.ok(ins && ins.lastInsertRowid);
  assert.throws(
    () => tdb.createInfluencer({ handle: 'nope', category: 'bogus' }),
    /CHECK|constraint/i
  );

  const job = tdb.createCollectionJob({ source: 'family_office', seeds: ['https://acme.example'], maxResults: 25 });
  assert.ok(job && job.lastInsertRowid, 'family_office collection job should insert');

  const tgt = tdb.insertPrTarget({ publication: 'Acme Family Office', category: 'family_office', tier: 'niche' });
  assert.ok(tgt > 0, 'family_office PR shelf should accept a target');
  assert.throws(
    () => tdb.insertPrTarget({ publication: 'Nope', category: 'bogus_shelf' }),
    /CHECK|constraint/i
  );

  // podcast_outreach FK survived both 037 rebuilds: link + cascade.
  const pod = tdb.createInfluencer({ handle: 'pod-host', category: 'podcast', email: 'host@example.org' });
  const podId = Number(pod.lastInsertRowid);
  db.prepare("INSERT INTO podcast_outreach (tenant_id, influencer_id, pitch_status) VALUES (?, ?, 'pitched')")
    .run(tid, podId);
  db.prepare('DELETE FROM influencers WHERE id = ?').run(podId);
  const left = db.prepare('SELECT COUNT(*) AS n FROM podcast_outreach WHERE influencer_id = ?').get(podId);
  assert.equal(left.n, 0, 'deleting the influencer must still cascade');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('lead-collect-sync rejects a wrong token, a bad source, and missing seeds', async () => {
  await register('fo@family.example');
  const c = client(base);
  const wrong = await c.post('/api/auth/lead-collect-sync/wrong-token', {
    tenant_email: 'fo@family.example', source: 'family_office', seeds: [fixtureBase + '/'],
  });
  assert.equal(wrong.status, 403);
  const tok = process.env.MIGRATION_TOKEN;
  const badSource = await c.post(`/api/auth/lead-collect-sync/${tok}`, {
    tenant_email: 'fo@family.example', source: 'weblist', seeds: [fixtureBase + '/'],
  });
  assert.equal(badSource.status, 400);
  const noSeeds = await c.post(`/api/auth/lead-collect-sync/${tok}`, {
    tenant_email: 'fo@family.example', source: 'family_office', seeds: [],
  });
  assert.equal(noSeeds.status, 400);
});

test('lead-collect-sync collects a family office lead into the tenant list', async () => {
  const c = client(base);
  const r = await c.post(`/api/auth/lead-collect-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'fo@family.example', source: 'family_office', seeds: [fixtureBase + '/'], max_results: 25,
  });
  assert.equal(r.status, 202, 'sync should accept: ' + JSON.stringify(r.json));
  assert.equal(r.json.job.source, 'family_office');

  const done = await pollJob(r.json.job.id);
  assert.equal(done.job.status, 'done');
  assert.equal(done.job.new_count, 1);
  assert.equal(done.family_office_count, 1);

  // Visible in the tenant's own surfaces, as its own bucket.
  const tenant = await register('fo-tenant@example.org');
  const mine = await tenant.get('/api/influencers?category=family_office');
  assert.equal(mine.json.influencers.length, 0, 'other tenants see nothing');

  const owner = client(base);
  const login = await owner.post('/api/auth/login', { email: 'fo@family.example', password: 'fo-secret-pw-12345' });
  assert.equal(login.status, 200);
  const list = await owner.get('/api/influencers?category=family_office');
  assert.equal(list.status, 200);
  assert.equal(list.json.influencers.length, 1);
  const lead = list.json.influencers[0];
  assert.equal(lead.email, 'hello@acmefamily.example');
  assert.equal(lead.category, 'family_office');
  assert.equal(lead.status, 'unvetted');
  assert.equal(lead.source, 'lead-collect:family_office');

  const counts = await owner.get('/api/influencers/counts');
  const foCount = counts.json.counts.find(x => x.category === 'family_office');
  assert.ok(foCount && foCount.n === 1, 'counts should carry the family_office bucket');

  const pending = await owner.get('/api/vetted/pending?category=family_office');
  assert.equal(pending.status, 200);
  assert.equal(pending.json.leads.length, 1);
  const stats = await owner.get('/api/vetted/stats');
  assert.equal(stats.json.unvetted.family_office, 1);
});

test('lead-collect-sync reject pulls a lead at the vetting stage; job inboxes never ingest', async () => {
  // The fixture page also publishes jobs@ and careers@ addresses;
  // the collect test above filed exactly one lead (hello@), so the
  // job-inbox filter held. Here: reject flow for a row like the
  // HR inbox Michael ordered out (2026-11-08).
  const c = await register('fo-reject@example.org');
  const me = await c.get('/api/auth/me');
  const { forTenant } = require('../src/db');
  const tdb = forTenant(me.json.tenant.id);
  tdb.createInfluencer({
    handle: 'Some Trust', platform: 'web', email: 'employment@sometrust.example',
    category: 'family_office', status: 'unvetted', source: 'lead-collect:family_office',
    notes: 'fixture HR inbox',
  });

  const anon = client(base);
  const wrong = await anon.post(`/api/auth/lead-collect-sync/wrong-token/reject`, {
    tenant_email: 'fo-reject@example.org', email: 'employment@sometrust.example',
  });
  assert.equal(wrong.status, 403);

  const tok = process.env.MIGRATION_TOKEN;
  const missing = await anon.post(`/api/auth/lead-collect-sync/${tok}/reject`, {
    tenant_email: 'fo-reject@example.org', email: 'nobody@sometrust.example',
  });
  assert.equal(missing.status, 404);

  const r = await anon.post(`/api/auth/lead-collect-sync/${tok}/reject`, {
    tenant_email: 'fo-reject@example.org', email: 'employment@sometrust.example',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'rejected');

  const pending = await c.get('/api/vetted/pending?category=family_office');
  assert.equal(pending.json.leads.length, 0, 'rejected lead leaves the vetting queue');
  const stats = await c.get('/api/vetted/stats');
  assert.equal(stats.json.rejected.family_office, 1);
  const list = await c.get('/api/influencers?category=family_office');
  assert.equal(list.json.influencers.length, 1, 'the row stays on record');
  assert.equal(list.json.influencers[0].status, 'rejected');
});

test('re-running the same collection dedupes by email', async () => {
  const c = client(base);
  const r = await c.post(`/api/auth/lead-collect-sync/${process.env.MIGRATION_TOKEN}`, {
    tenant_email: 'fo@family.example', source: 'family_office', seeds: [fixtureBase + '/'], max_results: 25,
  });
  assert.equal(r.status, 202);
  const done = await pollJob(r.json.job.id);
  assert.equal(done.job.status, 'done');
  assert.equal(done.job.new_count, 0);
  assert.equal(done.family_office_count, 1);
});
