// Admin-only member management. All calls are admin-gated server-side. No AI tokens used.

async function adminFetch(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) throw new Error(data?.error?.message || "Request failed (" + res.status + ").");
  return data;
}

/* Returns { users, youAreOwner }. The caller's tier comes back with the list
   rather than being inferred from the signed-in user, because the question
   the screen asks — may I appoint admins — is the server's to answer. */
export async function listUsers() {
  const data = await adminFetch("/api/admin/users");
  return { users: data.users || [], youAreOwner: data.you?.isOwner === true };
}

export async function setUserRole(id, isAdmin) {
  return adminFetch("/api/admin/users/" + encodeURIComponent(id) + "/role", { method: "POST", body: { isAdmin } });
}

export async function removeUser(id) {
  return adminFetch("/api/admin/users/" + encodeURIComponent(id), { method: "DELETE" });
}

// Team activity feed + windowed leaderboard (admin-only). Returns { feed, leaderboard, days }.
export async function fetchTeamActivity(days = 7) {
  return adminFetch("/api/admin/activity?days=" + encodeURIComponent(days));
}
