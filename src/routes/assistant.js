'use strict';
/**
 * AI assistant API — the in-product marketing co-pilot.
 *
 *   GET  /api/assistant/status          -> { provider: 'Muse'|'insights', ... }
 *   POST /api/assistant/chat  { message, history? }
 *        -> { ok, reply, provider }
 *
 * Tenant-scoped by construction: the assistant only receives the context
 * snapshot built from req.tdb. Rate-limited tightly (LLM calls cost money
 * when keyed; the insight engine is cheap but still bounded).
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const assistant = require('../lib/assistant');

const router = express.Router();

const chatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 60,                  // 60 messages/hour per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'too_many_requests' },
});

router.get('/status', (req, res) => {
  res.json(assistant.status());
});

router.post('/chat', chatLimiter, async (req, res) => {
  try {
    const { message, history } = req.body || {};
    if (typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ ok: false, error: 'message_required' });
    }
    if (message.length > 2000) {
      return res.status(400).json({ ok: false, error: 'message_too_long', max: 2000 });
    }
    if (history !== undefined && !Array.isArray(history)) {
      return res.status(400).json({ ok: false, error: 'invalid_history' });
    }
    const result = await assistant.chat(message.trim(), req.tdb, history || []);
    res.json({ ok: true, reply: result.reply, provider: result.provider, model: result.model || undefined });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[assistant/chat]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
