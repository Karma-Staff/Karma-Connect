-- 005: calls are recorded in the activity log, so the manager's report can
-- answer "who called whom today, and did it connect" from the same place
-- every other action already lives. New action name, so the closed CHECK
-- list grows by one.
--
-- The outcome and duration ride in activity_log.meta rather than new columns:
-- they are specific to this one action, meta is already jsonb, and a column
-- that is null for twelve action types out of thirteen earns its keep only if
-- something indexes it. Shape written by leads/server/calls.js:
--   { outcome: 'connected' | 'no-answer' | 'busy' | 'failed' | 'cancelled'
--              | 'placed',   -- handed to Zoho's own dialler; result unknown
--     seconds: <int>, provider: 'zoho', call_id: '<provider id>' }
ALTER TABLE activity_log DROP CONSTRAINT activity_log_action_check;
ALTER TABLE activity_log ADD CONSTRAINT activity_log_action_check
  CHECK (action IN ('open', 'status', 'owner', 'favorite', 'unfavorite', 'note',
                    'remove', 'restore', 'import', 'jobsearch',
                    'delete', 'undelete', 'purge', 'enrich', 'call'));

-- The report asks "today, per person" and "in the last 15 minutes" on every
-- refresh. Without this it is a sequential scan over the whole log each time,
-- which grows with the team's activity forever. Partial: calls are a small
-- slice of the log and the other actions never use this access path.
CREATE INDEX IF NOT EXISTS activity_log_call_at_idx
  ON activity_log (at DESC, actor)
  WHERE action = 'call';
