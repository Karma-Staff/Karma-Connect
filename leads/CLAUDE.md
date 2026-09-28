# CLAUDE.md

Shared sales dashboard for a lead-gen team: Node/Express API + PostgreSQL,
vanilla SPA in `public/`, Python importers in `dashboard/`.

Run: `docker compose up -d` → `node server/migrate.js` → `node server/index.js`
(http://localhost:8080/app). No build step, no linter.

## Invariants (break these and the data lies)

- **Schema changes ONLY via `migrations/` + `node server/migrate.js`.**
  `karma_api` is the only DDL role.
- **`server/dedupe.js` is identity. Franchises are not duplicates**: an email
  match also needs the names to agree (one SERVPRO manager's email sits on nine
  franchises), a phone match yields when names AND emails disagree, name+city
  needs a real city, and `pk()` refuses Bitrix placeholder phones (up to 46
  unrelated companies share one). Every clause is there because it caught a
  real merge — after any change re-check counts per brand (servpro, stanley
  steemer, puroclean). Python twin: `dashboard/setup_v2.py`.
- **Every query over `leads` filters `deleted_at IS NULL`** (trash bin,
  `server/trash.js`, 30-day purge) or binned leads come back as phantom
  duplicates. Deleting a company bins its jobs; deleting a job never touches
  the company.
- **Removal ≠ deletion.** `POST /api/leads/:id/remove` is a phone ban that
  sweeps every lead sharing the number (Manage → DNC). `DELETE` is the bin.
- **KPI tile predicates are written three times** — `FOCUS` in
  `server/leads.js`, the FILTERs in `server/counts.js`, `FOCUS_TEST` in
  `public/app.js`. Change one, change all three, or a tile says 412 and opens
  380.
- **Bulk actions repeat the single-lead rules, they never shortcut them.**
  `server/bulk.js` (`/api/bulk/*`, admin) is assign / DNC / delete over a
  ticked selection: the DNC still blocklists each number and sweeps every lead
  sharing it, the delete still takes a company's job postings and leaves the
  batch on one `deleted_at` so the bin restores exactly that sweep. It writes
  ONE summary row to `activity_log` per action (`meta.bulk`, action names kept
  inside the existing CHECK list) — 300 per-lead rows would bury the feed — and
  touches no recents for the same reason.
- `server/imports.js` is the only bulk *ingest* path — idempotent,
  blank-never-overwrites. The pipeline reaches it through
  `KARMA_API_URL`/`KARMA_API_TOKEN`, never Postgres directly.

## Working here

- Auth: a shared HS256 JWT in the httpOnly `kc_session` cookie, issued by Karma
  Connect and read here by `server/auth.js`. WorkOS (`kl_session`) is still
  accepted as a fallback so pre-cutover sessions are not thrown out, but it is
  no longer how anyone signs in.
  Authorisation is a **ranked ladder** — `owner > admin > member`, compared as
  "at least", never `=== "admin"`. member works leads; admin adds job search,
  imports, users, trash, DNC, Team activity; owner holds the irreversible
  things and is conferred by `OWNER_EMAILS` in the environment, not by the
  database. Enforced server-side — `.admin-only` is presentation only.
- Front end: state in one `S` object; `fromApi()` is the whole snake_case →
  title-case translation; paging is keyset; KPIs are one `/api/counts`.
  The `?v=` cache-busters in `index.html` are **stamped at serve time** from
  the real file contents (`server/cachebust.js`) — you no longer bump them by
  hand, and forgetting to can no longer leave browsers on a stale `app.js`.
  It happened: app.js shipped twice while index.html still said v=76, so every
  browser that had cached that URL kept running the old file. The numbers in
  source are just markers for a diff.
- `leads.owner` is free text matched on equality, and the data holds email
  addresses. Assigning goes through `GET /api/owners` (accounts + the owner
  strings already on leads) so one person can't become three owner filters —
  an account's assignable value is its **email**, never its display name.
- Keep `.env` (compose passwords) and `.env.server` (DATABASE_URL + WorkOS)
  split — nothing that names a database goes in `.env`.

## Known data issues (not bugs to "fix" silently)

- State naming is inconsistent across sources (`FL` vs `Florida`). The API's
  state filter matches both; the stored data is still split.
- **Roughly a fifth of States are inferred, not sourced.** `backfill_states()`
  fills blanks from city, else area code — 86% coverage at 96% accuracy, so
  expect ~1 in 25 inferred states to be wrong. Nothing in the code says this.
