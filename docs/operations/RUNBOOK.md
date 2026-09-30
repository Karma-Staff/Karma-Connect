# Runbook

What is set where, what breaks when it is not, and how to check — rather than
how to guess. Most of the incidents in this project's history were a
configuration value, and every one of them was one command away from being
known.

**The rule that matters:** check the running system, not the source. `curl` the
endpoint, query the database, look at the served HTML.

---

## The estate

| Thing | Where | Plan | Notes |
|---|---|---|---|
| `karma-connect` web service | Render | free | the whole app, both halves |
| `karma-connect-db` | Render Postgres | free | Connect's data |
| `karmaleads_database` | Render Postgres | **paid** | 36,619 leads, 114 MB, region **virginia** |
| `karma-leads-nocodb` | Render | — | ⚠️ **the old service, still live** |
| Daily digest trigger | GitHub Actions | free | `.github/workflows/daily-digest.yml` |
| CI | GitHub Actions | free | `.github/workflows/ci.yml` |
| Mail | gateway via `GATEWAY_URL` | — | not SMTP |
| Telephony | Zoho | see §Zoho | licence-limited |
| Scrapers | Apify | pay per run | job search, LinkedIn |
| AI | Anthropic, via `api/_proxy.cjs` | pay per token | budgeted |

### ⚠️ The old service is still running

`karma-leads-nocodb.onrender.com` serves **frozen code against the same live
database**. This is not hypothetical: it is why reps reported that the new
sections "weren't there" — they were bookmarked to the old host, which was
serving `app.js?v=39`.

It is the single most likely cause of any future "it works for you but not for
me". Before suspending it:

1. Confirm nothing points at it: check bookmarks with the team, and any saved
   links in email or chat.
2. Confirm it is not the thing holding a DNS record or a redirect.
3. Confirm the Python importer's `KARMA_API_URL` does **not** name it — it
   writes leads, and pointing at a frozen API is worse than pointing at none.
4. Suspend (do not delete) and leave it suspended for a fortnight.

```bash
# which build is each host serving? they should agree.
curl -s https://karma-connect-9s2z.onrender.com/leads/ | grep -o 'app\.js?v=[a-z0-9]*'
curl -s https://karma-leads-nocodb.onrender.com/leads/ | grep -o 'app\.js?v=[a-z0-9]*'
```

---

## Deploys

`npm start` is `node scripts/leads-migrate.mjs && node server.js`. **Migrations
run automatically on every deploy, before the server starts.** Two consequences:

- A bad migration takes the service down, not just the feature. The `&&` is
  deliberate — a half-migrated database serving traffic is worse than a service
  that will not start.
- You do not run migrations by hand in production. You push.

```bash
npm run leads:migrate:status   # what has been applied
npm run leads:migrate          # apply (runs on deploy anyway)
```

The build is `vite build` for Connect only. **Karma Leads has no build step** —
`leads/public/app.js` is served as written, which is why a Leads fix ships by
pushing one file.

### Cache-busting is automatic. Do not touch it.

`leads/server/cachebust.js` stamps `?v=` into `index.html` **at serve time**,
from a hash of the size and mtime of `app.js`, `app.css` and `na-geo.js`.

The `?v=76`-style numbers you see in the source are markers for a diff and
nothing else. This exists because it went wrong: `app.js` shipped twice while
`index.html` still said `v=76`, so every browser that had cached that URL kept
running the old file — for days, while the fixes appeared to have been deployed.

**Never hand-bump a `?v=`.** If browsers are stale, the question is whether
`cachebust.js` is running, not what number to type.

---

## Environment variables

The authoritative list is what the code reads. Note that `render.yaml` is
**out of date** — see the warning at the end of this section.

### Cannot start / nothing works without these

| Variable | Used by | What breaks without it |
|---|---|---|
| `LEADS_DATABASE_URL` | Leads | every Leads route. The module throws at require time |
| `DATABASE_URL` | Connect | Connect's half |
| `AUTH_JWT_SECRET` | both | the shared `kc_session` cookie. **Rotating it signs everyone out** |
| `APP_URL` | digest, mail links | emails ship with dead links |

`karmaleads_database` is in **virginia**. Render's *internal* connection string
only works from the same region — if the web service is elsewhere, this must be
the *external* URL. Getting this wrong looks like a hanging connection, not an
auth error.

Also relevant: `PGSSL`, `PGSSLMODE`, `PGCONNECT_TIMEOUT`, `PG_POOL_MAX`.

### Access control

| Variable | Effect |
|---|---|
| `OWNER_EMAILS` | confers the **owner** tier. Env-only by design — a database edit cannot grant the irreversible powers ([ADR-002](../decisions/ADR-002-owner-tier-lives-in-the-environment.md)). Defaults to `tenzinwoesel@karmastaff.com` |
| `ADMIN_EMAILS` | seeds admins |
| `ALLOWED_EMAILS`, `ALLOWED_EMAIL_DOMAIN` | lock sign-in down to a list or a domain |
| `AUTO_INVITE_DOMAIN` | who may self-serve an account |

There is no `ADMIN_SIGNUP_CODE`. It was removed: anyone who knew the code could
promote themselves.

### Mail

| Variable | Notes |
|---|---|
| `GATEWAY_URL`, `GATEWAY_TOKEN` | the mail gateway. **Not SMTP** |
| `MAIL_FROM` | the from address |

Without these, three features fail *silently in different ways*: team invites
send no email, follow-back reminders never arrive, and the digest returns
`skipped: "mail is not configured"`. If any one of those is reported, check
these first — it is one cause, not three.

### Scheduled work

| Variable | Notes |
|---|---|
| `CRON_TOKEN` | shared secret for `POST /api/cron/daily`. **Unset ⇒ the route returns 503**, refusing rather than defaulting to open |
| `DIGEST_HOUR` | local hour the digest sends. Default 7 |
| `DIGEST_TZ` | the timezone that hour is judged in |
| `REPORT_TZ` | the timezone a *day* is measured in for the call rollup and report. Falls back to `DIGEST_TZ`, then `America/New_York`. **Changing it moves the boundary only for days rolled up from then on**, not for rows already stored |

The same `CRON_TOKEN` value must also be a **GitHub repository secret**, along
with `APP_URL`. See §The morning knock.

### Zoho telephony

| Variable | Notes |
|---|---|
| `ZOHO_VOICE_ENABLED` | master switch |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` | Self Client credentials |
| `ZOHO_REFRESH_TOKEN` | **a refresh token, not a grant code.** See §Zoho |
| `ZOHO_ACCOUNTS_DOMAIN` | region, e.g. `accounts.zoho.com` |
| `ZOHO_DIAL_MODE` | `copy` or the hand-off |
| `ZOHO_DIAL_URL` | **leave empty.** Empty is the correct production value |
| `ZOHO_DIAL_COUNTRY_CODE` | |

`ZOHO_DIAL_URL` reads `=== undefined` rather than `||`, specifically so that
**blanking it in the dashboard takes effect**. With `||`, an empty string was
indistinguishable from unset and the old behaviour persisted — which is exactly
what happened, and why it looked as if the dashboard was being ignored.

### Scrapers and AI

| Variable | Notes |
|---|---|
| `APIFY_TOKEN` | unset ⇒ job search and LinkedIn research are disabled, not broken |
| `APIFY_LINKEDIN_COMPANY_ACTOR`, `APIFY_LINKEDIN_PROFILE_ACTOR` | which actor to run |
| `ANTHROPIC_API_KEY` | read by `api/_proxy.cjs` |
| `ALLOWED_MODELS`, `MAX_TOKENS_CAP`, `MAX_TOOLS`, `MAX_SEARCH_USES` | the proxy clamps the browser's request; the browser is not trusted |
| `RATE_LIMIT_RPM`, `DAILY_TOKEN_BUDGET` | spend limits |
| `BREAKER_FAILS`, `BREAKER_COOLDOWN` | circuit breaker |
| `RESPONSE_CACHE_TTL` | response cache |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | shared rate-limit state. Without them limits are per-instance |
| `RESEARCH_MODEL`, `RESEARCH_DAILY_CAP` | the briefing |
| `NWS_USER_AGENT` | the weather service asks for a contact address and may throttle without one |

### Escape hatches

| Variable | Effect |
|---|---|
| `LEADS_ENABLED=0` | unmount Karma Leads with no code change |
| `LEADS_APP_PATH` | where Leads is served |
| `KARMA_NO_SWEEP` | disable background sweepers |
| `KARMA_DEMO` | demo data |
| `DEV_AUTH_EMAIL`, `DEV_AUTH_ROLE` | local sign-in bypass. **Never set in production** |

### ⚠️ `render.yaml` no longer describes the service

The blueprint is stale and will mislead you. It still documents **WorkOS as
Leads' sign-in** and `SESSION_SECRET` sealing a `kl_session` cookie — that was
replaced by the shared `kc_session` JWT. And it does not mention `OWNER_EMAILS`,
`CRON_TOKEN`, any `ZOHO_*`, `MAIL_FROM`, `GATEWAY_*`, `NWS_USER_AGENT`,
`DIGEST_*`, `RESEARCH_*` or the Apify actor variables — all of which the running
service needs.

Treat the Render dashboard as the truth and this document as the map. `DECISION
REQUIRED`: bring `render.yaml` up to date or delete it. A blueprint that would
deploy a broken service is worse than no blueprint.

### Rotating a secret

1. Add the new value in Render **alongside** the old where the code accepts
   both; otherwise expect the restart to sign people out.
2. `AUTH_JWT_SECRET` signs out every session in both halves. Do it deliberately,
   not at 3pm.
3. `CRON_TOKEN` must be changed in **two** places — Render and the GitHub
   repository secret. Changing one gives a 403 on the next knock.
4. Never paste a placeholder. `YOUR_CLIENT_ID`, `<from the other service>` and a
   Zoho grant code have all reached production here.

---

## Checks

### Is it up?

```bash
curl -s https://karma-connect-9s2z.onrender.com/api/health
```

Free plan: the **first** request after idle takes about 50 seconds to wake the
process. A timeout is not an outage. Ask twice.

### Is it serving the build you think?

```bash
curl -s https://<host>/leads/ | grep -o 'app\.js?v=[a-z0-9]*'
```

Compare against a local hash of `leads/public/app.js`. If they differ, the
deploy has not landed — or you are talking to the old service.

### Is the database healthy?

```sql
SELECT count(*) FROM leads WHERE deleted_at IS NULL;         -- ~36,619
SELECT name, applied_at FROM schema_migrations ORDER BY name; -- 10 rows
SELECT pg_size_pretty(pg_database_size(current_database()));  -- 114 MB
```

The full set of diagnostic queries is in
[DATABASE.md](../architecture/DATABASE.md#queries-worth-keeping).

### Is CI green?

It exists — `.github/workflows/ci.yml`, on push to `main` and on every PR:
`npm ci`, `npm run lint`, `npm test`, `npm run build`. Locally, as of
2026-09-28: lint 0 errors (1 warning), **116 tests passing** in under a second,
build clean.

```bash
npm run lint && npm test && npm run build
```

---

## The morning knock

**One knock, three jobs.** GitHub Actions calls `POST /api/cron/daily` twice a
day — `11:00` and `12:00` UTC, because cron is UTC and has no idea about
daylight saving, so one of the two is 7am Eastern. That single request does:

| Job | What it does | Claimed as |
|---|---|---|
| **Storm digest** | severe-weather states joined to the lead base, mailed to **everyone** | `storm-digest` |
| **Call report** | rolls yesterday into `call_daily`, then mails yesterday's per-person calls and connections to **admins and the owner** | `call-digest` |
| Follow-back sweep | flushes reminders that fell due overnight | — |

Each digest claims its own row in `job_runs`, so a failure in one never
silently swallows the other, and the storm digest's "nothing active today, no
email" does not stop the call report going out.

The storm digest checks the real local hour in `DIGEST_TZ` and only sends at
`DIGEST_HOUR`; the second knock is then a no-op.

**The call report differs in one deliberate way: it sends even on a zero day.**
A silent floor is exactly what a manager needs to be told about, so that email
*is* the signal. The storm digest stays quiet on a calm morning, because a
daily "nothing happened" is a message people learn to delete.

It reports **yesterday**, not today — at 7am today has barely started. The
rollup runs before the send, so the email and the screen read the same stored
rows and cannot disagree.

This is external because Render's free plan stops the process after ~15 minutes
idle. At 7am nobody has touched the site since the night before, so a
`setInterval` inside the app is not running and fires nothing
([ADR-003](../decisions/ADR-003-scheduled-work-is-triggered-from-outside.md)).

**Current state: `job_runs` is empty. No scheduled digest has ever been sent.**

### Diagnosing it

Do this in order — each step rules out the one below.

```bash
# 1. Are the GitHub secrets set? If not the workflow emits a notice and stops.
#    Settings → Secrets and variables → Actions → APP_URL, CRON_TOKEN
gh secret list

# 2. Knock by hand, forced, to one address. force skips the hour check and
#    does NOT claim the day, so it is safe to repeat.
curl -s -X POST "$APP_URL/api/cron/daily" \
  -H 'Content-Type: application/json' -H "x-cron-token: $CRON_TOKEN" \
  -d '{"force":true,"only":"you@karmastaff.com"}'
```

Read the reply. It tells you exactly which gate stopped it:

| Response | Meaning | Fix |
|---|---|---|
| `503 CRON_TOKEN is not set` | not set on Render | set it |
| `403 bad token` | Render and GitHub disagree | make them match |
| `404` | wrong `APP_URL` | fix the secret |
| `skipped: "mail is not configured"` | no `GATEWAY_URL` / `GATEWAY_TOKEN` | set them |
| `skipped: "it is 14:00 in …"` | working correctly, wrong hour | use `force` to test |
| `skipped: "already sent today"` | working correctly | — |
| `skipped: "nothing active"` | working correctly — **a quiet day sends no email** | — |
| `skipped: "weather feed unavailable"` | NWS/FEMA is down or throttling | set `NWS_USER_AGENT`; retry |
| `{sent: 11, …}` | it worked | — |

That last "skipped" is deliberate and worth knowing before you file a bug: **a
quiet morning gets no email.** A daily message saying "nothing happened" is a
daily message people learn to delete, and then they delete the one that
mattered.

```sql
-- 3. did a real (non-forced) run ever land?
SELECT job, ran_on, ran_at, detail FROM job_runs ORDER BY ran_at DESC LIMIT 5;
```

A forced run never writes a row. If you only ever test with `force`, this table
stays empty and that is correct.

### If the workflow emails a red failure

The workflow is written not to fail when it is merely unconfigured — it emits a
notice and stops. "Nobody has set it up yet" is not a broken build, and mailing
a red failure twice a day for it only teaches people to ignore the alerts that
matter. So a red run means a real failure: read the step output, which prints
the HTTP code and the body.

---

## Zoho telephony

**Understand this before touching anything: the current blocker is a licence
tier, not code.** Zoho *Telephony* agents are denied the Voice softphone. No
token, scope or configuration change fixes that. The app already degrades
correctly — it copies the number to the clipboard and says so.

Every one of the following has been a real incident here.

| Symptom | Cause | Fix |
|---|---|---|
| `Invalid OAuth scope` | the token was minted asking for `ZohoVoice.sdk.READ` | mint with `.ALL`. `npm run zoho:token` |
| Every token reads as read-only | a literal `0x08` byte inside the scope regex — a shell heredoc ate a backslash, so `\b` became a control character | fixed; found with `od -c`. Do not write regexes through heredocs |
| `invalid_code` | a **grant code** was pasted into `ZOHO_REFRESH_TOKEN` | exchange the grant code for a refresh token first. The error's `refreshTokenPrefix` identifies this |
| `Access Denied` on the dialler page | our fallback opened `voice.zoho.com`, the exact page a Telephony licence denies | fixed — copy-only |
| Windows app-chooser, no Zoho in it | `ZOHO_DIAL_URL=tel:{number}`; Zoho is not a registered `tel:` handler | **blank `ZOHO_DIAL_URL`** |
| Blanking it changed nothing | `||` treated empty as unset | fixed to `=== undefined`; empty is now the default |

### Checking the Zoho state

```bash
curl -s "$APP_URL/api/voice/config" -H "Cookie: kc_session=<a real session>"
```

This reports whether Voice is enabled and which scope was actually granted —
which is the question, and is not answerable by reading the dashboard.

### Outstanding

- `ZOHO_DIAL_URL` should be **deleted** in Render. If it still holds
  `tel:{number}`, reps get the app-chooser.
- The licence decision is the user's: Zoho Voice seats cost money, and the
  connect-rate metric in the call report needs one.

---

## Common incidents

### "The members can't see the new section"

Almost always the **old service**. Ask for the URL in their address bar before
anything else. Then compare the `?v=` each host is serving.

### "The follow-back email went to the wrong person"

Fixed. The UI promised "your inbox" while the server used `lead.owner`, so the
reminder went to whoever owned the lead. Now uses the caller's identity. Row 5
in `lead_followups` predates the fix.

### "The invite didn't send"

`POST /api/users` originally only inserted a row. It now sends mail and the UI
reports delivery. If it still fails, the cause is `GATEWAY_URL` /
`GATEWAY_TOKEN`.

### "A rep has no leads"

Check whether their leads are assigned to an address with no account:

```sql
SELECT l.owner, count(*) FROM leads l
 WHERE l.owner IS NOT NULL AND l.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM app_users u WHERE lower(u.email)=lower(l.owner))
 GROUP BY 1 ORDER BY 2 DESC;
```

**Right now `abhimanyu@karmastaff.com` owns 2,011 leads and has no account.**
Assignment is free text, not a foreign key.

### "A KPI tile says 412 and opens 380 rows"

The predicate is written three times and one copy was changed: `FOCUS` in
`leads/server/leads.js`, the `FILTER`s in `leads/server/counts.js`, `FOCUS_TEST`
in `leads/public/app.js`. Fix all three.

### "Florida numbers look low"

The base stores `FL` (2,585), `Florida` (613) and `Fl` (1) for the same place.
Counting one spelling under-reports by about 19%. Every state-aware query must
match both.

### "A pane only fills half the window"

Happened below 1080px: `.stats-pane` did not span both grid rows. It affected
every pane, not one.

### The disk is filling

69 MB of the paid 114 MB is abandoned import staging, including two jobs left
`open` since 2026-08-11 holding 54,000 rows. See
[DATABASE.md](../architecture/DATABASE.md#housekeeping-that-is-owed) before
deleting anything.

---

## Working against production safely

**There is no staging copy of the 36,619 leads. The development database is
production.**

- A test row you write is a real row. Give it a distinctive name so you can find
  it again, and clean it up.
- Prefer read-only probes. Most questions are a `SELECT`.
- `KARMA_DEMO` exists for demonstrations; use it rather than editing real leads.
- Before a migration, read it. The paid plan's backups are the only undo.
- Never point a local server at `LEADS_DATABASE_URL` with `DEV_AUTH_EMAIL` set
  and then click around as an owner. The destructive routes are real.

## After making a change

```bash
npx vitest run          # 116 tests, under a second
npm run lint            # CI runs this; 0 errors expected
npm run build           # only needed if you touched src/
node --check <file>     # on anything a script edited
```

Then say what you changed **and what you verified**. "It should work" is not a
report.
