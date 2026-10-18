-- D2RM Dashboard SaaS — Migration 010: audience segmentation
--
-- Every campaign/posting tags WHO it targets: pastors, influencers,
-- churches, schools, individuals. Same structure as product/language.

ALTER TABLE email_campaigns ADD COLUMN audience TEXT DEFAULT 'individual';
ALTER TABLE content_postings ADD COLUMN audience TEXT DEFAULT 'individual';

CREATE INDEX IF NOT EXISTS idx_campaigns_audience ON email_campaigns(audience);
CREATE INDEX IF NOT EXISTS idx_postings_audience ON content_postings(audience);
