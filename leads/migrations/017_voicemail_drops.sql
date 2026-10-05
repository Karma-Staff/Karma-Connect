-- 017: each rep's recorded voicemail, for "voicemail drop".
--
-- A rep records their voicemail message once; on a call that reaches an
-- answering machine they press one button after the beep and this recording
-- plays into the call instead of their microphone, then the call ends. It
-- saves saying the same thirty seconds a few dozen times a day.
--
-- One per person, replaced when they re-record. Stored in the database
-- rather than on disk because Render's disk does not survive a deploy. A
-- minute of Opus is a few hundred kilobytes, so this stays small.
CREATE TABLE IF NOT EXISTS voicemail_drops (
  user_id     bigint PRIMARY KEY REFERENCES app_users (id) ON DELETE CASCADE,
  audio       bytea NOT NULL,
  mime        text NOT NULL,
  seconds     numeric(6, 2),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
