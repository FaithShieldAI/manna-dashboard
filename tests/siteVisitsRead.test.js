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
