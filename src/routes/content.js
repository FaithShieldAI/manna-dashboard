'use strict';
/**
 * Content library (video repository) API.
 *
 *   GET  /api/content                    list (filters: product, category, language)
 *   GET  /api/content/products           product -> language -> count tree
 *   GET  /api/content/:id                item details
 *   GET  /api/content/:id/file           stream/download the file
 *   POST /api/content/:id/view           bump view count
 *   PUT  /api/content/:id/score          set performance score { score }
 *
 * Owners/admins see all tenants; everyone else sees their own tenant's
 * items plus global (tenant_id IS NULL) items.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

const MEDIA_DIR = path.join(__dirname, '..', '..', 'media');

function scopeFilter(req) {
  const role = (req.user && req.user.role) || 'viewer';
  const all = role === 'owner' || role === 'admin';
  return {
    all,
    clause: all ? '' : 'AND (tenant_id = ? OR tenant_id IS NULL)',
    params: all ? [] : [req.tdb.tenantId],
  };
}

// Map DB tenant id for scoped queries — forTenant closes over it, so we
// run these on the raw db handle via req.tdb's escape hatch.
function rawDb(req) {
  return require('../db').db;
}

router.get('/products', (req, res) => {
  const { all, clause, params } = scopeFilter(req);
  const rows = rawDb(req).prepare(`
    SELECT product, language, category, COUNT(*) AS n
    FROM content_items
    WHERE 1=1 ${clause}
    GROUP BY product, language, category
    ORDER BY product, language, category
  `).all(...params);
  const tree = {};
  for (const r of rows) {
    tree[r.product] = tree[r.product] || {};
    tree[r.product][r.language] = tree[r.product][r.language] || {};
    tree[r.product][r.language][r.category] = r.n;
  }
  res.json({ ok: true, tree });
});

router.get('/', (req, res) => {
  const { all, clause, params } = scopeFilter(req);
  const { product, category, language, q } = req.query;
  const conds = ['1=1'];
  const args = [...params];
  if (product) { conds.push('product = ?'); args.push(String(product)); }
  if (category) { conds.push('category = ?'); args.push(String(category)); }
  if (language) { conds.push('language = ?'); args.push(String(language)); }
  if (q) { conds.push('(title LIKE ? OR description LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  const rows = rawDb(req).prepare(`
    SELECT id, product, category, language, title, description, type,
           file_size_bytes, duration_s, performance_score, view_count, created_at
    FROM content_items
    WHERE ${conds.join(' AND ')} ${clause}
    ORDER BY product, language, category, title
    LIMIT 500
  `).all(...args);
  res.json({ ok: true, items: rows });
});

router.get('/:id', (req, res) => {
  const { clause, params } = scopeFilter(req);
  const row = rawDb(req).prepare(`
    SELECT * FROM content_items WHERE id = ? ${clause}
  `).get(req.params.id, ...params);
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, item: row });
});

router.get('/:id/file', (req, res) => {
  const { clause, params } = scopeFilter(req);
  const row = rawDb(req).prepare(`
    SELECT file_path, title, type FROM content_items WHERE id = ? ${clause}
  `).get(req.params.id, ...params);
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  const abs = path.resolve(MEDIA_DIR, row.file_path);
  if (!abs.startsWith(MEDIA_DIR + path.sep)) {
    return res.status(400).json({ ok: false, error: 'bad_path' });
  }
  if (!fs.existsSync(abs)) {
    return res.status(404).json({ ok: false, error: 'file_missing' });
  }
  // Bump view count (fire-and-forget).
  try {
    rawDb(req).prepare('UPDATE content_items SET view_count = view_count + 1 WHERE id = ?')
      .run(req.params.id);
  } catch (e) { /* never break serving */ }
  res.sendFile(abs);
});

router.post('/:id/view', (req, res) => {
  const { clause, params } = scopeFilter(req);
  const r = rawDb(req).prepare(`
    UPDATE content_items SET view_count = view_count + 1 WHERE id = ? ${clause}
  `).run(req.params.id, ...params);
  res.json({ ok: true, updated: r.changes > 0 });
});

router.put('/:id/score', (req, res) => {
  const role = (req.user && req.user.role) || 'viewer';
  if (role !== 'owner' && role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const score = parseFloat(req.body && req.body.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    return res.status(400).json({ ok: false, error: 'bad_score' });
  }
  const { clause, params } = scopeFilter(req);
  const r = rawDb(req).prepare(`
    UPDATE content_items
    SET performance_score = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? ${clause}
  `).run(score, req.params.id, ...params);
  res.json({ ok: true, updated: r.changes > 0 });
});

module.exports = router;
