// Per-lead notes & activity timeline. No AI tokens used.
import { getAccessToken } from "./auth.js";

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + getAccessToken() },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) throw new Error(data?.error?.message || "Request failed (" + res.status + ").");
  return data;
}

const enc = (id) => encodeURIComponent(id);
export async function listNotes(prospectId) { return (await api("/api/leads/" + enc(prospectId) + "/notes")).notes || []; }
export async function addNote(prospectId, body) { return (await api("/api/leads/" + enc(prospectId) + "/notes", { method: "POST", body: { body } })).note; }
export async function deleteNote(prospectId, noteId) { return api("/api/leads/" + enc(prospectId) + "/notes/" + enc(noteId), { method: "DELETE" }); }
