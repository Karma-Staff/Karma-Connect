-- 010: a calling session — working a list of leads straight through.
--
-- The list is SNAPSHOT at the start, as an ordered array of ids, rather than
-- re-run as a query on every Next. Two reasons, both learned the hard way by
-- anyone who has built a dialler:
--
--   The list must not move under the caller. Setting a lead to Contacted
--   would drop it out of a live "status = New" query, every later lead would
--   shift up by one, and position 12 of 47 would quietly become a different
--   company than the one just dialled.
--
--   Position has to mean something. "You are 12 of 47" is a promise that the
--   47 is fixed; against a moving query it is a number that shrinks as you
--   work and never reaches the end.
--
-- One live session per caller, held by the partial unique index. Starting a
-- new one ends the old rather than leaving two half-worked lists nobody can
-- tell apart.
CREATE TABLE IF NOT EXISTS call_sessions (
  id          bigserial PRIMARY KEY,
  -- who is doing the calling
  actor       text NOT NULL,
  -- whose list it is. Usually the same; a manager may work a rep's list,
  -- and the calls are still logged against the manager who made them.
  owner       text NOT NULL,
  lead_ids    bigint[] NOT NULL,
  -- how far in. 0-based index into lead_ids; equal to length means finished.
  pos         int NOT NULL DEFAULT 0,
  -- what built the list, so the screen can say so and it can be rebuilt
  filters     jsonb,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  -- counts kept here as they happen, so the summary does not have to
  -- re-derive a session's worth of calls out of the activity log
  called      int NOT NULL DEFAULT 0,
  connected   int NOT NULL DEFAULT 0,
  skipped     int NOT NULL DEFAULT 0
);

-- One open session per caller: "resume where I was" has to have exactly one
-- answer.
CREATE UNIQUE INDEX IF NOT EXISTS call_sessions_open_idx
  ON call_sessions (actor) WHERE ended_at IS NULL;

-- "what did we work through this week" — the only other question it is asked
CREATE INDEX IF NOT EXISTS call_sessions_started_idx
  ON call_sessions (started_at DESC);
