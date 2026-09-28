# Karma Staff — documentation

One Render service serves two products that share a sign-in and a website but
not a database. This folder is the source of truth for both.

> **If you are an AI coding agent, read [`ai/PROJECT-MEMORY.md`](ai/PROJECT-MEMORY.md) first.**
> It is short, and it contains the things that are true about this codebase but
> not obvious from reading it.

## The two products in one line each

| | What it is | Lives in | Database |
|---|---|---|---|
| **Karma Connect** | AI prospecting: research a prospect, generate outreach, approve and send it | `src/` (React SPA), `server.js` | `karma-connect-db` (Render, free plan) |
| **Karma Leads** | The lead base the sales floor works: 36,619 companies, people and job postings, assigned to reps who call them | `leads/` (vanilla SPA, no build step) | `karmaleads_database` (Render, paid) |

Both are served by `server.js` on one Render web service. Connect at `/`,
Leads at `/leads`. One sign-in cookie covers both.

## Reading order

**New to the project** → [`PROJECT.md`](PROJECT.md) → [`architecture/ARCHITECTURE.md`](architecture/ARCHITECTURE.md) → the half you are working on.

**About to change code** → [`ai/PROJECT-MEMORY.md`](ai/PROJECT-MEMORY.md) and the `CLAUDE.md` nearest the files you are touching (`leads/CLAUDE.md` is the detailed one).

**Operating it** → [`operations/RUNBOOK.md`](operations/RUNBOOK.md) for what is configured where and what breaks when it is not.

## Index

| Document | What it answers |
|---|---|
| [`PROJECT.md`](PROJECT.md) | What the product is, who uses it, what it is not |
| [`architecture/ARCHITECTURE.md`](architecture/ARCHITECTURE.md) | How the pieces fit, and why there are two of everything |
| [`architecture/DATABASE.md`](architecture/DATABASE.md) | Every table, the invariants, the known data problems |
| [`architecture/API.md`](architecture/API.md) | 133 routes across both halves. **Generated** — `npm run docs:api` |
| [`architecture/SECURITY.md`](architecture/SECURITY.md) | Roles, sessions, what is enforced where, and the known gaps |
| [`architecture/INTEGRATIONS.md`](architecture/INTEGRATIONS.md) | Zoho, Apify, Anthropic, the mail gateway, five public data feeds — and how each one fails |
| [`product/FEATURES.md`](product/FEATURES.md) | What exists, who can reach it, and how you would know it works |
| [`operations/RUNBOOK.md`](operations/RUNBOOK.md) | Environment, deploys, the scheduled job, what to check when something is wrong |
| [`ai/PROJECT-MEMORY.md`](ai/PROJECT-MEMORY.md) | What an agent must know before editing |
| [`ai/AI-RULES.md`](ai/AI-RULES.md) | Rules for changing this codebase |
| [`decisions/`](decisions/) | Why things are the way they are (ADRs) |

## Status of this documentation

Written from the running system, not from a plan: row counts, route counts and
behaviour were read out of the live database and the deployed service. Where
something is genuinely undecided it says `DECISION REQUIRED` rather than
guessing.

Sections not yet written are listed in [`OUTSTANDING.md`](OUTSTANDING.md) with
what each would need to be worth writing. That file is deliberately honest:
half-written documentation is worse than none, because people trust it.
