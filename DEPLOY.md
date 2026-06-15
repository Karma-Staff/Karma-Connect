# Deploying Karma Connect (Render + Postgres)

This turns the local tool into a shared team app where:

- the **Anthropic API key lives on the server** (never in anyone's browser),
- every teammate **signs in with email + password** (accounts stored in Postgres), and
- you can optionally restrict access to your email domain (enforced server-side).

The whole app — the built React frontend **and** the API — runs as a single Node web
service (`server.js`) on Render, backed by a managed Render Postgres database. You do this
once. It needs a free **Render** account.

---

## Option A — Blueprint (fastest)

The repo ships a `render.yaml`. In Render: **New + → Blueprint**, point it at this repo, and
it creates the web service **and** the Postgres database, wiring `DATABASE_URL` and a generated
`AUTH_JWT_SECRET` automatically. You only need to add `ANTHROPIC_API_KEY` (marked `sync: false`)
in the dashboard. Then run the schema once (step 4 below).

## Option B — Manual

### 1. Create the database
Render → **New + → Postgres**. Pick a name/region, **Free** plan, create. When it's ready,
copy the **Internal Database URL** (for the web service) and the **External Database URL**
(to run the schema from your laptop).

### 2. Create the web service
Render → **New + → Web Service** → connect this repo. Settings:

| Field | Value |
|---|---|
| Runtime | Node |
| Build command | `npm install && npm run build` |
| Start command | `npm start` |
| Health check path | `/api/health` |

### 3. Environment variables
Add these under the web service's **Environment**:

| Name | Value | Notes |
|---|---|---|
| `DATABASE_URL` | the **Internal** Database URL | server-side; Render requires SSL (handled automatically) |
| `AUTH_JWT_SECRET` | a long random string | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` — **server-side**, keep secret |
| `ANTHROPIC_API_KEY` | your `sk-ant-…` key | **server-side**, no VITE_ prefix |
| `NODE_ENV` | `production` | serves the built SPA + requires login on `/api/claude` |

**Sign-up is open by default** — anyone who creates an account can spend your API budget. For a
public URL, lock it down with **one** of these (optional):

| Name | Value | Notes |
|---|---|---|
| `ALLOWED_EMAIL_DOMAIN` | `karmastaff.com` | only this email domain may register/use the app |
| `ALLOWED_EMAILS` | `a@karmastaff.com,b@karmastaff.com` | exact list (overrides the domain) |

Optional rate-limit / quota / cache (recommended for production) — create a free Upstash Redis
and set `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (tunables in `.env.example`).

### 4. Create the tables (once)
From your machine, using the **External** Database URL:

```bash
DATABASE_URL="postgresql://…external…" npm run db:init
```

This applies `db/schema.sql` (idempotent — safe to re-run). Then **Deploy** the web service.

---

## 3. Use it

- Share the Render URL with the team.
- Each person clicks **Create an account**, sets an email + password, and they're in immediately.
- The API key is never exposed; if you set the allowlist, off-domain emails are rejected server-side.

---

## Local development

```bash
cp .env.example .env     # set ANTHROPIC_API_KEY; for real accounts set DATABASE_URL + AUTH_JWT_SECRET
npm install
npm run db:init          # only if you set DATABASE_URL (use PGSSL=off for a local Postgres)
npm run dev              # starts the backend (:8787) AND Vite (:3000); open http://localhost:3000
```

- `npm run dev` runs **both** the Express backend and the Vite dev server; Vite proxies every
  `/api/*` call to the backend, so local behaves like production.
- Without `DATABASE_URL`, there are no real accounts: the app uses a per-browser email+password
  gate and saves history in `localStorage`. AI still works on localhost without signing in.

## How the security works

- The browser calls **`/api/claude`** (our own endpoint), never Anthropic directly. The key is
  only in the server's environment.
- In production, `server.js` verifies the caller's login JWT (HS256, signed with `AUTH_JWT_SECRET`)
  and checks the allowlist before forwarding. Unauthenticated or off-domain calls are rejected.
- There is **no row-level security**: every database query is scoped in `server.js` to the
  `user_id` taken from the verified token — never from anything the client sends.
- Locally (`npm run dev`), the `/api/claude` proxy skips the login check (localhost only) so
  development stays frictionless; the auth and history endpoints still require a token.
