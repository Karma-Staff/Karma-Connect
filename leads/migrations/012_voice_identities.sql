-- 012: each rep's own telephony login.
--
-- Zoho was ONE set of credentials in the environment, shared by everybody, so
-- every rep dialled from the same identity. RingCentral is per seat, and that
-- difference is the point rather than an inconvenience:
--
--   * caller ID is the rep's own extension, so a returned call reaches the
--     person who made it;
--   * RingCentral's own call log attributes the call correctly;
--   * a rep who leaves is revoked by deleting one row, not by rotating a
--     secret that everyone else is also using;
--   * and a pool of distinct numbers is the cleanest answer to the carrier
--     spam-labelling that one shared number was collecting.
--
-- WHAT IS STORED: a refresh token. It is a long-lived credential that can place
-- calls as that person, so it is as sensitive as a password and is why this
-- table exists rather than a column on app_users — it keeps the blast radius
-- of a careless SELECT * small and makes the grant obvious to anyone reading
-- the schema.
--
-- ON DELETE CASCADE: removing someone's account removes their ability to dial.
-- That is the correct deprovisioning behaviour and it should not need a second
-- step that somebody can forget.

CREATE TABLE IF NOT EXISTS voice_identities (
  user_id        bigint PRIMARY KEY REFERENCES app_users (id) ON DELETE CASCADE,
  provider       text NOT NULL DEFAULT 'ringcentral',
  refresh_token  text NOT NULL,
  -- who RingCentral says this is, kept so the UI can show the rep which
  -- extension they are dialling from without a round trip on every page load
  rc_owner_id    text,
  extension      text,
  ext_number     text,
  main_number    text,
  -- refresh tokens expire if unused (RingCentral's is long but finite), so the
  -- UI can warn before a rep discovers it mid-session
  refresh_expires_at timestamptz,
  connected_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  -- the last refusal from RingCentral, so "it stopped working" has an answer
  last_error     text,
  last_error_at  timestamptz
);

-- "who on the team has connected a phone" is the only question asked across
-- rows, and it is asked on the admin screen every time it opens.
CREATE INDEX IF NOT EXISTS voice_identities_provider_idx
  ON voice_identities (provider, connected_at DESC);
