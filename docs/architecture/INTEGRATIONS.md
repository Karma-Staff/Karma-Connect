# External services

Ten dependencies. For each: what it is for, what it costs, how it fails, and
what the app does when it does.

The governing principle is in [PROJECT.md](../PROJECT.md): **never make the rep
the fallback.** When something outside fails, the app degrades to something
usable and says so, rather than showing an error and stopping.

| Service | For | Cost | Key needed | Failure is |
|---|---|---|---|---|
| Anthropic | prospect briefings, outreach drafting | per token | `ANTHROPIC_API_KEY` | visible, feature stops |
| Zoho Voice | click-to-call | per seat | OAuth refresh token | **degraded, not fatal** |
| Apify | job-board and LinkedIn scraping | per run | `APIFY_TOKEN` | feature disabled |
| Mail gateway | every email the app sends | internal | `GATEWAY_TOKEN` | **silent in three places** |
| NWS `api.weather.gov` | active weather alerts | free | none | named as down |
| FEMA OpenFEMA | declared disasters | free | none | named as down |
| NIFC ArcGIS | active wildfires | free | none | named as down |
| USGS | earthquakes | free | none | named as down |
| NOAA NHC | active tropical storms | free | none | named as down |
| LinkedIn | company and profile research | via Apify | actor id | empty briefing fields |

---

## Anthropic

Reached only through **`api/_proxy.cjs`**, never from the browser. The proxy
exists so the API key never reaches a client, and stays because it is also where
spend is controlled.

It **rebuilds the request** rather than forwarding it — `sanitizeBody()` — so
the browser cannot ask for a model it likes or a token count it invents. The
full clamp table is in [SECURITY.md](SECURITY.md#the-ai-proxy).

| Behaviour | Notes |
|---|---|
| Rate limit | `RATE_LIMIT_RPM`, per caller |
| Daily budget | `DAILY_TOKEN_BUDGET` |
| Circuit breaker | `BREAKER_FAILS` failures opens it for `BREAKER_COOLDOWN` |
| Response cache | `RESPONSE_CACHE_TTL`; keyed on model + system + user text, **never** for tool-using calls, because a live-search answer must not be replayed |
| Cost recording | every call, rolled into `usage_daily` per user per day |
| Shared state | `UPSTASH_REDIS_*`. Without it the limits are per-instance |

**Where it is used.** Prospect briefings (`leads/server/brief.js` builds the
prompt and parses the reply — both are unit-tested without a network) and
Connect's outreach drafting and coach.

**How it fails.** Loudly and locally: the feature returns an error and the rest
of the app is unaffected. The breaker means a broken upstream is not hammered.

> `ALLOWED_MODELS` defaults to `claude-sonnet-4-6,claude-haiku-4-5`. The
> allowlist is the control, so it needs updating when the models in use change —
> a stale list fails closed, which stops the feature rather than overspending.
> Right direction, still an outage.

### The briefing's one rule

An empty field is a correct answer. A fabricated one loses the call in ten
seconds, and the rep will not find out until they are on the phone. Every
briefing carries a confidence rating, and the prompt is built to prefer silence
over invention.

---

## Zoho Voice

**Read this before changing any Zoho code: the current blocker is a licence
tier, not code.** Zoho *Telephony* agents are denied the Voice softphone. No
token, scope, or configuration change fixes that.

### How it is meant to work

A WebRTC softphone that runs **inside the page**, which is why `/leads` gets its
own widened Content-Security-Policy and is the only route granted
`microphone=(self)`. See [SECURITY.md](SECURITY.md#the-csp-is-scoped-per-route-on-purpose).

Auth is an OAuth Self Client: `ZOHO_CLIENT_ID` + `ZOHO_CLIENT_SECRET` +
`ZOHO_REFRESH_TOKEN`, exchanged for short-lived access tokens.
`GET /api/voice/config` reports **which scope was actually granted** — the one
question the Zoho dashboard will not answer.

### How it degrades

The whole hand-off is one function, `dialHandOff()`:

1. If `ZOHO_DIAL_URL` contains `{number}`, open it with the number substituted.
2. Otherwise **copy the number to the clipboard** and say so.

The number is copied in *every* path, including the successful one, because a
rep who can see the digits is never stuck. `ZOHO_DIAL_URL` should be **empty** in
production — copy-only is the working configuration today.

### What has actually gone wrong

Every row here was a real incident, and only one was a code bug in the
integration itself.

| Symptom | Cause |
|---|---|
| `Invalid OAuth scope` | the token was minted asking `ZohoVoice.sdk.READ`, by our own helper script. Now `.ALL` |
| every token read as read-only | a literal `0x08` byte inside the scope regex — a shell heredoc ate a backslash, turning `\b` into a control character. Found with `od -c` |
| `invalid_code` | a **grant code** was pasted into `ZOHO_REFRESH_TOKEN`. The error's `refreshTokenPrefix` identified it |
| `Access Denied` on the dialler | our own fallback opened `voice.zoho.com` — the exact page a Telephony licence denies |
| Windows app-chooser with no Zoho in it | `ZOHO_DIAL_URL=tel:{number}`; Zoho is not a registered `tel:` handler |
| blanking `ZOHO_DIAL_URL` changed nothing | `||` treated empty as unset. Now `=== undefined` |
| "Unauthorized access" on deploy, fine locally | **the CSP**. Development serves no CSP at all, so a host blocked in production was never blocked locally — and the SDK reports a blocked request identically to a refused credential |

The lesson that generalises: *the SDK's error message describes what it
observed, not what went wrong.*

---

## Apify

Two uses, both admin-initiated and both paid per run:

| Use | Actor | Route |
|---|---|---|
| Job-board scraping — finds firms that are hiring, i.e. short-handed | built in | `POST /api/job-search` (admin) |
| LinkedIn company / profile research | `APIFY_LINKEDIN_COMPANY_ACTOR`, `APIFY_LINKEDIN_PROFILE_ACTOR` | the briefing |

`GET /api/apify-usage` reports spend. Because runs cost money, nothing triggers
them automatically — a person presses a button.

**Without `APIFY_TOKEN` these features are disabled, not broken.** The server
says "Apify token not configured — set the APIFY_TOKEN environment variable" and
everything else works. Currently unset, so job search and LinkedIn research are
off.

`leads/server/linkedin.js` normalises actor output shapes and is unit-tested
without a network, because **actors change their output format without
warning** — that is the integration's main long-term risk, and the tests are the
early warning.

### On the LinkedIn scraping

Used in a deliberately limited way, at the user's stated intent. It is
research-before-a-call, one prospect at a time, not bulk harvesting.

---

## The mail gateway

**One way out.** Every email the app sends POSTs to `${GATEWAY_URL}/send` with a
bearer token. Not SMTP.

Eight message types: verification, password reset, approval request, approval
decision, outreach, follow-up reminder, storm digest, team invite.

Good things about it:

- **Idempotency keys** are supported and used where a duplicate would be
  embarrassing — the digest sends `storm-digest-<date>-<recipient>`, so a
  double knock cannot mail the team twice.
- **Errors are mapped to causes**, not passed through: `401` says check
  `GATEWAY_TOKEN`; `403` says the admin must allowlist `MAIL_FROM`; `429`
  reports the `Retry-After`. That saves a hunt through the gateway's own logs.

### Its failure mode is the worst in the system

`emailVerifyOn` is just `GATEWAY_URL && GATEWAY_TOKEN`. When it is false,
**three features fail in three different-looking ways**:

| What a user sees | What actually happened |
|---|---|
| "The invite didn't send" | no gateway |
| "My follow-back reminder never arrived" | no gateway |
| digest reports `skipped: "mail is not configured"` | no gateway |

One cause, three bug reports, none of which mentions email configuration. If any
one of these is reported, check `GATEWAY_URL` and `GATEWAY_TOKEN` **first** —
see [RUNBOOK](../operations/RUNBOOK.md#mail).

---

## The five public data feeds

Storm watch. All five are official, free, and need no key — which is most of why
this feature is worth having.

| Feed | URL | Filter |
|---|---|---|
| NWS active alerts | `api.weather.gov/alerts/active` | the ~20% that mean property damage |
| FEMA disaster declarations | `fema.gov/api/open/v2/DisasterDeclarationsSummaries` | last **45 days** |
| NIFC active wildfires | `services3.arcgis.com/…` | **≥ 100 acres** |
| USGS earthquakes | `earthquake.usgs.gov/…/2.5_day.geojson` | **≥ magnitude 4.0** |
| NOAA NHC storms | `nhc.noaa.gov/CurrentStorms.json` | all active |

Cache 5 minutes, request timeout 20 seconds, `User-Agent` from `NWS_USER_AGENT`
(the weather service asks for a contact address and may throttle without one).

### The thresholds are editorial, and that is the product

Each filter encodes a judgement about what a restoration company can sell into:

- **100 acres** — smaller than that is a local crew's day, not a staffing
  shortage.
- **Magnitude 4.0** — below it, nothing needs restoring.
- **45 days** for FEMA — a declaration stays interesting while cleanup runs,
  which is months, but as a "what just happened" list six weeks is the useful
  window.

Weather alerts are tiered rather than filtered:

| Tier | Meaning | Examples |
|---|---|---|
| **3** | property is being destroyed right now | tornado, hurricane, storm surge, flash flood, ice storm, blizzard, extreme wind |
| **2** | damage likely, crews will be needed | tropical storm, severe thunderstorm, winter storm, high wind, coastal flood, flood, fire warning, red flag, freezing rain |
| **1** | worth watching | winter weather, wind advisory, fire weather, hard freeze, dense smoke |

Matched on the event name *containing* the key, because the NWS emits dozens of
variants — "Tornado Warning", "Tornado Watch", "PDS Tornado Warning" — and a
closed list would miss the one that matters. **Order counts: first match wins**,
so specific sits above general ("flash flood" before "flood").

`NOT_A_STATE` drops marine and coastal-leisure UGC zones (`AM`, `AN`, `GM`, `LC`,
`LE`, `LH`, `LM`, `LO`, `LS`, `PH`, `PK`, `PM`, `PS`, `PZ`, `SL`). A gale warning
on Lake Erie is not restoration work.

### Failing one feed does not fail the feature

```js
const [f, w, q, s] = await Promise.allSettled([fema(), fires(), quakes(), storms()]);
…
down: [["FEMA", f], ["NIFC", w], ["USGS", q], ["NHC", s]]
        .filter(([, r]) => r.status === "rejected").map(([n]) => n),
```

`Promise.allSettled` throughout, and **the response carries a `down` array that
the UI displays**. A partial map that names what is missing is honest; a blank
page or a stale map presented as current is not. This is the product principle —
*say what is not known* — implemented in eight lines.

### What joins it to the product

The feeds answer "where did property just get damaged". The **join to the lead
base** answers "and who do we already have on file there", and that is the part
no generic weather app does. It is also where the data quality caveat bites:
state matching has to handle both `FL` and `Florida`, and roughly a fifth of
states in the base were *inferred* from city or area code at about 96% accuracy.
Good enough to decide who to ring; not good enough to quote. See
[DATABASE.md](DATABASE.md#state-is-inconsistent-and-a-fifth-of-it-is-inferred).

---

## Render

The host, and two of its properties are load-bearing:

**The free plan sleeps the process** after ~15 minutes idle. Consequences:

- the first request after idle takes ~50 seconds — a timeout is not an outage
- **`setInterval` is not a scheduler.** At 7am nobody has touched the site since
  the night before, so anything in-process is not running. Scheduled work is
  triggered from outside by GitHub Actions
  ([ADR-003](../decisions/ADR-003-scheduled-work-is-triggered-from-outside.md))

**Region matters for the database.** `karmaleads_database` is in *virginia*, and
Render's internal connection string only works from the same region. From
elsewhere it must be the external URL — and getting it wrong looks like a hanging
connection, not an auth error.

Also: `render.yaml` is stale and would deploy a broken service. See
[RUNBOOK](../operations/RUNBOOK.md#-renderyaml-no-longer-describes-the-service).

---

## GitHub Actions

Two workflows, both free.

**`ci.yml`** — push to `main` and every PR: `npm ci`, lint, test, build, and the
API-docs drift check.

**`daily-digest.yml`** — knocks on `POST /api/cron/daily` at 11:00 and 12:00 UTC,
because cron is UTC and has no idea about daylight saving, so one of the two is
7am Eastern. The server decides which; `job_runs` makes the other a no-op.

Two details worth copying:

- **It does not fail when it is merely unconfigured.** Missing secrets produce a
  GitHub *notice* and a clean exit. Mailing a red failure twice a day for
  "nobody has set this up yet" only teaches people to ignore the alerts that
  matter.
- **It distinguishes retryable from not.** `401`/`403` (wrong token) and `404`
  (wrong URL) stop immediately and say which; anything else retries three times
  30 seconds apart, because it is most likely a free instance waking up.

---

## Adding an integration

The bar, from the ones above:

1. **State plainly what happens when it is down.** If the answer is "the feature
   errors", say so in the UI. If it is "the rep is stuck", redesign it.
2. **Never let a paid call happen without a person asking.** Apify runs and
   briefings take a button. Free feeds may refresh themselves.
3. **Put the credential in the environment and nowhere else.** Twelve runtime
   dependencies is a feature; do not add an SDK to avoid writing a `fetch`.
4. **Normalise the response in one tested place.** `linkedin.js` exists because
   actors change shape without warning.
5. **Map errors to causes.** "Gateway 403" is a hunt; "the admin must allowlist
   MAIL_FROM" is a fix.
