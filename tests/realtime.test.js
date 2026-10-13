'use strict';
/**
 * Realtime pipeline tests:
 *  beacon (public, collect_key) -> site_events -> /realtime + SSE /stream
 *  - wrong/missing collect_key rejected (no oracle)
 *  - active_now reflects distinct sessions in the last 5 minutes
 *  - SSE stream emits a tick event with the live count
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

let rtSeq = 0;
async function setupSite() {
  rtSeq += 1;
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Realtime Co ' + rtSeq, email: `rt${rtSeq}@example.org`, password: 'realtime-secret-1',
  });
  assert.equal(r.status, 201);
  const s = await c.post('/api/sites', { siteKey: 'shop', name: 'Shop' });
  assert.equal(s.status, 201);
  return { c, collectKey: s.json.collect_key };
}

async function beacon(siteKey, body) {
  const res = await fetch(base + '/api/collect/' + siteKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.status;
}

test('beacon rejects bad key and bad input', async () => {
  const { collectKey } = await setupSite();
  assert.equal(await beacon('shop', { collect_key: 'wrong', event_name: 'view' }), 400);
  assert.equal(await beacon('shop', { event_name: 'view' }), 400);
  assert.equal(await beacon('shop', { collect_key: collectKey }), 400);
  assert.equal(await beacon('nosuchsite', { collect_key: collectKey, event_name: 'view' }), 400);
  assert.ok(collectKey);
});

test('beacon -> realtime active_now counts distinct sessions', async () => {
  const { c, collectKey } = await setupSite();
  const before = await c.get('/api/sites/shop/realtime');
  assert.equal(before.json.active_now, 0);

  assert.equal(await beacon('shop', { collect_key: collectKey, event_name: 'pageview', session_key: 'sess-1' }), 200);
  assert.equal(await beacon('shop', { collect_key: collectKey, event_name: 'pageview', session_key: 'sess-1' }), 200);
  assert.equal(await beacon('shop', { collect_key: collectKey, event_name: 'signup', session_key: 'sess-2' }), 200);

  const afterBeacons = await c.get('/api/sites/shop/realtime');
  assert.equal(afterBeacons.json.active_now, 2, 'distinct sessions, not events');
  assert.ok(Array.isArray(afterBeacons.json.recent_events));
  assert.ok(afterBeacons.json.recent_events.length >= 3);
});

test('SSE stream emits live tick with active_now', async () => {
  const { c, collectKey } = await setupSite();
  const myEmail = `rt${rtSeq}@example.org`;
  await beacon('shop', { collect_key: collectKey, event_name: 'pageview', session_key: 'live-1' });

  // raw fetch with the session cookie to read SSE
  const loginRes = await c.get('/api/auth/me');
  assert.equal(loginRes.status, 200);

  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 8000);
  try {
    // Reuse the test client's cookie jar via a manual request is awkward;
    // instead login via raw fetch and forward the cookie.
    const lr = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ email: myEmail, password: 'realtime-secret-1' }),
    });
    const cookie = lr.headers.get('set-cookie').split(';')[0];
    const res = await fetch(base + '/api/sites/shop/stream', {
      headers: { Cookie: cookie, 'X-Requested-With': 'XMLHttpRequest' },
      signal: ctl.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let payload = null;
    for (let i = 0; i < 50; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/event: tick\ndata: (\{.*\})/);
      if (m) { payload = JSON.parse(m[1]); break; }
    }
    await reader.cancel();
    assert.ok(payload, 'received a tick event');
    assert.equal(payload.site, 'shop');
    assert.ok(payload.active_now >= 1, `active_now=${payload.active_now}`);
  } finally {
    clearTimeout(to);
  }
});
