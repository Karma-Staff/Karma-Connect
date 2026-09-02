# Karma Connect — LinkedIn agent

A local worker that sends the LinkedIn messages you approved in Karma Connect, and pulls each
prospect's title / company / company link off their profile while it's there.

It runs on **your machine**, not on Render. It needs the browser profile you signed into, and it
should reach LinkedIn from where you normally work.

## Which browser

**Microsoft Edge by default.** `LI_AGENT_BROWSER` accepts `msedge`, `chrome` or `chromium`, but
the saved session lives in whichever one you signed into — changing it means signing in again.

## How it logs in

Sign in with your LinkedIn **email and password**. Do **not** use "Continue with Google": Google
refuses its sign-in flow inside any automated browser, whatever browser you pick. If your account
has no LinkedIn password because it was created via Google, set one in Settings first.

**You sign in by hand, once** — the agent never logs in for you. It drives a persistent profile
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
npx playwright install chromium     # only needed for the LI_AGENT_BROWSER=chromium fallback

# Karma Connect login — the same one you use in the app
export KC_BASE_URL=https://your-app.onrender.com   # or http://localhost:8787
export KC_EMAIL=you@karmastaff.com
export KC_PASSWORD=...

npm run agent:login   # Edge opens - sign in with EMAIL + PASSWORD, it closes itself
npm run agent         # start the loop
```

On Windows PowerShell, use `$env:KC_EMAIL = "..."` instead of `export`.

Try it safely first:

```bash
npm run agent -- --dry-run
```

A dry run opens each profile, scrapes it, opens the composer and types the message — then
clears the box and stops without sending. It also checks the two things the real path needs
*after* that point, and prints what it found:

```
failed → Jane Doe: Dry run — Send button ok; thread transcript ok; composer cleared
```

If it says `THREAD TRANSCRIPT NOT FOUND`, LinkedIn's markup has moved and every live send would
come back `unverified` — fix the selectors in `send.cjs` before running for real.

## What it does each cycle

1. Asks the server for work (`POST /api/outreach/agent/lease`).
2. The server checks the caps and hands back at most a few items.
3. For each: open the profile → scrape → **Message** → type the approved body → **Send**.
4. Reports `sent` / `failed` / `halted` back, then waits 45–180s before the next one.

Step 3 *navigates* to the profile's `/messaging/compose/` URL rather than clicking the Message
link. LinkedIn floats promo banners ("Reactivate Premium: 50% Off") over the profile that
intercept clicks — a click retries until it times out having done nothing, while a navigation
can't be intercepted.

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
