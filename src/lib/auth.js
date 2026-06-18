// Client auth against our own backend (server.js). Replaces the old Supabase client.
// We hold a JWT (minted by the server, HS256) in localStorage and attach it as a Bearer
// token on API calls. The token carries the user id/email the server trusts for scoping.
//
// When the backend has no database (local dev without DATABASE_URL), `authAvailable()`
// resolves false and the app falls back to the per-browser password gate (see AuthGate).

const TOKEN_KEY = "kc_token";
const USER_KEY = "kc_user";

let token = null;
let user = null;
try {
  token = localStorage.getItem(TOKEN_KEY) || null;
  user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
} catch (e) { /* ignore */ }

const listeners = new Set();
function notify() { for (const fn of listeners) { try { fn(user); } catch (e) {} } }

export function onAuthChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getAccessToken() { return token; }
export function currentUser() { return user; }

function setSession(data) {
  token = data?.token || null;
  user = data?.user || null;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user)); else localStorage.removeItem(USER_KEY);
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

export async function signUp({ email, password, firstName, lastName, adminCode }) {
  const data = await post("/api/auth/signup", { email, password, firstName, lastName, adminCode });
  // When email verification is on, the server returns { needsVerification: true } and no
  // token — don't log in; the caller shows a "check your email" notice instead.
  if (data.token) setSession(data);
  return data;
}

// Ask the server to re-send the confirmation email for an unverified account.
export async function resendVerification(email) {
  return post("/api/auth/resend", { email });
}

// Request a password-reset email (server replies uniformly whether or not the account exists).
export async function requestPasswordReset(email) {
  return post("/api/auth/forgot", { email });
}

// Complete a reset with the emailed token + a new password. On success the server returns a
// session token and we log straight in.
export async function resetPassword(token, password) {
  const data = await post("/api/auth/reset", { token, password });
  if (data.token) setSession(data);
  return data;
}

export async function signIn({ email, password }) {
  const data = await post("/api/auth/signin", { email, password });
  setSession(data);
  return data;
}

export function signOut() { setSession(null); }

// Update just the stored user object (keeps the current token) and notify listeners.
function setUser(u) {
  if (!u) return;
  user = u;
  try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch (e) { /* ignore */ }
  notify();
}

// Self-promote to admin using the signup code. Updates the local session on success.
export async function promoteToAdmin(adminCode) {
  const res = await fetch("/api/auth/promote", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: JSON.stringify({ adminCode: adminCode || "" }),
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) throw new Error(data?.error?.message || "Could not update your role.");
  setUser(data.user);
  return data;
}

// Permanently delete the signed-in account (password-confirmed). Signs out on success.
export async function deleteAccount(password) {
  const res = await fetch("/api/auth/account", {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: JSON.stringify({ password: password || "" }),
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) throw new Error(data?.error?.message || "Could not delete the account.");
  signOut();
  return data;
}

// Validate the stored token against the server; clears it if rejected. Returns the user or null.
export async function refreshUser() {
  if (!token) return null;
  try {
    const res = await fetch("/api/auth/me", { headers: { Authorization: "Bearer " + token } });
    if (!res.ok) { if (res.status === 401) setSession(null); return null; }
    const data = await res.json();
    user = data.user || user;
    try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch (e) {}
    return user;
  } catch (e) { return user; }
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
