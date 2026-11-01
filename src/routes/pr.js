'use strict';
/**
 * PR API — press connections, releases, pitches.
 *
 *   GET    /api/pr/summary
 *   GET    /api/pr/targets?tier=&status=&q=
 *   POST   /api/pr/targets            {publication, contact_name?, role?,
 *                                      beat?, contact_route?, route_verified?,
 *                                      tier?, fit_note?, source?, status?}
 *   PUT    /api/pr/targets/:id        (any target field)
 *   DELETE /api/pr/targets/:id
 *   POST   /api/pr/targets/import     (seed the connections list from
 *                                      ~/workspace/press/targets-2026-11-01.md
 *                                      into the caller's tenant; idempotent)
 *   GET    /api/pr/releases?status=
 *   POST   /api/pr/releases           {title, subject_line?, body?, status?}
 *   PUT    /api/pr/releases/:id
 *   DELETE /api/pr/releases/:id
 *   GET    /api/pr/pitches?status=&target_id=
 *   POST   /api/pr/pitches            {target_id, release_id?, status?,
 *                                      follow_up_due?, notes?}
 *   PATCH  /api/pr/pitches/:id        {status?, release_id?, follow_up_due?,
 *                                      notes?, sent_at?, reply_at?}
 *   DELETE /api/pr/pitches/:id
 *
 * ACCESS: admin/whitelisted only (src/lib/pr.js requirePrAdmin). This
 * is the private D2RM dashboard's PR section (Michael, 2026-11-01:
 * "not for Manna yet"); tenant accounts get 403 on every route. Data
 * is tenant-scoped via req.tdb like every other route family, so the
 * section can migrate into Manna later by lifting the gate.
 *
 * Pitch status flow: drafted -> approved -> sent -> replied ->
 * covered / declined / no_response. Moving a pitch INTO 'sent'
 * stamps sent_at, and into 'replied' or 'covered' stamps reply_at,
 * unless the caller supplies the timestamp explicitly. Terminal
 * states are not locked: the operator can correct a mis-click.
 *
 * Mounted by the coordinator (server.js) — do NOT self-mount here.
 */
const express = require('express');
const {
  PR_TIERS, TARGET_STATUSES, RELEASE_STATUSES, PITCH_STATUSES, requirePrAdmin,
} = require('../lib/pr');
const { seedPrTargets, defaultTargetsPath } = require('../lib/prTargetsSeed');

const router = express.Router();
router.use(requirePrAdmin);

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const badEnum = (res, field, valid) =>
  res.status(400).json({ ok: false, error: `invalid_${field}`, valid });

function cleanTarget(body, { partial = false } = {}) {
  const b = body || {};
  const f = {};
  if (!partial || b.publication !== undefined) {
    f.publication = str(b.publication, 200);
    if (!f.publication) return { error: 'publication_required' };
  }
  for (const k of ['contact_name', 'role', 'beat', 'source']) {
    if (!partial || b[k] !== undefined) f[k] = str(b[k], 300);
  }
  if (!partial || b.contact_route !== undefined) f.contact_route = str(b.contact_route, 500);
  if (!partial || b.fit_note !== undefined) f.fit_note = str(b.fit_note, 1000);
  if (b.route_verified !== undefined) f.route_verified = !!b.route_verified;
  else if (!partial) f.route_verified = false;
  if (b.tier !== undefined) {
    if (!PR_TIERS.includes(b.tier)) return { error: 'invalid_tier', valid: PR_TIERS };
    f.tier = b.tier;
  } else if (!partial) f.tier = 'niche';
  if (b.status !== undefined) {
    if (!TARGET_STATUSES.includes(b.status)) return { error: 'invalid_status', valid: TARGET_STATUSES };
    f.status = b.status;
  } else if (!partial) f.status = 'active';
  return { fields: f };
}

function cleanRelease(body, { partial = false } = {}) {
  const b = body || {};
  const f = {};
  if (!partial || b.title !== undefined) {
    f.title = str(b.title, 300);
    if (!f.title) return { error: 'title_required' };
  }
  if (!partial || b.subject_line !== undefined) f.subject_line = str(b.subject_line, 300);
  if (!partial || b.body !== undefined) f.body = typeof b.body === 'string' ? b.body.slice(0, 60000) : null;
  if (b.status !== undefined) {
    if (!RELEASE_STATUSES.includes(b.status)) return { error: 'invalid_status', valid: RELEASE_STATUSES };
    f.status = b.status;
  } else if (!partial) f.status = 'draft';
  return { fields: f };
}

// --- Summary -------------------------------------------------------------

router.get('/summary', (req, res) => {
  res.json({ ok: true, summary: req.tdb.prSummary() });
});

// --- Targets -------------------------------------------------------------

router.get('/targets', (req, res) => {
  const { tier, status, q } = req.query;
  if (tier && !PR_TIERS.includes(tier)) return badEnum(res, 'tier', PR_TIERS);
  if (status && !TARGET_STATUSES.includes(status)) return badEnum(res, 'status', TARGET_STATUSES);
  const targets = req.tdb.listPrTargets({
    tier: tier || undefined,
    status: status || undefined,
    q: typeof q === 'string' && q.trim() ? q.trim().slice(0, 100) : undefined,
  });
  res.json({ ok: true, targets });
});

router.post('/targets', (req, res) => {
  const { fields, error, valid } = cleanTarget(req.body);
  if (error) return res.status(400).json({ ok: false, error, valid });
  try {
    const id = req.tdb.insertPrTarget(fields);
    res.status(201).json({ ok: true, target: req.tdb.getPrTarget(id) });
  } catch (e) {
    if (/UNIQUE constraint/.test(e.message)) {
      return res.status(409).json({ ok: false, error: 'target_exists' });
    }
    throw e;
  }
});

router.put('/targets/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!req.tdb.getPrTarget(id)) return res.status(404).json({ ok: false, error: 'not_found' });
  const { fields, error, valid } = cleanTarget(req.body, { partial: true });
  if (error) return res.status(400).json({ ok: false, error, valid });
  try {
    req.tdb.updatePrTarget(id, fields);
  } catch (e) {
    if (/UNIQUE constraint/.test(e.message)) {
      return res.status(409).json({ ok: false, error: 'target_exists' });
    }
    throw e;
  }
  res.json({ ok: true, target: req.tdb.getPrTarget(id) });
});

router.delete('/targets/:id', (req, res) => {
  const ok = req.tdb.deletePrTarget(Number(req.params.id));
  if (!ok) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true });
});

router.post('/targets/import', (req, res) => {
  const { db } = require('../db');
  const result = seedPrTargets(db, { tenantId: req.tenant.id });
  res.json({ ok: true, import: result, file: defaultTargetsPath() });
});

// --- Releases ------------------------------------------------------------

router.get('/releases', (req, res) => {
  const { status } = req.query;
  if (status && !RELEASE_STATUSES.includes(status)) return badEnum(res, 'status', RELEASE_STATUSES);
  res.json({ ok: true, releases: req.tdb.listPrReleases({ status: status || undefined }) });
});

router.post('/releases', (req, res) => {
  const { fields, error, valid } = cleanRelease(req.body);
  if (error) return res.status(400).json({ ok: false, error, valid });
  const id = req.tdb.insertPrRelease(fields);
  res.status(201).json({ ok: true, release: req.tdb.getPrRelease(id) });
});

router.put('/releases/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!req.tdb.getPrRelease(id)) return res.status(404).json({ ok: false, error: 'not_found' });
  const { fields, error, valid } = cleanRelease(req.body, { partial: true });
  if (error) return res.status(400).json({ ok: false, error, valid });
  req.tdb.updatePrRelease(id, fields);
  res.json({ ok: true, release: req.tdb.getPrRelease(id) });
});

router.delete('/releases/:id', (req, res) => {
  const ok = req.tdb.deletePrRelease(Number(req.params.id));
  if (!ok) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true });
});

// --- Pitches -------------------------------------------------------------

router.get('/pitches', (req, res) => {
  const { status, target_id } = req.query;
  if (status && !PITCH_STATUSES.includes(status)) return badEnum(res, 'status', PITCH_STATUSES);
  res.json({
    ok: true,
    pitches: req.tdb.listPrPitches({
      status: status || undefined,
      targetId: target_id ? Number(target_id) : undefined,
    }),
  });
});

router.post('/pitches', (req, res) => {
  const b = req.body || {};
  const targetId = Number(b.target_id);
  if (!targetId || !req.tdb.getPrTarget(targetId)) {
    return res.status(400).json({ ok: false, error: 'invalid_target' });
  }
  let releaseId = null;
  if (b.release_id !== undefined && b.release_id !== null) {
    releaseId = Number(b.release_id);
    if (!releaseId || !req.tdb.getPrRelease(releaseId)) {
      return res.status(400).json({ ok: false, error: 'invalid_release' });
    }
  }
  const status = b.status || 'drafted';
  if (!PITCH_STATUSES.includes(status)) return badEnum(res, 'status', PITCH_STATUSES);
  const now = new Date().toISOString();
  const id = req.tdb.insertPrPitch({
    target_id: targetId,
    release_id: releaseId,
    status,
    sent_at: status === 'sent' || status === 'replied' || status === 'covered' ? (str(b.sent_at, 40) || now) : str(b.sent_at, 40),
    reply_at: status === 'replied' || status === 'covered' ? (str(b.reply_at, 40) || now) : str(b.reply_at, 40),
    follow_up_due: str(b.follow_up_due, 40),
    notes: str(b.notes, 2000),
  });
  res.status(201).json({ ok: true, pitch: req.tdb.getPrPitch(id) });
});

router.patch('/pitches/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = req.tdb.getPrPitch(id);
  if (!existing) return res.status(404).json({ ok: false, error: 'not_found' });
  const b = req.body || {};
  const f = {};
  if (b.status !== undefined) {
    if (!PITCH_STATUSES.includes(b.status)) return badEnum(res, 'status', PITCH_STATUSES);
    f.status = b.status;
    const now = new Date().toISOString();
    // Stamp the moment on the transition that earns it, unless the
    // caller pinned the timestamp in the same request.
    if (b.status === 'sent' && !existing.sent_at && b.sent_at === undefined) f.sent_at = now;
    if ((b.status === 'replied' || b.status === 'covered') && !existing.reply_at && b.reply_at === undefined) f.reply_at = now;
    if (b.status === 'covered' && !existing.sent_at && b.sent_at === undefined) f.sent_at = f.sent_at || now;
  }
  if (b.sent_at !== undefined) f.sent_at = str(b.sent_at, 40);
  if (b.reply_at !== undefined) f.reply_at = str(b.reply_at, 40);
  if (b.follow_up_due !== undefined) f.follow_up_due = str(b.follow_up_due, 40);
  if (b.notes !== undefined) f.notes = str(b.notes, 2000);
  if (b.release_id !== undefined) {
    if (b.release_id === null) f.release_id = null;
    else {
      const releaseId = Number(b.release_id);
      if (!releaseId || !req.tdb.getPrRelease(releaseId)) {
        return res.status(400).json({ ok: false, error: 'invalid_release' });
      }
      f.release_id = releaseId;
    }
  }
  req.tdb.updatePrPitch(id, f);
  res.json({ ok: true, pitch: req.tdb.getPrPitch(id) });
});

router.delete('/pitches/:id', (req, res) => {
  const ok = req.tdb.deletePrPitch(Number(req.params.id));
  if (!ok) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true });
});

module.exports = router;
