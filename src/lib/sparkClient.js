'use strict';
/**
 * Meta Model API client for Muse Spark (OpenAI-compatible chat completions).
 *
 * This is the single plug-in point for Scribe's live intelligence:
 *   1. Set SPARK_API_KEY (Render env) — optionally SPARK_BASE_URL /
 *      SPARK_MODEL if Meta's production values differ from the defaults
 *      in src/config.js.
 *   2. Restart. Nothing else changes: with a key, Scribe calls Spark;
 *      without one, Scribe runs in stub mode (see src/lib/scribe.js).
 *
 * Fail-closed by design: every failure throws a SparkError with a stable
 * `code`; callers must treat a throw as "no advice", never invent output.
 * The API key is NEVER logged, returned, or included in error messages.
 */

const config = require('../config');

/**
 * Transport declaration: this client IS the live Meta Model API path.
 * Scribe stamps draft provenance from the producing client's declared
 * transport (see src/lib/scribe.js); this declaration is what earns this
 * client's output the 'scribe' (genuine live) stamp. An injected client
 * that declares nothing is treated as 'substituted' — never as live.
 */
const TRANSPORT = 'spark-api';

class SparkError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SparkError';
    this.code = code;
  }
}

function isConfigured() {
  return Boolean(config.sparkApiKey);
}

/**
 * One chat completion. Returns the assistant message content (string).
 * Throws SparkError on: not configured, timeout, network failure,
 * non-2xx response, or a response with no usable content.
 */
async function chatCompletion({ system, user, maxTokens = 1500, temperature = 0.3 } = {}) {
  if (!isConfigured()) {
    throw new SparkError('spark_not_configured', 'SPARK_API_KEY is not set; Scribe is in stub mode.');
  }
  if (typeof user !== 'string' || !user.trim()) {
    throw new SparkError('spark_bad_request', 'chatCompletion requires a non-empty user prompt.');
  }

  const url = `${String(config.sparkBaseUrl).replace(/\/+$/, '')}/chat/completions`;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 30000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.sparkApiKey}`,
      },
      body: JSON.stringify({
        model: config.sparkModel,
        max_tokens: maxTokens,
        temperature,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
      }),
    });
  } catch (e) {
    const code = e && e.name === 'AbortError' ? 'spark_timeout' : 'spark_network_error';
    throw new SparkError(code, `Spark request failed before a response was received (${code}).`);
  } finally {
    clearTimeout(to);
  }

  if (!res.ok) {
    // Deliberately do not read/echo the body: it may contain request detail
    // we don't want in logs. Status code is enough for diagnosis.
    throw new SparkError(`spark_http_${res.status}`, `Spark API returned HTTP ${res.status}.`);
  }

  let j;
  try {
    j = await res.json();
  } catch (e) {
    throw new SparkError('spark_bad_response', 'Spark API returned a non-JSON response.');
  }
  const content = j && j.choices && j.choices[0] && j.choices[0].message
    ? j.choices[0].message.content
    : null;
  if (typeof content !== 'string' || !content.trim()) {
    throw new SparkError('spark_bad_response', 'Spark API returned no message content.');
  }
  return content;
}

// The declaration rides on the function itself so the injected-client seam
// in scribe.analyze() reads it the same way it reads any client's.
chatCompletion.transport = TRANSPORT;

module.exports = { chatCompletion, isConfigured, SparkError, TRANSPORT };
