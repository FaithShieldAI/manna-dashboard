'use strict';
/**
 * Goal values (2026-11-18, red-team walk finding): the Overview goals
 * were frozen seeded copies. seedDemoData plants the same goal set
 * into every tenant with current_values frozen at seed time
 * (armor_bearer 3, k_punk 1, mannaai 0 in every tenant of the
 * production snapshot), and the reads served those stored numbers as
 * measurements. Only email_collection had a read-time override.
 *
 * The rule under test (src/lib/goalValues.js): a goal reports a
 * number only when the app's own data can measure it today, read at
 * request time.
 *   email_collection — the tenant's own live lead count.
 *   faithshield      — active/trialing rows in
 *                      faithshield_subscriptions.
 *   mannaai          — the count of user accounts in the app.
 * Goals with no live source in the app's data (armor_bearer: the
 * affiliates live in the separate Armor Bearer app; k_punk: the
 * notify-me list lives in a Netlify form export; two_fishes: no
 * households can exist while the deploy is held and billing is off)
 * must come back with current null and live_feed false, and the
 * served /app page must carry the "No live feed" target rendering
 * instead of a measured count. Stored goal rows are never written
 * by a read.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

let server, base, db;
before(async () => {
  ({ server, base } = await startServer());
  ({ db } = require('../src/db'));
});
after(async () => { server.close(); });

const { seedDemoData } = require('../scripts/seed-demo-data');

async function registerSeeded(email, companyName) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName, email, password: 'goal-values-secret', plan: 'starter',
  });
  assert.equal(r.status, 201, `register ${email}: ${JSON.stringify(r.json)}`);
  const tenantId = Number(r.json.tenant.id);
  const slug = db.prepare('SELECT slug FROM tenants WHERE id = ?').get(tenantId).slug;
  seedDemoData(slug);
  return { c, tenantId };
}

const byKey = (j) => Object.fromEntries(j.goals.map(g => [g.key, g]));

test('two tenants with different real activity read different email_collection values', async () => {
  const A = await registerSeeded('a@goals.example', 'Goals A Co');
  const B = await registerSeeded('b@goals.example', 'Goals B Co');
  const ins = db.prepare('INSERT INTO influencers (tenant_id, email, category) VALUES (?, ?, ?)');
  ins.run(A.tenantId, 'one@leads.example', 'influencer');
  ins.run(A.tenantId, 'two@leads.example', 'pastor');
  ins.run(A.tenantId, 'three@leads.example', 'influencer');
  ins.run(B.tenantId, 'only@leads.example', 'influencer');

  const ga = byKey((await A.c.get('/api/goals')).json);
  const gb = byKey((await B.c.get('/api/goals')).json);
  assert.equal(ga.email_collection.current, 3);
  assert.equal(gb.email_collection.current, 1);
  assert.equal(ga.email_collection.live_feed, true);

  // The stored rows are the frozen seed in BOTH tenants; the read,
  // not the row, carries the truth.
  const storedA = db.prepare(
    "SELECT current_value FROM goals WHERE tenant_id = ? AND goal_key = 'armor_bearer'"
  ).get(A.tenantId);
  const storedB = db.prepare(
    "SELECT current_value FROM goals WHERE tenant_id = ? AND goal_key = 'armor_bearer'"
  ).get(B.tenantId);
  assert.equal(storedA.current_value, 3);
  assert.equal(storedB.current_value, 3);
});

test('faithshield reads faithshield_subscriptions and mannaai reads the users table', async () => {
  const A = await registerSeeded('c@goals.example', 'Goals C Co');
  const before = byKey((await A.c.get('/api/goals')).json);
  assert.equal(before.faithshield.current, 0);
  assert.equal(before.faithshield.live_feed, true);
  const usersBefore = before.mannaai.current;
  assert.equal(typeof usersBefore, 'number');

  const insSub = db.prepare(
    'INSERT INTO faithshield_subscriptions (stripe_customer_id, stripe_subscription_id, status) VALUES (?, ?, ?)'
  );
  insSub.run('cus_a', 'sub_active_1', 'active');
  insSub.run('cus_b', 'sub_trialing_1', 'trialing');
  insSub.run('cus_c', 'sub_canceled_1', 'canceled');

  const after = byKey((await A.c.get('/api/goals')).json);
  assert.equal(after.faithshield.current, 2);

  // The read never writes the stored goal row.
  const stored = db.prepare(
    "SELECT current_value FROM goals WHERE tenant_id = ? AND goal_key = 'faithshield'"
  ).get(A.tenantId);
  assert.equal(stored.current_value, 0);

  // A new MannaAi user account moves the mannaai goal by exactly one.
  await registerSeeded('d@goals.example', 'Goals D Co');
  const after2 = byKey((await A.c.get('/api/goals')).json);
  assert.equal(after2.mannaai.current, usersBefore + 1);
});

test('goals without a live source are labeled in both APIs, never served as counts', async () => {
  const A = await registerSeeded('e@goals.example', 'Goals E Co');
  for (const path of ['/api/goals', '/api/overview']) {
    const r = await A.c.get(path);
    assert.equal(r.status, 200, path);
    const m = byKey(r.json);
    for (const key of ['armor_bearer', 'k_punk', 'two_fishes']) {
      assert.equal(m[key].live_feed, false, `${path} ${key} live_feed`);
      assert.equal(m[key].current, null, `${path} ${key} current`);
      assert.ok(m[key].goal > 0, `${path} ${key} keeps its target`);
    }
    for (const key of ['email_collection', 'faithshield', 'mannaai']) {
      assert.equal(m[key].live_feed, true, `${path} ${key} live_feed`);
      assert.equal(typeof m[key].current, 'number', `${path} ${key} current is a number`);
    }
  }
});

test('/app carries the No live feed target rendering for goals without a source', async () => {
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({
      companyName: 'Goals Page Co', email: 'page@goals.example',
      password: 'goal-values-secret', plan: 'starter',
    }),
  });
  assert.equal(res.status, 201);
  const setCookie = res.headers.get('set-cookie') || '';
  const m = setCookie.match(/d2rm_session=[^;]*/);
  assert.ok(m, 'register must set a session cookie');
  const page = await fetch(base + '/app', { headers: { Cookie: m[0] }, redirect: 'manual' });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(
    html.includes('No live feed for this goal yet'),
    '/app must render goals without a live source as labeled targets',
  );
  assert.ok(
    html.includes('live_feed'),
    '/app goal rendering must branch on live_feed',
  );
});
