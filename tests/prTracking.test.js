'use strict';
/**
 * PR email tracking (migration 033, src/lib/prTracking.js,
 * src/routes/track.js, GET /api/pr/tracking).
 *
 * Press emails carry an HMAC-signed token naming outlet, recipient,
 * and release version. The public routes /t/o/<token> (open pixel)
 * and /t/c/<token> (click redirect) record into pr_events; the PR
 * tab reads the per-recipient aggregate back, admin-gated like the
 * rest of /api/pr. Covers: sign/verify roundtrip and tamper
 * rejection, signing disabled with no key, the pixel serving a GIF
 * and writing exactly one open (and nothing for a bad token), the
 * click redirect + row, the non-http fallback, and the tracking
 * endpoint's gate and aggregation.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
process.env.PR_TRACKING_KEY = '0123456789abcdef'.repeat(4); // 32 bytes, hex

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

const { db } = require('../src/db');
const { sign, verify } = require('../src/lib/prTracking');

const PAYLOAD = { o: 'Test Outlet', e: 'desk@outlet.example', v: 'B' };
const PW = 'pr-tracking-pw-12345';

function eventCount(email, kind) {
  return db.prepare('SELECT COUNT(*) AS c FROM pr_events WHERE email = ? AND kind = ?')
    .get(email, kind).c;
}

async function registeredClient(email) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Tracking Test Co ' + email, email, password: PW,
  });
  assert.equal(r.status, 201, 'register failed: ' + JSON.stringify(r.json));
  return c;
}

test('sign/verify roundtrip; tampered tokens rejected', () => {
  const token = sign(PAYLOAD);
  assert.equal(typeof token, 'string');
  assert.deepEqual(verify(token), PAYLOAD);

  // Flip a character in the payload segment.
  const [body, sig] = token.split('.');
  const flipped = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
  assert.equal(verify(flipped + '.' + sig), null);
  // Flip a character in the signature segment.
  const badSig = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
  assert.equal(verify(body + '.' + badSig), null);
  // Malformed shapes.
  assert.equal(verify(''), null);
  assert.equal(verify('no-dot-here'), null);
  assert.equal(verify(token + '.extra'), null);
  assert.equal(verify(null), null);
});

test('no key configured: signing disabled, verify always null', () => {
  const saved = process.env.PR_TRACKING_KEY;
  delete process.env.PR_TRACKING_KEY;
  try {
    assert.equal(sign(PAYLOAD), null);
    assert.equal(verify('anything.anything'), null);
  } finally {
    process.env.PR_TRACKING_KEY = saved;
  }
});

test('GET /t/o/:token serves the GIF and writes exactly one open row', async () => {
  const token = sign(PAYLOAD);
  const res = await fetch(base + '/t/o/' + token, { redirect: 'manual' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /^image\/gif/);
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.slice(0, 6).toString('ascii'), 'GIF89a');
  assert.equal(eventCount(PAYLOAD.e, 'open'), 1);
  const row = db.prepare('SELECT * FROM pr_events WHERE email = ? AND kind = ?')
    .get(PAYLOAD.e, 'open');
  assert.equal(row.outlet, PAYLOAD.o);
  assert.equal(row.version, PAYLOAD.v);
  assert.ok(row.ts > 0);
});

test('GET /t/o/:token with a bad token still serves the GIF, writes nothing', async () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM pr_events').get().c;
  const res = await fetch(base + '/t/o/not-a-real-token.sig', { redirect: 'manual' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /^image\/gif/);
  await res.arrayBuffer();
  const afterCount = db.prepare('SELECT COUNT(*) AS c FROM pr_events').get().c;
  assert.equal(afterCount, before);
});

test('GET /t/c/:token redirects to the target and writes one click row', async () => {
  const token = sign(PAYLOAD);
  const target = 'https://faithshield.ai/story?x=1';
  const res = await fetch(base + '/t/c/' + token + '?u=' + encodeURIComponent(target),
    { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), target);
  assert.equal(eventCount(PAYLOAD.e, 'click'), 1);
  const row = db.prepare('SELECT * FROM pr_events WHERE email = ? AND kind = ?')
    .get(PAYLOAD.e, 'click');
  assert.equal(row.target_url, target);
});

test('GET /t/c/:token with a non-http u redirects to faithshield.ai', async () => {
  const token = sign(PAYLOAD);
  for (const u of ['javascript:alert(1)', 'ftp://example.com/x', 'not a url', '']) {
    const res = await fetch(base + '/t/c/' + token + '?u=' + encodeURIComponent(u),
      { redirect: 'manual' });
    assert.equal(res.status, 302, 'u=' + JSON.stringify(u));
    assert.equal(res.headers.get('location'), 'https://faithshield.ai');
  }
  const bad = await fetch(base + '/t/c/forged.token?u=' + encodeURIComponent('https://example.com/'),
    { redirect: 'manual' });
  assert.equal(bad.status, 302);
  assert.equal(bad.headers.get('location'), 'https://faithshield.ai');
});

test('GET /api/pr/tracking: non-admin refused, admin gets aggregated rows', async () => {
  const tenant = await registeredClient('plain-tenant@example.org');
  const r1 = await tenant.get('/api/pr/tracking');
  assert.equal(r1.status, 403);

  const stranger = client(base);
  const r2 = await stranger.get('/api/pr/tracking');
  assert.equal(r2.status, 401);

  const admin = await registeredClient('michael@faithshield.ai');
  const r3 = await admin.get('/api/pr/tracking');
  assert.equal(r3.status, 200);
  assert.equal(r3.json.ok, true);
  const row = (r3.json.rows || []).find(r => r.email === PAYLOAD.e);
  assert.ok(row, 'aggregate row for the tracked recipient exists');
  assert.equal(row.outlet, PAYLOAD.o);
  assert.equal(row.version, PAYLOAD.v);
  assert.equal(row.opens, 1);
  assert.equal(row.clicks, 1);
  assert.ok(typeof row.first_open === 'number' && row.first_open > 0);
  assert.ok(typeof row.last_open === 'number' && row.last_open >= row.first_open);
  assert.ok(typeof row.last_click === 'number' && row.last_click > 0);
});
