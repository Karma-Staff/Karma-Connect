-- 009: a record of which scheduled jobs have already run today.
--
-- The 7am storm digest is triggered from outside — Render's free plan sleeps
-- the process after a quarter hour of quiet, so an in-process timer is not
-- awake at seven to fire anything. Something external has to knock.
--
-- Anything that knocks can knock twice: a retry, an overlapping schedule, or
-- the two runs we deliberately fire either side of the daylight-saving shift
-- so that exactly one of them lands at 7am local. The primary key is the
-- guard. Claiming a day is an INSERT that either takes it or does nothing,
-- which is one statement and cannot race.
CREATE TABLE IF NOT EXISTS job_runs (
  job      text NOT NULL,
  ran_on   date NOT NULL,
  ran_at   timestamptz NOT NULL DEFAULT now(),
  detail   jsonb,
  PRIMARY KEY (job, ran_on)
);
