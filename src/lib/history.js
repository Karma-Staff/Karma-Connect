// Per-account prospect history. Stored in localStorage keyed by the signed-in email so each
// account keeps its own list. (When Supabase cloud storage is wired up, swap these two
// functions for table reads/writes — the rest of the app calls only these.)
const KEY = (email) => "kc_hist_" + (email || "anon").toLowerCase();

export function listHistory(email) {
  try { return JSON.parse(localStorage.getItem(KEY(email)) || "[]") || []; } catch (e) { return []; }
}

export function writeHistory(email, list) {
  try { localStorage.setItem(KEY(email), JSON.stringify(list)); } catch (e) {}
}
