# Karma Connect Dialer — desktop app

The softphone as a small **always-on-top window that floats over every
application** on the computer — Outlook, Excel, a Zoom call, anything — the way
Zoho Voice's desktop app does. The browser extension can only cover web pages
*inside* Chrome; this is a real program, so it covers the whole desktop.

It loads the **same dialer** as the extension (`/leads?embed=dialer`), but as the
window's own page, so the microphone and the login just work and stay signed in.

## Run it (to try it on this machine)

You need Node.js (already installed on the dev machine).

```powershell
cd "C:\Users\TenzinWoeselTakrang\OneDrive - Karma Staff\Desktop\Karma-Connect-main\desktop"
npm install      # first time only — downloads Electron (~200 MB), takes a minute
npm start
```

A small dark window titled **Karma Connect Dialer** opens and stays on top of
everything. The first time, sign in to Karma Connect inside it — it stays signed
in after that. **Drag it by its title bar**; it floats over every app. Allow the
**microphone** when asked (needed to make calls).

## Build an installer (to give it to the sales team)

```powershell
npm run dist          # or: npm run dist:win
```

This produces a Windows installer (`.exe`) under `desktop/dist/`. Send that file
to each rep; they run it once and get a normal Start-menu app that auto-updates
their login.

> Icons: for a branded installer, drop `icon.ico` (Windows) and `icon.icns`
> (Mac) into `desktop/icons/`. Without them the build still works with a default
> Electron icon.

## How it works / notes

- **Always on top:** the window floats above other windows, including full-screen
  apps (`setAlwaysOnTop(…, "screen-saver")` + visible on all workspaces).
- **First-party:** because the window loads the dialer directly (not in an
  iframe), there is no cross-site cookie or framing issue — none of the
  `SameSite=None` / `frame-ancestors` relaxations the extension needs apply here.
- **Microphone:** granted only to the dialer's own origin, denied to anything
  else.
- **One instance:** launching again just focuses the open window.
- **Size:** fixed at 320 × 560, the same as the dialer panel inside Karma
  Connect. Only the window's position is remembered between runs.
- **No taskbar button:** minimising turns it into a floating bubble
  (bottom-right, always on top); click the bubble to bring the dialer back.
- **Opens with Karma Connect:** the app registers the `karmaconnect://` link
  with Windows. Once a rep signs in to Karma Connect (or Leads) in the browser,
  the web app follows `karmaconnect://open` once per browser session, which
  starts the dialer or brings it back from its bubble. The first time, Chrome
  asks "Open Karma Connect Dialer?" — tick *Always allow* and it stops asking.
  If the app is not installed, nothing happens. The link is registered when the
  app first runs.
- **External links** (`tel:`, `http`) open in the default browser, not inside the
  dialer window.
- **Point it elsewhere:** set `KC_DIALER_URL` to override the dialer URL (default
  is `https://karma-connect-9s2z.onrender.com/leads/?embed=dialer`).

## Files
| File | What it is |
|------|------------|
| `main.js` | the Electron main process — the window, always-on-top, mic permission |
| `package.json` | Electron + electron-builder, run/build scripts, installer config |
