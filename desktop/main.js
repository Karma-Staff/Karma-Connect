"use strict";
/* Karma Connect Dialer — desktop app (Electron).
 *
 * A small, always-on-top window that floats the Karma Connect softphone over
 * EVERY application on the computer, the way Zoho Voice's desktop app does. A
 * browser extension can only cover web pages inside the browser; this is a real
 * program, so it covers Outlook, Excel, a Zoom call — anything.
 *
 * It loads the dialer as the window's own top-level page (not an iframe), so it
 * is first-party: the microphone and the login cookie just work and persist,
 * with none of the cross-site framing/cookie trouble the extension needed.
 */

const { app, BrowserWindow, session, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

/* The dialer. Same embed view the extension uses — the dashboard hidden, just
   the softphone. Override with KC_DIALER_URL if the app ever moves. */
const DIALER_URL = process.env.KC_DIALER_URL
  || "https://karma-connect-9s2z.onrender.com/leads/?embed=dialer";

/* Call audio must play without a click, or the far end is silent until the rep
   interacts. Set before the app is ready. */
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

/* One window only: a second launch focuses the one that's open. */
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;

const stateFile = () => path.join(app.getPath("userData"), "window-state.json");
function loadBounds() {
  try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch (e) { return {}; }
}
function saveBounds() {
  try { if (win) fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds())); } catch (e) { /* fine */ }
}

function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    width: b.width || 380,
    height: b.height || 680,
    x: b.x, y: b.y,
    minWidth: 320,
    minHeight: 480,
    title: "Karma Connect Dialer",
    backgroundColor: "#0e1626",
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // float above other windows, even full-screen apps
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadURL(DIALER_URL);

  // tel:/external links open in the default browser, not inside the dialer
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^tel:|^mailto:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("resize", saveBounds);
  win.on("move", saveBounds);
  win.on("closed", () => { win = null; });
}

app.on("second-instance", () => {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});

app.whenReady().then(() => {
  /* The softphone needs the microphone. Grant media/mic to our own dialer
     origin only, and deny everything else. */
  const allowed = new Set(["media", "microphone", "audioCapture"]);
  let dialerOrigin = "";
  try { dialerOrigin = new URL(DIALER_URL).origin; } catch (e) { /* leave blank */ }
  const fromDialer = (url) => { try { return new URL(url).origin === dialerOrigin; } catch (e) { return false; } };

  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(allowed.has(permission) && fromDialer(wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) =>
    allowed.has(permission) && origin === dialerOrigin);

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// keep running in the background on Windows/Linux only while a window exists
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
