'use strict';
/**
 * Centralized environment config with validation.
 *
 * Fails fast at boot on invalid production settings (e.g. missing
 * APP_BASE_URL in production, which would put wrong links in emails).
 * Safe defaults for local development.
 */

function requiredInProduction(name) {
  const v = process.env[name];
  if (process.env.NODE_ENV === 'production' && !v) {
    throw new Error(`[config] ${name} is required when NODE_ENV=production`);
  }
  return v;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  databasePath: process.env.DATABASE_PATH || null, // null -> src/db.js default
  // Public base URL used in emailed links (verification, password reset).
  // MUST be the https production URL in production.
  appBaseUrl: requiredInProduction('APP_BASE_URL') || null,
  // Dashboard template served at /app.
  dashboardHtmlPath: process.env.DASHBOARD_HTML_PATH || null,
  // AI co-pilot: when set, replies are synthesized by Muse.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  assistantModel: process.env.ASSISTANT_MODEL || 'claude-haiku-4-5',
  // --- Scribe (Meta Muse Spark via the Meta Model API) ---
  // Scribe is Manna's performance analyst: it reads the tenant's numbers,
  // returns structured observations + recommendations, and (on approval)
  // turns recommendations into draft artifacts. Provider is Meta's Muse
  // Spark, reached through the OpenAI-compatible Meta Model API.
  // SPARK_API_KEY is the ONLY required value. When it is unset, Scribe runs
  // in stub mode: the full pipeline works and returns clearly-marked sample
  // output, but no network call is made. SPARK_BASE_URL / SPARK_MODEL are
  // overridable so the exact production values can be set at key time
  // without a code change.
  sparkApiKey: process.env.SPARK_API_KEY || null,
  sparkBaseUrl: process.env.SPARK_BASE_URL || 'https://api.meta.ai/v1',
  sparkModel: process.env.SPARK_MODEL || 'muse-spark-1.3',
  // --- Video generation (HeyGen API, pay-as-you-go) ---
  // HEYGEN_API_KEY is the ONLY required value. When it is unset the video
  // feature fails closed (503 heygen_not_configured) — no stub videos are
  // ever fabricated. All provider specifics live in src/lib/videogen.js.
  // HEYGEN_API_BASE is overridable for the same reason SPARK_BASE_URL is.
  heygenApiKey: process.env.HEYGEN_API_KEY || null,
  heygenApiBase: process.env.HEYGEN_API_BASE || 'https://api.heygen.com',
  // --- Amazon SES (transactional email: verification, password reset) ---
  // Region defaults to us-east-1; the access key pair and from-address are
  // required for real sending. When any is missing, mailer.js falls back
  // to the stub (logs + in-memory outbox, zero emails sent).
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID || null,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || null,
  sesFromEmail: process.env.SES_FROM_EMAIL || null,
};

config.sesConfigured = Boolean(
  config.awsAccessKeyId && config.awsSecretAccessKey && config.sesFromEmail
);

config.scribeConfigured = Boolean(config.sparkApiKey);

config.heygenConfigured = Boolean(config.heygenApiKey);

if (config.env === 'production' && config.appBaseUrl && !config.appBaseUrl.startsWith('https://')) {
  throw new Error('[config] APP_BASE_URL must be https:// in production');
}

// Mail boot rule (audit B4, revised 2026-10-29): production requires the
// SES trio — SES is Manna's ONLY mail provider. An earlier B4 revision also
// accepted BREVO_API_KEY as an alternative; Michael then decided Brevo is
// eliminated from Manna entirely (Brevo = D2RM contact storage + appeal
// only, never a Manna dependency), so the Brevo alternative was removed.
// Neither SES in production = boot failure; non-production gets a loud
// stub warning instead.
config.mailConfigured = config.sesConfigured;

// Fail fast in production: verification/password-reset emails must actually
// send. Stub mode in production would silently break signup.
if (config.env === 'production' && !config.mailConfigured) {
  throw new Error(
    '[config] No transactional mail provider is configured: set the SES trio '
    + '(AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, SES_FROM_EMAIL).'
  );
}
if (config.env !== 'production' && !config.mailConfigured) {
  // eslint-disable-next-line no-console
  console.warn(
    '[config] WARNING: no mail provider configured (SES trio) — '
    + 'transactional mail is STUBBED: logged and kept in an in-memory outbox, never sent.'
  );
}

module.exports = config;
