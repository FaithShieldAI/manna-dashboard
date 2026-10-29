'use strict';
/**
 * Affiliate arsenal preload — "they join Armor Bearer and they get
 * their guns already loaded" (Michael, 2026-10-25).
 *
 * When an influencer tenant (plan='influencer', provisioned by the
 * Armor Bearer webhook) exists, it must arrive PRELOADED with the full
 * D2RM contact arsenal — all 13,871 master contacts — inside the app:
 * rows in `influencers` (the single table behind the Leads, Vetted and
 * Influencers surfaces), source='d2rm-arsenal', external_id = master
 * contact id (migration 027). Media preloads via the Content Library;
 * this is the data equivalent.
 *
 * The canonical seed data lives in data/seed/arsenal-seed.json,
 * generated from the master DB by scripts/generate-arsenal-seed.js
 * (mapping identical to scripts/import-contacts.js). Regenerate the
 * file — never hand-edit it — when the master DB changes materially.
 *
 * Idempotency (mandatory): external_id is the key.
 *   - master id already represented in the tenant  -> skipped
 *   - same email already present WITHOUT an external_id (e.g. the
 *     owner's earlier import, or a lead the affiliate collected
 *     themselves) -> the existing row is ADOPTED (external_id set;
 *     its handle/status/notes/source are left untouched — the
 *     affiliate's row is never overwritten or duplicated)
 *   - otherwise -> inserted
 * A per-tenant tenant_seed_state row (migration 027) records the
 * seeded version + coverage, giving replays an O(1) fast path.
 * Re-running therefore inserts ZERO duplicates, always.
 *
 * Tenant isolation: every statement is scoped to the one tenant_id;
 * seeded rows belong to that tenant only.
 */
const fs = require('fs');
const path = require('path');

const SEED_KEY = 'd2rm-arsenal';
const SEED_SOURCE = 'd2rm-arsenal';
const DEFAULT_SEED_PATH = path.join(__dirname, '..', '..', 'data', 'seed', 'arsenal-seed.json');

const cache = new Map(); // path -> parsed seed data

/** Empty arsenal used ONLY when the seed file is missing (see below). */
function emptySeed() {
  return {
    seed_key: SEED_KEY,
    version: 0,
    generated_from: null,
    total: 0,
    counts_by_master_category: {},
    counts_by_mapped_category: {},
    rows: []
  };
}

function loadSeedData(seedPath) {
  const p = seedPath || DEFAULT_SEED_PATH;
  if (cache.has(p)) return cache.get(p);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      // FIX 2026-10-29: a MISSING seed file (e.g. the .dockerignore
      // packaging miss that kept data/seed/arsenal-seed.json out of the
      // production image) must never break signup / webhook seeding by
      // throwing. Degrade to an empty arsenal with a LOUD warning; the
      // empty fallback is deliberately NOT cached, so once the real file
      // ships it is picked up on the next call. A file that exists but is
      // malformed still throws below — corrupt data must stay visible.
      // eslint-disable-next-line no-console
      console.error(`[arsenal] WARNING: seed file not found at ${p} — arsenal preload DISABLED (empty seed). Check packaging of data/seed/arsenal-seed.json.`);
      return emptySeed();
    }
    throw e;
  }
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.rows) || typeof data.total !== 'number'
      || data.rows.length !== data.total) {
    throw new Error(`[arsenal] seed file ${p} is malformed (rows/total mismatch)`);
  }
  const ids = new Set(data.rows.map(r => r.master_id));
  if (ids.size !== data.total) {
    throw new Error(`[arsenal] seed file ${p} contains duplicate master ids`);
  }
  cache.set(p, data);
  return data;
}

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function withTx(db, fn) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const out = fn();
    db.exec('COMMIT;');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK;'); } catch (_) { /* already rolled back */ }
    throw e;
  }
}

/** Coverage snapshot for one tenant (no writes). */
function arsenalCoverage(db, tenantId) {
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM influencers WHERE tenant_id = ? AND external_id IS NOT NULL'
  ).get(tenantId);
  const state = db.prepare(
    'SELECT version, row_count, seeded_at, updated_at FROM tenant_seed_state WHERE tenant_id = ? AND seed_key = ?'
  ).get(tenantId, SEED_KEY);
  return { represented: row ? row.n : 0, state: state || null };
}

/**
 * Seed (or top up) one tenant with the full arsenal.
 * Returns { tenantId, inserted, adopted, already, total, complete }.
 * `total` is the seed file's row count; after a successful run the
 * tenant represents exactly `total` master contacts.
 */
function seedArsenalForTenant(db, tenantId, opts = {}) {
  const t = Number(tenantId);
  if (!Number.isInteger(t) || t <= 0) throw new Error('seedArsenalForTenant: invalid tenantId');
  const data = opts.seedData || loadSeedData(opts.seedPath);

  const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(t);
  if (!tenant) throw new Error(`seedArsenalForTenant: tenant ${t} does not exist`);

  // Fast path: state says this version is fully seeded AND the rows agree.
  const cov = arsenalCoverage(db, t);
  if (cov.state && cov.state.version >= data.version && cov.represented === data.total) {
    return { tenantId: t, inserted: 0, adopted: 0, already: data.total, total: data.total, complete: true };
  }

  const result = withTx(db, () => {
    const byExternal = new Map(
      db.prepare('SELECT id, external_id FROM influencers WHERE tenant_id = ? AND external_id IS NOT NULL')
        .all(t).map(r => [r.external_id, r.id])
    );
    // Adoption candidates: rows the tenant already has (same email) that
    // are not yet tied to a master contact. First row wins per email.
    const byEmail = new Map();
    for (const r of db.prepare(
      'SELECT id, LOWER(email) AS e FROM influencers WHERE tenant_id = ? AND external_id IS NULL AND email IS NOT NULL'
    ).all(t)) {
      if (!byEmail.has(r.e)) byEmail.set(r.e, r.id);
    }

    const ins = db.prepare(`
      INSERT INTO influencers
        (tenant_id, handle, platform, email, tier, category, status, notes, source, external_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))
    `);
    const adopt = db.prepare(
      'UPDATE influencers SET external_id = ? WHERE tenant_id = ? AND id = ? AND external_id IS NULL'
    );

    let inserted = 0;
    let adopted = 0;
    let already = 0;
    for (const r of data.rows) {
      if (byExternal.has(r.master_id)) { already += 1; continue; }
      const emailKey = r.email ? r.email.toLowerCase() : null;
      if (emailKey && byEmail.has(emailKey)) {
        const rowId = byEmail.get(emailKey);
        adopt.run(r.master_id, t, rowId);
        byExternal.set(r.master_id, rowId);
        byEmail.delete(emailKey);
        adopted += 1;
        continue;
      }
      const res = ins.run(t, r.handle, r.platform, r.email, r.tier, r.category, r.status,
        r.notes, SEED_SOURCE, r.master_id, r.created_at);
      byExternal.set(r.master_id, Number(res.lastInsertRowid));
      inserted += 1;
    }

    const represented = already + adopted + inserted;
    db.prepare(`
      INSERT INTO tenant_seed_state (tenant_id, seed_key, version, row_count, seeded_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, seed_key)
      DO UPDATE SET version = excluded.version, row_count = excluded.row_count,
                    updated_at = excluded.updated_at
    `).run(t, SEED_KEY, data.version, represented, utcNow(), utcNow());

    return { inserted, adopted, already, represented };
  });

  return {
    tenantId: t,
    inserted: result.inserted,
    adopted: result.adopted,
    already: result.already,
    total: data.total,
    complete: result.represented === data.total
  };
}

module.exports = {
  SEED_KEY,
  SEED_SOURCE,
  DEFAULT_SEED_PATH,
  loadSeedData,
  arsenalCoverage,
  seedArsenalForTenant
};
