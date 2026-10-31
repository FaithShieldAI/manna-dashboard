'use strict';
/**
 * Media library seed (2026-10-31): finished films ship in the repo
 * media/ tree and register into content_items automatically at
 * startup — curated titles for known films, a derived title for a
 * brand-new file, global rows (tenant_id NULL), exactly once each.
 * The startup call is skipped in the harness (MANNA_SKIP_MEDIA_SEED);
 * this test drives the seeder directly against the app DB.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setupTestEnv, startServer } = require('./helpers');

setupTestEnv();

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

const { db } = require('../src/db');
const { seedMediaLibrary } = require('../src/lib/mediaLibrarySeed');

const FINALS = [
  'armorbearer/en/armor-bearer-twin-final-2026-10-30.mp4',
  'faithshield/en/faithshield-pastors-final-2026-10-31.mp4',
  'faithshield/en/faithshield-parents-final-2026-10-31.mp4',
];

function mediaDirWith(rels) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manna-media-'));
  for (const rel of rels) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.alloc(1234, 7));
  }
  return dir;
}

test('the three finals register once, global, with curated titles', () => {
  const dir = mediaDirWith(FINALS);
  assert.equal(seedMediaLibrary(db, dir), 3);

  const rows = db.prepare(
    'SELECT * FROM content_items WHERE file_path IN (?, ?, ?) ORDER BY file_path'
  ).all(...FINALS);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.tenant_id, null);
    assert.equal(row.type, 'video');
    assert.equal(row.language, 'en');
    assert.equal(row.file_size_bytes, 1234);
  }
  const byPath = Object.fromEntries(rows.map(r => [r.file_path, r]));
  assert.equal(byPath[FINALS[0]].product, 'armorbearer');
  assert.equal(byPath[FINALS[0]].title, 'Armor Bearer Twin Video (Final)');
  assert.equal(byPath[FINALS[1]].title, 'FaithShield for Pastors (Final)');
  assert.equal(byPath[FINALS[2]].title, 'FaithShield for Parents (Final)');

  // idempotent: a second run inserts nothing
  assert.equal(seedMediaLibrary(db, dir), 0);
});

test('seeder skips files that are not on disk yet', () => {
  db.prepare('DELETE FROM content_items WHERE file_path = ?').run(FINALS[2]);
  const partial = mediaDirWith(FINALS.slice(0, 2));
  assert.equal(seedMediaLibrary(db, partial), 0);
  assert.equal(db.prepare('SELECT id FROM content_items WHERE file_path = ?').get(FINALS[2]), undefined);

  // Once the file ships, the next run registers it.
  assert.equal(seedMediaLibrary(db, mediaDirWith(FINALS)), 1);
});

test('automation: a new film registers on its own; junk is ignored', () => {
  const dir = mediaDirWith(['faithshield/en/new-hook-test.mp4', 'bogus/en/whatever.mp4']);
  fs.writeFileSync(path.join(dir, 'faithshield/en/notes.txt'), 'not a film');

  assert.equal(seedMediaLibrary(db, dir), 1);
  const row = db.prepare('SELECT * FROM content_items WHERE file_path = ?')
    .get('faithshield/en/new-hook-test.mp4');
  assert.ok(row, 'new film should be registered');
  assert.equal(row.title, 'New hook test');
  assert.equal(row.category, 'general');
  assert.equal(row.product, 'faithshield');
  assert.equal(
    db.prepare('SELECT id FROM content_items WHERE file_path = ?').get('bogus/en/whatever.mp4'),
    undefined
  );
  // and it is not registered twice
  assert.equal(seedMediaLibrary(db, dir), 0);
});
