-- Migration 012: email engagement stats on influencers
-- Michael requested: when viewing influencers, each record shows email counts.
ALTER TABLE influencers ADD COLUMN emails_sent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE influencers ADD COLUMN emails_opened INTEGER NOT NULL DEFAULT 0;
ALTER TABLE influencers ADD COLUMN emails_clicked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE influencers ADD COLUMN last_emailed_at TEXT;
