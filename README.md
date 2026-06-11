# Karma Connect AI

AI-powered LinkedIn prospecting workspace for Karma Staff.

## Setup

### 1. Install Node.js
Download from https://nodejs.org — get the LTS version (18 or higher).

### 2. Open in VS Code
```
File → Open Folder → select the karma-connect folder
```

### 3. Add your API key
In the project root, create a file called `.env` (copy from `.env.example`):
```
VITE_ANTHROPIC_API_KEY=sk-ant-...your key here...
```
Get your key at: https://console.anthropic.com/

### 4. Install dependencies
Open the VS Code terminal (Ctrl+` or Terminal → New Terminal) and run:
```bash
npm install
```

### 5. Start the app
```bash
npm run dev
```

The app opens automatically at http://localhost:3000

---

## Notes

- The API key is stored server-side in `.env` (no `VITE_` prefix) and never committed to git.
- The browser never sees the API key. All AI calls go through a server proxy at `/api/claude`
  (a Vercel function in production, a Vite dev-middleware locally) which verifies the user's
  Supabase login, enforces rate limits + token quotas, records usage, and forwards to Anthropic.
- To stop the server: Ctrl+C in the terminal
- To build for production: `npm run build`
- Lint / test: `npm run lint`, `npm test`

## Architecture & scaling

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map, data model, and request flow,
and [DEPLOY.md](DEPLOY.md) for the team deployment (Vercel + Supabase + optional Upstash).

**Persistence.** Saved prospects (History) live in the Supabase `public.prospects` table,
keyed by `auth.uid()` and protected by Row-Level Security, so history follows each user
across devices and survives a cleared browser. When offline or signed out, the app falls
back to `localStorage` and reconciles to the cloud on the next sign-in. Run
`supabase/schema.sql` once in the Supabase SQL editor to create the tables + policies.

**Rate limiting, quotas, usage.** The proxy enforces per-user requests/minute and a per-user
daily token budget (Upstash Redis), with a global circuit breaker, returning HTTP 429 +
`Retry-After` when limited; the client backs off (jittered exponential) and serializes a
prospect run so it never floods upstream. Each successful AI call records one row in
`public.usage` (input/output/cache-read tokens + computed cost) via the Supabase service-role
key — server-side only. A short Redis response cache de-duplicates identical requests. All of
these are optional and no-op until their env vars are set (see `.env.example`).
