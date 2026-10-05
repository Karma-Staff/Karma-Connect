-- 016: each person's own Zoho CRM sign-in.
--
-- Until now every CRM write went through ONE service account (the
-- ZOHO_CRM_* refresh token in the environment), so every Call and Lead
-- Karma Connect created in Zoho was owned by whoever set that up. Zoho
-- files a record under the account that creates it — reports by rep,
-- "My Calls", and record-level permissions all key off that owner — so a
-- rep's calls belonged to somebody else the moment they reached the CRM.
--
-- A rep who signs in here gets their writes made as themselves. Somebody
-- who has not connected keeps going through the service account exactly as
-- before; connecting is optional and done by each rep, not an admin.
--
-- Its own table rather than more rows in voice_identities: that table is
-- keyed on user_id alone (one phone per person), and a phone and a CRM
-- login are two different things a person holds at once.
CREATE TABLE IF NOT EXISTS crm_identities (
  user_id        bigint PRIMARY KEY REFERENCES app_users (id) ON DELETE CASCADE,
  provider       text NOT NULL DEFAULT 'zoho',
  -- Zoho's refresh token does not rotate and does not expire with use; it
  -- lasts until the person revokes it or it is unused for a long time.
  refresh_token  text NOT NULL,
  -- Zoho is regional: the person's account answers on the API host it was
  -- signed in on (.com, .eu, .in …), returned with the token.
  api_domain     text NOT NULL,
  accounts_url   text NOT NULL,
  -- who Zoho says this is, so the screen can show "connected as …" and a
  -- manager can see a rep connected the wrong Zoho account
  zoho_user_id   text,
  zoho_name      text,
  zoho_email     text,
  connected_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  -- the last refusal, so "my calls stopped showing as mine" has an answer
  last_error     text,
  last_error_at  timestamptz
);
