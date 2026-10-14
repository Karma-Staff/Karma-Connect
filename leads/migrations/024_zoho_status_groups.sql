-- 024: lead status from Zoho, rep groups for the power dialler, and a fast
-- "has this number ever been called" lookup.
--
-- 1. A lead's status now follows Zoho CRM: the Call Result (the disposition)
--    of the most recent Zoho Call to that number. The scan (zoho-scan.js)
--    keeps each Call's result and start time here, so the status of every
--    lead is one join against this table, never a Zoho request.
ALTER TABLE zoho_records ADD COLUMN IF NOT EXISTS call_result text;
ALTER TABLE zoho_records ADD COLUMN IF NOT EXISTS call_at timestamptz;   -- Zoho's Call_Start_Time
CREATE INDEX IF NOT EXISTS zoho_records_call_result_idx
  ON zoho_records (phone_key, call_at DESC)
  WHERE module = 'Calls' AND call_result IS NOT NULL AND phone_key IS NOT NULL;

-- 2. Named groups of reps. A power-dialler campaign given to a group splits
--    its contacts at random between the group's reps, one call session each.
CREATE TABLE IF NOT EXISTS rep_groups (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS rep_groups_name_idx ON rep_groups (lower(name));
CREATE TABLE IF NOT EXISTS rep_group_members (
  group_id  bigint NOT NULL REFERENCES rep_groups(id) ON DELETE CASCADE,
  user_id   bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

-- 3. "Unique numbers" — leads whose number nobody has ever called. A call is
--    an activity_log row (action 'call') carrying the dialled number in
--    meta.number; this indexes its ten digits, extension stripped, with the
--    exact expression calls.js PHONE10() writes, so the campaign builder's
--    NOT EXISTS is an index probe per lead rather than a scan of every call.
CREATE INDEX IF NOT EXISTS activity_log_call_number_idx
  ON activity_log ((right(regexp_replace(regexp_replace(coalesce(meta->>'number', ''),
    '\s*(ext\.?|extension|x|#)\s*\d+\s*$', '', 'i'), '\D', '', 'g'), 10)))
  WHERE action = 'call';
