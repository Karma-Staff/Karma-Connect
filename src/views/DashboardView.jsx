// Pipeline dashboard: funnel metrics + CSV/JSON export. Deterministic — no AI tokens.
import { useState, useEffect } from "react";
import { getStats, getLeadsPdf } from "../lib/leads.js";
import { LEAD_STATUSES } from "./HistoryView.jsx";

function Stat({ label, value, sub }) {
  return (
    <div className="scorecard" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
      <div className="scl">{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color: "var(--text)", fontFamily: "'Lora',serif" }}>{value}</div>
      {sub && <div className="scv">{sub}</div>}
    </div>
  );
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

export function DashboardView({ onGoStage }) {
  const [stats, setStats] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let alive = true;
    getStats().then((s) => { if (alive) { setStats(s); setLoading(false); } })
      .catch((e) => { if (alive) { setErr((e && e.message) || "Could not load stats."); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  async function exportPdf() {
    setExporting(true);
    try {
      downloadBlob("karma-connect-leads.pdf", await getLeadsPdf());
    } catch (e) { /* ignore */ }
    setExporting(false);
  }

  const s = stats || {};
  const total = s.total || 0;
  const counts = { new: s.s_new || 0, connected: s.s_connected || 0, replied: s.s_replied || 0, meeting: s.s_meeting || 0, won: s.s_won || 0, lost: s.s_lost || 0 };
  const reachedMeeting = counts.meeting + counts.won;
  const winRate = total ? Math.round((counts.won / total) * 100) : 0;
  const maxCount = Math.max(1, ...Object.values(counts));

  return (
    <div>
      <div className="head"><div className="eyebrow">Overview</div><h2>Dashboard</h2><p>Your pipeline at a glance — counts by stage, conversion, and exports. All from your saved leads.</p></div>

      {loading && <div className="panel" style={{ color: "var(--muted)" }}>Loading…</div>}
      {err && <div className="err">⚠ {err}</div>}

      {!loading && !err && (
        <>
          <div className="scorestrip">
            <Stat label="Total leads" value={total} sub={(s.added_week || 0) + " added this week"} />
            <Stat label="Reached a meeting" value={reachedMeeting} sub={total ? Math.round((reachedMeeting / total) * 100) + "% of leads" : "—"} />
            <Stat label="Win rate" value={winRate + "%"} sub={counts.won + " won · " + counts.lost + " lost"} />
          </div>

          <div className="panel">
            <div className="sect-title">Pipeline by stage</div>
            {total === 0 ? (
              <p style={{ color: "var(--muted)", fontSize: 13 }}>No leads yet. Analyze a prospect and it'll show up here.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {LEAD_STATUSES.map((st) => {
                  const c = counts[st.v] || 0;
                  return (
                    <div key={st.v} onClick={() => onGoStage && onGoStage(st.v)} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }} title={"View " + st.label + " leads"}>
                      <span style={{ width: 78, fontSize: 12.5, color: "var(--muted)" }}>{st.label}</span>
                      <div style={{ flex: 1, height: 14, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                        <div style={{ width: Math.round((c / maxCount) * 100) + "%", height: "100%", background: st.color, opacity: 0.85 }} />
                      </div>
                      <span style={{ width: 32, textAlign: "right", fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{c}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="hint" style={{ marginTop: 10 }}>Click a stage to see those leads in History.</div>
          </div>

          <div className="panel">
            <div className="sect-title">Export</div>
            <p style={{ color: "var(--muted)", fontSize: 13.5, marginBottom: 12 }}>Download a branded PDF of all your leads (name, title/company, stage, dates) with a stage summary.</p>
            <div className="toprow">
              <button className="btn primary" onClick={exportPdf} disabled={exporting}>{exporting ? "Preparing…" : "Export PDF"}</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
