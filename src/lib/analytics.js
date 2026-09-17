// Analytics + A/B client. Pipeline funnel, conversion KPIs, per-sender and per-angle
// performance, plus logging a "message sent" event (the A/B signal). No AI tokens.

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

export const getAnalytics = () => api("/api/analytics");

// Fire-and-forget: record that a generated message was sent. kind is normalized to the
// five tracked types; angle is the variant label; senderId is the voice used.
export function logMessageSend({ prospectId, kind, angle, senderId, message, personalization, acceptance }) {
  const k = String(kind || "");
  const norm = k.startsWith("meeting") ? "meeting" : k.startsWith("followup") ? "followup" : k;
  return api("/api/message-sends", { method: "POST", body: { prospectId: prospectId || null, kind: norm, angle: angle || "", senderId: senderId || "", message: message || "", personalization, acceptance } })
    .catch(() => {}); // never block the UI on analytics
}
