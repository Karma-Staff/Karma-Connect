"use strict";
/* The bubble is a tiny trusted local page; this is the whole bridge it needs.
   The page tracks the pointer and reports it; main.js owns the geometry (it
   moves the window with the real cursor position, which is DPI-safe) and
   decides whether a release was a click (restore the dialer) or a drop
   (remember the spot). State for the badges arrives from the dialer page via
   main.js (kc-state). */
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("kc", {
  restore: () => ipcRenderer.send("kc-restore"),
  dragStart: () => ipcRenderer.send("kc-bubble-drag", "start"),
  dragMove: () => ipcRenderer.send("kc-bubble-drag", "move"),
  dragEnd: () => ipcRenderer.send("kc-bubble-drag", "end"),
  onState: (cb) => ipcRenderer.on("kc-state", (e, s) => cb(s)),
});
