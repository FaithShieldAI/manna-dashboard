'use strict';
/**
 * Site visits read door: GET /api/auth/site-visits-read/:token is guarded
 * by the MIGRATION_TOKEN pattern and returns Manna's own first-party
 * page-view log (site_visits) as aggregates + recent rows for the private
 * D2RM dashboard chain. The door returns counts, paths and referrers
 * only: never ip hashes, session ids or user agents.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
process.env.MIGRATION_TOKEN = 'test-migration-token-not-real';

let server, base;

before(async () => {
  ({ server, base } = await startServer());
  const { db } = require('../src/db');
  const ins = db.prepare(`
    INSERT INTO site_visits (tenant_id, path, referrer, user_agent, ip_hash, session_id, created_at)
    VALUES (NULL, ?, ?, 'test-agent', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now', ?))`);
  // Within the 30-day window: 4 pageviews, 3 visitors, 3 sessions.
  ins.run('/', 'https://google.example/', 'hash-a', 'sess-1', '-1 day');
  ins.run('/', '', 'hash-a', 'sess-1', '-1 day');
  ins.run('/login', '', 'hash-b', 'sess-2', '-2 days');
  ins.run('/signup', 'https://faith.example/', 'hash-c', 'sess-3', '-5 days');
  // Outside the window: counts toward all_time only.
  ins.run('/', '', 'hash-d', 'sess-4', '-40 days');
});
after(async () => { server.close(); });

const tok = () => process.env.MIGRATION_TOKEN;

test('site visits read rejects a wrong migration token', async () => {
  const c = client(base);
  const r = await c.get('/api/auth/site-visits-read/wrong-token');
  assert.equal(r.status, 403);
  assert.equal(r.json.ok, false);
});

test('site visits read fails closed when MIGRATION_TOKEN is unset', async () => {
  const c = client(base);
  const saved = process.env.MIGRATION_TOKEN;
  delete process.env.MIGRATION_TOKEN;
  try {
    const r = await c.get('/api/auth/site-visits-read/anything');
    assert.equal(r.status, 503);
  } finally {
    process.env.MIGRATION_TOKEN = saved;
  }
});

test('site visits read returns window aggregates, top pages and recent rows', async () => {
  const c = client(base);
  const r = await c.get(`/api/auth/site-visits-read/${tok()}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.source, 'manna_site_visits');

  assert.equal(r.json.windows.last_30d.pageviews, 4);
  assert.equal(r.json.windows.last_30d.visitors, 3);
  assert.equal(r.json.windows.last_30d.sessions, 3);
  assert.equal(r.json.windows.all_time.pageviews, 5);
  assert.equal(r.json.windows.all_time.visitors, 4);
  assert.equal(r.json.windows.all_time.sessions, 4);

  const home = r.json.top_pages_30d.find((p) => p.path === '/');
  assert.equal(home.views, 2);
  assert.equal(home.visitors, 1);

  assert.equal(r.json.recent.length, 5);
  // Newest first: the -40 day row was inserted last, so it leads `recent`.
  assert.equal(r.json.recent[0].path, '/');
  for (const row of r.json.recent) {
    assert.ok(row.created_at, 'recent row carries its timestamp');
    assert.ok('referrer' in row, 'recent row carries its referrer');
    assert.equal(row.ip_hash, undefined);
    assert.equal(row.session_id, undefined);
    assert.equal(row.user_agent, undefined);
  }
});

test('site visits read splits human from machine traffic and returns signups', async () => {
  const { db } = require('../src/db');
  const ins = db.prepare(`
    INSERT INTO site_visits (tenant_id, path, referrer, user_agent, ip_hash, session_id, created_at)
    VALUES (NULL, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now', '-1 day'))`);
  // One row per class, all inside the 30-day window.
  ins.run('/login', '', 'curl/8.5.0', 'hash-z1', 'sess-z1');                    // machine_curl
  ins.run('/', '', 'facebookexternalhit/1.1', 'hash-z3', 'sess-z3');           // machine_bot
  ins.run('/t/abc123', '', 'Mozilla/5.0 (test browser)', 'hash-z2', 'sess-z2'); // pr_tracker (path wins over browser UA)
  ins.run('/pricing', '', 'Mozilla/5.0 (test browser)', 'hash-z4', 'sess-z4');  // human

  // A tenant + user + signup event for the signup record.
  const t = db.prepare(
    "INSERT INTO tenants (name, slug) VALUES ('Test Church', 'test-church-truth')").run();
  const u = db.prepare(
    "INSERT INTO users (tenant_id, email, password_hash, display_name) VALUES (?, 'pastor@testchurch.example', 'x', 'Test Pastor')").run(t.lastInsertRowid);
  db.prepare(
    "INSERT INTO signup_events (tenant_id, user_id, landing_path) VALUES (?, ?, '/')").run(t.lastInsertRowid, u.lastInsertRowid);

  const c = client(base);
  const r = await c.get(`/api/auth/site-visits-read/${tok()}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);

  // The seeded class rows land in their own buckets (earlier tests in this
  // file seeded 4 human rows in-window, so human is at least 5).
  const cls = r.json.classes.last_30d;
  assert.equal(cls.machine_curl.pageviews, 1);
  assert.equal(cls.machine_bot.pageviews, 1);
  assert.equal(cls.pr_tracker.pageviews, 1);
  assert.ok(cls.human.pageviews >= 5, 'human bucket carries the browser rows');
  assert.deepEqual(r.json.windows_human.last_30d, cls.human);
  const classSum = cls.human.pageviews + cls.machine_curl.pageviews
    + cls.machine_bot.pageviews + cls.pr_tracker.pageviews;
  assert.equal(classSum, r.json.windows.last_30d.pageviews);

  // Human-only views: top pages exclude the PR-tracker path, recent rows
  // exclude every machine row, and no raw user agent leaks anywhere.
  assert.ok(!r.json.top_pages_30d_human.some((p) => p.path.startsWith('/t/')));
  assert.ok(r.json.top_pages_30d_human.some((p) => p.path === '/pricing'));
  assert.ok(r.json.recent_human.length >= 1);
  for (const row of r.json.recent_human) {
    assert.ok(!row.path.startsWith('/t/'), 'recent_human has no tracker pings');
    assert.equal(row.user_agent, undefined);
    assert.equal(row.ip_hash, undefined);
    assert.equal(row.session_id, undefined);
  }
  const today = r.json.daily_30d.find((d) => d.human_pageviews !== undefined);
  assert.ok(today, 'daily rows carry the human/other split');
  assert.equal(today.pageviews, today.human_pageviews + today.other_pageviews);

  // Signup record: counts, the tenant with its user, and the event.
  assert.ok(r.json.signups.counts.tenants >= 1);
  assert.ok(r.json.signups.counts.users >= 1);
  assert.ok(r.json.signups.counts.signup_events >= 1);
  const tenant = r.json.signups.tenants.find((x) => x.name === 'Test Church');
  assert.ok(tenant, 'tenant is returned');
  assert.ok('subscription_status' in tenant && 'trial_ends_at' in tenant);
  assert.equal(tenant.users.length, 1);
  assert.equal(tenant.users[0].email, 'pastor@testchurch.example');
  const ev = r.json.signups.events.find((x) => x.tenant_name === 'Test Church');
  assert.ok(ev, 'signup event is returned');
  assert.equal(ev.email, 'pastor@testchurch.example');
});
