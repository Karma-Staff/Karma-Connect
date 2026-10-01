-- 013: settings an owner can change without a deploy.
--
-- Everything configurable in this app has lived in the environment, which is
-- right for secrets and wrong for decisions. Turning off a telephony provider
-- that is misbehaving should not require finding the Render dashboard, editing
-- a variable and waiting two minutes for a restart — least of all at 9am with
-- a floor full of reps who cannot dial.
--
-- Deliberately narrow: a key, a JSON value, and who last touched it. It is not
-- a feature-flag system and should not grow into one. Secrets stay in the
-- environment, where a careless SELECT cannot reach them.
--
-- The audit columns are the point as much as the value is. "Who turned Zoho
-- off and when" is the first question asked when somebody cannot make a call.

CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT ''
);
