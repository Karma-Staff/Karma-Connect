# Deploying Karma Connect for the team (Vercel + Supabase)

This turns the local single-user tool into a shared team app where:

- the **Anthropic API key lives on the server** (never in anyone's browser),
- every teammate **signs in with their @karmastaff.com email** (magic link), and
- only your domain can use it (enforced server-side).

You do this once. It needs a free **Supabase** account and a free **Vercel** account.
Each teammate's prospects still save in their own browser (localStorage) for now — a shared
database is a later step.

---

## 1. Create the Supabase project (login + auth)

1. Go to https://supabase.com → **New project**. Pick a name, set a DB password (you won't need it often), create.
2. When it's ready, open **Project Settings → API** and copy three values:
   - **Project URL** → this is `VITE_SUPABASE_URL`
   - **anon public** key → `VITE_SUPABASE_ANON_KEY`
   - **JWT Secret** (further down) → `SUPABASE_JWT_SECRET`
3. Open **Authentication → Providers → Email** and make sure **Email** is enabled (it is by default).
   Teammates sign in with **email + password** (they set their own password via "Create account").
   - For instant access, turn **off** "Confirm email" (Authentication → Providers → Email) so a new password works immediately.
   - Leave it **on** if you want each person to click a one-time confirmation link before their first login.
4. Open **Authentication → URL Configuration**:
   - Set **Site URL** to your future Vercel URL (you'll get it in step 2, e.g. `https://karma-connect.vercel.app`). You can come back and set this after the first deploy.
   - Add that same URL under **Redirect URLs**.

> Tip: to keep it strictly team-only, you can later turn off open sign-ups in Supabase and invite teammates, but the `ALLOWED_EMAIL_DOMAIN` check below already blocks anyone outside your domain.

---

## 2. Deploy to Vercel

1. Go to https://vercel.com → **Add New → Project** → import the GitHub repo
   `Takdang-Tenzin-Woesel/Karma-Connect`. Vercel auto-detects Vite.
2. Before the first deploy, open **Environment Variables** and add all of these
   (Production + Preview):

   | Name | Value | Notes |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | your `sk-ant-…` key | **server-side**, no VITE_ prefix |
   | `SUPABASE_JWT_SECRET` | from Supabase step 1.2 | verifies logins server-side |
   | `ALLOWED_EMAILS` | `tenzinwoesel@karmastaff.com` | exact allowlist (comma-separated). Add teammates here. Overrides the domain check. |
   | `ALLOWED_EMAIL_DOMAIN` | `karmastaff.com` | fallback if `ALLOWED_EMAILS` is left blank |
   | `VITE_SUPABASE_URL` | from Supabase | sent to the browser (safe) |
   | `VITE_SUPABASE_ANON_KEY` | from Supabase | sent to the browser (safe) |
   | `VITE_ALLOWED_EMAILS` | `tenzinwoesel@karmastaff.com` | client-side allowlist (same list); add teammates here too |
   | `VITE_ALLOWED_EMAIL_DOMAIN` | `karmastaff.com` | login-screen hint only |

3. Click **Deploy**. You'll get a URL like `https://karma-connect.vercel.app`.
4. Go back to **Supabase → Authentication → URL Configuration** and put that URL in
   **Site URL** and **Redirect URLs** (if you hadn't yet). Redeploy isn't needed.

---

## 3. Use it

- Share the Vercel URL with the team.
- Each person enters their `@karmastaff.com` email, gets a one-tap login link, and they're in.
- The API key is never exposed; non-team emails are rejected by the server.

---

## Local development (unchanged)

Locally you don't need Supabase. `npm run dev` runs a dev proxy that reads `ANTHROPIC_API_KEY`
from `.env` (server-side) — no login gate on localhost. To preview the real login flow locally,
fill the `VITE_SUPABASE_*` values in `.env` too.

## How the security works

- The browser calls **`/api/claude`** (our own endpoint), never Anthropic directly. The key
  is only in Vercel's server environment.
- In production, `/api/claude` (see `api/claude.js`) verifies the caller's Supabase login token
  and checks the email domain before forwarding. Unauthenticated or off-domain calls are rejected.
- Locally, the same path is served by a Vite dev middleware (`vite.config.js`) that skips the
  auth check (localhost only) so development stays frictionless.
