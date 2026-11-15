-- Migration 038: sign-in record columns on users (2026-11-14).
--
-- The sign-in record covers exactly TWO keyed accounts
-- (michael@faithshield.ai and support@faithshield.ai) and no others.
-- The keying lives in src/lib/signinRecord.js; these columns exist on
-- every user row but are only ever WRITTEN for the two keyed accounts
-- and only ever READ for them (their own profile payload). Every other
-- user's columns stay NULL forever.
--
--   last_login_at        — when the current/most recent visit began
--                          (stamped at password sign-in only).
--   last_activity_at     — most recent authenticated activity on the
--                          current visit (keyed users only).
--   last_session_seconds — length of the most recent visit so far,
--                          last_activity_at minus last_login_at, in
--                          whole seconds; refreshed on activity and
--                          finalized at logout. NULL until a visit has
--                          recorded activity.
--
-- Plain additive ALTERs, same shape as migration 028. The columns flow
-- into the production backups automatically as part of the users table.

ALTER TABLE users ADD COLUMN last_login_at TEXT;
ALTER TABLE users ADD COLUMN last_activity_at TEXT;
ALTER TABLE users ADD COLUMN last_session_seconds INTEGER;
