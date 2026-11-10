'use strict';
/**
 * Sites Visits reads are tracker-backed (2026-11-10 fix):
 *  - stats / realtime / breakdown proxy the house tracker
 *    (muse4.pythonanywhere.com) and map its real numbers, including
 *    countries / referrers / utm arrays (previously hardcoded [])
 *  - tracker failure -> 502 tracker_unavailable (the UI's feed-down
 *    state) — never zeros
 *  - tracker 400 "unknown site" -> honest empty result (nothing
 *    recorded), still 200
 * The tracker is a local stub here; TRACKER_BASE_URL points the app at
 * it. The stub's payload mirrors the real tracker's response shape.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

let mode = 'ok';
const stub = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (mode === 'down') return send(500, { ok: false, error: 'boom' });
  if (mode === 'unknown') return send(400, { ok: false, error: 'unknown site' });
  const u = new URL(req.url, 'http://stub');
  if (u.pathname === '/api/stats') {
    return send(200, {
      ok: true, site: 'faithshield', days: 30,
      metrics: {
        visitors: { value: 4, change_pct: -77.8 },
        visits: { value: 4, change_pct: -77.8 },
        views: { value: 5, change_pct: -73.7 },
        bounce_rate: { value: 50.0, change_pct: -10.1 },
        avg_duration_s: { value: 273.0, change_pct: -75.8 },
      },
    });
  }
  if (u.pathname === '/api/realtime') {
    return send(200, { ok: true, site: 'faithshield', active_now: 3, visitors: [] });
  }
  if (u.pathname === '/api/breakdown') {
    return send(200, {
      ok: true, site: 'faithshield', days: 30,
      countries: [{ label: 'US', count: 4 }],
      referrers: [{ label: 'd2rm-dashboard.netlify.app', count: 2 }],
      utm_sources: [{ label: 'newsletter', count: 1 }],
      utm_campaigns: [],
      devices: [{ label: 'desktop', count: 3 }],
      events: [{ label: 'signup', count: 2 }],
    });
  }
  return send(404, { ok: false, error: 'not_found' });
});

let server, base, c;
before(async () => {
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  process.env.TRACKER_BASE_URL = `http://127.0.0.1:${stub.address().port}`;
  ({ server, base } = await startServer());
  c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Tracker Co', email: 'tracker@example.org', password: 'tracker-secret-1',
  });
  assert.equal(r.status, 201);
  const s = await c.post('/api/sites', { siteKey: 'faithshield', name: 'FaithShield' });
  assert.equal(s.status, 201);
});
after(async () => { server.close(); stub.close(); });

test('stats maps the tracker numbers into the Manna shape', async () => {
  mode = 'ok';
  const r = await c.get('/api/sites/faithshield/stats?days=30');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.metrics.visitors.value, 4);
  assert.equal(r.json.metrics.views.value, 5);
  assert.equal(r.json.metrics.bounce_rate.value, 50.0);
  assert.equal(r.json.metrics.avg_duration_s.value, 273.0);
});

test('breakdown carries the tracker countries/referrers/utm, not hardcoded []', async () => {
  mode = 'ok';
  const r = await c.get('/api/sites/faithshield/breakdown?days=30');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.countries, [{ label: 'US', count: 4 }]);
  assert.deepEqual(r.json.referrers, [{ label: 'd2rm-dashboard.netlify.app', count: 2 }]);
  assert.deepEqual(r.json.utm_sources, [{ label: 'newsletter', count: 1 }]);
  assert.deepEqual(r.json.events, [{ label: 'signup', count: 2 }]);
});

test('realtime active_now comes from the tracker', async () => {
  mode = 'ok';
  const r = await c.get('/api/sites/faithshield/realtime');
  assert.equal(r.status, 200);
  assert.equal(r.json.active_now, 3);
});

test('compat shim endpoints read the tracker too', async () => {
  mode = 'ok';
  const s = await c.get('/api/stats?site=faithshield&days=30');
  assert.equal(s.status, 200);
  assert.equal(s.json.metrics.visitors.value, 4);
  const b = await c.get('/api/breakdown?site=faithshield&days=30');
  assert.equal(b.status, 200);
  assert.deepEqual(b.json.countries, [{ label: 'US', count: 4 }]);
  const rt = await c.get('/api/realtime?site=faithshield');
  assert.equal(rt.status, 200);
  assert.equal(rt.json.active_now, 3);
});

test('tracker down -> 502 tracker_unavailable, never zeros', async () => {
  mode = 'down';
  const s = await c.get('/api/sites/faithshield/stats?days=30');
  assert.equal(s.status, 502);
  assert.equal(s.json.ok, false);
  assert.equal(s.json.error, 'tracker_unavailable');
  const b = await c.get('/api/sites/faithshield/breakdown?days=30');
  assert.equal(b.status, 502);
  const shim = await c.get('/api/stats?site=faithshield&days=30');
  assert.equal(shim.status, 502);
  mode = 'ok';
});

test('tracker unknown site -> honest empty 200, not an error', async () => {
  mode = 'unknown';
  const s = await c.get('/api/sites/faithshield/stats?days=30');
  assert.equal(s.status, 200);
  assert.equal(s.json.ok, true);
  assert.equal(s.json.metrics.visitors.value, 0);
  assert.equal(s.json.metrics.bounce_rate.value, null);
  const b = await c.get('/api/sites/faithshield/breakdown?days=30');
  assert.equal(b.status, 200);
  assert.deepEqual(b.json.countries, []);
  mode = 'ok';
});
