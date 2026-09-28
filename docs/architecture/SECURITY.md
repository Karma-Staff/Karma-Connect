# Security

What is enforced, where, and why it is that way. Read alongside
[API.md](API.md), which lists the guard on every one of the 133 routes.

The threat model is honest and small: **eleven employees of one company, behind
a sign-in, holding 36,619 commercial contact records and the keys to a phone
system.** There is no anonymous public surface, no customer data, no payments.
The realistic risks are, in order:

1. A credential or token leaking — the Zoho and Apify keys are durable and cost
   money.
2. A member reaching leads that are not theirs, or promoting themselves.
3. An irreversible action taken by someone who should not have it — emptying the
   bin, deleting an account.

Everything below is aimed at those three.

---

## Sign-in

One session for both products: an **HS256 JWT in an httpOnly cookie**.

```
sign in at Connect ──► signJWT({sub, email}, AUTH_JWT_SECRET, 30d)
                         │
                         ▼
         Set-Cookie: kc_session=…; HttpOnly; SameSite=Lax; Path=/
                         │
        ┌────────────────┴────────────────┐
  Connect reads it                  Leads reads it
  server/auth.cjs → users      leads/server/auth.js → app_users
```

| Property | Value | Why |
|---|---|---|
| Cookie | `kc_session` | |
| `HttpOnly` | yes | page scripts cannot read it — the localStorage token it replaced could not claim that |
| `SameSite` | `Lax` | off cross-site requests, but still arrives when someone follows a link in |
| `Path` | `/` | one cookie covers Connect at `/` and Leads at `/leads` |
| `Secure` | production only | a `Secure` cookie on `http://localhost` is silently never stored, which would make local sign-in impossible. Gated on `RENDER` or `NODE_ENV=production` |
| TTL | 30 days | |
| Algorithm | HS256, `AUTH_JWT_SECRET` | the same helpers the AI proxy uses, so there is **one** signing secret rather than two schemes to keep in step |

**Why a cookie and not a bearer token.** Karma Leads' front end never sets an
`Authorization` header — it is vanilla JS that relies on the browser attaching
a cookie by itself. A token in `localStorage` could not be shared with it
without rewriting every call it makes. The cookie is shared for free.

### Verification is done properly

`verifyJWT` in `api/_proxy.cjs`:

- recomputes the HMAC and compares with **`crypto.timingSafeEqual`**, after a
  length check
- rejects an expired `exp`
- rejects a mismatched `iss` when one is expected
- returns `null` rather than throwing — a malformed cookie is "not signed in",
  exactly like no cookie

### Revocation

There is no session store, so there is no per-session revoke. **Rotating
`AUTH_JWT_SECRET` signs everybody out of both halves.** That is the lever; it is
blunt and it works. Use it if a laptop is lost.

### Password handling (Connect only)

`bcryptjs`, cost 12. Note `DUMMY_HASH` in `server/auth.cjs`: a real bcrypt hash
compared against when the email does not exist, so a **missing account takes the
same time as a wrong password**. Without it, response timing enumerates who has
an account.

### WorkOS

Still accepted as a fallback so sessions issued before the cutover are not
thrown out mid-afternoon. Nobody signs in through it now. It was replaced
because it had been set up by someone who left and nobody remaining could
administer it — allowlisting a callback URL was impossible. **An identity
provider only one departed person can operate is a single point of failure, not
a security control.**

---

## Authorisation: a rank ladder, not a set of labels

```js
const RANK = { member: 0, admin: 1, owner: 2 };
const rankOf = (role) => RANK[role] ?? 0;
```

Every check is **"at least"**, never equality:

```js
if (rankOf(req.user.role) < RANK.admin) return res.status(403)…
```

This matters and it is a rule with teeth. `role === "admin"` locks the *owner*
out of admin screens, because an owner is not an admin — they outrank one. An
unknown role falls to `0`, so a typo in the database demotes rather than
escalates.

| Tier | Count today | What it is for |
|---|---:|---|
| `member` | 7 | works the leads assigned to them |
| `admin` | 3 | runs the floor. Everything an admin can do is recoverable or merely costs money |
| `owner` | 1 | the irreversible things |

### The owner tier lives in the environment

```js
const OWNER_EMAILS = (process.env.OWNER_EMAILS ?? "tenzinwoesel@karmastaff.com")
const isOwnerEmail = (email) => OWNER_EMAILS.includes(…)
```

`OWNER_EMAILS` **wins over the stored role, never the other way round**. So:

- write access to `organization_memberships` does not grant the irreversible
  powers — you also need the Render dashboard
- the tier cannot be lost by a bad migration or an accidental `UPDATE`
- changing hands is an environment change, which is logged and deliberate

See [ADR-002](../decisions/ADR-002-owner-tier-lives-in-the-environment.md).

### What only an owner can do

Three routes, and each is chosen on the same test — *can this be undone?*

| Route | Why owner |
|---|---|
| `DELETE /api/trash` | empties the bin. **The only action in the app with no way back** |
| `POST /api/admin/users/:id/role` | appoints admins. An admin who can appoint admins is an owner in all but name, and one compromised account would be enough |
| `DELETE /api/admin/users/:id` | removes a member and cascades their data |

### Admin is not self-served

There is no `ADMIN_SIGNUP_CODE`. It was a single shared string that turned
whoever typed it into an admin: it could not be rotated without locking out the
people who already had it, and it could not be audited, because a shared secret
has no subject. An existing owner promotes people now.

---

## Row-level access: members see only their own leads

`requireOwnLead` in `leads/server/leads.js`, mounted with
`router.use("/api/leads/:id", requireOwnLead)` so it covers every sub-route at
once rather than being repeated and eventually forgotten:

```js
if (rankOf(req.user.role) >= RANK.admin) return next();   // admins see all
const row = await query("SELECT owner FROM leads WHERE id = $1 AND deleted_at IS NULL"…);
if (!row) return res.status(404).json({ error: "no such lead" });
if (row.owner.trim() !== req.user.email.trim())
  return res.status(404).json({ error: "no such lead" });
```

**404, not 403, and that is deliberate.** A 403 confirms the lead exists. A
member probing ids would learn the shape of the base — how many leads there are,
which ids are live — from the difference between the two codes. Both answers are
"no such lead".

Two caveats worth knowing:

- The comparison is on **`leads.owner`, which is free text**, matched by
  trimmed equality on the email. It is not a foreign key. Assignment goes
  through `GET /api/owners` so one person cannot become three owner strings via
  a typo, and an account's assignable value is its **email**, never its display
  name.
- Because it is free text, a lead can be owned by an address with no account —
  and 2,011 currently are. Those are unreachable by every member, which is safe
  but not intended. See
  [DATABASE.md](DATABASE.md#the-owner-column-is-free-text).

---

## How the 133 routes are actually guarded

Counted from [API.md](API.md), which is generated from the route declarations:

| Guard | Routes |
|---|---:|
| signed in | 71 |
| signed in + rate-limited | 2 |
| signed in + own lead | 12 |
| admin *(admins bypass the own-lead check)* | 23 |
| owner | 3 |
| service token *(imports:write)* or admin | 7 |
| rate-limited only, no session | 5 |
| no guard at all | 10 |
| **total** | **133** |

So **fifteen routes are reachable without a session**: ten with no guard, five
behind a rate limiter only. All fifteen are correct — the sign-in flows (you
cannot require a session in order to get one), `/api/health` for Render's
checker, and `/api/cron/daily`. API.md lists them with reasons; a *new* entry in
that list is the thing to look at.

`POST /api/cron/daily` is the interesting one. Its caller is a scheduler, not a
person, so it carries a shared secret in `x-cron-token`, compared in full
against `CRON_TOKEN`, and **returns 503 when `CRON_TOKEN` is unset rather than
defaulting to open**. Failing closed on a missing config value is the right
default and is not free — it has to be written that way.

### The client enforces nothing

`.admin-only` in `app.css` hides buttons. That is presentation. Every check
above is server-side, and the API returns the same answer whether the button was
visible or not. This was **verified by a real probe across all three tiers**,
not assumed.

---

## Machine callers

The Python import pipeline is not a user. It authenticates with a token from
`service_tokens`:

- only the **SHA-256 hash** is stored (`token_hash`, unique); the token itself
  is shown once at mint
- tokens carry a **`scopes` array**, checked per route — `imports:write` for the
  seven ingest routes
- `revoked_at` kills one without touching the others
- `requireScope(scope, requireAdmin)` falls through to the admin-user path when
  the caller is not a service, so the same route serves both a human admin and
  the pipeline
- the actor is recorded as `service:<name>` in `activity_log`, so machine writes
  are distinguishable from human ones in the feed

The pipeline reaches the API over HTTP (`KARMA_API_URL` / `KARMA_API_TOKEN`) and
**never connects to Postgres directly**, so every ingest passes the same
validation and dedupe a human upload does.

---

## HTTP headers

Set for every response in `server.js`:

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` *(production only)* |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` — **except on `/leads`**, where it is `microphone=(self)` |

### The CSP is scoped per route, on purpose

Two policies. Karma Connect and everything else get the strict one:

```
default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none';
img-src 'self' data:; script-src 'self';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com data:; connect-src 'self'
```

`/leads` gets a widened one, because Zoho's click-to-call is a **WebRTC
softphone that runs inside the page**: its SDK is served from `zohostatic.com`
and it talks to Zoho over HTTPS and WebSocket, none of which the strict policy
permits.

The widening is scoped to Zoho's host family — `zoho.com`, `zohoapis.com`,
`zohostatic.com`, `zohocdn.com`, `zohopublic.com`, `zohovoice.com`, plus `wss:`
for signalling — rather than opened to the web. Wildcards are used for
`connect-src` because the signalling and TURN hosts are regional
(`us-relay2.zohovoice.com` and friends) and are not a published fixed list.

**Widening it globally would hand every page in both products the right to load
and talk to a third party, for the sake of one feature on one route.** The
per-route split costs one `req.path` test.

Similarly, the microphone is granted only where a call can happen. Camera and
geolocation are denied everywhere, including `/leads`.

#### A trap that has already cost time

**Development serves no CSP at all** (the whole block is behind `if (!DEV)`),
because Vite serves the HTML in dev. So a CSP problem is invisible locally and
appears only on the deploy — and the Zoho SDK reports a blocked request as
`Unauthorized access`. **A blocked request and a refused credential look
identical from inside the SDK.** If Zoho works locally and fails deployed,
suspect the policy before the token.

---

## The AI proxy

`api/_proxy.cjs` sits between the browser and Anthropic. **The browser is not
trusted with the request body** — `sanitizeBody()` rebuilds it:

| Control | Default | Effect |
|---|---|---|
| `ALLOWED_MODELS` | `claude-sonnet-4-6,claude-haiku-4-5` | a model not on the list is rejected, so the browser cannot ask for an expensive one |
| `MAX_TOKENS_CAP` | 8000 | `max_tokens` is clamped into range, not trusted |
| `MAX_TOOLS` | 2 | the tool array is truncated |
| `MAX_SEARCH_USES` | 4 | each web-search tool's `max_uses` is clamped |
| `RATE_LIMIT_RPM` | — | per-caller request rate |
| `DAILY_TOKEN_BUDGET` | — | spend ceiling |
| `BREAKER_FAILS` / `BREAKER_COOLDOWN` | — | circuit breaker, so a failing upstream is not hammered |
| `RESPONSE_CACHE_TTL` | — | identical requests are served from cache |

Cost is recorded per call and rolled up into `usage_daily`, so AI spend is
visible per person per day rather than arriving as one monthly surprise.

`ANTHROPIC_API_KEY` never reaches the browser — that is the proxy's first
purpose. The clamps are its second: without them, anyone with a session could
run up the bill from the console.

> Keep `ALLOWED_MODELS` current when models change. The allowlist is the
> control, and a stale list fails closed — features stop rather than
> overspend — which is the right direction but still an outage.

### Sign-in rate limits

| Endpoint | Window | Max | Keyed on |
|---|---|---:|---|
| `signin` | 15 min | 12 | IP + email |
| `signup` | 60 min | 8 | IP |
| `resend` | 60 min | 6 | IP + email |
| `forgot` | 60 min | 6 | IP + email |
| `reset` | 60 min | 15 | IP |
| `promote` | 15 min | 8 | user ID |
| `password` | 15 min | 10 | user ID |

Keying sign-in on **IP + email** rather than IP alone means one person fumbling
their password does not lock out a colleague behind the same office NAT, while
still stopping a single address being sprayed.

Without `UPSTASH_REDIS_REST_URL` / `_TOKEN` these counters are per-instance.
With one instance that is the same thing; it stops being true the moment the
service scales out.

---

## Secrets

- `.env` is gitignored. **Nothing in this project's secrets is low-value** —
  they are durable keys to a phone system, a scraping account and a metered AI
  API.
- Never paste a placeholder into a config value. `YOUR_CLIENT_ID`,
  `<from the other service>` and a Zoho **grant code** have each reached
  production here.
- A Zoho grant code is not a refresh token. Pasting the former produces
  `invalid_code`, and the error's `refreshTokenPrefix` is how that was
  identified.
- `DEV_AUTH_EMAIL` / `DEV_AUTH_ROLE` bypass sign-in entirely and print a banner
  saying so at boot. **Never set on a deploy.**

### A grep trap, now fixed

`api/_proxy.cjs` contained two raw NUL bytes — a deliberate delimiter in a
cache-key hash, but written as literal bytes. `grep` therefore classified the
file as binary and **skipped it**, so a repo-wide search silently missed 17
environment variables that only this file reads, including `ANTHROPIC_API_KEY`
and `UPSTASH_REDIS_REST_TOKEN`.

Replaced with `\u0000` escapes — identical to JavaScript, greppable to
everything else. Worth remembering if a secret sweep over this repo ever comes
back suspiciously clean: check for `grep -a`.

---

## Known gaps

Stated rather than glossed.

| Gap | Severity | Notes |
|---|---|---|
| **2,011 leads owned by an accountless address** | medium | not an exposure — they are unreachable by everyone — but it is unmanaged data. See DATABASE.md |
| **No per-session revocation** | low | rotating `AUTH_JWT_SECRET` signs out everybody. Acceptable at eleven users |
| **Two user tables** | medium | a person removed from one may remain in the other. Deprovisioning is a two-step that nothing enforces |
| **The old service is still live** | medium | `karma-leads-nocodb` serves frozen code against the *live* database, so old authorisation logic is still reachable. The strongest argument for suspending it |
| **Rate limits are per-instance without Redis** | low | true today, false the moment it scales |
| **No audit of reads** | low | `activity_log` records `open`, but a member enumerating their own leads is not distinguishable from working |
| **Playwright role probes are not in CI** | low | the three-tier matrix was verified by hand; nothing re-checks it on a change |

The last one is the one to fix first, because it is the only gap where a
*regression* would be silent. Everything else on this list is known and stable.
