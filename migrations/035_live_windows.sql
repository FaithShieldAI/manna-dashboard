-- D2RM Dashboard SaaS — Migration 035: live windows payload store
--
-- The house tenant's outgoing-mail windows are computed LIVE on the
-- analytics VM (fresh Kit/MailerLite API pulls, live PR events, mailbox
-- harvest, send ledgers; the private dashboard builder's own math) and
-- pushed here every ~60s by POST /api/auth/live-windows-sync/:token
-- (src/lib/liveWindows.js). One row per tenant: the full payload plus
-- when it was received. Read paths (GET /api/email/windows, the /app
-- page injection, the public live-windows read) serve this payload
-- while it is fresh (<=180s old) and say so; the email_snapshots rows
-- remain as the fallback and are never presented as live.

CREATE TABLE IF NOT EXISTS live_windows (
  tenant_id INTEGER PRIMARY KEY,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
