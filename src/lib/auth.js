// Client auth for the merged Karma site. Karma Connect and Karma Leads share ONE
// sign-in: WorkOS AuthKit, sealed into an httpOnly `kl_session` cookie by the
// server (leads/server/auth.js). Signing in here signs you into both.
//
// Consequences of that cookie being httpOnly, which shape this whole module:
//   - There is no token for JavaScript to read, store or attach. The browser
//     sends the cookie on same-origin requests by itself, so API callers build
//     no Authorization header at all.
//   - "Am I signed in?" cannot be answered locally. It is answered by asking the
//     server (refreshUser → /api/auth/me) and caching the reply.
//   - Signing in is a full-page navigation to WorkOS, not a fetch. `next` tells
//     the callback which half of the site to come back to.
//
// The cached user in localStorage is a convenience only — it lets the UI paint
// before /api/auth/me answers. The cookie is the actual authority, so a stale
// cache costs nothing: the next request either succeeds or 401s.
//
// When the backend has no database (local dev without DATABASE_URL),
// `authAvailable()` resolves false and the app falls back to the per-browser
// password gate (see AuthGate).

const USER_KEY = "kc_user";

let user = null;
try {
  user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
} catch (e) { /* ignore */ }

const listeners = new Set();
function notify() { for (const fn of listeners) { try { fn(user); } catch (e) {} } }

export function onAuthChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function currentUser() { return user; }
// Best-effort, cache-based. Authoritative answers come from the server.
export function isSignedIn() { return !!user; }

function setUser(u) {
  user = u || null;
  try {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  } catch (e) { /* ignore */ }
  notify();
}

// Where to send the browser to sign in. A navigation, not a fetch: WorkOS hosts
// the form. `next` is where the callback returns to once it succeeds.
export function signInUrl(next) {
  const to = next || (window.location.pathname + window.location.search);
  return "/api/auth/login?next=" + encodeURIComponent(to);
}

export function startSignIn(next) {
  window.location.assign(signInUrl(next));
}

// Ends the WorkOS session as well as the local one, so signing out of Connect
// also signs you out of Leads — one session, one sign-out.
export async function signOut() {
  setUser(null);
  try {
    const res = await fetch("/api/auth/logout?next=%2F", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    window.location.assign(data.url || "/");
  } catch (e) {
    window.location.assign("/");
  }
}

// Permanently delete the signed-in account. There is no password to confirm with
// any more, so the server asks for the account's own email address instead.
export async function deleteAccount(confirmEmail) {
  const res = await fetch("/api/auth/account", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmEmail: confirmEmail || "" }),
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) throw new Error(data?.error?.message || "Could not delete the account.");
  await signOut();
  return data;
}

// Ask the server who we are. This is the real signed-in check: a 401 means the
// cookie is missing or expired, so drop the cached user.
export async function refreshUser() {
  try {
    const res = await fetch("/api/auth/me");
    if (!res.ok) { if (res.status === 401 || res.status === 403) setUser(null); return null; }
    const data = await res.json();
    setUser(data.user || null);
    return user;
  } catch (e) {
    // Network blip — keep whatever we had rather than falsely signing out.
    return user;
  }
}

// Whether real (database-backed) accounts are available. Cached after the first probe.
let _available;
export async function authAvailable() {
  if (_available !== undefined) return _available;
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    _available = !!data.db;
  } catch (e) { _available = false; }
  return _available;
}
