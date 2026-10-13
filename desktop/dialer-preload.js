"use strict";
/* The dialer window's one bridge to the app. The window is frameless, so the
   softphone's own header is the title bar: its minimise and close buttons
   (leads/public/index.html, .kd-win) call these. `show` brings the window out
   of the bubble. `state` tells the bubble what to show while the dialer is
   minimised (presence, reminders count, a ringing or live call) — sent only
   when something changed, since the page renders often. Nothing else is
   exposed to the web page. */
const { contextBridge, ipcRenderer } = require("electron");
let last = "";
contextBridge.exposeInMainWorld("kcDesktop", {
  show: () => ipcRenderer.send("kc-restore"),
  minimize: () => ipcRenderer.send("kc-minimize"),
  close: () => ipcRenderer.send("kc-close"),
  state: (s) => {
    const clean = {
      registered: !!(s && s.registered),
      badge: Math.max(0, Math.min(999, Number(s && s.badge) || 0)),
      call: s && (s.call === "ring" || s.call === "live") ? s.call : "",
    };
    const key = JSON.stringify(clean);
    if (key === last) return;
    last = key;
    ipcRenderer.send("kc-state", clean);
  },
});
