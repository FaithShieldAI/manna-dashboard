'use strict';
/**
 * Regression tests for the red-team round 1 fixes around migration 022
 * (F-A1 / F-A2 / F-A4 / F-A5). All dynamic work happens on scratch DBs in
 * tmpdir; migrate() always runs in a CHILD process because src/db.js binds
 * its connection to DATABASE_PATH at require time.
 *
 *  F-A1: an orphaned podcast_outreach row (influencer_id with no parent)
 *        must be swept by 022, not crash the migration with an FK error.
 *  F-A2: migrate() applies by set difference — a DB stamped 24 with 022
 *        missing gets 022 applied; a DB recording a version with no file
 *        fails loud. The import guard probes the live schema, not MAX().
 *  F-A4: in-source duplicate emails are reported as their own tally, with
 *        their sends, on first run AND on idempotent re-runs.
 *  F-A5: NULL / empty / whitespace emails are rejected with a reason —
 *        no transaction-wide rollback, no junk '' row.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.join(__dirname, '..');
const MIG_DIR = path.join(REPO, 'migrations');
const DB_JS = path.join(REPO, 'src', 'db.js');
const IMPORT_JS = path.join(REPO, 'scripts', 'import-contacts.js');

function migFile(v) {
  const f = fs.readdirSync(MIG_DIR).find(n => parseInt(n.split('_')[0], 10) === v);
  assert.ok(f, `migration file for version ${v} should exist`);
  return path.join(MIG_DIR, f);
}

function applyMigration(db, v) {
  const sql = fs.readFileSync(migFile(v), 'utf8');
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(v);
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    throw e;
  }
}

function scratchDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2rm-mig022fix-'));
  return path.join(dir, name);
}

/** Build a pre-022 DB (migrations 001..021) with seed data. */
function buildPre022(dbPath, { orphan = false, stampExtra = [] } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  for (let v = 1; v <= 21; v++) applyMigration(db, v);
  db.exec('PRAGMA foreign_keys = OFF;');
  db.prepare("INSERT INTO tenants (id, name, slug, plan) VALUES (1, 'Seed Co', 'seed-co', 'pro')").run();
  db.prepare("INSERT INTO users (id, tenant_id, email, password_hash, display_name, role) VALUES (1, 1, 'michael@faithshield.ai', 'x', 'Owner', 'owner')").run();
  const ins = db.prepare(`INSERT INTO influencers
    (id, tenant_id, handle, platform, email, category, status, notes, source, emails_sent)
    VALUES (?, 1, ?, 'youtube', ?, ?, 'unvetted', ?, 'seed', ?)`);
  ins.run(1, 'host-one', 'host1@example.org', 'podcast', 'note-one', 3);
  ins.run(2, 'pastor-one', 'pastor1@example.org', 'pastor', 'note-two', 0);
  ins.run(3, 'other-one', 'other1@example.org', 'influencer', 'note-three', 1);
  db.prepare("INSERT INTO podcast_outreach (id, tenant_id, influencer_id, pitch_status) VALUES (1, 1, 1, 'pitched')").run();
  if (orphan) {
    db.prepare("INSERT INTO podcast_outreach (id, tenant_id, influencer_id, pitch_status) VALUES (2, 1, 999999, 'identified')").run();
  }
  db.exec('PRAGMA foreign_keys = ON;');
  for (const v of stampExtra) applyMigration(db, v);
  db.close();
}

function runMigrate(dbPath) {
  const script = `
    process.env.DATABASE_PATH = process.argv[1];
    const { migrate, db } = require(process.argv[2]);
    migrate();
    const vers = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version);
    console.log('VERSIONS ' + vers.join(','));
  `;
  return spawnSync(process.execPath, ['-e', script, dbPath, DB_JS], { encoding: 'utf8' });
}

function dump(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const out = {
    // Migration 027 (affiliate arsenal preload) added influencers.external_id.
    // These tests assert 022-era DATA preservation across migrate(), so the
    // 027 column is stripped from the byte-identity comparison — every
    // pre-existing column is still compared exactly. (027's own behavior is
    // covered by tests/arsenalSeed.test.js.)
    influencers: db.prepare('SELECT * FROM influencers ORDER BY id').all()
      .map(r => { const { external_id, ...rest } = r; return rest; }),
    podcast: db.prepare('SELECT * FROM podcast_outreach ORDER BY id').all(),
    infSql: db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='influencers'").get().sql,
    fkViolations: db.prepare('PRAGMA foreign_key_check').all().length,
  };
  db.close();
  return out;
}

test('F-A1: orphaned podcast_outreach row is swept by 022; real data byte-identical', () => {
  const p = scratchDb('orphan.db');
  buildPre022(p, { orphan: true });
  const before = dump(p);
  assert.equal(before.podcast.length, 2, 'seed should include the orphan');

  const r = runMigrate(p);
  assert.equal(r.status, 0, `migrate should succeed despite the orphan: ${r.stdout} ${r.stderr}`);

  const after = dump(p);
  assert.deepEqual(after.influencers, before.influencers, 'influencer rows must be untouched');
  assert.equal(after.podcast.length, 1, 'orphan row must be swept');
  assert.equal(after.podcast[0].influencer_id, 1, 'the valid outreach row must survive');
  assert.equal(after.fkViolations, 0, 'foreign_key_check must be clean');
  assert.ok(after.infSql.includes("'individual'"), '022 must have rebuilt the table');
});

test('F-A2: DB stamped 24 with 022 missing gets 022 applied (no silent skip)', () => {
  const p = scratchDb('gap.db');
  buildPre022(p, { stampExtra: [23, 24] });
  const before = dump(p);
  assert.ok(!before.infSql.includes("'individual'"), 'precondition: schema is pre-022');

  const r = runMigrate(p);
  assert.equal(r.status, 0, `migrate should succeed: ${r.stdout} ${r.stderr}`);
  assert.match(r.stdout, /VERSIONS .*22/, 'version 22 must be recorded after migrate');

  const after = dump(p);
  assert.ok(after.infSql.includes("'individual'"), '022 must actually be applied');
  assert.deepEqual(after.influencers, before.influencers, 'data preserved across the gap fill');
  assert.equal(after.fkViolations, 0);
});

test('F-A2: a recorded version with no migration file fails loud', () => {
  const p = scratchDb('unknown.db');
  buildPre022(p);
  const db = new DatabaseSync(p);
  db.prepare('INSERT INTO schema_migrations (version) VALUES (999)').run();
  db.close();

  const r = runMigrate(p);
  assert.notEqual(r.status, 0, 'migrate must refuse a DB it cannot account for');
  assert.match(`${r.stdout}\n${r.stderr}`, /version 999/, 'error must name the unaccounted version');
});

test('F-A2: import guard refuses a pre-022-schema DB (stamped 24) and writes zero rows', () => {
  const target = scratchDb('pre022.db');
  buildPre022(target, { stampExtra: [23, 24] });
  const src = buildSourceDb();

  const r = spawnSync(process.execPath, [IMPORT_JS, '--db', target, '--source', src], { encoding: 'utf8' });
  assert.equal(r.status, 1, `import must refuse: ${r.stdout} ${r.stderr}`);
  assert.match(r.stderr, /predates migration 022/, 'refusal must explain the schema probe failed');

  const after = dump(target);
  assert.equal(after.influencers.length, 3, 'only the seed rows — import wrote nothing');
});

function buildSourceDb() {
  const p = scratchDb('source.db');
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE contacts (
    id INTEGER PRIMARY KEY, category TEXT, subcategory TEXT, first_name TEXT,
    email TEXT, notes TEXT, source_file TEXT, created_at TEXT);
  CREATE TABLE sends (
    id INTEGER PRIMARY KEY, contact_id INTEGER, campaign_name TEXT,
    provider TEXT, sent_at TEXT);`);
  const ins = db.prepare('INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run(1, 'pastor', 'senior/en', 'Pastor A', 'Dupe@Example.org', '', 'pastors.csv', '2026-01-01T00:00:00Z');
  ins.run(2, 'other', null, 'Person B', 'personb@example.org', '', 'others.csv', '2026-01-02T00:00:00Z');
  ins.run(3, 'influencer', 'micro', 'Creator A', 'dupe@example.org', '', 'influencers.csv', '2026-01-03T00:00:00Z');
  ins.run(4, 'pastor', null, 'No Email', null, '', 'pastors.csv', '2026-01-04T00:00:00Z');
  ins.run(5, 'influencer', null, 'Empty Email', '', '', 'influencers.csv', '2026-01-05T00:00:00Z');
  ins.run(6, 'influencer', null, 'Blank Email', '   ', '', 'influencers.csv', '2026-01-06T00:00:00Z');
  ins.run(7, 'influencer', 'nano', 'Creator C', 'creatorc@example.org', '', 'influencers.csv', '2026-01-07T00:00:00Z');
  const insS = db.prepare('INSERT INTO sends VALUES (?, ?, ?, ?, ?)');
  let sid = 0;
  const send = (cid, n) => { for (let i = 0; i < n; i++) insS.run(++sid, cid, 'Pastor Wave 1', 'brevo', '2026-02-01T00:00:00Z'); };
  send(1, 2); send(2, 1); send(3, 3); send(4, 1); send(7, 1);
  db.close();
  return p;
}

function buildMigratedTarget() {
  const p = scratchDb('target.db');
  buildPre022(p);
  const r = runMigrate(p);
  assert.equal(r.status, 0, `target migrate should succeed: ${r.stdout} ${r.stderr}`);
  return p;
}

function runImport(target, src) {
  return spawnSync(process.execPath, [IMPORT_JS, '--db', target, '--source', src], { encoding: 'utf8' });
}

test('F-A4/F-A5: duplicates and malformed emails tally correctly; valid rows import; re-run idempotent', () => {
  const target = buildMigratedTarget();
  const src = buildSourceDb();

  const r1 = runImport(target, src);
  assert.equal(r1.status, 0, `first import should succeed: ${r1.stdout} ${r1.stderr}`);
  assert.match(r1.stdout, /Inserted: 3\b/, 'three valid contacts import');
  assert.match(r1.stdout, /in-source duplicates \(skipped\): 1/, 'duplicate tallied separately');
  assert.match(r1.stdout, /DUPLICATE in source: dupe@example\.org/, 'duplicate named with the kept contact');
  assert.match(r1.stdout, /Sends belonging to in-source duplicates \(aggregate-only, first occurrence kept\): 3/, 'duplicate sends tallied');
  assert.match(r1.stdout, /rejected: 3/, 'three malformed emails rejected');
  assert.match(r1.stdout, /invalid email '\(null\)'/, 'NULL email rejected with reason');
  assert.match(r1.stdout, /Sends whose contact was rejected \(aggregate-only, no per-contact home\): 1/, 'rejected sends tallied');
  assert.match(r1.stdout, /Sends linked per-contact \(emails_sent set on insert\): 4 across 3 contacts/, 'linked sends tallied');

  const after1 = dump(target);
  const imported = after1.influencers.filter(r => r.source && r.source.includes('import:'));
  assert.equal(imported.length, 3, 'exactly the valid contacts landed');
  const dupe = imported.find(r => r.email === 'dupe@example.org');
  assert.equal(dupe.category, 'pastor', 'first-by-id wins the classification');
  assert.equal(dupe.emails_sent, 2, "winner carries its own sends only");
  assert.ok(imported.some(r => r.category === 'individual'), "'other' landed as 'individual'");
  assert.equal(after1.influencers.filter(r => r.email === '').length, 0, 'no junk empty-email row');
  const totalAfter1 = after1.influencers.length;

  const r2 = runImport(target, src);
  assert.equal(r2.status, 0, `re-run should succeed: ${r2.stdout} ${r2.stderr}`);
  assert.match(r2.stdout, /Inserted: 0\b/, 're-run inserts nothing twice');
  assert.match(r2.stdout, /in-source duplicates \(skipped\): 1/, 'duplicate still classified on re-run');
  assert.match(r2.stdout, /Sends belonging to already-present contacts \(stats set at their original insert\): 4/, 'winner sends accounted on re-run');
  const after2 = dump(target);
  assert.equal(after2.influencers.length, totalAfter1, 'row count unchanged on re-run');
  assert.deepEqual(after2.influencers, after1.influencers, 'rows byte-identical after re-run');
});
