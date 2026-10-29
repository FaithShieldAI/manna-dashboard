'use strict';
/**
 * Scribe — Manna's AI co-pilot (performance analyst).
 *
 * "Dashboard sees, Manna does, Scribe thinks." Scribe reads the tenant's
 * performance data (src/lib/scribeData.js), reasons over it with Meta's
 * Muse Spark (src/lib/sparkClient.js), and returns STRUCTURED advice:
 * observations that cite the numbers they rest on, plus recommendations
 * that the act-layer (below) can turn into DRAFT artifacts inside Manna.
 *
 * Modes:
 *   - LIVE: SPARK_API_KEY set -> Spark is called. FAIL-CLOSED: an API
 *     error, unparseable output, or output that fails schema validation
 *     returns an error state ({ ok: false, error }). Scribe NEVER
 *     fabricates recommendations to fill a gap.
 *   - STUB: no key -> no network call. Returns clearly-marked SAMPLE
 *     advice (every recommendation carries sample: true, and the result
 *     carries stub: true + a notice) built from the tenant's real
 *     numbers, so the whole pipeline — panel, routes, act-layer,
 *     drafts table — is testable before the key arrives.
 *
 * The act-layer creates DB rows with status 'draft' ONLY. Nothing in
 * this module sends email, posts to social, or publishes anything; a
 * human approves drafts later, per Michael's standing rule.
 *
 * Provenance + storage (F1): analyze() persists its VALIDATED advice
 * server-side (scribe_analyses) and returns an opaque, tenant-bound,
 * short-lived analysis id. Drafts are created ONLY from a stored
 * analysis — never from a client-supplied advice object — and each
 * draft's source stamp is derived from the transport recorded on the
 * analysis (see the transport section below), ignoring any flags a
 * client might send. Before storage, every cited number is verified
 * against the tenant's own signals (verifyCitations): advice that
 * invents numbers is rejected whole, in both live and stub modes.
 */

const crypto = require('crypto');
const sparkClient = require('./sparkClient');
const scribeData = require('./scribeData');
const config = require('../config');

const REC_TYPES = ['video_brief', 'social_post', 'email_campaign'];

// ---------------------------------------------------------------------------
// Transports and provenance stamps.
// Every advice-producing client declares a transport:
//   'spark-api'   the production Meta Model API client (sparkClient.js)
//   'stub'        the built-in no-key sample generator (stubAdvice below)
//   'substituted' anything else — an injected test client or a substituted
//                 model. FAIL-SAFE: an undeclared transport resolves to
//                 'substituted', NEVER to the live API, so pre-key test
//                 or substitution output can never masquerade as genuine
//                 Spark output in the drafts table.
// Draft source stamps derive from the transport of the stored analysis:
//   spark-api -> 'scribe' · stub -> 'scribe-stub' ·
//   substituted -> 'scribe-substituted'
// ---------------------------------------------------------------------------
const TRANSPORTS = ['spark-api', 'stub', 'substituted'];

function declaredTransport(client) {
  const t = client && client.transport;
  return TRANSPORTS.includes(t) ? t : 'substituted';
}

function sourceForTransport(transport) {
  if (transport === 'spark-api') return 'scribe';
  if (transport === 'stub') return 'scribe-stub';
  return 'scribe-substituted';
}

const SYSTEM_PROMPT = `You are Scribe, the AI analyst inside Manna (a marketing dashboard for small businesses, ministries, and creators).
You monitor the customer's performance data and direct their next content: which videos to make, which posts to publish, which emails to send.

Rules:
- Ground EVERY claim in the DATA JSON provided. Never invent numbers, trends, or results that are not in the data.
- Every observation MUST cite the numbers it rests on in its "metrics" object, copied from the data.
- If the data is thin, say so in an observation (citing the zero/low numbers) and recommend data-producing actions.
- Recommendations must be concrete and producible by a small team: a specific video to film, a specific post to publish, a specific email to send.
- Return ONLY a JSON object matching the requested schema. No prose outside the JSON.`;

function buildPrompt(signals) {
  const user = [
    'Analyze this customer\'s marketing performance data and return advice as JSON with EXACTLY this shape:',
    '{',
    '  "summary": "one or two sentences, grounded in the data",',
    '  "observations": [ { "text": "what the data shows", "metrics": { "label": number } } ],',
    '  "recommendations": [ {',
    '      "type": "video_brief" | "social_post" | "email_campaign",',
    '      "title": "short title",',
    '      "rationale": "why, citing the observation it follows from",',
    '      "based_on": ["the metric labels this rests on"],',
    '      "draft": { }  // video_brief: {"hook","outline","platform","product"}; social_post: {"platform","copy"}; email_campaign: {"subject","audience","outline"}',
    '  } ]',
    '}',
    'At least 1 observation and at least 1 recommendation. At most 5 of each.',
    '',
    'DATA (JSON):',
    JSON.stringify(signals),
  ].join('\n');
  return { system: SYSTEM_PROMPT, user };
}

// ---------------------------------------------------------------------------
// Schema validation (hand-rolled; the repo has no schema library).
// Returns { ok: true, advice } (normalized) or { ok: false, errors: [...] }.
// ---------------------------------------------------------------------------
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function validateAdvice(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, errors: ['advice is not an object'] };

  if (raw.summary !== undefined && typeof raw.summary !== 'string') {
    errors.push('summary must be a string');
  }

  if (!Array.isArray(raw.observations) || raw.observations.length === 0) {
    errors.push('observations must be a non-empty array');
  } else {
    raw.observations.forEach((o, i) => {
      if (!isPlainObject(o)) { errors.push(`observations[${i}] is not an object`); return; }
      if (typeof o.text !== 'string' || !o.text.trim()) errors.push(`observations[${i}].text is required`);
      if (!isPlainObject(o.metrics) || Object.keys(o.metrics).length === 0) {
        errors.push(`observations[${i}].metrics must cite at least one number`);
      } else {
        for (const [k, v] of Object.entries(o.metrics)) {
          if (typeof v !== 'number' && typeof v !== 'string') {
            errors.push(`observations[${i}].metrics.${k} must be a number or string`);
          }
        }
      }
    });
  }

  if (!Array.isArray(raw.recommendations) || raw.recommendations.length === 0) {
    errors.push('recommendations must be a non-empty array');
  } else {
    raw.recommendations.forEach((r, i) => {
      if (!isPlainObject(r)) { errors.push(`recommendations[${i}] is not an object`); return; }
      if (!REC_TYPES.includes(r.type)) errors.push(`recommendations[${i}].type must be one of ${REC_TYPES.join('|')}`);
      if (typeof r.title !== 'string' || !r.title.trim()) errors.push(`recommendations[${i}].title is required`);
      if (typeof r.rationale !== 'string' || !r.rationale.trim()) errors.push(`recommendations[${i}].rationale is required`);
      if (r.based_on !== undefined && !Array.isArray(r.based_on)) errors.push(`recommendations[${i}].based_on must be an array`);
      if (!isPlainObject(r.draft)) errors.push(`recommendations[${i}].draft must be an object`);
    });
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    advice: {
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      observations: raw.observations.slice(0, 10).map(o => ({ text: o.text, metrics: o.metrics })),
      recommendations: raw.recommendations.slice(0, 10).map(r => ({
        type: r.type,
        title: r.title,
        rationale: r.rationale,
        based_on: Array.isArray(r.based_on) ? r.based_on.filter(x => typeof x === 'string') : [],
        draft: r.draft,
        ...(r.sample === true ? { sample: true } : {}),
      })),
    },
  };
}

/** Extract a JSON object from model output (tolerates code fences / prose). */
function parseModelJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// Citation verification (F2). validateAdvice checks the SHAPE of the
// advice; this checks its TRUTH: every number an observation cites must
// exist in the tenant's own signals, under the cited label, with a
// matching value — exact for counts, small tolerance for derived rates
// (the model may round a rate the data layer computed to 1dp). ANY
// unverifiable citation rejects the WHOLE advice: fail-closed, the same
// discipline as malformed JSON. A client that invents numbers — 50,000
// sends for a tenant with none — produces no advice at all.
// ---------------------------------------------------------------------------
function numbersMatch(cited, actual) {
  // Integer actuals are counts: the citation must be that count exactly —
  // a fractional citation (2000.5 sends) never matches, no tolerance.
  if (Number.isInteger(actual)) return cited === actual;
  const diff = Math.abs(cited - actual);
  return diff <= 0.15 || diff <= 0.01 * Math.abs(actual);
}

function verifyCitations(advice, signals) {
  const map = scribeData.metricMap(signals);
  const errors = [];
  (advice.observations || []).forEach((o, i) => {
    for (const [label, value] of Object.entries(o.metrics || {})) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`observations[${i}].metrics.${label} is not a number`);
      } else if (!map.has(label)) {
        errors.push(`observations[${i}].metrics.${label} does not exist in the tenant's data`);
      } else if (!map.get(label).some(a => numbersMatch(value, a))) {
        errors.push(`observations[${i}].metrics.${label}=${value} does not match the tenant's data`);
      }
    }
  });
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Stub advice (no key): SAMPLE output, clearly marked, built from the
// tenant's real numbers so the demo of the pipeline shows real citations.
// ---------------------------------------------------------------------------
function stubAdvice(signals) {
  const observations = [];
  const recommendations = [];
  const all = signals.email && signals.email.windows ? signals.email.windows.all : null;

  if (all && all.sent > 0) {
    observations.push({
      text: `Email is your most measured channel: ${all.sent} sends all-time at a ${all.open_rate}% open rate and ${all.click_rate}% click rate.`,
      metrics: { sent: all.sent, opens: all.opens, clicks: all.clicks, open_rate_pct: all.open_rate, click_rate_pct: all.click_rate },
    });
    recommendations.push({
      type: 'email_campaign',
      title: 'SAMPLE: Follow-up email to your warmest segment',
      rationale: 'Sample recommendation (stub mode). In live mode Scribe targets the segment your real click data points to.',
      based_on: ['sent', 'click_rate_pct'],
      draft: {
        subject: 'A quick follow-up, just for you',
        audience: 'warm clickers',
        outline: 'Open with the result your audience cares about, one story, one clear call to action.',
      },
      sample: true,
    });
  } else {
    observations.push({
      text: 'No email sends are recorded yet, so there is no send/open/click performance for Scribe to reason from.',
      metrics: { sent: 0, opens: 0, clicks: 0 },
    });
    recommendations.push({
      type: 'email_campaign',
      title: 'SAMPLE: Send your first tracked campaign',
      rationale: 'Sample recommendation (stub mode). Real Scribe advice starts once the first campaign produces numbers.',
      based_on: ['sent'],
      draft: {
        subject: 'Start here',
        audience: 'individual',
        outline: 'Introduce the product, one clear benefit, one call to action. Log the send so Scribe can measure it.',
      },
      sample: true,
    });
  }

  const topVideo = signals.content.top_videos[0];
  if (topVideo && topVideo.views > 0) {
    observations.push({
      text: `Your best video is "${topVideo.video_name}" on ${topVideo.platform} with ${topVideo.views} views and ${topVideo.engagement} engagements.`,
      metrics: { top_video_views: topVideo.views, top_video_engagement: topVideo.engagement },
    });
    recommendations.push({
      type: 'video_brief',
      title: `SAMPLE: A follow-up to "${topVideo.video_name}"`,
      rationale: 'Sample recommendation (stub mode). In live mode Scribe directs the next video from what is performing and trending.',
      based_on: ['top_video_views'],
      draft: {
        hook: 'Open on the strongest moment from the original video.',
        outline: 'Recap the win in 10 seconds, add one new angle, close with the product call to action.',
        platform: topVideo.platform,
        product: topVideo.product,
      },
      sample: true,
    });
  }

  if (signals.trending.available) {
    const t = signals.trending.signals[0];
    observations.push({ text: `${t.signal} — ${t.evidence}.`, metrics: { trending_signals: signals.trending.signals.length } });
  }

  recommendations.push({
    type: 'social_post',
    title: 'SAMPLE: This week\'s anchor post',
    rationale: 'Sample recommendation (stub mode) demonstrating the social_post artifact type.',
    based_on: ['sent'],
    draft: {
      platform: 'instagram',
      copy: 'Sample post copy — live Scribe writes this from your current performance and trend data.',
    },
    sample: true,
  });

  return {
    summary: 'STUB MODE sample analysis — shape and citations are real, recommendations are samples.',
    observations,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// Advisory core.
//   analyze(tdb) -> { ok: true, mode, transport, analysisId, stub,
//                     advice, signals }
//                  | { ok: false, mode, transport, error, signals }
// On success the validated advice is persisted server-side and the
// result carries its opaque analysis id; drafts are later created from
// that stored record (createDrafts), never from client-held advice.
// opts.client may inject a chat-completion function (tests); defaults to
// the real Spark client. Injection never bypasses validation, citation
// verification, or honest transport labelling.
// ---------------------------------------------------------------------------
const ANALYSIS_TTL_MS = 60 * 60 * 1000; // analyses are short-lived (F1)

function storeAnalysis(tdb, { mode, transport, advice, signals }) {
  const id = crypto.randomBytes(18).toString('base64url');
  tdb.createScribeAnalysis({
    id, mode, transport, advice, signals,
    expiresAt: new Date(Date.now() + ANALYSIS_TTL_MS).toISOString(),
  });
  return id;
}

async function analyze(tdb, opts = {}) {
  const signals = scribeData.collectSignals(tdb);
  const client = opts.client || null;

  if (!client && !sparkClient.isConfigured()) {
    const advice = stubAdvice(signals);
    const check = verifyCitations(advice, signals);
    if (!check.ok) {
      return {
        ok: false, mode: 'stub', transport: 'stub',
        error: { code: 'scribe_unverified_citation', message: `Stub output failed citation verification: ${check.errors.join('; ')}` },
        signals,
      };
    }
    const analysisId = storeAnalysis(tdb, { mode: 'stub', transport: 'stub', advice, signals });
    return {
      ok: true,
      mode: 'stub',
      transport: 'stub',
      analysisId,
      stub: true,
      notice: 'STUB MODE: SPARK_API_KEY is not set. Recommendations are SAMPLES for pipeline testing — not live Scribe advice.',
      advice,
      signals,
    };
  }

  const transport = client ? declaredTransport(client) : declaredTransport(sparkClient.chatCompletion);
  const { system, user } = buildPrompt(signals);
  let text;
  try {
    text = client
      ? await client({ system, user })
      : await sparkClient.chatCompletion({ system, user, maxTokens: 1800 });
  } catch (e) {
    return {
      ok: false, mode: 'live', transport,
      error: { code: (e && e.code) || 'spark_error', message: 'Scribe could not reach Spark; no advice was produced.' },
      signals,
    };
  }

  const parsed = parseModelJson(text);
  if (!parsed) {
    return {
      ok: false, mode: 'live', transport,
      error: { code: 'scribe_malformed_output', message: 'Spark returned output that was not valid JSON; no advice was produced.' },
      signals,
    };
  }
  const v = validateAdvice(parsed);
  if (!v.ok) {
    return {
      ok: false, mode: 'live', transport,
      error: { code: 'scribe_invalid_output', message: `Spark output failed schema validation: ${v.errors.join('; ')}` },
      signals,
    };
  }
  const check = verifyCitations(v.advice, signals);
  if (!check.ok) {
    return {
      ok: false, mode: 'live', transport,
      error: { code: 'scribe_unverified_citation', message: `Output cited numbers that do not match the tenant's data: ${check.errors.join('; ')}` },
      signals,
    };
  }
  const analysisId = storeAnalysis(tdb, { mode: 'live', transport, advice: v.advice, signals });
  return { ok: true, mode: 'live', transport, analysisId, stub: false, advice: v.advice, signals };
}

// ---------------------------------------------------------------------------
// Act-layer: recommendations -> DRAFT rows in scribe_drafts.
// Only ever inserts rows with status 'draft'. Never sends, never posts.
// ---------------------------------------------------------------------------
function draftBody(rec) {
  const d = rec.draft || {};
  if (rec.type === 'video_brief') {
    return [d.hook && `Hook: ${d.hook}`, d.outline, d.platform && `Platform: ${d.platform}`, d.product && `Product: ${d.product}`]
      .filter(Boolean).join('\n');
  }
  if (rec.type === 'social_post') {
    return [d.platform && `Platform: ${d.platform}`, d.copy].filter(Boolean).join('\n');
  }
  if (rec.type === 'email_campaign') {
    return [d.subject && `Subject: ${d.subject}`, d.audience && `Audience: ${d.audience}`, d.outline]
      .filter(Boolean).join('\n');
  }
  return '';
}

/**
 * Create drafts from a STORED analysis (F1) — the only way drafts come
 * into existence. The source stamp derives from the analysis record's
 * transport (server-side truth); nothing the client sends can influence
 * it. IDEMPOTENT (F6): re-creating from the same analysis returns the
 * existing drafts instead of duplicating them. Each draft's payload
 * carries the full observations + a snapshot of the signals the advice
 * was reasoned from (F4 — full attribution, as migration 023 promised).
 *
 * @param {object} tdb tenant handle
 * @param {string} analysisId opaque id returned by analyze()
 * @returns { created: [{ id, draft_type, title, status, source }],
 *            idempotent: boolean }
 * Throws err.code 'scribe_analysis_not_found' (unknown/foreign/expired
 * id), 'scribe_invalid_advice' (stored record fails re-validation), or
 * 'scribe_draft_cap' (tenant's pending-draft cap reached).
 */
const MAX_PENDING_DRAFTS_PER_TENANT = 200;

function createDrafts(tdb, analysisId) {
  const analysis = tdb.getScribeAnalysis(analysisId);
  if (!analysis) {
    const err = new Error('createDrafts: analysis not found or expired');
    err.code = 'scribe_analysis_not_found';
    throw err;
  }
  const v = validateAdvice(analysis.advice);
  if (!v.ok) {
    const err = new Error(`createDrafts: stored advice invalid (${v.errors.join('; ')})`);
    err.code = 'scribe_invalid_advice';
    throw err;
  }

  const existing = tdb.listScribeDraftsByAnalysis(analysisId);
  if (existing.length) {
    return {
      created: existing.map(r => ({
        id: r.id, draft_type: r.draft_type, title: r.title, status: r.status, source: r.source,
      })),
      idempotent: true,
    };
  }

  const pending = tdb.countScribeDrafts({ status: 'draft' });
  if (pending + v.advice.recommendations.length > MAX_PENDING_DRAFTS_PER_TENANT) {
    const err = new Error(`createDrafts: tenant already has ${pending} pending drafts (cap ${MAX_PENDING_DRAFTS_PER_TENANT})`);
    err.code = 'scribe_draft_cap';
    throw err;
  }

  const source = sourceForTransport(analysis.transport);
  const rows = v.advice.recommendations.map(rec => ({
    draftType: rec.type,
    title: rec.title,
    body: draftBody(rec),
    payload: {
      recommendation: rec,
      summary: v.advice.summary,
      observations: v.advice.observations,
      signals: analysis.signals,
      analysis_id: analysisId,
      transport: analysis.transport,
    },
    source,
    analysisId,
  }));
  const ids = tdb.insertScribeDrafts(rows);
  return {
    created: rows.map((row, i) => ({
      id: ids[i], draft_type: row.draftType, title: row.title, status: 'draft', source,
    })),
    idempotent: false,
  };
}

function status() {
  const configured = sparkClient.isConfigured();
  return {
    ok: true,
    provider: configured ? 'spark' : 'stub',
    // The transport that would produce advice (and stamp drafts) right
    // now — the operator can see which mode is active before trusting
    // any draft's provenance.
    transport: configured ? declaredTransport(sparkClient.chatCompletion) : 'stub',
    model: configured ? config.sparkModel : null,
    configured,
    note: configured
      ? 'Scribe is live on Muse Spark (Meta Model API).'
      : 'STUB MODE: set SPARK_API_KEY to connect Scribe to Muse Spark. Sample output only until then.',
  };
}

module.exports = {
  analyze, createDrafts, status,
  validateAdvice, verifyCitations, parseModelJson, stubAdvice, buildPrompt,
  declaredTransport, sourceForTransport, TRANSPORTS,
  MAX_PENDING_DRAFTS_PER_TENANT,
  REC_TYPES,
};
