-- D2RM Dashboard SaaS — Migration 029: A/B tests do both (email + video)
--
-- Michael's ruling (2026-10-31): the A/B Tests board must handle video
-- posts as well as email templates. A video test links two social_postings
-- rows as its variants; its scoreboard (clicks/likes/shares/comments) is
-- synced from those postings by POST /api/engagement/ab/:id/sync.
-- Email tests are unchanged: kind defaults to 'email' and the variant
-- template columns keep their meaning.
ALTER TABLE ab_tests ADD COLUMN kind TEXT NOT NULL DEFAULT 'email' CHECK (kind IN ('email','video'));
ALTER TABLE ab_tests ADD COLUMN variant_a_post_id INTEGER REFERENCES social_postings(id) ON DELETE SET NULL;
ALTER TABLE ab_tests ADD COLUMN variant_b_post_id INTEGER REFERENCES social_postings(id) ON DELETE SET NULL;
ALTER TABLE ab_tests ADD COLUMN likes_a INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ab_tests ADD COLUMN likes_b INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ab_tests ADD COLUMN shares_a INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ab_tests ADD COLUMN shares_b INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ab_tests ADD COLUMN comments_a INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ab_tests ADD COLUMN comments_b INTEGER NOT NULL DEFAULT 0;
