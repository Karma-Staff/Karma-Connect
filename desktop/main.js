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

const { app, BrowserWindow, session, shell, ipcMain, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const DIALER_URL = process.env.KC_DIALER_URL
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
      contextIsolation: true, nodeIntegration: false,
      preload: path.join(__dirname, "dialer-preload.js"),
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadURL(DIALER_URL);

  const keepEmbed = (e, url) => { const f = forceEmbed(url); if (f) { e.preventDefault(); win.loadURL(f); } };
  win.webContents.on("will-navigate", keepEmbed);
  win.webContents.on("will-redirect", keepEmbed);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^tel:|^mailto:/i.test(url)) shell.openExternal(url);
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
      contextIsolation: true, nodeIntegration: false,
      preload: path.join(__dirname, "bubble-preload.js"),
    },
  });
  bubble.setAlwaysOnTop(true, "screen-saver");
  bubble.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bubble.webContents.on("did-finish-load", pushBubbleState);
  bubble.loadFile(path.join(__dirname, "bubble.html"));
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
ipcMain.on("kc-close", () => { if (win && !win.isDestroyed()) win.close(); });
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

app.whenReady().then(() => {
  /* Open automatically when the person logs into Windows, so the dialer is
     always running and floating — there the moment they open Karma Connect, no
     need to launch it by hand. Only for the INSTALLED app (openAtLogin on a
     dev `npm start` would register the Electron binary, not the real app). */
  if (app.isPackaged) {
    try { app.setLoginItemSettings({ openAtLogin: true, openAsHidden: false }); }
    catch (e) { /* not fatal */ }
  }

  // the softphone needs the microphone — grant it only to the dialer's origin
  const allowed = new Set(["media", "microphone", "audioCapture"]);
  const fromDialer = (url) => { try { return new URL(url).origin === DIALER_ORIGIN; } catch (e) { return false; } };
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(allowed.has(permission) && fromDialer(wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) =>
    allowed.has(permission) && origin === DIALER_ORIGIN);

  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
