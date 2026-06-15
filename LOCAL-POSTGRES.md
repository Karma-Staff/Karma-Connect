# Running Karma Connect against a local Postgres (Windows, no admin)

This is the local-first workflow: develop against a Postgres on your own machine, then flip a
single env var to point at Render Postgres when you go live. It uses a **portable** PostgreSQL
(a plain unzipped build) so nothing needs administrator rights or a system install.

> On this machine it's already set up. Postgres 16.4 lives at
> `%LOCALAPPDATA%\pgsql-portable\pgsql\bin`, its data is in `%LOCALAPPDATA%\pgsql-portable\data`,
> and it listens on **port 5433** (localhost only). The `.env` already points at it.

## Daily use

```powershell
# 1. Start Postgres (once per reboot — it keeps running in the background)
& "$env:LOCALAPPDATA\pgsql-portable\pgsql\bin\pg_ctl.exe" `
  -D "$env:LOCALAPPDATA\pgsql-portable\data" `
  -l "$env:LOCALAPPDATA\pgsql-portable\server.log" `
  -o "-p 5433 -c listen_addresses=127.0.0.1" start

# 2. Start the app (backend + Vite together)
npm run dev          # → http://localhost:3000

# 3. Stop Postgres when you're done for the day (optional)
& "$env:LOCALAPPDATA\pgsql-portable\pgsql\bin\pg_ctl.exe" -D "$env:LOCALAPPDATA\pgsql-portable\data" stop
```

`node` lives at `%LOCALAPPDATA%\nodejs-portable\node-v22.16.0-win-x64` and is on your user PATH.

## Useful commands

```powershell
$PG = "$env:LOCALAPPDATA\pgsql-portable\pgsql\bin"

# Is it running?
& "$PG\pg_ctl.exe" -D "$env:LOCALAPPDATA\pgsql-portable\data" status

# Open a SQL shell
& "$PG\psql.exe" -h 127.0.0.1 -p 5433 -U postgres -d karma_connect

# Inspect data
& "$PG\psql.exe" -h 127.0.0.1 -p 5433 -U postgres -d karma_connect -c "select email from users;"
& "$PG\psql.exe" -h 127.0.0.1 -p 5433 -U postgres -d karma_connect -c "select label, updated_at from prospects;"

# Re-apply / reset the schema (idempotent)
npm run db:init
```

The relevant `.env` values for local dev:

```
DATABASE_URL=postgresql://postgres@localhost:5433/karma_connect
PGSSL=off          # local Postgres has no SSL; Render does
AUTH_JWT_SECRET=<already generated>
ANTHROPIC_API_KEY=<your key>
```

## Switching to live (Render Postgres)

When the app works locally and you're ready to go live:

1. In `.env`, replace the two local lines with your Render **External Database URL** and remove
   the SSL override:
   ```
   DATABASE_URL=postgresql://<user>:<pass>@<host>.render.com/<db>
   # delete the PGSSL=off line  (Render requires SSL, which the code enables by default)
   ```
2. Create the tables on Render once:
   ```powershell
   npm run db:init
   ```
3. `npm run dev` now runs against Render. Your local Postgres can stay stopped.

For the actual production *deployment* (the app running on Render, not just the DB), see
[DEPLOY.md](DEPLOY.md). There, Render injects `DATABASE_URL` and `AUTH_JWT_SECRET` itself and you
run `npm start` (not `npm run dev`).

## Notes / gotchas

- **`npm run dev` does not auto-restart on `server.js` edits.** Node's `--watch` restart-loops on
  Windows and kills in-flight requests, so the default dev script runs plain `node`. If you want
  auto-reload while editing the backend, use `npm run dev:server:watch` in a separate terminal
  (and `npm run dev:client` for Vite) — just restart it manually if it gets noisy.
- Local accounts are **separate** from Render accounts — they live in different databases. You'll
  re-create your login after switching.
- The portable Postgres survives reboots as files, but the *server process* does not — re-run the
  `pg_ctl … start` command after a reboot.
