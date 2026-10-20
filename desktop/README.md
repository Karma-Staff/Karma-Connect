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
in after that. **Drag it by its header** (the strip with the status and caller
ID — the window has no Windows title bar of its own) and **resize it from any
edge**; it floats over every app. Allow the **microphone** when asked (needed to
make calls).

## Release it (to the sales team)

Releases are built in CI, not on a laptop:

1. Bump `"version"` in `desktop/package.json` (and run `npm install` so the
   lockfile agrees). Commit and push.
2. GitHub → Actions → **Desktop dialer release** → *Run workflow*. It builds
   from the committed `package-lock.json`, signs (when the signing secrets are
   set — see the workflow file), and uploads the installer, `latest.yml`, a
   `SHA256SUMS.txt`, an SBOM and a provenance attestation to a **draft**
   release tagged `desktop-vX.Y.Z`.
3. Check the job summary says *signed*, then publish the draft. Installed
   dialers pick it up within four hours and install it the next time they quit
   or the PC restarts; new reps download the installer from the release.

Never publish an unsigned build as a normal release. Mark it *pre-release*
(installed copies ignore those) and share it only with named testers.

### Local test build

```powershell
npm run dist          # unsigned, into desktop/dist/
```

Build outside OneDrive if it fails with `EPERM … rename` (OneDrive or the
antivirus is holding the folder): add
`-c.directories.output=$env:LOCALAPPDATA\kc-dialer-build`.

### Hardening (electron-builder.config.cjs)

- **Fuses:** no `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` or `--inspect`; only the
  shipped `app.asar` loads, and its hash is checked; the cookie store (the
  signed-in session) is encrypted with Windows DPAPI. Check a build with
  `npx @electron/fuses read --app "<…>\Karma Connect Dialer.exe"`.
- **Signing:** Microsoft Artifact Signing via `azureSignOptions`, switched on by
  the `KC_SIGN_*` variables; `forceCodeSigning` then refuses a half-signed
  build, and the updater only accepts updates signed by the same publisher.
- **Install notice:** `install-notice.txt` is shown as a page in the installer
  (microphone, start with Windows, what is stored, connections, updates).
- **Uninstall** removes the profile folder too (it holds the session).

## Every call goes through this app

Since Oct 2026 the browser has no phone of its own. Pressing Call anywhere in Karma Connect (a
number, the keypad, the power dialer) hands the number to this app through the server
(`leads/server/desktop-relay.js`), and the app places the call. Incoming calls ring only here.
The app reports back when a call ends and when the wrap-up is saved, so a power-dialer session
in the browser moves on as before.

- App not open: the call is not made; the browser opens the app and says to press Call again.
- Only the rep's own signed-in Karma Connect can send calls to their app. A website can't, which is
  why this doesn't use a `karmaconnect://call` link.
- The logic lives in the web page (`leads/public/app.js`), so installed 0.3.0 apps take part too.
- `CALLS_VIA_DESKTOP=0` on the server switches it off: the browser dials by itself again.

## How it works / notes

- **Always on top:** the window floats above other windows, including full-screen
  apps (`setAlwaysOnTop(…, "screen-saver")` + visible on all workspaces).
- **First-party:** because the window loads the dialer directly (not in an
  iframe), there is no cross-site cookie or framing issue — none of the
  `SameSite=None` / `frame-ancestors` relaxations the extension needs apply here.
- **Microphone:** granted only to the dialer's own origin, denied to anything
  else.
- **One instance:** launching again just focuses the open window.
- **Size:** opens at 320 × 560, the same as the dialer panel inside Karma
  Connect, and can be resized between 300 × 480 and 560 × 1000 (the keypad
  scales with the window). Size and position are remembered between runs;
  there is no maximise or full screen.
- **No title bar:** the window is frameless. The dialer's own header is the
  drag handle and carries the minimise and close buttons (`.kd-win` in
  `leads/public`, wired through `dialer-preload.js`).
- **No taskbar button:** minimising turns it into a floating bubble (always
  on top); click the bubble to bring the dialer back. Drag the bubble anywhere
  on any monitor and it stays there (it glides onto a screen edge when dropped
  near one; its spot is kept separately from the window's). It shows a green
  or grey presence dot, the due-reminders count, and a green ring while a call
  is ringing or live.
- **Opens with Karma Connect:** the app registers the `karmaconnect://` link
  with Windows. Once a rep signs in to Karma Connect (or Leads) in the browser,
  the web app follows `karmaconnect://open` once per browser session, which
  starts the dialer or brings it back from its bubble. The first time, Chrome
  asks "Open Karma Connect Dialer?" — tick *Always allow* and it stops asking.
  If the app is not installed, nothing happens. The link is registered when the
  app first runs.
- **Only Karma Connect in the window:** any other site — a link in a lead, a
  redirect — opens in the default browser instead (`tel:` and `mailto:` go to
  Windows). Sign-in is Karma Connect's own page, so it stays inside. A
  sign-in that the server sends out — RingCentral's *Reconnect* — finishes in
  the browser, and the dialer reloads when the rep comes back to it (never
  while a call is ringing or live).
- **The bubble** is served from the app's own `kc-app://` scheme, not
  `file://`: with the `grantFileProtocolExtraPrivileges` fuse off, `file://`
  cannot read inside `app.asar`, and the bubble came up blank.
- **Right-click the bubble:** *Start with Windows* (on by default, set once on
  the first run — after that it is the rep's choice), *Check for updates*, the
  version, and *Quit*.
- **Updates:** installed copies check GitHub Releases on start and every four
  hours (`electron-updater`), download in the background and install on quit —
  never mid-call. Pre-releases and drafts are ignored.
- **Point it elsewhere (dev only):** `KC_DIALER_URL` overrides the dialer URL for
  `npm start`. An installed copy ignores it, because the microphone is granted
  to whatever origin it loads (default
  `https://karma-connect-9s2z.onrender.com/leads/?embed=dialer`).

## Files
| File | What it is |
|------|------------|
| `main.js` | the Electron main process — the window, bubble, navigation guard, mic permission, auto-start, updates |
| `dialer-preload.js`, `bubble-preload.js` | the only bridges the two pages get (four actions; bubble drag) |
| `electron-builder.config.cjs` | installer, fuses, signing, update feed |
| `install-notice.txt` | the "what this app does" page shown by the installer |
| `package.json` / `package-lock.json` | pinned Electron, electron-builder, electron-updater |
| `../.github/workflows/desktop-release.yml` | the CI release build |
