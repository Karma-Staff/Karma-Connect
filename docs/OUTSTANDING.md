# What is not written yet, and what it needs

Written documentation that is wrong is worse than none, because people trust
it. This file says what is missing and what each section needs before it is
worth writing.

## Written

| Document | Status |
|---|---|
| `README.md` | done |
| `PROJECT.md` | done |
| `architecture/ARCHITECTURE.md` | done |
| `ai/PROJECT-MEMORY.md` | done |
| `ai/AI-RULES.md` | done |
| `decisions/ADR-001` … `ADR-004` | done |

## Next, in value order

| Document | Needs | Notes |
|---|---|---|
| `architecture/DATABASE.md` | nothing — can be generated | 21 tables in Leads, 15 in Connect, 10 migrations. The invariants are already known and half of them are in `leads/CLAUDE.md`. **Highest value remaining.** |
| `operations/RUNBOOK.md` | nothing | What is set where, what breaks when it is not, how to check. Would have prevented several of the last fortnight's incidents. |
| `architecture/API.md` | nothing | 120 routes. Worth generating from the source rather than hand-listing, so it cannot drift. |
| `architecture/SECURITY.md` | nothing | The role matrix is already verified by a real probe across all three tiers. |
| `architecture/INTEGRATIONS.md` | nothing | Zoho, Apify, Anthropic, mail gateway, NWS, FEMA, NIFC, USGS, NHC, LinkedIn |
| `product/FEATURES.md` | nothing | Feature IDs and acceptance criteria for what exists |

## Deliberately not written, and why

| Section the brief asked for | Why not |
|---|---|
| Payments | The product takes no payments. |
| SMS / push notifications | Neither exists. Email only. |
| Mobile app / device matrix | There is no mobile app, and the app is used on desktop by a sales floor. A responsive audit is worth doing; a device support matrix is not. |
| Personas (fictional) | The users are eleven named people at one company. Inventing personas for them would be theatre. `PROJECT.md` describes the three real roles instead. |
| SEO | Both products are behind a sign-in. There is nothing to index. |
| i18n | One company, one country, one language. |
| Design tokens / component library | Leads has a real token set in `app.css`; Connect has its own in `styles.css`. They are **not** the same system. Documenting them as one would be a lie; unifying them is a project. See the decision below. |

## Decisions the documentation cannot make

**`DECISION REQUIRED` — one design system or two.**
Connect and Leads have separate colour, spacing and component vocabularies.
They already look like siblings rather than one product. Options:
(a) leave them, document both, accept the seam;
(b) extract shared tokens and converge slowly;
(c) unify now.
Recommended (a) for now — the seam costs nothing operationally and (c) is weeks
of work with no user-facing gain.

**`DECISION REQUIRED` — unify the two user tables.**
Named in `PROJECT-MEMORY.md` as the known wart. Every new starter needs adding
twice and the two can silently disagree. Recommended: do it, before the team
grows past ~15 people.

**`DECISION REQUIRED` — retire the old service.**
`karma-leads-nocodb.onrender.com` is still live, serving frozen code against
the same database. It is why reps reported "the new sections aren't there".
Recommended: suspend it, after the checklist in `operations/RUNBOOK.md`.

**`DECISION REQUIRED` — CI.**
No automated test run. The suite exists and takes under two seconds.
Recommended: a push-triggered GitHub Actions workflow.
