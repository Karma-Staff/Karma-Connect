// Per-account prospect history. Backed by the backend `prospects` table (scoped by the
// user_id in the verified JWT) when signed in, so history follows the user across devices
// and survives a cleared browser. Falls back to localStorage when offline/unauthenticated,
// and reconciles any local-only entries up to the server once on the next sign-in.
//
// Signatures are unchanged for the app (listHistory / writeHistory / deleteHistory). They
// are async (DB reads can't be synchronous) and paginated (page size 25, newest first).
import { getAccessToken, currentUser } from "./auth.js";

const PAGE_SIZE = 25;
const lsKey = (email) => "kc_hist_" + (email || "anon").toLowerCase();
const reconciledKey = (uid) => "kc_reconciled_" + uid;

function lsRead(email) { try { return JSON.parse(localStorage.getItem(lsKey(email)) || "[]") || []; } catch (e) { return []; } }
function lsWrite(email, list) { try { localStorage.setItem(lsKey(email), JSON.stringify(list)); } catch (e) {} }
function lsMerge(email, list) {
  const existing = lsRead(email);
  const ids = new Set(list.map((e) => e.id));
  lsWrite(email, [...list, ...existing.filter((e) => !ids.has(e.id))]);
}

const rowToEntry = (r) => ({ id: r.id, label: r.label, sub: r.sub, status: r.status || "new", nextActionAt: r.next_action_at || null, nextActionNote: r.next_action_note || "", savedAt: r.updated_at, snapshot: r.data || {} });
const entryToRow = (e) => ({ id: e.id, label: e.label || "", sub: e.sub || "", status: e.status || "new", data: e.snapshot || {} });

async function api(path, { method = "GET", body } = {}) {
  const token = getAccessToken();
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error("History request failed (" + res.status + ").");
  return res.status === 204 ? null : res.json();
}

// One-time: push local-only entries to the server after first sign-in, then clear local.
async function reconcile(email, userId) {
  try {
    if (localStorage.getItem(reconciledKey(userId))) return;
    const local = lsRead(email);
    if (local.length) await api("/api/history", { method: "POST", body: { entries: local.map(entryToRow) } });
    localStorage.setItem(reconciledKey(userId), "1");
    lsWrite(email, []);
  } catch (e) { /* leave local intact; try again next sign-in */ }
}

// Read a page (page 0 = newest 25). Optional { q, status } filters (server-side when signed
// in; client-side over the local list when offline). Returns [{ id, label, sub, status, savedAt, snapshot }].
export async function listHistory(email, page = 0, { q = "", status = "" } = {}) {
  const user = currentUser();
  if (!user || !getAccessToken()) {
    let list = lsRead(email);
    if (q) { const s = q.toLowerCase(); list = list.filter((e) => (e.label || "").toLowerCase().includes(s) || (e.sub || "").toLowerCase().includes(s)); }
    if (status) list = list.filter((e) => (e.status || "new") === status);
    return list;
  }
  try {
    if (page === 0) await reconcile(email, user.id);
    const qs = new URLSearchParams({ page: String(page) });
    if (q) qs.set("q", q);
    if (status) qs.set("status", status);
    const data = await api("/api/history?" + qs.toString());
    return (data?.rows || []).map(rowToEntry);
  } catch (e) { return lsRead(email); }
}

// Update the pipeline status of one saved lead.
export async function setLeadStatus(email, id, status) {
  const user = currentUser();
  if (!user || !getAccessToken()) {
    const list = lsRead(email).map((e) => (e.id === id ? { ...e, status } : e));
    lsWrite(email, list);
    return;
  }
  try {
    await api("/api/history/" + encodeURIComponent(id) + "/status", { method: "POST", body: { status } });
  } catch (e) { /* best-effort */ }
}

// Upsert one or more entries (merge — does not delete anything).
export async function writeHistory(email, entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  const user = currentUser();
  if (!user || !getAccessToken()) { lsMerge(email, list); return; }
  try {
    await api("/api/history", { method: "POST", body: { entries: list.map(entryToRow) } });
  } catch (e) { lsMerge(email, list); }
}

// Delete one saved prospect by id.
export async function deleteHistory(email, id) {
  const user = currentUser();
  if (!user || !getAccessToken()) { lsWrite(email, lsRead(email).filter((e) => e.id !== id)); return; }
  try {
    await api("/api/history/" + encodeURIComponent(id), { method: "DELETE" });
  } catch (e) { lsWrite(email, lsRead(email).filter((e) => e.id !== id)); }
}

export const HISTORY_PAGE_SIZE = PAGE_SIZE;
