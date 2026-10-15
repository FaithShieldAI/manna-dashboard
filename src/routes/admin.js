'use strict';
/**
 * Admin endpoints.
 *
 *   POST /api/admin/sync-d2rm — one-shot import of the real D2RM dataset
 *   (contacts, campaigns, snapshots, goals) into the caller's tenant.
 *
 * SECURITY — HARD ALLOWLIST:
 *   Only michael@faithshield.ai and leon@faithshield.ai may call this.
 *   Any other logged-in user gets 403. Michael's real business data must
 *   NEVER be synced into another user's (e.g. Ken's) tenant.
 *
 *   The sync itself is tenant-scoped (writes only to req.tenant.id) and
 *   idempotent (upserts by email / name / window_key / goal_key).
 *
 *   This router is mounted under the /api router in server.js, which
 *   already applies requireAuth (session cookie), csrfCheck
 *   (X-Requested-With header) and apiLimiter.
 */
const express = require('express');
const fs = require('fs');
const { syncD2rmData, BUNDLED_SOURCE_DB } = require('../lib/syncD2rm');

const router = express.Router();

// HARD-CODED. Do not make this configurable without Michael's approval.
const SYNC_ALLOWLIST = new Set([
  'michael@faithshield.ai',
  'leon@faithshield.ai',
]);

router.post('/sync-d2rm', (req, res) => {
  const email = ((req.user && req.user.email) || '').toLowerCase().trim();
  if (!SYNC_ALLOWLIST.has(email)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  const sourceDbPath = process.env.D2RM_SOURCE_DB || BUNDLED_SOURCE_DB;
  if (!fs.existsSync(sourceDbPath)) {
    return res.status(500).json({ ok: false, error: 'source_db_missing', path: sourceDbPath, cwd: process.cwd() });
  }

  try {
    const synced = syncD2rmData({ sourceDbPath, tenantId: req.tenant.id });
    res.json({
      ok: true,
      email,
      tenant: req.tenant.slug,
      synced: {
        contacts: synced.contacts,
        campaigns: synced.campaigns,
        snapshots: synced.snapshots,
        goalsUpserted: synced.goalsUpserted,
        liveContactCount: synced.liveContactCount,
        influencersBefore: synced.influencersBefore,
        influencersAfter: synced.influencersAfter,
      },
    });
  } catch (e) {
    console.error('[admin/sync-d2rm]', e);
    res.status(500).json({ ok: false, error: 'sync_failed' });
  }
});

module.exports = router;
