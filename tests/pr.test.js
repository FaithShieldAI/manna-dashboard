'use strict';
/**
 * PR tab (Michael, 2026-11-01): a PR section in the private D2RM
 * dashboard. "The list of connections goes there." Not for Manna yet:
 * every /api/pr route is gated to the house (owner allowlist from
 * routes/admin.js, or a verified whitelisted email), and a plain
 * tenant account gets 403 everywhere. The gate must not trust the
 * role alone, because a tenant owner can grant a team member the
 * 'admin' role inside their own tenant.
 *
 * Covers: migration 031, the admin gate (HTTP + unit), target /
 * release / pitch CRUD, the pitch status flow with its automatic
 * sent/reply stamps, tenant isolation, and the connections-list
 * seeder (both markdown shapes, conservative route verification,
 * idempotency) plus the import endpoint.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

const { db, forTenant, unscoped } = require('../src/db');
const { seedPrTargets, parsePrTargetsMarkdown } = require('../src/lib/prTargetsSeed');
const { isPrAdmin } = require('../src/lib/pr');

function verifyEmail(email) {
  db.prepare("UPDATE users SET email_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE email = ?")
    .run(email);
}

const PW = 'pr-secret-pw-12345';

async function registeredClient(email, { verify = false } = {}) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'PR Test Co ' + email, email, password: PW,
  });
  assert.equal(r.status, 201, 'register failed: ' + JSON.stringify(r.json));
  if (verify) verifyEmail(email);
  return c;
}

async function loginClient(email) {
  const c = client(base);
  const r = await c.post('/api/auth/login', { email, password: PW });
  assert.equal(r.status, 200, 'login failed: ' + JSON.stringify(r.json));
  return c;
}

// Each test that needs a house account uses a different house email:
// the whitelist and the owner allowlist are small sets, and an email
// can only register once per database.

test('migrations applied: PR tables exist, 032 adds category shelves, 033 adds pr_events, 034 adds snapshot replies, 035 adds live_windows, 036 adds dashboard_payloads, 037 adds family_office', () => {
  const v = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
  assert.equal(v, 37);
  const snapshotCols = db.prepare('PRAGMA table_info(email_snapshots)').all().map(r => r.name);
  assert.ok(snapshotCols.includes('replies'), 'email_snapshots carries replies');
  const liveCols = db.prepare('PRAGMA table_info(live_windows)').all().map(r => r.name);
  assert.deepEqual(liveCols, ['tenant_id', 'payload_json', 'received_at'],
    'live_windows carries the pushed live payload per tenant');
  const dashCols = db.prepare('PRAGMA table_info(dashboard_payloads)').all().map(r => r.name);
  assert.deepEqual(dashCols, ['tenant_id', 'payload_json', 'received_at'],
    'dashboard_payloads carries the pushed dashboard payload per tenant');
  const foCols = db.prepare('PRAGMA table_info(pr_targets)').all().map(r => r.name);
  assert.deepEqual(foCols, ['id', 'tenant_id', 'publication', 'contact_name', 'role', 'beat',
    'contact_route', 'route_verified', 'tier', 'category', 'fit_note', 'source', 'status',
    'created_at', 'updated_at'],
    'pr_targets columns unchanged by the 037 shelf rebuild');
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('pr_targets', 'pr_releases', 'pr_pitches') ORDER BY name"
  ).all().map(r => r.name);
  assert.deepEqual(tables, ['pr_pitches', 'pr_releases', 'pr_targets']);
  const targetCols = db.prepare('PRAGMA table_info(pr_targets)').all().map(r => r.name);
  assert.ok(targetCols.includes('category'), 'pr_targets carries the shelf');
  const releaseCols = db.prepare('PRAGMA table_info(pr_releases)').all().map(r => r.name);
  assert.ok(releaseCols.includes('category'), 'pr_releases carries the shelf');
});

test('gate, unit level: who isPrAdmin lets in and keeps out', () => {
  // The house.
  assert.equal(isPrAdmin({ email: 'michael@faithshield.ai', role: 'viewer' }), true);
  assert.equal(isPrAdmin({ email: 'leon@faithshield.ai', role: 'viewer' }), true);
  assert.equal(isPrAdmin({ email: 'sid.allen@yahoo.com', role: 'viewer', email_verified_at: '2026-11-01' }), true);
  // Whitelisted but unverified: out (auth audit B6 posture).
  assert.equal(isPrAdmin({ email: 'sid.allen@yahoo.com', role: 'admin', email_verified_at: null }), false);
  // A tenant team member granted 'admin' inside their own tenant: out.
  assert.equal(isPrAdmin({ email: 'teammate@example.org', role: 'admin', email_verified_at: '2026-11-01' }), false);
  // A plain tenant owner: out.
  assert.equal(isPrAdmin({ email: 'owner@example.org', role: 'owner', email_verified_at: '2026-11-01' }), false);
  assert.equal(isPrAdmin(null), false);
  assert.equal(isPrAdmin({}), false);
});

test('gate, HTTP level: tenant accounts and unverified whitelist get 403, strangers 401', async () => {
  const tenant = await registeredClient('plain-tenant@example.org', { verify: true });
  for (const [method, url] of [
    ['get', '/api/pr/summary'],
    ['get', '/api/pr/targets'],
    ['get', '/api/pr/releases'],
    ['get', '/api/pr/pitches'],
  ]) {
    const r = await tenant[method](url);
    assert.equal(r.status, 403, `${method} ${url} should be 403, got ${r.status}`);
  }
  const post = await tenant.post('/api/pr/targets', { publication: 'Nope News' });
  assert.equal(post.status, 403);
  const imp = await tenant.post('/api/pr/targets/import', {});
  assert.equal(imp.status, 403);

  const unverified = await registeredClient('basedinfaith@mail.com'); // whitelisted, not verified
  const r2 = await unverified.get('/api/pr/targets');
  assert.equal(r2.status, 403, 'unverified whitelisted email must be refused');

  const stranger = client(base);
  const r3 = await stranger.get('/api/pr/targets');
  assert.equal(r3.status, 401);
});

test('targets: CRUD, validation, dedup, filters', async () => {
  const c = await registeredClient('sid.allen@yahoo.com', { verify: true });

  const bad = await c.post('/api/pr/targets', { contact_name: 'No Publication' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'publication_required');

  const badTier = await c.post('/api/pr/targets', { publication: 'X News', tier: 'platinum' });
  assert.equal(badTier.status, 400);
  assert.equal(badTier.json.error, 'invalid_tier');

  const created = await c.post('/api/pr/targets', {
    publication: 'Faith Daily', contact_name: 'Jane Editor', role: 'Religion editor',
    beat: 'Faith and technology', contact_route: 'jane@faithdaily.example',
    route_verified: true, tier: 'faith_major', fit_note: 'Covers church tech',
    source: 'https://faithdaily.example/contact',
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const t = created.json.target;
  assert.equal(t.publication, 'Faith Daily');
  assert.equal(t.route_verified, 1);
  assert.equal(t.status, 'active');

  const dup = await c.post('/api/pr/targets', {
    publication: 'Faith Daily', contact_name: 'Jane Editor',
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error, 'target_exists');

  const second = await c.post('/api/pr/targets', {
    publication: 'Chip Weekly', contact_name: 'Tom Maker', tier: 'tech',
    contact_route: 'route not yet confirmed', route_verified: false,
  });
  assert.equal(second.status, 201);

  const all = await c.get('/api/pr/targets');
  assert.equal(all.json.targets.length, 2);
  const majors = await c.get('/api/pr/targets?tier=faith_major');
  assert.equal(majors.json.targets.length, 1);
  assert.equal(majors.json.targets[0].publication, 'Faith Daily');
  const search = await c.get('/api/pr/targets?q=maker');
  assert.equal(search.json.targets.length, 1);
  assert.equal(search.json.targets[0].publication, 'Chip Weekly');

  const upd = await c.put(`/api/pr/targets/${t.id}`, { beat: 'Religion and AI', route_verified: false });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.target.beat, 'Religion and AI');
  assert.equal(upd.json.target.route_verified, 0);
  assert.equal(upd.json.target.contact_name, 'Jane Editor', 'partial update keeps other fields');

  const missing = await c.put('/api/pr/targets/99999', { beat: 'x' });
  assert.equal(missing.status, 404);

  const del = await c.del(`/api/pr/targets/${second.json.target.id}`);
  assert.equal(del.status, 200);
  const after = await c.get('/api/pr/targets');
  assert.equal(after.json.targets.length, 1);
});

test('releases: CRUD and status validation', async () => {
  const c = await registeredClient('michael@faithshield.ai', { verify: true });
  const bad = await c.post('/api/pr/releases', { body: 'no title' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'title_required');
  const badStatus = await c.post('/api/pr/releases', { title: 'X', status: 'blasted' });
  assert.equal(badStatus.status, 400);

  const created = await c.post('/api/pr/releases', {
    title: 'Five Loaves launch', subject_line: 'A suite for churches, built with Muse',
    body: 'FOR IMMEDIATE RELEASE...', status: 'draft',
  });
  assert.equal(created.status, 201);
  const rel = created.json.release;
  assert.equal(rel.status, 'draft');

  const upd = await c.put(`/api/pr/releases/${rel.id}`, { status: 'approved' });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.release.status, 'approved');
  assert.equal(upd.json.release.title, 'Five Loaves launch');

  const list = await c.get('/api/pr/releases?status=approved');
  assert.equal(list.json.releases.length, 1);

  const del = await c.del(`/api/pr/releases/${rel.id}`);
  assert.equal(del.status, 200);
  const after = await c.get('/api/pr/releases');
  assert.equal(after.json.releases.length, 0);
});

test('pitches: status flow stamps sent_at and reply_at; validation holds', async () => {
  const c = await registeredClient('leon@faithshield.ai');
  const t = (await c.post('/api/pr/targets', { publication: 'Grace Weekly', contact_name: 'Pat Faith' })).json.target;
  const rel = (await c.post('/api/pr/releases', { title: 'Launch release' })).json.release;

  const badTarget = await c.post('/api/pr/pitches', { target_id: 424242 });
  assert.equal(badTarget.status, 400);
  assert.equal(badTarget.json.error, 'invalid_target');
  const badRelease = await c.post('/api/pr/pitches', { target_id: t.id, release_id: 424242 });
  assert.equal(badRelease.status, 400);
  assert.equal(badRelease.json.error, 'invalid_release');
  const badStatus = await c.post('/api/pr/pitches', { target_id: t.id, status: 'yeeted' });
  assert.equal(badStatus.status, 400);

  const created = await c.post('/api/pr/pitches', {
    target_id: t.id, release_id: rel.id, follow_up_due: '2026-11-10', notes: 'First touch drafted',
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const p = created.json.pitch;
  assert.equal(p.status, 'drafted');
  assert.equal(p.target_publication, 'Grace Weekly');
  assert.equal(p.release_title, 'Launch release');
  assert.equal(p.sent_at, null);

  const approved = await c.patch(`/api/pr/pitches/${p.id}`, { status: 'approved' });
  assert.equal(approved.json.pitch.status, 'approved');
  assert.equal(approved.json.pitch.sent_at, null, 'approval does not stamp sent_at');

  const sent = await c.patch(`/api/pr/pitches/${p.id}`, { status: 'sent' });
  assert.equal(sent.json.pitch.status, 'sent');
  assert.ok(sent.json.pitch.sent_at, 'sent_at stamped on the sent transition');

  const replied = await c.patch(`/api/pr/pitches/${p.id}`, { status: 'replied' });
  assert.equal(replied.json.pitch.status, 'replied');
  assert.ok(replied.json.pitch.reply_at, 'reply_at stamped on the replied transition');
  assert.equal(replied.json.pitch.sent_at, sent.json.pitch.sent_at, 'sent_at is not restamped');

  const covered = await c.patch(`/api/pr/pitches/${p.id}`, { status: 'covered', notes: 'Ran the story' });
  assert.equal(covered.json.pitch.status, 'covered');
  assert.equal(covered.json.pitch.notes, 'Ran the story');

  const badPatch = await c.patch(`/api/pr/pitches/${p.id}`, { status: 'viral' });
  assert.equal(badPatch.status, 400);

  const byStatus = await c.get('/api/pr/pitches?status=covered');
  assert.equal(byStatus.json.pitches.length, 1);
  const byTarget = await c.get(`/api/pr/pitches?target_id=${t.id}`);
  assert.equal(byTarget.json.pitches.length, 1);

  const summary = await c.get('/api/pr/summary');
  assert.equal(summary.json.summary.pitches, 1);
  assert.equal(summary.json.summary.pitches_sent, 1);

  const del = await c.del(`/api/pr/pitches/${p.id}`);
  assert.equal(del.status, 200);
});

test('tenant isolation: a second house account sees none of the first tenant\'s PR data', async () => {
  const a = await registeredClient('mikemixer2002@gmail.com', { verify: true });
  const t = (await a.post('/api/pr/targets', { publication: 'Isolated Times', contact_name: 'Solo' })).json.target;
  const p = (await a.post('/api/pr/pitches', { target_id: t.id })).json.pitch;

  const b = await registeredClient('1faithshieldai@gmail.com', { verify: true });
  const list = await b.get('/api/pr/targets');
  assert.equal(list.status, 200, 'second whitelisted account passes the gate');
  assert.equal(list.json.targets.length, 0, 'but sees only its own tenant');
  const patch = await b.patch(`/api/pr/pitches/${p.id}`, { status: 'sent' });
  assert.equal(patch.status, 404);
  const put = await b.put(`/api/pr/targets/${t.id}`, { beat: 'hijack' });
  assert.equal(put.status, 404);
});

const SAMPLE_MD = `# Researched press targets
Working list, gathered 2026-11-01.

## Tier 1: Faith press majors

| Publication | Contact | Role | Beat | Contact route | Verified | Tier | Fit | Source |
|---|---|---|---|---|---|---|---|---|
| Faith Daily | Jane Editor | Religion editor | Faith and tech | jane@faithdaily.example | yes | Tier 1 | Covers church tech | https://faithdaily.example/contact |
| Grace Weekly | | News desk | Church news | contact route unverified | no | Tier 1 | Big denominational reach | https://graceweekly.example |
| Wire Faith | Sam Stringer | Reporter | Religion | sam@wirefaith.example | | Tech | Wire pickup | https://wirefaith.example |

## Tier 3: Faith-tech niche

### Church Tech Weekly
- Contact: Tom Maker
- Role: Editor
- Beat: Church technology
- Contact route: https://churchtechweekly.example/pitch
- Verified: yes
- Fit: Reviews tools built for churches
- Source: https://churchtechweekly.example/about

## Notes
- Call the Faith Daily desk on Tuesdays.
`;

function freshTenantId(slug) {
  const r = unscoped.createTenant('Seed Co ' + slug, slug, 'starter');
  return Number(r.lastInsertRowid);
}

test('seeder: parses tables and sections, marks verification conservatively, idempotent', () => {
  const tenantId = freshTenantId('pr-seed-co');
  const tdb = forTenant(tenantId);
  const before = tdb.listPrTargets({}).length;

  const parsed = parsePrTargetsMarkdown(SAMPLE_MD);
  assert.equal(parsed.length, 4, 'four real entries; the Notes heading is not a connection');
  const byPub = Object.fromEntries(parsed.map(e => [e.publication, e]));
  assert.equal(byPub['Faith Daily'].tier, 'faith_major');
  assert.equal(byPub['Faith Daily'].route_verified, 1);
  assert.equal(byPub['Faith Daily'].category, 'faith_based', 'faith tier sits on the Faith-Based shelf');
  assert.equal(byPub['Faith Daily'].status, 'active');
  assert.equal(byPub['Grace Weekly'].contact_name, null);
  assert.equal(byPub['Grace Weekly'].route_verified, 0, 'route text says unverified, stays unverified');
  assert.equal(byPub['Wire Faith'].tier, 'tech');
  assert.equal(byPub['Wire Faith'].category, 'mainstream', 'tech tier sits on the Mainstream shelf');
  assert.equal(byPub['Wire Faith'].route_verified, 0, 'no explicit verified marker, stays unverified');
  assert.equal(byPub['Church Tech Weekly'].tier, 'niche');
  assert.equal(byPub['Church Tech Weekly'].category, 'faith_based', 'the faith-tech niche is a Faith-Based shelf');
  assert.equal(byPub['Church Tech Weekly'].route_verified, 1);
  assert.equal(byPub['Church Tech Weekly'].contact_name, 'Tom Maker');

  const r1 = seedPrTargets(db, { tenantId, text: SAMPLE_MD });
  assert.equal(r1.inserted, 4);
  assert.equal(tdb.listPrTargets({}).length, before + 4);

  const r2 = seedPrTargets(db, { tenantId, text: SAMPLE_MD });
  assert.equal(r2.inserted, 0, 'second run inserts nothing');
  assert.equal(r2.skipped, 4);
  assert.equal(tdb.listPrTargets({}).length, before + 4);
});

test('seeder: missing file is a quiet no-op with a reason', () => {
  const r = seedPrTargets(db, {
    tenantId: freshTenantId('pr-seed-missing-co'),
    filePath: path.join(os.tmpdir(), 'definitely-not-here-targets.md'),
  });
  assert.equal(r.inserted, 0);
  assert.equal(r.reason, 'file_missing');
});

test('seeder: a numbered heading with "tier" inside its name still parses as an entry', () => {
  // Regression (2026-11-10): the real file's entry 2543,
  // "Frontiers of Faith", tripped the tier-label classification
  // ("Fron**tier**s" matches the tier regex and "of Faith" maps to
  // the faith_major tier), so its heading was swallowed as a tier
  // label and the entry was never imported. A numbered heading is
  // always an entry.
  const md = `## Tier 1: Faith majors

### 2543. Frontiers of Faith (SiriusXM, The Catholic Channel)
- **Why it fits:** A weekly show on Catholic missionary territories.
- **Named contact:** Katie Ruvalcaba, co-host.
- **Pitch route:** **Contact route unverified.** DO NOT PITCH.
- **Verified from:** SiriusXM, The Catholic Channel page.

### 2544. Next Outlet
- Contact: Jane Editor
- Contact route: https://nextoutlet.example/pitch
- Verified: yes
`;
  const parsed = parsePrTargetsMarkdown(md);
  const byPub = Object.fromEntries(parsed.map(e => [e.publication, e]));
  assert.ok(byPub['Frontiers of Faith'], 'the numbered "Frontiers" heading parses as an entry, not a tier label');
  assert.equal(byPub['Frontiers of Faith'].tier, 'faith_major', 'it keeps the tier context of the section it sits in');
  assert.equal(byPub['Frontiers of Faith'].status, 'do_not_pitch', 'its own DO NOT PITCH route still parks it');
  assert.ok(byPub['Next Outlet'], 'the entry after it still parses');
});

test('import endpoint: seeds the caller tenant from PR_TARGETS_FILE, then no-ops', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-import-'));
  const file = path.join(dir, 'targets.md');
  fs.writeFileSync(file, SAMPLE_MD);
  const prev = process.env.PR_TARGETS_FILE;
  process.env.PR_TARGETS_FILE = file;
  try {
    // 1faithshieldai was registered (and verified) by the isolation
    // test above; log back in rather than registering twice.
    const c = await loginClient('1faithshieldai@gmail.com');
    const first = await c.post('/api/pr/targets/import', {});
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.import.inserted, 4);
    const second = await c.post('/api/pr/targets/import', {});
    assert.equal(second.json.import.inserted, 0);
    assert.equal(second.json.import.skipped, 4);
    const list = await c.get('/api/pr/targets');
    assert.equal(list.json.targets.length, 4);
  } finally {
    if (prev === undefined) delete process.env.PR_TARGETS_FILE;
    else process.env.PR_TARGETS_FILE = prev;
  }
});

// --- Categories (Michael, 2026-11-01): "Faith-Based" and "Mainstream" ---
// The connections list sits on two shelves; releases sit on the same
// two shelves because "those releases are different"; a pitch
// defaults to a release from its target's own shelf.

test('categories: target validation, tier-derived default, filter', async () => {
  const c = await loginClient('sid.allen@yahoo.com');

  const badCat = await c.post('/api/pr/targets', { publication: 'Bad Shelf News', category: 'regular' });
  assert.equal(badCat.status, 400);
  assert.equal(badCat.json.error, 'invalid_category');

  // No shelf named: the tier decides. (The CRUD test above already
  // left a faith_major 'Faith Daily' and deleted its tech target;
  // these use fresh publications to stay independent.)
  const techT = (await c.post('/api/pr/targets', { publication: 'Circuit Times', tier: 'tech' })).json.target;
  assert.equal(techT.category, 'mainstream', 'tech tier defaults to the Mainstream shelf');
  const faithT = (await c.post('/api/pr/targets', { publication: 'Hymn Herald', tier: 'faith_major' })).json.target;
  assert.equal(faithT.category, 'faith_based', 'faith tier defaults to the Faith-Based shelf');
  const explicit = (await c.post('/api/pr/targets', {
    publication: 'Cross Shelf Journal', tier: 'tech', category: 'faith_based',
  })).json.target;
  assert.equal(explicit.category, 'faith_based', 'an explicit shelf wins over the tier default');

  const badFilter = await c.get('/api/pr/targets?category=regular');
  assert.equal(badFilter.status, 400);
  const mainstream = await c.get('/api/pr/targets?category=mainstream');
  assert.ok(mainstream.json.targets.every(t => t.category === 'mainstream'));
  assert.ok(mainstream.json.targets.some(t => t.publication === 'Circuit Times'));
  assert.ok(!mainstream.json.targets.some(t => t.publication === 'Hymn Herald'));
  const faith = await c.get('/api/pr/targets?category=faith_based');
  assert.ok(faith.json.targets.some(t => t.publication === 'Hymn Herald'));

  const upd = await c.put(`/api/pr/targets/${techT.id}`, { category: 'faith_based' });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.target.category, 'faith_based', 'a connection can be re-shelved');
  const updBack = await c.put(`/api/pr/targets/${techT.id}`, { category: 'mainstream' });
  assert.equal(updBack.json.target.category, 'mainstream');

  const parked = (await c.post('/api/pr/targets', {
    publication: 'Hidden Door Weekly', status: 'do_not_pitch',
  })).json.target;
  assert.equal(parked.status, 'do_not_pitch');
  const parkedList = await c.get('/api/pr/targets?status=do_not_pitch');
  assert.ok(parkedList.json.targets.some(t => t.publication === 'Hidden Door Weekly'));
  const summary = await c.get('/api/pr/summary');
  assert.ok(summary.json.summary.targets_do_not_pitch >= 1);
});

test('categories: releases carry the shelf and filter by it', async () => {
  const c = await loginClient('michael@faithshield.ai');
  const badCat = await c.post('/api/pr/releases', { title: 'Bad shelf', category: 'regular' });
  assert.equal(badCat.status, 400);
  assert.equal(badCat.json.error, 'invalid_category');

  const faithRel = (await c.post('/api/pr/releases', {
    title: 'Ministry cut', category: 'faith_based', body: 'Leads with the ministry angle',
  })).json.release;
  assert.equal(faithRel.category, 'faith_based');
  const mainRel = (await c.post('/api/pr/releases', {
    title: 'Tech cut', category: 'mainstream', body: 'Leads with the agent story',
  })).json.release;
  assert.equal(mainRel.category, 'mainstream');
  const defaulted = (await c.post('/api/pr/releases', { title: 'Unshelved draft' })).json.release;
  assert.equal(defaulted.category, 'faith_based', 'a release with no shelf named defaults to Faith-Based');

  const faithList = await c.get('/api/pr/releases?category=faith_based');
  assert.ok(faithList.json.releases.every(r => r.category === 'faith_based'));
  assert.ok(faithList.json.releases.some(r => r.title === 'Ministry cut'));
  assert.ok(!faithList.json.releases.some(r => r.title === 'Tech cut'));
  const badFilter = await c.get('/api/pr/releases?category=regular');
  assert.equal(badFilter.status, 400);

  const upd = await c.put(`/api/pr/releases/${mainRel.id}`, { category: 'faith_based' });
  assert.equal(upd.json.release.category, 'faith_based', 'a release can be re-shelved');
  await c.put(`/api/pr/releases/${mainRel.id}`, { category: 'mainstream' });
});

test('pitch default pairing: a pitch takes the newest release on the target shelf; do-not-pitch refuses', async () => {
  const c = await loginClient('leon@faithshield.ai');
  // Shelf stock (leon's tenant already holds one uncategorized-era
  // release from the flow test; these two are this test's shelves).
  const faithOld = (await c.post('/api/pr/releases', { title: 'Faith cut v1', category: 'faith_based' })).json.release;
  const faithNew = (await c.post('/api/pr/releases', { title: 'Faith cut v2', category: 'faith_based' })).json.release;
  const mainRel = (await c.post('/api/pr/releases', { title: 'Mainstream cut', category: 'mainstream' })).json.release;

  const mainTarget = (await c.post('/api/pr/targets', {
    publication: 'Metro Circuit', tier: 'tech',
  })).json.target;
  assert.equal(mainTarget.category, 'mainstream');
  const autoMain = (await c.post('/api/pr/pitches', { target_id: mainTarget.id })).json.pitch;
  assert.equal(autoMain.release_id, mainRel.id, 'mainstream target defaults to the mainstream release');

  const faithTarget = (await c.post('/api/pr/targets', {
    publication: 'Parish Post', tier: 'faith_major',
  })).json.target;
  const autoFaith = (await c.post('/api/pr/pitches', { target_id: faithTarget.id })).json.pitch;
  assert.equal(autoFaith.release_id, faithNew.id, 'faith target defaults to the NEWEST faith release');

  const override = (await c.post('/api/pr/pitches', {
    target_id: faithTarget.id, release_id: mainRel.id,
  })).json.pitch;
  assert.equal(override.release_id, mainRel.id, 'an explicit release overrides the shelf default');

  const parked = (await c.post('/api/pr/targets', {
    publication: 'No Door Gazette', status: 'do_not_pitch',
  })).json.target;
  const refused = await c.post('/api/pr/pitches', { target_id: parked.id });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error, 'target_do_not_pitch');
});

// --- The real connections file (2026-11-01): dry census ------------
// The owner's researched list must parse with the right shelf under
// every publication and the owner's exclusions parked. The file grew
// in passes the same day: 22 base entries, the WIRED/newspapers
// supplement (10), then Supplement 2, small Christian publications
// (15): 47 in all. If the file is edited, these numbers are the
// tripwire.
//
// The file did get edited, by standing order: since 2026-11-01 an
// hourly runner appends a new supplement wave to it, and the waves
// never touch the original sections. So the census below runs in two
// layers. The original 47-entry census is asserted at full strength
// against the original sections (everything before Supplement 3),
// and the grown file is asserted by exact invariants counted
// independently from the raw markdown, so a parser regression on
// either layer still fails here.

test('seeder: the real 2026-11-01 file parses shelved and parked correctly', () => {
  const { parsePrTargetsMarkdown: parse, defaultTargetsPath: targetsPath } = require('../src/lib/prTargetsSeed');
  const md = fs.readFileSync(targetsPath(), 'utf8');

  // The whole grown file: every numbered entry heading in the raw
  // file parses, exactly once. The heading count is computed from
  // the raw text here, not by the parser, so the two can disagree
  // and fail.
  const all = parse(md);
  const headingCount = (md.match(/^### \d+[.)]\s?\S/gm) || []).length;
  assert.equal(all.length, headingCount, 'every numbered entry in the grown file parses');
  assert.equal(all.filter(e => e.category === 'faith_based').length
    + all.filter(e => e.category === 'mainstream').length, all.length,
    'every parsed entry lands on one of the two shelves');
  assert.ok(all.filter(e => e.status !== 'do_not_pitch').every(e => e.status === 'active'));
  for (const name of ['ASSIST News Service', 'Axios', 'CBN News', 'Christian Today', 'Ministry Tech', 'Religion Unplugged', 'TIME']) {
    const e = all.find(x => x.publication === name);
    assert.ok(e && e.status === 'do_not_pitch', `the owner rule still parks ${name} in the grown file`);
  }

  // The original census: the file as this test was written against
  // it, everything before the Supplement 3 heading.
  const cut = md.search(/^## Supplement 3,/m);
  assert.ok(cut > 0, 'the Supplement 3 boundary is present in the file');
  const entries = parse(md.slice(0, cut));
  assert.equal(entries.length, 47, 'all 47 researched entries parse');

  const byCat = { faith_based: 0, mainstream: 0 };
  for (const e of entries) byCat[e.category]++;
  assert.equal(byCat.faith_based, 32, 'Tier 1 (11) + faith-tech niche (6) + Supplement 2 small Christian press (15)');
  assert.equal(byCat.mainstream, 15, 'Tier 2 (5) + the WIRED/newspapers supplement (10)');

  const parked = entries.filter(e => e.status === 'do_not_pitch').map(e => e.publication).sort();
  assert.deepEqual(parked, ['ASSIST News Service', 'Axios', 'CBN News', 'Christian Today', 'Ministry Tech', 'Religion Unplugged', 'TIME'],
    'the owner rule parks exactly the outlets with no published route');
  assert.ok(entries.filter(e => e.status !== 'do_not_pitch').every(e => e.status === 'active'));
  assert.equal(entries.filter(e => e.route_verified).length, 39, 'the file\u2019s own verified-route counts: 8 + 4 + 5 + 9 + 13');

  const byPub = Object.fromEntries(entries.map(e => [e.publication, e]));
  assert.equal(byPub['Christianity Today'].contact_name, 'Erik Petrik');
  assert.equal(byPub['Christianity Today'].category, 'faith_based');
  assert.equal(byPub['Christianity Today'].route_verified, 1);
  assert.equal(byPub['TechCrunch'].contact_name, 'Sarah Perez');
  assert.equal(byPub['TechCrunch'].category, 'mainstream');
  assert.equal(byPub['ChurchTechToday'].category, 'faith_based');
  assert.equal(byPub['ChurchTechToday'].route_verified, 1);
  assert.equal(byPub['TIME'].category, 'mainstream');
  assert.equal(byPub['TIME'].route_verified, 0, 'TIME publishes no route: unverified and parked');
  assert.equal(byPub['Ministry Tech'].contact_name, null, '"None current verified" means no contact on file');
  assert.equal(byPub['Associated Press'].contact_name, 'Holly Meyer', 'the "(Global Religion Team)" suffix is formatting, not name');
  // Supplement 2: the section heading names the shelf outright.
  assert.equal(byPub['WORLD'].category, 'faith_based');
  assert.equal(byPub['WORLD'].tier, 'niche', 'small Christian press sits in the niche tier, under the Faith-Based shelf');
  assert.equal(byPub['WORLD'].contact_name, 'Leigh Jones');
  assert.equal(byPub['The Christian Century'].contact_name, null);
  assert.equal(byPub['Christian Today'].status, 'do_not_pitch');
  assert.equal(byPub['Christian Today'].route_verified, 0);
});

test('seeder: the real file seeds a tenant with the census intact, idempotently', () => {
  const { parsePrTargetsMarkdown: parse, defaultTargetsPath: targetsPath } = require('../src/lib/prTargetsSeed');
  const entries = parse(fs.readFileSync(targetsPath(), 'utf8'));
  // The seeder inserts an entry only when no row exists for its
  // (publication, contact) pair, first occurrence wins. The grown
  // file boards a few outlets twice (a later wave re-researched an
  // outlet instead of updating its earlier entry), so the seeded
  // census is the parse deduplicated by that same rule.
  const seen = new Set();
  const census = [];
  for (const e of entries) {
    const k = `${e.publication}|${e.contact_name || ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    census.push(e);
  }
  const tenantId = freshTenantId('pr-real-file-co');
  const tdb = forTenant(tenantId);
  const r1 = seedPrTargets(db, { tenantId });
  assert.equal(r1.total, entries.length);
  assert.equal(r1.inserted, census.length);
  assert.equal(r1.skipped, entries.length - census.length);
  assert.equal(tdb.listPrTargets({ category: 'faith_based', limit: 100000 }).length,
    census.filter(e => e.category === 'faith_based').length);
  assert.equal(tdb.listPrTargets({ category: 'mainstream', limit: 100000 }).length,
    census.filter(e => e.category === 'mainstream').length);
  assert.equal(tdb.listPrTargets({ status: 'do_not_pitch', limit: 100000 }).length,
    census.filter(e => e.status === 'do_not_pitch').length);
  const r2 = seedPrTargets(db, { tenantId });
  assert.equal(r2.inserted, 0);
  assert.equal(r2.skipped, entries.length);
});
