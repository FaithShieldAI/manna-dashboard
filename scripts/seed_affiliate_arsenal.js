'use strict';
/**
 * Backfill the affiliate arsenal into EXISTING influencer tenants.
 *
 * The provisioning webhook seeds NEW influencer tenants automatically
 * (src/routes/influencerWebhook.js -> src/lib/arsenalSeed.js). Tenants
 * provisioned BEFORE this feature shipped (e.g. Leon's) are covered by
 * running this script once — it is idempotent, so re-running it (or
 * running it after the webhook already seeded a tenant) inserts 0.
 *
 * Usage:
 *   node scripts/seed_affiliate_arsenal.js [--db <manna.db>]
 *        [--tenant-id N | --tenant-email x@y.z] [--dry-run]
 *
 * Default target set: every tenant with plan='influencer'.
 * DATABASE_PATH is set from --db before src/db is required, exactly
 * like the other scripts in this folder.
 */
const path = require('path');
const fs = require('fs');

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') args.db = argv[++i];
    else if (a === '--tenant-id') args.tenantId = parseInt(argv[++i], 10);
    else if (a === '--tenant-email') args.tenantEmail = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.db) {
    if (!fs.existsSync(args.db)) { console.error(`ERROR: --db not found: ${args.db}`); process.exit(1); }
    process.env.DATABASE_PATH = path.resolve(args.db);
  }
  const { db, migrate } = require('../src/db');
  migrate(); // ensures migration 027 (external_id + tenant_seed_state) is applied

  const { seedArsenalForTenant, loadSeedData, arsenalCoverage } = require('../src/lib/arsenalSeed');
  const data = loadSeedData();
  console.log(`Arsenal seed: ${data.total} contacts (version ${data.version})`);

  let tenants;
  if (args.tenantId) {
    tenants = db.prepare('SELECT id, name, plan FROM tenants WHERE id = ?').all(args.tenantId);
    if (!tenants.length) { console.error(`ERROR: tenant ${args.tenantId} not found`); process.exit(1); }
  } else if (args.tenantEmail) {
    tenants = db.prepare(
      'SELECT t.id, t.name, t.plan FROM tenants t JOIN users u ON u.tenant_id = t.id WHERE u.email = ? LIMIT 1'
    ).all(String(args.tenantEmail).trim().toLowerCase());
    if (!tenants.length) { console.error(`ERROR: no tenant owns ${args.tenantEmail}`); process.exit(1); }
  } else {
    tenants = db.prepare("SELECT id, name, plan FROM tenants WHERE plan = 'influencer' ORDER BY id").all();
  }
  if (!tenants.length) { console.log('No target tenants found — nothing to do.'); return; }

  for (const t of tenants) {
    if (args.dryRun) {
      const cov = arsenalCoverage(db, t.id);
      console.log(`tenant ${t.id} (${t.name}, plan=${t.plan}): ${cov.represented}/${data.total} represented — DRY RUN, would seed the rest`);
      continue;
    }
    const started = Date.now();
    const r = seedArsenalForTenant(db, t.id, { seedData: data });
    console.log(
      `tenant ${t.id} (${t.name}, plan=${t.plan}): inserted ${r.inserted}, adopted ${r.adopted}, ` +
      `already present ${r.already} -> ${r.total} total (${Date.now() - started}ms) complete=${r.complete}`
    );
    if (!r.complete) { console.error(`ERROR: tenant ${t.id} did not reach full coverage`); process.exitCode = 1; }
  }
}

if (require.main === module) main();
