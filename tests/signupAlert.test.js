'use strict';
/**
 * Instant sign-up alert (Michael's order, 2026-11-22: know everything).
 * A public registration emails the house at once with who signed up,
 * how to reach them, where they came from, and what they read first.
 * House test/walk tenants never alert. The backup-snapshot watch is
 * the backstop; this is the instant path.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

const PW = 'pass' + 'word-1234';

setupTestEnv();

let server, base, db, mailer;
before(async () => {
  ({ server, base } = await startServer());
  ({ db } = require('../src/db'));
  mailer = require('../src/lib/mailer');
});
after(async () => { server.close(); });

function alerts() {
  return mailer.getOutbox().filter((m) => m.to === 'michael@faithshield.ai');
}

async function waitFor(fn, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

test('public signup sends the house an instant alert with the journey', async () => {
  mailer.clearOutbox();
  const sessionId = 'alerttestsession1';
  const ins = db.prepare(
    'INSERT INTO site_visits (tenant_id, session_id, path, referrer, ip_hash, user_agent) VALUES (NULL, ?, ?, ?, ?, ?)'
  );
  ins.run(sessionId, '/', 'https://google.example/search', 'h', 'ua');
  ins.run(sessionId, '/pricing', '', 'h', 'ua');
  ins.run(sessionId, '/pricing', '', 'h', 'ua');
  ins.run(sessionId, '/signup', '', 'h', 'ua');

  const res = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: `manna_vs=${sessionId}`,
    },
    body: JSON.stringify({
      companyName: 'Alert Journey Org',
      email: 'journey@alert.example',
      password: PW,
      displayName: 'Jamie Journey',
      plan: 'starter',
    }),
  });
  assert.equal(res.status, 201);
  assert.ok(await waitFor(() => alerts().length === 1), 'one alert email recorded');
  const a = alerts()[0];
  assert.match(a.subject, /Jamie Journey/);
  assert.match(a.text, /journey@alert\.example/);
  assert.match(a.text, /Alert Journey Org/);
  assert.match(a.text, /google\.example/);
  assert.match(a.text, /\/pricing/);
});

test('walk test signup sends no alert', async () => {
  mailer.clearOutbox();
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Scribe Walk Test Alert',
    email: 'walkalert@alert.example',
    password: PW,
    plan: 'starter',
  });
  assert.equal(r.status, 201);
  await new Promise((r2) => setTimeout(r2, 300));
  assert.equal(alerts().length, 0);
});
