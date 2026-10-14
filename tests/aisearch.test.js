'use strict';
/**
 * AI lead finder tests:
 *  - parseQuery fallback: "AV integrators in Texas", "plumbers near Austin, TX",
 *    "dentists", filler-word stripping ("Find me coffee roasters in Portland")
 *  - pickLinks: DDG result parsing, junk-domain filtering, host dedupe
 *  - aisearch.collect with stubbed fetch: DDG html + business pages
 *    -> leads with name/url/emails/location
 *  - POST /api/leads/ai-search end-to-end (stubbed global fetch):
 *    validation, job done, leads land in influencers as unvetted,
 *    tenant isolation
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

const aisearch = require('../src/lib/collectors/aisearch');

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

// --- query parsing (local fallback; no ANTHROPIC_API_KEY in test env) --------

test('parseQuery: "AV integrators in Texas"', async () => {
  const p = await aisearch.parseQuery('AV integrators in Texas', { skipClaude: true });
  assert.equal(p.business_type, 'AV integrators');
  assert.equal(p.location, 'Texas');
});

test('parseQuery: "plumbers near Austin, TX"', async () => {
  const p = await aisearch.parseQuery('plumbers near Austin, TX', { skipClaude: true });
  assert.equal(p.business_type, 'plumbers');
  assert.equal(p.location, 'Austin, Texas');
});

test('parseQuery: bare business type, no location', async () => {
  const p = await aisearch.parseQuery('dentists', { skipClaude: true });
  assert.equal(p.business_type, 'dentists');
  assert.equal(p.location, '');
});

test('parseQuery: strips filler words', async () => {
  const p = await aisearch.parseQuery('Find me coffee roasters in Portland', { skipClaude: true });
  assert.equal(p.business_type, 'coffee roasters');
  assert.equal(p.location, 'Portland');
});

test('parseQuery: state abbreviation normalizes', async () => {
  const p = await aisearch.parseQuery('landscapers in tx', { skipClaude: true });
  assert.equal(p.business_type, 'landscapers');
  assert.equal(p.location, 'Texas');
});

// --- search-result parsing ---------------------------------------------------

test('pickLinks: parses DDG results, skips junk, dedupes hosts', () => {
  const html = `<html><body>
    <a class="result__a" href="https://acme-av.example/">Acme</a>
    <a class="result__a" href="https://acme-av.example/contact">Acme contact</a>
    <a class="result__a" href="https://www.yelp.com/biz/something">Yelp listing</a>
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbestav.example%2F&rut=abc">Best</a>
    <a class="result__a" href="https://www.linkedin.com/company/x">LinkedIn</a>
  </body></html>`;
  const links = aisearch.pickLinks(html, 'ddg');
  const hosts = links.map(l => l.host).sort();
  assert.deepEqual(hosts, ['acme-av.example', 'bestav.example']);
});

test('pickLinks: parses Bing results', () => {
  const html = `<html><body>
    <h2><a target="_blank" href="https://shop.example/">Shop</a></h2>
    <h2><a target="_blank" href="https://www.bing.com/maps">Maps</a></h2>
  </body></html>`;
  const links = aisearch.pickLinks(html, 'bing');
  assert.equal(links.length, 1);
  assert.equal(links[0].host, 'shop.example');
});

// --- collector with stubbed fetch --------------------------------------------

const DDG_HTML = `<html><body>
  <div class="result"><a rel="nofollow" class="result__a" href="https://acme-av.example/">Acme AV Integrators</a></div>
  <div class="result"><a rel="nofollow" class="result__a" href="https://bestav.example/contact">Contact — Best AV</a></div>
  <div class="result"><a rel="nofollow" class="result__a" href="https://noemail.example/">No Email Co</a></div>
</body></html>`;

const PAGES = {
  'https://acme-av.example/': `<html><head><title>Acme AV Integrators — Home</title></head>
    <body><p>Email sales@acme-av.example for quotes.</p></body></html>`,
  'https://bestav.example/contact': `<html><head><title>Contact Us | Best AV</title></head>
    <body><p>Reach us at info@bestav.example</p></body></html>`,
  'https://bestav.example/': `<html><head><title>Best AV</title></head><body><p>Welcome.</p></body></html>`,
  'https://noemail.example/': `<html><head><title>No Email Co</title></head><body><p>Nothing here.</p></body></html>`,
};

function stubFetch(url) {
  return {
    ok: true,
    arrayBuffer: async () => {
      if (String(url).includes('duckduckgo.com')) return Buffer.from(DDG_HTML);
      const body = PAGES[String(url).split('?')[0]];
      if (body) return Buffer.from(body);
      throw new Error('fetch failed: ' + url); // fetchText treats as "no data"
    },
  };
}

test('collect: finds businesses and extracts emails (stubbed fetch)', async () => {
  const { leads, parsed } = await aisearch.collect({
    query: 'AV integrators in Texas',
    fetch: stubFetch,
    noDelay: true,
    skipClaude: true,
  });
  assert.equal(parsed.business_type, 'AV integrators');
  assert.equal(parsed.location, 'Texas');
  assert.equal(leads.length, 2, JSON.stringify(leads));
  const acme = leads.find(l => l.host === undefined && l.url === 'https://acme-av.example');
  assert.ok(acme, 'acme lead present');
  assert.equal(acme.name, 'Acme AV Integrators');
  assert.deepEqual(acme.emails, ['sales@acme-av.example']);
  assert.equal(acme.location, 'Texas');
  const best = leads.find(l => l.url === 'https://bestav.example');
  assert.ok(best, 'bestav lead present (found via contact page)');
  assert.deepEqual(best.emails, ['info@bestav.example']);
  // noemail.example produced no lead
  assert.ok(!leads.some(l => l.url.includes('noemail')), 'sites without emails are skipped');
});

// --- API endpoint --------------------------------------------------------------

async function register(email) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'AI Search Co ' + email, email, password: 'aisearch-secret-12',
  });
  assert.equal(r.status, 201);
  return c;
}

function withStubbedFetch(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const u = String(url);
    // Only stub the collector's outbound web calls; the test HTTP client
    // itself uses global fetch to reach the local test server.
    if (u.includes('duckduckgo.com') || u.includes('bing.com')
        || /\.example(\/|$|\?)/.test(u) || u.includes('api.anthropic.com')) {
      return stubFetch(u, init);
    }
    return real(url, init);
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => { globalThis.fetch = real; });
}

test('POST /api/leads/ai-search validates query', async () => {
  const c = await register('aiq@example.org');
  const r = await c.post('/api/leads/ai-search', { query: '   ' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'query_required');
});

test('POST /api/leads/ai-search end-to-end: query -> job -> influencers', async () => {
  const c = await register('aie2e@example.org');
  const r = await withStubbedFetch(() => c.post('/api/leads/ai-search', {
    query: 'AV integrators in Texas',
    max_results: 10,
  }));
  assert.equal(r.status, 201);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.job.source, 'aisearch');
  assert.equal(r.json.job.status, 'done');
  assert.equal(r.json.job.query, 'AV integrators in Texas');
  assert.deepEqual(r.json.parsed, { business_type: 'AV integrators', location: 'Texas' });
  assert.ok(r.json.found >= 2, `found=${r.json.found}`);
  assert.ok(r.json.new >= 2, `new=${r.json.new}`);
  assert.ok(Array.isArray(r.json.leads) && r.json.leads.length >= 2);
  assert.ok(r.json.leads[0].name && r.json.leads[0].url && r.json.leads[0].emails);

  const inf = await c.get('/api/influencers?status=unvetted');
  const emails = inf.json.influencers.map(i => i.email);
  assert.ok(emails.includes('sales@acme-av.example'));
  assert.ok(emails.includes('info@bestav.example'));
  const lead = inf.json.influencers.find(i => i.email === 'sales@acme-av.example');
  assert.equal(lead.source, 'lead-collect:aisearch');
  assert.match(lead.notes, /AV integrators in Texas/);
});

test('ai-search dedupes on re-run; tenant isolation holds', async () => {
  const c1 = await register('aid1@example.org');
  const c2 = await register('aid2@example.org');
  await withStubbedFetch(() => c1.post('/api/leads/ai-search', { query: 'AV integrators in Texas' }));
  const again = await withStubbedFetch(() => c1.post('/api/leads/ai-search', { query: 'AV integrators in Texas' }));
  assert.equal(again.json.new, 0, 'second run adds no duplicates');

  const inf2 = await c2.get('/api/influencers?status=unvetted');
  assert.equal(inf2.json.influencers.length, 0, 'other tenant sees nothing');

  const jobs2 = await c2.get('/api/leads/jobs');
  assert.equal(jobs2.json.jobs.length, 0, 'other tenant sees no jobs');
});
