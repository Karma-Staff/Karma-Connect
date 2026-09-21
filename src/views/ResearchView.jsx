// Prospect Research — look someone up and get the briefing you read before
// the call: what they do, anything recent worth congratulating them on, who
// you are speaking to, and what not to raise.
//
// The same briefing Karma Leads produces. Both go through one prompt on the
// server (leads/server/brief.js via POST /api/research), because two products
// answering the same question differently is how one of them quietly starts
// inventing an alma mater.
//
// Nothing here runs on its own — each briefing is a live web search, so it
// takes a button. The form prefills from whichever prospect is loaded in the
// Hub, so the common case is: open this, press Research.
import { useState, useEffect } from "react";

const STAGES = ["Looking them up…", "Reading their site…", "Checking recent news…",
  "Finding an opener…", "Writing the briefing…"];

function Block({ label, children, tone }) {
  if (!children) return null;
  return (
    <div className={"rsblock" + (tone ? " " + tone : "")}>
      <div className="rslabel">{label}</div>
      {children}
    </div>
  );
}

const List = ({ items }) => (items && items.length
  ? <ul className="rsul">{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : null);

const Text = ({ value }) => (value ? <p className="rstext">{value}</p> : null);

export function ResearchView({ prospect, showToast }) {
  const [form, setForm] = useState({
    company: "", name: "", title: "", website: "", city: "", state: "", industry: "",
  });
  const [brief, setBrief] = useState(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(STAGES[0]);
  const [err, setErr] = useState("");

  /* Prefill from the Hub's prospect, once, and only into fields the person
     has not already typed into — retyping what is already on screen is the
     most annoying thing a form can do. */
  useEffect(() => {
    if (!prospect) return;
    setForm((f) => ({
      company: f.company || prospect.company || "",
      name: f.name || [prospect.firstName, prospect.lastName].filter(Boolean).join(" "),
      title: f.title || prospect.title || "",
      website: f.website || prospect.website || "",
      city: f.city || prospect.location || "",
      state: f.state,
      industry: f.industry || prospect.industry || "",
    }));
  }, [prospect]);

  useEffect(() => {
    if (!busy) return;
    let i = 0;
    const t = setInterval(() => { i = Math.min(i + 1, STAGES.length - 1); setStage(STAGES[i]); }, 4000);
    return () => clearInterval(t);
  }, [busy]);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function run() {
    setErr(""); setBusy(true); setStage(STAGES[0]);
    try {
      const res = await fetch("/api/research", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // a name without a company is a person; with one it is the firm
        body: JSON.stringify({ ...form, kind: form.name && !form.company ? "person" : "company" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || "Research failed (" + res.status + ").");
      setBrief(data.brief);
      if (showToast) showToast("Briefing ready");
    } catch (e) { setErr((e && e.message) || "Could not run the research."); }
    setBusy(false);
  }

  const p = (brief && brief.person) || {};
  const who = form.company || form.name;

  return (
    <div>
      <div className="head">
        <div className="eyebrow">Before the call</div>
        <h2>Prospect research</h2>
        <p>Look a prospect up and get a briefing you can read before dialling — what they
          do, anything recent worth congratulating them on, and what to avoid.</p>
      </div>

      <div className="panel">
        <div className="fgrid">
          <div className="f"><label>Company</label>
            <input value={form.company} onChange={set("company")} placeholder="SERVPRO of Tulsa" /></div>
          <div className="f"><label>Person (optional)</label>
            <input value={form.name} onChange={set("name")} placeholder="Dana Reed" /></div>
          <div className="f"><label>Job title (optional)</label>
            <input value={form.title} onChange={set("title")} placeholder="Operations Manager" /></div>
          <div className="f"><label>Website</label>
            <input value={form.website} onChange={set("website")} placeholder="servprotulsa.com" /></div>
          <div className="f"><label>Location</label>
            <input value={form.city} onChange={set("city")} placeholder="Tulsa, OK" /></div>
          <div className="f"><label>Industry</label>
            <input value={form.industry} onChange={set("industry")} placeholder="Restoration" /></div>
        </div>
        <div className="toprow" style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={run}
                  disabled={busy || !(form.company || form.name || form.website)}>
            {busy ? "Researching…" : brief ? "Research again" : "Research prospect"}
          </button>
          {busy && <span className="rsworking"><span className="rsspin" />{stage}</span>}
        </div>
        {err && <div className="err" style={{ marginTop: 12 }}>⚠ {err}</div>}
      </div>

      {brief && (
        <div className="panel">
          {brief.headline && <p className="rsheadline">{brief.headline}</p>}
          {brief.confidence && (
            <span className={"rsconf rsconf-" + brief.confidence}
                  title="How much of this the model could verify, rather than infer">
              {brief.confidence} confidence
            </span>
          )}

          <Block label="What they do"><Text value={brief.whatTheyDo} /></Block>
          <Block label="Size"><Text value={brief.size} /></Block>
          <Block label="Recent"><List items={brief.recentSignals} /></Block>
          <Block label="Worth congratulating them on" tone="good"><List items={brief.congratulations} /></Block>
          <Block label="Their role"><Text value={p.role} /></Block>
          <Block label="Background"><Text value={p.background} /></Block>
          <Block label="Education"><Text value={p.education} /></Block>
          <Block label="Interests"><List items={p.interests} /></Block>
          <Block label="Talking points"><List items={brief.talkingPoints} /></Block>
          <Block label="Don't raise" tone="avoid"><List items={brief.avoid} /></Block>

          {brief.sources.length > 0 && (
            <Block label="Sources">
              <div className="rssources">
                {brief.sources.map((u, i) => {
                  let host = u;
                  try { host = new URL(u).hostname.replace(/^www\./, ""); } catch (e) { /* show it raw */ }
                  return <a key={i} href={u} target="_blank" rel="noopener noreferrer">{host}</a>;
                })}
              </div>
            </Block>
          )}

          <p className="rswarn">Written from a web search on {who || "this prospect"}. Check
            anything you plan to say out loud — a wrong detail is worse than none.</p>
        </div>
      )}
    </div>
  );
}
