'use strict';
/**
 * Lead collection tests:
 *  - sources listed; job validation (bad source, missing keywords/seeds)
 *  - weblist end-to-end against a local HTTP server (no external network):
 *    job -> run -> emails extracted -> inserted into influencers as unvetted
 *  - dedupe: re-running does not duplicate
 *  - youtube collector parsing unit-tested with stubbed fetch
 *  - tenant isolation: jobs are per-tenant
 *  - cancel only while queued
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

// --- local fixture web server -------------------------------------------
let fixture, fixtureBase;
before(async () => {
  fixture = http.createServer((req, res) => {
    if (req.url === '/creator') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><title>Jane Creator — Portfolio</title></head>
        <body><h1>Jane Creator</h1>
        <p>For commissions: jane.creator@creatormail.net</p>
        <p>Or reach me at jane [at] creatormail [dot] net</p>
        <p>Fake: not-an-email@, test@example.com</p>
        </body></html>`);
    } else if (req.url === '/empty') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><p>No contact here.</p></body></html>');
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
    companyName: 'Leads Co ' + email, email, password: 'leads-secret-pw-12',
  });
  assert.equal(r.status, 201);
  return c;
}

test('sources listed', async () => {
  const c = await register('src@example.org');
  const r = await c.get('/api/leads/sources');
  assert.equal(r.status, 200);
  const keys = r.json.sources.map(s => s.key).sort();
  assert.deepEqual(keys, ['weblist', 'youtube']);
});

test('job validation', async () => {
  const c = await register('val@example.org');
  const bad = await c.post('/api/leads/jobs', { source: 'instagram' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_source');
  const nokw = await c.post('/api/leads/jobs', { source: 'youtube', keywords: [] });
  assert.equal(nokw.status, 400);
  assert.equal(nokw.json.error, 'keywords_required');
  const noseed = await c.post('/api/leads/jobs', { source: 'weblist', seeds: [] });
  assert.equal(noseed.status, 400);
  assert.equal(noseed.json.error, 'seeds_required');
});

test('weblist job end-to-end: seeds -> emails -> influencers', async () => {
  const c = await register('wl@example.org');
  const r = await c.post('/api/leads/jobs', {
    source: 'weblist',
    seeds: [fixtureBase + '/creator', fixtureBase + '/empty'],
    max_results: 25,
    auto_run: true,
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.job.status, 'done');
  assert.equal(r.json.result.ok, true);
  assert.ok(r.json.result.found >= 2, `found=${r.json.result.found}`);
  assert.ok(r.json.result.new >= 2, `new=${r.json.result.new}`);

  // leads landed in the tenant's influencers table as unvetted
  const inf = await c.get('/api/influencers?status=unvetted');
  const emails = inf.json.influencers.map(i => i.email);
  assert.ok(emails.includes('jane.creator@creatormail.net'));
  assert.ok(emails.includes('jane@creatormail.net'), 'obfuscated [at]/[dot] decoded');
  assert.ok(!emails.includes('test@example.com'), 'bad domain filtered');
  const lead = inf.json.influencers.find(i => i.email === 'jane.creator@creatormail.net');
  assert.match(lead.notes, /seed URL/);
});

test('re-run dedupes: no duplicate influencers', async () => {
  const c = await register('dd@example.org');
  const mk = async () => {
    const r = await c.post('/api/leads/jobs', {
      source: 'weblist', seeds: [fixtureBase + '/creator'], auto_run: true,
    });
    return r.json;
  };
  const first = await mk();
  assert.ok(first.result.new >= 2);
  const before = (await c.get('/api/influencers')).json.influencers.length;
  const second = await mk();
  assert.equal(second.result.new, 0, 'all emails already known');
  const afterCount = (await c.get('/api/influencers')).json.influencers.length;
  assert.equal(afterCount, before);
});

test('jobs are tenant-isolated', async () => {
  const a = await register('t-a@example.org');
  const b = await register('t-b@example.org');
  const r = await a.post('/api/leads/jobs', { source: 'weblist', seeds: [fixtureBase + '/creator'] });
  const id = r.json.job.id;
  const got = await b.get('/api/leads/jobs/' + id);
  assert.equal(got.status, 404);
  const run = await b.post('/api/leads/jobs/' + id + '/run', {});
  assert.equal(run.status, 404);
  const listB = await b.get('/api/leads/jobs');
  assert.equal(listB.json.jobs.length, 0);
});

test('cancel only while queued', async () => {
  const c = await register('cx@example.org');
  const r = await c.post('/api/leads/jobs', { source: 'weblist', seeds: [fixtureBase + '/creator'] });
  const id = r.json.job.id;
  assert.equal(r.json.job.status, 'queued');
  const cx = await c.post('/api/leads/jobs/' + id + '/cancel', {});
  assert.equal(cx.status, 200);
  assert.equal(cx.json.job.status, 'canceled');
  const cx2 = await c.post('/api/leads/jobs/' + id + '/cancel', {});
  assert.equal(cx2.status, 409);
});

test('youtube collector parses channel renderers (stubbed fetch)', async () => {
  const youtube = require('../src/lib/collectors/youtube');
  const fakeSearchHtml = `<html><body><script>var ytInitialData = ${JSON.stringify({
    contents: { channelRenderer: { channelId: 'UC123', title: { simpleText: 'Test Channel' }, videoCountText: { simpleText: '10K subscribers' }, navigationEndpoint: { commandMetadata: { webCommandMetadata: { url: '/@testchannel' } } } } },
  })};</script></body></html>`;
  const fakeFetch = async (url) => ({
    ok: true,
    arrayBuffer: async () => Buffer.from(url.includes('results') ? fakeSearchHtml : '<html></html>'),
  });
  const channels = await youtube.searchChannels('test kw', 5, { fetch: fakeFetch, noDelay: true });
  assert.equal(channels.length, 1);
  assert.equal(channels[0].channel_id, 'UC123');
  assert.equal(channels[0].name, 'Test Channel');
});
