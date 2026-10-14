'use strict';
/**
 * Funnels tests: POST /api/funnels creates a funnel with stages.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

test('POST /api/funnels creates funnel with stages', async () => {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Funnel Co', email: 'funnel-test@example.org', password: 'funnel-secret-pw-123',
  });
  assert.equal(r.status, 201);

  // valid create
  const cr = await c.post('/api/funnels', {
    funnelKey: 'email-signup',
    name: 'Email Signup Funnel',
    subtitle: 'Visitors to subscribers',
    stages: [
      { label: 'Visitors', goalValue: 10000 },
      { label: 'Leads', goalValue: 1000 },
      { label: 'Customers' }, // no goal
    ],
  });
  assert.equal(cr.status, 201, 'expected 201, got ' + cr.status + ' ' + JSON.stringify(cr.json));
  assert.equal(cr.json.ok, true);
  assert.equal(cr.json.funnel_key, 'email-signup');

  // verify via GET
  const g = await c.get('/api/funnels');
  assert.equal(g.json.ok, true);
  const f = g.json.funnels.find(x => x.key === 'email-signup');
  assert.ok(f, 'funnel should appear in GET');
  assert.equal(f.name, 'Email Signup Funnel');
  assert.equal(f.subtitle, 'Visitors to subscribers');
  assert.equal(f.stages.length, 3);
  assert.equal(f.stages[0].label, 'Visitors');
  assert.equal(f.stages[0].goal, 10000);
  assert.equal(f.stages[2].label, 'Customers');

  // duplicate key -> 409
  const dup = await c.post('/api/funnels', {
    funnelKey: 'email-signup', name: 'Dup', stages: [{ label: 'A' }],
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error, 'funnel_key_taken');

  // bad key -> 400
  const bad = await c.post('/api/funnels', {
    funnelKey: 'BAD KEY!', name: 'Bad', stages: [{ label: 'A' }],
  });
  assert.equal(bad.status, 400);

  // no stages -> 400
  const ns = await c.post('/api/funnels', {
    funnelKey: 'empty', name: 'Empty', stages: [],
  });
  assert.equal(ns.status, 400);

  // unauthenticated -> 401/403
  const anon = client(base);
  const ua = await anon.post('/api/funnels', {
    funnelKey: 'anon', name: 'Anon', stages: [{ label: 'A' }],
  });
  assert.ok(ua.status === 401 || ua.status === 403, 'expected auth failure, got ' + ua.status);
});
