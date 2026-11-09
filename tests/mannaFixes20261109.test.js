'use strict';
/**
 * Manna fixes of 2026-11-09 (Michael's approval, one deploy):
 *
 *  1. Scribe error surfacing + call hardening:
 *     - a spark_timeout triggers ONE retry with a trimmed payload
 *       (compactSignals); a second timeout is final (fail-closed).
 *     - non-timeout failures are never retried.
 *     - the client's real error message reaches the result (the route
 *       forwards it as `detail` and the dashboard shows it), instead of
 *       every failure collapsing into one generic line.
 *
 *  2. Briefing window label: the assistant's default briefing is built
 *     from the ALL-TIME email snapshot and now says so.
 *
 *  3. Funnel registration: lead pipelines are derived live from the
 *     leads table (tdb.leadPipelines) and counted by the assistant's
 *     context alongside manual funnels; counts change on re-read when
 *     the underlying leads change (nothing hand-entered, nothing
 *     stored), tenants stay isolated, 'rejected' is an exit, not a
 *     stage, and the manual funnels table is untouched.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer } = require('./helpers');

setupTestEnv();
// Scribe must be in stub mode for the no-client paths regardless of env.
delete process.env.SPARK_API_KEY;

// Require AFTER setupTestEnv so the modules pick up the test DATABASE_PATH.
const { db, forTenant } = require('../src/db');
const scribe = require('../src/lib/scribe');
const assistant = require('../src/lib/assistant');

// Booting the app is what runs the migrations against the fresh test DB;
// these tests then work at lib level (direct tenants, like scribe.test.js).
let server;
before(async () => { ({ server } = await startServer()); });
after(async () => { server.close(); });

let tenantSeq = 0;
function makeTenant(label) {
  const info = db.prepare('INSERT INTO tenants (name, slug, plan) VALUES (?, ?, ?)')
    .run('Fixes ' + label, 'fixes-' + label + '-' + (++tenantSeq), 'starter');
  return Number(info.lastInsertRowid);
}

function seedEmail(tenantId) {
  db.prepare(`INSERT INTO email_snapshots (tenant_id, window_key, sent, opens, clicks)
              VALUES (?, 'all', 2000, 300, 20)`).run(tenantId);
}

function seedVideos(tenantId, n) {
  const ins = db.prepare(`INSERT INTO video_postings (tenant_id, video_name, product, platform, views, likes, comments, shares)
                          VALUES (?, ?, 'manna', 'instagram', ?, 10, 2, 1)`);
  for (let i = 0; i < n; i++) ins.run(tenantId, 'Video ' + (i + 1), 1000 * (n - i));
}

// Advice citing the seeded tenant's TRUE numbers (2000 sent, 1.0% click
// rate): passes shape validation AND citation verification in both the
// full and the trimmed prompt, because verification always runs against
// the full signals.
const GOOD = {
  summary: 'Email is your measured channel; clicks are the lever.',
  observations: [{ text: 'You sent 2,000 emails at a 1.0% click rate.', metrics: { sent: 2000, click_rate_pct: 1.0 } }],
  recommendations: [{
    type: 'social_post', title: 'Pin the best post', rationale: 'Follows from the click observation.',
    based_on: ['click_rate_pct'], draft: { platform: 'instagram', copy: 'Pinned.' },
  }],
};

function timeoutError() {
  const e = new Error('Spark request failed before a response was received (spark_timeout).');
  e.code = 'spark_timeout';
  return e;
}

// --- Fix 1: retry + error surfacing --------------------------------------

test('scribe: timeout on the first call retries once with a trimmed prompt and succeeds', async () => {
  const tenantId = makeTenant('retry-ok');
  seedEmail(tenantId);
  seedVideos(tenantId, 5);
  const tdb = forTenant(tenantId);
  const prompts = [];
  const client = async ({ user }) => {
    prompts.push(user);
    if (prompts.length === 1) throw timeoutError();
    return JSON.stringify(GOOD);
  };
  const r = await scribe.analyze(tdb, { client });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'live');
  assert.equal(prompts.length, 2, 'exactly one retry');
  assert.ok(prompts[1].length < prompts[0].length, 'retry prompt is trimmed');
});

test('scribe: a second timeout is final, no third call, real message surfaces', async () => {
  const tenantId = makeTenant('retry-final');
  seedEmail(tenantId);
  const tdb = forTenant(tenantId);
  let calls = 0;
  const client = async () => { calls++; throw timeoutError(); };
  const r = await scribe.analyze(tdb, { client });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'spark_timeout');
  assert.match(r.error.message, /spark_timeout/);
  assert.equal(calls, 2, 'first call plus exactly one retry');
  assert.equal(r.advice, undefined);
});

test('scribe: non-timeout failures are not retried and their message passes through', async () => {
  const tenantId = makeTenant('http-401');
  seedEmail(tenantId);
  const tdb = forTenant(tenantId);
  let calls = 0;
  const client = async () => {
    calls++;
    const e = new Error('Spark API returned HTTP 401.');
    e.code = 'spark_http_401';
    throw e;
  };
  const r = await scribe.analyze(tdb, { client });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'spark_http_401');
  assert.equal(r.error.message, 'Spark API returned HTTP 401.');
  assert.equal(calls, 1, 'no retry for non-timeout failures');
});

test('scribe: compactSignals trims lists and keeps the email windows whole', () => {
  const signals = {
    email: { windows: { all: { sent: 5 } }, campaigns_total: 9, top_campaigns: [1, 2, 3, 4, 5] },
    content: { top_videos: [1, 2, 3, 4, 5], recent_postings: [1, 2, 3, 4, 5], top_posts: [1, 2, 3, 4, 5] },
    library: { films_total: 10, films: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    operator_answers: [1, 2, 3],
    trending: { available: true, signals: [1, 2, 3] },
  };
  const c = scribe.compactSignals(signals);
  assert.equal(c.email.windows.all.sent, 5, 'windows untouched');
  assert.equal(c.email.top_campaigns.length, 3);
  assert.equal(c.content.top_videos.length, 3);
  assert.equal(c.content.recent_postings.length, 3);
  assert.equal(c.content.top_posts.length, 3);
  assert.equal(c.library.films.length, 5);
  assert.equal(c.operator_answers.length, 2);
  assert.equal(c.trending.signals.length, 2);
  // the input is not mutated
  assert.equal(signals.content.top_videos.length, 5);
  assert.equal(signals.library.films.length, 10);
});

// --- Fix 3: derived lead pipelines ----------------------------------------

test('leadPipelines derives stage counts live from the leads table', () => {
  const tenantId = makeTenant('pipelines');
  const tdb = forTenant(tenantId);
  assert.deepEqual(tdb.leadPipelines(), [], 'no leads, no pipelines');

  tdb.createInfluencer({ handle: 'Acme Family Office', category: 'family_office', email: 'a@acme.example' });
  tdb.createInfluencer({ handle: 'Beacon Family Office', category: 'family_office', email: 'b@beacon.example' });
  tdb.createInfluencer({ handle: 'Covenant Family Office', category: 'family_office', email: 'c@covenant.example', status: 'vetted' });
  tdb.createInfluencer({ handle: 'Dead End Office', category: 'family_office', email: 'd@dead.example', status: 'rejected' });
  tdb.createInfluencer({ handle: 'Pastor One', category: 'pastor', email: 'p@pastor.example', status: 'contacted' });

  const pipes = tdb.leadPipelines();
  assert.equal(pipes.length, 2);
  const fo = pipes.find(p => p.funnel_key === 'leads:family_office');
  assert.ok(fo, 'family office pipeline present');
  assert.equal(fo.name, 'Family Offices pipeline');
  assert.deepEqual(
    fo.stages.map(s => [s.stage_key, s.current_value]),
    [['unvetted', 2], ['vetted', 1]],
    'rejected is an exit, not a stage',
  );
  const pastor = pipes.find(p => p.funnel_key === 'leads:pastor');
  assert.deepEqual(pastor.stages.map(s => [s.stage_key, s.current_value]), [['contacted', 1]]);

  // Liveness: a lead added after the first read shows on the next read,
  // with no stored funnel row anywhere.
  tdb.createInfluencer({ handle: 'New Office', category: 'family_office', email: 'n@new.example', status: 'active' });
  const again = tdb.leadPipelines().find(p => p.funnel_key === 'leads:family_office');
  assert.deepEqual(
    again.stages.map(s => [s.stage_key, s.current_value]),
    [['unvetted', 2], ['vetted', 1], ['active', 1]],
  );
  assert.deepEqual(tdb.funnels(), [], 'manual funnels table untouched');

  // Tenant isolation.
  const other = forTenant(makeTenant('pipelines-other'));
  assert.deepEqual(other.leadPipelines(), []);
});

// --- Fixes 2 + 3 together: the briefing -----------------------------------

test('briefing counts lead pipelines and labels the email window as all time', () => {
  const tenantId = makeTenant('briefing');
  seedEmail(tenantId);
  const tdb = forTenant(tenantId);
  tdb.createInfluencer({ handle: 'Acme Family Office', category: 'family_office', email: 'a@acme.example' });

  const ctx = assistant.buildContext(tdb);
  assert.equal(ctx.funnels.length, 1, 'the lead pipeline counts as a funnel');
  assert.equal(ctx.funnels[0].name, 'Family Offices pipeline');
  assert.equal(ctx.funnels[0].stages[0].current, 1);

  const reply = assistant.insightReply('give me the rundown', ctx);
  assert.match(reply, /Quick briefing: 2,000 emails sent, all time \(15% open, 1% click\), 1 funnel\(s\)/);
});
