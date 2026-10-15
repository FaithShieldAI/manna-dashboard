'use strict';
/**
 * Sync REAL D2RM data into a Manna tenant account (CLI).
 *
 * Replaces demo/seed data with Michael's actual D2RM numbers.
 *
 * Usage:
 *   node scripts/sync-d2rm-data.js --email michael@faithshield.ai
 *   node scripts/sync-d2rm-data.js --email leon@faithshield.ai
 *   node scripts/sync-d2rm-data.js --email michael@faithshield.ai \
 *     --source-db /path/to/email-database.db
 *
 *   DATABASE_PATH=/tmp/test-manna.db node scripts/sync-d2rm-data.js \
 *     --email test@example.com   # test against disposable DB
 *
 * Exit codes: 0 = ok, 1 = usage/config error, 2 = sync error.
 *
 * The sync core lives in src/lib/syncD2rm.js so the HTTP endpoint
 * (src/routes/admin.js) can reuse it.
 */
const path = require('path');

function parseArgs(argv) {
  const out = { email: null, sourceDb: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--email' && argv[i + 1]) out.email = argv[++i];
    else if (argv[i] === '--source-db' && argv[i + 1]) out.sourceDb = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/sync-d2rm-data.js --email <user-email> [--source-db <path>]');
      process.exit(0);
    }
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.email) {
  console.error('[sync] --email is required');
  process.exit(1);
}
const USER_EMAIL = args.email.toLowerCase().trim();

const DEFAULT_SOURCE_DB = path.join(
  process.env.HOME,
  'workspace/goals/faithshield-and-angel-warriors-marketing-funnels/hidden_files/email-database.db'
);
const SOURCE_DB_PATH = args.sourceDb || process.env.D2RM_SOURCE_DB || DEFAULT_SOURCE_DB;

const { unscoped, migrate } = require('../src/db');
const { syncD2rmData, resolveTenantForEmail } = require('../src/lib/syncD2rm');

function main() {
  console.log(`[sync] source: ${SOURCE_DB_PATH}`);
  console.log(`[sync] target: ${process.env.DATABASE_PATH || '(default local DB)'}`);
  console.log(`[sync] user: ${USER_EMAIL}`);

  migrate();

  const { tenantId, tenant, created } = resolveTenantForEmail(unscoped, USER_EMAIL);
  if (created) {
    console.log(`[sync] no user for ${USER_EMAIL} — created tenant "${tenant.name}" (id=${tenantId}, slug=${tenant.slug})`);
    console.log(`[sync] NOTE: ${USER_EMAIL} must sign up to claim this tenant.`);
  } else {
    console.log(`[sync] user ${USER_EMAIL} -> tenant "${tenant.name}" (id=${tenantId}, slug=${tenant.slug})`);
  }

  const result = syncD2rmData({ sourceDbPath: SOURCE_DB_PATH, tenantId });

  console.log(`[sync] influencers: ${result.contacts.inserted} inserted, ${result.contacts.updated} updated, ${result.contacts.skipped} skipped (no email)`);
  console.log(`[sync] by category: ${JSON.stringify(result.contacts.byCategory)}`);
  console.log(`[sync] campaigns: ${result.campaigns.inserted} inserted, ${result.campaigns.updated} updated`);
  console.log(`[sync] snapshots: ${result.snapshots.upserted} upserted (24h/7d/30d/all)`);
  console.log(`[sync] goals: ${result.goalsUpserted} upserted (email_collection=${result.liveContactCount})`);
  console.log('[sync] done.');
  console.log(JSON.stringify(result, null, 2));
}

try {
  main();
} catch (e) {
  console.error('[sync] FATAL:', e.message);
  process.exit(2);
}
