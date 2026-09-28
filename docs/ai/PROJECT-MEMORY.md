# PROJECT MEMORY — read before modifying the codebase

Everything here is true of the running system and **not obvious from reading
the code**. Most entries exist because something already went wrong.

---

## 1. There are two products, two databases, and two user tables

| | Karma Connect | Karma Leads |
|---|---|---|
| Code | `src/` (React + Vite), `server.js` | `leads/` (vanilla JS, **no build step**) |
| Served at | `/` | `/leads` |
| Database | `DATABASE_URL` → `karma_connect` | `LEADS_DATABASE_URL` → `karmaleads_database` |
| Users table | `users` (uuid ids, `is_admin` bool) | `app_users` + `organization_memberships` (int ids, `role` text) |

**Nothing syncs the two user tables.** Making somebody an admin in Connect does
not make them an admin in Leads. This is the most common source of "why can't
they see X". It is a known wart, not an oversight — the merge was deliberately
at the app layer only.

One sign-in covers both: Connect issues an httpOnly `kc_session` JWT cookie
(`server/session.cjs`) and Leads reads the same cookie (`leads/server/auth.js`).

---

## 2. The role ladder is ranked, and duplicated in three places

`owner > admin > member`. Every gate is "rank at least X", never `=== "admin"`,
or an owner loses access to screens they outrank.

Defined in: `leads/server/auth.js` (`RANK`), `server/auth.cjs` (Connect), and
`leads/migrations/006_owner_role.sql`. Change one, change all three.

**The owner tier lives in `OWNER_EMAILS`, not the database.** Deliberate: it
must survive a wrong row and must not be grantable from inside the app.
Defaults to `tenzinwoesel@karmastaff.com` when unset.

---

## 3. Data facts that will bite you

- **`leads.owner` is free text holding email addresses**, matched on equality.
  Assigning goes through `GET /api/owners` so one person cannot become three
  owner strings. ~2,000 leads sit under `abhimanyu@karmastaff.com`, who has no
  account — those leads are invisible in everyone's My tasks.
- **State is stored two ways**: `FL` and `Florida` are both present for the
  same place. Every query that counts by state must match both spellings or it
  under-reports Florida by 611. See `leads/server/alerts.js` → `leadCounts()`.
- **~1 in 5 states is inferred**, not sourced (from city, else area code).
  86% coverage at 96% accuracy. Nothing in the UI says so.
- **`server/dedupe.js` is identity.** Franchises are not duplicates. Every
  clause in it caught a real bad merge. After any change, re-check counts for
  servpro, stanley steemer, puroclean.
- **Every query over `leads` must filter `deleted_at IS NULL`** or binned rows
  come back as phantom duplicates.
- **Removal ≠ deletion.** `POST /api/leads/:id/remove` is a phone ban that
  sweeps every lead sharing the number. `DELETE` is the 30-day bin.

---

## 4. Things that look broken but are correct

- **`/login-intro.mp4` returns 200** — that is the SPA catch-all serving
  `index.html` for an unknown path. The file was deleted.
- **Everyone shows 0 assigned on the Call report** — accurate. The assigned
  leads belong to an owner string with no account (see above).
- **Canada is on the Storm watch map and never lights up** — the alert feed is
  the US National Weather Service. Environment Canada has no API, and the base
  holds 8 Canadian leads out of 36,619.
- **The Zoho "Notes/Disposition" panel may refuse to save** — that is Zoho's
  own panel writing to Zoho. Notes typed in Karma Leads are unaffected.

---

## 5. Zoho is a licence problem, not a code problem

The sales team are **Zoho Telephony** agents. The in-page softphone needs
**Zoho Voice**, a different paid product. Without it:

- the softphone cannot authenticate → the app degrades to copying the number
- auto-dial and hang-up-to-advance are unavailable (they need call events)
- the Call report shows calls but not connect rates

`voice.zoho.com` answers those accounts with **Access Denied**, so it must
never be used as the fallback — that was a real bug. `ZOHO_DIAL_URL` unset now
means *nothing opens*, and the number is copied.

`tel:{number}` is **not** a fix here: checked on a real machine, Zoho was not
among the registered `tel:` handlers, so it only produces Windows' app-chooser.

---

## 6. Do not bump the `?v=` cache-busters by hand

`leads/server/cachebust.js` stamps them at serve time from a hash of the real
`app.js` / `app.css` / `na-geo.js` bytes. The numbers left in `index.html` are
markers for a diff and are not load-bearing.

This exists because the manual rule failed: `app.js` shipped twice while
`index.html` still said `v=76`, so every browser that had cached that URL kept
running the old file. Green deploy, correct server, stale reps.

---

## 7. Render is on the free plan, and it sleeps

The process stops after ~15 minutes without a request, so **`setInterval` is
not running at 7am**. Anything scheduled must be triggered from outside:
`.github/workflows/daily-digest.yml` knocks on `POST /api/cron/daily`, which
also flushes follow-back reminders that came due overnight.

The two cron times (11:00 and 12:00 UTC) exist so exactly one lands at 7am
local through daylight saving; `job_runs` (migration 009) makes the day
something you claim once.

---

## 8. Schema changes only via `migrations/` + `node leads/server/migrate.js`

Ten migrations so far. `karma_api` is the only DDL role. Never hand-edit the
schema on a running database.

---

## 9. There is a LinkedIn automation bot in `agent/`

It drives a real browser against LinkedIn from a **local machine** (never the
server — `render.yaml` omits Playwright deliberately). Server-side caps in
`server/linkedin-agent.cjs`: 25/day, 8/hour, 45–180s gaps, weekdays 09:00–17:00,
counted from the database so restarting resets nothing.

`agent/.profile` holds a live signed-in LinkedIn session. It is gitignored.
The repo owner built it and accepts the ToS risk knowingly — this is context,
not a decision to revisit.

---

## 10. Known limitations, stated plainly

| Limitation | Why it is still like this |
|---|---|
| Two user tables, two role stores | The merge was app-layer only, by request. Unifying is a contained job nobody has authorised. |
| Call outcomes are client-reported | Only the browser holding the softphone knows a call ended. A rep dialling from a handset produces no rows. |
| Research is one lookup, not monitoring | Briefings are bought once and stored; nothing re-checks them. |
| Connect's own data is unavailable locally | No `DATABASE_URL` in local `.env`; the dev bypass synthesises a user so the UI renders. |
| The old service is still live | `karma-leads-nocodb.onrender.com` serves frozen old code against the *same* database. Reps who kept the bookmark see a two-week-old app. |

---

## 11. Do-not-change without understanding

- `server/dedupe.js` — identity rules, each clause earned
- `leads/server/auth.js` `resolve()` — the shared-cookie path both products depend on
- `api/_proxy.cjs` — the Anthropic proxy, rate limits, circuit breaker, cost recording
- The partial unique indexes in migrations 008 and 010 — they are what stop
  duplicate reminders and duplicate call sessions
