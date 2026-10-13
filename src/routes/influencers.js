'use strict';
/**
 * Influencers API (creators + podcast hosts as category='podcast').
 * GET /api/influencers[?category=][?status=]
 * GET /api/influencers/counts
 */
const express = require('express');

const router = express.Router();
const CATEGORIES = ['influencer', 'podcast', 'pastor', 'church', 'attorney'];
const STATUSES = ['unvetted', 'vetted', 'contacted', 'active', 'rejected'];

router.get('/counts', (req, res) => {
  res.json({ ok: true, counts: req.tdb.influencerCategoryCounts() });
});

router.get('/', (req, res) => {
  const { category, status } = req.query;
  if (category && !CATEGORIES.includes(category)) {
    return res.status(400).json({ ok: false, error: 'invalid_category' });
  }
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ ok: false, error: 'invalid_status' });
  }
  res.json({ ok: true, influencers: req.tdb.influencers({ category, status }) });
});

module.exports = router;
