# Karma Connect — Architecture

## Stack
- **Frontend:** React 18 + Vite (single-page app).
- **Backend:** a single always-on Node/Express server (`server.js`) on **Render** that serves the
  built SPA *and* the JSON API. In dev, `npm run dev` runs it alongside Vite (Vite proxies `/api/*`).
- **AI access:** all Anthropic calls go through a **server-side proxy** (`/api/claude`, shared core
  in `api/_proxy.cjs`) so the API key never reaches the browser.
- **Auth:** our own email + password. Accounts live in Postgres (`users`, bcrypt hashes); the server
  mints an HS256 JWT (`AUTH_JWT_SECRET`) that the client sends as a Bearer token. Open sign-up;
  optional domain/allowlist lockdown. No third-party auth service.
- **Persistence:** **Render Postgres** (`prospects` table), with a `localStorage` fallback when
  offline/unauthenticated that reconciles on next sign-in. There is **no row-level security**:
  every query is scoped in `server.js` to the `user_id` from the verified token.
- **Reliability/cost:** the proxy enforces per-user rate limits + a daily token quota + a
  global circuit breaker (Upstash Redis), records usage to Postgres, and caches identical
  requests. The client backs off on 429 and serializes each prospect run.

## Module layout (`src/`)
| Path | Responsibility |
|---|---|
| `lib/claude.js` | API client → posts to `/api/claude` with the user's Bearer token; retries 429 (backoff) and serializes calls. |
| `lib/backoff.js` | Pure 429 backoff/retry helpers (unit-tested). |
| `lib/prompts.js` | All prompt templates + `buildContext`. **The brand voice lives here — do not change behavior.** |
| `lib/brand.js` | `SYSTEM`, `BRAND_DNA`, `HUMANIZE`, `STYLE_REF`, `KS_COMPANY`. |
| `lib/senders.js` | The four sender voices. |
| `lib/json.js` | Defensive LLM-JSON parsing (`safeJSON`, `repairJSON`, `extractObjects`). |
| `lib/text.js` | `stripHyphens` (anti-AI-fingerprint), `cleanMessages`, `stripLinkedInNoise`. |
| `lib/history.js` | Saved-prospect persistence: backend `prospects` via `/api/history` + localStorage fallback; paginated (`listHistory`/`writeHistory`/`deleteHistory`). |
| `lib/auth.js` / `lib/localpass.js` | Backend auth client (signup/signin/JWT, `getAccessToken`) + per-browser local password fallback. |
| `components/` | `AuthGate`, `Loader`, `MsgCard`, icons. |
| `KarmaConnectAI.jsx` | The main app (state + the hub/intel/generation/history views). |

Backend (root):
| Path | Responsibility |
|---|---|
| `server.js` | Express server: serves `dist/`, auth (`/api/auth/*`), history (`/api/history`), usage (`/api/usage`), and `/api/claude`. Owns the `pg` pool; scopes every query by the token's `user_id`. |
| `api/_proxy.cjs` | **Shared proxy core**: JWT sign + verify (sig/exp/aud/iss), rate limit + token quota + circuit breaker (Upstash), response cache, usage accounting (`computeCost` + an injected `recordUsage` hook → Postgres), forward to Anthropic. |
| `db/schema.sql` / `scripts/db-init.mjs` | Plain-Postgres schema (no RLS) + a one-shot applier (`npm run db:init`). |
| `vite.config.js` | Dev only: serves the client and proxies `/api/*` to `server.js`. |

## The pipeline (per prospect)
1. **Company research** (optional) — one web-search call fills company fields.
2. **Deep LinkedIn paste** (optional) — `parsePaste` extracts a full profile from pasted page text.
3. **Run AI Analysis** — `pAnalysis` → intelligence profile + fit scores (gates the engines).
4. **Generate** — connection / relationship / meeting / follow-up, each a single right-sized call.
- Every call caches the large system prompt (`cache_control: ephemeral`) and is post-processed by
  `stripHyphens` to remove the AI-fingerprint dashes.

## Data model (Postgres — see `db/schema.sql`)
- **`users`** — accounts: `email` (unique), `password_hash` (bcrypt), names. Created via `/api/auth/signup`.
- **`prospects`** — saved-prospect snapshots ("History"). `data jsonb` holds the full snapshot.
  `id` is `text` (the client supplies it). Indexed by `(user_id, updated_at desc)`. Isolation is
  enforced in `server.js` (every query filters `user_id = <token sub>`), not by RLS.
- **`usage`** — per-user token/cost accounting (input/output/cache-read tokens + `cost_usd`).
  Inserted server-side by the proxy's `recordUsage` hook; users read their own via `/api/usage`.

## Request flow (`/api/claude`)
1. Client (`lib/claude.js`) posts the Anthropic request body to `/api/claude` with the user's
   Bearer token; calls are serialized (queue) and retried on 429 (jittered backoff).
2. Proxy (`api/_proxy.cjs`) verifies the JWT (signature, exp, `aud`, `iss`), checks the
   allowlist, then the circuit breaker → per-user rate limit → daily token quota.
3. Cache check: identical `(model, system, user)` within the TTL returns the cached response
   (live web-search calls are never cached).
4. Forward to Anthropic with the server-only key. On success, parse `usage`, `computeCost`,
   INSERT one `usage` row, and roll the daily quota counter. On limit → 429 + `Retry-After`.

## Verifying production behavior
- **Cross-device history:** run `npm run db:init`; sign in on two browsers → saves appear on both; clearing one browser doesn't lose data.
- **Rate limit:** burst > `RATE_LIMIT_RPM` requests → 429 with `Retry-After`; the client recovers.
- **Usage:** each successful AI call → exactly one row in `usage` with non-zero `cost_usd`.
- **Secrets:** `grep -r sk-ant dist/` and any `DATABASE_URL`/`AUTH_JWT_SECRET` string returns nothing.

## Upgrade roadmap
1. ✅ CI (lint + test + build), hardened JWT (`aud`/`iss`).
2. ✅ Persistence on Postgres (`prospects`, paginated, localStorage fallback + reconcile).
3. ✅ Proxy rate limit + token quota + circuit breaker (Upstash) + 429 backoff + serialized client queue.
4. ✅ Shared proxy core (`_proxy.cjs`) — Express server + dev proxy can't drift.
5. ✅ Live usage accounting + server response cache.
6. ✅ Self-hosted auth (email+password, JWT) + single Render web service + Render Postgres.
7. ✅ Password reset flow (Resend one-time token → set-new-password page; auto-migrated columns).
8. Remaining: per-prospect cost **estimate** in the UI; Sentry monitoring; extract `useProspectPipeline` hook.
