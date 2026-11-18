'use strict';
/**
 * Regression tests for the migration-restore door (2026-11-18, Heavy 30
 * audit Part 8). The door is the backup self-heal's restore path:
 *   - RESTORE_ORDER covers every live table and is a valid foreign-key
 *     dependency order against the real schema (parents before
 *     children), so the list cannot silently rot as migrations land.
 *   - refusal paths: wrong token 403, missing confirm 400, unknown
 *     table 400, non-array table 400, and a refused call writes nothing.
 *   - an export/restore round trip replaces table contents exactly:
 *     per-table counts match, row ids and tenant ids are preserved,
 *     cross-table references (funnel_stages, ab_tests) survive, a junk
 *     row present only in the live DB is cleared, and a table absent
 *     from the payload is left untouched.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
process.env.MIGRATION_TOKEN = 'test-migration-token';

const { db } = require('../src/db');
const authRouter = require('../src/routes/auth');
const RESTORE_ORDER = authRouter.RESTORE_ORDER;

let server, base, tenantId;
before(async () => {
  ({ server, base } = await startServer());
  const c = client(base);
  const reg = await c.post('/api/auth/register', {
    companyName: 'Restore QA Tenant',
    email: 'restore-qa@example.org',
    password: 'restore-qa-password-1',
    plan: 'heavy30',
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  tenantId = reg.json.tenant.id;
});
after(async () => { server.close(); });

const door = (token) => `/api/auth/migration-restore/${token}`;
const TOK = process.env.MIGRATION_TOKEN;

// --- Coverage + ordering ----------------------------------------------------

test('RESTORE_ORDER covers every live table exactly once', () => {
  const live = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  ).all().map(x => x.name)
    .filter(n => !n.startsWith('sqlite_') && n !== 'schema_migrations' && !n.endsWith('_new'));
  assert.ok(Array.isArray(RESTORE_ORDER), 'restore door must export RESTORE_ORDER');
  assert.equal(RESTORE_ORDER.length, live.length,
    `order has ${RESTORE_ORDER.length} tables, schema has ${live.length}`);
  assert.equal(new Set(RESTORE_ORDER).size, RESTORE_ORDER.length, 'no duplicates');
  for (const t of live) {
    assert.ok(RESTORE_ORDER.includes(t), `restore order must include live table ${t}`);
  }
  // The engagement set the 2026-11-18 audit found unrestorable:
  for (const t of ['ab_tests', 'social_postings', 'content_postings', 'tenant_usage',
    'drip_campaigns', 'drip_steps', 'drip_enrollments', 'drip_send_log',
    'scheduled_sends', 'funnels', 'funnel_stages', 'scribe_analyses',
    'scribe_drafts', 'scribe_followups', 'video_jobs', 'facebook_pages']) {
    assert.ok(RESTORE_ORDER.includes(t), `restore order must include ${t}`);
  }
});

test('RESTORE_ORDER is a valid FK dependency order for the live schema', () => {
  const pos = {};
  RESTORE_ORDER.forEach((t, i) => { pos[t] = i; });
  for (const t of RESTORE_ORDER) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${t})`).all()) {
      assert.ok(pos[fk.table] < pos[t],
        `${t} must come after its parent ${fk.table}`);
    }
  }
});

// --- Refusal paths ------------------------------------------------------------

test('restore refuses without the token, the confirm flag, or a clean payload', async () => {
  const c = client(base);
  const usersBefore = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  const wrongTok = await c.post(door('nope'), { confirm: 'replace-all', data: { tenants: [] } });
  assert.equal(wrongTok.status, 403, JSON.stringify(wrongTok.json));

  const noConfirm = await c.post(door(TOK), { data: { tenants: [] } });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.json.error, 'confirm_required');

  const noData = await c.post(door(TOK), { confirm: 'replace-all' });
  assert.equal(noData.status, 400);
  assert.equal(noData.json.error, 'No data');

  const unknown = await c.post(door(TOK), { confirm: 'replace-all', data: { not_a_table: [] } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error, 'unknown_table:not_a_table');

  const notArray = await c.post(door(TOK), { confirm: 'replace-all', data: { tenants: { id: 1 } } });
  assert.equal(notArray.status, 400);
  assert.equal(notArray.json.error, 'table_not_array:tenants');

  const usersAfter = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  assert.equal(usersAfter, usersBefore, 'a refused restore must write nothing');
});

// --- Round trip ---------------------------------------------------------------

test('export/restore round trip replaces contents and preserves ids and references', async () => {
  const c = client(base);

  // Seed an FK chain the export/restore must carry intact:
  // content_items -> social_postings -> ab_tests, funnels -> funnel_stages.
  const item = db.prepare(
    "INSERT INTO content_items (tenant_id, product, title, file_path) VALUES (?, 'faithshield', 'Restore QA film', '/tmp/restore-qa.mp4')"
  ).run(tenantId);
  const posting = db.prepare(
    "INSERT INTO social_postings (tenant_id, platform, post_url, content_item_id) VALUES (?, 'youtube', 'https://www.youtube.com/watch?v=restoreqa', ?)"
  ).run(tenantId, item.lastInsertRowid);
  const ab = db.prepare(
    "INSERT INTO ab_tests (tenant_id, name, kind, variant_a_post_id) VALUES (?, 'Restore QA test', 'video', ?)"
  ).run(tenantId, posting.lastInsertRowid);
  const funnel = db.prepare(
    "INSERT INTO funnels (tenant_id, funnel_key, name) VALUES (?, 'restore-qa', 'Restore QA funnel')"
  ).run(tenantId);
  const stage = db.prepare(
    "INSERT INTO funnel_stages (funnel_id, stage_key, label) VALUES (?, 'step-1', 'Step 1')"
  ).run(funnel.lastInsertRowid);

  const exp1 = await c.get(`/api/auth/migration-export/${TOK}`);
  assert.equal(exp1.status, 200);
  const snapshot = exp1.json.data;
  const counts1 = {};
  for (const t of RESTORE_ORDER) counts1[t] = snapshot[t].length;

  // Damage the live DB the way a partial wipe would: delete the chain's
  // child rows and add a junk row that exists in no snapshot.
  db.prepare('DELETE FROM ab_tests WHERE id = ?').run(ab.lastInsertRowid);
  db.prepare('DELETE FROM social_postings WHERE id = ?').run(posting.lastInsertRowid);
  const junk = db.prepare(
    "INSERT INTO goals (tenant_id, goal_key, label, goal_value) VALUES (?, 'junk-restore-qa', 'junk', 1)"
  ).run(tenantId);

  const res = await c.post(door(TOK), { confirm: 'replace-all', data: snapshot });
  assert.equal(res.status, 200, JSON.stringify(res.json).slice(0, 300));
  for (const t of RESTORE_ORDER) {
    assert.equal(res.json.results[t].restored, counts1[t], `${t}: restored count`);
  }

  const exp2 = await c.get(`/api/auth/migration-export/${TOK}`);
  assert.equal(exp2.status, 200);
  for (const t of RESTORE_ORDER) {
    assert.equal(exp2.json.data[t].length, counts1[t], `${t}: count after restore`);
  }

  // Ids and references survived: the chain reads back exactly as seeded.
  const abRow = db.prepare('SELECT * FROM ab_tests WHERE id = ?').get(Number(ab.lastInsertRowid));
  assert.ok(abRow, 'ab_tests row restored under its original id');
  assert.equal(abRow.variant_a_post_id, Number(posting.lastInsertRowid));
  const stageRow = db.prepare('SELECT * FROM funnel_stages WHERE id = ?').get(Number(stage.lastInsertRowid));
  assert.ok(stageRow, 'funnel_stages row restored under its original id');
  assert.equal(stageRow.funnel_id, Number(funnel.lastInsertRowid));
  const postingRow = db.prepare('SELECT * FROM social_postings WHERE id = ?').get(Number(posting.lastInsertRowid));
  assert.equal(postingRow.tenant_id, tenantId, 'tenant_id preserved, not force-mapped');

  // Replace semantics: the junk row is gone.
  const junkRow = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(junk.lastInsertRowid));
  assert.equal(junkRow, undefined, 'rows absent from the snapshot are cleared');
});

test('a table absent from the payload is left untouched and reported skipped', async () => {
  const c = client(base);
  const goalsBefore = db.prepare('SELECT COUNT(*) AS n FROM goals').get().n;
  const res = await c.post(door(TOK), {
    confirm: 'replace-all',
    data: { tenants: db.prepare('SELECT * FROM tenants').all() },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json).slice(0, 200));
  assert.equal(res.json.results.goals.skipped, 'not_in_payload');
  const goalsAfter = db.prepare('SELECT COUNT(*) AS n FROM goals').get().n;
  assert.equal(goalsAfter, goalsBefore, 'unlisted tables keep their rows');
});
