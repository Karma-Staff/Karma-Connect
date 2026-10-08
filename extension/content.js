/* Karma Connect Dialer — the floating widget injected into every website.
 *
 * It is deliberately thin: the dialler itself is the real Karma Connect
 * softphone, loaded in an <iframe> at <app>/?embed=dialer. The iframe inherits
 * the rep's Karma Connect login (same-origin cookie) and reuses every bit of
 * the calling code that already exists — RingCentral, recording, voicemail
 * drop. This script only does what a web page cannot do on its own: put that
 * dialler on top of ANY site and let the rep drag it anywhere.
 *
 * Everything lives inside a Shadow DOM so the host site's CSS cannot reach in
 * and break it. Position and open/closed state are kept in chrome.storage, so
 * the widget is where the rep left it on the next page and the next site.
 *
 * Known Phase-1 limit: a full page load of the HOST site reloads this script
 * and the iframe, which drops a call in progress. Keeping a call alive across
 * navigations needs an MV3 offscreen document holding the WebPhone — that is
 * the next phase and is sketched in background.js / README.md. */
(async () => {
  "use strict";
  if (window.top !== window) return;                 // top frame only

  const store = {
    get: (k, d) => new Promise((r) => chrome.storage.local.get(k, (o) => r(k in o ? o[k] : d))),
    set: (o) => new Promise((r) => chrome.storage.local.set(o, r)),
  };

  const appUrl = (await store.get("kcAppUrl", "") || globalThis.KC_APP_URL_DEFAULT || "").replace(/\/+$/, "");
  if (!appUrl || appUrl.includes("your-app.onrender.com")) {
    // Not configured yet — do nothing rather than inject a broken frame.
    console.warn("[Karma Dialer] Set the app URL in the extension's Options page.");
    return;
  }
  // Don't inject the widget on the app's own pages — that would be a dialler
  // inside the dialler.
  try { if (new URL(appUrl).origin === location.origin) return; } catch (e) { /* bad URL → bail below */ }

  // A per-install token, also put in the iframe URL, so only we can post a
  // dial request into the dialler (a host page can find the iframe in the DOM).
  let token = await store.get("kcToken", "");
  if (!token) { token = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2); await store.set({ kcToken: token }); }

  const DIAL_SRC = `${appUrl}/?embed=dialer&k=${encodeURIComponent(token)}`;
  const Z = 2147483000;                               // above basically everything

  // ---- build the UI inside a shadow root ----
  const host = document.createElement("div");
  host.id = "kc-dialer-ext";
  host.style.cssText = `all: initial; position: fixed; z-index: ${Z};`;
  (document.body || document.documentElement).appendChild(host);
  const sh = host.attachShadow({ mode: "open" });
  sh.innerHTML = `
    <style>
      :host, * { box-sizing: border-box; }
      .wrap { position: fixed; font-family: -apple-system, Segoe UI, Roboto, sans-serif; }
      .bubble {
        width: 56px; height: 56px; border-radius: 50%; cursor: grab;
        display: grid; place-items: center; color: #fff; border: none;
        background: linear-gradient(160deg, #2b6ef2, #1b4fd0);
        box-shadow: 0 10px 24px -6px rgba(10,30,80,.55), 0 2px 6px rgba(0,0,0,.25);
        touch-action: none; user-select: none; transition: transform .12s ease;
      }
      .bubble:hover { transform: scale(1.05); }
      .bubble.dragging { cursor: grabbing; }
      .bubble svg { width: 26px; height: 26px; fill: none; stroke: #fff; stroke-width: 2; }
      .bubble .dot { position: absolute; top: 2px; right: 2px; width: 13px; height: 13px;
        border-radius: 50%; background: #16c784; border: 2px solid #1b4fd0; display: none; }
      .bubble.oncall .dot { display: block; animation: pulse 1.6s ease-in-out infinite; }
      @keyframes pulse { 50% { opacity: .35; } }

      .panel { width: 340px; height: 604px; max-height: calc(100vh - 24px);
        background: #0e1626; border-radius: 16px; overflow: hidden; display: none;
        box-shadow: 0 24px 60px -12px rgba(0,0,0,.6), 0 8px 20px -8px rgba(0,0,0,.4);
        border: 1px solid rgba(255,255,255,.08); }
      .panel.show { display: block; }
      .bar { height: 34px; display: flex; align-items: center; gap: 6px; padding: 0 6px 0 12px;
        background: #0b1220; color: #cdd7ea; cursor: grab; touch-action: none; user-select: none;
        font-size: 12px; font-weight: 600; }
      .bar.dragging { cursor: grabbing; }
      .bar .t { flex: 1; letter-spacing: .02em; }
      .bar button { width: 24px; height: 24px; border: none; background: transparent; color: #9fb0cc;
        border-radius: 6px; cursor: pointer; font-size: 15px; line-height: 1; }
      .bar button:hover { background: rgba(255,255,255,.08); color: #fff; }
      iframe { width: 100%; height: calc(100% - 34px); border: 0; display: block; background: #0e1626; }
    </style>
    <div class="wrap">
      <button class="bubble" title="Karma Connect dialler — drag me anywhere">
        <span class="dot"></span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>
      </button>
      <div class="panel" role="dialog" aria-label="Karma Connect dialler">
        <div class="bar"><span class="t">Karma Connect</span>
          <button class="min" title="Minimise">—</button></div>
        <!-- iframe is created lazily on first open, so a rep who never calls
             never loads the softphone on every page -->
      </div>
    </div>`;

  const wrap = sh.querySelector(".wrap");
  const bubble = sh.querySelector(".bubble");
  const panel = sh.querySelector(".panel");
  const bar = sh.querySelector(".bar");
  let iframe = null;

  function ensureFrame() {
    if (iframe) return iframe;
    iframe = document.createElement("iframe");
    iframe.src = DIAL_SRC;
    iframe.allow = "microphone; autoplay";
    iframe.addEventListener("load", () => { iframe.dataset.ready = "1"; });
    panel.appendChild(iframe);
    return iframe;
  }

  // ---- position: remembered across pages and sites ----
  const SIZE = { bubble: [56, 56], panel: [340, 604] };
  let pos = await store.get("kcPos", null);           // {x, y} top-left of the wrap
  let open = await store.get("kcOpen", false);

  function clamp(x, y, w, h) {
    return [
      Math.max(6, Math.min(x, innerWidth - w - 6)),
      Math.max(6, Math.min(y, innerHeight - h - 6)),
    ];
  }
  function layout() {
    const [w, h] = open ? SIZE.panel : SIZE.bubble;
    if (!pos) { pos = { x: innerWidth - w - 20, y: innerHeight - h - 20 }; }
    const [x, y] = clamp(pos.x, pos.y, w, h);
    pos = { x, y };
    wrap.style.left = x + "px";
    wrap.style.top = y + "px";
    bubble.style.display = open ? "none" : "grid";
    panel.classList.toggle("show", open);
    if (open) ensureFrame();
  }
  function setOpen(v) { open = v; store.set({ kcOpen: v }); layout(); }

  bubble.addEventListener("click", () => { if (!bubble._suppress) setOpen(true); });
  sh.querySelector(".min").addEventListener("click", () => setOpen(false));

  // ---- drag (bubble or panel bar) ----
  function dragFrom(handle) {
    let d = null;
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const r = wrap.getBoundingClientRect();
      d = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("dragging");
    });
    handle.addEventListener("pointermove", (e) => {
      if (!d) return;
      const [w, h] = open ? SIZE.panel : SIZE.bubble;
      const [x, y] = clamp(e.clientX - d.dx, e.clientY - d.dy, w, h);
      if (Math.abs(x - pos.x) + Math.abs(y - pos.y) > 3) d.moved = true;
      pos = { x, y }; wrap.style.left = x + "px"; wrap.style.top = y + "px";
    });
    const end = () => {
      if (!d) return;
      handle.classList.remove("dragging");
      // a drag that moved should not also count as a click that opens/closes
      if (d.moved) { handle._suppress = true; setTimeout(() => (handle._suppress = false), 0); }
      store.set({ kcPos: pos });
      d = null;
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }
  dragFrom(bubble);
  dragFrom(bar);
  addEventListener("resize", layout);
  layout();

  // ---- dial a number: from the toolbar button, the context menu, or a tel: click ----
  function dial(number, now) {
    const n = String(number || "").trim();
    if (!n) return;
    setOpen(true);
    ensureFrame();
    const send = () => iframe.contentWindow?.postMessage({ kc: "dial", number: n, k: token, now: now !== false }, "*");
    // if the frame is still loading, wait for it
    if (iframe.dataset.ready) send();
    else iframe.addEventListener("load", send, { once: true });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "kc-call") dial(msg.number, true);
    if (msg.type === "kc-toggle") setOpen(!open);
  });

  // tel: links anywhere on the page → dial through Karma, not the OS handler
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest('a[href^="tel:"]');
    if (!a) return;
    e.preventDefault();
    dial(decodeURIComponent(a.getAttribute("href").slice(4)), true);
  }, true);
})();
