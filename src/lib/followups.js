// First message after someone accepts a connection request. The LinkedIn agent copies their
// whole profile page; here it goes through the same steps as a manual Deep LinkedIn paste:
//   1. parse the page into prospect fields          (lib/profile.js — the paste panel's parser)
//   2. build the intelligence profile                (pAnalysis, as "AI Analysis" does)
//   3. save both onto the lead, so Karma Connect has them like any analysed lead
//   4. draft one first message                       (pRelationship — "they just accepted")
// The draft lands in an editable box in the Send Queue; nothing is sent until a person approves.
import { anthropicMsg, CLAUDE_MODEL } from "./claude.js";
import { SYSTEM } from "./brand.js";
import { buildContext, pAnalysis, pRelationship } from "./prompts.js";
import { senderOffer, SENDERS } from "./senders.js";
import { safeJSON } from "./json.js";
import { cleanMessages } from "./text.js";
import { parseProfileText, mergeParsed } from "./profile.js";
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

// The same blank prospect the main screen starts from, so every field buildContext reads exists.
const EMPTY_PROSPECT = {
  firstName: "", lastName: "", company: "", title: "", industry: "Property Restoration", location: "",
  headline: "", about: "", experience: "", website: "", companyDesc: "", news: "", linkedinUrl: "",
  notes: "", mutual: "", research: "", pain: "", growth: "", staffing: "", ops: "",
  context: "",
};

export const listFollowups = () => api("/api/outreach/followups").then((d) => d.followups || []);
export const saveFollowupDraft = (id, body) => api("/api/outreach/followups/" + encodeURIComponent(id) + "/draft", { method: "POST", body: { body } });
export const approveFollowup = (id, body) => api("/api/outreach/followups/" + encodeURIComponent(id) + "/approve", { method: "POST", body: { body } }).then((d) => d.item);
export const skipFollowup = (id) => api("/api/outreach/followups/" + encodeURIComponent(id) + "/skip", { method: "POST" });

// Run the pipeline for one accepted person. `fallbackSender` is used when the saved lead has
// no sender of its own. `onStep` reports progress ("Reading their profile…"). Returns
// { message, analysis, prospect }.
export async function prepareFollowup(f, fallbackSender, onStep = () => {}) {
  const snap = f.p_data || {};
  const sender = SENDERS.find((s) => s.id === snap.sender) || fallbackSender || SENDERS[0];
  const offer = (snap.offer && String(snap.offer).trim()) || senderOffer(sender);

  onStep("Reading their profile…");
  const d = await parseProfileText(f.profile_text || "");
  let prospect = mergeParsed({ ...EMPTY_PROSPECT, ...(snap.prospect || {}) }, d);
  if (!prospect.linkedinUrl && f.linkedin_url) prospect = { ...prospect, linkedinUrl: f.linkedin_url };
  if (!prospect.firstName && !prospect.company) {
    const [first, ...rest] = String(f.lead_label || "").split(" ");
    prospect = { ...prospect, firstName: first || "", lastName: rest.join(" ") };
  }

  onStep("Analyzing them…");
  const anaTxt = await anthropicMsg(SYSTEM, pAnalysis(buildContext(prospect, offer, null, "")), { maxTokens: 2500 });
  let analysis = null;
  try { analysis = cleanMessages(safeJSON(anaTxt)); } catch (e) { analysis = null; } // the draft can still go ahead

  onStep("Drafting a first message…");
  let system = SYSTEM;
  try {
    const pb = (await getPlaybook()).relationship;
    if (pb && pb.trim()) system += "\n\nWHAT'S BEEN WORKING (learned from THIS account's own replies — favor these patterns, they have out-performed the alternatives here):\n" + pb.trim();
  } catch (e) { /* no playbook yet */ }
  const msgTxt = await anthropicMsg(system, pRelationship(buildContext(prospect, offer, analysis, ""), 1, []), { maxTokens: 900, model: CLAUDE_MODEL });
  let arr = safeJSON(msgTxt); if (!Array.isArray(arr)) arr = [arr];
  const first = cleanMessages(arr.filter((x) => x && x.message))[0];
  if (!first) throw new Error("No message came back. Try Redraft.");

  // Save the parsed profile, the analysis and the draft onto the lead, as a manual run would.
  if (f.p_label != null) {
    const results = { ...(snap.results || {}) };
    results.relationship = [first, ...((results.relationship || []).filter((x) => x && x.message !== first.message))].slice(0, 6);
    const entry = {
      id: f.prospect_id, label: f.p_label, sub: [prospect.title, prospect.company].filter(Boolean).join(" · ") || f.p_sub || "",
      status: f.p_status || "connected",
      snapshot: { ...snap, prospect, sender: snap.sender || sender.id, offer, analysis: analysis || snap.analysis || null, results },
    };
    await writeHistory((currentUser() || {}).email || "", [entry]).catch(() => {});
  }
  return { message: first.message, analysis, prospect };
}
