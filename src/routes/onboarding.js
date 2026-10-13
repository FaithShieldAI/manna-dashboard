'use strict';
/**
 * Guided onboarding API.
 *
 *   GET  /api/onboarding/status
 *   POST /api/onboarding/welcome          (mark the tour seen)
 *   POST /api/onboarding/dismiss         (skip setup entirely)
 *   POST /api/onboarding/restart         (start over)
 *
 *   GET    /api/onboarding/socials
 *   POST   /api/onboarding/socials        { platform, handle, access_token?, refresh_token?, expires_at? }
 *   DELETE /api/onboarding/socials/:platform
 *
 *   GET  /api/onboarding/templates
 *   POST /api/onboarding/templates/install       { email?: [keys], social?: [keys] }
 *   POST /api/onboarding/templates/install-all
 *
 * All auth-required, tenant-scoped. Social tokens are encrypted with
 * AES-256-GCM (src/lib/socialTokens.js) before they touch the database.
 * Full OAuth per platform is a later milestone — v1 accepts a handle plus
 * an optional API token, which is enough to unblock setup.
 */
const express = require('express');
const onboarding = require('../lib/onboarding');
const socialTokens = require('../lib/socialTokens');
const starter = require('../lib/starterTemplates');

const router = express.Router();

const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x', 'facebook'];

function statusPayload(tdb) {
  return { ok: true, onboarding: onboarding.getStatus(tdb) };
}

// --- checklist state -------------------------------------------------------
router.get('/status', (req, res) => {
  res.json(statusPayload(req.tdb));
});

router.post('/welcome', (req, res) => {
  req.tdb.markWelcomeSeen();
  res.json(statusPayload(req.tdb));
});

router.post('/dismiss', (req, res) => {
  req.tdb.dismissOnboarding();
  res.json(statusPayload(req.tdb));
});

router.post('/restart', (req, res) => {
  req.tdb.restartOnboarding();
  res.json(statusPayload(req.tdb));
});

// --- socials ---------------------------------------------------------------
router.get('/socials', (req, res) => {
  // Never returns token material — only a has_token flag.
  res.json({ ok: true, socials: req.tdb.listConnectedSocials() });
});

router.post('/socials', (req, res) => {
  const { platform, handle, access_token, refresh_token, expires_at } = req.body || {};

  if (!PLATFORMS.includes(platform)) {
    return res.status(400).json({ ok: false, error: 'invalid_platform', valid: PLATFORMS });
  }
  let h = String(handle || '').trim().replace(/^@+/, '');
  if (h.length < 1 || h.length > 80) {
    return res.status(400).json({ ok: false, error: 'invalid_handle' });
  }
  // Handles are identifiers, not free text — keep the alphabet tight.
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(h)) {
    return res.status(400).json({ ok: false, error: 'invalid_handle_chars' });
  }

  let accessEnc = null;
  let refreshEnc = null;
  try {
    if (access_token !== undefined && access_token !== null && String(access_token) !== '') {
      const at = String(access_token);
      if (at.length > 4000) return res.status(400).json({ ok: false, error: 'token_too_long' });
      accessEnc = socialTokens.encryptToken(at);
    }
    if (refresh_token !== undefined && refresh_token !== null && String(refresh_token) !== '') {
      const rt = String(refresh_token);
      if (rt.length > 4000) return res.status(400).json({ ok: false, error: 'token_too_long' });
      refreshEnc = socialTokens.encryptToken(rt);
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'token_encrypt_failed' });
  }

  let expiresAt = null;
  if (expires_at !== undefined && expires_at !== null && String(expires_at) !== '') {
    const d = new Date(String(expires_at));
    if (Number.isNaN(d.getTime())) {
      return res.status(400).json({ ok: false, error: 'invalid_expires_at' });
    }
    expiresAt = d.toISOString();
  }

  req.tdb.upsertConnectedSocial({
    platform, handle: h, accessTokenEnc: accessEnc, refreshTokenEnc: refreshEnc, expiresAt,
  });
  // Mirror into social_accounts so the dashboard's Social tab shows it.
  req.tdb.upsertSocialAccount({ platform, handle: h });

  const socials = req.tdb.listConnectedSocials();
  const mine = socials.find(s => s.platform === platform);
  res.status(201).json({ ok: true, social: mine, onboarding: onboarding.getStatus(req.tdb) });
});

router.delete('/socials/:platform', (req, res) => {
  const platform = String(req.params.platform || '').toLowerCase();
  if (!PLATFORMS.includes(platform)) {
    return res.status(400).json({ ok: false, error: 'invalid_platform', valid: PLATFORMS });
  }
  const r = req.tdb.deleteConnectedSocial(platform);
  if (!r.changes) {
    return res.status(404).json({ ok: false, error: 'social_not_found' });
  }
  res.json({ ok: true, onboarding: onboarding.getStatus(req.tdb) });
});

// --- starter templates -------------------------------------------------------
router.get('/templates', (req, res) => {
  res.json({
    ok: true,
    library: {
      email: starter.EMAIL_TEMPLATES.map(t => ({
        key: t.key, name: t.name, category: t.category,
        subject: t.subject, body_text: t.body_text, body_html: t.body_html,
      })),
      social: starter.SOCIAL_TEMPLATES.map(t => ({
        key: t.key, name: t.name, platform: t.platform, content: t.content,
      })),
    },
    installed: {
      email: req.tdb.listEmailTemplates(),
      social: req.tdb.listSocialTemplates(),
    },
  });
});

function installKeys(tdb, emailKeys, socialKeys) {
  let installedEmail = 0;
  let installedSocial = 0;
  for (const key of emailKeys) {
    const t = starter.getEmailTemplate(key);
    if (!t) continue;
    const r = tdb.installEmailTemplate({
      templateKey: t.key, name: t.name, subject: t.subject,
      bodyHtml: t.body_html, bodyText: t.body_text,
      category: t.category, isStarter: true,
    });
    if (r.changes) installedEmail += 1;
  }
  for (const key of socialKeys) {
    const t = starter.getSocialTemplate(key);
    if (!t) continue;
    const r = tdb.installSocialTemplate({
      templateKey: t.key, name: t.name, platform: t.platform, content: t.content,
    });
    if (r.changes) installedSocial += 1;
  }
  return { installedEmail, installedSocial };
}

router.post('/templates/install', (req, res) => {
  const { email, social } = req.body || {};
  if (email !== undefined && !Array.isArray(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email_keys' });
  }
  if (social !== undefined && !Array.isArray(social)) {
    return res.status(400).json({ ok: false, error: 'invalid_social_keys' });
  }
  const emailKeys = (email || []).map(String).slice(0, 50);
  const socialKeys = (social || []).map(String).slice(0, 50);
  if (!emailKeys.length && !socialKeys.length) {
    return res.status(400).json({ ok: false, error: 'no_keys' });
  }
  const { installedEmail, installedSocial } = installKeys(req.tdb, emailKeys, socialKeys);
  res.status(201).json({
    ok: true,
    installed: { email: installedEmail, social: installedSocial },
    onboarding: onboarding.getStatus(req.tdb),
  });
});

router.post('/templates/install-all', (req, res) => {
  const { installedEmail, installedSocial } = installKeys(
    req.tdb,
    starter.EMAIL_TEMPLATES.map(t => t.key),
    starter.SOCIAL_TEMPLATES.map(t => t.key)
  );
  res.status(201).json({
    ok: true,
    installed: { email: installedEmail, social: installedSocial },
    onboarding: onboarding.getStatus(req.tdb),
  });
});

module.exports = router;
