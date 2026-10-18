-- D2RM Dashboard SaaS — Migration 009: email product/language structure
--
-- Structures email campaigns and templates the same way as the video
-- repository: separate by product, each language its own subcategory.
-- Sustained is excluded (no email marketing repository).

ALTER TABLE email_campaigns ADD COLUMN product TEXT DEFAULT 'manna';
ALTER TABLE email_campaigns ADD COLUMN language TEXT DEFAULT 'en';
ALTER TABLE email_templates ADD COLUMN product TEXT DEFAULT 'manna';
ALTER TABLE email_templates ADD COLUMN language TEXT DEFAULT 'en';

CREATE INDEX IF NOT EXISTS idx_campaigns_product ON email_campaigns(product, language);
CREATE INDEX IF NOT EXISTS idx_templates_product ON email_templates(product, language);
