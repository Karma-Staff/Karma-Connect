"use strict";
/* The dialer window's one bridge to the app. The window is frameless, so the
   softphone's own header is the title bar: its minimise and close buttons
   (leads/public/index.html, .kd-win) call these. `show` brings the window out
   of the bubble. Nothing else is exposed to the web page. */
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("kcDesktop", {
  show: () => ipcRenderer.send("kc-restore"),
  minimize: () => ipcRenderer.send("kc-minimize"),
  close: () => ipcRenderer.send("kc-close"),
});
