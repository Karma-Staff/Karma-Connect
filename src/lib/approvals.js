// Client helper for the lead-approval gate. Members request approval for a lead to unlock
// the Relationship / Meeting / Follow-up engines; admins approve or deny.
import { getAccessToken } from "./auth.js";

async function api(path, { method = "GET", body } = {}) {
  const token = getAccessToken();
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data?.error?.message || ("Request failed (" + res.status + ")."));
  return data;
}

// Member: request approval for a lead, optionally addressed to a chosen admin. Returns { prospect_id, status }.
export async function requestApproval(prospectId, label, sub, assignedAdminId) {
  const d = await api("/api/approvals", { method: "POST", body: { prospectId, label, sub, assignedAdminId: assignedAdminId || null } });
  return d.approval;
}

// Any signed-in user: list of admins to choose who should review a request.
export async function listAdmins() {
  const d = await api("/api/admins");
  return d.admins || [];
}

// Member: map of { prospect_id: status } for the signed-in member's leads.
export async function myApprovals() {
  const d = await api("/api/approvals/mine");
  const map = {};
  for (const a of d.approvals || []) map[a.prospect_id] = a.status;
  return map;
}

// Admin: full list of requests (pending first).
export async function listApprovals() {
  const d = await api("/api/approvals");
  return d.approvals || [];
}

// Admin: approve or deny a request by id.
export async function decideApproval(id, decision) {
  const d = await api("/api/approvals/" + encodeURIComponent(id) + "/decide", { method: "POST", body: { decision } });
  return d.approval;
}
