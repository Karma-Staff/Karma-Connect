// Admin-only member management. All calls are admin-gated server-side. No AI tokens used.
import { getAccessToken } from "./auth.js";

async function adminFetch(path, { method = "GET", body } = {}) {
  const token = getAccessToken();
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) throw new Error(data?.error?.message || "Request failed (" + res.status + ").");
  return data;
}

export async function listUsers() {
  const data = await adminFetch("/api/admin/users");
  return data.users || [];
}

export async function setUserRole(id, isAdmin) {
  return adminFetch("/api/admin/users/" + encodeURIComponent(id) + "/role", { method: "POST", body: { isAdmin } });
}

export async function removeUser(id) {
  return adminFetch("/api/admin/users/" + encodeURIComponent(id), { method: "DELETE" });
}
