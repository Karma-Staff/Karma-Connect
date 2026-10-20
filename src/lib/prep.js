// The research for one accepted connection, written once and run in two places: the Send Queue
// in the browser (lib/followups.js) and the server, unattended (server/li-prep.cjs, which runs
// this file bundled as server/gen/prep.cjs), so a new connection is researched and drafted
// before anyone opens Karma Connect. The same steps as a manual Deep LinkedIn paste:
//   1. parse the copied profile page into prospect fields   (lib/profile.js)
//   2. build the intelligence profile                       (pAnalysis, as "AI Analysis" does)
//   3. draft one first message                              (pRelationship — "they just accepted")
// It reads and writes nothing itself; the caller saves the result. Nothing here sends anything.
import { anthropicMsg, CLAUDE_MODEL } from "./claude.js";
import { SYSTEM } from "./brand.js";
import { buildContext, pAnalysis, pRelationship } from "./prompts.js";
import { senderOffer, SENDERS } from "./senders.js";
import { safeJSON } from "./json.js";
import { cleanMessages } from "./text.js";
import { parseProfileText, mergeParsed } from "./profile.js";

// The same blank prospect the main screen starts from, so every field buildContext reads exists.
export const EMPTY_PROSPECT = {
  firstName: "", lastName: "", company: "", title: "", industry: "Property Restoration", location: "",
  headline: "", about: "", experience: "", website: "", companyDesc: "", news: "", linkedinUrl: "",
  notes: "", mutual: "", research: "", pain: "", growth: "", staffing: "", ops: "",
  context: "",
};

// the server reads the sender list from here (li-prospecting.cjs signs the invitation note)
export { SENDERS };

export const senderById = (id, fallback) => SENDERS.find((s) => s.id === id) || fallback || SENDERS[0];

/* f: { profile_text, linkedin_url, lead_label, prospect_id, p_label, p_sub, p_status, p_data }
   (a row of the Send Queue's followups list). playbook: what has been working for this account's
   first messages, or "". Returns { message, analysis, prospect, entry } — entry is the lead as it
   should now be saved (null when there's no saved lead to write back to). */
export async function runFollowupPipeline(f, { fallbackSender = null, playbook = "", onStep = () => {} } = {}) {
  const snap = f.p_data || {};
  const sender = senderById(snap.sender, fallbackSender);
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
  if (playbook && String(playbook).trim())
    system += "\n\nWHAT'S BEEN WORKING (learned from THIS account's own replies — favor these patterns, they have out-performed the alternatives here):\n" + String(playbook).trim();
  const msgTxt = await anthropicMsg(system, pRelationship(buildContext(prospect, offer, analysis, ""), 1, []), { maxTokens: 900, model: CLAUDE_MODEL });
  let arr = safeJSON(msgTxt); if (!Array.isArray(arr)) arr = [arr];
  const first = cleanMessages(arr.filter((x) => x && x.message))[0];
  if (!first) throw new Error("No message came back. Try Redraft.");

  // The lead as a manual run would leave it: the parsed profile, the analysis, the draft.
  let entry = null;
  if (f.p_label != null) {
    const results = { ...(snap.results || {}) };
    results.relationship = [first, ...((results.relationship || []).filter((x) => x && x.message !== first.message))].slice(0, 6);
    entry = {
      id: f.prospect_id, label: f.p_label, sub: [prospect.title, prospect.company].filter(Boolean).join(" · ") || f.p_sub || "",
      status: f.p_status || "connected",
      snapshot: { ...snap, prospect, sender: snap.sender || sender.id, offer, analysis: analysis || snap.analysis || null, results },
    };
  }
  return { message: first.message, analysis, prospect, entry };
}
