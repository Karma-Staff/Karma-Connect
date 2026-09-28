# The data

Two PostgreSQL databases, one per product, that never join. Row counts here
were taken from the live `karmaleads_database` on **2026-09-28** and will have
moved; the shapes and the problems will not have.

- `karmaleads_database` — paid plan, **114 MB**, 21 tables, the sales floor
- `karma-connect-db` — free plan, 15 tables, the AI outreach half

They are separate because the products were separate, and the merge was
deliberately app-layer only ([ADR-001](../decisions/ADR-001-merge-at-the-app-layer.md)).
Nothing in either half reaches across. The cost of that is one real wart: the
same person exists in `app_users` *and* in Connect's `users`, added twice, able
to disagree.

---

## How the schema changes

**This is the one part of the two halves that differs in discipline, not just
in style.**

| | Karma Leads | Karma Connect |
|---|---|---|
| Mechanism | `leads/migrations/*.sql` + `node leads/server/migrate.js` | `create table if not exists` at boot |
| Ledger | `schema_migrations` table, 10 rows | none |
| DDL role | `karma_api`, the only one | the app role |
| Can you tell what ran? | yes, with timestamps | no |

Leads' rule is absolute and is in `leads/CLAUDE.md`: **schema changes only via
a migration.** Hand-edits drift and there is no way to notice.

Connect has no migrations. It defines its tables idempotently at start-up,
across `server/db.cjs`, `server/outreach.cjs` and `server/linkedin-agent.cjs`,
and there is *also* a `db/schema.sql`. Nine tables are defined in both places.
See [the drift](#the-connect-drift-is-real) below — it has already happened
once.

### The migrations, and what each one was for

| | Applied | What it added |
|---|---|---|
| `001_core.sql` | 2026-08-11 | `leads`, `lead_keys`, `activity_log`, `app_users`, imports, blocklist — the whole original system |
| `002_company_logo.sql` | 2026-08-12 | `leads.logo_url` |
| `003_trash.sql` | 2026-08-12 | `deleted_at` / `deleted_by`, the 30-day bin |
| `004_enrich_action.sql` | 2026-08-18 | `enrich` added to the `activity_log` action CHECK |
| `005_call_activity.sql` | 2026-09-18 | call logging: the `call` action + `activity_log_call_at_idx` |
| `006_owner_role.sql` | 2026-09-18 | `owner` accepted in `organization_memberships.role` |
| `007_lead_research.sql` | 2026-09-21 | `lead_research`, the prospect briefing |
| `008_followups.sql` | 2026-09-21 | `lead_followups` + the two partial indexes that make reminders safe |
| `009_job_runs.sql` | 2026-09-21 | `job_runs`, so a daily job can be claimed once |
| `010_call_sessions.sql` | 2026-09-22 | `call_sessions`, the campaign dialler |

Migrations 005–010 are all from the last fortnight. That is the shape of this
project right now: a stable core from August, and everything since built on top
of it.

---

## Karma Leads: the tables

Eighteen live, three dead. Grouped by what they are for rather than
alphabetically, because alphabetical tells you nothing.

```
                          ┌──────────────┐
                          │ organizations│ 1
                          └──────┬───────┘
                                 │
  ┌───────────┐          ┌───────▼──────────────────┐
  │ app_users │ 11 ◄─────┤ organization_memberships │ 11
  └─────┬─────┘          │  role: member|admin|owner│
        │                └──────────────────────────┘
        │ user_id
        │
        │      ┌─────────────────── leads ───────────────────┐
        │      │              36,619 · 27 MB                 │
        │      │  the only table that matters                │
        │      └──┬────┬────┬─────┬─────┬──────┬────┬────────┘
        │         │    │    │     │     │      │    │
        ├─ recents│    │    │     │     │      │    └─ company_lead_id
        │   257   │    │    │     │     │      │        (self: a job → its
        │         │    │    │     │     │      │         parent company)
        ├─ lead_comments   │     │     │      │
        │        140      │     │     │      │
        │                 │     │     │      │
   activity_log ──────────┘     │     │      │
      1,506                     │     │      │
    (lead_id, loose)            │     │      │
                                │     │      │
              lead_keys ────────┘     │      │
                47,838                │      │
           (dedupe identity)          │      │
                                      │      │
                    lead_research ────┘      │
                         23                  │
                                             │
                    lead_followups ──────────┘
                          6
```

### The core

**`leads`** — 36,619 rows, 27 MB, 33 columns. Everything else hangs off it.

One table holds three different things, distinguished by `kind`:

| `kind` | Rows | What it is |
|---|---:|---|
| `company` | 33,043 | a restoration or construction firm — the actual target |
| `person` | 2,305 | a named contact, sometimes tied to a company |
| `job` | 1,271 | a job posting, linked to its company by `company_lead_id` |

Notable columns, because the names do not all explain themselves:

| Column | What it really is |
|---|---|
| `lead_code` | the human-facing id, unique, what a rep reads out |
| `phone_key` | the normalised phone; **this is what dedupe and the DNC ban match on**, not `phone` |
| `owner` | free text, holding an email address. Not a foreign key. See [the owner problem](#the-owner-column-is-free-text) |
| `status` | five words, free text with a CHECK. 36,606 rows are still `New` |
| `removed` | a **do-not-call ban**, not a deletion. See below |
| `deleted_at` | the 30-day bin. Every query must filter this |
| `company_lead_id` | a job posting's parent company; self-referencing |
| `certs` | count of certifications — a rough quality signal, used for sorting |

Ten indexes, seven of them partial. The partial ones are not premature
optimisation; each exists because a specific screen was slow:

```sql
leads_status_idx      ON (status)         WHERE NOT removed        -- the KPI tiles
leads_owner_idx       ON (owner)          WHERE owner IS NOT NULL  -- a rep's queue
leads_phone_key_idx   ON (phone_key)      WHERE phone_key IS NOT NULL -- dedupe + DNC sweep
leads_segment_idx     ON (category,state) WHERE kind = 'company'   -- the segment filter
leads_favorite_idx    ON (favorite)       WHERE favorite           -- 'favourites' is tiny
leads_deleted_idx     ON (deleted_at DESC) WHERE deleted_at IS NOT NULL -- the bin
```

The pattern is worth copying: the interesting rows are always the minority, so
the index only covers them.

**`lead_keys`** — 47,838 rows. The dedupe index. Primary key is
`(kind, key_type, key_value)`, so a key can only ever point at one lead. Four
key types, and the split tells you what the data actually has:

| `key_type` | Rows | Reach |
|---|---:|---|
| `phone` | 33,189 | the strongest signal, and the most common |
| `email` | 11,645 | |
| `namecity` | 2,393 | the fallback when there is no phone or email |
| `name` | 611 | weakest; name alone almost never decides a merge |

This table is written by `leads/server/dedupe.js`, which is **identity** and is
load-bearing. Read the comments in it before changing anything: franchises are
not duplicates, and every clause in there was added because it caught a real
bad merge. One SERVPRO manager's email address sits on nine franchises; up to
46 unrelated companies share a single Bitrix placeholder phone number.

**`activity_log`** — 1,506 rows. Append-only. What happened, who did it, and
the before/after values.

| Action | Count |
|---|---:|
| `open` | 1,128 |
| `note` | 148 |
| `call` | 124 |
| `status` | 42 |
| `enrich` | 23 |
| `jobsearch` | 10 |
| `owner` | 10 |
| `remove` | 9 |
| `favorite` / `unfavorite` | 6 / 4 |
| `delete`, `import` | 1 each |

Two things to know. First, `lead_id` is a plain column with no foreign key, and
`lead_code` / `lead_name` are **denormalised on purpose** — the feed must still
read correctly after a lead is purged. Second, the actions are constrained by a
CHECK, which is why adding one takes a migration (004, 005).

`activity_log_call_at_idx` is `(at DESC, actor) WHERE action = 'call'` — the
manager's call report is the only thing that reads it and it only ever wants
calls.

**Bulk actions write one summary row, not three hundred.** `leads/server/bulk.js`
puts the count in `meta.bulk`. Three hundred per-lead rows would bury the feed.

### Working the base

**`call_sessions`** — 10 rows. The campaign dialler. The important column is
`lead_ids bigint[]`: the session **snapshots** the lead ids at the moment it
starts, rather than re-running the filter each time you advance.

That is deliberate. If it re-queried, the list would shift underneath the rep
as they changed statuses — they would skip leads or ring one twice. A snapshot
plus `pos` means "next" is unambiguous.

```sql
call_sessions_open_idx ON (actor) WHERE ended_at IS NULL
```

A unique partial index, so **one open session per person** is enforced by the
database rather than by hope.

**`lead_followups`** — 6 rows. The follow-back reminder. Two partial indexes,
both load-bearing:

```sql
-- at most one open reminder per lead, enforced
lead_followups_open_idx ON (lead_id)
  WHERE sent_at IS NULL AND done_at IS NULL AND cancelled_at IS NULL

-- what the 60-second sweeper reads: only what is still owed
lead_followups_due_idx  ON (due_at)
  WHERE sent_at IS NULL AND cancelled_at IS NULL
```

`owner` is who gets the email. This column caused a real bug: the UI promised
"lands in your inbox" while the server used `lead.owner` — so the reminder went
to whoever owned the lead, not the rep who set it. Fixed to use the caller's
identity. The row at id 5 in the current data is from before that fix.

**`recents`** — 257 rows. `(user_id, lead_id)` primary key, `touched_at`. Both
foreign keys cascade, so it cleans itself up.

**`blocklist`** — 537 rows. The do-not-call list, unique on `phone_key`.

**Removal is not deletion, and this trips people up.** `POST
/api/leads/:id/remove` is a *phone ban*: it blocklists the number and sweeps
`removed = true` across every lead sharing it. `DELETE` is the 30-day bin.
A lead can be removed and not deleted, which is the normal case — 252 rows are
currently `removed`, and `0` are in the bin.

### Ingest

**`import_jobs`** (7) + **`import_rows`** (124,486, **69 MB**) — a two-phase
import. Rows land in `import_rows` as raw `jsonb`, get validated and previewed,
and only then commit into `leads`. `import_rows` cascades on job delete.
`idempotency_key` is unique, which is what makes a retried upload safe.

`leads/server/imports.js` is the **only** bulk ingest path. The Python pipeline
reaches it over HTTP via `KARMA_API_URL` / `KARMA_API_TOKEN` and never touches
Postgres directly. Blank values never overwrite populated ones.

⚠️ **69 MB of the 114 MB database is abandoned import staging.** See
[housekeeping](#housekeeping-that-is-owed).

**`service_tokens`** (1) — hashed tokens for the Python pipeline, with a
`scopes` array and a `revoked_at`. Only the hash is stored.

### Intelligence

**`lead_research`** — 23 rows. The prospect briefing, stored as `jsonb`, with
the `model` that produced it and the `actor` who asked.

```sql
lead_research_current_idx ON (lead_id) WHERE superseded_at IS NULL
```

Unique and partial: **one current briefing per lead**, with the old ones kept.
A re-run stamps `superseded_at` rather than overwriting, so a rep who quotes an
old briefing can be shown what it actually said.

Briefings are stored because they cost money to produce — a paid web call per
lead. Cheap things refresh themselves; expensive things get a button and a row.

**`job_runs`** — `(job, ran_on)` primary key, so a daily job is claimed once
even if the trigger fires twice. Written by `leads/server/digest.js`.

⚠️ **This table is empty.** No daily digest has ever recorded a successful run.
See [housekeeping](#housekeeping-that-is-owed).

### Accounts

**`app_users`** (11) · **`organizations`** (1) · **`organization_memberships`**
(11). One organisation. Role lives on the membership, not the user:

| Role | Count |
|---|---:|
| `member` | 7 |
| `admin` | 3 |
| `owner` | 1 |

`owner` became a legal value in migration 006. Note that the **owner tier is
not defined by this table alone** — `OWNER_EMAILS` in the environment can
confer it, which is what stops a database edit from granting the irreversible
powers. See [ADR-002](../decisions/ADR-002-owner-tier-lives-in-the-environment.md).

`app_users.oidc_sub` is a leftover of the WorkOS era, nullable and mostly unset.

### Dead tables

| Table | Rows | What it is |
|---|---:|---|
| `notification` | 1 | NocoDB residue |
| `workspace` | 1 | NocoDB residue — has Stripe columns, grace periods, plan tiers |
| `workspace_user` | 1 | NocoDB residue — SCIM columns |
| `lead_code_aliases` | 0 | ours, built for a rename path that was never used |

The first three are from when this database was behind NocoDB. Nothing in our
code reads them — grep for the names and you get nothing. They are harmless but
they are confusing: `workspace.stripe_customer_id` in particular has made more
than one person ask whether this product takes payments. It does not.

`lead_code_aliases` is ours and cascades correctly; it is simply unused.

---

## What the schema does not enforce

These are the invariants the application has to keep. A constraint cannot
express any of them, which is why they are written down.

**1. Every query over `leads` filters `deleted_at IS NULL`.** Forget it and
binned leads come back as phantom duplicates. There are `0` binned rows today,
which makes this easy to forget and no less true.

**2. Deleting a company bins its job postings. Deleting a job never touches the
company.** `leads_deleted_company_idx` on `(company_lead_id, deleted_at)` is
what makes restoring that exact sweep possible.

**3. The KPI tile predicates are written three times** — `FOCUS` in
`leads/server/leads.js`, the `FILTER` clauses in `leads/server/counts.js`, and
`FOCUS_TEST` in `leads/public/app.js`. Change one, change all three. A tile
that says 412 and opens 380 rows is worse than no tile.

Blank strings count as missing throughout, because importers write `''` as
readily as `NULL`. Hence `nullif(btrim(col), '') IS NULL` rather than
`col IS NULL`, everywhere.

**4. Bulk actions repeat the single-lead rules; they never shortcut them.** The
bulk DNC still blocklists each number and still sweeps every lead sharing it.

**5. Counting by state must match both spellings.** See below.

---

## Known data problems

Not bugs to be silently "fixed" — these are properties of the data, and code
that pretends otherwise reports wrong numbers.

### State is inconsistent, and a fifth of it is inferred

| | Rows |
|---|---:|
| two-letter code (`FL`) | 31,623 |
| spelled out (`Florida`) | 3,335 |
| blank | 1,661 |

Florida alone, right now:

| Stored value | Rows |
|---|---:|
| `FL` | 2,585 |
| `Florida` | 613 |
| `Fl` | 1 |

**Counting only `FL` under-reports Florida by 614 — about 19%.** Every
state-aware query handles this, and they should keep handling it:

- `leads.js` filter: `(upper(state) = $1 OR state ILIKE $2)`
- `alerts.js` `leadCounts()`: matches both, on `upper(btrim(state))`, then
  folds `FLORIDA` back onto `FL`
- `enrich.js`: compares on the abbreviation

Two further wrinkles. `upper()` covers the `Fl` row. And the base contains
**non-US rows** — one `France`, one `Federal Territory of Kuala Lumpur` — which
no state filter will ever match and which quietly sit outside every regional
count.

**Worse, and undocumented anywhere in the code: roughly a fifth of states were
inferred, not sourced.** The Python `backfill_states()` fills blanks from city,
else from area code: 86% coverage at 96% accuracy. **Expect about 1 in 25
inferred states to be wrong.** Storm watch joins alerts to leads by state, so
this feeds directly into "who do we ring after the tornado". It is good enough
for that and it is not good enough to quote to a customer.

### The `owner` column is free text

`leads.owner` holds an email address as text, matched on equality. There is no
foreign key. That was a pragmatic choice — leads were assigned before accounts
existed — and it has one live consequence:

> **`abhimanyu@karmastaff.com` owns 2,011 leads and has no account.**

Verified: that address appears in no row of `app_users`. So those 2,011 leads —
**6% of the base, the second-largest assignment after unassigned** — are
assigned to nobody who can sign in. No rep sees them in their queue. The one
follow-up reminder booked against that owner (row id 5) can never reach anyone.

Current distribution:

| Owner | Leads | Has an account? |
|---|---:|---|
| *(unassigned)* | 33,357 | — |
| abhimanyu@ | **2,011** | **no** |
| ethina@ | 500 | yes, member |
| abhilasha@ | 300 | yes, member |
| simran@ | 200 | yes, member |
| surbhi@ | 200 | yes, member |
| tenzinwoesel@ | 25 | yes, owner |
| anjan@ | 25 | yes, admin |
| pema@ | 1 | yes, admin |

Four of the eleven accounts own nothing.

The guard against this getting worse is `GET /api/owners`, which returns
accounts plus the owner strings already on leads, so one person cannot become
three owner filters through a typo. **An account's assignable value is its
email, never its display name.**

`DECISION REQUIRED` — what happens to abhimanyu@'s 2,011 leads. Either create
the account or reassign them. Right now they are dark inventory: the largest
single block of assigned leads in the system and nobody is working it.

### 99.96% of leads are still `New`

| Status | Rows |
|---|---:|
| `New` | 36,606 |
| `Contacted` | 9 |
| `Not interested` | 4 |

Two of the five statuses have never been used. This is not a data bug — the
calling workflow is days old — but it means **any funnel metric built on
`status` today is measuring nothing**, and the call report's own numbers (124
logged calls) are the only real activity signal.

### Contactability

| | Rows | Share |
|---|---:|---:|
| have a phone number | 32,039 | 87% |
| have an email | 11,737 | 32% |
| have a website | 8,092 | 22% |
| banned (`removed`) | 252 | 0.7% |

Phone is the channel this base supports. That is why the product is a dialler
and not an email tool, and why `phone_key` carries the dedupe.

Only 22% have a website, which caps `webphone.js` (phone-number scraping) and
the LinkedIn research path — a briefing cannot be produced for a firm with no
web presence. 23 briefings exist against 8,092 possible.

---

## Karma Connect: the tables

Fifteen tables on the free plan. Not queried live for this document — local
`DATABASE_URL` is blank — so the following is **from source**
(`db/schema.sql`, `server/db.cjs`, `server/outreach.cjs`,
`server/linkedin-agent.cjs`) and has no row counts.

| Table | Purpose |
|---|---|
| `users` | Connect's own accounts. `password_hash`, `email_verified`, `is_admin`, reset tokens |
| `prospects` | a saved prospect: `label`, `sub`, and a `data` jsonb blob |
| `lead_approvals` | a member requests a prospect; an admin decides. `assigned_admin_id` |
| `lead_notes` | notes against a prospect |
| `campaigns` → `campaign_steps` → `campaign_enrollments` | multi-step outreach sequences |
| `message_sends` | what was actually sent, including the text, so the coach can learn wording |
| `coach_playbook` / `coach_changes` | the self-tuning outreach coach and its audit trail |
| `outreach_queue` | the send queue. Leased: `lease_id`, `leased_at`, `lease_expires_at`, `attempts` |
| `usage` / `usage_daily` | Anthropic token and cost accounting, per user per day per kind |
| `activity` | Connect's activity feed |
| `linkedin_agent` | LinkedIn automation state |

Two patterns worth noting because they are good:

**`usage_daily`** is a rollup keyed `(user_id, day, kind)` carrying
`input_tokens`, `output_tokens`, `cache_read_tokens`, `cost_usd`, `calls`. AI
spend is visible per person per day without scanning the raw `usage` table.
This is what makes the proxy's cost recording useful rather than decorative.

**`outreach_queue` uses lease-based claiming** — `lease_id` + `lease_expires_at`
+ `attempts`, which is the `FOR UPDATE SKIP LOCKED` pattern done properly. A
worker that dies mid-send does not strand the row; the lease expires and it is
picked up again. `attempts` is what stops a poisonous row retrying forever.

`is_admin` on `users` is a **boolean**, where Leads has a three-tier ranked
ladder. The two halves genuinely have different authorisation models.

### The Connect drift is real

Nine tables are defined in both `db/schema.sql` and `server/db.cjs`. I compared
all nine, ignoring comments:

- `lead_notes`, `usage_daily`, `campaigns`, `campaign_steps`,
  `campaign_enrollments`, `coach_playbook`, `coach_changes` — **identical**
- `message_sends` — **genuinely differs.** `db/schema.sql` declares `message`,
  `personalization` and `acceptance`; the `db.cjs` `create table` does not, and
  three `alter table … add column if not exists` statements
  (`server/db.cjs:132-134`) patch them back on afterwards.

So the drift already happened, and the boot path papers over it. Worse,
`db/schema.sql` is **not a complete schema** — `activity`, `linkedin_agent` and
`outreach_queue` exist only in code, so a database built from that file alone
would be missing the entire send queue.

`DECISION REQUIRED` — Connect's schema management. Options: (a) adopt the Leads
migration runner for Connect too, (b) delete `db/schema.sql` and make the boot
path the single source of truth, (c) leave it. Recommended **(b) now, (a)
later** — (b) is an afternoon and removes a file that is already lying;
(a) is the right end state but nothing is on fire.

---

## Housekeeping that is owed

Three concrete items, all verified, in order of size.

**1. 69 MB of abandoned import staging — 60% of the database.**

| Job | Status | Staged rows |
|---|---|---:|
| `sync 20260811-1106` | **open** | 27,000 |
| `sync 20260811-1108` | **open** | 27,000 |
| `sync 20260811-1109` | committed | 35,242 |
| `sync 20260811-1124` | committed | 35,242 |
| `pipeline-test.csv` | committed | 2 |

Two jobs from 2026-08-11 are still `open` — started, never committed, never
aborted — holding 54,000 staging rows. Two more are committed but their staging
rows were never purged. Deleting the job rows cascades to `import_rows` and
reclaims roughly 69 MB of a 114 MB paid database.

Do not do this blind: confirm the two committed syncs actually landed (35,242
staged against 36,619 live leads is consistent, but confirm) and confirm nobody
intends to resume the open ones. Then delete. There is no automatic purge for
this and there probably should be.

**2. `job_runs` is empty — the 7am digest has never recorded a run.**

The table exists (migration 009, 2026-09-21), `digest.js` writes to it, and it
has zero rows.

Read `runDigest()` carefully before concluding it is broken. The day is claimed
**after** the hour check and the mail check and **before** the send, and a
`force`d run never claims at all. So an empty `job_runs` is consistent with any
of:

1. the GitHub secrets are unset, so the workflow emits a notice and never knocks
2. `CRON_TOKEN` is unset on Render, so the knock gets a 503
3. the knock arrives but the local hour is not `DIGEST_HOUR` — a correct skip
4. mail is not configured (`GATEWAY_URL` / `GATEWAY_TOKEN`) — also skipped early
5. every run so far was `force`d, which deliberately leaves no row

What it does establish is that **no scheduled digest has ever been sent**. That
matters more than the empty table. Diagnosis is in
[RUNBOOK.md](../operations/RUNBOOK.md); the check is one query:

```sql
SELECT * FROM job_runs ORDER BY ran_at DESC LIMIT 5;   -- currently: nothing
```

**3. Three dead NocoDB tables.** `notification`, `workspace`, `workspace_user`.
One row each, read by nothing. Dropping them is a migration and it is safe;
leaving them costs nothing but keeps inviting the question about Stripe.

---

## Queries worth keeping

Diagnostics that have each earned their place. Run them read-only.

```sql
-- assigned to somebody who cannot sign in (found the 2,011)
SELECT l.owner, count(*) FROM leads l
 WHERE l.owner IS NOT NULL AND l.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM app_users u
                    WHERE lower(u.email) = lower(l.owner))
 GROUP BY 1 ORDER BY 2 DESC;

-- is a state split across spellings?
SELECT state, count(*) FROM leads
 WHERE deleted_at IS NULL AND state ILIKE 'f%'
 GROUP BY 1 ORDER BY 2 DESC;

-- did the daily job run?
SELECT job, ran_on, ran_at, detail FROM job_runs
 ORDER BY ran_at DESC LIMIT 10;

-- sessions left open (should be at most one per person, and none overnight)
SELECT actor, started_at, pos, array_length(lead_ids,1) AS total
  FROM call_sessions WHERE ended_at IS NULL;

-- reminders that are due and have not gone out
SELECT id, owner, due_at FROM lead_followups
 WHERE sent_at IS NULL AND cancelled_at IS NULL AND due_at < now()
 ORDER BY due_at;

-- what is actually taking up the paid disk
SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS total
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
 ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10;
```

## A caution

This repository's development database **is** production. There is no staging
copy of the 36,619 leads. Two consequences:

1. A test row you write is a real row. Clean it up, and prefer a distinctive
   name so it can be found again.
2. `migrate.js` runs against live data. Read the migration before applying it,
   and remember that the paid plan's backups are the only undo.
