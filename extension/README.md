# Karma Connect — Lead Finder (Chrome extension)

A small Chrome extension that finds B2B leads using your Karma Connect backend's Claude
web-research proxy, and saves the ones you like straight into Karma Connect as prospects.

It does **not** scrape LinkedIn or any other site. It asks Claude (with web search) to
research the open web — the same "ask Claude to find leads" flow the app already uses.

## What it talks to

All calls go to your existing backend — nothing new server-side is required:

| Action | Endpoint |
|---|---|
| Sign in (needed to save) | `POST /api/auth/signin` |
| Research leads | `POST /api/claude` (web search) |
| Save a lead | `POST /api/history` |

## Install (load unpacked)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the extension and click its icon to open the popup.

## Configure

Open the popup, click the **⚙ gear**:

- **Backend URL**
  - Local dev: `http://localhost:8787` (the Express server; default)
  - Production: your Render URL, e.g. `https://karma-connect.onrender.com`
- **Sign in** with your Karma Connect email + password. Required to **save** leads.
  (On a local dev server, searching works without signing in; saving still needs login.)

## Use

1. Type what you're after, e.g.
   *"owners of water-damage restoration companies in Texas, 10–50 staff, hiring admins"*.
2. Set how many leads (1–15) and click **Find leads**.
3. Review the cards (company, signal, why it fits, website + source links).
4. Click **Save to Karma Connect** on the good ones — they appear on your board as `new`.

The search runs in the background service worker, so you can close the popup while it
works; results are waiting when you reopen it.

## Requirements / notes

- The backend needs a **real `ANTHROPIC_API_KEY`** for search to work. With the placeholder
  key you'll see `invalid x-api-key`. Set the key in the backend `.env` (local) or the Render
  dashboard (prod) and restart.
- Results are AI-generated from web search — **verify before outreach**. The model is told
  never to fabricate and to cite a source URL, but always sanity-check.
- Regenerate icons after editing colors: `node icons/gen-icons.cjs`.
