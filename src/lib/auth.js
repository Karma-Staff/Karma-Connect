// Client auth against our own backend (server.js).
//
// The session is an httpOnly cookie the server sets at sign-in, NOT a token
// this code holds. Two consequences shape everything here:
//
//   - There is nothing to attach to requests. The browser sends the cookie on
//     same-origin calls by itself, so no caller builds an Authorization
//     header. It is also why Karma Leads, which never sets headers, shares the
//     same sign-in for free.
//   - "Am I signed in?" cannot be answered locally — the cookie is invisible
//     to page scripts, which is the point. It is answered by asking the server
//     (refreshUser → /api/auth/me) and caching the reply.
//
// The cached user in localStorage is a convenience only: it lets the UI paint
// before /api/auth/me answers. The cookie is the authority, so a stale cache
// costs nothing — the next request either succeeds or 401s and clears it.
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

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) throw new Error(data?.error?.message || "Request failed (" + res.status + ").");
  return data;
}

export async function signUp({ email, password, firstName, lastName }) {
  const data = await post("/api/auth/signup", { email, password, firstName, lastName });
  // With email confirmation on, the server returns { needsVerification: true }
  // and sets no cookie — don't treat that as being signed in; the caller shows
  // a "check your email" notice instead.
  if (data.user) setUser(data.user);
  return data;
}

// Ask the server to re-send the confirmation email for an unverified account.
export async function resendVerification(email) {
  return post("/api/auth/resend", { email });
}

// Request a password-reset email (the server replies the same way whether or
// not the account exists, so this cannot be used to discover who has one).
export async function requestPasswordReset(email) {
  return post("/api/auth/forgot", { email });
}

// Complete a reset with the emailed token + a new password. The server signs
// you in on success by setting the cookie.
export async function resetPassword(token, password) {
  const data = await post("/api/auth/reset", { token, password });
  if (data.user) setUser(data.user);
  return data;
}

export async function signIn({ email, password }) {
  const data = await post("/api/auth/signin", { email, password });
  setUser(data.user);
  return data;
}

// Clears the cookie server-side as well as the cached user — dropping the
// local copy alone would leave a live session on the browser.
export async function signOut() {
  setUser(null);
  try { await fetch("/api/auth/signout", { method: "POST" }); } catch (e) { /* ignore */ }
}


// Change password while signed in (current password required).
export async function changePassword(currentPassword, newPassword) {
  return post("/api/auth/password", { currentPassword, newPassword });
}

// Permanently delete the signed-in account (password-confirmed). Signs out.
export async function deleteAccount(password) {
  const res = await fetch("/api/auth/account", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: password || "" }),
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
    // Network blip — keep what we had rather than falsely signing out.
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
    // the local bypass makes every request authenticated, so the gate should
    // stand aside even when there is no database behind it
    authAvailable.devAuth = !!data.devAuth;
    _available = !!data.db;
  } catch (e) { _available = false; }
  return _available;
}
