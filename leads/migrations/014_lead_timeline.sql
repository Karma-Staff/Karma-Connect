-- 014: read the activity log the other way round — "everything that ever
-- happened to THIS lead", newest first.
--
-- Every index on activity_log so far answers the manager's question: by time,
-- by actor, by call. The dialler asks the rep's question instead. It opens on
-- one lead and shows that lead's calls, notes and status changes in the panel
-- beside the phone, and it asks on every single call.
--
-- Without this that query is a sequential scan of the whole log — fine today
-- at a few thousand rows, and a growing cost on a table that by design is
-- never pruned. The read happens once per call placed, so it is squarely on
-- the path a rep waits on.
--
-- Not partial: unlike activity_log_call_at_idx this serves every action type,
-- because the History tab's filters (All / Calls / Notes / Follow-ups) are a
-- filter over one lead's whole timeline rather than three separate queries.
CREATE INDEX IF NOT EXISTS activity_log_lead_at_idx
  ON activity_log (lead_id, at DESC)
  WHERE lead_id IS NOT NULL;
