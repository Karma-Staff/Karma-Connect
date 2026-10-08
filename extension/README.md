# Karma Connect Dialer — browser extension

A floating Karma Connect softphone that rides over **every website** — drag it
anywhere, and call a number you select on any page. This is the only way to get
a dialler on top of other sites (Gmail, another CRM, a Google Sheet): a web page
is sandboxed to its own site, so it takes a browser extension to draw over the
rest. This is the same mechanism Zoho's dialler uses.

## How it works (so the next person understands it)

The extension is deliberately thin. The dialler **is the real Karma Connect
softphone** — it is loaded in an `<iframe>` pointed at `<app>/?embed=dialer`:

- **`content.js`** injects a draggable bubble/panel into every page, inside a
  Shadow DOM so the host site's CSS can't touch it. Position and open state are
  saved in `chrome.storage`, so it's where the rep left it on the next page and
  the next site.
- The panel's iframe loads the app in **embed mode** (`?embed=dialer`, added to
  `app.js`/`app.css`). Embed mode hides the dashboard and docks just the
  softphone to fill the frame. Because the iframe is the **same origin** as the
  app, it inherits the rep's Karma Connect login and reuses everything that
  already exists — RingCentral, call recording, voicemail drop. Nothing is
  rebuilt.
- **`background.js`** adds the right-click *"Call … with Karma Connect"* and
  makes the toolbar icon show/hide the widget. The number is posted into the
  dialler, which dials it. A one-time token (in the iframe URL and every dial
  message) stops a random page from driving the softphone.

### Phase-1 limit — read this
A **full page load of the host site** reloads the content script and the iframe,
which **drops a call in progress**. Fine while the rep stays on one page during a
call; not yet true "call survives everywhere." The fix is an MV3 **offscreen
document** that owns the RingCentral WebPhone (audio lives in the extension, not
a tab), with the visible panel reduced to UI that talks to it through
`background.js`. That's the next phase and is stubbed in `background.js`.

## Install (for testing — no store needed)

1. **Set your app URL.** Either edit `config.js` (`KC_APP_URL_DEFAULT`) or, after
   loading, open the extension's **Options** and paste it there (that wins).
   Example: `https://karma-connect.onrender.com` — no trailing slash.
2. Chrome/Edge → `chrome://extensions` → turn on **Developer mode** →
   **Load unpacked** → pick this `extension/` folder.
3. (Optional) add two PNGs, `icon48.png` / `icon128.png`, and reference them in
   `manifest.json` under `"icons"` and `"action".default_icon` for a real icon.
4. Open any website. A blue phone bubble appears bottom-right. Click it → the
   dialler opens (sign in to Karma Connect the first time). Drag the bubble or
   the panel's top bar anywhere — it stays there across pages and sites.

### Try it
- **Drag:** grab the bubble or the panel's top bar, drop it anywhere.
- **Call from a page:** select a phone number on any site → right-click →
  *Call … with Karma Connect*. Or click any `tel:` link.
- **Show/hide:** click the toolbar icon.

## Rolling it out to reps
Loading unpacked is per-machine and for testing. For a real rollout, either
publish to the **Chrome Web Store** (a few days' review) or **force-install** via
Google Workspace / Edge enterprise policy so every rep gets it automatically.
Microphone permission is granted once per rep in the dialler iframe.

## Files
| File | What it is |
|------|------------|
| `manifest.json` | MV3 manifest, permissions, content-script registration |
| `config.js` | the one setting: your app URL (or set it in Options) |
| `content.js` | the floating, draggable widget + the dialler iframe + click-to-call |
| `background.js` | right-click call, toolbar toggle, Phase-2 offscreen stub |
| `options.html` / `options.js` | set the app URL per machine |

## App side (already added, in the main repo)
- `?embed=dialer` in `leads/public/app.js` — boots as a bare softphone, accepts
  a token-checked dial message.
- `.kc-embed` styles in `leads/public/app.css` — hides the dashboard, docks the
  dialler to fill the frame.
