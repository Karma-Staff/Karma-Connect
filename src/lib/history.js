// Per-account prospect history. Backed by the Supabase `public.prospects` table (RLS keyed
// by auth.uid()) when the user is signed in, so history follows them across devices and
// survives a cleared browser. Falls back to localStorage when offline/unauthenticated, and
// reconciles any local-only entries up to the cloud once on the next sign-in.
//
// Signatures are unchanged for the app (listHistory / writeHistory), plus deleteHistory.
// They are async (DB reads can't be synchronous) and paginated (page size 25, newest first).
import { supabase } from "./supabase.js";

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

async function currentUser() {
  if (!supabase) return null;
  try { const { data } = await supabase.auth.getUser(); return data?.user || null; } catch (e) { return null; }
}

const rowToEntry = (r) => ({ id: r.id, label: r.label, sub: r.sub, savedAt: r.updated_at, snapshot: r.data || {} });
const entryToRow = (userId, e) => ({ id: e.id, user_id: userId, label: e.label || "", sub: e.sub || "", data: e.snapshot || {} });

// One-time: push local-only entries to the cloud after first sign-in, then clear local.
async function reconcile(email, userId) {
  try {
    if (localStorage.getItem(reconciledKey(userId))) return;
    const local = lsRead(email);
    if (local.length) await supabase.from("prospects").upsert(local.map((e) => entryToRow(userId, e)), { onConflict: "id" });
    localStorage.setItem(reconciledKey(userId), "1");
    lsWrite(email, []);
  } catch (e) { /* leave local intact; try again next sign-in */ }
}

// Read a page (page 0 = newest 25). Returns [{ id, label, sub, savedAt, snapshot }].
export async function listHistory(email, page = 0) {
  const user = await currentUser();
  if (!user) return lsRead(email);
  try {
    if (page === 0) await reconcile(email, user.id);
    const from = page * PAGE_SIZE;
    const { data, error } = await supabase
      .from("prospects")
      .select("id,label,sub,data,updated_at")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    return (data || []).map(rowToEntry);
  } catch (e) { return lsRead(email); }
}

// Upsert one or more entries (merge — does not delete anything).
export async function writeHistory(email, entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  const user = await currentUser();
  if (!user) { lsMerge(email, list); return; }
  try {
    const { error } = await supabase.from("prospects").upsert(list.map((e) => entryToRow(user.id, e)), { onConflict: "id" });
    if (error) throw error;
  } catch (e) { lsMerge(email, list); }
}

// Delete one saved prospect by id.
export async function deleteHistory(email, id) {
  const user = await currentUser();
  if (!user) { lsWrite(email, lsRead(email).filter((e) => e.id !== id)); return; }
  try {
    const { error } = await supabase.from("prospects").delete().eq("user_id", user.id).eq("id", id);
    if (error) throw error;
  } catch (e) { lsWrite(email, lsRead(email).filter((e) => e.id !== id)); }
}

export const HISTORY_PAGE_SIZE = PAGE_SIZE;
