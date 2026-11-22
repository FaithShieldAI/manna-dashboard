'use strict';
/**
 * PR targets seed door (2026-11-21): POST /api/auth/pr-targets-seed/:token
 * loads the researched press board (already parsed by the app's own
 * parser) into the house tenant's PR connections, through the same
 * insert path as the file seeder. The board file lives outside the
 * deployment, so the file-based import could never reach it on Render
 * and the Media/PR tab stood at "No connections yet." Token-gated like
 * every staff door. Re-runs add nothing twice; an unverified route can
 * never arrive as verified.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
process.env.MIGRATION_TOKEN = 'test-migration-token';

const ENTRIES = [
  {
    publication: 'Christianity Today', contact_name: 'Jane Editor', role: 'Religion editor',
    beat: null, contact_route: 'tips@christianitytoday.org', route_verified: 1,
    tier: 'faith_major', category: 'faith_based', fit_note: 'Faith major.', source: 'Outlet contact page', status: 'active',
  },
  {
    publication: 'TechCrunch', contact_name: null, role: null,
    beat: null, contact_route: 'tips@techcrunch.com', route_verified: 1,
    tier: 'tech', category: 'mainstream', fit_note: 'Tech major.', source: 'Outlet contact page', status: 'active',
  },
  {
    publication: 'Small Parish Weekly', contact_name: null, role: null,
    beat: null, contact_route: 'Contact route unverified', route_verified: 0,
    tier: 'niche', category: 'faith_based', fit_note: null, source: null, status: 'active',
  },
  {
    publication: 'Parked Outlet', contact_name: null, role: null,
    beat: null, contact_route: 'Contact route unverified', route_verified: 0,
    tier: 'niche', category: 'mainstream', fit_note: 'DO NOT PITCH.', source: null, status: 'do_not_pitch',
  },
  {
    // A payload must not be able to upgrade itself: a string 'yes' is
    // not a verified marker, and an unknown status lands active.
    publication: 'Sneaky Outlet', contact_name: null, role: null,
    beat: null, contact_route: 'form on site', route_verified: 'yes',
    tier: 'niche', category: 'mainstream', fit_note: null, source: null, status: 'whatever',
  },
];

let server, base, c;
before(async () => {
  ({ server, base } = await startServer());
  c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'House Co', email: 'michael@faithshield.ai', password: 'house-secret-1',
  });
  assert.equal(r.status, 201);
});
after(async () => { server.close(); });

test('door loads the board into the house tenant with honest statuses', async () => {
  const r = await c.post(`/api/auth/pr-targets-seed/${process.env.MIGRATION_TOKEN}`, { entries: ENTRIES });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.before.targets, 0);
  assert.equal(r.json.inserted, 5);
  assert.equal(r.json.skipped, 0);
  assert.equal(r.json.total, 5);
  assert.equal(r.json.after.targets, 5);
  assert.equal(r.json.after.targets_do_not_pitch, 1);
  // Active unverified rows only: Small Parish Weekly and Sneaky Outlet.
  assert.equal(r.json.after.targets_unverified, 2);
  assert.equal(r.json.samples.pitchable_faith_based.publication, 'Christianity Today');
  assert.equal(r.json.samples.pitchable_faith_based.route_verified, 1);
  assert.equal(r.json.samples.pitchable_mainstream.publication, 'TechCrunch');
  assert.equal(r.json.samples.pitchable_mainstream.route_verified, 1);
  assert.equal(r.json.samples.unverified.route_verified, 0);
});

test('door is idempotent: a second run inserts nothing', async () => {
  const r = await c.post(`/api/auth/pr-targets-seed/${process.env.MIGRATION_TOKEN}`, { entries: ENTRIES });
  assert.equal(r.status, 200);
  assert.equal(r.json.inserted, 0);
  assert.equal(r.json.skipped, 5);
  assert.equal(r.json.after.targets, 5);
});

test('door rejects a body with no entries', async () => {
  const r = await c.post(`/api/auth/pr-targets-seed/${process.env.MIGRATION_TOKEN}`, {});
  assert.equal(r.status, 400);
});

test('door rejects a wrong token', async () => {
  const r = await c.post('/api/auth/pr-targets-seed/wrong-token', { entries: ENTRIES });
  assert.equal(r.status, 403);
});
