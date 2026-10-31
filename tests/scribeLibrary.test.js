'use strict';
/**
 * Scribe watches the library (Michael, 2026-10-31): collectSignals must
 * include the tenant-visible content library films, with each film's
 * posting performance rolled up from social_postings.content_item_id,
 * including films that have never been posted (posts: 0). The numbers
 * must flow into metricMap so Scribe's citations of them verify.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

const { db, forTenant } = require('../src/db');
const scribeData = require('../src/lib/scribeData');

test('library films appear in Scribe signals with posting rollups', async () => {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Scribe Watch Co', email: 'scribe-library@example.org', password: 'scribe-secret-pw-123',
  });
  assert.equal(r.status, 201);
  const me = await c.get('/api/auth/me');
  const tenantId = me.json.tenant.id;

  // A global library film (like the shipped finals) ...
  const film = db.prepare(`
    INSERT INTO content_items (tenant_id, product, category, language, title, type, file_path, file_size_bytes, view_count)
    VALUES (NULL, 'faithshield', 'promo', 'en', 'FaithShield for Parents (Final)', 'video', 'faithshield/en/faithshield-parents-final-2026-10-31.mp4', 1000, 7)
  `).run();
  // ... and one that has never been posted.
  db.prepare(`
    INSERT INTO content_items (tenant_id, product, category, language, title, type, file_path, file_size_bytes)
    VALUES (NULL, 'armorbearer', 'influencer', 'en', 'Armor Bearer Twin Video (Final)', 'video', 'armorbearer/en/armor-bearer-twin-final-2026-10-30.mp4', 1000)
  `).run();

  // Two postings of the parents film, logged for this tenant.
  const post = db.prepare(`
    INSERT INTO social_postings (tenant_id, platform, post_url, content_item_id, likes, shares, comments, clicks)
    VALUES (?, 'instagram', ?, ?, ?, ?, ?, ?)
  `);
  post.run(tenantId, 'https://instagram.com/reel/P1', Number(film.lastInsertRowid), 30, 4, 6, 11);
  post.run(tenantId, 'https://instagram.com/reel/P2', Number(film.lastInsertRowid), 10, 1, 2, 5);

  const signals = scribeData.collectSignals(forTenant(tenantId));
  assert.equal(signals.library.films_total, 2);
  const parents = signals.library.films.find(f => f.title === 'FaithShield for Parents (Final)');
  assert.ok(parents, 'posted film must be in Scribe signals');
  assert.equal(parents.posts, 2);
  assert.equal(parents.clicks, 16);
  assert.equal(parents.likes, 40);
  assert.equal(parents.shares, 5);
  assert.equal(parents.comments, 8);
  assert.equal(parents.engagement, 16 + 40 + 5 + 8);
  assert.equal(parents.views, 7);

  const unposted = signals.library.films.find(f => f.title === 'Armor Bearer Twin Video (Final)');
  assert.ok(unposted, 'unposted film must still be watched');
  assert.equal(unposted.posts, 0);
  assert.equal(unposted.engagement, 0);

  // The trending layer names the top library film.
  const trend = signals.trending.signals.find(s => s.source === 'content_items');
  assert.ok(trend, 'trending should carry the top library film');
  assert.match(trend.signal, /FaithShield for Parents \(Final\)/);

  // Citations of library numbers must verify: metricMap carries them.
  const map = scribeData.metricMap(signals);
  assert.ok(map.has('library.films.clicks'), 'metricMap should include library paths');
  assert.ok((map.get('library.films.clicks') || []).includes(16), 'the rolled-up clicks must be citable');
});
