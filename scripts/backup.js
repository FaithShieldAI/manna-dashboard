#!/usr/bin/env node
'use strict';
/**
 * Backup script — timestamped copy of the SQLite database.
 *
 * Usage: node scripts/backup.js [dest-dir]
 * Default dest: <project>/backups/
 *
 * SQLite backup is a file copy (WAL mode: the -wal/-shm companions are
 * checkpointed first via a quick connection). For production, run this
 * on a schedule (cron) and ship copies off-machine.
 */
const fs = require('fs');
const path = require('path');

const destDir = process.argv[2]
  || path.join(__dirname, '..', 'backups');

const dbPath = process.env.DATABASE_PATH
  || path.join(__dirname, '..', 'data', 'd2rm-dashboard.db');

if (!fs.existsSync(dbPath)) {
  console.error(`[backup] database not found: ${dbPath}`);
  process.exit(1);
}

// Checkpoint WAL so the main file is self-contained.
try {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  db.close();
} catch (e) {
  console.error('[backup] checkpoint failed:', e.message);
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dest = path.join(destDir, `d2rm-dashboard-${stamp}.db`);
fs.copyFileSync(dbPath, dest);
console.log(`[backup] ${dbPath} -> ${dest}`);
