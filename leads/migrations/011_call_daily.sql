-- 011: one row per person per day of calling, kept forever.
--
-- The call report used to ask activity_log for `at >= date_trunc('day', now())`
-- and nothing else. Every number on the manager's screen therefore went back
-- to zero at midnight, and there was no way to ask what yesterday looked like,
-- or last week, or whether a rep is improving. The rows were never lost —
-- activity_log is append-only — but nothing read them, which to the person
-- looking at the screen is the same thing.
--
-- WHY A TABLE AND NOT JUST A BETTER QUERY: two reasons.
--
--   A finished day is a fact. Once a day is over its numbers cannot change,
--   so recomputing them on every page load is work done again and again for
--   an answer that was already known. The rollup is written once and read
--   cheaply forever.
--
--   The morning email must agree with the screen. Both now read the same
--   stored row, so a manager cannot be told 31 calls in an email and shown 34
--   an hour later because the two queries drifted apart.
--
-- TIMEZONE — the subtle part. `at` is timestamptz and Render runs UTC, so
-- `at::date` puts a 8pm Eastern call into TOMORROW. That is not a rounding
-- detail; it silently moves a whole evening of work into the next day's
-- report and makes the morning email wrong. The day here is the LOCAL date in
-- the team's own timezone, and `call_day()` below is the single definition of
-- it. Change the timezone in one place or not at all.
--
-- Today is deliberately NOT stored: it is still changing. calls.js reads the
-- live log for today and this table for every day before it, and the daily
-- cron writes yesterday once it is complete.

CREATE OR REPLACE FUNCTION call_day(ts timestamptz, tz text)
RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT (ts AT TIME ZONE tz)::date
$$;

CREATE TABLE IF NOT EXISTS call_daily (
  day        date NOT NULL,
  actor      text NOT NULL,
  calls      int  NOT NULL DEFAULT 0,
  connected  int  NOT NULL DEFAULT 0,
  -- handed to Zoho's own dialler: an attempt we made and an outcome we never
  -- saw. Counted apart from `connected` so a connect rate is never inflated
  -- by calls whose result nobody reported back.
  placed     int  NOT NULL DEFAULT 0,
  no_answer  int  NOT NULL DEFAULT 0,
  busy       int  NOT NULL DEFAULT 0,
  failed     int  NOT NULL DEFAULT 0,
  cancelled  int  NOT NULL DEFAULT 0,
  seconds    int  NOT NULL DEFAULT 0,
  leads      int  NOT NULL DEFAULT 0,   -- distinct leads rung that day
  first_at   timestamptz,
  last_at    timestamptz,
  built_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, actor)
);

-- "the whole team, one day" and "one person, many days" are the only two
-- questions asked of this table, and the primary key already serves the first.
CREATE INDEX IF NOT EXISTS call_daily_actor_idx ON call_daily (actor, day DESC);

-- Backfill every complete day that already exists in the log, so the history
-- screen is not empty on the morning this ships. Re-runnable: the upsert makes
-- rebuilding a day idempotent, which is also how the nightly job works.
INSERT INTO call_daily (day, actor, calls, connected, placed, no_answer, busy,
                        failed, cancelled, seconds, leads, first_at, last_at)
SELECT call_day(at, 'America/New_York') AS day,
       actor,
       count(*)::int,
       count(*) FILTER (WHERE meta->>'outcome' = 'connected')::int,
       count(*) FILTER (WHERE meta->>'outcome' = 'placed')::int,
       count(*) FILTER (WHERE meta->>'outcome' = 'no-answer')::int,
       count(*) FILTER (WHERE meta->>'outcome' = 'busy')::int,
       count(*) FILTER (WHERE meta->>'outcome' = 'failed')::int,
       count(*) FILTER (WHERE meta->>'outcome' = 'cancelled')::int,
       coalesce(sum((meta->>'seconds')::int), 0)::int,
       count(DISTINCT lead_id)::int,
       min(at), max(at)
  FROM activity_log
 WHERE action = 'call'
   AND call_day(at, 'America/New_York') < call_day(now(), 'America/New_York')
 GROUP BY 1, 2
ON CONFLICT (day, actor) DO NOTHING;
