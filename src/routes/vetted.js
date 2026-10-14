'use strict';
/**
 * Vetted tab API — lead vetting counts and approve/reject actions.
 * GET  /api/vetted/stats              { vetted: {cat:n}, unvetted: {cat:n}, rejected: {cat:n}, totals }
 * GET  /api/vetted/pending[?category=][?limit=]
 * POST /api/vetted/:id/approve        -> status='vetted'
 * POST /api/vetted/:id/reject         -> status='rejected'
 * All queries are tenant-scoped via req.tdb.
 */
const express = require('express');

const router = express.Router();
const CATEGORIES = ['influencer', 'podcast', 'pastor', 'church', 'attorney'];
const VETTED_STATUSES = ['vetted'];
const UNVETTED_STATUSES = ['unvetted'];
const REJECTED_STATUSES = ['rejected'];

router.get('/stats', (req, res) => {
  const rows = req.tdb.influencerVettedCounts();
  const vetted = {}, unvetted = {}, rejected = {};
  let tV = 0, tU = 0, tR = 0;
  for (const r of rows) {
    if (VETTED_STATUSES.includes(r.status)) {
      vetted[r.category] = (vetted[r.category] || 0) + r.n; tV += r.n;
    } else if (UNVETTED_STATUSES.includes(r.status)) {
      unvetted[r.category] = (unvetted[r.category] || 0) + r.n; tU += r.n;
    } else if (REJECTED_STATUSES.includes(r.status)) {
      rejected[r.category] = (rejected[r.category] || 0) + r.n; tR += r.n;
    }
  }
  res.json({ ok: true, vetted, unvetted, rejected, totals: { vetted: tV, unvetted: tU, rejected: tR }, categories: CATEGORIES });
});

router.get('/pending', (req, res) => {
  const { category } = req.query;
  if (category && !CATEGORIES.includes(category)) {
    return res.status(400).json({ ok: false, error: 'invalid_category' });
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  res.json({ ok: true, leads: req.tdb.pendingVetted({ category, limit }) });
});

router.post('/:id/approve', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const changed = req.tdb.setInfluencerStatus(id, 'vetted');
  if (!changed) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, id, status: 'vetted' });
});

router.post('/:id/reject', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const changed = req.tdb.setInfluencerStatus(id, 'rejected');
  if (!changed) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, id, status: 'rejected' });
});

module.exports = router;
