# Karma Connect — LinkedIn agent

A local worker that sends the LinkedIn messages you approved in Karma Connect, and pulls each
prospect's title / company / company link off their profile while it's there.

It runs on **your machine**, not on Render. It needs the Chrome profile you signed into, and it
should reach LinkedIn from where you normally work.

## How it logs in

It doesn't. **You sign in by hand, once.** The agent drives a persistent Chrome profile
(`agent/.profile`) and reuses that session for weeks. Your LinkedIn password is never asked for,
never stored, and never sent anywhere.

When the session eventually expires the agent stops and tells you to sign in again — it will not
attempt a login for you. A scripted password login is the strongest automation signal LinkedIn
has, and it stalls on 2FA anyway.

> `agent/.profile/` holds a **live logged-in session**. It's gitignored. Don't copy it around,
> and delete it if the machine changes hands.

## Setup

```bash
npm install                         # picks up playwright (optionalDependencies)
npx playwright install chromium     # one-time browser download

# Karma Connect login — the same one you use in the app
export KC_BASE_URL=https://your-app.onrender.com   # or http://localhost:8787
export KC_EMAIL=you@karmastaff.com
export KC_PASSWORD=...

npm run agent:login   # a Chrome window opens — sign in to LinkedIn, it closes itself
npm run agent         # start the loop
```

On Windows PowerShell, use `$env:KC_EMAIL = "..."` instead of `export`.

Try it safely first:

```bash
npm run agent -- --dry-run   # opens profiles, scrapes, types the message, never presses Send
```

## What it does each cycle

1. Asks the server for work (`POST /api/outreach/agent/lease`).
2. The server checks the caps and hands back at most a few items.
3. For each: open the profile → scrape → **Message** → type the approved body → **Send**.
4. Reports `sent` / `failed` / `halted` back, then waits 45–180s before the next one.

The message text always comes from a queue row **a human approved in Karma Connect**. The agent
never writes or edits message content.

## Limits

Enforced on the **server**, counted from the database — restarting the worker or running two
copies doesn't reset anything. Tune with env vars on the server, not here.

| | default | env |
|---|---|---|
| Sends per day | 25 | `LI_AGENT_PER_DAY` |
| Sends per hour | 8 | `LI_AGENT_PER_HOUR` |
| Gap between sends | 45–180s | `LI_AGENT_MIN_GAP_SEC` / `LI_AGENT_MAX_GAP_SEC` |
| Sending window | 09:00–17:00 | `LI_AGENT_WINDOW_START` / `LI_AGENT_WINDOW_END` |
| Weekdays only | yes | `LI_AGENT_WEEKDAYS_ONLY=false` to allow weekends |
| Batch per lease | 3 | `LI_AGENT_BATCH` |
| Lease expiry | 10 min | `LI_AGENT_LEASE_MIN` |

Raising these raises the risk to the account. They're deliberately low.

## How a send is judged

Clicking Send is not proof it sent, so the agent checks afterwards:

| Situation | Outcome |
|---|---|
| Text found in the thread | `sent` |
| Text still in the composer | `failed` — the click didn't take; safe to retry |
| Composer cleared, text not found in the thread | `unverified` |
| Captcha / security check / limit notice | `halted` |
| No Message button, composer won't open | `failed` — retries, parks after 3 attempts |

`unverified` is the ambiguous one. It marks the row **sent** — deliberately, so it can never be
sent again automatically — attaches a warning visible on the item in the Send Queue, and stops
the agent. Go look at that thread: the message may well have gone out. Double-messaging a
prospect is worse than missing one, which is why it doesn't retry.

## When it stops

The agent **halts itself** — switches off, releases the message, shows the reason in the Send
Queue — the moment LinkedIn pushes back: a captcha, a security check, a "you've reached the
limit" notice, or a signed-out session. It never tries to work around any of them. Sort it out
in your own browser, then hit **Clear & restart** in the Send Queue.

A crashed worker is safe too: the lease expires after 10 minutes and the message goes back to
*ready* rather than being stranded.

## Worth knowing

- Automating LinkedIn is against their User Agreement, whatever the pacing. The caps here reduce
  the risk of a restriction; they don't remove it. Your account, your call.
- Scraped profile data is personal data. It lands on the `outreach_queue` row
  (`prospect_title`, `prospect_company`, `company_url`) and inherits that row's retention.
- The Lead Finder extension in `extension/` is unrelated and still doesn't touch LinkedIn.
