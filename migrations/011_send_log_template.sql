-- Migration 011: visual send log — track which template was used and who was targeted
-- (Michael 2026-10-18: "all of the ads we send need a visual log in Manna AI,
-- time and date stamped and who we targeted")

ALTER TABLE email_campaigns ADD COLUMN template_key TEXT; -- e.g. 'pastor-combo-english'
ALTER TABLE email_campaigns ADD COLUMN target_description TEXT; -- e.g. '9,173 pastors' or '1,991 influencers'

CREATE INDEX IF NOT EXISTS idx_campaigns_template ON email_campaigns(template_key);
