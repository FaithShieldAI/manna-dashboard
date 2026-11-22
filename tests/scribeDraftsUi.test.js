'use strict';
/**
 * Scribe Drafts visibility (2026-11-22): the owner asked Scribe "where
 * are my scribe drafts" and got deflected, because (a) no screen in the
 * dashboard ever listed the drafts and (b) the assistant had no drafts
 * in its context and routed the word "draft" to the copy-writing
 * branch. These tests pin both halves of the fix:
 *  - the dashboard template carries the Scribe Drafts list wired to
 *    the drafts API (list + approve/dismiss),
 *  - the assistant answers the location question from real data,
 *    including the bare follow-up "where are they located",
 *  - a genuine write request ("draft me an email") still routes to
 *    the writing branch.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

const { db } = require('../src/db');

const PW = 'drafts-ui-' + 'pw-1234';

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

async function registerWithDrafts(email) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Drafts Co ' + email, email, password: PW,
  });
  assert.equal(r.status, 201);
  const tenantId = r.json.tenant.id;
  const ins = db.prepare(`INSERT INTO scribe_drafts
    (tenant_id, draft_type, title, body, payload_json, source)
    VALUES (?, ?, ?, ?, '{}', 'scribe')`);
  ins.run(tenantId, 'video_brief', 'Film Manna Promo Video', 'Hook: film it.');
  ins.run(tenantId, 'email_campaign', 'New Email Campaign for Email Collection', 'Subject: Boost.');
  return { c, tenantId };
}

test('template carries the Scribe Drafts list wired to the drafts API', () => {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard-template.html'), 'utf8');
  assert.ok(tpl.includes('id="scribe-drafts-block"'), 'drafts block present');
  assert.ok(tpl.includes('id="scribe-drafts-list"'), 'drafts list present');
  assert.ok(tpl.includes('/api/scribe/drafts?status=draft'), 'list fetch present');
  assert.ok(tpl.includes('data-draft-decide'), 'approve/dismiss buttons present');
  assert.ok(tpl.includes('listed right below this chat'), 'creation message names the location');
});

test('assistant answers "where are my scribe drafts" from real data', async () => {
  const { c } = await registerWithDrafts('where@example.org');
  const r = await c.post('/api/assistant/chat', { message: 'where are my scribe drafts' });
  assert.equal(r.status, 200);
  assert.ok(r.json.reply.includes('Film Manna Promo Video'), 'names first draft');
  assert.ok(r.json.reply.includes('New Email Campaign for Email Collection'), 'names second draft');
  assert.ok(r.json.reply.includes('directly under this chat'), 'names the real location');
  assert.ok(!r.json.reply.includes('Happy to write it'), 'no copy-writing deflection');
});

test('assistant answers the bare follow-up "where are they located" after a drafts exchange', async () => {
  const { c } = await registerWithDrafts('followup@example.org');
  const history = [
    { role: 'user', content: 'where are my scribe drafts' },
    { role: 'assistant', content: 'You have 2 Scribe draft(s) waiting.' },
  ];
  const r = await c.post('/api/assistant/chat', { message: 'where are they located', history });
  assert.equal(r.status, 200);
  assert.ok(r.json.reply.includes('Scribe Drafts list'), 'answers with the drafts location');
  assert.ok(r.json.reply.includes('Film Manna Promo Video'), 'names a waiting draft');
});

test('a real write request still routes to the writing branch', async () => {
  const { c } = await registerWithDrafts('write@example.org');
  // Note: the word "email" routes to the email-stats branch earlier in
  // the chain (pre-existing behavior), so the write probe avoids it.
  const r = await c.post('/api/assistant/chat', { message: 'write me a draft post about our spring sale' });
  assert.equal(r.status, 200);
  assert.ok(r.json.reply.includes('Happy to write it'), 'writing branch answers');
});

test('drafts list endpoint serves the UI its waiting drafts', async () => {
  const { c } = await registerWithDrafts('list@example.org');
  const r = await c.get('/api/scribe/drafts?status=draft');
  assert.equal(r.status, 200);
  assert.equal(r.json.drafts.length, 2);
  const decided = await c.post(`/api/scribe/drafts/${r.json.drafts[0].id}/status`, { status: 'approved' });
  assert.equal(decided.status, 200);
  const afterDecide = await c.get('/api/scribe/drafts?status=draft');
  assert.equal(afterDecide.json.drafts.length, 1, 'approved draft leaves the waiting list');
});
