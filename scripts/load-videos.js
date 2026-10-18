#!/usr/bin/env node
'use strict';
/**
 * Load videos into the Manna content library (video repository).
 *
 * Copies video files into media/<product>/<language>/ and registers them
 * in content_items with product, category, language metadata.
 *
 * Usage: node scripts/load-videos.js [--dry-run]
 */
const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry-run');
const REPO = path.join(__dirname, '..');
const MEDIA_DIR = path.join(REPO, 'media');
const FILES_DIR = '/home/hatch/workspace/goals/faithshield-and-angel-warriors-marketing-funnels/files';
const MANNA_VIDEOS = '/home/hatch/workspace/manna-competitor-videos';

// product, filename, category, language, title
const MANIFEST = [
  // ---- FaithShield ----
  ['faithshield', 'faithshield-promo-1-knowyourcongregation-en.mp4', 'promo', 'en', 'Know Your Congregation'],
  ['faithshield', 'faithshield-promo-2-sermoncoach-en.mp4', 'promo', 'en', 'Sermon Coach'],
  ['faithshield', 'faithshield-screenshot-tour-en.mp4', 'tour', 'en', 'App Tour'],
  // ---- Armor Bearer: Short 1 ----
  ['armorbearer', 'armor-bearer-short1-final.mp4', 'short', 'en', 'Armor Bearer Short 1'],
  ['armorbearer', 'armor-bearer-short1-final-logo.mp4', 'short', 'en', 'Armor Bearer Short 1 (Logo)'],
  ['armorbearer', 'armor-bearer-short1-es.mp4', 'short', 'es', 'Armor Bearer Short 1'],
  ['armorbearer', 'armor-bearer-short1-fr.mp4', 'short', 'fr', 'Armor Bearer Short 1'],
  ['armorbearer', 'armor-bearer-short1-de.mp4', 'short', 'de', 'Armor Bearer Short 1'],
  ['armorbearer', 'armor-bearer-short1-pt.mp4', 'short', 'pt', 'Armor Bearer Short 1'],
  ['armorbearer', 'armor-bearer-short1-tl.mp4', 'short', 'tl', 'Armor Bearer Short 1'],
  ['armorbearer', 'armor-bearer-short1-id.mp4', 'short', 'id', 'Armor Bearer Short 1'],
  // ---- Armor Bearer: Short 2 ----
  ['armorbearer', 'armor-bearer-short2-final.mp4', 'short', 'en', 'Armor Bearer Short 2'],
  ['armorbearer', 'armor-bearer-short2-final-logo.mp4', 'short', 'en', 'Armor Bearer Short 2 (Logo)'],
  ['armorbearer', 'armor-bearer-short2-es.mp4', 'short', 'es', 'Armor Bearer Short 2'],
  ['armorbearer', 'armor-bearer-short2-fr.mp4', 'short', 'fr', 'Armor Bearer Short 2'],
  ['armorbearer', 'armor-bearer-short2-de.mp4', 'short', 'de', 'Armor Bearer Short 2'],
  ['armorbearer', 'armor-bearer-short2-pt.mp4', 'short', 'pt', 'Armor Bearer Short 2'],
  ['armorbearer', 'armor-bearer-short2-tl.mp4', 'short', 'tl', 'Armor Bearer Short 2'],
  ['armorbearer', 'armor-bearer-short2-id.mp4', 'short', 'id', 'Armor Bearer Short 2'],
  // ---- Armor Bearer: Short 3 (English only) ----
  ['armorbearer', 'armor-bearer-short3-final.mp4', 'short', 'en', 'Armor Bearer Short 3'],
  // ---- Manna ----
  ['manna', 'manna-vs-mailerlite-v5.mp4', 'promo', 'en', 'Manna vs MailerLite'],
];

function srcDir(product) {
  return product === 'manna' ? MANNA_VIDEOS : FILES_DIR;
}

async function main() {
  const { migrate, db } = require('../src/db');
  migrate();

  let loaded = 0, skipped = 0;
  for (const [product, file, category, language, title] of MANIFEST) {
    const src = path.join(srcDir(product), file);
    if (!fs.existsSync(src)) {
      console.log(`SKIP (missing): ${file}`);
      skipped++;
      continue;
    }
    const destDir = path.join(MEDIA_DIR, product, language);
    const relPath = path.join(product, language, file);
    const existing = db.prepare(
      'SELECT id FROM content_items WHERE file_path = ?'
    ).get(relPath);
    if (existing) {
      skipped++;
      continue;
    }
    if (!DRY) {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, path.join(destDir, file));
      const stat = fs.statSync(src);
      db.prepare(`
        INSERT INTO content_items
          (tenant_id, product, category, language, title, type, file_path, file_size_bytes)
        VALUES (NULL, ?, ?, ?, ?, 'video', ?, ?)
      `).run(product, category, language, title, relPath, stat.size);
    }
    console.log(`${DRY ? 'WOULD LOAD' : 'LOADED'}: ${product}/${language}/${file}`);
    loaded++;
  }
  console.log(`\nDone: ${loaded} loaded, ${skipped} skipped.`);
}

main().catch(e => { console.error(e); process.exit(1); });
