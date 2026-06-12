import { useState, useEffect, Fragment } from "react";
import { CSS } from "./styles.js";
import { SYSTEM } from "./lib/brand.js";
import { SENDERS, senderOffer } from "./lib/senders.js";
import { anthropicMsg, callClaude } from "./lib/claude.js";
import { safeJSON } from "./lib/json.js";
import { cleanMessages, stripLinkedInNoise } from "./lib/text.js";
import {
  COMPANY_SYSTEM, companyResearchPrompt, buildContext,
  pAnalysis, pConnection, pRelationship, pMeeting, pFollowup,
  STAGES_ANALYZE, STAGES_GEN,
} from "./lib/prompts.js";
import { KarmaMark, Ic, CopyIc, StarIc } from "./components/icons.jsx";
import { Loader } from "./components/Loader.jsx";
import { MsgCard } from "./components/MsgCard.jsx";
import { listHistory, writeHistory, deleteHistory, HISTORY_PAGE_SIZE } from "./lib/history.js";

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
  };
  const [view, setView] = useState(saved.view || "hub");
  const [prospect, setProspect] = useState({ ...EMPTY_PROSPECT, ...(saved.prospect || {}) });
  const [sender, setSender] = useState(saved.sender || "nordon");
  const [offer, setOffer] = useState(saved.offer || senderOffer(SENDERS[0]));
  const [coUrl, setCoUrl] = useState(saved.coUrl || "");
  const [enriching, setEnriching] = useState(false);
  const [enrichMsg, setEnrichMsg] = useState("");
  const [enrichErr, setEnrichErr] = useState("");
  const [rawPaste, setRawPaste] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseMsg, setParseMsg] = useState("");
  const [parseErr, setParseErr] = useState("");
  const [analysis, setAnalysis] = useState(saved.analysis || null);
  const [results, setResults] = useState(saved.results || { connection: [], relationship: [], meeting_short: [], meeting_standard: [], meeting_executive: [], followup: [] });
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [regen, setRegen] = useState({});
  const [favs, setFavs] = useState(saved.favs || {});
  const [meetLen, setMeetLen] = useState(saved.meetLen || "standard");
  const [prospectReply, setProspectReply] = useState(saved.prospectReply || "");
  const [toast, setToast] = useState("");
  const [confirmState, setConfirmState] = useState(null); // { title, message, confirmLabel, danger, onConfirm }
  const [history, setHistory] = useState([]);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyMore, setHistoryMore] = useState(false);
  const [currentEntryId, setCurrentEntryId] = useState(saved.currentEntryId || null);

  // Load saved prospects (Supabase when signed in, else localStorage). Async + paginated.
  useEffect(() => {
    let alive = true;
    listHistory(userEmail, 0).then((rows) => {
      if (!alive) return;
      setHistory(rows); setHistoryPage(0); setHistoryMore(rows.length >= HISTORY_PAGE_SIZE);
    });
    return () => { alive = false; };
  }, [userEmail]);

  // Persist work to localStorage so a refresh never loses (or re-bills) it.
  useEffect(() => {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({ view, prospect, sender, offer, coUrl, analysis, results, favs, meetLen, prospectReply, currentEntryId }));
    } catch (e) {}
  }, [view, prospect, sender, offer, coUrl, analysis, results, favs, meetLen, prospectReply, currentEntryId, STATE_KEY]);

  // Auto-save the current prospect to history once analysis has run, then keep it in sync
  // (debounced) as messages are generated/edited. No manual "Save" needed.
  useEffect(() => {
    if (!analysis) return;
    const t = setTimeout(() => autoSaveCurrent(), 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, results, favs, prospect, sender, offer, meetLen, prospectReply]);

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
  function askConfirm(opts) { setConfirmState(opts); }
  function doReset() {
    setProspect({ ...EMPTY_PROSPECT });
    setAnalysis(null);
    setResults({ connection: [], relationship: [], meeting_short: [], meeting_standard: [], meeting_executive: [], followup: [] });
    setFavs({}); setCoUrl(""); setRawPaste(""); setProspectReply(""); setView("hub");
    setEnrichMsg(""); setEnrichErr(""); setParseMsg(""); setParseErr("");
    setCurrentEntryId(null);
    showToast("Cleared. Ready for a new prospect.");
  }
  function resetAll() {
    askConfirm({ title: "Start a new prospect?", message: "This clears the current prospect and everything generated for them. It can't be undone.", confirmLabel: "Clear & start new", danger: true, onConfirm: doReset });
  }

  // ---- Per-account prospect history (auto-saved after analysis) ----
  function autoSaveCurrent() {
    if (!analysis) return;
    if (!prospect.firstName.trim() && !prospect.company.trim()) return;
    let id = currentEntryId;
    if (!id) { id = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : "h" + Date.now(); setCurrentEntryId(id); }
    const label = [prospect.firstName, prospect.lastName].filter(Boolean).join(" ") || prospect.company || "Untitled";
    const sub = [prospect.title, prospect.company].filter(Boolean).join(" · ");
    const entry = { id, label, sub, savedAt: new Date().toISOString(), snapshot: { prospect, sender, offer, coUrl, analysis, results, favs, meetLen, prospectReply } };
    setHistory((cur) => [entry, ...cur.filter((h) => h.id !== id)]);
    writeHistory(userEmail, [entry]);
  }
  function loadMoreHistory() {
    const next = historyPage + 1;
    listHistory(userEmail, next).then((rows) => {
      if (rows.length) { setHistory((cur) => [...cur, ...rows]); setHistoryPage(next); }
      setHistoryMore(rows.length >= HISTORY_PAGE_SIZE);
    });
  }
  function loadFromHistory(entry) {
    const s = entry.snapshot || {};
    setProspect({ ...EMPTY_PROSPECT, ...(s.prospect || {}) });
    setSender(s.sender || "nordon");
    setOffer(s.offer || senderOffer(SENDERS[0]));
    setCoUrl(s.coUrl || "");
    setAnalysis(s.analysis || null);
    setResults(s.results || { connection: [], relationship: [], meeting_short: [], meeting_standard: [], meeting_executive: [], followup: [] });
    setFavs(s.favs || {});
    setMeetLen(s.meetLen || "standard");
    setProspectReply(s.prospectReply || "");
    setCurrentEntryId(entry.id);
    setView(s.analysis ? "intel" : "hub");
    showToast("Loaded " + (entry.label || "prospect"));
  }
  function deleteFromHistory(id) {
    setHistory(history.filter((h) => h.id !== id));
    deleteHistory(userEmail, id);
  }
  const favKey = (kind, i, msg) => kind + ":" + i + ":" + (msg || "").slice(0, 24);
  function toggleFav(kind, i, msg) { const k = favKey(kind, i, msg); setFavs((f) => ({ ...f, [k]: !f[k] })); }

  // Lightweight COMPANY research — one web-search call. Fills empty company-side fields only.
  // (The person's profile comes from the Deep LinkedIn paste panel below.)
  async function enrich() {
    if (!coUrl.trim() && !prospect.company.trim()) {
      setEnrichErr("Add the company website URL or the company name first.");
      return;
    }
    setEnriching(true); setEnrichMsg(""); setEnrichErr("");
    try {
      const txt = await anthropicMsg(COMPANY_SYSTEM, companyResearchPrompt(prospect, coUrl), { maxTokens: 1200, useSearch: true });
      const parsed = safeJSON(txt);
      const d = Array.isArray(parsed) ? (parsed[0] || {}) : parsed;
      const nv = (v) => (v == null || v === "NOT VERIFIED" ? "" : String(v).trim());
      const joinArr = (a, sep = ", ") => (Array.isArray(a) ? a.map(nv).filter(Boolean).join(sep) : "");
      setProspect((prev) => {
        const next = { ...prev };
        const fill = (k, val) => { if (val && !String(next[k] || "").trim()) next[k] = val; };
        fill("company", nv(d.company));
        fill("industry", nv(d.industry));
        fill("website", nv(d.website) || coUrl);
        fill("location", nv(d.location));
        fill("companyDesc", [nv(d.companyDesc), joinArr(d.services)].filter(Boolean).join(" | "));
        fill("news", joinArr((d.recentNews || []).slice(0, 3), " | "));
        const note = [nv(d.summary), nv(d.employeeCount) ? "Employees: " + nv(d.employeeCount) : ""].filter(Boolean).join(" ");
        if (note) next.research = (next.research ? next.research + "\n\n" : "") + "Company research: " + note;
        return next;
      });
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
${stripLinkedInNoise(rawPaste).slice(0, 14000)}`;

    try {
      const txt = await anthropicMsg(systemPrompt, userPrompt, { maxTokens: 4000 });

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

  async function runAnalysis() {
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
    } catch (e) {
      setErrors((er) => ({ ...er, analysis: (e && e.message) || "Analysis failed. Try again." }));
    }
    setLoading((l) => ({ ...l, analysis: false }));
  }

  const TARGET = { connection: 10, relationship: 10, meeting_short: 10, meeting_standard: 10, meeting_executive: 10 };
  function builderFor(kind, n, avoid) {
    const base = buildContext(prospect, offer, analysis, "");
    if (kind === "connection") return pConnection(base, n, avoid);
    if (kind === "relationship") return pRelationship(base, n, avoid);
    if (kind.indexOf("meeting_") === 0) return pMeeting(base, n, kind.split("_")[1], avoid, prospectReply);
    return "";
  }
  async function generate(kind) {
    setLoading((l) => ({ ...l, [kind]: true })); setErrors((e) => ({ ...e, [kind]: null })); setResults((r) => ({ ...r, [kind]: [] }));
    try {
      if (kind === "followup") {
        const txt = await callClaude(SYSTEM, pFollowup(buildContext(prospect, offer, analysis, "")), false, 2800);
        let arr = safeJSON(txt); if (!Array.isArray(arr)) arr = [arr]; arr = cleanMessages(arr); setResults((r) => ({ ...r, followup: arr }));
      } else {
        const target = TARGET[kind] || 10;
        const isMeeting = kind.indexOf("meeting_") === 0;
        // Right-sized output cap to fit all `target` items in ONE call.
        const cap = isMeeting ? 4800 : kind === "relationship" ? 3600 : 3000;
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

  const NAV = [
    { id: "hub", label: "Prospect Hub", ic: Ic.hub },
    { id: "intel", label: "Intelligence", ic: Ic.intel, gate: true },
    { id: "connection", label: "Connection Requests", ic: Ic.conn, gate: true, count: results.connection.length },
    { id: "relationship", label: "Relationship Builder", ic: Ic.rel, gate: true, count: results.relationship.length },
    { id: "meeting", label: "Meeting Requests", ic: Ic.meet, gate: true },
    { id: "followup", label: "Follow-up Engine", ic: Ic.fup, gate: true, count: results.followup.length },
    { id: "history", label: "History", ic: Ic.hist, count: history.length },
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
  function SectionGenerator({ kind, title, eyebrow, blurb, charLimit }) {
    const items = results[kind] || [], isLoad = loading[kind], err = errors[kind];
    return (
      <div>
        <div className="head"><div className="eyebrow">{eyebrow}</div><h2>{title}</h2><p>{blurb}</p></div>
        <ProspectStrip />
        <div className="toprow">
          <button className="btn primary" onClick={() => generate(kind)} disabled={isLoad}>{isLoad ? "Generating…" : items.length ? "Regenerate all" : "Generate 10 variations"}</button>
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
              <MsgCard key={i} item={it} idx={i} kind={kind} charLimit={charLimit}
                favOn={!!favs[favKey(kind, i, it.message)]} onCopy={copy} onFav={() => toggleFav(kind, i, it.message)}
                onRegen={() => regenerateOne(kind, i)} regening={!!regen[kind + i]} />
            ))}
            {isLoad && <div className="mcard" style={{ justifyContent: "center", alignItems: "center", minHeight: 120, color: "var(--muted)", fontSize: 13 }}>Crafting more…</div>}
          </div>
        )}
      </div>
    );
  }

  const fitRows = analysis && analysis.fit ? [["ICP Fit", analysis.fit.icp], ["Qualification", analysis.fit.qualification], ["Buying readiness", analysis.fit.readiness]] : [];

  // Prospect completion + research coverage + AI confidence (derived from current data).
  const COMPLETION_FIELDS = ["firstName", "lastName", "title", "company", "industry", "location", "headline", "about", "experience", "website", "companyDesc", "news"];
  const completion = Math.round((100 * COMPLETION_FIELDS.filter((k) => String(prospect[k] || "").trim()).length) / COMPLETION_FIELDS.length);
  const coverage = [
    ["LinkedIn", !!(prospect.about || prospect.experience || prospect.headline)],
    ["Website", !!String(prospect.website || "").trim()],
    ["Company", !!String(prospect.companyDesc || prospect.company || "").trim()],
    ["News", !!String(prospect.news || "").trim()],
    ["Role", !!(String(prospect.title || "").trim() && String(prospect.firstName || "").trim())],
  ];
  const aiConfidence = analysis && analysis.fit
    ? Math.round(((analysis.fit.icp?.score || 0) + (analysis.fit.qualification?.score || 0) + (analysis.fit.readiness?.score || 0)) / 3)
    : null;
  const insights = analysis ? [...(analysis.hooks || []), ...(analysis.trends || [])].filter(Boolean).slice(0, 6) : [];

  return (
    <div className="kc">
      <style>{CSS}</style>
      <div className="app">
        <aside className="side">
          <div className="brand">
            <span className="mark"><KarmaMark color="#fff" w={22} /></span>
            <div><h1>Karma <b>Connect</b></h1><span>AI Prospecting</span></div>
          </div>
          <div className="navlbl">Workspace</div>
          {NAV.map((n) => {
            const locked = n.gate && !analysis && !loading.analysis;
            return (
              <Fragment key={n.id}>
                {n.id === "connection" && <div className="navlbl" style={{ marginTop: 4 }}>Outreach</div>}
                {n.id === "history" && <div className="navlbl" style={{ marginTop: 4 }}>Library</div>}
                <button className={"nav" + (view === n.id ? " on" : "") + (locked ? " lock" : "")} onClick={() => { if (!locked) setView(n.id); }}>
                  {n.ic}{n.label}
                  {n.count > 0 && <span className="ct">{n.count}</span>}
                  {locked && <span className="ct" style={{ color: "var(--faint)" }}>🔒</span>}
                </button>
              </Fragment>
            );
          })}
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

        <main className="main">
          {toast && <div className="kctoast">{toast}</div>}
          {confirmState && (
            <div className="modal-ov" onClick={() => setConfirmState(null)}>
              <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
                <h3>
                  {confirmState.danger && <span className="mi" style={{ background: "rgba(226,74,74,.16)", color: "#ff9a9a", border: "1px solid rgba(226,74,74,.3)" }}>!</span>}
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
                  <div className="progring" style={{ "--p": aiConfidence || 0, "--c": "var(--ai)" }}><span>{aiConfidence != null ? aiConfidence + "%" : "—"}</span></div>
                  <div><div className="scl">AI confidence</div><div className="scv">{aiConfidence != null ? "From analysis" : "Run analysis"}</div></div>
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
                    {aiConfidence != null && <span style={{ color: "var(--muted)", fontSize: 13 }}>Last run: {aiConfidence}% confidence, re-run after adding more.</span>}
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
                      <h4>Fit &amp; opportunity scoring</h4>
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
                    </div>
                  )}
                  {[["Likely responsibilities", analysis.responsibilities], ["Pain points", analysis.painPoints], ["Goals they're pursuing", analysis.goals], ["Connection angles", analysis.hooks], ["Industry trends", analysis.trends], ["Sector challenges", analysis.challenges]].map(([t, arr], i) =>
                    arr && arr.length ? <div className="iblock" key={i}><h4>{t}</h4><ul>{arr.map((x, k) => <li key={k}>{x}</li>)}</ul></div> : null
                  )}
                  <div className="iblock full" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--muted)", fontSize: 13.5 }}>Profile ready — the engines are unlocked. Start with a connection request.</span>
                    <div style={{ display: "flex", gap: 10 }}>
                      <button className="btn ghost sm" onClick={runAnalysis}>Re-run analysis</button>
                      <button className="btn primary sm" onClick={() => setView("connection")}>Connection requests →</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {view === "connection" && <SectionGenerator kind="connection" eyebrow="Section 01 · Most important" title="LinkedIn connection requests" blurb="Personalized invite notes under 300 characters. No pitch, no selling, no meeting ask — the only goal is an accepted connection that feels genuinely personal." charLimit={300} />}
          {view === "relationship" && <SectionGenerator kind="relationship" eyebrow="Section 02 · After they accept" title="Post-connection relationship builder" blurb="Relationship-first openers that start a real conversation and demonstrate relevance — built to earn a reply, not to pitch." />}

          {view === "meeting" && (
            <div>
              <div className="head"><div className="eyebrow">Section 03 · Once rapport is built</div><h2>Meeting request generator</h2><p>Value-focused, non-salesy meeting requests that make the ask an easy yes. Choose a length, then generate 10 angles.</p></div>
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
                <button className="btn primary" onClick={() => generate("meeting_" + meetLen)} disabled={loading["meeting_" + meetLen]}>{loading["meeting_" + meetLen] ? "Generating…" : (results["meeting_" + meetLen].length ? "Regenerate" : "Generate 10")}</button>
              </div>
              {errors["meeting_" + meetLen] && <div className="err" style={{ marginBottom: 16 }}>⚠ {errors["meeting_" + meetLen]}</div>}
              {loading["meeting_" + meetLen] && results["meeting_" + meetLen].length === 0 && <GenSkeleton />}
              {!loading["meeting_" + meetLen] && results["meeting_" + meetLen].length === 0 && !errors["meeting_" + meetLen] && (
                <div className="empty"><div className="eic">{Ic.meet}</div><h3>No {meetLen} meeting requests yet</h3><p>Generate 10 personalized {meetLen} meeting requests for {name}.</p><button className="btn primary" onClick={() => generate("meeting_" + meetLen)}>Generate for {name}</button></div>
              )}
              {results["meeting_" + meetLen].length > 0 && (
                <div className="grid2">
                  {results["meeting_" + meetLen].map((it, i) => { const kind = "meeting_" + meetLen; return <MsgCard key={i} item={it} idx={i} kind="meeting" favOn={!!favs[favKey(kind, i, it.message)]} onCopy={copy} onFav={() => toggleFav(kind, i, it.message)} onRegen={() => regenerateOne(kind, i)} regening={!!regen[kind + i]} />; })}
                  {loading["meeting_" + meetLen] && <div className="mcard" style={{ justifyContent: "center", alignItems: "center", minHeight: 120, color: "var(--muted)", fontSize: 13 }}>Crafting more…</div>}
                </div>
              )}
            </div>
          )}

          {view === "followup" && (
            <div>
              <div className="head"><div className="eyebrow">Section 04 · No reply yet</div><h2>Intelligent follow-up engine</h2><p>A 5-step sequence where every message introduces something new — never "just checking in," never a repeat.</p></div>
              <ProspectStrip />
              <div className="toprow"><button className="btn primary" onClick={() => generate("followup")} disabled={loading.followup}>{loading.followup ? "Generating…" : (results.followup.length ? "Regenerate sequence" : "Generate sequence")}</button></div>
              {errors.followup && <div className="err" style={{ marginBottom: 16 }}>⚠ {errors.followup}</div>}
              {loading.followup && <div className="panel"><Loader stages={STAGES_GEN} /></div>}
              {!loading.followup && results.followup.length === 0 && !errors.followup && (
                <div className="empty"><div className="eic">{Ic.fup}</div><h3>No sequence yet</h3><p>Generate a 5-step follow-up sequence tailored to {name}.</p><button className="btn primary" onClick={() => generate("followup")}>Generate sequence</button></div>
              )}
              {results.followup.length > 0 && (
                <div className="tline">
                  {results.followup.map((st, i) => { const kind = "followup"; return (
                    <div className="titem" key={i}>
                      <div className="mcard">
                        <div className="mctop"><span className="chip idx">{i + 1}</span><span className="stagehd">{st.stage}</span></div>
                        <div className="mbody">{st.message}</div>
                        {st.fresh && <div className="reason"><b>New angle</b> · {st.fresh}</div>}
                        {st.reasoning && <div className="reason"><b>AI Coach</b> · {st.reasoning}</div>}
                        <div className="mact">
                          <button className="iconbtn" onClick={() => copy(st.message)}>{CopyIc} Copy</button>
                          <button className={"iconbtn fav" + (favs[favKey(kind, i, st.message)] ? " on" : "")} onClick={() => toggleFav(kind, i, st.message)} aria-label={favs[favKey(kind, i, st.message)] ? "Remove from favorites" : "Add to favorites"} aria-pressed={!!favs[favKey(kind, i, st.message)]} style={{ marginLeft: "auto" }}>{StarIc(!!favs[favKey(kind, i, st.message)])}</button>
                        </div>
                      </div>
                    </div>
                  ); })}
                </div>
              )}
            </div>
          )}

          {view === "history" && (
            <div>
              <div className="head"><div className="eyebrow">Saved prospects</div><h2>History</h2><p>Every prospect you save lands here, tied to your account. Open one to restore the full prospect, analysis, and generated messages, or remove it.</p></div>
              {history.length === 0 ? (
                <div className="empty">
                  <div className="eic">{Ic.hist}</div>
                  <h3>No saved prospects yet</h3>
                  <p>Run <b>AI Analysis</b> on a prospect and it's saved here automatically, along with everything you generate for them.</p>
                  <button className="btn primary" onClick={() => setView("hub")}>Go to Prospect Hub</button>
                </div>
              ) : (
                <div className="grid2">
                  {history.map((h) => (
                    <div className="mcard" key={h.id}>
                      <div className="mctop">
                        <span className="av" style={{ width: 30, height: 30, borderRadius: 8, background: "var(--grad)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 12, color: "#fff", fontFamily: "'Lora',serif" }}>
                          {((h.label || "?")[0] || "?").toUpperCase()}
                        </span>
                        <div>
                          <div className="pn" style={{ fontSize: 14, fontWeight: 700 }}>{h.label}</div>
                          {h.sub && <div className="pr" style={{ fontSize: 11.5, color: "var(--muted)" }}>{h.sub}</div>}
                        </div>
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--faint)", display: "flex", gap: 12, flexWrap: "wrap" }}>
                        <span>Saved {new Date(h.savedAt).toLocaleDateString()} {new Date(h.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                        {h.snapshot?.analysis && <span style={{ color: "#52d39e" }}>Analysis ✓</span>}
                        {(() => { const r = h.snapshot?.results || {}; const n = Object.values(r).reduce((a, x) => a + (Array.isArray(x) ? x.length : 0), 0); return n ? <span>{n} messages</span> : null; })()}
                      </div>
                      <div className="mact">
                        <button className="iconbtn" onClick={() => loadFromHistory(h)}>Open</button>
                        <button className="iconbtn" onClick={() => askConfirm({ title: "Remove from history?", message: "Remove " + (h.label || "this prospect") + " and everything saved for them. This can't be undone.", confirmLabel: "Delete", danger: true, onConfirm: () => deleteFromHistory(h.id) })} style={{ marginLeft: "auto" }}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {history.length > 0 && historyMore && (
                <div className="toprow" style={{ justifyContent: "center", marginTop: 18 }}>
                  <button className="btn ghost sm" onClick={loadMoreHistory}>Load older</button>
                </div>
              )}
            </div>
          )}
          </div>
          <div className="appfoot">
            <KarmaMark color="#5f72a0" w={15} />
            <span>Karma <b>Connect</b> · AI-Powered Prospect Intelligence</span>
            <span className="sp">{analysis ? "Profile active" : "Awaiting analysis"}</span>
          </div>
        </main>
      </div>
    </div>
  );
}
