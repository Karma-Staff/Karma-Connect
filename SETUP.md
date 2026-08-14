# Running Karma Connect locally

Karma Connect is a Vite + React client with an Express backend (`server.js`) backed by
PostgreSQL. One command runs both together.

## 1. Prerequisites
- **Node.js 20+** (https://nodejs.org — LTS).
- **PostgreSQL** — either a local install, or a hosted database URL (e.g. Render Postgres).

## 2. Install dependencies
```bash
npm install
```

## 3. Configure `.env`
Create a `.env` file in the project root (it is gitignored — never commit it):
```bash
ANTHROPIC_API_KEY=sk-ant-...           # required (the AI proxy)
DATABASE_URL=postgresql://user:pass@host:5432/dbname
PGSSL=off                              # 'off' for local Postgres; omit for hosted (SSL)
AUTH_JWT_SECRET=<64+ random hex chars> # node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# Optional
GATEWAY_URL=https://<gateway-host>     # internal mail gateway; enables email confirmation on signup
GATEWAY_TOKEN=<per-client bearer token> # issued by an admin; keep out of source control
MAIL_FROM=Karma Connect <karmaconnect@karmastaff.com>  # must be allowlisted for the token
APP_URL=http://localhost:3000          # canonical URL used in email links
ADMIN_EMAILS=you@karmastaff.com        # comma-separated admins
ADMIN_SIGNUP_CODE=<shared secret>      # signups entering this code become admins
ALLOWED_EMAIL_DOMAIN=karmastaff.com    # who may register (defaults to karmastaff.com)
```

## 4. Initialise the database (one time)
```bash
npm run db:init        # applies db/schema.sql to DATABASE_URL
```

## 5. Run it
```bash
npm run dev            # starts the Express API and the Vite client together
```
Open **http://localhost:3000**. The Vite client proxies `/api/*` to the Express server.

## Other commands
| Command | What it does |
|---|---|
| `npm run build` | Build the production client into `dist/` |
| `npm start` | Run the production server (serves `dist/` + the API) |
| `npm test` | Run the unit tests (vitest) |
| `npm run lint` | Lint the client source |

## Deploying
Push to the deployment branch; Render builds (`npm run build`) and runs `npm start`.
Set the same environment variables (above) in the Render dashboard. See `DEPLOY.md` for details.

### Where do I get the Anthropic API key?
From whoever administers the app, or **https://console.anthropic.com → API Keys**. Keep it
private and never commit it.
