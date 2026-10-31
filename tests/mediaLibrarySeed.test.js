'use strict';
/**
 * Media library seed (2026-10-31): the three final films ship in the
 * repo media/ tree and must register into content_items (global,
 * tenant_id NULL) exactly once, skipping files that are absent.
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
const { seedMediaLibrary, MEDIA_ITEMS } = require('../src/lib/mediaLibrarySeed');

function mediaDirWith(rels) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manna-media-'));
  for (const rel of rels) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.alloc(1234, 7));
  }
  return dir;
}

test('seeder registers all shipped finals once, global and playable rows', () => {
  const rels = MEDIA_ITEMS.map(m => m[4]);
  const dir = mediaDirWith(rels);

  const n = seedMediaLibrary(db, dir);
  assert.equal(n, 3);

  const rows = db.prepare(
    'SELECT * FROM content_items WHERE file_path IN (?, ?, ?) ORDER BY file_path'
  ).all(...rels);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.tenant_id, null);
    assert.equal(row.type, 'video');
    assert.equal(row.language, 'en');
    assert.equal(row.file_size_bytes, 1234);
  }
  const byPath = Object.fromEntries(rows.map(r => [r.file_path, r]));
  assert.equal(byPath['armorbearer/en/armor-bearer-twin-final-2026-10-30.mp4'].product, 'armorbearer');
  assert.equal(byPath['faithshield/en/faithshield-pastors-final-2026-10-31.mp4'].title, 'FaithShield for Pastors (Final)');
  assert.equal(byPath['faithshield/en/faithshield-parents-final-2026-10-31.mp4'].title, 'FaithShield for Parents (Final)');

  // idempotent: a second run inserts nothing
  assert.equal(seedMediaLibrary(db, dir), 0);
});

test('seeder skips files that are not on disk yet', () => {
  const rels = MEDIA_ITEMS.map(m => m[4]);
  // Drop the parents row, then seed from a dir that lacks its file.
  db.prepare('DELETE FROM content_items WHERE file_path = ?').run(rels[2]);
  const partial = mediaDirWith(rels.slice(0, 2));
  assert.equal(seedMediaLibrary(db, partial), 0);
  const gone = db.prepare('SELECT id FROM content_items WHERE file_path = ?').get(rels[2]);
  assert.equal(gone, undefined);

  // Once the file ships, the next run registers it.
  const full = mediaDirWith(rels);
  assert.equal(seedMediaLibrary(db, full), 1);
});
