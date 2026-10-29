'use strict';
/**
 * Scribe tests (no SPARK_API_KEY in test env -> stub mode).
 *  - status reports the stub provider AND the active transport
 *  - analyze returns structured, clearly-marked SAMPLE advice whose
 *    observations cite the tenant's real seeded numbers, and stores the
 *    advice server-side (only an opaque analysis_id comes back)
 *  - act-layer: drafts are created ONLY from a stored analysis id
 *    (F1 — a client-supplied advice object can no longer create drafts
 *    at all, in any mode); creation is idempotent per analysis (F6);
 *    payload carries observations + signals snapshot (F4)
 *  - draft status is a state machine: draft -> approved|dismissed only,
 *    both terminal, decision audited (F5); ids are parsed strictly (F7)
 *  - tenant isolation: a foreign analysis id is indistinguishable from a
 *    missing one (404, zero drafts)
 *  - advisory core is FAIL-CLOSED in live mode: an injected client that
 *    throws, returns non-JSON, returns schema-invalid JSON, or cites
 *    numbers the tenant does not have produces an error state and NO
 *    advice (F2 — citations are verified against the tenant's signals)
 *  - provenance: an undeclared injected client is transport
 *    'substituted' and its drafts are stamped 'scribe-substituted'; a
 *    client declaring transport 'spark-api' earns 'scribe'; stub drafts
 *    can never carry 'scribe'
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
// Scribe must be in stub mode for these tests regardless of outer env.
delete process.env.SPARK_API_KEY;

// Require AFTER setupTestEnv so the modules pick up the test DATABASE_PATH.
const { db, forTenant } = require('../src/db');
const scribe = require('../src/lib/scribe');

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

async function register(email, company) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: company || ('Scribe Co ' + email), email, password: 'scribe-secret-pw-1',
  });
  assert.equal(r.status, 201);
  return { c, tenantId: r.json.tenant.id };
}

function seedTenant(tenantId) {
  db.prepare(`INSERT INTO email_snapshots (tenant_id, window_key, sent, opens, clicks)
              VALUES (?, 'all', 2000, 300, 20)`).run(tenantId);
  db.prepare(`INSERT INTO video_postings (tenant_id, video_name, product, platform, views, likes, comments, shares)
              VALUES (?, 'Launch Teaser', 'manna', 'instagram', 5000, 400, 30, 25)`).run(tenantId);
}

function draftCount(tenantId) {
  return db.prepare('SELECT COUNT(*) AS n FROM scribe_drafts WHERE tenant_id = ?').get(tenantId).n;
}

// Direct tenant creation for lib-level tests: the auth router's rate
// limiter (20/IP/15min) is already saturated by the HTTP tests above, so
// tests that only exercise scribe.analyze/createDrafts insert the tenant
// row directly instead of registering over HTTP.
let tenantSeq = 0;
function makeTenant(label) {
  const info = db.prepare('INSERT INTO tenants (name, slug, plan) VALUES (?, ?, ?)')
    .run('Scribe ' + label, 'scribe-' + label + '-' + (++tenantSeq), 'starter');
  return Number(info.lastInsertRowid);
}

// Advice that cites the seeded tenant's TRUE numbers (2000 sent, 1.0%
// click rate) — passes shape validation AND citation verification.
const GOOD = {
  summary: 'Email is your measured channel; clicks are the lever.',
  observations: [{ text: 'You sent 2,000 emails at a 1.0% click rate.', metrics: { sent: 2000, click_rate_pct: 1.0 } }],
  recommendations: [{
    type: 'social_post', title: 'Pin the best post', rationale: 'Follows from the click observation.',
    based_on: ['click_rate_pct'], draft: { platform: 'instagram', copy: 'Pinned.' },
  }],
};
const goodClient = (extra) => Object.assign(async () => JSON.stringify(GOOD), extra || {});

test('status reports stub mode and the stub transport', async () => {
  const { c } = await register('s-status@example.org');
  const r = await c.get('/api/scribe/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.provider, 'stub');
  assert.equal(r.json.transport, 'stub');
  assert.equal(r.json.configured, false);
});

test('analyze (stub) returns structured sample advice citing real numbers', async () => {
  const { c, tenantId } = await register('s-analyze@example.org');
  seedTenant(tenantId);
  const r = await c.post('/api/scribe/analyze', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.mode, 'stub');
  assert.equal(r.json.transport, 'stub');
  assert.equal(typeof r.json.analysis_id, 'string');
  assert.ok(r.json.analysis_id.length >= 16);
  assert.equal(r.json.stub, true);
  assert.match(r.json.notice, /STUB MODE/);
  const advice = r.json.advice;
  assert.ok(Array.isArray(advice.observations) && advice.observations.length >= 1);
  assert.ok(Array.isArray(advice.recommendations) && advice.recommendations.length >= 1);
  // Every recommendation is marked as a sample in stub mode.
  assert.ok(advice.recommendations.every(rec => rec.sample === true));
  // Observations cite the seeded numbers (2000 sends, 5000 views).
  const cited = JSON.stringify(advice.observations);
  assert.match(cited, /2000/);
  assert.match(cited, /5000/);
  // Every observation carries a metrics object (citation requirement).
  assert.ok(advice.observations.every(o => o.metrics && Object.keys(o.metrics).length > 0));
  // Signals came back tenant-scoped.
  assert.equal(r.json.signals.email.windows.all.sent, 2000);
});

test('act-layer: drafts from a stored analysis only; idempotent; audited decisions', async () => {
  const { c, tenantId } = await register('s-drafts@example.org');
  seedTenant(tenantId);
  const a = await c.post('/api/scribe/analyze', {});
  assert.equal(a.status, 200);
  const n = a.json.advice.recommendations.length;

  const created = await c.post('/api/scribe/drafts', { analysis_id: a.json.analysis_id });
  assert.equal(created.status, 201);
  assert.equal(created.json.idempotent, false);
  assert.equal(created.json.created.length, n);
  assert.ok(created.json.created.every(d => d.status === 'draft'));
  // (c) stub-mode drafts can never carry the live stamp.
  assert.ok(created.json.created.every(d => d.source === 'scribe-stub'));

  // F6: re-creating from the same analysis returns the same drafts.
  const replay = await c.post('/api/scribe/drafts', { analysis_id: a.json.analysis_id });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.idempotent, true);
  assert.deepEqual(
    replay.json.created.map(d => d.id).sort(),
    created.json.created.map(d => d.id).sort(),
  );
  assert.equal(draftCount(tenantId), n);

  const list = await c.get('/api/scribe/drafts');
  assert.equal(list.status, 200);
  assert.equal(list.json.drafts.length, n);
  assert.ok(list.json.drafts.every(d => d.status === 'draft'));
  // F4: payload traces back to recommendation AND the cited evidence.
  assert.ok(list.json.drafts.every(d => d.payload && d.payload.recommendation));
  assert.ok(list.json.drafts.every(d => Array.isArray(d.payload.observations) && d.payload.observations.length >= 1));
  assert.ok(list.json.drafts.every(d => d.payload.signals && d.payload.signals.email.windows.all.sent === 2000));
  assert.ok(list.json.drafts.every(d => d.payload.analysis_id === a.json.analysis_id));
  assert.ok(list.json.drafts.every(d => d.payload.transport === 'stub'));

  // F5: draft -> approved works and is audited...
  const id = list.json.drafts[0].id;
  const approve = await c.post(`/api/scribe/drafts/${id}/status`, { status: 'approved' });
  assert.equal(approve.status, 200);
  const afterApprove = await c.get('/api/scribe/drafts?status=approved');
  assert.equal(afterApprove.json.drafts.length, 1);
  assert.equal(afterApprove.json.drafts[0].id, id);
  assert.ok(Number.isInteger(afterApprove.json.drafts[0].decided_by) && afterApprove.json.drafts[0].decided_by > 0);
  assert.match(afterApprove.json.drafts[0].decided_at, /^\d{4}-\d{2}-\d{2}T/);

  // ...approved is terminal: no re-deciding, no flipping to dismissed.
  const reApprove = await c.post(`/api/scribe/drafts/${id}/status`, { status: 'approved' });
  assert.equal(reApprove.status, 409);
  const flip = await c.post(`/api/scribe/drafts/${id}/status`, { status: 'dismissed' });
  assert.equal(flip.status, 409);
  // 'draft' is not a legal target, and unknown statuses are refused.
  const backToDraft = await c.post(`/api/scribe/drafts/${id}/status`, { status: 'draft' });
  assert.equal(backToDraft.status, 400);
  const badStatus = await c.post(`/api/scribe/drafts/${id}/status`, { status: 'sent' });
  assert.equal(badStatus.status, 400);
  // F7: a sloppy id must not resolve to a real draft.
  const sloppy = await c.post(`/api/scribe/drafts/${id}x/status`, { status: 'dismissed' });
  assert.equal(sloppy.status, 400);
});

test('(a) client-forged advice can no longer create drafts at all', async () => {
  const { c, tenantId } = await register('s-forged@example.org');
  seedTenant(tenantId);
  // Hand-written, perfectly-shaped advice — the old provenance hole.
  const forged = await c.post('/api/scribe/drafts', { advice: GOOD });
  assert.equal(forged.status, 400);
  assert.equal(forged.json.error, 'analysis_id_required');
  assert.equal(draftCount(tenantId), 0);
  // Missing body and unknown ids are refused too, creating nothing.
  const missing = await c.post('/api/scribe/drafts', {});
  assert.equal(missing.status, 400);
  const unknown = await c.post('/api/scribe/drafts', { analysis_id: 'AAAAAAAAAAAAAAAAAAAAAA' });
  assert.equal(unknown.status, 404);
  assert.equal(draftCount(tenantId), 0);
});

test('(d) a foreign analysis id is a 404 and creates zero drafts', async () => {
  const a = await register('s-x-a@example.org');
  seedTenant(a.tenantId);
  const analysis = await a.c.post('/api/scribe/analyze', {});
  assert.equal(analysis.status, 200);

  const b = await register('s-x-b@example.org');
  const steal = await b.c.post('/api/scribe/drafts', { analysis_id: analysis.json.analysis_id });
  assert.equal(steal.status, 404);
  assert.equal(draftCount(b.tenantId), 0);

  // The rightful owner is unaffected.
  const mine = await a.c.post('/api/scribe/drafts', { analysis_id: analysis.json.analysis_id });
  assert.equal(mine.status, 201);
  assert.ok(draftCount(a.tenantId) > 0);
});

test('drafts are tenant-isolated', async () => {
  const a = await register('s-iso-a@example.org');
  seedTenant(a.tenantId);
  const analysis = await a.c.post('/api/scribe/analyze', {});
  await a.c.post('/api/scribe/drafts', { analysis_id: analysis.json.analysis_id });
  const mine = await a.c.get('/api/scribe/drafts');
  assert.ok(mine.json.drafts.length > 0);
  const draftId = mine.json.drafts[0].id;

  const b = await register('s-iso-b@example.org');
  const theirs = await b.c.get('/api/scribe/drafts');
  assert.equal(theirs.json.drafts.length, 0);
  const steal = await b.c.post(`/api/scribe/drafts/${draftId}/status`, { status: 'approved' });
  assert.equal(steal.status, 404);
});

test('analyze rate limit is keyed per tenant, not per IP (F3)', async () => {
  const a = await register('s-rl-a@example.org');
  // Every test client shares one IP (loopback); under the old per-IP key
  // tenant B below would inherit A's exhausted budget and starve.
  for (let i = 0; i < 30; i++) {
    const r = await a.c.post('/api/scribe/analyze', {});
    assert.equal(r.status, 200, `call ${i + 1}`);
  }
  const over = await a.c.post('/api/scribe/analyze', {});
  assert.equal(over.status, 429);
  const b = await register('s-rl-b@example.org');
  const fresh = await b.c.post('/api/scribe/analyze', {});
  assert.equal(fresh.status, 200);
});

test('unauthenticated scribe calls are rejected', async () => {
  const c = client(base);
  const r = await c.post('/api/scribe/analyze', {});
  assert.equal(r.status, 401);
});

// --- advisory core: fail-closed live path (injected clients, no network) ---

test('live path: client error -> error state, no advice (fail-closed)', async () => {
  const { tenantId } = await register('s-fail@example.org');
  const tdb = forTenant(tenantId);
  const boom = new Error('upstream down');
  boom.code = 'spark_http_500';
  const r = await scribe.analyze(tdb, { client: async () => { throw boom; } });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'spark_http_500');
  assert.equal(r.transport, 'substituted');
  assert.equal(r.advice, undefined);
  assert.equal(r.analysisId, undefined);
});

test('live path: non-JSON output -> error state, no advice', async () => {
  const { tenantId } = await register('s-nonjson@example.org');
  const tdb = forTenant(tenantId);
  const r = await scribe.analyze(tdb, { client: async () => 'Here is my advice, in prose!' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'scribe_malformed_output');
  assert.equal(r.transport, 'substituted');
  assert.equal(r.advice, undefined);
});

test('live path: schema-invalid JSON -> error state, no advice', async () => {
  const { tenantId } = await register('s-badschema@example.org');
  const tdb = forTenant(tenantId);
  const bad = JSON.stringify({ observations: [{ text: 'no metrics cited' }], recommendations: [] });
  const r = await scribe.analyze(tdb, { client: async () => bad });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'scribe_invalid_output');
  assert.equal(r.advice, undefined);
});

test('(b) live path: invented metric values are rejected whole (F2)', async () => {
  const cases = [
    ['s-fake-count@example.org', { sent: 999999 }],              // fabricated count
    ['s-fake-string@example.org', { open_rate: 'banana' }],      // non-numeric citation
    ['s-fake-label@example.org', { conversions: 42 }],           // label not in the data
  ];
  for (const [email, metrics] of cases) {
    const { tenantId } = await register(email);
    seedTenant(tenantId);
    const tdb = forTenant(tenantId);
    const advice = {
      summary: 'Trust me.',
      observations: [{ text: 'Huge numbers, honestly.', metrics }],
      recommendations: GOOD.recommendations,
    };
    const r = await scribe.analyze(tdb, { client: async () => JSON.stringify(advice) });
    assert.equal(r.ok, false, email);
    assert.equal(r.error.code, 'scribe_unverified_citation', email);
    assert.equal(r.advice, undefined, email);
    assert.equal(r.analysisId, undefined, email);
    assert.equal(draftCount(tenantId), 0, email);
  }
});

test('live path: undeclared client -> substituted transport and stamps', async () => {
  const { tenantId } = await register('s-live@example.org');
  seedTenant(tenantId);
  const tdb = forTenant(tenantId);
  const r = await scribe.analyze(tdb, { client: async () => '```json\n' + JSON.stringify(GOOD) + '\n```' });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'live');
  assert.equal(r.stub, false);
  assert.equal(r.transport, 'substituted');
  assert.equal(r.advice.recommendations[0].title, 'Pin the best post');

  const result = scribe.createDrafts(tdb, r.analysisId);
  assert.equal(result.idempotent, false);
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].source, 'scribe-substituted');
  const rows = tdb.listScribeDrafts({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'draft');
  assert.equal(rows[0].source, 'scribe-substituted');
  assert.equal(rows[0].payload.transport, 'substituted');
});

test("live path: client declaring 'spark-api' earns the 'scribe' stamp", async () => {
  const { tenantId } = await register('s-spark@example.org');
  seedTenant(tenantId);
  const tdb = forTenant(tenantId);
  const r = await scribe.analyze(tdb, { client: goodClient({ transport: 'spark-api' }) });
  assert.equal(r.ok, true);
  assert.equal(r.transport, 'spark-api');

  const result = scribe.createDrafts(tdb, r.analysisId);
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].source, 'scribe');
  const rows = tdb.listScribeDrafts({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'scribe');
});

test('expired analyses cannot create drafts', async () => {
  const { tenantId } = await register('s-expired@example.org');
  const tdb = forTenant(tenantId);
  tdb.createScribeAnalysis({
    id: 'expired-analysis-id', mode: 'stub', transport: 'stub',
    advice: GOOD, signals: {}, expiresAt: '2000-01-01T00:00:00.000Z',
  });
  assert.throws(
    () => scribe.createDrafts(tdb, 'expired-analysis-id'),
    (e) => e.code === 'scribe_analysis_not_found',
  );
  assert.equal(draftCount(tenantId), 0);
});

test('pending-draft cap refuses new creations (F6)', async () => {
  const { tenantId } = await register('s-cap@example.org');
  const ins = db.prepare(`INSERT INTO scribe_drafts (tenant_id, draft_type, title, source)
                          VALUES (?, 'social_post', 'filler', 'scribe-stub')`);
  for (let i = 0; i < scribe.MAX_PENDING_DRAFTS_PER_TENANT; i++) ins.run(tenantId);
  const tdb = forTenant(tenantId);
  const r = await scribe.analyze(tdb, {});
  assert.equal(r.ok, true);
  assert.throws(
    () => scribe.createDrafts(tdb, r.analysisId),
    (e) => e.code === 'scribe_draft_cap',
  );
  assert.equal(draftCount(tenantId), scribe.MAX_PENDING_DRAFTS_PER_TENANT);
});

test('(b2) live path: fractional citations of integer counts are rejected whole (RT2)', async () => {
  const cases = [
    ['frac-over', { sent: 2000.5 }],   // fraction just over the true count
    ['frac-under', { sent: 1999.9 }],  // fraction just under the true count
  ];
  for (const [email, metrics] of cases) {
    const tenantId = makeTenant(email);
    seedTenant(tenantId);
    const tdb = forTenant(tenantId);
    const advice = {
      summary: 'Almost the real numbers.',
      observations: [{ text: 'Close enough, surely.', metrics }],
      recommendations: GOOD.recommendations,
    };
    const r = await scribe.analyze(tdb, { client: async () => JSON.stringify(advice) });
    assert.equal(r.ok, false, email);
    assert.equal(r.error.code, 'scribe_unverified_citation', email);
    assert.equal(r.advice, undefined, email);
    assert.equal(r.analysisId, undefined, email);
    assert.equal(draftCount(tenantId), 0, email);
  }
});

test('live path: exact integer citations still verify and draft', async () => {
  const tenantId = makeTenant('exact');
  seedTenant(tenantId);
  const tdb = forTenant(tenantId);
  const advice = {
    summary: 'Email is your measured channel.',
    observations: [{ text: 'You sent 2,000 emails; 300 opens, 20 clicks.', metrics: { sent: 2000, opens: 300, clicks: 20 } }],
    recommendations: GOOD.recommendations,
  };
  const r = await scribe.analyze(tdb, { client: async () => JSON.stringify(advice) });
  assert.equal(r.ok, true);
  assert.equal(typeof r.analysisId, 'string');
  const result = scribe.createDrafts(tdb, r.analysisId);
  assert.equal(result.created.length, 1);
  assert.equal(draftCount(tenantId), 1);
});

test('verifyCitations: non-integer rates keep the tolerance (no over-tightening)', () => {
  const signals = {
    email: { windows: { all: { sent: 2000, opens: 300, clicks: 20, open_rate: 15.05, click_rate: 1.0 } } },
  };
  const advice = {
    observations: [{ text: 'Rates as derived.', metrics: { open_rate_pct: 15.04, click_rate_pct: 1.0 } }],
  };
  const check = scribe.verifyCitations(advice, signals);
  assert.equal(check.ok, true, check.errors.join('; '));
});

test('stub mode: zero-activity tenant still analyzes end-to-end (integer zero citations)', async () => {
  const tenantId = makeTenant('zero');
  const tdb = forTenant(tenantId);
  const r = await scribe.analyze(tdb, {});
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'stub');
  assert.equal(r.transport, 'stub');
  const result = scribe.createDrafts(tdb, r.analysisId);
  assert.ok(result.created.length >= 1);
  assert.ok(result.created.every(d => d.source === 'scribe-stub'));
  assert.equal(draftCount(tenantId), result.created.length);
});

test('validateAdvice enforces the citation + shape rules', () => {
  assert.equal(scribe.validateAdvice(null).ok, false);
  assert.equal(scribe.validateAdvice({ observations: [], recommendations: [] }).ok, false);
  assert.equal(scribe.validateAdvice({
    observations: [{ text: 'x', metrics: {} }],
    recommendations: [{ type: 'video_brief', title: 't', rationale: 'r', draft: {} }],
  }).ok, false); // observation cites no numbers
  assert.equal(scribe.validateAdvice({
    observations: [{ text: 'x', metrics: { sent: 3 } }],
    recommendations: [{ type: 'video_brief', title: 't', rationale: 'r', draft: {} }],
  }).ok, true);
});
