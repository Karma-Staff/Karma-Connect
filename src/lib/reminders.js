// Follow-up reminders (next-action date per lead). No AI tokens used.

async function api(path, { method = "GET", body } = {}) {
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

// date = ISO/yyyy-mm-dd string to set, or "" / null to clear.
export async function setReminder(prospectId, date, note) {
  return api("/api/history/" + encodeURIComponent(prospectId) + "/reminder", { method: "POST", body: { date: date || null, note: note || "" } });
}
export async function listReminders() {
  return (await api("/api/reminders")).reminders || [];
}
