# What is not written yet, and what it needs

Written documentation that is wrong is worse than none, because people trust it.
This file says what is missing and what each section needs before it is worth
writing.

## Written

| Document | Status |
|---|---|
| `README.md` | done |
| `PROJECT.md` | done |
| `architecture/ARCHITECTURE.md` | done |
| `architecture/DATABASE.md` | done — all 21 Leads tables, verified against the live database |
| `operations/RUNBOOK.md` | done — every env var, every incident seen so far |
| `architecture/API.md` | done — **generated** by `scripts/gen-api-docs.mjs`, 133 routes, checked in CI |
| `architecture/SECURITY.md` | done — including a gaps table |
| `architecture/INTEGRATIONS.md` | done — ten services, each with its failure mode |
| `product/FEATURES.md` | done — 17 Leads features, 12 Connect views, with acceptance criteria |
| `ai/PROJECT-MEMORY.md` | done |
| `ai/AI-RULES.md` | done |
| `decisions/ADR-001` … `ADR-004` | done |

## Next

**Every document planned in the first pass is now written.** What remains is not
documentation — it is the actions and decisions listed below, which are the
things documenting the system surfaced.

If more documentation is wanted, the candidates in rough value order are:

| Document | Needs | Notes |
|---|---|---|
| `architecture/FRONTEND.md` | nothing | The 5,700-line `app.js`: the `S` state object, `fromApi()`, keyset paging, where to add a screen. Useful to anyone who has to touch Leads |
| `operations/ONBOARDING.md` | nothing | What a new starter needs on day one, including that they must be added to **two** user tables |
| `decisions/ADR-005…` | a decision to record | ADRs are written when a decision is made, not in advance |

Deliberately still not written: the list at the end of this file.

## Corrections made to earlier drafts

Recorded rather than quietly fixed, because the pattern matters more than the
facts.

| Claim | Reality |
|---|---|
| "There is no CI" | `.github/workflows/ci.yml` has existed since the *Upgrade Phase 1* commit. Lint, test, build, on push to `main` and every PR. Green |
| "104 tests" | 116 |
| `leads/CLAUDE.md`: "Auth: WorkOS AuthKit, `kl_session`" | Shared `kc_session` HS256 JWT from Connect; WorkOS is a fallback only. Corrected in place — AI-RULES sends agents to that file, so it was actively misleading them |
| `job_runs` empty ⇒ "the knock is not arriving" | Too strong. The day is claimed *after* the hour and mail checks and a `force`d run never claims, so five different states produce an empty table. RUNBOOK distinguishes them |

Each was asserted from memory instead of checked. All four were one command away.

## Findings that need a decision or an action

### `DECISION REQUIRED` — 2,011 leads assigned to nobody

`abhimanyu@karmastaff.com` owns 2,011 leads — 6% of the base, the largest block
of *assigned* leads — and has no row in `app_users`. Nobody can see them; the one
follow-up booked against that owner can never be delivered. Either create the
account or reassign. This is dark inventory, not a cosmetic problem.

### `ACTION` — 69 MB of abandoned import staging on a paid plan

60% of the 114 MB database. Two import jobs left `open` since 2026-08-11 holding
54,000 staging rows, plus committed jobs whose rows were never purged. Checklist
in [DATABASE.md](architecture/DATABASE.md#housekeeping-that-is-owed). There is no
automatic purge and there probably should be.

### `ACTION` — no scheduled digest has ever been sent

`job_runs` is empty. Most likely the GitHub repository secrets (`APP_URL`,
`CRON_TOKEN`) are unset, in which case the workflow emits a notice and stops by
design. Diagnosis is five minutes:
[RUNBOOK §The morning knock](operations/RUNBOOK.md#the-morning-knock).

### `DECISION REQUIRED` — `render.yaml` would deploy a broken service

It still documents WorkOS as Leads' sign-in and `SESSION_SECRET` sealing
`kl_session`, and omits `OWNER_EMAILS`, `CRON_TOKEN`, every `ZOHO_*`, `MAIL_FROM`,
`GATEWAY_*`, `NWS_USER_AGENT`, `DIGEST_*`, `RESEARCH_*` and the Apify actors.
Recommended: update it, or delete it. A blueprint that lies is worse than none.

### `DECISION REQUIRED` — Connect has no migrations, and has already drifted

Tables are created at boot across three files, and `db/schema.sql` also exists.
Nine tables are defined twice. `message_sends` genuinely differs between the two,
patched over by three `add column if not exists` statements. `db/schema.sql` is
not even complete — `activity`, `linkedin_agent` and `outreach_queue` exist only
in code, so a database built from that file would have no send queue.
Recommended: **delete `db/schema.sql` now** (an afternoon, removes a file that is
already lying), adopt the Leads migration runner later.

### `ACTION` — three dead NocoDB tables

`notification`, `workspace`, `workspace_user`. One row each, read by nothing.
`workspace.stripe_customer_id` keeps prompting the question of whether this
product takes payments. It does not. Dropping them is a migration and it is safe.

### `DECISION REQUIRED` — retire the old service

`karma-leads-nocodb.onrender.com` is still live, serving frozen code against the
same database. It is why reps reported the new sections were missing. Suspend it
after the checklist in
[RUNBOOK](operations/RUNBOOK.md#-the-old-service-is-still-running).

### `DECISION REQUIRED` — unify the two user tables

Named in `PROJECT-MEMORY.md` as the known wart. Every new starter is added twice
and the two can silently disagree. Recommended: do it, before the team grows past
~15.

### `DECISION REQUIRED` — one design system or two

Connect and Leads have separate colour, spacing and component vocabularies. They
already look like siblings rather than one product. Options: (a) leave them,
document both, accept the seam; (b) extract shared tokens and converge slowly;
(c) unify now. Recommended **(a)** — the seam costs nothing operationally and (c)
is weeks of work with no user-facing gain.

## Fixed in passing

**`api/_proxy.cjs` contained two raw NUL bytes.** They were deliberate — a
delimiter in a cache-key hash — but written as literal bytes rather than
`\u0000` escapes, which made `grep` classify the file as binary and **skip it**.
Consequence: a repo-wide grep silently missed 17 environment variables that only
this file reads, including `ANTHROPIC_API_KEY` and `UPSTASH_REDIS_REST_TOKEN`. A
secret sweep over this repo would have missed them too.

Replaced with `\u0000`. Identical string to JavaScript, so cache keys are
unchanged; 116 tests pass; the file is now text and greppable.

## Deliberately not written, and why

| Section the brief asked for | Why not |
|---|---|
| Payments | The product takes no payments. The Stripe columns are NocoDB residue |
| SMS / push notifications | Neither exists. Email only |
| Mobile app / device matrix | There is no mobile app, and the app is used on desktop by a sales floor. A responsive audit is worth doing; a device support matrix is not |
| Personas (fictional) | The users are eleven named people at one company. Inventing personas would be theatre. `PROJECT.md` describes the three real roles |
| SEO | Both products are behind a sign-in. There is nothing to index |
| i18n | One company, one country, one language |
| Design tokens as one system | Leads has a real token set in `app.css`; Connect has its own in `styles.css`. They are **not** the same system. Documenting them as one would be a lie |
