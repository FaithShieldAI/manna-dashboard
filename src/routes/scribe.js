'use strict';
/**
 * Scribe API — Manna's AI analyst (Muse Spark via the Meta Model API).
 *
 *   GET  /api/scribe/status
 *        -> { ok, provider: 'spark'|'stub', transport, configured,
 *             model, note }
 *   POST /api/scribe/analyze
 *        -> { ok: true, mode: 'live'|'stub', transport, analysis_id,
 *             stub, notice?, advice, signals }
 *        -> { ok: false, error } on live-mode failure (FAIL-CLOSED: no
 *           fabricated advice is ever returned in place of an error)
 *        The validated advice is stored SERVER-SIDE; analysis_id is an
 *        opaque, tenant-bound, short-lived handle to it.
 *   POST /api/scribe/drafts  { analysis_id }
 *        -> creates DRAFT artifacts from the stored analysis. A
 *           client-supplied advice object is NEVER accepted (F1: that
 *           was a provenance-forgery hole — hand-written "advice" was
 *           stamped as live Scribe output). Source stamps derive from
 *           the analysis record's transport. Idempotent: re-creating
 *           from the same analysis returns the existing drafts (200).
 *           Drafts only: nothing sends, nothing posts; a human approves.
 *   GET  /api/scribe/drafts?status=draft
 *        -> { ok, drafts: [...] }
 *   POST /api/scribe/drafts/:id/status  { status: 'approved'|'dismissed' }
 *        -> human decision on a draft. draft -> approved|dismissed are
 *           the only legal transitions and both are terminal (F5); the
 *           decision is audited (decided_by / decided_at).
 *
 * Tenant-scoped by construction: every handler works through req.tdb.
 * With no SPARK_API_KEY the analyze endpoint runs in stub mode and says
 * so in the response (mode: 'stub', stub: true, transport: 'stub').
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const scribe = require('../lib/scribe');

const router = express.Router();

const analyzeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,                  // live Spark calls cost money; stub is cheap but bounded too
  // F3: key by TENANT, not IP — tenants behind one NAT (or one office)
  // must not starve each other. IP is only a pre-auth fallback.
  keyGenerator: (req) => (req.tenant && req.tenant.id
    ? `tenant:${req.tenant.id}`
    : ipKeyGenerator(req)),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'too_many_requests' },
});

router.get('/status', (req, res) => {
  res.json(scribe.status());
});

router.post('/analyze', analyzeLimiter, async (req, res) => {
  try {
    const result = await scribe.analyze(req.tdb);
    if (!result.ok) {
      return res.status(502).json({ ok: false, error: result.error.code, detail: result.error.message });
    }
    res.json({
      ok: true,
      mode: result.mode,
      transport: result.transport,
      analysis_id: result.analysisId,
      stub: result.stub,
      notice: result.notice || undefined,
      advice: result.advice,
      signals: result.signals,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[scribe/analyze]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.post('/drafts', (req, res) => {
  try {
    const { analysis_id } = req.body || {};
    if (typeof analysis_id !== 'string' || !analysis_id.trim()) {
      return res.status(400).json({ ok: false, error: 'analysis_id_required' });
    }
    const result = scribe.createDrafts(req.tdb, analysis_id.trim());
    res.status(result.idempotent ? 200 : 201)
      .json({ ok: true, created: result.created, idempotent: result.idempotent });
  } catch (e) {
    if (e && e.code === 'scribe_analysis_not_found') {
      return res.status(404).json({ ok: false, error: 'analysis_not_found' });
    }
    if (e && e.code === 'scribe_draft_cap') {
      return res.status(429).json({ ok: false, error: 'draft_cap_reached', detail: e.message });
    }
    if (e && e.code === 'scribe_invalid_advice') {
      return res.status(400).json({ ok: false, error: 'invalid_advice', detail: e.message });
    }
    // eslint-disable-next-line no-console
    console.error('[scribe/drafts]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.get('/drafts', (req, res) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const drafts = req.tdb.listScribeDrafts({ status, limit: 100 });
    res.json({ ok: true, drafts });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[scribe/drafts list]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.post('/drafts/:id/status', (req, res) => {
  try {
    // F7: strict id — parseInt alone would accept '18x' as draft 18.
    if (!/^\d+$/.test(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'invalid_id' });
    }
    const id = parseInt(req.params.id, 10);
    const { status } = req.body || {};
    if (!['approved', 'dismissed'].includes(status)) {
      return res.status(400).json({ ok: false, error: 'invalid_status' });
    }
    const draft = req.tdb.getScribeDraft(id);
    if (!draft) return res.status(404).json({ ok: false, error: 'draft_not_found' });
    const changed = req.tdb.setScribeDraftStatus(id, status, req.user && req.user.id);
    if (!changed) {
      // Exists but already decided — approved/dismissed are terminal (F5).
      return res.status(409).json({ ok: false, error: 'draft_already_decided', status: draft.status });
    }
    res.json({ ok: true, id, status });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[scribe/drafts status]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
