-- D2RM Dashboard SaaS — Migration 030: Scribe follow-ups (the loop)
--
-- Michael's doctrine (2026-10-31): every recorded move is followed up
-- automatically — Scribe analyzes, dictates the next move, prepares the
-- drafts, and the operator is notified with the ask. The operator's
-- only jobs are answering Scribe's questions and pressing OK.
-- One row per follow-up: what happened (summary), the audience
-- reaction's direction (up/down/flat, NULL when a first sighting),
-- the analysis + drafts Scribe prepared, any questions Scribe asked,
-- the operator's answers, and the decision.
CREATE TABLE IF NOT EXISTS scribe_followups (
  id             INTEGER PRIMARY KEY,
  tenant_id      INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type     TEXT NOT NULL,
  event_ref      TEXT,
  summary        TEXT NOT NULL,
  direction      TEXT CHECK (direction IS NULL OR direction IN ('up','down','flat')),
  analysis_id    TEXT,
  next_move      TEXT,
  drafts_count   INTEGER NOT NULL DEFAULT 0,
  questions_json TEXT NOT NULL DEFAULT '[]',
  answers_json   TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','dismissed')),
  decided_at     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_scribe_followups_tenant ON scribe_followups(tenant_id, status, id DESC);
