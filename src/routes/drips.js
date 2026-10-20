'use strict';
/**
 * Drip campaigns + scheduled sends API.
 *
 *   POST   /api/drips              create campaign + steps
 *   GET    /api/drips              list campaigns
 *   GET    /api/drips/due          items due for the worker cron
 *                                    (active enrollments with next_send_at <= now,
 *                                     pending scheduled sends with scheduled_at <= now)
 *   GET    /api/drips/:id          campaign detail (steps + enrollment counts)
 *   PUT    /api/drips/:id          pause / resume / draft  { status }
 *   POST   /api/drips/:id/enroll   { emails: [...] }
 *   POST   /api/drips/scheduled    { campaign_id, scheduled_at }
 *   GET    /api/drips/scheduled    upcoming + recent
 *   DELETE /api/drips/scheduled/:id  cancel a pending send
 *
 * Every query is tenant-scoped via req.tdb.tenantId. Delivery itself is
 * performed by the worker cron; these endpoints only queue / gate the work.
 */
const express = require('express');
const { db, transaction } = require('../db');

const router = express.Router();

const PRODUCTS = ['faithshield', 'armorbearer', 'manna'];
const DRIP_STATUSES = ['active', 'paused', 'draft'];

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// next_send_at = now + delayHours (UTC ISO-8601, fixed width for ordering)
function hoursFromNow(delayHours) {
  const d = new Date(Date.now() + delayHours * 3600 * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e).trim());
}

// ---------------------------------------------------------------------------
// POST /api/drips — create campaign + steps (one transaction)
// Body: { name, product?, language?, audience?, steps: [{ step_order?, delay_hours, template_key, subject? }] }
// ---------------------------------------------------------------------------
router.post('/', (req, res) => {
  const t = req.tdb.tenantId;
  const { name, product, language, audience, steps } = req.body || {};
  const n = String(name || '').trim();
  if (n.length < 1 || n.length > 120) {
    return res.status(400).json({ ok: false, error: 'invalid_name' });
  }
  const prod = PRODUCTS.includes(product) ? product : 'manna';
  const lang = String(language || 'en').slice(0, 5);
  const aud = audience === undefined || audience === null || String(audience).trim() === ''
    ? null : String(audience).trim().slice(0, 60);
  if (!Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ ok: false, error: 'steps_required' });
  }
  const normSteps = steps.map((s, i) => {
    const order = Number.isInteger(s.step_order) && s.step_order >= 0 ? s.step_order : i;
    const delay = Math.max(0, Math.min(87600, Number(s.delay_hours) || 0));
    const tk = String(s.template_key || '').trim().slice(0, 80);
    const subj = s.subject === undefined || s.subject === null ? null
      : String(s.subject).trim().slice(0, 200) || null;
    return { step_order: order, delay_hours: delay, template_key: tk, subject: subj };
  });
  for (const s of normSteps) {
    if (!s.template_key) {
      return res.status(400).json({ ok: false, error: 'template_key_required' });
    }
  }
  const orders = normSteps.map(s => s.step_order);
  if (new Set(orders).size !== orders.length) {
    return res.status(400).json({ ok: false, error: 'duplicate_step_order' });
  }

  const dripId = transaction(() => {
    const r = db.prepare(
      `INSERT INTO drip_campaigns (tenant_id, name, product, language, audience, status)
       VALUES (?, ?, ?, ?, ?, 'draft')`
    ).run(t, n, prod, lang, aud);
    const dripIdLocal = Number(r.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO drip_steps (tenant_id, drip_id, step_order, delay_hours, template_key, subject)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const s of normSteps) {
      ins.run(t, dripIdLocal, s.step_order, s.delay_hours, s.template_key, s.subject);
    }
    return dripIdLocal;
  });
  res.status(201).json({ ok: true, id: dripId });
});

// ---------------------------------------------------------------------------
// GET /api/drips — list campaigns (step + enrollment counts)
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const t = req.tdb.tenantId;
  const rows = db.prepare(`
    SELECT dc.*,
           (SELECT COUNT(*) FROM drip_steps ds
             WHERE ds.tenant_id = dc.tenant_id AND ds.drip_id = dc.id) AS step_count,
           (SELECT COUNT(*) FROM drip_enrollments de
             WHERE de.tenant_id = dc.tenant_id AND de.drip_id = dc.id
               AND de.status = 'active') AS active_enrollments,
           (SELECT COUNT(*) FROM drip_enrollments de
             WHERE de.tenant_id = dc.tenant_id AND de.drip_id = dc.id
               AND de.status = 'completed') AS completed_enrollments
    FROM drip_campaigns dc
    WHERE dc.tenant_id = ?
    ORDER BY dc.id DESC
  `).all(t);
  res.json({ ok: true, drips: rows });
});

// ---------------------------------------------------------------------------
// GET /api/drips/due — worker-cron feed. Defined BEFORE '/:id' so 'due'
// is not swallowed as an id.
// ---------------------------------------------------------------------------
router.get('/due', (req, res) => {
  const t = req.tdb.tenantId;
  const now = utcNow();
  const enrollments = db.prepare(`
    SELECT de.id AS enrollment_id, de.drip_id, de.contact_email, de.current_step,
           de.next_send_at,
           dc.name AS drip_name, dc.product, dc.language, dc.audience,
           ds.id AS step_id, ds.step_order, ds.delay_hours, ds.template_key, ds.subject
    FROM drip_enrollments de
    JOIN drip_campaigns dc ON dc.id = de.drip_id AND dc.tenant_id = de.tenant_id
    JOIN drip_steps ds ON ds.drip_id = de.drip_id AND ds.tenant_id = de.tenant_id
                      AND ds.step_order = de.current_step
    WHERE de.tenant_id = ? AND de.status = 'active' AND de.next_send_at <= ?
      AND dc.status = 'active' AND ds.status = 'active'
    ORDER BY de.next_send_at ASC
  `).all(t, now);
  const scheduled = db.prepare(`
    SELECT ss.id, ss.campaign_id, ss.scheduled_at, ss.created_at,
           ec.name AS campaign_name
    FROM scheduled_sends ss
    LEFT JOIN email_campaigns ec ON ec.id = ss.campaign_id AND ec.tenant_id = ss.tenant_id
    WHERE ss.tenant_id = ? AND ss.status = 'pending' AND ss.scheduled_at <= ?
    ORDER BY ss.scheduled_at ASC
  `).all(t, now);
  res.json({ ok: true, enrollments, scheduled });
});

// ---------------------------------------------------------------------------
// GET /api/drips/:id — detail: campaign, steps, enrollment counts
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const t = req.tdb.tenantId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_id' });
  }
  const drip = db.prepare(
    'SELECT * FROM drip_campaigns WHERE tenant_id = ? AND id = ?'
  ).get(t, id);
  if (!drip) return res.status(404).json({ ok: false, error: 'drip_not_found' });
  const steps = db.prepare(
    'SELECT * FROM drip_steps WHERE tenant_id = ? AND drip_id = ? ORDER BY step_order ASC'
  ).all(t, id);
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS n
    FROM drip_enrollments
    WHERE tenant_id = ? AND drip_id = ?
    GROUP BY status
  `).all(t, id);
  res.json({ ok: true, drip, steps, enrollment_counts: counts });
});

// ---------------------------------------------------------------------------
// PUT /api/drips/:id — pause / resume / draft  { status: 'active'|'paused'|'draft' }
// ---------------------------------------------------------------------------
router.put('/:id', (req, res) => {
  const t = req.tdb.tenantId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_id' });
  }
  const { status } = req.body || {};
  if (!DRIP_STATUSES.includes(status)) {
    return res.status(400).json({ ok: false, error: 'invalid_status' });
  }
  if (status === 'active') {
    const n = db.prepare(
      'SELECT COUNT(*) AS n FROM drip_steps WHERE tenant_id = ? AND drip_id = ? AND status = ?'
    ).get(t, id, 'active');
    if (!n || n.n === 0) {
      return res.status(400).json({ ok: false, error: 'no_active_steps' });
    }
  }
  const r = db.prepare(
    'UPDATE drip_campaigns SET status = ? WHERE tenant_id = ? AND id = ?'
  ).run(status, t, id);
  if (r.changes === 0) return res.status(404).json({ ok: false, error: 'drip_not_found' });
  res.json({ ok: true, id, status });
});

// ---------------------------------------------------------------------------
// POST /api/drips/:id/enroll — { emails: [...] }
// New contacts start at step 0 with next_send_at = now + step0.delay_hours.
// Re-enrolling an existing email re-activates it from step 0.
// ---------------------------------------------------------------------------
router.post('/:id/enroll', (req, res) => {
  const t = req.tdb.tenantId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_id' });
  }
  const drip = db.prepare(
    'SELECT * FROM drip_campaigns WHERE tenant_id = ? AND id = ?'
  ).get(t, id);
  if (!drip) return res.status(404).json({ ok: false, error: 'drip_not_found' });
  if (drip.status !== 'active') {
    return res.status(400).json({ ok: false, error: 'drip_not_active' });
  }
  const step0 = db.prepare(
    'SELECT delay_hours FROM drip_steps WHERE tenant_id = ? AND drip_id = ? AND status = ? ORDER BY step_order ASC LIMIT 1'
  ).get(t, id, 'active');
  if (!step0) return res.status(400).json({ ok: false, error: 'no_active_steps' });

  const raw = (req.body && req.body.emails) || [];
  const list = (Array.isArray(raw) ? raw : [raw])
    .map(e => String(e || '').trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) {
    return res.status(400).json({ ok: false, error: 'emails_required' });
  }
  const unique = [...new Set(list)];
  const invalid = unique.filter(e => !isValidEmail(e));
  if (invalid.length) {
    return res.status(400).json({ ok: false, error: 'invalid_email', invalid });
  }

  const next = hoursFromNow(step0.delay_hours);
  const result = transaction(() => {
    const upsert = db.prepare(`
      INSERT INTO drip_enrollments (tenant_id, drip_id, contact_email, current_step, next_send_at, status)
      VALUES (?, ?, ?, 0, ?, 'active')
      ON CONFLICT (drip_id, contact_email)
      DO UPDATE SET status = 'active', current_step = 0, next_send_at = excluded.next_send_at
    `);
    let count = 0;
    for (const email of unique) {
      upsert.run(t, id, email, next);
      count += 1;
    }
    return count;
  });
  res.json({ ok: true, drip_id: id, enrolled: result });
});

// ---------------------------------------------------------------------------
// POST /api/drips/scheduled — { campaign_id, scheduled_at }
// ---------------------------------------------------------------------------
router.post('/scheduled', (req, res) => {
  const t = req.tdb.tenantId;
  const { campaign_id, scheduled_at } = req.body || {};
  const cid = Number(campaign_id);
  if (!Number.isInteger(cid) || cid <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_campaign_id' });
  }
  const campaign = db.prepare(
    'SELECT id FROM email_campaigns WHERE tenant_id = ? AND id = ?'
  ).get(t, cid);
  if (!campaign) return res.status(404).json({ ok: false, error: 'campaign_not_found' });

  const at = String(scheduled_at || '').trim();
  const parsed = new Date(at);
  if (!at || Number.isNaN(parsed.getTime())) {
    return res.status(400).json({ ok: false, error: 'invalid_scheduled_at' });
  }
  if (parsed.getTime() <= Date.now()) {
    return res.status(400).json({ ok: false, error: 'scheduled_at_in_past' });
  }
  const iso = parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const r = db.prepare(
    `INSERT INTO scheduled_sends (tenant_id, campaign_id, scheduled_at, status)
     VALUES (?, ?, ?, 'pending')`
  ).run(t, cid, iso);
  res.status(201).json({ ok: true, id: Number(r.lastInsertRowid), scheduled_at: iso });
});

// ---------------------------------------------------------------------------
// GET /api/drips/scheduled — pending first, then recent history
// ---------------------------------------------------------------------------
router.get('/scheduled', (req, res) => {
  const t = req.tdb.tenantId;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const rows = db.prepare(`
    SELECT ss.*, ec.name AS campaign_name
    FROM scheduled_sends ss
    LEFT JOIN email_campaigns ec ON ec.id = ss.campaign_id AND ec.tenant_id = ss.tenant_id
    WHERE ss.tenant_id = ?
    ORDER BY CASE WHEN ss.status = 'pending' THEN 0 ELSE 1 END, ss.scheduled_at DESC
    LIMIT ?
  `).all(t, limit);
  res.json({ ok: true, scheduled: rows });
});

// ---------------------------------------------------------------------------
// DELETE /api/drips/scheduled/:id — cancel a pending send
// ---------------------------------------------------------------------------
router.delete('/scheduled/:id', (req, res) => {
  const t = req.tdb.tenantId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_id' });
  }
  const r = db.prepare(
    "UPDATE scheduled_sends SET status = 'cancelled' WHERE tenant_id = ? AND id = ? AND status = 'pending'"
  ).run(t, id);
  if (r.changes === 0) {
    return res.status(404).json({ ok: false, error: 'scheduled_not_found_or_final' });
  }
  res.json({ ok: true, id, status: 'cancelled' });
});

module.exports = router;
