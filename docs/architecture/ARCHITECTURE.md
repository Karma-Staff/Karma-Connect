# Architecture

## The shape of it

```
                     ┌──────────────────────────────────────┐
  browser  ────────► │  Render web service: karma-connect   │
                     │  Express 5 (server.js, 1,365 lines)  │
                     └──────────────┬───────────────────────┘
                                    │
             ┌──────────────────────┼──────────────────────┐
             │                      │                      │
     ┌───────▼────────┐    ┌────────▼────────┐   ┌─────────▼─────────┐
     │ Karma Connect  │    │  Karma Leads    │   │  Shared services  │
     │ React SPA      │    │  vanilla SPA    │   │  session.cjs      │
     │ built by Vite  │    │  no build step  │   │  email.cjs        │
     │ served from    │    │  served from    │   │  api/_proxy.cjs   │
     │ dist/          │    │  leads/public/  │   │  (Anthropic)      │
     └───────┬────────┘    └────────┬────────┘   └───────────────────┘
             │                      │
     ┌───────▼────────┐    ┌────────▼────────┐
     │ karma-connect  │    │ karmaleads      │
     │ -db (free)     │    │ _database (paid)│
     │ users,         │    │ leads 36,619    │
     │ prospects,     │    │ activity_log,   │
     │ outreach_queue │    │ app_users, …    │
     └────────────────┘    └─────────────────┘
```

**One process, two products, two databases.** That is the single most
important fact about this system and the source of most of its surprises.

## Why it is like this

The two products were built separately, each with its own database. They were
merged onto one Render service to stop paying for two — and the merge was
deliberately **app-layer only**:

> *"i dont want to merge them fulll i want to make a small button which changes
> it between karma connect and karma lead but i want them both in one website"*

So `leads/server/index.js` exports `mount(app, opts)`, and `server.js` calls it.
The Leads API paths are identical whether it runs standalone or merged, because
`leads/public/app.js` calls them absolutely. That is what let the front end stay
untouched through the cutover.

See [ADR-001](../decisions/ADR-001-merge-at-the-app-layer.md).

## Request routing

| Path | Handled by |
|---|---|
| `/api/auth/*`, `/api/claude`, `/api/admin/*`, `/api/connect/*` | `server.js` (Connect) |
| `/api/leads/*`, `/api/counts`, `/api/alerts`, `/api/campaign/*`, … | `leads/server/*` via `mount()` |
| `/leads/*` | `leads/public/` static, with `index.html` stamped by `cachebust.js` |
| everything else | Connect's SPA fallback — regex excludes `/api/` and `/leads` |

Content-Security-Policy is **scoped per route**: `/leads` gets a policy that
allows Zoho's softphone hosts; everywhere else gets a strict one. Likewise
`Permissions-Policy: microphone=(self)` is only sent on `/leads`.

## Authentication

```
sign in at Connect  →  HS256 JWT  →  httpOnly cookie `kc_session`
                                          │
                     ┌────────────────────┴────────────────────┐
              Connect reads it                          Leads reads it
              (server/auth.cjs)                    (leads/server/auth.js)
              → users table                        → app_users + memberships
```

This replaced WorkOS, which had been set up by someone who left and which
nobody remaining could administer — a change as small as allowlisting a
callback URL was impossible. WorkOS is still accepted as a fallback so
pre-cutover sessions are not thrown out mid-afternoon.

Authorisation is a **rank ladder**: `owner > admin > member`, tested as "at
least", never equality. See [SECURITY.md](SECURITY.md).

## The Leads server, module by module

36 modules in `leads/server/`. Grouped by what they are for:

**Core data**
`db.js` · `leads.js` (list, detail, every mutation) · `counts.js` (the KPI
tiles, one SQL pass) · `dedupe.js` (identity) · `recents.js` · `trash.js`

**Working the base**
`tasks.js` (a rep's queue) · `assignments.js` · `bulk.js` · `campaign.js`
(call sessions) · `calls.js` (call logging + the manager's report) ·
`followups.js` (reminders + the sweeper)

**Bringing data in**
`imports.js` · `import-worker.js` · `jobsearch.js` (Apify) · `enrich.js` ·
`webphone.js` (reads phone numbers off company websites)

**Intelligence**
`research.js` + `brief.js` (the prospect briefing) · `linkedin.js` (Apify
scrape) · `alerts.js` + `hazards.js` (Storm watch, four public feeds) ·
`digest.js` (the 7am email)

**Plumbing**
`auth.js` · `service-auth.js` · `users.js` · `activity.js` · `apify.js` ·
`voice.js` (Zoho) · `cachebust.js` · `migrate.js` · `cli.js` · `demo.js`

## The front ends are deliberately different

**Karma Connect** is React + Vite, built to `dist/`. Conventional.

**Karma Leads has no build step.** One `app.js` (~5,700 lines), one `app.css`,
served as-is. State lives in a single `S` object; `fromApi()` is the whole
snake_case → title-case translation in one place; paging is keyset so page 400
costs the same as page 1.

This is not laziness — it is why a change to Leads can be deployed by pushing a
file, and why the app has survived being moved between two hosting setups. The
cost is no type checking and no module system. Do not "modernise" it without a
reason that survives that trade.

## Scheduled work

| Job | Trigger | Why not a timer |
|---|---|---|
| 7am storm digest | GitHub Actions → `POST /api/cron/daily` | Render free plan sleeps the process; `setInterval` is not running at 7am |
| Follow-back reminders | in-process every 60s **and** on the cron knock | The knock is what wakes it after a night idle |
| Trash purge (30 days) | in-process, every 24h | Best-effort; not time-critical |
| Outreach send tick | in-process (`server/outreach.cjs`) | Only runs while somebody is using the site, which is when it matters |

## Testing

`vitest`, 104 tests. The pure, high-consequence logic is extracted so it can be
tested without a database or a network: `leads/server/brief.js` (prompt +
parsing), `leads/server/linkedin.js` (actor-shape normalising),
`src/lib/*.test.js`, `api/_proxy.test.js`, `server/modules.test.js`.

Integration behaviour is verified by booting the API and driving a real browser
with Playwright — that is how the role matrix, the call session and the storm
map were checked. Those runs are not in CI; they are done by hand.

**`DECISION REQUIRED` — CI.** There is no continuous integration. `vitest` runs
only when somebody types it. Options: (a) a GitHub Actions workflow on push,
(b) leave it. Recommended (a); the workflow file is ten lines and the suite runs
in under two seconds.
