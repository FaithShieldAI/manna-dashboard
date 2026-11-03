-- D2RM Dashboard SaaS — Migration 033: PR email tracking events
--
-- Press emails sent through Amazon SES carry two tracking routes on
-- the Manna public domain (see src/routes/track.js):
--
--   /t/o/<token>  a 1x1 pixel; loading it records an "open"
--   /t/c/<token>  a redirect; following it records a "click"
--
-- The token is a signed payload (src/lib/prTracking.js) naming the
-- outlet, the recipient email, and the release version (the A/B
-- headline split), so events land here already attributed — no join
-- against pr_targets or pr_pitches is needed to read them back, and
-- the table deliberately carries NO tenant_id: the routes are public
-- and pre-auth by design, and the PR section itself is house-only
-- (every /api/pr route is admin-gated, src/lib/pr.js). One row per
-- event; the /api/pr/tracking endpoint aggregates per recipient.
--
-- ts is unix seconds (the tracking routes stamp Date.now()/1000),
-- not the ISO text the PR tables use: these rows are machine-written
-- and machine-read, and the panel formats them client-side.

CREATE TABLE pr_events (
  id         INTEGER PRIMARY KEY,
  token      TEXT,
  outlet     TEXT,
  email      TEXT,
  version    TEXT,
  kind       TEXT CHECK (kind IN ('open', 'click')),
  target_url TEXT,
  ua         TEXT,
  ip         TEXT,
  ts         INTEGER
);

CREATE INDEX idx_pr_events_email ON pr_events(email);
CREATE INDEX idx_pr_events_ts ON pr_events(ts);
