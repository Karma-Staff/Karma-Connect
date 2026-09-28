# ADR-003 — Scheduled work is triggered from outside the process

**Status** Accepted · **Date** 2026-09 · **Owner** repo owner

## Context

The 7am storm digest has to send at 7am. The Render service is on the free
plan, which stops the process after ~15 minutes without a request. At seven in
the morning nobody has touched the site since the night before, so
`setInterval` is not running and fires nothing.

This also silently affected follow-back reminders, which used the same pattern.

## Options

1. Upgrade to a paid always-on instance.
2. Render Cron Job (a separate paid service type).
3. An external scheduler knocking on an endpoint.

## Decision

Option 3. `.github/workflows/daily-digest.yml` posts to `/api/cron/daily` with
a shared secret. The knock also flushes any follow-back reminders that came due
overnight — the same problem, solved by the same wake-up.

## Reason

Free, and the repo is already on GitHub. The whole project exists to cut
hosting cost; paying for always-on to send one email would be self-defeating.

## Tradeoffs

- The endpoint needs its own auth (`CRON_TOKEN`), refused outright when unset
  rather than defaulting to open.
- Cron is UTC and knows nothing of daylight saving, so **two** times are fired
  (11:00 and 12:00 UTC) and the server decides which is 7am local.
  `job_runs` (migration 009) makes the day something you claim once, in a
  single statement that cannot race.
- If GitHub Actions is down, the digest is missed. Acceptable for a sales
  briefing; would not be for anything transactional.
