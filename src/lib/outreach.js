// Client helper for the outreach send queue. A generated message is queued here; the agent
// auto-sends approved EMAIL items, while LinkedIn items wait for the human one-click hand-off.

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data?.error?.message || ("Request failed (" + res.status + ")."));
  return data;
}

// Queue a generated message. channel: "email" | "linkedin".
//   { prospectId, leadLabel, channel, step, subject, body, toEmail, fromEmail, fromName }
export async function queueMessage(item) {
  const d = await api("/api/outreach/queue", { method: "POST", body: item });
  return d.item;
}

// List this user's queue. { sendingOn } tells the UI whether the server can auto-send email.
export async function listQueue({ status = "", channel = "" } = {}) {
  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (channel) qs.set("channel", channel);
  const d = await api("/api/outreach/queue" + (qs.toString() ? "?" + qs.toString() : ""));
  return { items: d.items || [], sendingOn: !!d.sendingOn };
}

// Approve a pending item (email then auto-sends). Pass toEmail/subject to fill them in first.
export async function approveQueued(id, { toEmail, subject, scheduledAt } = {}) {
  const d = await api("/api/outreach/queue/" + encodeURIComponent(id) + "/approve", { method: "POST", body: { toEmail, subject, scheduledAt } });
  return d.item;
}

// Send an approved email item right now (skip the wait).
export async function sendQueuedNow(id) {
  const d = await api("/api/outreach/queue/" + encodeURIComponent(id) + "/send-now", { method: "POST" });
  return d.item;
}

// Mark a LinkedIn item sent after the human one-click hand-off.
export async function markQueuedSent(id) {
  const d = await api("/api/outreach/queue/" + encodeURIComponent(id) + "/sent", { method: "POST" });
  return d.item;
}

export async function skipQueued(id) {
  await api("/api/outreach/queue/" + encodeURIComponent(id) + "/skip", { method: "POST" });
  return true;
}

// ── LinkedIn agent ──────────────────────────────────────────────────
// The agent itself is a local worker (agent/) driving a Chrome profile you signed into by hand.
// These two calls are just the app's view of it: what it's doing, and the kill switch.
// The lease/report endpoints it uses aren't here — only the worker calls those.

// { enabled, haltedAt, haltReason, lastSeenAt, lastSentAt, limits, counts:{day,hour}, ready, inflight }
export async function agentStatus() {
  return api("/api/outreach/agent/status");
}

// Turn the agent on or off. Turning it on also clears a previous halt.
export async function setAgentEnabled(enabled) {
  const d = await api("/api/outreach/agent/enable", { method: "POST", body: { enabled: !!enabled } });
  return d.status;
}

// Your own limits and hours ({ perDay, perHour, invitesPerDay, invitesPerWeek, minGapSec,
// maxGapSec, windowStart, windowEnd, weekdaysOnly, copiesPerDay, inboxEveryMin, acceptEveryMin })
// and/or dry run. The server keeps each inside its safe range. Resolves with the new status.
export async function saveAgentSettings({ settings, dryRun } = {}) {
  return api("/api/outreach/agent/settings", { method: "PUT", body: { settings, dryRun } });
}

// Ask the agent's PC to do something on its next check-in (about 15 seconds):
// "check_inbox", "check_accepts" or "linkedin_login". Resolves with the new status.
export async function agentCommand(command) {
  return api("/api/outreach/agent/command", { method: "POST", body: { command } });
}

// A one-time code for connecting a PC → { code, expiresAt }.
export async function agentPairCode() {
  return api("/api/outreach/agent/pair", { method: "POST" });
}

export async function revokeAgentDevice(id) {
  return api("/api/outreach/agent/devices/" + encodeURIComponent(id) + "/revoke", { method: "POST" });
}

// The activity log, newest first: [{ id, at, level, text }].
export async function agentEvents(limit = 150) {
  const d = await api("/api/outreach/agent/events?limit=" + limit);
  return d.events || [];
}

// Download the agent as a zip. The endpoint needs the Bearer token, so a plain <a download>
// can't fetch it — we pull the blob here and click a temporary link at it instead.
export async function downloadAgent() {
  const res = await fetch("/api/outreach/agent/download", {});
  if (!res.ok) {
    let msg = "Could not download the agent (" + res.status + ").";
    try { msg = (await res.json())?.error?.message || msg; } catch (e) {}
    throw new Error(msg);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = "karma-connect-agent.zip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Copy a profile with the agent ───────────────────────────────────
// Ask the LinkedIn agent (running on someone's computer) to open a profile and copy the page,
// then wait for it. onWait(seconds) is called while waiting. Resolves with the page text;
// rejects with the reason when the agent can't (not running, LinkedIn pushed back…).
export async function copyProfileWithAgent(url, prospectId, onWait = () => {}) {
  const { id } = await api("/api/outreach/agent/copy-request", { method: "POST", body: { url, prospectId } });
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const r = await api("/api/outreach/agent/copy-request/" + encodeURIComponent(id));
    if (r.status === "done") return r.text || "";
    if (r.status === "failed") throw new Error(r.error || "The agent couldn't copy that profile.");
    if (!r.agentOn) throw new Error("The LinkedIn agent is off. Press Start on the LinkedIn agent page, and make sure its PC is on.");
    onWait(Math.round((Date.now() - started) / 1000), r.status);
  }
}

// ── LinkedIn replies ────────────────────────────────────────────────
// Conversations the agent read from LinkedIn — only ones with people you reached out to.
export async function listInbox() {
  const d = await api("/api/outreach/inbox");
  return d.threads || [];
}

// Keep an AI draft with its thread. `forText` is the message it answers.
export async function saveThreadDraft(id, body, forText) {
  const d = await api("/api/outreach/inbox/" + encodeURIComponent(id) + "/draft", { method: "POST", body: { body, forText } });
  return d.thread;
}

// You approved the reply: the agent sends it into the LinkedIn thread.
export async function approveReply(id, body) {
  const d = await api("/api/outreach/inbox/" + encodeURIComponent(id) + "/reply", { method: "POST", body: { body } });
  return d.item;
}

// Done with a conversation without replying (handled=false brings it back).
export async function setThreadHandled(id, handled = true) {
  const d = await api("/api/outreach/inbox/" + encodeURIComponent(id) + "/handled", { method: "POST", body: { handled } });
  return d.thread;
}

// A message held until the invitation is accepted: send it without waiting.
export async function sendWithoutWaiting(id) {
  const d = await api("/api/outreach/queue/" + encodeURIComponent(id) + "/no-wait", { method: "POST" });
  return d.item;
}
