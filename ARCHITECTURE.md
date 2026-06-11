# Karma Connect — Architecture

## Stack
- **Frontend:** React 18 + Vite (single-page app).
- **AI access:** all Anthropic calls go through a **server-side proxy** (`/api/claude`) so the
  API key never reaches the browser. In production that's a Vercel function (`api/claude.js`);
  in local dev a Vite middleware (`vite.config.js`) serves the same path.
- **Auth:** Supabase email + password (open sign-up; optional domain/allowlist lockdown in the proxy).
- **Persistence:** Supabase Postgres (`prospects` table, RLS by `auth.uid()`), with a
  `localStorage` fallback when offline/unauthenticated that reconciles on next sign-in.
- **Reliability/cost:** the proxy enforces per-user rate limits + a daily token quota + a
  global circuit breaker (Upstash Redis), records usage to Postgres, and caches identical
  requests. The client backs off on 429 and serializes each prospect run.

## Module layout (`src/`)
| Path | Responsibility |
|---|---|
| `lib/claude.js` | API client → posts to `/api/claude` with the user's Supabase token; retries 429 (backoff) and serializes calls. |
| `lib/backoff.js` | Pure 429 backoff/retry helpers (unit-tested). |
| `lib/prompts.js` | All prompt templates + `buildContext`. **The brand voice lives here — do not change behavior.** |
| `lib/brand.js` | `SYSTEM`, `BRAND_DNA`, `HUMANIZE`, `STYLE_REF`, `KS_COMPANY`. |
| `lib/senders.js` | The four sender voices. |
| `lib/json.js` | Defensive LLM-JSON parsing (`safeJSON`, `repairJSON`, `extractObjects`). |
| `lib/text.js` | `stripHyphens` (anti-AI-fingerprint), `cleanMessages`, `stripLinkedInNoise`. |
| `lib/history.js` | Saved-prospect persistence: Supabase `prospects` (RLS) + localStorage fallback; paginated (`listHistory`/`writeHistory`/`deleteHistory`). |
| `lib/supabase.js` / `lib/localpass.js` | Auth client + local password fallback. |
| `components/` | `AuthGate`, `Loader`, `MsgCard`, icons. |
| `KarmaConnectAI.jsx` | The main app (state + the hub/intel/generation/history views). |
| `api/_proxy.cjs` | **Shared proxy core** (imported by both entry points so they can't drift): JWT verify (sig/exp/aud/iss), rate limit + token quota + circuit breaker (Upstash), response cache, usage accounting (`computeCost` + service-role INSERT), forward to Anthropic. |
| `api/claude.js` | Thin Vercel function → `_proxy.cjs` with `requireAuth: true`. |
| `vite.config.js` | Dev middleware → the same `_proxy.cjs` with `requireAuth: false` (localhost). |

## The pipeline (per prospect)
1. **Company research** (optional) — one web-search call fills company fields.
2. **Deep LinkedIn paste** (optional) — `parsePaste` extracts a full profile from pasted page text.
3. **Run AI Analysis** — `pAnalysis` → intelligence profile + fit scores (gates the engines).
4. **Generate** — connection / relationship / meeting / follow-up, each a single right-sized call.
- Every call caches the large system prompt (`cache_control: ephemeral`) and is post-processed by
  `stripHyphens` to remove the AI-fingerprint dashes.

## Data model (Supabase — see `supabase/schema.sql`)
- **`prospects`** — saved-prospect snapshots ("History"). `data jsonb` holds the full snapshot.
  RLS: a row is visible/writable only to `auth.uid() = user_id`. Indexed by `(user_id, updated_at desc)`.
- **`usage`** — per-user token/cost accounting (input/output/cache-read tokens + `cost_usd`).
  Inserted server-side with the service-role key (bypasses RLS); users may read only their own.

## Request flow (`/api/claude`)
1. Client (`lib/claude.js`) posts the Anthropic request body to `/api/claude` with the user's
   Supabase access token; calls are serialized (queue) and retried on 429 (jittered backoff).
2. Proxy (`api/_proxy.cjs`) verifies the JWT (signature, exp, `aud`, `iss`), checks the
   allowlist, then the circuit breaker → per-user rate limit → daily token quota.
3. Cache check: identical `(model, system, user)` within the TTL returns the cached response
   (live web-search calls are never cached).
4. Forward to Anthropic with the server-only key. On success, parse `usage`, `computeCost`,
   INSERT one `usage` row, and roll the daily quota counter. On limit → 429 + `Retry-After`.

## Verifying production behavior
- **Cross-device history:** run `supabase/schema.sql`; sign in on two browsers → saves appear on both; clearing one browser doesn't lose data.
- **Rate limit:** burst > `RATE_LIMIT_RPM` requests → 429 with `Retry-After`; the client recovers.
- **Usage:** each successful AI call → exactly one row in `public.usage` with non-zero `cost_usd`.
- **Secrets:** `grep -r sk-ant dist/` and any `service_role`/JWT-secret string returns nothing.

## Upgrade roadmap
1. ✅ CI (lint + test + build), hardened JWT (`aud`/`iss`), Supabase schema + RLS.
2. ✅ Persistence on Supabase (`prospects`, RLS, paginated, localStorage fallback + reconcile).
3. ✅ Proxy rate limit + token quota + circuit breaker (Upstash) + 429 backoff + serialized client queue.
4. ✅ Shared proxy core (`_proxy.cjs`) — Vercel function + dev middleware can't drift.
5. ✅ Live usage accounting + server response cache.
6. Remaining: per-prospect cost **estimate** in the UI; Sentry monitoring; extract `useProspectPipeline` hook.
