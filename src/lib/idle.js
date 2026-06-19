// Inactivity auto-logout. For security, an unattended session is signed out after
// IDLE_MS of no user activity. Works for both auth modes: it clears the JWT (remote)
// and the per-browser gate key (local), then reloads to the login screen.
//
// The last-activity time is persisted, so a tab left open then revisited — or reloaded —
// past the limit is logged out immediately rather than getting a fresh 30 minutes.

import { getAccessToken, signOut } from "./auth.js";

const IDLE_MS = 30 * 60 * 1000; // 30 minutes
const LAST_ACTIVE_KEY = "kc_last_active";
const LOCAL_GATE_KEY = "kc_email"; // matches AuthGate's LS_KEY (per-browser fallback)
const ACTIVITY = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "wheel", "click"];

let timer = null;
let lastWrite = 0;

function loggedIn() {
  try {
    return !!getAccessToken() || !!localStorage.getItem(LOCAL_GATE_KEY);
  } catch (e) { return false; }
}

function readLastActive() {
  try { return Number(localStorage.getItem(LAST_ACTIVE_KEY)) || 0; } catch (e) { return 0; }
}
function writeLastActive(now) {
  try { localStorage.setItem(LAST_ACTIVE_KEY, String(now)); } catch (e) {}
}

function doLogout() {
  if (!loggedIn()) return;
  try { signOut(); } catch (e) {}                              // clears the JWT, flips the gate
  try { localStorage.removeItem(LOCAL_GATE_KEY); } catch (e) {} // local-mode session
  try { localStorage.removeItem(LAST_ACTIVE_KEY); } catch (e) {}
  // Reload so the per-browser gate (React state) also drops to the login screen, and add a
  // marker the login screen can read to explain why.
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("timeout", "1");
    window.location.replace(url.pathname + url.search);
  } catch (e) { try { window.location.reload(); } catch (e2) {} }
}

function arm(now) {
  if (timer) clearTimeout(timer);
  const elapsed = now - readLastActive();
  const remaining = Math.max(0, IDLE_MS - elapsed);
  timer = setTimeout(doLogout, remaining);
}

function onActivity() {
  if (!loggedIn()) return;
  const now = Date.now();
  // Throttle storage writes to once every 5s; always re-arm the timer.
  if (now - lastWrite > 5000) { writeLastActive(now); lastWrite = now; }
  arm(now);
}

// Start the watcher. Safe to call once at app startup.
export function startIdleLogout() {
  if (typeof window === "undefined") return;
  const now = Date.now();
  // If we were already idle past the limit before this load, log out at once.
  if (loggedIn() && readLastActive() && now - readLastActive() >= IDLE_MS) { doLogout(); return; }
  writeLastActive(now); lastWrite = now;
  for (const evt of ACTIVITY) window.addEventListener(evt, onActivity, { passive: true });
  // Another tab updating the timestamp (shared session) keeps this tab's timer fresh.
  window.addEventListener("storage", (e) => { if (e.key === LAST_ACTIVE_KEY) arm(Date.now()); });
  arm(now);
}
