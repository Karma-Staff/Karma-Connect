import { useState, useEffect, Fragment } from "react";
import { SYSTEM } from "./lib/brand.js";
import { SENDERS, senderOffer } from "./lib/senders.js";
import { anthropicMsg, callClaude, CLAUDE_FAST_MODEL } from "./lib/claude.js";
import { safeJSON } from "./lib/json.js";
import { cleanMessages, stripLinkedInNoise } from "./lib/text.js";
import { flagUnsupported } from "./lib/verify.js";
import {
  COMPANY_SYSTEM, companyResearchPrompt, buildContext,
  pAnalysis, pConnection, pInmail, pRefine, pRelationship, pMeeting, pFollowup, pFollowupSequence,
  STAGES_ANALYZE, STAGES_GEN, FOLLOWUP_STAGES,
} from "./lib/prompts.js";
import { KarmaMark, Ic, CopyIc, StarIc } from "./components/icons.jsx";
import { Loader } from "./components/Loader.jsx";
import { MsgCard } from "./components/MsgCard.jsx";
import { RefineBox } from "./components/RefineBox.jsx";
import { Dropdown } from "./components/Dropdown.jsx";
import { HistoryView } from "./views/HistoryView.jsx";
import { ApprovalsView } from "./views/ApprovalsView.jsx";
import { SettingsView } from "./views/SettingsView.jsx";
import { UsageView } from "./views/UsageView.jsx";
import { AdminMembersView } from "./views/AdminMembersView.jsx";
import { TeamActivityView } from "./views/TeamActivityView.jsx";
import { DashboardView } from "./views/DashboardView.jsx";
import { BoardView } from "./views/BoardView.jsx";
import { RemindersView } from "./views/RemindersView.jsx";
import { listHistory, writeHistory, deleteHistory, setLeadStatus, HISTORY_PAGE_SIZE } from "./lib/history.js";
import { setReminder, listReminders } from "./lib/reminders.js";
import { getProspectBriefPdf } from "./lib/leads.js";
import { scoreFit } from "./lib/scoring.js";
import { currentUser } from "./lib/auth.js";
import { requestApproval, myApprovals, listApprovals, decideApproval, listAdmins } from "./lib/approvals.js";

// A prospect's identity signature, used to notice when the user has switched to a
// DIFFERENT person in the same form (without clicking "New Prospect"). Keyed on the
// person's name when present, else the company — so fixing a company on a named prospect
// doesn't look like a brand-new person. Empty string means "no identity yet".
function identityOf(p) {
  const name = [(p?.firstName || "").trim(), (p?.lastName || "").trim()].filter(Boolean).join(" ").toLowerCase();
  if (name) return "n:" + name;
  const co = (p?.company || "").trim().toLowerCase();
  return co ? "c:" + co : "";
}

// Per-account store of recently-researched companies, so repeat companies can be re-filled
// from history instead of re-running a web search each time.
const companyHistKey = (email) => "kc_company_hist_" + (email || "anon").toLowerCase();
// Stable key for a company: its URL host (or name), lower-cased and trimmed of scheme/slash.
const companyKey = (url, name) => String(url || name || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "").trim();

export default function KarmaConnectAI({ userEmail = "", onSignOut } = {}) {
  // Working draft is namespaced per account so different logins don't clobber each other.
  const STATE_KEY = "kc_state_v1_" + (userEmail || "anon").toLowerCase();

  // Restore saved work once (survives refresh, avoids re-billing). See save effect below.
  const [saved] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STATE_KEY) || "{}") || {}; } catch (e) { return {}; }
  });
  const EMPTY_PROSPECT = {
    firstName: "", lastName: "", company: "", title: "", industry: "Property Restoration", location: "",
    headline: "", about: "", experience: "", website: "", companyDesc: "", news: "",
    notes: "", mutual: "", research: "", pain: "", growth: "", staffing: "", ops: "",
    context: "",
  };
  // Full results shape — restored results are merged onto this so every key always exists
  // (older saved state from before a key was added won't crash on `.length`).
  const EMPTY_RESULTS = { connection: [], inmail: [], relationship: [], meeting_short: [], meeting_standard: [], meeting_executive: [], followup: [], followupSeq: [] };
  const [view, setView] = useState(saved.view || "hub");
  const [prospect, setProspect] = useState({ ...EMPTY_PROSPECT, ...(saved.prospect || {}) });
  const [sender, setSender] = useState(saved.sender || "nordon");
  const [offer, setOffer] = useState(saved.offer || senderOffer(SENDERS[0]));
  const [coUrl, setCoUrl] = useState(saved.coUrl || "");
  // Recently-researched companies (per account), newest first. Clicking one re-fills the
  // company fields without spending another web search — most prospects share a few firms.
  const [companyHistory, setCompanyHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(companyHistKey(userEmail)) || "[]") || []; } catch (e) { return []; }
  });
  const [enriching, setEnriching] = useState(false);
  const [enrichMsg, setEnrichMsg] = useState("");
  const [enrichErr, setEnrichErr] = useState("");
  const [rawPaste, setRawPaste] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseMsg, setParseMsg] = useState("");
  const [parseErr, setParseErr] = useState("");
  const [analysis, setAnalysis] = useState(saved.analysis || null);
  const [results, setResults] = useState({ ...EMPTY_RESULTS, ...(saved.results || {}) });
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [regen, setRegen] = useState({});
  const [favs, setFavs] = useState(saved.favs || {});
  const [meetLen, setMeetLen] = useState(saved.meetLen || "standard");
  const [connMode, setConnMode] = useState(saved.connMode || "note"); // "note" (invite note) | "inmail" (premium message to non-connections)
  const [prospectReply, setProspectReply] = useState(saved.prospectReply || "");
  const [fuMode, setFuMode] = useState(saved.fuMode || "sequence"); // "sequence" (LinkedIn 5-step) | "email" (after-meeting, admin-only)
  const [fuStage, setFuStage] = useState(saved.fuStage || "post_meeting"); // follow-up stage (email mode)
  const [transcript, setTranscript] = useState(saved.transcript || "");    // call/meeting transcript
  const [toast, setToast] = useState("");
  const [exportingBrief, setExportingBrief] = useState(false);
  const [confirmState, setConfirmState] = useState(null); // { title, message, confirmLabel, danger, onConfirm }
  const [history, setHistory] = useState([]);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyMore, setHistoryMore] = useState(false);
  const [histQuery, setHistQuery] = useState("");   // History search box
  const [histStatus, setHistStatus] = useState(""); // History pipeline-status filter ("" = all)
  const [remindersDue, setRemindersDue] = useState(0); // count of overdue/due-today follow-ups (nav badge)
  const [showRubric, setShowRubric] = useState(false);
  const [currentEntryId, setCurrentEntryId] = useState(saved.currentEntryId || null);
  // Identity of the prospect currently being worked (the "anchor"). When the live form's
  // identity drifts away from this, the user has started a new person — see the auto-fork
  // effect below. Restored from saved work so a refresh keeps the anchor aligned.
  const [anchorIdentity, setAnchorIdentity] = useState(() => (saved.analysis ? identityOf(saved.prospect || {}) : ""));

  // ---- Admin approval gate ----
  // Members work a lead through connection freely; Relationship / Meeting / Follow-up stay
  // locked per lead until an admin approves it. Admins bypass the lock.
  const me = currentUser();
  const isAdmin = !!(me && me.isAdmin);
  const APPROVAL_ENGINES = ["relationship", "meeting", "followup"];
  const [approvals, setApprovals] = useState({});   // { prospectId: 'pending'|'approved'|'denied' }
  const [apprBusy, setApprBusy] = useState(false);
  const [adminList, setAdminList] = useState([]);    // admin view: all requests
  const [adminOptions, setAdminOptions] = useState([]); // member view: admins to choose from
  const [chosenAdmin, setChosenAdmin] = useState("");   // selected admin id for the request
  const leadStatus = currentEntryId ? approvals[currentEntryId] : undefined;
  // Approval gate DISABLED: Relationship / Meeting / Follow-up are unlocked for everyone, no admin
  // approval needed. To re-enable, restore: isAdmin || leadStatus === "approved".
  const leadApproved = true;
  const engineLocked = (id) => APPROVAL_ENGINES.includes(id) && !leadApproved;
  // The after-meeting email mode is admin-only; members are always on the LinkedIn sequence.
  const fuModeEff = isAdmin ? fuMode : "sequence";

  // Load saved prospects (server when signed in, else localStorage). Async + paginated, and
  // re-fetches page 0 when the search box / status filter changes (debounced while typing).
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      listHistory(userEmail, 0, { q: histQuery, status: histStatus }).then((rows) => {
        if (!alive) return;
        setHistory(rows); setHistoryPage(0); setHistoryMore(rows.length >= HISTORY_PAGE_SIZE);
      });
    }, histQuery ? 250 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [userEmail, histQuery, histStatus]);

  // Load this member's lead-approval statuses (gates the locked engines). Admins also load
  // the full request list for the Approvals panel + badge. Also the follow-up due count.
  useEffect(() => {
    refreshApprovals();
    if (isAdmin) loadAdminList(); else loadAdminOptions();
    loadRemindersDue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userEmail]);
  // Re-check when opening a locked engine, so an admin's just-granted approval shows up.
  useEffect(() => {
    if (!isAdmin && APPROVAL_ENGINES.includes(view)) { refreshApprovals(); if (!adminOptions.length) loadAdminOptions(); }
    if (isAdmin && view === "approvals") loadAdminList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Persist work to localStorage so a refresh never loses (or re-bills) it.
  useEffect(() => {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({ view, prospect, sender, offer, coUrl, analysis, results, favs, meetLen, connMode, prospectReply, fuMode, fuStage, transcript, currentEntryId }));
    } catch (e) {}
  }, [view, prospect, sender, offer, coUrl, analysis, results, favs, meetLen, connMode, prospectReply, fuMode, fuStage, transcript, currentEntryId, STATE_KEY]);

  // Auto-save the current prospect to history once analysis has run, then keep it in sync
  // (debounced) as messages are generated/edited. No manual "Save" needed.
  useEffect(() => {
    if (!analysis) return;
    const t = setTimeout(() => autoSaveCurrent(), 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, results, favs, prospect, sender, offer, meetLen, prospectReply]);

  // Auto-fork on a new person: if the live form's identity drifts away from the prospect
  // being worked (the anchor), the user has started a DIFFERENT person without clicking
  // "New Prospect". The previous one is already saved in History, so we simply detach from
  // it (clear the entry id) and drop the stale analysis — that both stops the old entry from
  // being overwritten AND makes the new person save as its own separate entry once analysed.
  useEffect(() => {
    if (!analysis) return;                        // only matters once a prospect is analysed/loaded
    const sig = identityOf(prospect);
    if (!anchorIdentity) { setAnchorIdentity(sig); return; }   // first analysis — set the anchor
    if (sig && sig !== anchorIdentity) {
      setCurrentEntryId(null);                    // detach — next analysis saves as a NEW prospect
      setAnalysis(null);                          // stop auto-save from overwriting the previous one
      setResults({ ...EMPTY_RESULTS });
      setFavs({});
      setAnchorIdentity("");                      // re-anchors when the new prospect is analysed
      showToast("New prospect started — previous one is saved in History");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prospect.firstName, prospect.lastName, prospect.company, analysis, anchorIdentity]);

  // Close the confirm modal on Escape.
  useEffect(() => {
    if (!confirmState) return;
    const onKey = (e) => { if (e.key === "Escape") setConfirmState(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmState]);

  function pickSender(id) { const s = SENDERS.find((x) => x.id === id) || SENDERS[0]; setSender(id); setOffer(senderOffer(s)); }
  const set = (k, v) => setProspect((p) => ({ ...p, [k]: v }));
  const ready = prospect.firstName.trim() && (prospect.company.trim() || prospect.title.trim());
  const name = prospect.firstName || "this prospect";
  const initials = ((prospect.firstName[0] || "") + (prospect.lastName[0] || prospect.company[0] || "")).toUpperCase() || "·";
  function showToast(t) { setToast(t); setTimeout(() => setToast(""), 1600); }
  function copy(text) { navigator.clipboard && navigator.clipboard.writeText(text); showToast("Copied to clipboard"); }
  function handleTranscriptFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setTranscript(String(reader.result || "").slice(0, 20000));
    reader.onerror = () => showToast("Could not read that file.");
    reader.readAsText(file);
    e.target.value = "";
  }
  function askConfirm(opts) { setConfirmState(opts); }
  function doReset() {
    setProspect({ ...EMPTY_PROSPECT });
    setAnalysis(null);
    setResults({ ...EMPTY_RESULTS });
    setFavs({}); setCoUrl(""); setRawPaste(""); setProspectReply(""); setTranscript(""); setFuMode("sequence"); setFuStage("post_meeting"); setView("hub");
    setEnrichMsg(""); setEnrichErr(""); setParseMsg(""); setParseErr("");
    setCurrentEntryId(null);
    setAnchorIdentity("");
    showToast("Cleared. Ready for a new prospect.");
  }
  function resetAll() {
    askConfirm({ title: "Start a new prospect?", message: "This clears the current prospect and everything generated for them. It can't be undone.", confirmLabel: "Clear & start new", danger: true, onConfirm: doReset });
  }

  // ---- Per-account prospect history (auto-saved after analysis) ----
  // pros/ana default to the live state, but can be passed explicitly so a freshly-completed
  // analysis can be persisted immediately (before the debounce and before React re-renders).
  function autoSaveCurrent(pros = prospect, ana = analysis) {
    if (!ana) return;
    if (!pros.firstName.trim() && !pros.company.trim()) return;
    let id = currentEntryId;
    // Backstop: never overwrite a loaded entry that belongs to a different person — fork instead.
    const prior = id ? history.find((h) => h.id === id) : null;
    const priorSig = prior ? identityOf(prior.snapshot?.prospect || {}) : "";
    if (priorSig && priorSig !== identityOf(pros)) id = null;
    if (!id) { id = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : "h" + Date.now(); setCurrentEntryId(id); }
    const label = [pros.firstName, pros.lastName].filter(Boolean).join(" ") || pros.company || "Untitled";
    const sub = [pros.title, pros.company].filter(Boolean).join(" · ");
    const status = (history.find((h) => h.id === id) || {}).status || "new"; // keep the lead's stage
    const entry = { id, label, sub, status, savedAt: new Date().toISOString(), snapshot: { prospect: pros, sender, offer, coUrl, analysis: ana, results, favs, meetLen, prospectReply, fuMode, fuStage, transcript } };
    setHistory((cur) => [entry, ...cur.filter((h) => h.id !== id)]);
    writeHistory(userEmail, [entry]);
  }
  function loadMoreHistory() {
    const next = historyPage + 1;
    listHistory(userEmail, next, { q: histQuery, status: histStatus }).then((rows) => {
      if (rows.length) { setHistory((cur) => [...cur, ...rows]); setHistoryPage(next); }
      setHistoryMore(rows.length >= HISTORY_PAGE_SIZE);
    });
  }
  function setHistoryStatus(id, status) {
    setHistory((cur) => cur.map((h) => (h.id === id ? { ...h, status } : h)));
    setLeadStatus(userEmail, id, status);
  }
  function setHistoryReminder(id, date, note) {
    const iso = date ? new Date(date).toISOString() : null;
    setHistory((cur) => cur.map((h) => (h.id === id ? { ...h, nextActionAt: iso, nextActionNote: date ? note : "" } : h)));
    setReminder(id, date || null, note || "").then(loadRemindersDue).catch(() => {});
  }
  function loadRemindersDue() {
    if (!userEmail) return;
    listReminders().then((rs) => {
      const now = new Date();
      const endToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      setRemindersDue(rs.filter((r) => new Date(r.next_action_at) < endToday).length);
    }).catch(() => {});
  }
  function loadFromHistory(entry) {
    const s = entry.snapshot || {};
    setProspect({ ...EMPTY_PROSPECT, ...(s.prospect || {}) });
    setSender(s.sender || "nordon");
    setOffer(s.offer || senderOffer(SENDERS[0]));
    setCoUrl(s.coUrl || "");
    setAnalysis(s.analysis || null);
    setResults({ ...EMPTY_RESULTS, ...(s.results || {}) });
    setFavs(s.favs || {});
    setMeetLen(s.meetLen || "standard");
    setProspectReply(s.prospectReply || "");
    setFuMode(s.fuMode || "sequence");
    setFuStage(s.fuStage || "post_meeting");
    setTranscript(s.transcript || "");
    setCurrentEntryId(entry.id);
    setAnchorIdentity(identityOf(s.prospect || {}));   // anchor to the loaded person, so editing it isn't seen as a switch
    setView(s.analysis ? "intel" : "hub");
    showToast("Loaded " + (entry.label || "prospect"));
  }
  function deleteFromHistory(id) {
    setHistory(history.filter((h) => h.id !== id));
    deleteHistory(userEmail, id);
  }

  // ---- Approval gate actions ----
  async function refreshApprovals() {
    if (!userEmail) return;
    try { setApprovals(await myApprovals()); } catch (e) { /* keep prior */ }
  }
  async function doRequestApproval() {
    if (!currentEntryId) { showToast("Run AI Analysis first so the lead is saved."); return; }
    setApprBusy(true);
    try {
      const label = [prospect.firstName, prospect.lastName].filter(Boolean).join(" ") || prospect.company || "Untitled";
      const sub = [prospect.title, prospect.company].filter(Boolean).join(" · ");
      const a = await requestApproval(currentEntryId, label, sub, chosenAdmin || null);
      setApprovals((m) => ({ ...m, [currentEntryId]: (a && a.status) || "pending" }));
      const who = adminOptions.find((x) => x.id === chosenAdmin);
      showToast(who ? "Request sent to " + ([who.first_name, who.last_name].filter(Boolean).join(" ") || who.email) + "." : "Approval requested.");
    } catch (e) { showToast("Could not request approval. Try again."); }
    setApprBusy(false);
  }
  // Members: load the list of admins to choose who should review the request.
  async function loadAdminOptions() {
    try {
      const list = await listAdmins();
      setAdminOptions(list);
      setChosenAdmin((cur) => cur || (list[0] ? list[0].id : ""));
    } catch (e) { /* network / none */ }
  }
  async function loadAdminList() {
    try { setAdminList(await listApprovals()); } catch (e) { /* not admin / network */ }
  }
  async function doDecide(id, decision) {
    try {
      await decideApproval(id, decision);
      setAdminList((list) => list.map((a) => (a.id === id ? { ...a, status: decision, decided_by: userEmail } : a)));
      showToast(decision === "approved" ? "Lead approved." : "Lead denied.");
    } catch (e) { showToast("Could not save the decision."); }
  }
  const favKey = (kind, i, msg) => kind + ":" + i + ":" + (msg || "").slice(0, 24);
  function toggleFav(kind, i, msg) { const k = favKey(kind, i, msg); setFavs((f) => ({ ...f, [k]: !f[k] })); }

  // Lightweight COMPANY research — one web-search call. Fills empty company-side fields only.
  // (The person's profile comes from the Deep LinkedIn paste panel below.)
  // ---- Recent-company history (per account) ----
  // Save a researched company (its resolved fields) so it can be re-applied later for free.
  function rememberCompany(data) {
    const key = companyKey(data.url, data.name);
    if (!key) return;
    setCompanyHistory((cur) => {
      const next = [{ ...data, key, at: new Date().toISOString() }, ...cur.filter((c) => c.key !== key)].slice(0, 12);
      try { localStorage.setItem(companyHistKey(userEmail), JSON.stringify(next)); } catch (e) {}
      return next;
    });
  }
  // Re-fill the company fields from a saved company (no web search). Leaves the person's
  // profile fields untouched; sets the URL box so a fresh research is one click away if wanted.
  function applyCompany(c) {
    setProspect((prev) => {
      const next = { ...prev };
      const put = (k, v) => { if (v) next[k] = v; };
      put("company", c.name); put("industry", c.industry); put("location", c.location);
      put("companyDesc", c.companyDesc); put("news", c.news); put("website", c.website || c.url);
      if (c.research && !String(next.research || "").includes(c.research)) next.research = (next.research ? next.research + "\n\n" : "") + c.research;
      return next;
    });
    if (c.url) setCoUrl(c.url);
    showToast("Loaded " + (c.name || "company") + " from history");
  }
  function forgetCompany(key) {
    setCompanyHistory((cur) => {
      const next = cur.filter((c) => c.key !== key);
      try { localStorage.setItem(companyHistKey(userEmail), JSON.stringify(next)); } catch (e) {}
      return next;
    });
  }

  async function enrich() {
    if (!coUrl.trim() && !prospect.company.trim()) {
      setEnrichErr("Add the company website URL or the company name first.");
      return;
    }
    setEnriching(true); setEnrichMsg(""); setEnrichErr("");
    try {
      const txt = await anthropicMsg(COMPANY_SYSTEM, companyResearchPrompt(prospect, coUrl), { maxTokens: 900, useSearch: "light", model: CLAUDE_FAST_MODEL });
      const parsed = safeJSON(txt);
      const d = Array.isArray(parsed) ? (parsed[0] || {}) : parsed;
      const nv = (v) => (v == null || v === "NOT VERIFIED" ? "" : String(v).trim());
      const joinArr = (a, sep = ", ") => (Array.isArray(a) ? a.map(nv).filter(Boolean).join(sep) : "");
      // Resolve the company fields once, so we can both fill the form and remember them.
      const co = {
        name: nv(d.company) || prospect.company.trim(),
        industry: nv(d.industry),
        location: nv(d.location),
        website: nv(d.website) || coUrl.trim(),
        companyDesc: [nv(d.companyDesc), joinArr(d.services)].filter(Boolean).join(" | "),
        news: joinArr((d.recentNews || []).slice(0, 3), " | "),
      };
      const note = [nv(d.summary), nv(d.employeeCount) ? "Employees: " + nv(d.employeeCount) : ""].filter(Boolean).join(" ");
      co.research = note ? "Company research: " + note : "";
      setProspect((prev) => {
        const next = { ...prev };
        const fill = (k, val) => { if (val && !String(next[k] || "").trim()) next[k] = val; };
        fill("company", co.name); fill("industry", co.industry); fill("website", co.website);
        fill("location", co.location); fill("companyDesc", co.companyDesc); fill("news", co.news);
        if (co.research) next.research = (next.research ? next.research + "\n\n" : "") + co.research;
        return next;
      });
      rememberCompany({ url: coUrl.trim() || co.website, ...co });
      setEnrichMsg("Company research done. Filled the empty company fields I could verify. For the person's profile, use the Deep LinkedIn paste below.");
    } catch (e) {
      setEnrichErr((e && e.message) || "Couldn't research the company. You can still fill the fields manually.");
    }
    setEnriching(false);
  }

  async function parsePaste() {
    if (!rawPaste.trim()) return;
    setParsing(true); setParseMsg(""); setParseErr("");

    const systemPrompt = `You are an expert LinkedIn profile parser. You receive raw copy-pasted LinkedIn page text (Ctrl+A, Ctrl+C from a browser). The text contains the real profile mixed with LinkedIn UI noise: nav menus, ads, sidebars, "People also viewed", suggested connections, footer links, button labels, notification counts. Extract ONLY the actual profile data for the main person the page is about.

CRITICAL RULES:
- Return ONLY a single valid JSON object. No markdown. No code fences. No preamble. No commentary. Start your response with { and end with }.
- Every string value must be properly JSON-escaped. Escape all double quotes inside values as \\". Escape all newlines as \\n. Never use unescaped control characters inside string values.
- If a field has no data, use an empty string "". Never omit a field.
- For long fields like "about" and "experience": include ALL content, do not truncate. Use \\n to separate paragraphs and entries.
- "experience" should list every role as: TITLE at COMPANY (DATE_RANGE)\\nDescription if any. One entry per line.`;

    const userPrompt = `Extract every profile field from this raw LinkedIn page paste. Return a single JSON object with exactly these keys:
firstName, lastName, title, company, industry, location, headline, about, experience, education, skills, certifications, recommendations, recentPosts, mutualConnections, companyDesc, news, website, volunteering, languages, extraNotes, fieldsFound (array of field names you found data for), quality (high/medium/low string), qualityNote (one sentence string).

RAW PASTE:
${stripLinkedInNoise(rawPaste).slice(0, 24000)}`;

    try {
      const txt = await anthropicMsg(systemPrompt, userPrompt, { maxTokens: 6000, model: CLAUDE_FAST_MODEL });

      let d;
      try {
        d = safeJSON(txt);
      } catch (parseErr) {
        const grab = (key) => { const m = txt.match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"')); return m ? m[1].replace(/\\n/g, "\n") : ""; };
        d = {
          firstName: grab("firstName"), lastName: grab("lastName"), title: grab("title"),
          company: grab("company"), industry: grab("industry"), location: grab("location"),
          headline: grab("headline"), about: grab("about"), experience: grab("experience"),
          education: grab("education"), skills: grab("skills"), certifications: grab("certifications"),
          recommendations: grab("recommendations"), recentPosts: grab("recentPosts"),
          mutualConnections: grab("mutualConnections"), companyDesc: grab("companyDesc"),
          news: grab("news"), website: grab("website"), volunteering: grab("volunteering"),
          languages: grab("languages"), extraNotes: grab("extraNotes"),
          fieldsFound: [], quality: "low", qualityNote: "Partial extraction due to response format issue.",
        };
        const anyFound = Object.values(d).some((v) => typeof v === "string" && v.trim().length > 0);
        if (!anyFound) throw new Error("Could not extract any profile data. Make sure you selected all text on the LinkedIn page (Ctrl+A then Ctrl+C) and try again.");
      }

      if (!d || typeof d !== "object") throw new Error("Unexpected response format. Try again.");
      const safeStr = (v) => (typeof v === "string" ? v.replace(/\\n/g, "\n").trim() : "");

      setProspect((p) => {
        const next = { ...p };
        ["firstName","lastName","title","company","industry","location","headline","about","experience","website","companyDesc","news"]
          .forEach((k) => { if (safeStr(d[k])) next[k] = safeStr(d[k]); });
        const extras = [];
        if (safeStr(d.education)) extras.push("Education: " + safeStr(d.education));
        if (safeStr(d.skills)) extras.push("Skills: " + safeStr(d.skills));
        if (safeStr(d.certifications)) extras.push("Certifications: " + safeStr(d.certifications));
        if (safeStr(d.volunteering)) extras.push("Volunteering: " + safeStr(d.volunteering));
        if (safeStr(d.languages)) extras.push("Languages: " + safeStr(d.languages));
        if (safeStr(d.extraNotes)) extras.push("Other: " + safeStr(d.extraNotes));
        if (extras.length) next.research = (next.research ? next.research + "\n\n" : "") + "From LinkedIn paste:\n" + extras.join("\n");
        const noteBlocks = [];
        if (safeStr(d.recommendations)) noteBlocks.push("Recommendations:\n" + safeStr(d.recommendations));
        if (safeStr(d.recentPosts)) noteBlocks.push("Recent posts / activity:\n" + safeStr(d.recentPosts));
        if (noteBlocks.length) next.notes = (next.notes ? next.notes + "\n\n" : "") + noteBlocks.join("\n\n");
        if (safeStr(d.mutualConnections)) next.mutual = (next.mutual ? next.mutual + " | " : "") + safeStr(d.mutualConnections);
        return next;
      });

      const found = Array.isArray(d.fieldsFound) ? d.fieldsFound.length : Object.values(d).filter((v) => typeof v === "string" && v.trim()).length;
      setParseMsg(`Profile parsed (${d.quality || "medium"} quality). ${found} fields extracted. ${d.qualityNote || ""} Review the fields below and fill in anything the AI missed.`);
      setRawPaste("");
    } catch (e) {
      setParseErr((e && e.message) || "Parse failed. Try Ctrl+A on the LinkedIn profile page, Ctrl+C, then paste here again.");
    }
    setParsing(false);
  }

  // Zero-token duplicate guard: before spending AI credits, warn if this person is already saved.
  async function runAnalysis() {
    try {
      const nameLabel = [prospect.firstName, prospect.lastName].filter(Boolean).join(" ").trim();
      const qstr = prospect.company.trim() || nameLabel;
      if (qstr) {
        const matches = await listHistory(userEmail, 0, { q: qstr });
        const dup = matches.find((h) => h.id !== currentEntryId && nameLabel && (h.label || "").toLowerCase() === nameLabel.toLowerCase());
        if (dup) {
          askConfirm({
            title: "You already have this lead",
            message: "“" + dup.label + "” is already in your History" + (dup.sub ? " (" + dup.sub + ")" : "") + ". Analyzing again uses AI credits — open the saved one from History instead, or analyze again?",
            confirmLabel: "Analyze again",
            onConfirm: doRunAnalysis,
          });
          return;
        }
      }
    } catch (e) { /* dedup is best-effort — never block analysis */ }
    doRunAnalysis();
  }

  async function doRunAnalysis() {
    setLoading((l) => ({ ...l, analysis: true }));
    setErrors((e) => ({ ...e, analysis: null }));
    setView("intel");

    const systemPrompt = SYSTEM;
    const userPrompt = pAnalysis(buildContext(prospect, offer, null, ""));

    const attempt = async () => {
      const txt = await anthropicMsg(systemPrompt, userPrompt, { maxTokens: 2500 });
      if (!txt || !txt.trim()) throw new Error("Empty response from AI. Please try again.");
      return cleanMessages(safeJSON(txt));
    };

    try {
      // Try once; if parse fails, retry once automatically
      let result;
      try {
        result = await attempt();
      } catch (firstErr) {
        // One automatic retry before showing error
        result = await attempt();
      }
      setAnalysis(result);
      // Persist right away (not just via the debounce) so switching prospects quickly after
      // an analysis can never lose the one just completed.
      autoSaveCurrent(prospect, result);
    } catch (e) {
      setErrors((er) => ({ ...er, analysis: (e && e.message) || "Analysis failed. Try again." }));
    }
    setLoading((l) => ({ ...l, analysis: false }));
  }

  const TARGET = { connection: 3, inmail: 3, relationship: 3, meeting_short: 3, meeting_standard: 3, meeting_executive: 3 };
  function builderFor(kind, n, avoid) {
    const base = buildContext(prospect, offer, analysis, "");
    if (kind === "connection") return pConnection(base, n, avoid);
    if (kind === "inmail") return pInmail(base, n, avoid);
    if (kind === "relationship") return pRelationship(base, n, avoid);
    if (kind.indexOf("meeting_") === 0) return pMeeting(base, n, kind.split("_")[1], avoid, prospectReply);
    return "";
  }
  async function generate(kind) {
    // Approval gate: don't spend on locked engines until an admin approves this lead.
    const baseKind = kind.indexOf("meeting_") === 0 ? "meeting" : kind === "followupSeq" ? "followup" : kind;
    if (APPROVAL_ENGINES.includes(baseKind) && !leadApproved) { showToast("An admin must approve this lead first."); return; }
    if (kind === "followup" && !isAdmin) { showToast("The after-meeting email is for admins only."); return; }
    setLoading((l) => ({ ...l, [kind]: true })); setErrors((e) => ({ ...e, [kind]: null })); setResults((r) => ({ ...r, [kind]: [] }));
    try {
      if (kind === "followup") {
        const stage = FOLLOWUP_STAGES.find((s) => s.v === fuStage) || FOLLOWUP_STAGES[0];
        const txt = await callClaude(SYSTEM, pFollowup(buildContext(prospect, offer, analysis, ""), stage, transcript), false, 1600);
        let arr = safeJSON(txt); if (!Array.isArray(arr)) arr = [arr];
        arr = arr.filter((x) => x && x.message); arr = cleanMessages(arr);
        if (!arr.length) throw new Error("No email came back. Please try again.");
        setResults((r) => ({ ...r, followup: arr }));
      } else if (kind === "followupSeq") {
        const txt = await callClaude(SYSTEM, pFollowupSequence(buildContext(prospect, offer, analysis, "")), false, 2800);
        let arr = safeJSON(txt); if (!Array.isArray(arr)) arr = [arr]; arr = cleanMessages(arr);
        if (!arr.length) throw new Error("No sequence came back. Please try again.");
        setResults((r) => ({ ...r, followupSeq: arr }));
      } else {
        const target = TARGET[kind] || 3;
        const isMeeting = kind.indexOf("meeting_") === 0;
        // Right-sized output cap to fit all `target` items in ONE call (sized for 5, with margin
        // so JSON never truncates — a truncated parse would force a costly full retry).
        const cap = isMeeting || kind === "inmail" ? 2800 : kind === "relationship" ? 2200 : 1800;
        let acc = [], guard = 0;
        // Ask for ALL remaining items in a single call (collapses the old 2-4 call loop).
        // The loop only repeats if the model returned fewer than requested.
        while (acc.length < target && guard < 4) {
          guard++;
          const n = target - acc.length;
          const avoid = acc.map((x) => x.angle).filter(Boolean);
          const txt = await callClaude(SYSTEM, builderFor(kind, n, avoid), false, cap);
          let arr = safeJSON(txt); if (!Array.isArray(arr)) arr = [arr];
          arr = arr.filter((x) => x && x.message);
          arr = cleanMessages(arr);
          if (!arr.length) break;
          acc = acc.concat(arr); setResults((r) => ({ ...r, [kind]: [...acc] }));
        }
        if (!acc.length) throw new Error("No messages came back. Please try again.");
      }
    } catch (e) { setErrors((er) => ({ ...er, [kind]: e.message })); }
    setLoading((l) => ({ ...l, [kind]: false }));
  }
  async function regenerateOne(kind, i) {
    const rk = kind + i; setRegen((r) => ({ ...r, [rk]: true }));
    try {
      const avoid = results[kind].filter((_, k) => k !== i).map((x) => x.angle).filter(Boolean);
      const txt = await callClaude(SYSTEM, builderFor(kind, 1, avoid));
      let arr = safeJSON(txt); if (!Array.isArray(arr)) arr = [arr]; arr = cleanMessages(arr);
      const item = arr.find((x) => x && x.message);
      if (item) setResults((r) => { const c = [...r[kind]]; c[i] = item; return { ...r, [kind]: c }; });
      else showToast("Regenerate failed — try again");
    } catch (e) { showToast("Regenerate failed — try again"); }
    setRegen((r) => ({ ...r, [rk]: false }));
  }
  // Refine ONE message with a user instruction, keeping it aligned with the original.
  // Used by every section (RefineBox under each card). Returns a promise the box awaits.
  async function refineOne(kind, i, instruction) {
    if (!instruction || !instruction.trim()) return;
    const orig = (results[kind] || [])[i];
    if (!orig) return;
    const refineKind = kind.indexOf("meeting_") === 0 ? "meeting" : kind === "followupSeq" ? "followup" : kind;
    const cap = kind.indexOf("meeting_") === 0 || kind === "inmail" ? 1600 : 1100;
    try {
      const prompt = pRefine(buildContext(prospect, offer, analysis, ""), refineKind, orig.message, instruction, { subject: orig.subject });
      const txt = await callClaude(SYSTEM, prompt, false, cap);
      let arr = safeJSON(txt); if (!Array.isArray(arr)) arr = [arr]; arr = cleanMessages(arr);
      const item = arr.find((x) => x && x.message);
      if (item) { setResults((r) => { const c = [...r[kind]]; c[i] = { ...c[i], ...item }; return { ...r, [kind]: c }; }); showToast("Message refined"); }
      else showToast("Refine failed — try again");
    } catch (e) { showToast("Refine failed — try again"); }
  }

  const NAV = [
    { id: "dashboard", label: "Dashboard", ic: Ic.dash },
    { id: "hub", label: "Prospect Hub", ic: Ic.hub },
    { id: "intel", label: "Intelligence", ic: Ic.intel, gate: true },
    { id: "connection", label: "Connection Requests", ic: Ic.conn, gate: true, count: results.connection.length },
    { id: "relationship", label: "Relationship Builder", ic: Ic.rel, gate: true, count: results.relationship.length },
    { id: "meeting", label: "Meeting Requests", ic: Ic.meet, gate: true },
    { id: "followup", label: "Follow-up Engine", ic: Ic.fup, gate: true, count: results.followup.length + results.followupSeq.length },
    { id: "history", label: "History", ic: Ic.hist, count: history.length },
    { id: "board", label: "Board", ic: Ic.board },
    { id: "reminders", label: "Reminders", ic: Ic.fup, count: remindersDue },
    ...(isAdmin ? [
      { id: "approvals", label: "Approvals", ic: Ic.intel, admin: true, count: adminList.filter((a) => a.status === "pending").length },
      { id: "team", label: "Team activity", ic: Ic.team, admin: true },
      { id: "members", label: "Members", ic: <KarmaMark color="currentColor" w={20} />, admin: true },
    ] : []),
    { id: "usage", label: "Usage & cost", ic: Ic.usage },
    { id: "settings", label: "Settings", ic: Ic.cog },
  ];

  function GenSkeleton() {
    return (
      <div className="grid2">
        {[0, 1, 2, 3].map((i) => (
          <div className="skcard" key={i}>
            <div className="sk" style={{ height: 13, width: "38%" }} />
            <div className="sk" style={{ height: 52 }} />
            <div className="sk" style={{ height: 9, width: "72%" }} />
            <div className="sk" style={{ height: 9, width: "54%" }} />
          </div>
        ))}
      </div>
    );
  }
  function ProspectStrip() {
    return (
      <div className="pchip">
        <span className="av">{initials}</span>
        <span>
          <div className="pn">{[prospect.firstName, prospect.lastName].filter(Boolean).join(" ") || "Unnamed prospect"}</div>
          <div className="pr">{[prospect.title, prospect.company].filter(Boolean).join(" · ") || prospect.industry}</div>
        </span>
      </div>
    );
  }
  function Field({ k, label, ph, area, full }) {
    return (
      <div className={"f" + (full ? " full" : "")}>
        <label>{label}</label>
        {area ? <textarea value={prospect[k]} placeholder={ph} onChange={(e) => set(k, e.target.value)} />
              : <input value={prospect[k]} placeholder={ph} onChange={(e) => set(k, e.target.value)} />}
      </div>
    );
  }
  // Source text the hallucination guard checks generated messages against (same data the
  // prompts were built from). Cheap string build; recomputed each render is fine.
  const verifySource = buildContext(prospect, offer, analysis, "");
  function SectionGenerator({ kind, title, eyebrow, blurb, charLimit }) {
    const items = results[kind] || [], isLoad = loading[kind], err = errors[kind];
    return (
      <div>
        <div className="head"><div className="eyebrow">{eyebrow}</div><h2>{title}</h2><p>{blurb}</p></div>
        <ProspectStrip />
        <div className="toprow">
          <button className="btn primary" onClick={() => generate(kind)} disabled={isLoad}>{isLoad ? "Generating…" : items.length ? "Regenerate all" : `Generate ${TARGET[kind] || 5} variations`}</button>
          {items.length > 0 && !isLoad && <span style={{ color: "var(--muted)", fontSize: 13 }}>{items.length} crafted for {name}</span>}
        </div>
        {err && <div className="err" style={{ marginBottom: 16 }}>⚠ {err}</div>}
        {isLoad && items.length === 0 && <GenSkeleton />}
        {!isLoad && items.length === 0 && !err && (
          <div className="empty"><div className="eic">{Ic.conn}</div><h3>No messages yet</h3><p>{blurb}</p><button className="btn primary" onClick={() => generate(kind)}>Generate for {name}</button></div>
        )}
        {items.length > 0 && (
          <div className="grid2">
            {items.map((it, i) => (
              <MsgCard key={i} item={it} idx={i} kind={kind} charLimit={charLimit} source={verifySource}
                favOn={!!favs[favKey(kind, i, it.message)]} onCopy={copy} onFav={() => toggleFav(kind, i, it.message)}
                onRegen={() => regenerateOne(kind, i)} onRefine={(instr) => refineOne(kind, i, instr)} regening={!!regen[kind + i]} />
            ))}
            {isLoad && <div className="mcard" style={{ justifyContent: "center", alignItems: "center", minHeight: 120, color: "var(--muted)", fontSize: 13 }}>Crafting more…</div>}
          </div>
        )}
      </div>
    );
  }

  // Locked-engine panel shown to members until an admin approves the current lead.
  function ApprovalGate({ title }) {
    const st = leadStatus;
    const adminName = (a) => [a.first_name, a.last_name].filter(Boolean).join(" ") || a.email;
    const AdminPicker = () => (
      adminOptions.length > 0 ? (
        <div className="f" style={{ maxWidth: 340, margin: "0 auto 14px", textAlign: "left" }}>
          <label htmlFor="kc-approver">Send the request to</label>
          <Dropdown
            id="kc-approver"
            value={chosenAdmin}
            onChange={setChosenAdmin}
            placeholder="Choose an admin…"
            options={adminOptions.map((a) => ({ value: a.id, label: adminName(a), email: a.email }))}
            renderOption={(o) => (
              <span className="kcdd-admin">
                <span className="kcdd-av">{(o.label[0] || "?").toUpperCase()}</span>
                <span className="kcdd-name"><b>{o.label}</b><small>{o.email}</small></span>
              </span>
            )}
          />
          <span className="hint">They'll get an email and see it in Approvals.</span>
        </div>
      ) : null
    );
    return (
      <div>
        <div className="head"><div className="eyebrow">Locked · needs admin approval</div><h2>{title}</h2><p>This is an advanced outreach stage. An admin approves each lead before it can move past connection requests.</p></div>
        <ProspectStrip />
        <div className="empty">
          <div className="eic" style={{ fontSize: 30 }}>🔒</div>
          {st === "pending" ? (
            <>
              <h3>Approval requested</h3>
              <p>Waiting for an admin to approve <b>{prospect.firstName || "this lead"}</b>. Once approved, Relationship, Meeting and Follow-up unlock for them.</p>
              <button className="btn ghost" onClick={refreshApprovals}>Check again</button>
            </>
          ) : st === "denied" ? (
            <>
              <h3>Not approved</h3>
              <p>An admin did not approve this lead for the advanced engines. You can request again if something has changed.</p>
              <AdminPicker />
              <button className="btn primary" onClick={doRequestApproval} disabled={apprBusy}>{apprBusy ? "Requesting…" : "Request again"}</button>
            </>
          ) : (
            <>
              <h3>Approval required</h3>
              <p>Ask an admin to approve <b>{prospect.firstName || "this lead"}</b> to unlock the Relationship, Meeting and Follow-up engines.</p>
              <AdminPicker />
              <button className="btn primary" onClick={doRequestApproval} disabled={apprBusy || !currentEntryId}>{apprBusy ? "Requesting…" : "Request approval"}</button>
              {!currentEntryId && <p className="hint">Run AI Analysis first so the lead is saved.</p>}
            </>
          )}
        </div>
      </div>
    );
  }

  // Deterministic, explainable fit — computed in code from the prospect's own data (lib/scoring.js).
  // Same prospect always yields the same number, and every score carries a factor breakdown you can
  // show a client. Independent of the AI's qualitative read.
  const fit = scoreFit(prospect);
  const fitRows = [["ICP Fit", fit.icp], ["Qualification", fit.qualification], ["Buying readiness", fit.readiness]];

  // Export this prospect's brief (details + fit + AI analysis) as a PDF. Zero tokens.
  async function exportBrief() {
    if (!analysis) { showToast("Run AI Analysis first."); return; }
    setExportingBrief(true);
    try {
      const blob = await getProspectBriefPdf({ prospect, analysis, fit });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const nm = [prospect.firstName, prospect.lastName].filter(Boolean).join("-").toLowerCase() || "prospect";
      a.href = url; a.download = "karma-connect-" + nm + "-brief.pdf";
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch (e) { showToast("Could not export the PDF."); }
    setExportingBrief(false);
  }

  // Prospect completion + research coverage + opportunity fit (derived from current data).
  const COMPLETION_FIELDS = ["firstName", "lastName", "title", "company", "industry", "location", "headline", "about", "experience", "website", "companyDesc", "news"];
  const completion = Math.round((100 * COMPLETION_FIELDS.filter((k) => String(prospect[k] || "").trim()).length) / COMPLETION_FIELDS.length);
  const coverage = [
    ["LinkedIn", !!(prospect.about || prospect.experience || prospect.headline)],
    ["Website", !!String(prospect.website || "").trim()],
    ["Company", !!String(prospect.companyDesc || prospect.company || "").trim()],
    ["News", !!String(prospect.news || "").trim()],
    ["Role", !!(String(prospect.title || "").trim() && String(prospect.firstName || "").trim())],
  ];
  const aiConfidence = fit.overall;
  const insights = analysis ? [...(analysis.hooks || []), ...(analysis.trends || [])].filter(Boolean).slice(0, 6) : [];

  return (
    <div className="kc">
      <a href="#kc-main" className="skip-link">Skip to main content</a>
      <div className="app">
        <aside className="side">
          <div className="brand">
            <span className="mark"><KarmaMark color="#fff" w={30} /></span>
            <div><h1>Karma <b>Connect</b></h1><span>AI Prospecting</span></div>
          </div>
          <nav aria-label="Primary">
          <div className="navlbl">Workspace</div>
          {NAV.map((n) => {
            // analysisLock blocks the click (can't use engines before analysis).
            const analysisLock = n.gate && !analysis && !loading.analysis;
            // approvalLock shows a 🔒 on the locked engines but stays clickable, so the member
            // can open the view and request approval. Admins never see the approval lock.
            const approvalLock = APPROVAL_ENGINES.includes(n.id) && !leadApproved && analysis;
            const locked = analysisLock;
            const showLock = analysisLock || approvalLock;
            return (
              <Fragment key={n.id}>
                {n.id === "connection" && <div className="navlbl" style={{ marginTop: 4 }}>Outreach</div>}
                {n.id === "history" && <div className="navlbl" style={{ marginTop: 4 }}>Library</div>}
                {n.id === "approvals" && <div className="navlbl" style={{ marginTop: 4 }}>Admin</div>}
                {n.id === "usage" && <div className="navlbl" style={{ marginTop: 4 }}>Account</div>}
                <button className={"nav" + (view === n.id ? " on" : "") + (locked ? " lock" : "")} onClick={() => { if (!locked) setView(n.id); }}
                  aria-current={view === n.id ? "page" : undefined}
                  aria-disabled={locked || undefined}
                  title={locked ? "Run AI analysis first to unlock this" : undefined}>
                  {n.ic}{n.label}
                  {n.count > 0 && <span className="ct" aria-label={n.count + " items"}>{n.count}</span>}
                  {showLock && <span className="ct" style={{ color: "var(--faint)" }} aria-label="locked">🔒</span>}
                </button>
              </Fragment>
            );
          })}
          </nav>
          <div className="sidefoot">
            <div><span className="dot" />{analysis ? "Profile active" : "Awaiting analysis"}</div>
            <div style={{ marginTop: 6, opacity: .85 }}>Sending as <b style={{ color: "var(--ice)" }}>{(SENDERS.find((s) => s.id === sender) || SENDERS[0]).name}</b></div>
            {userEmail && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 34, height: 34, flex: "0 0 34px", borderRadius: "50%", background: "var(--grad)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Lora',serif", fontWeight: 800, fontSize: 15, color: "#fff", boxShadow: "inset 0 1px 0 rgba(255,255,255,.3), 0 4px 12px -6px rgba(0,0,0,.6)" }}>
                  {(userEmail[0] || "?").toUpperCase()}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12, color: "var(--ice)", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={userEmail}>{userEmail}</div>
                  {onSignOut && <button onClick={onSignOut} style={{ background: "none", border: "none", color: "var(--faint)", cursor: "pointer", fontSize: 11, fontWeight: 600, padding: 0, marginTop: 1 }}>Sign out</button>}
                </div>
              </div>
            )}
          </div>
        </aside>

        <main className="main" id="kc-main" tabIndex={-1}>
          <div className="kctoast-live" role="status" aria-live="polite">{toast && <div className="kctoast">{toast}</div>}</div>
          {confirmState && (
            <div className="modal-ov" onClick={() => setConfirmState(null)}>
              <div className="modal" role="dialog" aria-modal="true" aria-labelledby="kc-modal-title" onClick={(e) => e.stopPropagation()}>
                <h3 id="kc-modal-title">
                  {confirmState.danger && <span className="mi" style={{ background: "rgba(226,74,74,.16)", color: "#ff9a9a", border: "1px solid rgba(226,74,74,.3)" }} aria-hidden="true">!</span>}
                  {confirmState.title}
                </h3>
                <p>{confirmState.message}</p>
                <div className="mrow">
                  <button className="btn ghost sm" onClick={() => setConfirmState(null)}>Cancel</button>
                  <button className={"btn sm " + (confirmState.danger ? "danger" : "primary")} autoFocus onClick={() => { const fn = confirmState.onConfirm; setConfirmState(null); if (fn) fn(); }}>{confirmState.confirmLabel || "Confirm"}</button>
                </div>
              </div>
            </div>
          )}

          <div key={view} className="viewfade">
          {view === "hub" && (
            <div>
              <div className="hero">
                <div style={{ position: "relative", zIndex: 1, minWidth: 0 }}>
                  <div className="eyebrow">Prospect Intelligence Hub</div>
                  <h1>Tell AI about your prospect</h1>
                  <p>Paste a LinkedIn profile, a company website, or both. Karma Connect builds a complete prospect profile and generates personalized outreach. Your work saves automatically.</p>
                  <div className="actions">
                    <button className="btn ai sm" onClick={runAnalysis} disabled={!ready || loading.analysis}>{loading.analysis ? "Analyzing…" : "Run AI Analysis →"}</button>
                    <button className="btn ghost sm" onClick={resetAll}>New prospect</button>
                  </div>
                </div>
                <div className="heroglow">
                  <div className="ring1" /><div className="ring2" /><div className="orb" />
                  <span className="pdot" style={{ top: 2, left: "46%" }} />
                  <span className="pdot" style={{ bottom: 6, right: 12, background: "var(--amber)", boxShadow: "0 0 10px var(--amber)" }} />
                  <span className="pdot" style={{ top: "52%", left: -2 }} />
                  <span className="pdot" style={{ top: 18, right: 0 }} />
                  <span className="pdot" style={{ bottom: 22, left: 8, background: "var(--amber)", boxShadow: "0 0 9px var(--amber)" }} />
                </div>
              </div>

              <div className="scorestrip">
                <div className="scorecard">
                  <div className="progring" style={{ "--p": completion, "--c": "var(--amber)" }}><span>{completion}%</span></div>
                  <div><div className="scl">Prospect completion</div><div className="scv">{completion >= 80 ? "Ready to generate" : completion >= 40 ? "Getting there" : "Add more detail"}</div></div>
                </div>
                <div className="scorecard">
                  <div className="progring" style={{ "--p": aiConfidence || 0, "--c": "var(--ai)" }}><span>{aiConfidence}%</span></div>
                  <div><div className="scl">Opportunity fit</div><div className="scv">{aiConfidence >= 65 ? "Strong fit" : aiConfidence >= 40 ? "Moderate fit" : "Add more data"}</div></div>
                </div>
                <div className="scorecard">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="scl" style={{ marginBottom: 9 }}>Research coverage</div>
                    <div className="cov">{coverage.map(([l, on], i) => <span key={i} className={"covchip" + (on ? " on" : "")}><span className="cdot" />{l}</span>)}</div>
                  </div>
                </div>
              </div>

              <div className="fa">
                <div className="panel step" style={{ borderColor: "var(--border2)" }}>
                  <div className="stepbadge"><span className="sn">1</span><span><span className="stt">Company Intelligence</span><span className="stsub">Auto-fill from the website</span></span></div>
                  <div className="fgrid">
                    <div className="f"><label>Company website URL</label><input value={coUrl} placeholder="https://company.com" onChange={(e) => setCoUrl(e.target.value)} /></div>
                  </div>
                  {companyHistory.length > 0 && (
                    <div className="cohist">
                      <span className="cohist-l">Recent</span>
                      {companyHistory.map((c) => (
                        <button key={c.key} type="button" className="chip cochip" title={"Load " + (c.name || c.url) + " from history"} onClick={() => applyCompany(c)}>
                          {c.name || c.url}
                          <span className="cochip-x" role="button" tabIndex={-1} aria-label="Remove from history" onClick={(e) => { e.stopPropagation(); forgetCompany(c.key); }}>×</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="toprow" style={{ marginTop: 14 }}>
                    <button className="btn primary" onClick={enrich} disabled={enriching || (!coUrl && !prospect.company.trim())}>{enriching ? "Researching…" : "Research company & fill ↓"}</button>
                    <span style={{ color: "var(--muted)", fontSize: 12.5 }}>One quick web-search pass on the company. Fills empty company fields only, never overwrites what you typed.</span>
                  </div>
                  {enriching && <div className="panel" style={{ marginTop: 14 }}><Loader stages={["Reading the company site…", "Searching the web…", "Extracting company facts…"]} /></div>}
                  {enrichMsg && <div className="reason" style={{ marginTop: 12 }}><b>Done</b> · {enrichMsg}</div>}
                  {enrichErr && <div className="err" style={{ marginTop: 12 }}>⚠ {enrichErr}</div>}
                  <div className="hint" style={{ marginTop: 10 }}>⚠ For the person's profile (name, title, about, experience), use the Deep LinkedIn paste panel below, that's the most complete and lowest-cost way to import a profile.</div>
                </div>

                <div className="panel step" style={{ borderColor: "rgba(255,207,0,.22)", background: "rgba(255,207,0,.03)" }}>
                  <div className="stepbadge"><span className="sn">2</span><span><span className="stt">LinkedIn Intelligence</span><span className="stsub">The most complete way to import a profile</span></span></div>
                  <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 14, lineHeight: 1.65 }}>
                    Open the LinkedIn profile in your browser while logged in. Press <b style={{ color: "var(--text)" }}>Ctrl+A</b> (select all) then <b style={{ color: "var(--text)" }}>Ctrl+C</b> (copy). Paste everything below. The AI will extract every field including full About, all Experience entries, Education, Skills, Certifications, recent posts, recommendations, and mutual connections.
                  </div>
                  <div className="f full" style={{ marginBottom: 14 }}>
                    <label>Raw LinkedIn page paste — Ctrl+A on the profile page, Ctrl+C, paste here</label>
                    <textarea
                      value={rawPaste}
                      onChange={(e) => setRawPaste(e.target.value)}
                      placeholder={"Paste the full LinkedIn page text here...\n\nTip: on the profile page press Ctrl+A to select everything, then Ctrl+C to copy, then click here and Ctrl+V. It will look messy — that is fine, the AI knows how to parse it."}
                      style={{ minHeight: 140, fontFamily: "monospace", fontSize: 12, lineHeight: 1.5 }}
                    />
                  </div>
                  {rawPaste.trim().length > 0 && (
                    <div style={{ fontSize: 12, color: "var(--faint)", marginBottom: 12 }}>
                      {rawPaste.length.toLocaleString()} characters pasted
                    </div>
                  )}
                  <div className="toprow" style={{ marginTop: 0 }}>
                    <button className="btn primary" onClick={parsePaste} disabled={parsing || !rawPaste.trim()}>
                      {parsing ? "Parsing profile…" : "Parse & fill all fields ↓"}
                    </button>
                    <span style={{ color: "var(--muted)", fontSize: 12.5 }}>Overwrites all fields with what it finds — most complete data source available.</span>
                  </div>
                  {parsing && <div className="panel" style={{ marginTop: 14 }}><Loader stages={["Reading raw paste…","Stripping LinkedIn UI noise…","Extracting profile fields…","Parsing experience history…","Capturing posts and signals…","Structuring all data…"]} /></div>}
                  {parseMsg && <div className="reason" style={{ marginTop: 12 }}><b>Done</b> · {parseMsg}</div>}
                  {parseErr && <div className="err" style={{ marginTop: 12 }}>⚠ {parseErr}</div>}
                </div>

                <div className="panel">
                  <div className="sect-title">Basic information</div>
                  <div className="fgrid">
                    <Field k="firstName" label="First name" ph="e.g. Jeremy" />
                    <Field k="lastName" label="Last name" ph="e.g. Berg" />
                    <Field k="company" label="Company" ph="e.g. Armor Restoration" />
                    <Field k="title" label="Job title" ph="e.g. Owner / Operations Director" />
                    <Field k="industry" label="Industry" ph="e.g. Property Restoration" />
                    <Field k="location" label="Location" ph="e.g. Dallas, TX" />
                  </div>
                </div>
                <div className="panel">
                  <div className="sect-title">Context for the AI</div>
                  <div className="f full">
                    <label>Tell the AI what you already know about this lead — how you met, a referral, something they said, their priorities, anything to make the outreach feel personal. Used in every message and the analysis.</label>
                    <textarea value={prospect.context} placeholder={"e.g. Met briefly at the Dallas restoration expo — he mentioned they're slammed after the spring storms and short on field crews. Warm intro from Sarah at ServiceMaster."} onChange={(e) => set("context", e.target.value)} style={{ minHeight: 110 }} />
                  </div>
                </div>
                <div className="panel">
                  <div className="sect-title">Research information</div>
                  <div className="fgrid">
                    <Field k="headline" label="LinkedIn headline" ph="Their headline" full />
                    <Field k="about" label="LinkedIn about section" ph="Paste their About text" area full />
                    <Field k="experience" label="LinkedIn experience" ph="Key roles, tenure, background" area full />
                    <Field k="website" label="Company website" ph="armorrestoration.com" />
                    <Field k="news" label="Recent news / signals" ph="Expansion, hiring, storm season, etc." />
                    <Field k="companyDesc" label="Company description" ph="What the company does" area full />
                    <Field k="mutual" label="Mutual interests" ph="Shared groups, alma mater, hobbies" />
                    <Field k="notes" label="Personal notes" ph="Anything personal you noticed" />
                    <Field k="research" label="Additional research" ph="Anything else relevant" area full />
                  </div>
                </div>
                <div className="panel">
                  <div className="sect-title">Optional AI context</div>
                  <div className="fgrid">
                    <Field k="pain" label="Pain points" ph="Known frustrations" />
                    <Field k="growth" label="Growth objectives" ph="Where they're trying to grow" />
                    <Field k="staffing" label="Staffing challenges" ph="Hiring / capacity issues" />
                    <Field k="ops" label="Operational challenges" ph="Process / margin / backlog issues" />
                  </div>
                </div>

                <div className="panel">
                  <div className="sect-title">Sending as</div>
                  <div className="senders">
                    {SENDERS.map((s) => (
                      <button key={s.id} className={"sbtn" + (sender === s.id ? " on" : "")} onClick={() => pickSender(s.id)}>
                        <span className="sn">{s.name}</span><span className="sr">{s.role}</span><span className="st">{s.tag}</span>
                      </button>
                    ))}
                  </div>
                  <div className="f full">
                    <label>The AI writes in this sender's voice, uses only these real facts, and signs off with their first name. Meeting &amp; follow-up CTAs use their calendar link. Switching sender reloads the template.</label>
                    <textarea value={offer} onChange={(e) => setOffer(e.target.value)} style={{ minHeight: 120 }} />
                  </div>
                </div>

                <div className="panel step ai">
                  <div className="stepbadge ai"><span className="sn">3</span><span><span className="stt">AI Enrichment</span><span className="stsub">Build the intelligence profile + fit scores</span></span></div>
                  <div style={{ color: "var(--muted)", fontSize: 13.5, lineHeight: 1.6 }}>Karma Connect reads everything above and builds a full intelligence profile and fit scoring, then unlocks every outreach engine.</div>
                  <div className="sources">
                    {["Website", "LinkedIn", "Company news", "Public signals", "Your notes"].map((s) => <span key={s} className="srcchip"><span className="sdot" />{s}</span>)}
                  </div>
                  {!ready && <div className="hint" style={{ marginBottom: 8 }}>⚠ Add at least a first name and a company or title to continue.</div>}
                  <div className="toprow" style={{ marginBottom: 0, marginTop: 4 }}>
                    <button className="btn ai" disabled={!ready || loading.analysis} onClick={runAnalysis}>{loading.analysis ? "Analyzing…" : "Run AI Analysis →"}</button>
                    <span style={{ color: "var(--muted)", fontSize: 13 }}>Opportunity fit: {aiConfidence}% — computed from the data above.</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {view === "intel" && (
            <div>
              <div className="head"><div className="eyebrow">AI Analysis Engine</div><h2>Intelligence profile</h2><p>What the AI understands about {name} before writing a word. This drives every message.</p></div>
              <ProspectStrip />
              {analysis && !loading.analysis && insights.length > 0 && (
                <div className="copilot">
                  <h4><span className="cdotai" />AI Copilot · Insights found</h4>
                  <div className="insightgrid">
                    {insights.map((t, i) => <div className="insight" key={i}><span className="ifire">🔥</span><span>{t}</span></div>)}
                  </div>
                </div>
              )}
              {loading.analysis && <div className="panel"><Loader stages={STAGES_ANALYZE} /></div>}
              {errors.analysis && <div className="err">⚠ {errors.analysis}</div>}
              {analysis && !loading.analysis && (
                <div className="iprofile">
                  <div className="iblock full"><h4>Who they are</h4><p>{analysis.persona}</p></div>
                  {fitRows.length > 0 && (
                    <div className="iblock full">
                      <div className="fithead">
                        <h4>Fit &amp; opportunity scoring</h4>
                        <button className="btn ghost sm" onClick={() => setShowRubric((v) => !v)}>{showRubric ? "Hide the math" : "How these scores are calculated"}</button>
                      </div>
                      <div className="fitgrid">
                        {fitRows.map(([label, v], i) => v ? (
                          <div className="fitcard" key={i}>
                            <div className="fh"><span className="fn">{label}</span><span className="fv">{v.score}</span></div>
                            <div className="bar gold"><i style={{ width: (v.score || 0) + "%" }} /></div>
                            <div className="fc">{v.confidence} confidence</div>
                            <div className="fw">{v.why}</div>
                          </div>
                        ) : null)}
                      </div>
                      {showRubric && (
                        <div className="rubric">
                          <p className="rubric-note">Each score is computed in code from the data you entered — no AI guesswork, so the same prospect always scores the same. Points show exactly what earned the score.</p>
                          {fitRows.map(([label, v], i) => v ? (
                            <div className="rubric-dim" key={i}>
                              <div className="rubric-dh"><span>{label}</span><span className="rubric-tot">{v.score} / 100</span></div>
                              {v.factors.map((f, k) => (
                                <div className={"rubric-row" + (f.points > 0 ? "" : " miss")} key={k}>
                                  <span className="rubric-lbl">{f.points > 0 ? "✓" : "○"} {f.label}</span>
                                  <span className="rubric-pts">{f.points} / {f.max}</span>
                                </div>
                              ))}
                            </div>
                          ) : null)}
                        </div>
                      )}
                    </div>
                  )}
                  {[["Likely responsibilities", analysis.responsibilities], ["Pain points", analysis.painPoints], ["Goals they're pursuing", analysis.goals], ["Connection angles", analysis.hooks], ["Industry trends", analysis.trends], ["Sector challenges", analysis.challenges]].map(([t, arr], i) =>
                    arr && arr.length ? <div className="iblock" key={i}><h4>{t}</h4><ul>{arr.map((x, k) => <li key={k}>{x}</li>)}</ul></div> : null
                  )}
                  <div className="iblock full" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--muted)", fontSize: 13.5 }}>Profile ready — the engines are unlocked. Start with a connection request.</span>
                    <div style={{ display: "flex", gap: 10 }}>
                      <button className="btn ghost sm" onClick={exportBrief} disabled={exportingBrief}>{exportingBrief ? "Preparing…" : "Export PDF"}</button>
                      <button className="btn ghost sm" onClick={runAnalysis}>Re-run analysis</button>
                      <button className="btn primary sm" onClick={() => setView("connection")}>Connection requests →</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {view === "connection" && (
            <div>
              <div className="seg" style={{ marginBottom: 18 }}>
                <button className={connMode === "note" ? "on" : ""} onClick={() => setConnMode("note")}>Connection note</button>
                <button className={connMode === "inmail" ? "on" : ""} onClick={() => setConnMode("inmail")}>InMail message</button>
              </div>
              {connMode === "note"
                ? <SectionGenerator kind="connection" eyebrow="Section 01 · Most important" title="LinkedIn connection requests" blurb="Personalized invite notes under 300 characters. No pitch, no selling, no meeting ask — the only goal is an accepted connection that feels genuinely personal." charLimit={300} />
                : <SectionGenerator kind="inmail" eyebrow="Section 01 · For people who didn't accept" title="LinkedIn InMail messages" blurb="Premium messages you can send without being connected (when they ignored your invite). A subject line plus a personalized note — here you can introduce who you are and why you're reaching out, customized for them." charLimit={1900} />}
            </div>
          )}
          {view === "relationship" && (engineLocked("relationship")
            ? <ApprovalGate title="Relationship Builder" />
            : <SectionGenerator kind="relationship" eyebrow="Section 02 · After they accept" title="Post-connection relationship builder" blurb="Relationship-first openers that start a real conversation and demonstrate relevance — built to earn a reply, not to pitch." />)}

          {view === "meeting" && (engineLocked("meeting") ? <ApprovalGate title="Meeting Requests" /> : (
            <div>
              <div className="head"><div className="eyebrow">Section 03 · Once rapport is built</div><h2>Meeting request generator</h2><p>Value-focused, non-salesy meeting requests that make the ask an easy yes. Choose a length, then generate 3 angles.</p></div>
              <ProspectStrip />
              <div className="panel" style={{ marginBottom: 20, borderColor: prospectReply.trim() ? "rgba(82,211,158,.3)" : "var(--border)" }}>
                <div className="sect-title">Their reply (optional) · paste what the prospect said and the messages will respond to it</div>
                <div className="f full">
                  <textarea
                    value={prospectReply}
                    placeholder={"Paste the prospect's reply here.\nThe AI reads their tone (warm, curious, skeptical, busy…) and writes meeting asks that respond to what they actually said and match their energy. Leave blank for a standard meeting request."}
                    onChange={(e) => setProspectReply(e.target.value)}
                    style={{ minHeight: 90 }}
                  />
                </div>
                {prospectReply.trim() && <div className="hint" style={{ color: "#52d39e" }}>✓ Reply-aware mode on, the meeting requests below will respond to their message and match its tone.</div>}
              </div>
              <div className="toprow">
                <div className="seg">{[["short", "Short"], ["standard", "Standard"], ["executive", "Executive"]].map(([v, l]) => <button key={v} className={meetLen === v ? "on" : ""} onClick={() => setMeetLen(v)}>{l}</button>)}</div>
                <button className="btn primary" onClick={() => generate("meeting_" + meetLen)} disabled={loading["meeting_" + meetLen]}>{loading["meeting_" + meetLen] ? "Generating…" : (results["meeting_" + meetLen].length ? "Regenerate" : "Generate 3")}</button>
              </div>
              {errors["meeting_" + meetLen] && <div className="err" style={{ marginBottom: 16 }}>⚠ {errors["meeting_" + meetLen]}</div>}
              {loading["meeting_" + meetLen] && results["meeting_" + meetLen].length === 0 && <GenSkeleton />}
              {!loading["meeting_" + meetLen] && results["meeting_" + meetLen].length === 0 && !errors["meeting_" + meetLen] && (
                <div className="empty"><div className="eic">{Ic.meet}</div><h3>No {meetLen} meeting requests yet</h3><p>Generate 3 personalized {meetLen} meeting requests for {name}.</p><button className="btn primary" onClick={() => generate("meeting_" + meetLen)}>Generate for {name}</button></div>
              )}
              {results["meeting_" + meetLen].length > 0 && (
                <div className="grid2">
                  {results["meeting_" + meetLen].map((it, i) => { const kind = "meeting_" + meetLen; return <MsgCard key={i} item={it} idx={i} kind="meeting" source={verifySource} favOn={!!favs[favKey(kind, i, it.message)]} onCopy={copy} onFav={() => toggleFav(kind, i, it.message)} onRegen={() => regenerateOne(kind, i)} onRefine={(instr) => refineOne(kind, i, instr)} regening={!!regen[kind + i]} />; })}
                  {loading["meeting_" + meetLen] && <div className="mcard" style={{ justifyContent: "center", alignItems: "center", minHeight: 120, color: "var(--muted)", fontSize: 13 }}>Crafting more…</div>}
                </div>
              )}
            </div>
          ))}

          {view === "followup" && (engineLocked("followup") ? <ApprovalGate title="Follow-up Engine" /> : (
            <div>
              <div className="head"><div className="eyebrow">Section 04 · Follow-up</div><h2>Follow-up engine</h2><p>Two ways to follow up: a 5-step LinkedIn sequence for when there's no reply yet, or a stage-aware email after a meeting.</p></div>
              <ProspectStrip />
              <div className="seg" style={{ marginBottom: 18 }}>
                <button className={fuModeEff === "sequence" ? "on" : ""} onClick={() => setFuMode("sequence")}>LinkedIn sequence</button>
                <button className={fuModeEff === "email" ? "on" : ""} onClick={() => (isAdmin ? setFuMode("email") : showToast("The after-meeting email is for admins only."))}>After-meeting email{!isAdmin && " 🔒"}</button>
              </div>

              {fuModeEff === "sequence" ? (
                <>
                  <div className="toprow">
                    <button className="btn primary" onClick={() => generate("followupSeq")} disabled={loading.followupSeq}>{loading.followupSeq ? "Generating…" : (results.followupSeq.length ? "Regenerate sequence" : "Generate 5-step sequence")}</button>
                    <span style={{ color: "var(--muted)", fontSize: 13 }}>A no-reply sequence — each step introduces something new, never "just checking in".</span>
                  </div>
                  {errors.followupSeq && <div className="err" style={{ marginTop: 16 }}>⚠ {errors.followupSeq}</div>}
                  {loading.followupSeq && <div className="panel" style={{ marginTop: 16 }}><Loader stages={STAGES_GEN} /></div>}
                  {!loading.followupSeq && results.followupSeq.length === 0 && !errors.followupSeq && (
                    <div className="empty" style={{ marginTop: 16 }}><div className="eic">{Ic.fup}</div><h3>No sequence yet</h3><p>Generate a 5-step follow-up sequence tailored to {name}.</p><button className="btn primary" onClick={() => generate("followupSeq")}>Generate sequence</button></div>
                  )}
                  {results.followupSeq.length > 0 && (
                    <div className="tline" style={{ marginTop: 16 }}>
                      {results.followupSeq.map((st, i) => { const kind = "followupSeq"; return (
                        <div className="titem" key={i}>
                          <div className="mcard">
                            <div className="mctop"><span className="chip idx">{i + 1}</span><span className="stagehd">{st.stage}</span></div>
                            <div className="mbody" style={{ whiteSpace: "pre-wrap" }}>{st.message}</div>
                            {st.fresh && <div className="reason"><b>New angle</b> · {st.fresh}</div>}
                            {st.reasoning && <div className="reason"><b>AI Coach</b> · {st.reasoning}</div>}
                            {(() => { const fl = flagUnsupported(st.message, verifySource); return fl.length ? <div className="verify" title="These specifics aren't in the data you entered. Double-check them before sending.">⚠ Verify before sending: {fl.map((f) => f.claim).join(", ")}</div> : null; })()}
                            <div className="mact">
                              <button className="iconbtn" onClick={() => copy(st.message)}>{CopyIc} Copy</button>
                              <button className={"iconbtn fav" + (favs[favKey(kind, i, st.message)] ? " on" : "")} onClick={() => toggleFav(kind, i, st.message)} aria-label={favs[favKey(kind, i, st.message)] ? "Remove from favorites" : "Add to favorites"} aria-pressed={!!favs[favKey(kind, i, st.message)]} style={{ marginLeft: "auto" }}>{StarIc(!!favs[favKey(kind, i, st.message)])}</button>
                            </div>
                            <RefineBox onRefine={(instr) => refineOne("followupSeq", i, instr)} />
                          </div>
                        </div>
                      ); })}
                    </div>
                  )}
                </>
              ) : (
              <>
              <div className="panel" style={{ marginBottom: 20 }}>
                <div className="sect-title">Which stage are you at?</div>
                <div className="fustages">
                  {FOLLOWUP_STAGES.map((st) => <button key={st.v} className={"fustage" + (fuStage === st.v ? " on" : "")} onClick={() => setFuStage(st.v)}>{st.label}</button>)}
                </div>
                <div className="sect-title" style={{ marginTop: 18 }}>Call / meeting transcript <span style={{ color: "var(--faint)", textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>· optional</span></div>
                <div className="f full">
                  <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder={"Paste your call or meeting transcript here (or upload a .txt below). The email will reference what was actually discussed."} style={{ minHeight: 120, fontFamily: "monospace", fontSize: 12, lineHeight: 1.5 }} />
                </div>
                <div className="toprow" style={{ marginTop: 10 }}>
                  <label className="btn ghost sm" style={{ cursor: "pointer" }}>Upload .txt<input type="file" accept=".txt,.vtt,.md,text/plain" style={{ display: "none" }} onChange={handleTranscriptFile} /></label>
                  {transcript.trim()
                    ? <span className="hint" style={{ color: "#52d39e" }}>✓ Transcript loaded ({transcript.length.toLocaleString()} chars) — the email will reference it.</span>
                    : <span style={{ color: "var(--muted)", fontSize: 12.5 }}>Optional, but it makes the email far more specific.</span>}
                  {transcript.trim() && <button className="iconbtn" onClick={() => setTranscript("")}>Clear</button>}
                </div>
              </div>
              <div className="toprow">
                <button className="btn primary" onClick={() => generate("followup")} disabled={loading.followup}>{loading.followup ? "Generating…" : (results.followup.length ? "Regenerate email" : "Generate email")}</button>
                <span style={{ color: "var(--muted)", fontSize: 13 }}>One email for: <b style={{ color: "var(--ice)" }}>{(FOLLOWUP_STAGES.find((s) => s.v === fuStage) || FOLLOWUP_STAGES[0]).label}</b></span>
              </div>
              {errors.followup && <div className="err" style={{ marginTop: 16 }}>⚠ {errors.followup}</div>}
              {loading.followup && <div className="panel" style={{ marginTop: 16 }}><Loader stages={STAGES_GEN} /></div>}
              {!loading.followup && results.followup.length === 0 && !errors.followup && (
                <div className="empty" style={{ marginTop: 16 }}><div className="eic">{Ic.fup}</div><h3>No email yet</h3><p>Pick a stage above and generate a tailored follow-up email for {name}.</p></div>
              )}
              {results.followup.length > 0 && results.followup.map((st, i) => { const kind = "followup"; return (
                <div className="mcard" key={i} style={{ marginTop: 16 }}>
                  <div className="mctop"><span className="stagehd">{st.stage || "Follow-up"}</span></div>
                  <div className="mbody" style={{ whiteSpace: "pre-wrap" }}>{st.message}</div>
                  {st.reasoning && <div className="reason"><b>Why this fits</b> · {st.reasoning}</div>}
                  {(() => { const fl = flagUnsupported(st.message, verifySource + "\n" + transcript); return fl.length ? <div className="verify" title="These specifics aren't in your data or the transcript. Double-check them before sending.">⚠ Verify before sending: {fl.map((f) => f.claim).join(", ")}</div> : null; })()}
                  <div className="mact">
                    <button className="iconbtn" onClick={() => copy(st.message)}>{CopyIc} Copy</button>
                    <button className={"iconbtn fav" + (favs[favKey(kind, i, st.message)] ? " on" : "")} onClick={() => toggleFav(kind, i, st.message)} aria-label={favs[favKey(kind, i, st.message)] ? "Remove from favorites" : "Add to favorites"} aria-pressed={!!favs[favKey(kind, i, st.message)]} style={{ marginLeft: "auto" }}>{StarIc(!!favs[favKey(kind, i, st.message)])}</button>
                  </div>
                  <RefineBox onRefine={(instr) => refineOne("followup", i, instr)} />
                </div>
              ); })}
              </>
              )}
            </div>
          ))}

          {view === "history" && (
            <HistoryView
              history={history}
              historyMore={historyMore}
              onOpen={loadFromHistory}
              onDelete={deleteFromHistory}
              onLoadMore={loadMoreHistory}
              onGoHub={() => setView("hub")}
              askConfirm={askConfirm}
              query={histQuery}
              status={histStatus}
              onSearch={setHistQuery}
              onFilter={setHistStatus}
              onSetStatus={setHistoryStatus}
              onSetReminder={setHistoryReminder}
            />
          )}

          {view === "approvals" && isAdmin && (
            <ApprovalsView adminList={adminList} onRefresh={loadAdminList} onDecide={doDecide} />
          )}

          {view === "members" && isAdmin && (
            <AdminMembersView meId={me && me.id} askConfirm={askConfirm} showToast={showToast} />
          )}
          {view === "team" && isAdmin && <TeamActivityView />}

          {view === "dashboard" && <DashboardView onGoStage={(st) => { setHistStatus(st); setView("history"); }} />}

          {view === "board" && <BoardView onSetStatus={setHistoryStatus} />}

          {view === "reminders" && <RemindersView onChanged={loadRemindersDue} />}

          {view === "usage" && <UsageView />}

          {view === "settings" && (
            <SettingsView user={me} isAdmin={isAdmin} askConfirm={askConfirm} showToast={showToast} />
          )}
          </div>
          <div className="appfoot">
            <KarmaMark color="#5f72a0" w={18} />
            <span>Karma <b>Connect</b> · AI-Powered Prospect Intelligence</span>
            <span className="sp">{analysis ? "Profile active" : "Awaiting analysis"}</span>
          </div>
        </main>
      </div>
    </div>
  );
}
