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
 *   - Minimise collapses to a floating BUBBLE (bottom-right, always on top), not
 *     the taskbar; click the bubble to bring the dialer back. The window never
 *     has a taskbar button at all — it is either open or a bubble.
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

function showBubble() {
  if (bubble && !bubble.isDestroyed()) { bubble.show(); return; }
  const area = screen.getPrimaryDisplay().workArea;
  bubble = new BrowserWindow({
    width: 76, height: 76,
    x: area.x + area.width - 100, y: area.y + area.height - 100,
    frame: false, transparent: true, resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, "bubble-preload.js") },
  });
  bubble.setAlwaysOnTop(true, "screen-saver");
  bubble.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bubble.loadFile(path.join(__dirname, "bubble.html"));
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
