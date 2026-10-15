'use strict';
/**
 * Email templates dashboard tests.
 *  - GET /api/email/templates lists installed templates (tenant-scoped, with preview)
 *  - GET /api/email/templates/:key returns full content for copy/use
 *  - invalid key -> 400, unknown key -> 404
 *  - tenant isolation: templates never leak across tenants
 *  - empty state: fresh tenant gets an empty list
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

async function register(email, company) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: company || ('Tpl Co ' + email), email, password: 'tpl-secret-1234',
  });
  assert.equal(r.status, 201);
  return c;
}

test('empty tenant gets empty template list', async () => {
  const c = await register('tpl-empty@example.org');
  const r = await c.get('/api/email/templates');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.templates, []);
});

test('installed templates appear with name, subject, preview', async () => {
  const c = await register('tpl-inst@example.org');
  const inst = await c.post('/api/onboarding/templates/install', { email: ['welcome-1', 'launch'], social: [] });
  assert.equal(inst.status, 201);

  const r = await c.get('/api/email/templates');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.templates.length, 2);

  const keys = r.json.templates.map(t => t.template_key).sort();
  assert.deepEqual(keys, ['launch', 'welcome-1']);

  const w = r.json.templates.find(t => t.template_key === 'welcome-1');
  assert.ok(w.name && w.name.length > 0, 'name present');
  assert.ok(w.subject && w.subject.length > 0, 'subject present');
  assert.ok(typeof w.preview === 'string' && w.preview.length > 0, 'preview present');
  assert.equal(w.is_starter, true);
  // preview must not leak the full body
  assert.ok(w.preview.length <= 160, 'preview is truncated');
  assert.ok(!('body_text' in w) && !('body_html' in w), 'no full body in list');
});

test('template detail returns full content for copy/use', async () => {
  const c = await register('tpl-detail@example.org');
  await c.post('/api/onboarding/templates/install', { email: ['welcome-1'], social: [] });

  const r = await c.get('/api/email/templates/welcome-1');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.template.template_key, 'welcome-1');
  assert.ok(r.json.template.subject && r.json.template.subject.length > 0);
  assert.ok(r.json.template.body_text && r.json.template.body_text.length > 0, 'body_text present for copy');
});

test('invalid key -> 400, unknown key -> 404', async () => {
  const c = await register('tpl-err@example.org');
  const bad = await c.get('/api/email/templates/' + encodeURIComponent('../x'));
  assert.equal(bad.status, 400);
  assert.equal(bad.json.ok, false);

  const missing = await c.get('/api/email/templates/no-such-template');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.ok, false);
});

test('templates are tenant-isolated', async () => {
  const a = await register('tpl-tenant-a@example.org');
  const b = await register('tpl-tenant-b@example.org');
  await a.post('/api/onboarding/templates/install', { email: ['welcome-1'], social: [] });

  const ra = await a.get('/api/email/templates');
  const rb = await b.get('/api/email/templates');
  assert.equal(ra.json.templates.length, 1);
  assert.deepEqual(rb.json.templates, [], 'tenant B sees nothing');

  const cross = await b.get('/api/email/templates/welcome-1');
  assert.equal(cross.status, 404, 'tenant B cannot fetch tenant A template by key');
});

test('unauthenticated requests are rejected', async () => {
  const anon = client(base);
  const r = await anon.get('/api/email/templates');
  assert.equal(r.status, 401);
});
