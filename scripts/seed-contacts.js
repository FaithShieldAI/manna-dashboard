'use strict';
/**
 * Seed Michael's real contact data on startup (if not already present).
 * Reads scripts/seed-influencers.sql and inserts for tenant_id=1.
 * Idempotent: skips if influencers already exist for tenant 1.
 */
const fs = require('fs');
const path = require('path');
const { db, migrate } = require('../src/db');

function seedInfluencers() {
  try {
    migrate();
    
    // Ensure tenant 1 exists
    let tenant = db.prepare('SELECT id FROM tenants WHERE id = 1').get();
    if (!tenant) {
      console.log('[seed] Creating default tenant...');
      const result = db.prepare(
        "INSERT INTO tenants (id, name, slug, plan) VALUES (1, 'D2RM', 'd2rm', 'pro')"
      ).run();
      console.log('[seed] Tenant created');
    }
    
    // Check if already seeded
    const count = db.prepare('SELECT COUNT(*) as c FROM influencers WHERE tenant_id = 1').get();
    if (count.c > 0) {
      console.log(`[seed] Influencers already seeded (${count.c} records), skipping`);
      return;
    }
    
    // Read and execute seed SQL
    const sqlPath = path.join(__dirname, 'seed-influencers.sql');
    if (!fs.existsSync(sqlPath)) {
      console.log('[seed] No seed-influencers.sql found, skipping');
      return;
    }
    
    console.log('[seed] Seeding influencers from SQL...');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const lines = sql.split('\n').filter(l => l.trim().startsWith('INSERT INTO'));
    
    const insert = db.prepare(`
      INSERT OR IGNORE INTO influencers 
      (id, tenant_id, handle, platform, email, tier, category, status, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    let inserted = 0;
    const insertMany = db.transaction((rows) => {
      for (const row of rows) {
        try {
          insert.run(...row);
          inserted++;
        } catch (e) {
          // Skip duplicates/errors
        }
      }
    });
    
    // Parse INSERT statements (simplified - assumes standard format)
    // Actually, let's just execute the raw SQL in a transaction
    db.exec('BEGIN TRANSACTION');
    try {
      // SQLite can execute multiple statements
      db.exec(sql);
      db.exec('COMMIT');
      const newCount = db.prepare('SELECT COUNT(*) as c FROM influencers WHERE tenant_id = 1').get();
      console.log(`[seed] Seeded ${newCount.c} influencers`);
    } catch (e) {
      db.exec('ROLLBACK');
      console.error('[seed] Error seeding:', e.message);
    }
  } catch (e) {
    console.error('[seed] Failed:', e.message);
  }
}

if (require.main === module) {
  seedInfluencers();
}

module.exports = { seedInfluencers };
