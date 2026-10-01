# Rules for changing this codebase

Aimed at an AI coding agent, but they are just good rules.

## Before you touch anything

1. **Read [`PROJECT-MEMORY.md`](PROJECT-MEMORY.md).** It is short and it is
   mostly things that already went wrong.
2. **Read the nearest `CLAUDE.md`.** `leads/CLAUDE.md` holds the invariants for
   the half of the system with the data in it.
3. **Work out which half you are in.** Connect and Leads have different
   languages, different databases, different user tables and different design
   vocabularies. A fix in one is not a fix in the other.

## While you work

**Check, do not assume.** Nearly every wrong turn in this project's history was
a confident guess:

- "the deploy is stuck" — it had deployed; the cache-buster hadn't
- "the token is fine" — Render held the grant code, not the refresh token
- "members can't see the new sections" — they were on the old service
- "`tel:` will reach Zoho" — Zoho was not a registered handler

Each was one command away from being known. Run the command.

**Verify against the running system, not the source.** `curl` the endpoint,
query the database, drive the browser. The source tells you what should
happen.

**A failing test or a red screenshot is the finding.** Do not explain it away.
Twice in this project a test "failure" was the test being wrong — both times
that was established by capturing the actual DOM and the actual response, not
by reasoning about it.

**Do not write through a shell heredoc what you can write with a file tool.**
Two real bugs came from heredocs eating backslashes: a literal `0x08` inside a
regex that made every OAuth token look read-only, and a newline inside a string
literal that broke the build. If you must, verify with `od -c`.

## Rules with teeth

| Rule | Because |
|---|---|
| Schema changes only via `leads/migrations/` + `migrate.js` | `karma_api` is the only DDL role; hand-edits drift |
| Every `leads` query filters `deleted_at IS NULL` | or binned rows return as phantom duplicates |
| Role checks are rank comparisons, never `=== "admin"` | or an owner loses screens they outrank |
| Counting by state matches both `FL` and `Florida` | or Florida is under-reported by 611 |
| Never hand-bump the `?v=` cache-busters | `cachebust.js` does it from the file bytes |
| Run `npm run docs:api` after editing **any** file that declares routes | API.md embeds `file:line` links, so adding a comment to `server.js` is enough to make it stale and fail CI |
| Never commit a secret; `.env` is gitignored | tokens in this project are durable keys to a phone system |
| Never put a placeholder in a config value | `YOUR_CLIENT_ID`, `<from the other service>` and a grant code have all been pasted into production here |
| Do not add a dependency without saying why | the runtime is twelve packages and that is a feature |
| Clean up test rows you write to production | this repo's dev database *is* production |

## Things that are load-bearing

Change these only with a reason that survives reading the comments in them:

- `server/dedupe.js` — identity. Franchises are not duplicates. Every clause
  caught a real bad merge.
- `leads/server/auth.js` `resolve()` — the shared-cookie path both products
  depend on.
- `api/_proxy.cjs` — Anthropic proxy: rate limits, circuit breaker, cost
  recording.
- The partial unique indexes in migrations 008 and 010 — they are what stop
  duplicate reminders and duplicate call sessions.

## When you finish

- `npx vitest run` — 116 tests, under a second
- `npx vite build` if you touched `src/`
- `node --check` on any file a script edited
- Say what you changed and what you verified. If you could not verify
  something, say that too — "it should work" is not a report.

## On scope

The instinct to tidy is usually wrong here. Karma Leads has no build step and
one 5,700-line `app.js`; that is why it survived being moved between two
hosting setups and why a fix ships by pushing a file. Modernising it is a
project, not a side-effect of a bug fix.

Equally: do not narrow the job. If something is broken in three places, fix
three places and say so.
