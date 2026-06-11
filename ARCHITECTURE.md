# Karma Connect — Architecture

## Stack
- **Frontend:** React 18 + Vite (single-page app).
- **AI access:** all Anthropic calls go through a **server-side proxy** (`/api/claude`) so the
  API key never reaches the browser. In production that's a Vercel function (`api/claude.js`);
  in local dev a Vite middleware (`vite.config.js`) serves the same path.
- **Auth:** Supabase email + password (open sign-up; optional domain/allowlist lockdown in the proxy).
- **Persistence:** currently per-account `localStorage`; migrating to Supabase Postgres (see below).

## Module layout (`src/`)
| Path | Responsibility |
|---|---|
| `lib/claude.js` | API client → posts to `/api/claude` with the user's Supabase token. |
| `lib/prompts.js` | All prompt templates + `buildContext`. **The brand voice lives here — do not change behavior.** |
| `lib/brand.js` | `SYSTEM`, `BRAND_DNA`, `HUMANIZE`, `STYLE_REF`, `KS_COMPANY`. |
| `lib/senders.js` | The four sender voices. |
| `lib/json.js` | Defensive LLM-JSON parsing (`safeJSON`, `repairJSON`, `extractObjects`). |
| `lib/text.js` | `stripHyphens` (anti-AI-fingerprint), `cleanMessages`, `stripLinkedInNoise`. |
| `lib/history.js` | The **only** call sites for saved-prospect persistence (`listHistory`/`writeHistory`). Swap target for Supabase. |
| `lib/supabase.js` / `lib/localpass.js` | Auth client + local password fallback. |
| `components/` | `AuthGate`, `Loader`, `MsgCard`, icons. |
| `KarmaConnectAI.jsx` | The main app (state + the hub/intel/generation/history views). |
| `api/claude.js` | Server proxy: verifies the Supabase JWT (sig + exp + aud + iss), enforces optional allowlist, forwards to Anthropic. |

## The pipeline (per prospect)
1. **Company research** (optional) — one web-search call fills company fields.
2. **Deep LinkedIn paste** (optional) — `parsePaste` extracts a full profile from pasted page text.
3. **Run AI Analysis** — `pAnalysis` → intelligence profile + fit scores (gates the engines).
4. **Generate** — connection / relationship / meeting / follow-up, each a single right-sized call.
- Every call caches the large system prompt (`cache_control: ephemeral`) and is post-processed by
  `stripHyphens` to remove the AI-fingerprint dashes.

## Data model (Supabase — see `supabase/schema.sql`)
- **`prospects`** — saved-prospect snapshots ("History"). `data jsonb` holds the full snapshot.
  RLS: a row is visible/writable only to `auth.uid() = user_id`.
- **`usage`** — per-user token/cost accounting. Inserted server-side (service role); users read only their own.

## Upgrade roadmap (incremental PRs)
1. ✅ CI (lint + test + build), hardened JWT (`aud`/`iss`), Supabase schema + RLS. — *this phase*
2. Persistence: swap `lib/history.js` to Supabase (localStorage fallback kept). — *Scalability*
3. Proxy: per-user rate limit + token quota (Upstash Redis), 429 backoff + queue. — *Scalability*
4. Refactor: extract `useProspectPipeline` hook; split views; dedupe proxy/dev-middleware. — *Architecture/Maintainability*
5. Server response cache (identical prospect+sender) + per-prospect cost estimate. — *Token Efficiency*
6. Error monitoring (Sentry) on proxy + client. — *Engineering*
7. Styling tokens + a11y (focus states, ARIA, keyboard nav). — *Design*
