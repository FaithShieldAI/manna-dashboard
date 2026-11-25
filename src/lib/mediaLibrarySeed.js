'use strict';
/**
 * Media library seed — the automated registration step for Manna's
 * Content Library (2026-10-31: finished films are part of
 * the automated process, not a hand-run chore).
 *
 * Manna has no upload endpoint; library films ship inside the repo's
 * media/ tree and are registered in content_items so they appear in
 * the Content Library and play in the in-app player
 * (GET /api/content/:id/file). This seeder runs at server startup and
 * registers EVERY .mp4 found under media/<product>/<language>/ that
 * has no content_items row yet, so shipping a film is the whole job:
 * registration, and Scribe's library watch (scribeData), follow
 * automatically.
 *
 * Known films carry curated titles/categories (CURATED below, the
 * same titles scripts/load-videos.js used); a brand-new file gets a
 * title derived from its filename and category 'general' until
 * someone curates it. Rows are global (tenant_id NULL), exactly like
 * the old loader: the library is shared, every tenant sees them.
 * Products are limited to the content_items CHECK list, so a stray
 * directory can never break the insert.
 *
 * Set MANNA_SKIP_MEDIA_SEED=1 to skip (the test harness does, and
 * covers this module directly instead).
 */
const fs = require('fs');
const path = require('path');

const MEDIA_DIR = path.join(__dirname, '..', '..', 'media');
const PRODUCTS = ['faithshield', 'armorbearer', 'manna', 'kpkunk', 'sustained'];

// file_path (relative to media/) -> { category, title }
const CURATED = {
  'faithshield/en/faithshield-promo-1-knowyourcongregation-en.mp4': { category: 'promo', title: 'Know Your Congregation' },
  'faithshield/en/faithshield-promo-2-sermoncoach-en.mp4': { category: 'promo', title: 'Sermon Coach' },
  'faithshield/en/faithshield-screenshot-tour-en.mp4': { category: 'tour', title: 'App Tour' },
  'armorbearer/en/armor-bearer-short1-final.mp4': { category: 'short', title: 'Armor Bearer Short 1' },
  'armorbearer/en/armor-bearer-short1-final-logo.mp4': { category: 'short', title: 'Armor Bearer Short 1 (Logo)' },
  'armorbearer/es/armor-bearer-short1-es.mp4': { category: 'short', title: 'Armor Bearer Short 1' },
  'armorbearer/fr/armor-bearer-short1-fr.mp4': { category: 'short', title: 'Armor Bearer Short 1' },
  'armorbearer/de/armor-bearer-short1-de.mp4': { category: 'short', title: 'Armor Bearer Short 1' },
  'armorbearer/pt/armor-bearer-short1-pt.mp4': { category: 'short', title: 'Armor Bearer Short 1' },
  'armorbearer/tl/armor-bearer-short1-tl.mp4': { category: 'short', title: 'Armor Bearer Short 1' },
  'armorbearer/id/armor-bearer-short1-id.mp4': { category: 'short', title: 'Armor Bearer Short 1' },
  'armorbearer/en/armor-bearer-short2-final.mp4': { category: 'short', title: 'Armor Bearer Short 2' },
  'armorbearer/en/armor-bearer-short2-final-logo.mp4': { category: 'short', title: 'Armor Bearer Short 2 (Logo)' },
  'armorbearer/es/armor-bearer-short2-es.mp4': { category: 'short', title: 'Armor Bearer Short 2' },
  'armorbearer/fr/armor-bearer-short2-fr.mp4': { category: 'short', title: 'Armor Bearer Short 2' },
  'armorbearer/de/armor-bearer-short2-de.mp4': { category: 'short', title: 'Armor Bearer Short 2' },
  'armorbearer/pt/armor-bearer-short2-pt.mp4': { category: 'short', title: 'Armor Bearer Short 2' },
  'armorbearer/tl/armor-bearer-short2-tl.mp4': { category: 'short', title: 'Armor Bearer Short 2' },
  'armorbearer/id/armor-bearer-short2-id.mp4': { category: 'short', title: 'Armor Bearer Short 2' },
  'armorbearer/en/armor-bearer-short3-final.mp4': { category: 'short', title: 'Armor Bearer Short 3' },
  'armorbearer/en/armor-bearer-influencer-ad-male-vo.mp4': { category: 'influencer', title: 'Stop Renting Your Influence (Male VO)' },
  'armorbearer/en/armor-bearer-influencer-ad-female-vo.mp4': { category: 'influencer', title: 'Stop Renting Your Influence (Female VO)' },
  'manna/en/manna-vs-mailerlite-v5.mp4': { category: 'promo', title: 'Manna vs MailerLite' },
  'kpkunk/en/kpunk-fullband-v17-lyrics.mp4': { category: 'promo', title: 'K-Punk Angel Warriors, Full Band Lyric Video' },
  'kpkunk/en/kpunk-fullband-performance.mp4': { category: 'promo', title: 'K-Punk Angel Warriors, Full Band Performance (Kickstarter Card)' },
  'kpkunk/en/angel-warriors-kickstarter.mp4': { category: 'promo', title: 'Angel Warriors Kickstarter Video' },
  'kpkunk/en/kpunk-short-1.mp4': { category: 'short', title: 'K-Punk Short 1' },
  'kpkunk/en/kpunk-short-2.mp4': { category: 'short', title: 'K-Punk Short 2' },
  'kpkunk/en/kpunk-short-3.mp4': { category: 'short', title: 'K-Punk Short 3' },
  'kpkunk/en/kpunk-short-4.mp4': { category: 'short', title: 'K-Punk Short 4' },
  'kpkunk/en/kpunk-short-5.mp4': { category: 'short', title: 'K-Punk Short 5' },
  'kpkunk/pt/kpunk-short-1.mp4': { category: 'short', title: 'K-Punk Short 1' },
  'kpkunk/pt/kpunk-short-2.mp4': { category: 'short', title: 'K-Punk Short 2' },
  'kpkunk/pt/kpunk-short-3.mp4': { category: 'short', title: 'K-Punk Short 3' },
  'kpkunk/pt/kpunk-short-4.mp4': { category: 'short', title: 'K-Punk Short 4' },
  'kpkunk/pt/kpunk-short-5.mp4': { category: 'short', title: 'K-Punk Short 5' },
  'kpkunk/en/kpunk-teaser-band.mp4': { category: 'short', title: 'K-Punk Teaser, Band' },
  'kpkunk/en/kpunk-teaser-bruno-solo.mp4': { category: 'short', title: 'K-Punk Teaser, Bruno Solo' },
  'kpkunk/en/kpunk-teaser-isaac.mp4': { category: 'short', title: 'K-Punk Teaser, Isaac' },
  'kpkunk/en/kpunk-teaser-janine.mp4': { category: 'short', title: 'K-Punk Teaser, Janine' },
  'kpkunk/en/kpunk-teaser-mission.mp4': { category: 'short', title: 'K-Punk Teaser, Mission' },
  'kpkunk/en/kpunk-teaser-reveal.mp4': { category: 'short', title: 'K-Punk Teaser, Reveal' },
  'kpkunk/en/kpunk-teaser-singalong.mp4': { category: 'short', title: 'K-Punk Teaser, Singalong' },
  // The three finals (2026-10-31)
  'armorbearer/en/armor-bearer-twin-final-2026-10-30.mp4': { category: 'influencer', title: 'Armor Bearer Twin Video (Final)' },
  'faithshield/en/faithshield-pastors-final-2026-10-31.mp4': { category: 'promo', title: 'FaithShield for Pastors (Final)' },
  'faithshield/en/faithshield-parents-final-2026-10-31.mp4': { category: 'promo', title: 'FaithShield for Parents (Final)' },
  // The nine posted November slide videos (2026-11-15 load)
  'armorbearer/en/armor-bearer-slide-2026-11-11.mp4': { category: 'promo', title: 'Armor Bearer Slide Video, November 11' },
  'faithshield/en/faithshield-slide-2026-11-11.mp4': { category: 'promo', title: 'FaithShield AI Slide Video, November 11' },
  'manna/en/manna-slide-2026-11-11.mp4': { category: 'promo', title: 'MannaAi Slide Video, November 11' },
  'armorbearer/en/armor-bearer-slide-join-2026-11-12.mp4': { category: 'promo', title: 'Armor Bearer Slide Video, Posted November 12' },
  'faithshield/en/faithshield-slide-join-2026-11-12.mp4': { category: 'promo', title: 'FaithShield AI Slide Video, Posted November 12' },
  'manna/en/manna-slide-join-2026-11-12.mp4': { category: 'promo', title: 'MannaAi Slide Video, Posted November 12' },
  'faithshield/en/faithshield-slide-2026-11-15-v3.mp4': { category: 'promo', title: 'FaithShield AI Slide Video, Posted November 15' },
  'armorbearer/en/armor-bearer-slide-2026-11-15.mp4': { category: 'promo', title: 'Armor Bearer Slide Video, Posted November 15' },
  'manna/en/manna-automation-slide-2026-11-15-v3.mp4': { category: 'promo', title: 'MannaAi Automation Slide Video, Posted November 15' },
};

// [product, category, language, title, file_path] — kept for callers/tests
// that enumerate the known library.
const MEDIA_ITEMS = Object.entries(CURATED).map(([rel, c]) => {
  const [product, language] = rel.split('/');
  return [product, c.category, language, c.title, rel];
});

function titleFromFilename(file) {
  const words = file.replace(/\.mp4$/i, '').replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : file;
}

function seedMediaLibrary(db, mediaDir = MEDIA_DIR) {
  const exists = db.prepare('SELECT id FROM content_items WHERE file_path = ?');
  const insert = db.prepare(`
    INSERT INTO content_items
      (tenant_id, product, category, language, title, type, file_path, file_size_bytes)
    VALUES (NULL, ?, ?, ?, ?, 'video', ?, ?)
  `);
  let inserted = 0;
  for (const product of PRODUCTS) {
    const pdir = path.join(mediaDir, product);
    if (!fs.existsSync(pdir)) continue;
    for (const lang of fs.readdirSync(pdir)) {
      const ldir = path.join(pdir, lang);
      if (!fs.statSync(ldir).isDirectory()) continue;
      for (const file of fs.readdirSync(ldir)) {
        if (!/\.mp4$/i.test(file)) continue;
        const rel = `${product}/${lang}/${file}`;
        if (exists.get(rel)) continue;
        const cur = CURATED[rel];
        const stat = fs.statSync(path.join(ldir, file));
        insert.run(
          product,
          cur ? cur.category : 'general',
          lang,
          cur ? cur.title : titleFromFilename(file),
          rel,
          stat.size
        );
        inserted++;
      }
    }
  }
  return inserted;
}

module.exports = { seedMediaLibrary, MEDIA_ITEMS, CURATED, MEDIA_DIR, titleFromFilename };
