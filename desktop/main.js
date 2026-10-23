"use strict";
/* Karma Connect Dialer — desktop app (Electron).
 *
 * A small, always-on-top window that floats the Karma Connect softphone over
 * EVERY application, the way Zoho Voice's desktop app does. It loads the dialer
 * as the window's own top-level page (not an iframe), so it is first-party: the
 * microphone and the login just work and persist.
 *
 * Behaviour the team asked for:
 *   - ONLY the dialer, never the whole dashboard — the window is pinned to the
 *     embed view, and a sign-in round trip that drops the flag is rewritten back.
 *   - The Karma Staff mark as the app icon.
 *   - Minimise collapses to a floating BUBBLE (always on top), not the
 *     taskbar; click the bubble to bring the dialer back. The bubble can be
 *     dragged anywhere and stays put; it shows presence, due reminders and
 *     a ringing/live call. The window never has a taskbar button at all — it
 *     is either open or a bubble.
 *   - Opens at the size of the dialer panel inside Karma Connect (320 x 560),
 *     and can be resized between 300 x 480 and 560 x 1000 — the size is
 *     remembered with the position. No maximise, no full screen.
 *   - No Windows title bar: the window is frameless and the dialer's own slim
 *     header (leads/public, .kd-head) is the drag region, with its own
 *     minimise and close buttons wired through dialer-preload.js.
 *   - Opening Karma Connect in the browser opens this app too: the web app
 *     follows a karmaconnect:// link, which Windows hands to this app.
 */

const { app, BrowserWindow, Menu, dialog, protocol, session, shell, ipcMain, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

/* The bubble's own page is served from kc-app://, not file://. The
   grantFileProtocolExtraPrivileges fuse is off (electron-builder.config.cjs),
   and without it file:// cannot read inside app.asar — the bubble window
   opened empty and invisible (ERR_FILE_NOT_FOUND). The scheme serves only the
   files listed here, straight out of the app's own folder. */
const APP_SCHEME = "kc-app";
const APP_FILES = {
  "bubble.html": "text/html; charset=utf-8",
  "icons/mark-white.png": "image/png",
};
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);
function serveAppFiles() {
  protocol.handle(APP_SCHEME, (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "");
    const type = APP_FILES[rel];
    if (!type) return new Response("not found", { status: 404 });
    try { return new Response(fs.readFileSync(path.join(__dirname, rel)), { headers: { "content-type": type } }); }
    catch (e) { return new Response("not found", { status: 404 }); }
  });
}

/* KC_DIALER_URL points a DEV run at another server. An installed copy ignores
   it: the microphone is granted to whatever origin this is, so anyone able to
   set the rep's environment could otherwise aim it at their own page. */
const DIALER_URL = (!app.isPackaged && process.env.KC_DIALER_URL)
  || "https://karma-connect-9s2z.onrender.com/leads/?embed=dialer";
let DIALER_ORIGIN = "";
try { DIALER_ORIGIN = new URL(DIALER_URL).origin; } catch (e) { /* leave blank */ }

const ICON = path.join(__dirname, "icons", "icon.png");
const PROTOCOL = "karmaconnect";
// the dialer panel inside Karma Connect (.kd in leads/public/app.css) is the
// starting size; the window can be resized within these bounds. The layout
// (app.css, body.kc-embed) is fluid across the whole range.
const DIALER_W = 320, DIALER_H = 560;
const MIN_W = 300, MIN_H = 480, MAX_W = 560, MAX_H = 1000;
// the page's own surface colour (--surface in app.css) — painted before the
// page loads and behind it, so the window edge is never see-through
const SURFACE = "#0e1a30";

/* An installed copy refuses Chromium's remote debugging. The fuses already
   block --inspect, but --remote-debugging-port / --remote-debugging-pipe
   would hand this signed-in, microphone-enabled window to whoever started it
   (a shortcut or a script can add the switch). Dev runs keep it. */
const DEBUG_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe"];
if (app.isPackaged && (DEBUG_SWITCHES.some((s) => app.commandLine.hasSwitch(s))
  || process.argv.some((a) => DEBUG_SWITCHES.some((s) => a.toLowerCase().startsWith("--" + s))))) {
  app.exit(1);
}

// call audio must play without a click, or the far end is silent
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let bubble = null;

const stateFile = () => path.join(app.getPath("userData"), "window-state.json");
/* Position and size are remembered together. The size is clamped to the
   window's own limits (a state file from an older build has no size, and
   gets the default); the position is dropped if it was left on a monitor
   that is no longer plugged in. */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));
function loadPos() {
  try {
    const p = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    const out = {};
    if (Number.isFinite(p.width) && Number.isFinite(p.height)) {
      out.width = clamp(p.width, MIN_W, MAX_W);
      out.height = clamp(p.height, MIN_H, MAX_H);
    }
    const onScreen = Number.isFinite(p.x) && Number.isFinite(p.y)
      && screen.getAllDisplays().some(({ workArea: a }) =>
        p.x >= a.x && p.y >= a.y && p.x < a.x + a.width && p.y < a.y + a.height);
    if (onScreen) { out.x = p.x; out.y = p.y; }
    return out;
  } catch (e) { return {}; }
}
function savePos() {
  try {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const { x, y } = win.getBounds();
    const [width, height] = win.getContentSize();
    fs.writeFileSync(stateFile(), JSON.stringify({ x, y, width, height }));
  } catch (e) { /* fine */ }
}
// a drag or a resize fires dozens of events a second; write once it settles
let saveTimer = null;
function savePosSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(savePos, 250); }

// minimise → a floating bubble instead of the taskbar (the window never has a
// taskbar button). Reached from the header's minimise button via IPC.
function toBubble() {
  if (!win || win.isDestroyed()) return;
  win.hide();
  showBubble();
}

/* Keep the window on the dialer-only view. Signing in can land back on /leads
   WITHOUT ?embed=dialer, which would show the whole dashboard; rewrite any such
   URL to the embed view. The sign-in page itself (a different origin) is left
   alone. */
function forceEmbed(url) {
  try {
    const u = new URL(url);
    if (u.origin !== DIALER_ORIGIN) return null;
    if (!u.pathname.startsWith("/leads")) return null;
    if (u.searchParams.get("embed") === "dialer") return null;
    u.searchParams.set("embed", "dialer");
    return u.toString();
  } catch (e) { return null; }
}

/* Only Karma Connect itself is shown in this window — sign-in included, which
   is Karma Connect's own page (WorkOS is no longer how anyone signs in, and a
   wildcard for its *.authkit.app tenants would have let any tenant's look-alike
   page render here, in a window with no address bar). Anything else — a link
   in a lead, a redirect — opens in the person's browser instead: this window
   is always on top, holds the microphone, and should never become a general
   browser. */
/* And only two of its pages: the dialer (/leads…) and the sign-in at "/",
   which a signed-out dialer is sent to as /?next=/leads/ and which sends it
   back. The rest of Karma Connect opens in the browser, so a bug anywhere
   else on the site never runs in this window, next to the microphone. */
const onDialerPath = (p) => p === "/leads" || p.startsWith("/leads/");
function allowedInWindow(url) {
  try {
    const u = new URL(url);
    return u.origin === DIALER_ORIGIN && (u.pathname === "/" || onDialerPath(u.pathname));
  } catch (e) { return false; }
}
// RingCentral's and Zoho CRM's connect flows (leads/server ringcentral.js, crm-identity.js)
function isConnectLink(url) {
  try {
    const u = new URL(url);
    return u.origin === DIALER_ORIGIN && ["/api/voice/rc/connect", "/api/crm/me/connect"].includes(u.pathname);
  } catch (e) { return false; }
}
function onDialerPage(url) {
  try { const u = new URL(url); return u.origin === DIALER_ORIGIN && onDialerPath(u.pathname); }
  catch (e) { return false; }
}
/* A redirect sent out to the browser is usually a sign-in started here — the
   RingCentral "Reconnect" button (/api/voice/rc/connect) is one. It finishes
   in the browser, so when the rep comes back to this window it reloads and
   picks the new connection up, instead of staying unregistered. */
let reloadOnFocus = false;
/* One click, one tab. This window sits on top of everything, so the tab a
   click opened appeared BEHIND it; a rep who saw nothing happen clicked again
   (seven tabs, 2026-10-22). Now a web link also sends the dialer to its bubble
   so the tab is in view, and the same link clicked again within 15 s opens
   nothing more — the tab it opened is already there. */
const OUTSIDE_REPEAT_MS = 15 * 1000;
let lastOutside = { url: "", at: 0 };
function openOutside(url) {
  if (!/^https?:|^tel:|^mailto:/i.test(url)) return;
  const web = /^https?:/i.test(url);
  const now = Date.now();
  const repeat = url === lastOutside.url && now - lastOutside.at < OUTSIDE_REPEAT_MS;
  if (!repeat) {
    lastOutside = { url, at: now };
    shell.openExternal(url);
  }
  if (web) toBubble();
}

function createWindow() {
  const p = loadPos();
  win = new BrowserWindow({
    width: p.width || DIALER_W, height: p.height || DIALER_H, useContentSize: true,
    minWidth: MIN_W, minHeight: MIN_H, maxWidth: MAX_W, maxHeight: MAX_H,
    x: p.x, y: p.y,
    /* No Windows title bar — the dialer draws its own (drag region, minimise,
       close). thickFrame stays on so Windows still gives the window its
       shadow and the resize edges. */
    frame: false,
    resizable: true, maximizable: false, fullscreenable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    title: "Karma Connect Dialer",
    icon: ICON,
    backgroundColor: SURFACE,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, "dialer-preload.js"),
      /* The power dialer keeps calling while this window sits in the bubble
         (hidden). Chromium slows a hidden page's timers, which stretched the
         countdown to the next lead; a softphone must not be throttled. */
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadURL(DIALER_URL);

  const guardNav = (e, url, isRedirect) => {
    if (!allowedInWindow(url)) {
      e.preventDefault(); openOutside(url);
      // only a SERVER redirect (a sign-in flow), never a link the rep clicked
      if (isRedirect && e.isMainFrame !== false && /^https:/i.test(url)) reloadOnFocus = true;
      // ...or the dialer's own Connect / Reconnect links: the click is sent to
      // the browser before any redirect happens here, so the check above
      // never saw it and the dialer stayed unregistered after a reconnect
      if (isConnectLink(url)) reloadOnFocus = true;
      return;
    }
    const f = forceEmbed(url);
    if (f) { e.preventDefault(); win.loadURL(f); }
  };
  win.webContents.on("will-navigate", (e, url) => guardNav(e, url, false));
  win.webContents.on("will-redirect", (e, url) => guardNav(e, url, true));
  win.on("focus", () => {
    // never reload under a ringing or live call — it would drop it; try again next focus
    if (!reloadOnFocus || bubbleState.call) return;
    reloadOnFocus = false;
    win.loadURL(DIALER_URL);
  });
  /* Backstop: Chromium commits some navigations without asking will-navigate
     first — about:blank is one (found in the 0.3.0 retest). Whatever lands in
     the window that is not allowed there is replaced by the dialer again. */
  win.webContents.on("did-navigate", (_e, url) => {
    if (!allowedInWindow(url)) win.loadURL(DIALER_URL);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });

  // a minimise from anywhere else (Win+Down, the taskbar thumbnail) → bubble too
  win.on("minimize", (e) => { e.preventDefault(); toBubble(); });
  win.on("move", savePosSoon);
  win.on("resize", savePosSoon);
  win.on("closed", () => { win = null; if (bubble && !bubble.isDestroyed()) bubble.close(); });
}

/* ---- the bubble ----
   An 84px transparent window around a 60px disc (bubble.html; the margin
   holds the shadow, the reminders badge and the ringing pulse). The rep drags
   it anywhere, on any monitor, and it stays there: its spot is kept in its
   own file, separate from the dialer window's, and falls back to the
   bottom-right corner if that monitor is gone. The page reports the pointer;
   this side moves the window from the real cursor (DPI-safe) and tells a
   click from a drag by how far the cursor travelled — a click brings the
   dialer back, a drag never does. */
const BUBBLE = 84;
const BUBBLE_MARGIN = 4;     // from the work-area edge (the disc itself sits 16px in)
const SNAP = 28;             // dropped this close to an edge → glides onto it
const bubbleFile = () => path.join(app.getPath("userData"), "bubble-state.json");

function bubbleHome() {
  const a = screen.getPrimaryDisplay().workArea;
  return { x: a.x + a.width - BUBBLE - BUBBLE_MARGIN, y: a.y + a.height - BUBBLE - BUBBLE_MARGIN };
}
function loadBubblePos() {
  try {
    const p = JSON.parse(fs.readFileSync(bubbleFile(), "utf8"));
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return bubbleHome();
    // the disc's centre must be on a monitor that is still plugged in
    const cx = p.x + BUBBLE / 2, cy = p.y + BUBBLE / 2;
    const ok = screen.getAllDisplays().some(({ workArea: a }) =>
      cx >= a.x && cy >= a.y && cx < a.x + a.width && cy < a.y + a.height);
    return ok ? { x: p.x, y: p.y } : bubbleHome();
  } catch (e) { return bubbleHome(); }
}
function saveBubblePos() {
  try {
    if (!bubble || bubble.isDestroyed()) return;
    const [x, y] = bubble.getPosition();
    fs.writeFileSync(bubbleFile(), JSON.stringify({ x, y }));
  } catch (e) { /* fine */ }
}

// what the dialer page last reported (dialer-preload.js → kc-state): shown on
// the bubble as the presence dot, the reminders badge and a ringing/live ring
let bubbleState = { registered: false, badge: 0, call: "" };
function pushBubbleState() {
  if (bubble && !bubble.isDestroyed()) bubble.webContents.send("kc-state", bubbleState);
}

function showBubble() {
  if (bubble && !bubble.isDestroyed()) { bubble.show(); pushBubbleState(); return; }
  const p = loadBubblePos();
  bubble = new BrowserWindow({
    width: BUBBLE, height: BUBBLE, x: p.x, y: p.y,
    /* pinned on every axis: a transparent window on a scaled display can
       otherwise grow when it is moved programmatically (a Chromium quirk on
       Windows) — placeBubble() also passes the size with every move */
    minWidth: BUBBLE, minHeight: BUBBLE, maxWidth: BUBBLE, maxHeight: BUBBLE,
    frame: false, transparent: true, resizable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    icon: ICON,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, "bubble-preload.js"),
    },
  });
  bubble.setAlwaysOnTop(true, "screen-saver");
  bubble.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // a local page with nowhere to go
  bubble.webContents.on("will-navigate", (e) => e.preventDefault());
  bubble.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  bubble.webContents.on("did-finish-load", pushBubbleState);
  bubble.webContents.on("context-menu", showBubbleMenu);
  bubble.loadURL(`${APP_SCHEME}://app/bubble.html`);
}

/* Right-click the bubble: whether the dialer starts with Windows, an update
   check, and a real Quit (the window's close button only closes the window). */
function showBubbleMenu() {
  const packaged = app.isPackaged;
  // switched off in Task Manager → that is the rep's choice, and only Task Manager changes it
  const blocked = packaged && autoStartBlocked();
  Menu.buildFromTemplate([
    { label: "Open dialer", click: openDialer },
    { type: "separator" },
    blocked
      ? { label: "Start with Windows: turned off in Task Manager", enabled: false }
      : { label: "Start with Windows", type: "checkbox", enabled: packaged,
        checked: packaged && autoStartOn(),
        click: (item) => setAutoStart(item.checked) },
    updateReady
      ? { label: bubbleState.call ? `Restart to update to ${updateReady} (after this call)` : `Restart to update to ${updateReady}`,
        enabled: !bubbleState.call, click: restartToUpdate }
      : { label: "Check for updates", enabled: packaged, click: () => checkForUpdates(true) },
    { label: `Version ${app.getVersion()}`, enabled: false },
    { type: "separator" },
    { label: "Quit Karma Connect Dialer", click: () => app.quit() },
  ]).popup({ window: bubble });
}

// cursor offset from the window's corner at press, where the press was, and
// whether it has travelled far enough to count as a drag
let drag = null;
let glide = null;
// move = position AND size, see the note on the window options
function placeBubble(x, y) { bubble.setBounds({ x, y, width: BUBBLE, height: BUBBLE }); }
ipcMain.on("kc-bubble-drag", (e, what) => {
  if (!bubble || bubble.isDestroyed() || e.sender !== bubble.webContents) return;
  const c = screen.getCursorScreenPoint();
  if (what === "start") {
    clearInterval(glide);
    const [x, y] = bubble.getPosition();
    drag = { ox: c.x - x, oy: c.y - y, sx: c.x, sy: c.y, moved: false };
    return;
  }
  if (!drag) return;
  if (what === "move") {
    if (!drag.moved && Math.hypot(c.x - drag.sx, c.y - drag.sy) < 4) return;
    drag.moved = true;
    placeBubble(c.x - drag.ox, c.y - drag.oy);
    return;
  }
  const d = drag;                                   // "end"
  drag = null;
  if (!d.moved) { openDialer(); return; }           // a click
  settleBubble();
});

/* Dropped: keep it inside the work area of whichever monitor it is on, and
   if it is near an edge glide the last bit onto that edge. */
function settleBubble() {
  const [x, y] = bubble.getPosition();
  const a = screen.getDisplayMatching({ x, y, width: BUBBLE, height: BUBBLE }).workArea;
  const left = a.x + BUBBLE_MARGIN, right = a.x + a.width - BUBBLE - BUBBLE_MARGIN;
  const top = a.y + BUBBLE_MARGIN, bottom = a.y + a.height - BUBBLE - BUBBLE_MARGIN;
  let tx = Math.max(left, Math.min(x, right)), ty = Math.max(top, Math.min(y, bottom));
  if (tx - left <= SNAP) tx = left; else if (right - tx <= SNAP) tx = right;
  if (ty - top <= SNAP) ty = top; else if (bottom - ty <= SNAP) ty = bottom;
  glideBubble(tx, ty);
}
function glideBubble(tx, ty) {
  const [x0, y0] = bubble.getPosition();
  if (x0 === tx && y0 === ty) { saveBubblePos(); return; }
  const t0 = Date.now(), T = 160;
  clearInterval(glide);
  glide = setInterval(() => {
    if (!bubble || bubble.isDestroyed()) { clearInterval(glide); return; }
    const k = Math.min(1, (Date.now() - t0) / T), ease = 1 - (1 - k) * (1 - k);
    placeBubble(Math.round(x0 + (tx - x0) * ease), Math.round(y0 + (ty - y0) * ease));
    if (k >= 1) { clearInterval(glide); saveBubblePos(); }
  }, 16);
}

function openDialer() {
  if (!win) { createWindow(); return; }
  if (bubble && !bubble.isDestroyed()) bubble.hide();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

ipcMain.on("kc-restore", openDialer);
// the dialer header's own window buttons (dialer-preload.js): minimise goes to
// the bubble exactly like the old title-bar button did; close closes the window
ipcMain.on("kc-minimize", toBubble);
// — except under a ringing or live call: closing quits the app and drops it, so
// that goes to the bubble instead (the page refuses too; this is the backstop)
ipcMain.on("kc-close", () => {
  if (!win || win.isDestroyed()) return;
  if (bubbleState.call) return toBubble();
  win.close();
});
// presence / reminders / call state from the dialer page, for the bubble
ipcMain.on("kc-state", (e, s) => {
  if (!win || win.isDestroyed() || e.sender !== win.webContents || !s) return;
  bubbleState = { registered: !!s.registered, badge: Number(s.badge) || 0, call: String(s.call || "") };
  pushBubbleState();
});

// launched again — by hand, or by Karma Connect's karmaconnect:// link
app.on("second-instance", openDialer);

/* Register karmaconnect:// so the web app can open this one. Installed app:
   Windows runs the .exe. Dev (`npm start`): Windows runs electron.exe with this
   folder as the app. */
if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
else app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1] || ".")]);

/* ---- start with Windows ----
   On by default, so the dialer is there the moment a rep opens Karma Connect —
   but set only ONCE, on the first run of an installed copy. After that it is
   the rep's choice (the bubble's right-click menu, or Task Manager → Startup
   apps), and a later launch never switches it back on. Only for the
   INSTALLED app: on a dev `npm start` it would register the Electron binary. */
const prefsFile = () => path.join(app.getPath("userData"), "desktop-prefs.json");
function readPrefs() { try { return JSON.parse(fs.readFileSync(prefsFile(), "utf8")) || {}; } catch (e) { return {}; } }
function writePrefs(p) { try { fs.writeFileSync(prefsFile(), JSON.stringify(p)); } catch (e) { /* fine */ } }
/* The Run-key value name is pinned to the one 0.1–0.2 wrote. Electron derives
   the default from the AppUserModelId, which this build now sets — left to the
   default, an upgraded PC would get a SECOND entry (two launches at login, and
   unticking the menu item would only remove one of them). */
const LOGIN_ITEM = { name: "electron.app.Karma Connect Dialer" };
/* Read from the registry itself. getLoginItemSettings() takes no name on
   Windows (its openAtLogin answers for the AppUserModelId's entry, not this
   one), and its launchItems came back EMPTY for a value it had just written —
   so the menu tick always read "off" and could never switch auto-start off.
   Task Manager's "Disabled" is an odd first byte under StartupApproved. */
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APPROVED_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
function regValue(key) {
  try {
    return require("node:child_process").execFileSync("reg", ["query", key, "/v", LOGIN_ITEM.name],
      { stdio: "pipe", windowsHide: true }).toString();
  } catch (e) { return null; }
}
// Task Manager's "Disabled" on our Run value. Never deleted from here: that
// value is Windows' own record of the user's choice (KA-05).
function autoStartBlocked() {
  if (!regValue(RUN_KEY)) return false;
  const m = /REG_BINARY\s+([0-9A-F]{2})/i.exec(regValue(APPROVED_KEY) || "");
  return !!(m && (parseInt(m[1], 16) & 1));
}
function autoStartOn() {
  return !!regValue(RUN_KEY) && !autoStartBlocked();
}
function setAutoStart(on) {
  try { app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: !!on }); } catch (e) { /* not fatal */ }
  writePrefs({ ...readPrefs(), autoStartChosen: true });
}
function autoStartFirstRun() {
  if (!app.isPackaged || readPrefs().autoStartChosen) return;
  setAutoStart(true);
}

/* ---- updates ----
   Installed copies check GitHub Releases (the `publish` block in package.json)
   on start and every four hours, download in the background, and install when
   the app next quits — never mid-call. electron-updater checks the sha512 in
   latest.yml and, once the build is signed, that the update is signed by the
   same publisher (verifyUpdateCodeSignature). Pre-releases are ignored. */
let updater = null;
function checkForUpdates(byHand) {
  if (!app.isPackaged) return;
  try {
    if (!updater) {
      updater = require("electron-updater").autoUpdater;
      updater.logger = null;            // its default logger prints whole stack traces; one line below is enough
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = true;
      updater.allowPrerelease = false;
      /* every failure — the check, and the background download (network
         drop, sha512 or publisher mismatch) — arrives here once; the promise
         rejections below are only swallowed so none of them can surface as
         Electron's "JavaScript error in the main process" dialog over the dialer */
      updater.on("error", (e) => console.warn("[updater]", e && e.message));
      // downloaded: offered on the bubble's menu (showBubbleMenu)
      updater.on("update-downloaded", (info) => { updateReady = (info && info.version) || "the new version"; });
    }
    updater.checkForUpdates()
      .then((r) => {
        if (r && r.downloadPromise) r.downloadPromise.catch(() => {});
        if (!byHand) return;
        if (updateReady) return tellRep(`Version ${updateReady} is ready. Right-click the bubble → "Restart to update".`);
        if (r && r.isUpdateAvailable) return tellRep(`Version ${r.updateInfo.version} is downloading. When it's ready, right-click the bubble → "Restart to update".`);
        tellRep(`You're on the latest version (${app.getVersion()}).`);
      })
      .catch((e) => { if (byHand) tellRep("Couldn't check for updates — " + ((e && e.message) || "no connection") + ". Try again later."); });
  } catch (e) { console.warn("[updater]", e && e.message); }
}
/* "Check for updates" used to say nothing at all — up to date, downloading or
   failed looked the same, so reps clicked it again and again. Updates also
   only installed on quit, which reps with start-with-Windows almost never do,
   so a downloaded one is offered on the bubble's menu as well. */
let updateReady = null;
function tellRep(message) {
  const parent = [bubble, win].find((w) => w && !w.isDestroyed() && w.isVisible());
  const opts = { type: "info", title: "Karma Connect Dialer", message, buttons: ["OK"] };
  (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts)).catch(() => {});
}
function restartToUpdate() {
  // never under a ringing or live call — quitting drops it
  if (!updater || !updateReady || bubbleState.call) return;
  updater.quitAndInstall();
}

app.whenReady().then(() => {
  app.setAppUserModelId("com.karmastaff.karmaconnect.dialer");
  serveAppFiles();
  autoStartFirstRun();

  /* The softphone needs the microphone (and to pick the speaker) — granted
     only to the dialer's origin. The check handler is handed a full URL
     ("https://…/leads/?embed=dialer"), not a bare origin: comparing it to
     DIALER_ORIGIN as a string always failed, so Chromium hid the device ids,
     the dialer asked for "exactly" a microphone with an empty id, and every
     call died at once with OverconstrainedError. Compare origins instead. */
  /* Only while the window is ON the dialer page (/leads), not anywhere on
     the origin: the sign-in page shares the origin and never needs the mic. */
  const allowed = new Set(["media", "microphone", "audioCapture", "speaker-selection"]);
  const fromDialer = (url) => { try { return new URL(url).origin === DIALER_ORIGIN; } catch (e) { return false; } };
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(allowed.has(permission) && onDialerPage(wc.getURL())
      && !(details?.mediaTypes || []).includes("video"));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) =>
    allowed.has(permission) && details?.mediaType !== "video"
      && (fromDialer(origin) || fromDialer(details?.requestingUrl))
      // a check can come without a web contents; the request above still gates the mic itself
      && (!wc || onDialerPage(wc.getURL())));

  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

  checkForUpdates(false);
  setInterval(() => checkForUpdates(false), 4 * 60 * 60 * 1000);
});

/* Belt and braces for every web contents this app ever creates: nothing may
   attach a <webview>, and no new window opens inside the app. */
app.on("web-contents-created", (_e, wc) => {
  wc.on("will-attach-webview", (e) => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: "deny" }; });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
