'use strict';
/**
 * PR events light door (2026-11-19): GET /api/auth/pr-events-export/:token
 * carries just the pr_events table (a few KB), token-gated like the other
 * migration doors. The mail-truth chain's step 2 used to pull the whole
 * 52+ MB migration export just for pr_events, so when the full export
 * 502'd, the dashboard sync died with it.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer } = require('./helpers');

setupTestEnv();
process.env.MIGRATION_TOKEN = 'pr-events-test-token-123';

let server, base, db;
before(async () => {
  ({ server, base } = await startServer());
  ({ db } = require('../src/db'));
});
after(async () => { server.close(); });

test('pr-events door returns the table, token-gated', async () => {
  db.prepare(
    "INSERT INTO pr_events (email, kind, ts, outlet, version, target_url) VALUES ('a@x.example', 'open', 1795090000, 'Outlet A', 'B', NULL), ('b@x.example', 'click', 1795090100, 'Outlet B', 'B', 'https://example.org')"
  ).run();
  const res = await fetch(`${base}/api/auth/pr-events-export/${process.env.MIGRATION_TOKEN}`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(Array.isArray(json.data.pr_events), true);
  assert.equal(json.data.pr_events.length, 2);
  assert.equal(json.data.pr_events[0].email, 'a@x.example');
});

test('pr-events door rejects a wrong token', async () => {
  const res = await fetch(`${base}/api/auth/pr-events-export/wrong-token`);
  assert.equal(res.status, 403);
});
