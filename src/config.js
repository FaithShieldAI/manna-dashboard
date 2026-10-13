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

if (config.env === 'production' && config.appBaseUrl && !config.appBaseUrl.startsWith('https://')) {
  throw new Error('[config] APP_BASE_URL must be https:// in production');
}

// Fail fast in production: verification/password-reset emails must actually
// send. Stub mode in production would silently break signup.
if (config.env === 'production' && !config.sesConfigured) {
  throw new Error(
    '[config] SES is not configured: set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, '
    + 'and SES_FROM_EMAIL (AWS_REGION optional, defaults to us-east-1).'
  );
}

module.exports = config;
