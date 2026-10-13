'use strict';
/**
 * IP Registry API.
 * GET /api/ip-registry[?type=][?status=]
 */
const express = require('express');

const router = express.Router();
const TYPES = ['copyright', 'trademark', 'patent', 'trade_secret', 'domain', 'other'];
const STATUSES = ['idea', 'created-unregistered', 'filed-pending', 'registered', 'licensed'];

router.get('/', (req, res) => {
  const { type, status } = req.query;
  if (type && !TYPES.includes(type)) {
    return res.status(400).json({ ok: false, error: 'invalid_type' });
  }
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ ok: false, error: 'invalid_status' });
  }
  res.json({ ok: true, assets: req.tdb.ipAssets({ assetType: type, status }) });
});

module.exports = router;
