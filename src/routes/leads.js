'use strict';
/**
 * Lead collection API — TURNKEY lead gen inside the dashboard.
 *
 * This is the productized version of D2RM's internal collector fleet
 * (YouTube / Instagram / TikTok / podcast scrapers). v1 ships the two
 * credential-free sources so any customer can use it with zero setup:
 *
 *   youtube — keywords -> public channel search -> about pages -> emails
 *   weblist — seed URLs -> page fetch -> public contact emails
 *
 * (Instagram/podcast/TikTok need per-customer credentials or heavier
 * infra — later versions.)
 *
 * Collected leads are inserted into the tenant's influencers table
 * (status='unvetted', source='lead-collect:<source>') — i.e. directly
 * into the dashboard's email list. "Big agency data, little guy money"
 * includes the data collection itself.
 *
 * Endpoints (all auth-required, tenant-scoped):
 *   GET  /api/leads/sources
 *   POST /api/leads/jobs            { source, keywords?, seeds?, max_results?, auto_run? }
 *   GET  /api/leads/jobs
 *   GET  /api/leads/jobs/:id
 *   POST /api/leads/jobs/:id/run    (runs inline; bounded — see caps below)
 *   POST /api/leads/jobs/:id/cancel (only while queued)
 */
const express = require('express');
const youtube = require('../lib/collectors/youtube');
const weblist = require('../lib/collectors/weblist');
const aisearch = require('../lib/collectors/aisearch');

const router = express.Router();

const SOURCES = {
  youtube: {
    key: 'youtube',
    name: 'YouTube channel search',
    description: 'Enter keywords for your niche — we find public channels and pull business contact emails from their about pages and linked sites.',
    input: 'keywords',
    example: ['fitness coach', 'sourdough baking'],
  },
  weblist: {
    key: 'weblist',
    name: 'Seed URL list',
    description: 'Paste creator homepages, link-in-bio pages, or directories — we extract public contact emails from each page.',
    input: 'seeds',
    example: ['https://example-creator.com', 'https://directory.example/niche'],
  },
  aisearch: {
    key: 'aisearch',
    name: 'AI search',
    description: 'Describe your ideal customer in plain English — e.g. "AV integrators in Texas". The AI searches the live web for matching businesses and pulls public contact emails.',
    input: 'query',
    example: ['AV integrators in Texas', 'coffee roasters near Portland'],
  },
};

const MAX_ACTIVE_JOBS = 10; // per tenant; keeps the shared server polite

function publicJob(row) {
  if (!row) return null;
  let keywords = [], seeds = [];
  try { keywords = JSON.parse(row.keywords_json || '[]'); } catch (e) { /* keep [] */ }
  try { seeds = JSON.parse(row.seeds_json || '[]'); } catch (e) { /* keep [] */ }
  return {
    id: row.id,
    source: row.source,
    keywords,
    seeds,
    query: row.query_text || null,
    max_results: row.max_results,
    status: row.status,
    found_count: row.found_count,
    new_count: row.new_count,
    error: row.error,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
  };
}

// --- insert leads into the tenant's influencers table (deduped by email) ---
function ingestLeads(tdb, job, leads) {
  const known = tdb.influencerEmails();
  const source = job.source;
  let added = 0;
  for (const lead of leads) {
    for (const email of (lead.emails || [])) {
      const e = String(email).toLowerCase();
      if (known.has(e)) continue;
      known.add(e);
      const isYt = source === 'youtube';
      const isAi = source === 'aisearch';
      const notes = isYt
        ? `Collected ${(lead.keyword ? `for keyword "${lead.keyword}" ` : '')}from YouTube channel "${lead.name}"`
        : isAi
          ? `AI search "${job.query_text || ''}" → ${lead.name || lead.url}${lead.location ? ` (${lead.location})` : ''}`
          : `Collected from seed URL ${lead.url}`;
      tdb.createInfluencer({
        handle: isYt ? (lead.handle || lead.name) : (lead.name || lead.title || lead.url),
        platform: isYt ? 'youtube' : 'web',
        email: e,
        tier: null,
        category: 'influencer',
        status: 'unvetted',
        notes,
        source: `lead-collect:${source}`,
      });
      added += 1;
    }
  }
  return added;
}

async function runJob(tdb, job) {
  const started = new Date().toISOString();
  tdb.updateCollectionJob(job.id, { status: 'running', started_at: started, error: null });
  try {
    let keywords = [], seeds = [];
    try { keywords = JSON.parse(job.keywords_json || '[]'); } catch (e) { /* keep [] */ }
    try { seeds = JSON.parse(job.seeds_json || '[]'); } catch (e) { /* keep [] */ }
    const maxResults = Math.min(Math.max(job.max_results || 25, 1), 100);

    let leads;
    let parsed = null;
    if (job.source === 'youtube') {
      leads = await youtube.collect({ keywords, maxPerKeyword: 8, maxLeads: maxResults, noDelay: false });
    } else if (job.source === 'weblist') {
      const raw = await weblist.collect({ seeds });
      leads = raw.slice(0, maxResults);
    } else if (job.source === 'aisearch') {
      const res = await aisearch.collect({ query: job.query_text, maxLeads: maxResults, noDelay: false });
      leads = res.leads;
      parsed = res.parsed;
    } else {
      throw new Error(`unknown source: ${job.source}`);
    }

    const found = leads.reduce((a, l) => a + (l.emails || []).length, 0);
    const added = ingestLeads(tdb, job, leads);
    tdb.updateCollectionJob(job.id, {
      status: 'done',
      found_count: found,
      new_count: added,
      finished_at: new Date().toISOString(),
    });
    return { ok: true, found, new: added, parsed, leads: leads.slice(0, maxResults) };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[leads/run]', e);
    tdb.updateCollectionJob(job.id, {
      status: 'failed',
      error: String((e && e.message) || e).slice(0, 500),
      finished_at: new Date().toISOString(),
    });
    return { ok: false, error: 'collection_failed' };
  }
}

// ---------------------------------------------------------------------------
router.get('/sources', (req, res) => {
  res.json({ ok: true, sources: Object.values(SOURCES) });
});

// --- shared job creation (validates input, enforces the active-job cap) ---
function createJob(tdb, { source, query, keywords, seeds, maxResults }) {
  if (!SOURCES[source]) {
    return { error: { status: 400, body: { ok: false, error: 'invalid_source', valid: Object.keys(SOURCES) } } };
  }
  const rawQ = String(query || '').trim();
  if (rawQ.length > 500) {
    return { error: { status: 400, body: { ok: false, error: 'query_too_long', max: 500 } } };
  }
  const q = rawQ.slice(0, 500);
  const kw = Array.isArray(keywords) ? keywords.map(String).map(s => s.trim()).filter(Boolean).slice(0, 10) : [];
  const sd = Array.isArray(seeds) ? seeds.map(String).map(s => s.trim()).filter(Boolean).slice(0, 50) : [];
  if (source === 'youtube' && kw.length === 0) {
    return { error: { status: 400, body: { ok: false, error: 'keywords_required' } } };
  }
  if (source === 'weblist' && sd.length === 0) {
    return { error: { status: 400, body: { ok: false, error: 'seeds_required' } } };
  }
  if (source === 'aisearch' && !q) {
    return { error: { status: 400, body: { ok: false, error: 'query_required' } } };
  }
  const max = Math.min(Math.max(parseInt(maxResults, 10) || 25, 1), 100);

  const active = tdb.listCollectionJobs(100).filter(j => j.status === 'queued' || j.status === 'running').length;
  if (active >= MAX_ACTIVE_JOBS) {
    return { error: { status: 429, body: { ok: false, error: 'too_many_jobs', max_active: MAX_ACTIVE_JOBS } } };
  }

  const r = tdb.createCollectionJob({ source, keywords: kw, seeds: sd, maxResults: max, queryText: q || null });
  return { job: publicJob(tdb.getCollectionJob(Number(r.lastInsertRowid))) };
}

router.post('/jobs', async (req, res) => {
  const { source, query, keywords, seeds, max_results, auto_run } = req.body || {};
  const created = createJob(req.tdb, { source, query, keywords, seeds, maxResults: max_results });
  if (created.error) return res.status(created.error.status).json(created.error.body);

  if (auto_run) {
    const result = await runJob(req.tdb, req.tdb.getCollectionJob(created.job.id));
    return res.status(201).json({ ok: true, job: publicJob(req.tdb.getCollectionJob(created.job.id)), result });
  }
  res.status(201).json({ ok: true, job: created.job });
});

/**
 * Origami-style entry point: plain-English query straight to an inline run.
 *   POST /api/leads/ai-search  { query: "AV integrators in Texas", max_results?: 25 }
 * Creates an aisearch collection job, runs it inline, and ingests the leads
 * into the tenant's list — same as the jobs flow, one call.
 */
router.post('/ai-search', async (req, res) => {
  const { query, max_results } = req.body || {};
  const created = createJob(req.tdb, { source: 'aisearch', query, maxResults: max_results });
  if (created.error) return res.status(created.error.status).json(created.error.body);

  const result = await runJob(req.tdb, req.tdb.getCollectionJob(created.job.id));
  const status = result.ok ? 201 : 502;
  res.status(status).json({
    ok: result.ok,
    job: publicJob(req.tdb.getCollectionJob(created.job.id)),
    parsed: result.parsed || null,
    found: result.found || 0,
    new: result.new || 0,
    leads: result.leads || [],
    error: result.error,
  });
});

router.get('/jobs', (req, res) => {
  res.json({ ok: true, jobs: req.tdb.listCollectionJobs().map(publicJob) });
});

router.get('/jobs/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'invalid_job_id' });
  const job = publicJob(req.tdb.getCollectionJob(id));
  if (!job) return res.status(404).json({ ok: false, error: 'job_not_found' });
  res.json({ ok: true, job });
});

router.post('/jobs/:id/run', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'invalid_job_id' });
  const row = req.tdb.getCollectionJob(id);
  if (!row) return res.status(404).json({ ok: false, error: 'job_not_found' });
  if (row.status === 'running') {
    return res.status(409).json({ ok: false, error: 'job_already_running' });
  }
  if (row.status === 'done') {
    return res.status(409).json({ ok: false, error: 'job_already_done' });
  }
  // Re-running a failed/canceled/queued job is allowed (fresh attempt).
  const result = await runJob(req.tdb, row);
  const status = result.ok ? 200 : 502;
  res.status(status).json({ ...result, job: publicJob(req.tdb.getCollectionJob(id)) });
});

router.post('/jobs/:id/cancel', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'invalid_job_id' });
  const row = req.tdb.getCollectionJob(id);
  if (!row) return res.status(404).json({ ok: false, error: 'job_not_found' });
  if (row.status !== 'queued') {
    return res.status(409).json({ ok: false, error: 'job_not_cancelable', status: row.status });
  }
  req.tdb.updateCollectionJob(id, { status: 'canceled', finished_at: new Date().toISOString() });
  res.json({ ok: true, job: publicJob(req.tdb.getCollectionJob(id)) });
});

module.exports = router;
