-- Migration 013: queued email count on influencers
-- Michael requested: show (a) queued/scheduled emails AND (b) actually sent, per influencer.
ALTER TABLE influencers ADD COLUMN emails_queued INTEGER NOT NULL DEFAULT 0;
