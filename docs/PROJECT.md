# The product

## In one sentence

Karma Staff sells staffing to restoration and construction firms; this system
finds those firms, tells a salesperson who to ring and what to say, and records
what happened.

## In one paragraph

A restoration company — the people who turn up after a fire, a flood or a storm
— is busiest exactly when it is least able to hire. Karma Staff supplies them
crews. The problem is knowing *which* firm is short-handed *this week*, and
getting to them before a competitor. This system holds 36,619 of those firms,
assigns them to reps, watches the weather and disaster feeds for where damage
just happened, researches a prospect before the call, dials them, records the
outcome, and reminds the rep to follow up. Karma Connect is the AI half that
writes outreach; Karma Leads is the floor the sales team actually works.

## In one page

**Who uses it.** Eleven people at one company. Three roles:

| Role | Who | What they do here |
|---|---|---|
| **member** | a sales rep | Works the leads assigned to them: calls, notes, statuses, follow-backs. Sees nothing else. |
| **admin** | the sales manager | Runs the floor: assigns work, imports leads, runs job searches, reads the whole team's numbers. Everything an admin can do is recoverable or costs money. |
| **owner** | one person | The irreversible things: appointing admins, deleting accounts, emptying the bin, lifting a do-not-call ban. |

**The core loop.**

```
find firms            →  imports, job-board scrapes, storm alerts
  ↓
assign them           →  Assignments board, per rep
  ↓
know who you're ringing → the research briefing: what they do, what to
                           congratulate them on, what not to raise
  ↓
ring them             →  call session: one lead at a time, dial, outcome,
                           note, follow-back — in one press
  ↓
don't lose them       →  follow-back reminder lands in the rep's inbox
  ↓
the manager can see it →  Call report, Team activity
```

**What makes it worth building rather than buying.** Two things a generic CRM
does not do:

1. **Storm watch.** Four official feeds (US National Weather Service, FEMA
   disaster declarations, NIFC active wildfires, USGS earthquakes) filtered to
   the ~20% that mean property was damaged, then *joined to the lead base*. It
   does not answer "what is the weather"; it answers "where did property just
   get damaged, and who do we already have on file there". A tornado through
   Tulsa means every restoration firm nearby is turning work away for want of
   crews, and the first staffing company to ring gets the business.

2. **The briefing.** Before a call, a rep gets what the firm does, anything
   recent worth congratulating them on, who they are speaking to, and what not
   to raise — sourced from a LinkedIn scrape, never invented. An empty field is
   a correct answer; a fabricated one loses the call in ten seconds.

## Non-goals

- **Not a CRM.** No pipelines, forecasts, quotes or deals. Statuses are five
  words and that is deliberate.
- **Not multi-tenant.** One company, one team, one lead base. Nothing is built
  to be sold to anyone else, and building for that would cost more than it
  could return.
- **Not a dialler company.** Telephony is Zoho's. This app hands numbers to it
  and records what came back.
- **Not marketing automation.** Outreach is per-prospect and a human approves
  every message before it sends.

## What success looks like

Not "users" — there are eleven and there always will be. The measures are:

| | Where you can already see it |
|---|---|
| Calls placed per rep per day | Call report |
| Connect rate | Call report (needs a Zoho Voice seat — see PROJECT-MEMORY §5) |
| Leads assigned vs sitting unowned | Assignments; currently ~34k unassigned |
| Time from a storm to the first call into that state | not measured — **the number this product exists to move** |

## Product principles

**Say what is not known.** Every briefing carries a confidence rating, the
storm map names feeds that did not answer, the call report says out loud that
it only counts calls made through the app. A number without its caveat gets
repeated to a customer.

**Never make the rep the fallback.** When something fails — a licence, a feed,
a scrape — the app degrades to something usable and explains it, rather than
showing an error and stopping. Copying the number beats a page that says
Access Denied.

**One press, not four.** The call session logs the call, sets the status,
writes the note and books the reminder in a single request, because four
requests are four ways to end up half-recorded.

**Cheap things cached, expensive things asked for.** A briefing is a paid web
call, so it takes a button and is stored. The storm feed is free, so it
refreshes itself every five minutes.
