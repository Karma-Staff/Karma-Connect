# Features

What exists, who can reach it, and how you would know it is working. This
describes the **built** product, not a roadmap — if it is in this file it ships
today.

Each feature has an ID so it can be referred to in a commit or a bug report.
`KL-` is Karma Leads, `KC-` is Karma Connect.

Acceptance criteria are written as things you can check, not as intentions.
Where a criterion is **not** currently met, it says so.

---

## Karma Leads

Thirteen screens. Nine are visible to everyone; four are admin-only, gated
server-side, with `.admin-only` in the CSS as presentation only.

| ID | Screen | Tab | Who |
|---|---|---|---|
| KL-01 | My tasks | `tasks` | everyone |
| KL-02 | Companies | `companies` | everyone |
| KL-03 | People | `people` | everyone |
| KL-04 | Job board | `jobs` | everyone |
| KL-05 | Recent | `recent` | everyone |
| KL-06 | Favorites | `favorites` | everyone |
| KL-07 | Research | `research` | everyone |
| KL-08 | Call session | `camp` | everyone |
| KL-09 | Storm watch | `storm` | everyone |
| KL-10 | Assignments | `assign` | **admin** |
| KL-11 | Call report | `calls` | **admin** |
| KL-12 | Team activity | `stats` | **admin** |
| KL-13 | DNC | `removed` | **admin** |

Plus imports, job search and user management, which are actions rather than
screens.

---

### KL-01 · My tasks

A rep's queue: the leads assigned to them that are still worth calling.

**Acceptance**

- A member sees only leads where `leads.owner` equals their email, trimmed.
- An admin sees everything.
- A lead with no phone number does not appear in a calling queue.
- Removed (`removed = true`) and binned (`deleted_at`) leads never appear.

> ⚠️ **Known**: 2,011 leads are owned by `abhimanyu@karmastaff.com`, which has
> no account, so they appear in nobody's tasks. Not a bug in this feature — see
> [DATABASE.md](../architecture/DATABASE.md#the-owner-column-is-free-text).

### KL-02 / KL-03 / KL-04 · Companies, People, Job board

The lead base, split by `kind`: 33,043 companies, 2,305 people, 1,271 job
postings.

**Acceptance**

- Paging is **keyset**, so page 400 costs the same as page 1.
- The state filter matches **both** `FL` and `Florida` — counting one spelling
  under-reports Florida by about 19%.
- Blank strings count as missing everywhere (`nullif(btrim(col), '')`), because
  importers write `''` as readily as `NULL`.
- A job posting links to its parent company via `company_lead_id`.
- Deleting a company bins its job postings; deleting a job never touches the
  company.

### KL-05 · Recent

The last leads this user opened, per user.

**Acceptance**

- Scoped to the signed-in user (`recents` is keyed `(user_id, lead_id)`).
- Cleans itself up when a lead is purged — both foreign keys cascade.

### KL-06 · Favorites

A flag, indexed partially (`WHERE favorite`) because the set is small.

### KL-07 · Research — the prospect briefing

Before a call, what the firm does, anything recent worth congratulating them on,
who you are speaking to, and what not to raise. Sourced from a LinkedIn scrape
via Apify, drafted through the Anthropic proxy.

**Acceptance**

- **An empty field is a correct answer.** Nothing is invented — a fabricated
  detail loses the call in ten seconds.
- Every briefing carries a confidence rating.
- One current briefing per lead, enforced by a partial unique index
  (`lead_research_current_idx WHERE superseded_at IS NULL`).
- Re-running **supersedes** rather than overwrites, so an old briefing a rep
  quoted can still be produced.
- It costs money, so it takes a button — never automatic.

**Current state**: 23 briefings exist. The ceiling is 8,092 — only 22% of leads
have a website. Also requires `APIFY_TOKEN`, which is unset, so this is
**currently disabled**.

### KL-08 · Call session — the dialler

Work a whole assigned list in one sitting: dial, outcome, note, follow-back,
next.

**Acceptance**

- Starting a session **snapshots** the lead ids into `lead_ids bigint[]`. The
  list cannot shift under the rep as they change statuses — otherwise they skip
  leads or ring one twice.
- **One open session per person**, enforced by a partial unique index
  (`call_sessions_open_idx WHERE ended_at IS NULL`), not by the UI.
- `POST /api/campaign/outcome` logs the call, sets the status, writes the note,
  books the follow-back **and advances** — one request. Four requests are four
  ways to end up half-recorded.
- Auto-dial: the next number is dialled without a click.
- **Hanging up advances.** Ending a call moves to the next lead; the rep does not
  press "next".
- The number is copied to the clipboard on every path, including success, so a
  rep who can see the digits is never stuck.

**Current state**: works. The *softphone* does not, for licence reasons — see
[INTEGRATIONS](../architecture/INTEGRATIONS.md#zoho-voice). Copy-to-clipboard is
the working configuration today, and that is a deliberate degradation rather
than a failure.

### KL-09 · Storm watch

A projected map of the US and Canada showing where property was just damaged,
joined to the lead base.

**Acceptance**

- Five official feeds: NWS alerts, FEMA declarations, NIFC wildfires (≥100
  acres), USGS earthquakes (≥M4.0), NOAA NHC storms.
- Alerts are **tiered 1–3**, not merely filtered; the map colours on the worst
  tier per state.
- Marine and lake zones are excluded — a gale warning on Lake Erie is not
  restoration work.
- Each state shows **how many leads we hold there and how many are unassigned**.
  That join is the point of the feature.
- **A feed that fails is named.** The response carries a `down` array and the UI
  shows it. A partial map that says what is missing is honest; a stale one
  presented as current is not.
- Refreshes every 5 minutes; the feeds are free, so it does not wait to be asked.
- Geometry is real Albers equal-area conic, generated **offline** into a 52 KB
  `na-geo.js` ([ADR-004](../decisions/ADR-004-map-geometry-is-generated-offline.md)).

**Caveat that must stay visible**: roughly a fifth of states in the base were
inferred from city or area code at about 96% accuracy. Good enough to decide who
to ring; not good enough to quote to a customer.

### KL-10 · Assignments *(admin)*

Distribute leads to reps.

**Acceptance**

- Assignable values come from `GET /api/owners` — accounts **plus** the owner
  strings already on leads — so one person cannot become three owner filters via
  a typo.
- An account's assignable value is its **email**, never its display name.
- Bulk assign writes **one** summary row to `activity_log` (`meta.bulk`), not one
  per lead; 300 rows would bury the feed.

**Current state**: 33,357 of 36,619 leads are unassigned.

### KL-11 · Call report *(admin)*

Calls per rep and connect rate, for any day — plus a 30-day history and a
drill-down into one person.

**Acceptance**

- Reads `activity_log` where `action = 'call'`, served by a partial index
  `(at DESC, actor) WHERE action = 'call'`.
- **Any past day can be opened**, read from `call_daily`. The numbers no longer
  reset at midnight.
- **Today is counted live**, every earlier day from the stored rollup, using
  the same expressions — so the screen and the morning email agree.
- The 30-day strip shows **every** day including empty ones. A gap must read as
  "nobody called", never as a missing bar.
- A day is a **local** date in `REPORT_TZ`, not a UTC one, or an evening's work
  lands in the wrong day.
- **Says out loud that it only counts calls made through the app.** A number
  without its caveat gets repeated to a customer.

**Current state**: 232 calls over 30 days; history back to 18 Sept.

### KL-11b · Downloading the report as a PDF *(admin)*

One Download button in the call report header, opening a small panel: period,
detail, go.

**Acceptance**

- Periods: **this week, last week, this month, last month, custom dates**.
  Weeks start **Monday** — a sales week does, and a Sunday start files Monday's
  calls under "last week" every Monday morning.
- Three levels of detail: **totals per person**, **day by day**, **every call**
  with the company named.
- **Scope follows the screen.** On the team report it exports everyone; with a
  person's record open it exports just them, and the panel says which
  ("The whole team" / "Just Surbhi Panwar"). Overall and individual are the
  same endpoint, so they can never disagree about what a call is.
- Somebody who called nothing is a **zero row, not an absence** — the same rule
  the morning email follows.
- **Today is rolled up before any export that includes it**, or a range ending
  today would be short by the day most likely being looked at.
- **PDF**, branded, built with `pdfkit`. Playwright is deliberately not
  installed on the deploy, so there is no browser on the server to print with;
  pdfkit is already a runtime dependency and draws to the response stream.
- **Six headline numbers**, then an activity chart, the table, a card per
  person, how the calls ended, and where the calling went.
- The **activity chart** is one bar per day with the connected share solid —
  height inside the bar, never a second bar beside it, so the two cannot be
  read as separate quantities. Empty days are drawn, because a gap must mean
  "nobody called".
- Only the ends and the busiest day are labelled, and a label is dropped where
  it would print on top of its neighbour.
- Each person gets a **card**: their own run of days on the same scale, their
  rate, and how many companies they reached.
- On an individual report the sixth tile becomes **Days calling**, because the
  rows are days and counting them as people says "3 of 3" and means nothing.
- The header names the **period and the scope**, because a file that has been
  forwarded twice has lost the screen it came from.
- Long company names are **measured and truncated**, not wrapped — rows are a
  fixed height and a wrapped name prints over the row below.
- CSV remains available at `?format=csv` for anyone who wants to pivot it, with
  a UTF-8 BOM, formula-injection guards and phone numbers formatted as text.
- **The caveat travels with the file** — the footer rows say it counts only
  calls placed through the dashboard. A spreadsheet gets mailed on and read by
  someone who never saw the screen.
- Capped at 20,000 rows; a bigger answer is a query, not a file.

### KL-11a · One person *(admin)*

The question a manager asks after "who is calling", which is "what is *this
person* doing". Reached by clicking any row in the call report.

**Acceptance**

- Their daily run for 30 days, the outcome mix, everything else they did
  (calls are one action of eleven — a rep who placed no calls but wrote thirty
  notes was not idle), their last 50 calls **with the company named**, their
  book of leads, and their open follow-ups.
- Days with no calls are included in the average denominator only via
  `activeDays`, so "per active day" cannot be inflated by a quiet week.
- Works for callers who are **not accounts** — owner strings from the old
  system made real calls, and hiding them would make totals disagree with rows.
- Admin only: this is a colleague's work in detail, which is exactly what a
  member may not see.
- A call row links through to the lead, using the same route the activity feed
  uses, and is plain text when the lead has since been purged.

### KL-12 · Team activity *(admin)*

The audit feed: who did what, with before and after values.

**Acceptance**

- `lead_code` and `lead_name` are denormalised on purpose, so the feed still
  reads correctly after a lead is purged.
- Machine callers appear as `service:<name>`, distinguishable from people.
- Actions are constrained by a CHECK, so adding one takes a migration.

### KL-13 · DNC *(admin)*

The do-not-call list.

**Acceptance**

- **Removal is not deletion.** `POST /api/leads/:id/remove` blocklists the
  number and sweeps `removed = true` across **every** lead sharing it.
- Bulk DNC repeats the single-lead rules; it does not shortcut them.
- Lifting a ban is **owner**-only.
- `blocklist` is unique on `phone_key`, the normalised number — not on `phone`.

**Current state**: 537 blocked numbers, 252 leads flagged `removed`.

### KL-14 · Imports

CSV and pipeline ingest.

**Acceptance**

- Two-phase: rows land in `import_rows` as raw `jsonb`, are previewed, then
  commit.
- `idempotency_key` is unique, so a retried upload is safe.
- **Blank never overwrites populated.**
- Dedupe is `dedupe.js` and it is identity: franchises are not duplicates. An
  email match also needs the names to agree (one SERVPRO manager's address sits
  on nine franchises); a phone match yields when names *and* emails disagree;
  `pk()` refuses Bitrix placeholder phones, one of which is shared by up to 46
  unrelated companies.
- The Python pipeline goes through the HTTP API, never Postgres directly, so it
  passes the same validation a human upload does.

> ⚠️ **Gap**: committed staging rows are never purged, and two jobs have sat
> `open` since 11 August. 69 MB of a 114 MB paid database. There is no automatic
> purge and there should be.

### KL-15 · Follow-back reminders

Book a reminder against a lead; it arrives by email when due.

**Acceptance**

- The email goes to **the person who set it**, not the lead's owner. (It did the
  wrong thing once: the UI promised "your inbox" while the server used
  `lead.owner`.)
- At most **one open reminder per lead**, enforced by a partial unique index.
- The sweeper runs every 60 seconds in-process **and** on the external cron
  knock — the knock is what flushes reminders that fell due overnight while the
  free-plan process was asleep.

### KL-16 · The 7am storm digest

**Acceptance**

- Sends at `DIGEST_HOUR` local in `DIGEST_TZ`, judged on the real local hour.
- Claimed once a day via `job_runs (job, ran_on)`, so a double knock cannot
  double-send.
- Claim happens **before** the send, never after: losing a day's digest is a
  missed email, whereas claiming afterwards risks mailing the whole team twice.
- **A quiet day sends nothing.** A daily "nothing happened" message is one people
  learn to delete, and then they delete the one that mattered.
- Goes to everyone with a live account, not just managers — a storm is news
  before it is an assignment.

> ⚠️ **Not currently working.** `job_runs` is empty: no scheduled digest has ever
> been sent. Diagnosis in
> [RUNBOOK](../operations/RUNBOOK.md#the-morning-knock).

### KL-16a · The morning call report *(to admins)*

Every morning, yesterday's calling emailed to the people who run the floor: how
many calls, how many connected, per member.

**Acceptance**

- **Rolls yesterday into `call_daily` first, then mails what it just stored.**
  Not a second query — if the email counted separately it could disagree with
  the screen an hour later, and then nobody trusts either.
- Goes to **admins and the owner only**. The storm digest goes to everyone
  because a storm is news; this is every person's numbers side by side, which
  is a management view. `OWNER_EMAILS` is unioned in, so the owner tier does
  not depend on a database row.
- **People who called nothing appear as a zero, not as an omission.** A list of
  only the active makes an idle day look like a quiet one, and the gap is the
  point.
- Reports **yesterday** — at 7am today has barely started.
- **Sends even on a zero day**, unlike the storm digest. A silent floor is
  precisely what a manager must be told.
- Compares against the **same weekday last week**, not simply the day before,
  so "down 60%" does not appear every Monday until people ignore it.
- Claimed once a day via `job_runs`, under its own job name so a storm-digest
  failure cannot swallow it.
- Says that it counts only calls placed through the dashboard, and names the
  timezone.

### KL-17 · Trash

A 30-day bin.

**Acceptance**

- Every query over `leads` filters `deleted_at IS NULL`, or binned rows return
  as phantom duplicates.
- Restore brings back exactly the sweep that was deleted, including a company's
  job postings (`leads_deleted_company_idx`).
- **Emptying the bin is owner-only and is the one action in the app with no way
  back.**

---

## Karma Connect

The AI outreach half. Twelve views.

| ID | View | What it does |
|---|---|---|
| KC-01 | Dashboard | the landing summary |
| KC-02 | Board | prospects as a working board |
| KC-03 | Approvals | a member requests a prospect, an admin decides |
| KC-04 | Send queue | outreach waiting to go, with lease-based claiming |
| KC-05 | Coach | a self-tuning playbook learned from what was actually sent |
| KC-06 | History | what happened |
| KC-07 | Reminders | follow-ups |
| KC-08 | Notes | notes against a prospect |
| KC-09 | Team activity | Connect's audit feed |
| KC-10 | Usage | **AI spend per person per day** |
| KC-11 | Admin members | user management |
| KC-12 | Settings | |

**Acceptance highlights**

- KC-04: the queue uses `lease_id` + `lease_expires_at` + `attempts`. A worker
  that dies mid-send does not strand the row — the lease expires and it is
  retried; `attempts` stops a poisonous row retrying forever.
- KC-10: `usage_daily` is a rollup keyed `(user_id, day, kind)` with tokens,
  cost and call count, so AI spend is visible per person per day rather than
  arriving as a monthly surprise.
- **A human approves every message before it sends.** This is not marketing
  automation.
- KC-11: appointing an admin and deleting an account are **owner**-only.

---

## Cross-cutting

| ID | | Acceptance |
|---|---|---|
| X-01 | Roles | Three tiers, `owner > admin > member`, checked as "at least". Owner comes from `OWNER_EMAILS`, so a database edit cannot grant it. Verified by a real probe across all three tiers |
| X-02 | Row-level access | A member reaching another rep's lead gets **404, not 403** — a 403 would confirm the lead exists |
| X-03 | Cache-busting | `?v=` is stamped at serve time from the file bytes. Never hand-bumped. It went wrong once and reps ran stale code for days |
| X-04 | KPI tiles | Every tile is a clickable work queue, and the count must equal the rows it opens. The predicate is written in three places and all three must agree |
| X-05 | Degradation | Every integration failure leaves something usable and says what is missing. Copying a number beats a page that says Access Denied |

---

## What is deliberately absent

| | Why |
|---|---|
| Pipelines, forecasts, quotes, deals | Not a CRM. Statuses are five words and that is on purpose |
| Multi-tenancy | One company, one team, one lead base |
| A dialler of our own | Telephony is Zoho's. This app hands it numbers and records what came back |
| Bulk outreach automation | A human approves every message |
| SMS, push notifications | Email only |
| A mobile app | Used on desktop by a sales floor |

---

## How to tell whether the product is working

Not user counts — there are eleven and there always will be.

| Measure | Where | Today |
|---|---|---|
| Calls per rep per day | Call report | 124 logged in total |
| Connect rate | Call report | needs a Zoho Voice seat |
| Leads assigned vs unowned | Assignments | 33,357 unassigned |
| Statuses moving off `New` | anywhere | 13 of 36,619 |
| **Time from a storm to the first call into that state** | not measured | **the number this product exists to move** |

That last row is the honest summary of where the product is: the machinery to
move it is built, and the measurement of it is not.
