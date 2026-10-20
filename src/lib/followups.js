// First message after someone accepts a connection request. The LinkedIn agent copies their
// whole profile page; here it goes through the same steps as a manual Deep LinkedIn paste:
//   1. parse the page into prospect fields          (lib/profile.js — the paste panel's parser)
//   2. build the intelligence profile                (pAnalysis, as "AI Analysis" does)
//   3. save both onto the lead, so Karma Connect has them like any analysed lead
//   4. draft one first message                       (pRelationship — "they just accepted")
// The draft lands in an editable box in the Send Queue; nothing is sent until a person approves.
import { runFollowupPipeline } from "./prep.js";
import { writeHistory } from "./history.js";
import { getPlaybook } from "./coach.js";
import { currentUser } from "./auth.js";

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty */ }
  if (!res.ok) throw new Error(data?.error?.message || "Request failed (" + res.status + ").");
  return data;
}

export const listFollowups = () => api("/api/outreach/followups").then((d) => d.followups || []);
export const saveFollowupDraft = (id, body) => api("/api/outreach/followups/" + encodeURIComponent(id) + "/draft", { method: "POST", body: { body } });
export const approveFollowup = (id, body) => api("/api/outreach/followups/" + encodeURIComponent(id) + "/approve", { method: "POST", body: { body } }).then((d) => d.item);
export const skipFollowup = (id) => api("/api/outreach/followups/" + encodeURIComponent(id) + "/skip", { method: "POST" });

// Run the pipeline for one accepted person (lib/prep.js, the same steps the server runs by itself).
// `fallbackSender` is used when the saved lead has no sender of its own. `onStep` reports
// progress ("Reading their profile…"). Saves the analysed lead. Returns { message, analysis, prospect }.
export async function prepareFollowup(f, fallbackSender, onStep = () => {}) {
  let playbook = "";
  try { playbook = (await getPlaybook()).relationship || ""; } catch (e) { /* no playbook yet */ }
  const r = await runFollowupPipeline(f, { fallbackSender, playbook, onStep });
  if (r.entry) await writeHistory((currentUser() || {}).email || "", [r.entry]).catch(() => {});
  return { message: r.message, analysis: r.analysis, prospect: r.prospect };
}
