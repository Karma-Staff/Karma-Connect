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
ANTHROPIC_API_KEY=sk-ant-...your key here...
```
Get your key at: https://console.anthropic.com/ — note there's **no** `VITE_` prefix, so the
key stays server-side and never reaches the browser. For real cross-device accounts, also set
`DATABASE_URL` (Render Postgres) and `AUTH_JWT_SECRET`; without them the app runs in a
per-browser local mode.

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
  (the Express server `server.js`, both locally and in production) which verifies the user's
  login, enforces rate limits + token quotas, records usage, and forwards to Anthropic.
- `npm run dev` starts **both** the backend (`:8787`) and Vite (`:3000`); open http://localhost:3000.
- To stop the server: Ctrl+C in the terminal
- To build for production: `npm run build` (then `npm start` runs the server that serves it)
- Lint / test: `npm run lint`, `npm test`

## Architecture & scaling

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map, data model, and request flow,
and [DEPLOY.md](DEPLOY.md) for the team deployment (Render + Postgres + optional Upstash).

**Persistence.** Saved prospects (History) live in the `prospects` table on Render Postgres,
scoped server-side to the signed-in user's id (taken from the verified JWT), so history follows
each user across devices and survives a cleared browser. When offline or signed out, the app
falls back to `localStorage` and reconciles to the server on the next sign-in. Run
`npm run db:init` once to create the tables.

**Auth.** Email + password accounts stored in Postgres (bcrypt-hashed); the server mints an
HS256 JWT (`AUTH_JWT_SECRET`) that the client sends as a Bearer token. No third-party auth service.

**Rate limiting, quotas, usage.** The proxy enforces per-user requests/minute and a per-user
daily token budget (Upstash Redis), with a global circuit breaker, returning HTTP 429 +
`Retry-After` when limited; the client backs off (jittered exponential) and serializes a
prospect run so it never floods upstream. Each successful AI call records one row in `usage`
(input/output/cache-read tokens + computed cost) — server-side only. A short Redis response
cache de-duplicates identical requests. All of these are optional and no-op until their env
vars are set (see `.env.example`).
