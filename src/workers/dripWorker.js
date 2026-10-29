'use strict';
/**
 * Drip worker — polls for due drip steps and sends them.
 *
 * Run:  node src/workers/dripWorker.js [--once] [--tenant <id>]
 *   --once    process one batch and exit (default; cron calls this)
 *   --tenant  restrict to a single tenant id
 *
 * The worker queries the database directly (same DATABASE_PATH as the app)
 * using the same "due" definition as GET /api/drips/due: active enrollments
 * with next_send_at <= now on active campaigns with active steps.
 *
 * Per item:
 *   1. Quota check — tenant plan emails_per_month via src/lib/plans.js
 *      (trial tenants get 100). Over quota -> logged as skipped_quota and
 *      left for the next run; the enrollment is NOT advanced or failed.
 *   2. Template resolution — email_templates for the tenant by template_key.
 *      Missing template -> logged as failed (config error, not retried).
 *   3. Send via src/lib/mailer.js (SES -> stub). campaign =
 *      `drip-<drip_id>`, templateKey = step.template_key (dashboard rule:
 *      every send logs its template_key).
 *   4. Success -> drip_send_log 'sent', tenant_usage +1, enrollment advanced
 *      to the next active step (or 'completed' when no steps remain).
 *   5. Failure -> retry once (next_send_at = now + 1h, send_attempts = 1).
 *      Second failure -> enrollment status 'failed', logged. Nothing is
 *      ever silently dropped: every outcome lands in drip_send_log.
 *
 * Concurrency: single-flight via a lock row in a worker_locks table
 * (created on first run). A stale lock (>15 min) is taken over.
 */
const { db, transaction, migrate } = require('../db');
const { sendMail } = require('../lib/mailer');
const { getPlan, currentMonthKey } = require('../lib/plans');

const LOCK_NAME = 'drip-worker';
const LOCK_TTL_MS = 15 * 60 * 1000;
const RETRY_DELAY_HOURS = 1;

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function hoursFromNow(h) {
  return new Date(Date.now() + h * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(`[drip-worker] ${msg}`);
}

/** Single-flight lock; returns true when this process holds it. */
function acquireLock() {
  db.exec(`CREATE TABLE IF NOT EXISTS worker_locks (
    name TEXT PRIMARY KEY, locked_at TEXT NOT NULL, holder TEXT NOT NULL
  )`);
  const holder = `pid-${process.pid}-${Date.now()}`;
  const now = utcNow();
  const existing = db.prepare('SELECT locked_at, holder FROM worker_locks WHERE name = ?').get(LOCK_NAME);
  if (existing) {
    const age = Date.now() - new Date(existing.locked_at).getTime();
    if (age < LOCK_TTL_MS) {
      log(`lock held by ${existing.holder} (${Math.round(age / 1000)}s old) — exiting`);
      return false;
    }
    log(`stale lock from ${existing.holder} taken over`);
  }
  db.prepare(`INSERT INTO worker_locks (name, locked_at, holder) VALUES (?, ?, ?)
    ON CONFLICT (name) DO UPDATE SET locked_at = excluded.locked_at, holder = excluded.holder`)
    .run(LOCK_NAME, now, holder);
  return true;
}

function releaseLock() {
  try {
    db.prepare('DELETE FROM worker_locks WHERE name = ?').run(LOCK_NAME);
  } catch (e) { /* best effort */ }
}

function getDueEnrollments(tenantFilter) {
  const now = utcNow();
  const tenantClause = tenantFilter ? 'AND de.tenant_id = ?' : '';
  // Placeholder order in the SQL: next_send_at first, tenant_id second.
  const params = tenantFilter ? [now, tenantFilter] : [now];
  return db.prepare(`
    SELECT de.id AS enrollment_id, de.tenant_id, de.drip_id, de.contact_email,
           de.current_step, de.next_send_at, de.send_attempts,
           dc.name AS drip_name, dc.product, dc.language,
           ds.id AS step_id, ds.step_order, ds.delay_hours, ds.template_key, ds.subject,
           t.plan AS tenant_plan, t.subscription_status
    FROM drip_enrollments de
    JOIN drip_campaigns dc ON dc.id = de.drip_id AND dc.tenant_id = de.tenant_id
    JOIN drip_steps ds ON ds.drip_id = de.drip_id AND ds.tenant_id = de.tenant_id
                      AND ds.step_order = de.current_step
    JOIN tenants t ON t.id = de.tenant_id
    WHERE de.status = 'active' AND de.next_send_at <= ?
      AND dc.status = 'active' AND ds.status = 'active'
      ${tenantClause}
    ORDER BY de.next_send_at ASC
  `).all(...params);
}

/** Monthly email usage for a tenant (mirrors src/routes/email.js quota logic). */
function quotaState(tenantId, planKey, subscriptionStatus) {
  const plan = getPlan(planKey) || getPlan('starter');
  const isTrial = subscriptionStatus !== 'active';
  const limit = isTrial ? 100 : plan.emails_per_month;
  const monthKey = currentMonthKey();
  const row = db.prepare(
    'SELECT emails_sent FROM tenant_usage WHERE tenant_id = ? AND month_key = ?'
  ).get(tenantId, monthKey);
  const used = row ? row.emails_sent : 0;
  return { limit, used, monthKey, planKey: plan.key };
}

function recordSend({ tenantId, dripId, enrollmentId, email, templateKey, status, provider, msgId, error, attempt }) {
  db.prepare(`
    INSERT INTO drip_send_log
      (tenant_id, drip_id, enrollment_id, contact_email, template_key,
       status, provider, provider_msg_id, error, attempt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tenantId, dripId, enrollmentId, email, templateKey, status,
    provider || null, msgId || null, error || null, attempt);
}

function addUsage(tenantId, monthKey, count) {
  db.prepare(`
    INSERT INTO tenant_usage (tenant_id, month_key, emails_sent)
    VALUES (?, ?, ?)
    ON CONFLICT (tenant_id, month_key)
    DO UPDATE SET emails_sent = emails_sent + excluded.emails_sent,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .run(tenantId, monthKey, count);
}

function resolveTemplate(tenantId, templateKey) {
  return db.prepare(
    'SELECT subject, body_html, body_text FROM email_templates WHERE tenant_id = ? AND template_key = ?'
  ).get(tenantId, templateKey);
}

/** Advance an enrollment after a successful send. Returns 'completed' or 'advanced'. */
function advanceEnrollment(item) {
  const next = db.prepare(`
    SELECT step_order, delay_hours FROM drip_steps
    WHERE tenant_id = ? AND drip_id = ? AND status = 'active' AND step_order > ?
    ORDER BY step_order ASC LIMIT 1
  `).get(item.tenant_id, item.drip_id, item.current_step);
  if (!next) {
    db.prepare("UPDATE drip_enrollments SET status = 'completed' WHERE id = ?").run(item.enrollment_id);
    return 'completed';
  }
  db.prepare(`
    UPDATE drip_enrollments
    SET current_step = ?, next_send_at = ?, send_attempts = 0
    WHERE id = ?
  `).run(next.step_order, hoursFromNow(next.delay_hours), item.enrollment_id);
  return 'advanced';
}

async function processItem(item) {
  const attempt = (item.send_attempts || 0) + 1;
  const label = `tenant=${item.tenant_id} drip=${item.drip_id} to=${item.contact_email} step=${item.current_step} template=${item.template_key}`;

  // 1) Quota gate — never exceed the tenant's monthly email limit.
  const quota = quotaState(item.tenant_id, item.tenant_plan, item.subscription_status);
  if (quota.limit != null && quota.used >= quota.limit) {
    recordSend({
      tenantId: item.tenant_id, dripId: item.drip_id, enrollmentId: item.enrollment_id,
      email: item.contact_email, templateKey: item.template_key,
      status: 'skipped_quota', attempt,
      error: `quota ${quota.used}/${quota.limit} (${quota.planKey})`,
    });
    log(`SKIP quota ${label} used=${quota.used}/${quota.limit}`);
    return 'skipped_quota';
  }

  // 2) Template resolution.
  const tpl = resolveTemplate(item.tenant_id, item.template_key);
  if (!tpl) {
    recordSend({
      tenantId: item.tenant_id, dripId: item.drip_id, enrollmentId: item.enrollment_id,
      email: item.contact_email, templateKey: item.template_key,
      status: 'failed', attempt, error: 'template_not_found',
    });
    db.prepare("UPDATE drip_enrollments SET status = 'failed' WHERE id = ?").run(item.enrollment_id);
    log(`FAIL template_not_found ${label} — enrollment marked failed`);
    return 'failed';
  }
  const subject = item.subject || tpl.subject || `Step ${item.current_step + 1}: ${item.drip_name}`;

  // 3) Send.
  try {
    const result = await sendMail({
      to: item.contact_email,
      subject,
      text: tpl.body_text || '',
      html: tpl.body_html || '',
      campaign: `drip-${item.drip_id}`,
      templateKey: item.template_key,
    });
    const provider = result.stubbed ? 'stub' : 'ses';
    transaction(() => {
      recordSend({
        tenantId: item.tenant_id, dripId: item.drip_id, enrollmentId: item.enrollment_id,
        email: item.contact_email, templateKey: item.template_key,
        status: 'sent', provider, msgId: result.id, attempt,
      });
      addUsage(item.tenant_id, quota.monthKey, 1);
      advanceEnrollment(item);
    });
    log(`SENT ${label} via=${provider} id=${result.id}`);
    return 'sent';
  } catch (e) {
    const errMsg = String(e && e.message ? e.message : e).slice(0, 300);
    if (attempt < 2) {
      // Retry once: push the send out an hour, keep it active.
      transaction(() => {
        recordSend({
          tenantId: item.tenant_id, dripId: item.drip_id, enrollmentId: item.enrollment_id,
          email: item.contact_email, templateKey: item.template_key,
          status: 'failed', attempt, error: `${errMsg} (retry scheduled)`,
        });
        db.prepare('UPDATE drip_enrollments SET send_attempts = ?, next_send_at = ? WHERE id = ?')
          .run(attempt, hoursFromNow(RETRY_DELAY_HOURS), item.enrollment_id);
      });
      log(`RETRY scheduled ${label} attempt=${attempt} error=${errMsg}`);
      return 'retry';
    }
    // Second failure: mark failed. It stays visible in drip_send_log and the
    // enrollment status — never silently dropped.
    transaction(() => {
      recordSend({
        tenantId: item.tenant_id, dripId: item.drip_id, enrollmentId: item.enrollment_id,
        email: item.contact_email, templateKey: item.template_key,
        status: 'failed', attempt, error: errMsg,
      });
      db.prepare("UPDATE drip_enrollments SET status = 'failed', send_attempts = ? WHERE id = ?")
        .run(attempt, item.enrollment_id);
    });
    log(`FAIL ${label} attempt=${attempt} error=${errMsg} — enrollment marked failed`);
    return 'failed';
  }
}

async function main() {
  const args = process.argv.slice(2);
  const tenantArg = args.indexOf('--tenant');
  const tenantFilter = tenantArg >= 0 ? parseInt(args[tenantArg + 1], 10) : null;
  if (tenantArg >= 0 && !Number.isInteger(tenantFilter)) {
    log('invalid --tenant id');
    process.exitCode = 2;
    return;
  }
  if (!acquireLock()) {
    process.exitCode = 0;
    return;
  }
  try {
    // The server runs migrations on boot; the cron worker must do the same
    // so drip tables exist even when the server has never started this DB.
    migrate();
    const due = getDueEnrollments(tenantFilter);
    log(`found ${due.length} due enrollment(s)${tenantFilter ? ` for tenant ${tenantFilter}` : ''}`);
    const counts = { sent: 0, retry: 0, failed: 0, skipped_quota: 0 };
    for (const item of due) {
      try {
        const outcome = await processItem(item);
        counts[outcome] = (counts[outcome] || 0) + 1;
      } catch (e) {
        log(`UNEXPECTED error on enrollment ${item.enrollment_id}: ${e.message}`);
      }
    }
    log(`done: ${JSON.stringify(counts)}`);
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  main().catch(e => {
    // eslint-disable-next-line no-console
    console.error(`[drip-worker] fatal: ${e.stack || e.message}`);
    try { releaseLock(); } catch (_) { /* best effort */ }
    process.exitCode = 1;
  });
}

module.exports = { processItem, getDueEnrollments, quotaState };
