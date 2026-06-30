// Admin-only Team Activity: a windowed leaderboard (leads added, meetings, wins, AI cost)
// plus a live cross-member feed of recent actions. Deterministic — no AI tokens used.
import { useState, useEffect } from "react";
import { fetchTeamActivity } from "../lib/admin.js";

const usd = (n) => "$" + (Number(n) || 0).toFixed(2);
const fullName = (r) => [r.first_name, r.last_name].filter(Boolean).join(" ") || r.email || "Someone";
const initial = (r) => ((r.first_name || r.email || "?")[0] || "?").toUpperCase();

function relTime(iso) {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60); if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24); if (d < 7) return d + "d ago";
  return new Date(iso).toLocaleDateString();
}

const STAGE_LABEL = { new: "New", connected: "Connected", replied: "Replied", meeting: "Meeting", won: "Won", lost: "Lost" };

// Map an activity row to an emoji + a human sentence (the actor's name is shown separately).
function describe(a) {
  const who = fullName(a);
  const lead = a.label || "a lead";
  switch (a.kind) {
    case "lead_added": return { ic: "➕", text: <><b>{who}</b> added <b>{lead}</b></> };
    case "stage_changed": {
      const st = STAGE_LABEL[a.detail] || a.detail || "a stage";
      const ic = a.detail === "won" ? "🏆" : a.detail === "meeting" ? "📅" : a.detail === "lost" ? "✖️" : "↗️";
      return { ic, text: <><b>{who}</b> moved <b>{lead}</b> to <b>{st}</b></> };
    }
    case "approval_requested": return { ic: "🔓", text: <><b>{who}</b> requested approval for <b>{lead}</b></> };
    case "approval_decided": return { ic: a.detail === "approved" ? "✅" : "⛔", text: <><b>{lead}</b> ({who}) was <b>{a.detail === "approved" ? "approved" : "not approved"}</b></> };
    default: return { ic: "•", text: <><b>{who}</b> · {a.kind}</> };
  }
}

const RANGES = [{ d: 7, label: "7 days" }, { d: 30, label: "30 days" }, { d: 90, label: "90 days" }];

export function TeamActivityView() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState({ feed: [], leaderboard: [] });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  function load(d = days) {
    setLoading(true); setErr("");
    return fetchTeamActivity(d).then((res) => { setData(res); setLoading(false); })
      .catch((e) => { setErr((e && e.message) || "Could not load team activity."); setLoading(false); });
  }
  // Reload whenever the time window changes (and on first mount).
  useEffect(() => {
    let active = true;
    setLoading(true); setErr("");
    fetchTeamActivity(days)
      .then((res) => { if (active) { setData(res); setLoading(false); } })
      .catch((e) => { if (active) { setErr((e && e.message) || "Could not load team activity."); setLoading(false); } });
    return () => { active = false; };
  }, [days]);

  const board = data.leaderboard || [];
  const feed = data.feed || [];
  const max = Math.max(1, ...board.map((r) => r.added + r.meetings + r.wins));

  return (
    <div>
      <div className="head"><div className="eyebrow">Admin</div><h2>Team activity</h2><p>Who's doing what across the team — leads added, meetings booked, wins, and a live feed. Pick a time window.</p></div>

      <div className="toprow" style={{ justifyContent: "space-between" }}>
        <div className="seg">
          {RANGES.map((r) => <button key={r.d} className={days === r.d ? "on" : ""} onClick={() => setDays(r.d)}>{r.label}</button>)}
        </div>
        <button className="btn ghost sm" onClick={() => load()}>Refresh</button>
      </div>

      {err && <div className="err">⚠ {err}</div>}
      {loading && <div className="panel" style={{ color: "var(--muted)" }}>Loading team activity…</div>}

      {!loading && !err && (
        <>
          <div className="panel">
            <div className="sect-title">Leaderboard · last {days} days</div>
            {board.length === 0 && <div style={{ color: "var(--muted)", fontSize: 13 }}>No members yet.</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {board.map((r, i) => (
                <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ width: 20, textAlign: "center", fontWeight: 800, color: i === 0 ? "#E7B74B" : "var(--faint)", fontFamily: "'Lora',serif" }}>{i + 1}</span>
                  <span className="av" style={{ width: 30, height: 30, borderRadius: 8, background: "var(--grad)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 12, color: "#fff", fontFamily: "'Lora',serif", flex: "0 0 auto" }}>{initial(r)}</span>
                  <div style={{ minWidth: 120, flex: "1 1 140px" }}>
                    <div className="pn" style={{ fontSize: 13.5, fontWeight: 700 }}>{fullName(r)}</div>
                    <div className="bar" style={{ marginTop: 5 }}><i style={{ width: Math.round(((r.added + r.meetings + r.wins) / max) * 100) + "%" }} /></div>
                  </div>
                  <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, color: "var(--muted)", justifyContent: "flex-end", flex: "1 1 auto" }}>
                    <span title="Leads added"><b style={{ color: "var(--text)" }}>{r.added}</b> added</span>
                    <span title="Moved to Meeting"><b style={{ color: "var(--text)" }}>{r.meetings}</b> meetings</span>
                    <span title="Moved to Won"><b style={{ color: "var(--text)" }}>{r.wins}</b> wins</span>
                    <span title="AI calls · cost"><b style={{ color: "var(--text)" }}>{r.calls}</b> calls · {usd(r.cost_usd)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel" style={{ marginTop: 16 }}>
            <div className="sect-title">Recent activity</div>
            {feed.length === 0 && <div style={{ color: "var(--muted)", fontSize: 13 }}>No activity recorded yet. Actions show up here as the team works.</div>}
            <div style={{ display: "flex", flexDirection: "column" }}>
              {feed.map((a) => {
                const d = describe(a);
                return (
                  <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 11, padding: "9px 0", borderBottom: "1px solid var(--border)" }}>
                    <span style={{ fontSize: 16, width: 22, textAlign: "center", flex: "0 0 auto" }}>{d.ic}</span>
                    <span style={{ fontSize: 13.5, color: "var(--text)", flex: "1 1 auto", lineHeight: 1.45 }}>{d.text}</span>
                    <span style={{ fontSize: 11.5, color: "var(--faint)", flex: "0 0 auto", whiteSpace: "nowrap" }}>{relTime(a.created_at)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
