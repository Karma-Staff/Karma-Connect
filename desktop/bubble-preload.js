"use strict";
/* The bubble is a tiny trusted local page; this is the only bridge it needs —
   a click asks the main process to bring the dialer window back. */
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("kc", {
  restore: () => ipcRenderer.send("kc-restore"),
});
