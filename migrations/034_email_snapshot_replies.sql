-- D2RM Dashboard SaaS — Migration 034: replies in email snapshots
--
-- The standard outgoing-mail column set shared by the private dashboard
-- and Manna is: sent, opens, open rate, clicks, click rate, bounces,
-- opt-outs, replies. email_snapshots carried every one of those except
-- replies (harvested from the mailbox: SES and Outlook sends report their
-- replies there, not to a provider stats API). This column lets the
-- token-guarded snapshot sync (src/routes/auth.js) store the combined
-- house reply counts next to the other windowed totals.

ALTER TABLE email_snapshots ADD COLUMN replies INTEGER NOT NULL DEFAULT 0;
