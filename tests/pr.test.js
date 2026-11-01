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

test('migration 031 applied: PR tables exist', () => {
  const v = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
  assert.equal(v, 31);
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('pr_targets', 'pr_releases', 'pr_pitches') ORDER BY name"
  ).all().map(r => r.name);
  assert.deepEqual(tables, ['pr_pitches', 'pr_releases', 'pr_targets']);
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
  assert.equal(byPub['Grace Weekly'].contact_name, null);
  assert.equal(byPub['Grace Weekly'].route_verified, 0, 'route text says unverified, stays unverified');
  assert.equal(byPub['Wire Faith'].tier, 'tech');
  assert.equal(byPub['Wire Faith'].route_verified, 0, 'no explicit verified marker, stays unverified');
  assert.equal(byPub['Church Tech Weekly'].tier, 'niche');
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
