'use strict';
/**
 * Email API — windowed aggregates (EMAIL_WINDOWS equivalent) + campaigns.
 * GET /api/email/windows
 * GET /api/email/campaigns            (now with ROI per campaign)
 * GET /api/email/templates           (installed templates, tenant-scoped)
 * GET /api/email/templates/:key      (full template content for copy/use)
 * POST /api/email/log-send           (metering choke point: enforces the
 *                                     plan's monthly email quota; delivery
 *                                     itself is stubbed in this build)
 */
const express = require('express');
const { roi } = require('../lib/roi');
const { getPlan, currentMonthKey } = require('../lib/plans');
const { transaction } = require('../db');
const mailer = require('../lib/mailer');

const router = express.Router();

router.get('/windows', (req, res) => {
  const rows = req.tdb.emailSnapshots();
  const windows = {};
  for (const r of rows) {
    let warmByLang = {};
    try { warmByLang = JSON.parse(r.warm_by_lang_json || '{}'); } catch (e) { /* keep {} */ }
    const openRate = r.sent > 0 ? +(100 * r.opens / r.sent).toFixed(1) : 0;
    const clickRate = r.sent > 0 ? +(100 * r.clicks / r.sent).toFixed(1) : 0;
    const optoutRate = r.sent > 0 ? +(100 * r.unsubs / r.sent).toFixed(2) : 0;
    windows[r.window_key] = {
      sent: r.sent, opens: r.opens, clicks: r.clicks,
      unsubs: r.unsubs, bounces: r.bounces,
      open_rate: openRate, click_rate: clickRate, optout_rate: optoutRate,
      warm: { total: r.warm_total, by_lang: warmByLang },
      captured_at: r.captured_at,
    };
  }
  res.json({ ok: true, windows });
});

router.get('/campaigns', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const campaigns = req.tdb.emailCampaigns(limit).map(c => ({
    ...c,
    ...roi(c.cost_cents, c.revenue_cents),
  }));
  res.json({ ok: true, campaigns });
});

// POST /api/email/campaigns { name, provider? }
// Creates a campaign row so the customer can track it from day one
// (onboarding step: "set up your first campaign"). Sends are logged
// separately via /log-send.
router.post('/campaigns', (req, res) => {
  const { name, provider } = req.body || {};
  const n = String(name || '').trim();
  if (n.length < 1 || n.length > 120) {
    return res.status(400).json({ ok: false, error: 'invalid_name' });
  }
  let p = null;
  if (provider !== undefined && provider !== null && String(provider).trim() !== '') {
    p = String(provider).trim().slice(0, 40);
  }
  const r = req.tdb.createEmailCampaign({ name: n, provider: p });
  const created = req.tdb.emailCampaigns(200).find(c => c.id === Number(r.lastInsertRowid));
  res.status(201).json({ ok: true, campaign: created ? { ...created, ...roi(created.cost_cents, created.revenue_cents) } : null });
});

// POST /api/email/log-send { count, campaign_id? }
// Records metered email sends against the plan quota. Delivery is NOT
// performed here (stubbed) — this is the accounting choke point so the
// $29.99/$89.99 tiers' 5k/20k monthly limits are enforced in one place.
router.post('/log-send', (req, res) => {
  // Trial users get 100 free emails (fishhook — enough to test the full
  // flow). Paid plans get their full quota. (Michael, 2026-10-15)
  const subStatus = req.tenant.subscription_status;
  const isTrial = subStatus !== 'active';
  const plan = getPlan(req.tenant.plan) || getPlan('starter');
  const effectiveLimit = isTrial ? 100 : plan.emails_per_month;
  const count = parseInt(req.body && req.body.count, 10);
  if (!Number.isInteger(count) || count < 1 || count > 100000) {
    return res.status(400).json({ ok: false, error: 'invalid_count' });
  }
  const monthKey = currentMonthKey();
  const used = req.tdb.getUsage(monthKey);
  if (effectiveLimit != null && used + count > effectiveLimit) {
    return res.status(403).json({
      ok: false,
      error: isTrial ? 'trial_email_limit_reached' : 'email_quota_exceeded',
      plan: plan.key,
      limit: effectiveLimit,
      used,
      requested: count,
      remaining: Math.max(0, effectiveLimit - used),
    });
  }
  const { campaign_id } = req.body || {};
  transaction(() => {
    req.tdb.addUsage(monthKey, count);
    if (campaign_id) {
      require('../db').db.prepare(
        'UPDATE email_campaigns SET sent = sent + ? WHERE tenant_id = ? AND id = ?'
      ).run(count, req.tenant.id, parseInt(campaign_id, 10) || 0);
    }
  });
  res.json({
    ok: true,
    logged: count,
    month_key: monthKey,
    used: used + count,
    remaining: effectiveLimit == null ? null : effectiveLimit - (used + count),
    delivery: mailer.isSesConfigured()
      ? { stubbed: false, provider: 'ses', note: 'Sends go through Amazon SES.' }
      : { stubbed: true, provider: 'stub', note: 'SES not configured — sends are logged only. Set AWS keys + SES_FROM_EMAIL to go live.' },
  });
});

// GET /api/email/templates — installed email templates for this tenant
// (installed via onboarding; tenant-scoped by req.tdb)
router.get('/templates', (req, res) => {
  const rows = req.tdb.previewEmailTemplates().map(t => ({
    template_key: t.template_key,
    name: t.name,
    subject: t.subject,
    category: t.category,
    is_starter: !!t.is_starter,
    preview: t.preview || '',
  }));
  res.json({ ok: true, templates: rows });
});

// GET /api/email/templates/:key — full template content (for copy/use)
router.get('/templates/:key', (req, res) => {
  const key = String(req.params.key || '').slice(0, 80);
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
    return res.status(400).json({ ok: false, error: 'invalid_key' });
  }
  const t = req.tdb.getEmailTemplate(key);
  if (!t) return res.status(404).json({ ok: false, error: 'template_not_found' });
  res.json({
    ok: true,
    template: {
      template_key: t.template_key,
      name: t.name,
      subject: t.subject,
      body_html: t.body_html,
      body_text: t.body_text,
      category: t.category,
      is_starter: !!t.is_starter,
    },
  });
});

module.exports = router;
