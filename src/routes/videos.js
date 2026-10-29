'use strict';
/**
 * Video generation API — Manna's AI video maker (HeyGen, standard engine).
 *
 *   GET  /api/videos/catalogue
 *        -> { ok, configured, avatars, voices, entitlement }
 *   GET  /api/videos/jobs
 *        -> { ok, jobs, entitlement }  (processing jobs are refreshed
 *           from the provider on read — same poll-on-read shape the
 *           leads jobs use with their status endpoint)
 *   GET  /api/videos/jobs/:id
 *        -> { ok, job, entitlement }   (404 for missing OR foreign jobs:
 *           a tenant can never distinguish the two)
 *   POST /api/videos/jobs  { script, avatar?, voice? }
 *        -> 201 { ok, job, entitlement }
 *        -> 503 heygen_not_configured  (no HEYGEN_API_KEY — fail closed,
 *           mirrors google_not_configured in socialConnect)
 *        -> 403 purchase-prompt contract at the cap / without the feature
 *
 * Entitlement (server-side, at job creation — Michael, 2026-10-25):
 *   trial tenants (subscription_status !== 'active', ANY plan):
 *     5 videos TOTAL across the trial, standard engine only.
 *   paid heavy10 / heavy30: 10 / 30 videos per calendar month
 *     (src/lib/plans.js videos_per_month).
 *   paid starter: no video feature at all.
 *   paid pro / influencer / agency: plans.js grants the video FEATURE
 *     with NO videos_per_month number — enforced as feature-yes with no
 *     numeric cap, exactly as plans.js says (flagged in the wiring
 *     report; no cap invented here).
 *
 * Script cap: 1,000 characters. At typical TTS pace (~800 chars/min of
 * speech) that is ~75 seconds of video ≈ ~$1.25 at the standard
 * engine's ~$1/min — a hard cost ceiling per generation, and a trial
 * promo script is naturally far shorter.
 *
 * Tenant isolation: every read/write goes through req.tdb; provider
 * polling uses ONLY the provider_job_id stored server-side on the
 * tenant's own row — client-supplied tenant ids are never trusted
 * (there is no tenant id in any request shape here at all).
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { getPlan, hasFeature, currentMonthKey } = require('../lib/plans');
const videogen = require('../lib/videogen');

const router = express.Router();

const TRIAL_VIDEO_LIMIT = 5; // Michael, 2026-10-25: 5 across the whole trial
const MAX_SCRIPT_CHARS = 1000;

// Generation costs real money per call; bound request rate per tenant
// (anti-abuse/cost control in the Scribe limiter's shape). This is NOT
// a plan cap — plan caps are the entitlement numbers below.
const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => (req.tenant && req.tenant.id
    ? `tenant:${req.tenant.id}`
    : ipKeyGenerator(req)),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'too_many_requests' },
});

function publicJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    script: row.script,
    avatar: row.avatar_key,
    voice: row.voice_key,
    status: row.status,
    video_url: row.video_url || null,
    duration_s: row.duration_s != null ? row.duration_s : null,
    error: row.error || null,
    created_at: row.created_at,
    finished_at: row.finished_at || null,
  };
}

function monthStartIso() {
  return `${currentMonthKey()}-01T00:00:00.000Z`;
}

/** The tenant's current video entitlement + usage, from plans.js + counts. */
function videoEntitlement(req) {
  const plan = getPlan(req.tenant.plan) || getPlan('starter');
  const isTrial = req.tenant.subscription_status !== 'active';
  if (isTrial) {
    const used = req.tdb.countVideoJobs(null); // all-time: the cap is per-trial
    return {
      trial: true, plan: plan.key, feature: true, period: 'trial',
      limit: TRIAL_VIDEO_LIMIT, used,
      remaining: Math.max(0, TRIAL_VIDEO_LIMIT - used),
    };
  }
  if (!hasFeature(plan.key, 'video')) {
    return {
      trial: false, plan: plan.key, feature: false, period: 'month',
      limit: 0, used: req.tdb.countVideoJobs(monthStartIso()), remaining: 0,
    };
  }
  const limit = plan.videos_per_month != null ? plan.videos_per_month : null;
  const used = req.tdb.countVideoJobs(monthStartIso());
  return {
    trial: false, plan: plan.key, feature: true, period: 'month',
    limit, used, remaining: limit == null ? null : Math.max(0, limit - used),
  };
}

/** Poll-on-read refresh for one processing job (leads-jobs convention). */
async function refreshJob(req, row) {
  if (!row || row.status !== 'processing' || !row.provider_job_id) return row;
  // The dashboard polls the list; don't hammer the provider inside 2s.
  const updatedMs = Date.parse(row.updated_at || '');
  if (Number.isFinite(updatedMs) && Date.now() - updatedMs < 2000) return row;
  try {
    const s = await videogen.getVideoStatus(row.provider_job_id);
    if (s.status === 'completed') {
      req.tdb.updateVideoJob(row.id, {
        status: 'completed',
        video_url: s.videoUrl || null,
        duration_s: s.durationS != null ? s.durationS : null,
        error: null,
        finished_at: new Date().toISOString(),
      });
    } else if (s.status === 'failed') {
      req.tdb.updateVideoJob(row.id, {
        status: 'failed',
        error: String(s.error || 'provider_failed').slice(0, 500),
        finished_at: new Date().toISOString(),
      });
    }
  } catch (e) {
    // A polling failure is not a job failure: leave the row processing
    // and let the next read try again.
    // eslint-disable-next-line no-console
    console.error('[videos/refresh]', e && e.message ? e.message : e);
  }
  return req.tdb.getVideoJob(row.id);
}

async function refreshAll(req, rows) {
  const out = [];
  for (const row of rows) out.push(await refreshJob(req, row));
  return out;
}

// ---------------------------------------------------------------------------
router.get('/catalogue', (req, res) => {
  const cat = videogen.getCatalogue();
  res.json({
    ok: true,
    configured: videogen.isConfigured(),
    avatars: cat.avatars,
    voices: cat.voices,
    entitlement: videoEntitlement(req),
  });
});

router.get('/jobs', async (req, res) => {
  try {
    const rows = await refreshAll(req, req.tdb.listVideoJobs());
    res.json({ ok: true, jobs: rows.map(publicJob), entitlement: videoEntitlement(req) });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[videos/list]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.get('/jobs/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'invalid_job_id' });
  try {
    const row = await refreshJob(req, req.tdb.getVideoJob(id));
    if (!row) return res.status(404).json({ ok: false, error: 'job_not_found' });
    res.json({ ok: true, job: publicJob(row), entitlement: videoEntitlement(req) });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[videos/get]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.post('/jobs', createLimiter, async (req, res) => {
  // Fail closed when the provider is not configured — never fake a video.
  if (!videogen.isConfigured()) {
    return res.status(503).json({ ok: false, error: 'heygen_not_configured' });
  }
  const body = req.body || {};
  const script = typeof body.script === 'string' ? body.script.trim() : '';
  if (!script) {
    return res.status(400).json({ ok: false, error: 'invalid_script' });
  }
  if (script.length > MAX_SCRIPT_CHARS) {
    return res.status(400).json({ ok: false, error: 'script_too_long', max: MAX_SCRIPT_CHARS });
  }
  const cat = videogen.getCatalogue();
  const avatarKey = typeof body.avatar === 'string' && body.avatar ? body.avatar : cat.avatars[0].key;
  const voiceKey = typeof body.voice === 'string' && body.voice ? body.voice : cat.voices[0].key;
  if (!videogen.isValidAvatarKey(avatarKey)) {
    return res.status(400).json({ ok: false, error: 'invalid_avatar', valid: cat.avatars.map(a => a.key) });
  }
  if (!videogen.isValidVoiceKey(voiceKey)) {
    return res.status(400).json({ ok: false, error: 'invalid_voice', valid: cat.voices.map(v => v.key) });
  }

  // Entitlement + caps, enforced BEFORE any provider call or job row
  // consumes allowance. Rejections carry the purchase-prompt contract
  // (Michael, 2026-10-25): upgrade_required + limit_name 'videos' and
  // the numbers the prompt renders — enforcement itself is unchanged.
  const ent = videoEntitlement(req);
  if (!ent.feature) {
    return res.status(403).json({
      ok: false,
      error: 'video_not_available',
      upgrade_required: true,
      limit_name: 'videos',
      trial: false,
      plan: ent.plan,
      limit: 0,
      used: ent.used,
      remaining: 0,
      note: 'Video generation is a Pro-and-up feature.',
    });
  }
  if (ent.limit != null && ent.used >= ent.limit) {
    return res.status(403).json({
      ok: false,
      error: ent.trial ? 'trial_video_limit_reached' : 'video_limit_reached',
      upgrade_required: true,
      limit_name: 'videos',
      trial: ent.trial,
      plan: ent.plan,
      limit: ent.limit,
      used: ent.used,
      remaining: 0,
      note: ent.trial
        ? 'Your free trial includes 5 videos. Choose a paid plan to keep creating.'
        : 'Upgrade your plan to create more videos this month.',
    });
  }

  const created = req.tdb.createVideoJob({
    script,
    avatarKey,
    voiceKey,
    engine: videogen.ENGINE_STANDARD,
    provider: videogen.providerName(),
  });
  const jobId = Number(created.lastInsertRowid);
  try {
    const { providerJobId } = await videogen.createVideo({ script, avatarKey, voiceKey });
    req.tdb.updateVideoJob(jobId, { provider_job_id: providerJobId, status: 'processing' });
  } catch (e) {
    // Provider refused/failed: the row is marked failed (never counts
    // against the allowance) and the caller gets an honest 502.
    req.tdb.updateVideoJob(jobId, {
      status: 'failed',
      error: String((e && e.message) || e).slice(0, 500),
      finished_at: new Date().toISOString(),
    });
    // eslint-disable-next-line no-console
    console.error('[videos/create]', e && e.message ? e.message : e);
    return res.status(502).json({ ok: false, error: 'video_provider_error', job_id: jobId });
  }
  const row = req.tdb.getVideoJob(jobId);
  res.status(201).json({ ok: true, job: publicJob(row), entitlement: videoEntitlement(req) });
});

module.exports = router;
