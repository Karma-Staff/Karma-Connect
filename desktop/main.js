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
 *     the taskbar; click the bubble to bring the dialer back.
 */

const { app, BrowserWindow, session, shell, ipcMain, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const DIALER_URL = process.env.KC_DIALER_URL
  || "https://karma-connect-9s2z.onrender.com/leads/?embed=dialer";
let DIALER_ORIGIN = "";
try { DIALER_ORIGIN = new URL(DIALER_URL).origin; } catch (e) { /* leave blank */ }

const ICON = path.join(__dirname, "icons", "icon.png");

// call audio must play without a click, or the far end is silent
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let bubble = null;

const stateFile = () => path.join(app.getPath("userData"), "window-state.json");
function loadBounds() { try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch (e) { return {}; } }
function saveBounds() {
  try { if (win && !win.isDestroyed()) fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds())); }
  catch (e) { /* fine */ }
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
  const b = loadBounds();
  win = new BrowserWindow({
    width: b.width || 380, height: b.height || 680,
    x: b.x, y: b.y, minWidth: 320, minHeight: 480,
    title: "Karma Connect Dialer",
    icon: ICON,
    backgroundColor: "#0e1626",
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
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

  // minimise → a floating bubble instead of the taskbar
  win.on("minimize", (e) => { e.preventDefault(); win.hide(); showBubble(); });
  win.on("resize", saveBounds);
  win.on("move", saveBounds);
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

ipcMain.on("kc-restore", () => {
  if (bubble && !bubble.isDestroyed()) bubble.hide();
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});

app.on("second-instance", () => {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  else createWindow();
});

app.whenReady().then(() => {
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
