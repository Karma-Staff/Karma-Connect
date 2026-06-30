// Pipeline dashboard: metric tiles + stage funnel + PDF export. Deterministic — no AI tokens.
import { useState, useEffect } from "react";
import { getStats, getLeadsPdf } from "../lib/leads.js";
import { LEAD_STATUSES } from "./HistoryView.jsx";

// One metric tile. With `ring` (0-100) it shows a conic progress ring; otherwise a big number
// with a colored accent stripe — matching the app's glass cards.
function Tile({ label, value, sub, ring, color }) {
  return (
    <div className="dash-tile">
      {ring != null
        ? <div className="progring" style={{ "--p": ring, "--c": color }}><span>{value}</span></div>
        : <span className="dash-accent" style={{ background: color }} />}
      <div style={{ minWidth: 0 }}>
        <div className="tl">{label}</div>
        {ring == null && <div className="tv">{value}</div>}
        <div className="ts">{sub}</div>
      </div>
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
    try { downloadBlob("karma-connect-leads.pdf", await getLeadsPdf()); } catch (e) { /* ignore */ }
    setExporting(false);
  }

  const s = stats || {};
  const total = s.total || 0;
  const counts = { new: s.s_new || 0, connected: s.s_connected || 0, replied: s.s_replied || 0, meeting: s.s_meeting || 0, won: s.s_won || 0, lost: s.s_lost || 0 };
  const open = counts.new + counts.connected + counts.replied + counts.meeting;
  const reachedMeeting = counts.meeting + counts.won;
  const meetPct = total ? Math.round((reachedMeeting / total) * 100) : 0;
  const winRate = total ? Math.round((counts.won / total) * 100) : 0;

  return (
    <div className="dash">
      <div className="head"><div className="eyebrow">Overview</div><h2>Dashboard</h2><p>Your pipeline at a glance — counts by stage, conversion, and a PDF export. All from your saved leads.</p></div>

      {loading && <div className="panel" style={{ color: "var(--muted)" }}>Loading…</div>}
      {err && <div className="err">{err}</div>}

      {!loading && !err && (
        <>
          <div className="dash-stats">
            <Tile label="Total leads" value={total} sub={(s.added_week || 0) + " added this week"} color="var(--ai)" />
            <Tile label="In pipeline" value={open} sub="active, not closed" color="var(--steel)" />
            <Tile label="Reached meeting" ring={meetPct} value={meetPct + "%"} sub={reachedMeeting + " of " + total + " leads"} color="#E7B74B" />
            <Tile label="Win rate" ring={winRate} value={winRate + "%"} sub={counts.won + " won · " + counts.lost + " lost"} color="#52d39e" />
          </div>

          <div className="panel">
            <div className="sect-title">Pipeline by stage</div>
            {total === 0 ? (
              <p style={{ color: "var(--muted)", fontSize: 13 }}>No leads yet. Run AI Analysis on a prospect and it'll show up here.</p>
            ) : (
              <div className="funnel">
                {LEAD_STATUSES.map((st) => {
                  const c = counts[st.v] || 0;
                  const pct = total ? Math.round((c / total) * 100) : 0;
                  return (
                    <button type="button" className="funnel-row" key={st.v} onClick={() => onGoStage && onGoStage(st.v)} title={"View " + st.label + " leads"} aria-label={"View " + st.label + " leads (" + c + ", " + pct + "%)"}>
                      <span className="fdot" style={{ background: st.color, boxShadow: "0 0 8px " + st.color }} />
                      <span className="fl">{st.label}</span>
                      <span className="fc">{c}<small>{pct}%</small></span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="hint" style={{ marginTop: 14 }}>Click a stage to open those leads in History.</div>
          </div>

          <div className="panel" style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 260px", minWidth: 0 }}>
              <div className="sect-title" style={{ marginBottom: 8 }}>Export</div>
              <p style={{ color: "var(--muted)", fontSize: 13.5, margin: 0, lineHeight: 1.6 }}>Download a branded PDF of all your leads — name, title/company, stage and dates, with a stage summary.</p>
            </div>
            <button className="btn primary" onClick={exportPdf} disabled={exporting}>{exporting ? "Preparing…" : "Export PDF"}</button>
          </div>
        </>
      )}
    </div>
  );
}
