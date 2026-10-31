'use strict';
/**
 * Media library seed — registers finished films that ship inside the
 * repo's media/ tree into content_items (the Content Library), so they
 * appear in Manna next to the rest of the library and play in the
 * in-app player (GET /api/content/:id/file).
 *
 * Why this exists (2026-10-31): Michael ordered the three final films
 * (Armor Bearer twin, FaithShield pastors, FaithShield parents) loaded
 * into MannaAi. Manna has no upload endpoint; library rows were only
 * ever created by scripts/load-videos.js run by hand against a DB.
 * This seeder runs the same registration at server startup,
 * idempotently: a film is inserted only when its file is present in
 * media/ and no content_items row carries its file_path yet.
 *
 * Rows are global (tenant_id NULL), exactly like scripts/load-videos.js:
 * the library is shared, every tenant sees them.
 *
 * Set MANNA_SKIP_MEDIA_SEED=1 to skip (the test harness does, and
 * covers this module directly instead).
 */
const fs = require('fs');
const path = require('path');

const MEDIA_DIR = path.join(__dirname, '..', '..', 'media');

// product, category, language, title, file_path (relative to media/)
const MEDIA_ITEMS = [
  ['armorbearer', 'influencer', 'en', 'Armor Bearer Twin Video (Final)',
    'armorbearer/en/armor-bearer-twin-final-2026-10-30.mp4'],
  ['faithshield', 'promo', 'en', 'FaithShield for Pastors (Final)',
    'faithshield/en/faithshield-pastors-final-2026-10-31.mp4'],
  ['faithshield', 'promo', 'en', 'FaithShield for Parents (Final)',
    'faithshield/en/faithshield-parents-final-2026-10-31.mp4'],
];

function seedMediaLibrary(db, mediaDir = MEDIA_DIR) {
  let inserted = 0;
  for (const [product, category, language, title, rel] of MEDIA_ITEMS) {
    const abs = path.join(mediaDir, rel);
    if (!fs.existsSync(abs)) continue;
    const existing = db.prepare(
      'SELECT id FROM content_items WHERE file_path = ?'
    ).get(rel);
    if (existing) continue;
    const stat = fs.statSync(abs);
    db.prepare(`
      INSERT INTO content_items
        (tenant_id, product, category, language, title, type, file_path, file_size_bytes)
      VALUES (NULL, ?, ?, ?, ?, 'video', ?, ?)
    `).run(product, category, language, title, rel, stat.size);
    inserted++;
  }
  return inserted;
}

module.exports = { seedMediaLibrary, MEDIA_ITEMS, MEDIA_DIR };
