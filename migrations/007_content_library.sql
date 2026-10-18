-- D2RM Dashboard SaaS — Migration 007: content library (video repository)
--
-- Stores videos and HTML templates organized by product, category, and
-- language, with performance scores. Files live on disk under media/;
-- this table tracks metadata and serves them.

CREATE TABLE IF NOT EXISTS content_items (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  product          TEXT NOT NULL CHECK (product IN ('faithshield','armorbearer','manna','kpkunk','sustained')),
  category         TEXT NOT NULL DEFAULT 'general',
  language         TEXT NOT NULL DEFAULT 'en',
  title            TEXT NOT NULL,
  description      TEXT,
  type             TEXT NOT NULL DEFAULT 'video' CHECK (type IN ('video','html','image','doc')),
  file_path        TEXT NOT NULL,
  file_size_bytes  INTEGER,
  duration_s       REAL,
  thumbnail_path   TEXT,
  performance_score REAL,
  view_count       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_content_product ON content_items(product);
CREATE INDEX IF NOT EXISTS idx_content_lang ON content_items(language);
CREATE INDEX IF NOT EXISTS idx_content_cat ON content_items(product, category);
CREATE INDEX IF NOT EXISTS idx_content_tenant ON content_items(tenant_id);
