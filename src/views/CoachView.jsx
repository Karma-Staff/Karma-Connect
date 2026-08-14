// Message Coach view. Shows the current learned playbook (what's steering every new message)
// and a change log — exactly what the automatic learning has changed, and when. Learning runs
// automatically in the background; the "Update now" button just forces a pass.
import { useState, useEffect } from "react";
import { getPlaybook, getChanges, learnFromResults, KINDS, KIND_LABEL } from "../lib/coach.js";

const fmtDate = (t) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const rules = (text) => String(text || "").split("\n").map((l) => l.replace(/^[-•\s]+/, "").trim()).filter(Boolean);

export function CoachView() {
  const [playbook, setPlaybook] = useState(null);
  const [changes, setChanges] = useState([]);
  const [learning, setLearning] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  function load() {
    getPlaybook().then(setPlaybook).catch(() => setPlaybook({}));
    getChanges().then(setChanges).catch(() => setChanges([]));
  }
  useEffect(() => { load(); }, []);

  async function learn() {
    setMsg(""); setErr(""); setLearning("starting");
    try {
      const results = await learnFromResults((k) => setLearning(k));
      const learned = results.filter((r) => r.status === "learned");
      const skipped = results.filter((r) => r.status === "skipped");
      load();
      setMsg(learned.length
        ? `Updated ${learned.length} playbook${learned.length === 1 ? "" : "s"}.${skipped.length ? " " + skipped.length + " type(s) still need more decided results." : ""}`
        : "Not enough decided results yet — mark messages sent, then mark those leads Won or Ghosted.");
    } catch (e) { setErr(e.message || "Could not update right now."); }
    setLearning("");
  }

  const kindsWith = playbook ? KINDS.filter((k) => playbook[k] && playbook[k].trim()) : [];

  return (
    <div>
      <div className="head">
        <div className="eyebrow">Self-improving</div>
        <h2>Message Coach</h2>
        <p>The coach learns from your results automatically — comparing messages that won replies against ones that got ghosted — and applies what it learns to every new message. Below is what it's using now, and a log of every change it has made.</p>
      </div>

      {err && <div className="err">⚠ {err}</div>}

      {/* Current playbook */}
      <div className="panel" style={{ marginBottom: 14, borderLeft: "3px solid var(--gold, #E7B74B)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div className="sect-title">Currently applied to your messages</div>
            <div style={{ fontSize: 11.5, color: "var(--muted)" }}>Updates on its own as results come in. You can also force a pass.</div>
          </div>
          <button className="btn primary sm" onClick={learn} disabled={!!learning}>
            {learning ? (learning === "starting" ? "Analyzing…" : "Learning " + (KIND_LABEL[learning] || learning) + "…") : "Update now"}
          </button>
        </div>
        {msg && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>{msg}</div>}
        {kindsWith.length > 0 ? (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
            {kindsWith.map((k) => (
              <div key={k}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>{KIND_LABEL[k]}</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--muted)", lineHeight: 1.55 }}>
                  {rules(playbook[k]).map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
            Nothing learned yet. As you mark messages sent and mark leads Won or Ghosted, the coach will build this automatically.
          </div>
        )}
      </div>

      {/* Change log */}
      <div className="panel">
        <div className="sect-title">Change log — what the coach has changed</div>
        {changes.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>No changes yet. Every time the coach updates how your messages are written, it'll be recorded here with the before and after.</div>
        ) : (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 12 }}>
            {changes.map((c) => (
              <div key={c.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700 }}>{KIND_LABEL[c.kind] || c.kind}</span>
                  <span style={{ fontSize: 11, padding: "1px 7px", borderRadius: 999, background: c.source === "auto" ? "rgba(82,211,158,.15)" : "rgba(74,134,200,.15)", color: c.source === "auto" ? "var(--accent, #52d39e)" : "var(--steel, #4a86c8)" }}>
                    {c.source === "auto" ? "automatic" : "manual"}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--faint)" }}>{fmtDate(c.created_at)} · from {c.sample_size} result{c.sample_size === 1 ? "" : "s"}</span>
                </div>
                <div style={{ fontSize: 12, color: "var(--text)", marginTop: 6, marginBottom: 2 }}>Now writing with:</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
                  {rules(c.playbook).map((r, i) => <li key={i}>{r}</li>)}
                </ul>
                {c.prev_playbook && c.prev_playbook.trim() && (
                  <details style={{ marginTop: 6 }}>
                    <summary style={{ fontSize: 11.5, color: "var(--faint)", cursor: "pointer" }}>what it replaced</summary>
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--faint)", lineHeight: 1.5 }}>
                      {rules(c.prev_playbook).map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
