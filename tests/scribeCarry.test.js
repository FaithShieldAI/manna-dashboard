'use strict';
/**
 * The approval carry (2026-11-22): approving a Scribe draft used to
 * stamp the row and send it nowhere. These tests pin where each draft
 * type goes on approval, walked through the real API:
 *   email_campaign -> a campaign in the Email tab (nothing sent)
 *   video_brief    -> a brief row in My Videos (nothing generated)
 *   social_post    -> decided copy (no artifact; nothing posted)
 * and that dismissal carries nothing, and the follow-up batch OK
 * carries its drafts the same way.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

const { db } = require('../src/db');

const PW = 'carry-' + 'pw-1234';

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

async function register(email) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Carry Co ' + email, email, password: PW,
  });
  assert.equal(r.status, 201);
  return { c, tenantId: r.json.tenant.id };
}

function insertDraft(tenantId, draftType, title, draftFields, body) {
  const payload = JSON.stringify({
    recommendation: { type: draftType, title, draft: draftFields },
    transport: 'stub',
  });
  const r = db.prepare(`INSERT INTO scribe_drafts
    (tenant_id, draft_type, title, body, payload_json, source)
    VALUES (?, ?, ?, ?, ?, 'scribe')`)
    .run(tenantId, draftType, title, body || '', payload);
  return Number(r.lastInsertRowid);
}

test('approving an email draft creates a campaign in the Email tab, sends nothing', async () => {
  const { c, tenantId } = await register('email@example.org');
  const id = insertDraft(tenantId, 'email_campaign', 'Spring Outreach',
    { subject: 'Hello spring', audience: 'individual', outline: 'Introduce the offer.' },
    'Subject: Hello spring');
  const r = await c.post(`/api/scribe/drafts/${id}/status`, { status: 'approved' });
  assert.equal(r.status, 200);
  assert.equal(r.json.carried.kind, 'email_campaign');
  const camps = await c.get('/api/email/campaigns');
  const mine = camps.json.campaigns.filter(x => x.name === 'Spring Outreach');
  assert.equal(mine.length, 1, 'campaign exists in the Email tab');
  assert.equal(mine[0].sent || 0, 0, 'nothing was sent');
  const after = await c.get('/api/scribe/drafts?status=approved');
  assert.equal(after.json.drafts[0].payload.carried_to, 'email_campaign', 'destination recorded on the draft');
});

test('approving a video brief parks it in My Videos as a brief, generates nothing', async () => {
  const { c, tenantId } = await register('video@example.org');
  const id = insertDraft(tenantId, 'video_brief', 'Film the Promo',
    { hook: 'Open on the problem', outline: 'Problem, product, call.', platform: 'youtube', product: 'manna' },
    'Hook: Open on the problem');
  const r = await c.post(`/api/scribe/drafts/${id}/status`, { status: 'approved' });
  assert.equal(r.status, 200);
  assert.equal(r.json.carried.kind, 'video_job');
  const jobs = await c.get('/api/videos/jobs');
  const mine = jobs.json.jobs.filter(j => (j.script || '').includes('BRIEF (not started)'));
  assert.equal(mine.length, 1, 'brief waits in My Videos');
  assert.equal(mine[0].status, 'queued', 'parked, not processing');
  const row = db.prepare('SELECT provider, provider_job_id FROM video_jobs WHERE tenant_id = ?').get(tenantId);
  assert.equal(row.provider, 'scribe');
  assert.ok(!row.provider_job_id, 'no generation was started');
});

test('approving a social post carries the copy only, posts nothing', async () => {
  const { c, tenantId } = await register('social@example.org');
  const id = insertDraft(tenantId, 'social_post', 'Launch Post',
    { platform: 'instagram', copy: 'We are live.' }, 'Platform: instagram\nWe are live.');
  const r = await c.post(`/api/scribe/drafts/${id}/status`, { status: 'approved' });
  assert.equal(r.status, 200);
  assert.equal(r.json.carried.kind, 'decided_copy');
  const camps = await c.get('/api/email/campaigns');
  assert.equal(camps.json.campaigns.length, 0, 'no stray campaign created');
  const jobs = await c.get('/api/videos/jobs');
  assert.equal(jobs.json.jobs.length, 0, 'no stray video job created');
});

test('dismissing a draft carries nothing anywhere', async () => {
  const { c, tenantId } = await register('dismiss@example.org');
  const id = insertDraft(tenantId, 'email_campaign', 'Nope Campaign',
    { subject: 'x', audience: 'individual', outline: 'y' }, 'Subject: x');
  const r = await c.post(`/api/scribe/drafts/${id}/status`, { status: 'dismissed' });
  assert.equal(r.status, 200);
  assert.equal(r.json.carried, null);
  const camps = await c.get('/api/email/campaigns');
  assert.equal(camps.json.campaigns.length, 0);
});

test('the follow-up batch OK carries its approved drafts too', async () => {
  const { c, tenantId } = await register('batch@example.org');
  // A stored analysis + its draft + a pending follow-up over it.
  const { db: rawDb } = require('../src/db');
  const analysisId = 'batch-analysis-1';
  rawDb.prepare(`INSERT INTO scribe_analyses (id, tenant_id, mode, transport, advice_json, signals_json, expires_at)
    VALUES (?, ?, 'stub', 'stub', ?, '{}', '2999-01-01T00:00:00.000Z')`)
    .run(analysisId, tenantId, JSON.stringify({
      summary: 's', observations: [{ text: 'One send recorded', metrics: { sent: 1 } }],
      recommendations: [{ type: 'email_campaign', title: 'Batch Mail', rationale: 'r', draft: { subject: 'B', audience: 'individual', outline: 'o' } }],
    }));
  const created = await c.post('/api/scribe/drafts', { analysis_id: analysisId });
  assert.equal(created.status, 201);
  const fu = rawDb.prepare(`INSERT INTO scribe_followups
    (tenant_id, event_type, event_ref, summary, direction, analysis_id, next_move, drafts_count, questions_json)
    VALUES (?, 'send', 'x', 'A send happened', 'up', ?, 'Send the batch mail', 1, '[]')`)
    .run(tenantId, analysisId);
  const fuId = Number(fu.lastInsertRowid);
  const dec = await c.post(`/api/scribe/followups/${fuId}/decide`, { decision: 'approved' });
  assert.equal(dec.status, 200);
  assert.equal(dec.json.drafts_decided, 1);
  const camps = await c.get('/api/email/campaigns');
  assert.equal(camps.json.campaigns.filter(x => x.name === 'Batch Mail').length, 1, 'batch approval carried the draft');
});
