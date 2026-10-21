// The LinkedIn agent dashboard — the LinkedIn side of the calls dashboard the team uses for its
// sales reps: tiles for the whole team, one row per LinkedIn account (whose it is, online or not,
// what it sent and got back), invitations day by day and hour by hour. An admin sees every rep;
// anyone else sees their own accounts (GET /api/outreach/agent/dashboard).
import { useState, useEffect } from "react";
import { agentDashboard } from "../lib/outreach.js";

const GREEN = "#52d39e", AMBER = "#E7B74B", RED = "#e24a4a", GREY = "#8a93a6";
const C_INV = "#7c5cff", C_ACC = "#52d39e", C_MSG = "#4fb3ff";
const RANGES = [["today", "Today"], ["yesterday", "Yesterday"], ["week", "7 days"], ["month", "30 days"]];
const STATE = {
  working: { tone: GREEN, label: "Working" }, online: { tone: GREEN, label: "Online" },
  test: { tone: AMBER, label: "Test mode" }, paused: { tone: GREY, label: "Paused" },
  offline: { tone: GREY, label: "PC off" }, stopped: { tone: RED, label: "Stopped" },
};
const pct = (r) => (r == null ? "—" : Math.round(r * 100) + "%");
const n = (v) => (v == null ? 0 : v).toLocaleString();
function ago(t) {
  if (!t) return "never";
  const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
}
const dayLabel = (d) => new Date(d + "T12:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

function Tile({ label, value, sub, tone, meter }) {
  return (
    <div className="dash-tile" style={{ flexDirection: "column", alignItems: "stretch", gap: 0 }}>
      <div className="tl">{label}</div>
      <div className="tv" style={{ color: tone || undefined }}>{value}</div>
      <div className="ts">{sub}</div>
      {meter != null && (
        <div className="bar" style={{ marginTop: 10 }}><i style={{ width: Math.max(0, Math.min(100, Math.round(meter * 100))) + "%" }} /></div>
      )}
    </div>
  );
}

// Invitations, accepts and first messages per day: grouped bars, hand-drawn SVG.
function Daily({ days }) {
  const W = 640, H = 200, P = { l: 30, r: 8, t: 10, b: 26 };
  const max = Math.max(4, ...days.map((d) => Math.max(d.invited, d.accepted, d.messages)));
  const step = Math.ceil(max / 4), top = step * 4;
  const cw = (W - P.l - P.r) / Math.max(1, days.length), bw = Math.min(14, (cw - 6) / 3);
  const y = (v) => P.t + (H - P.t - P.b) * (1 - v / top);
  const every = Math.ceil(days.length / 10);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Invitations, accepted and messages per day">
      {[0, 1, 2, 3, 4].map((i) => (
        <g key={i}>
          <line x1={P.l} x2={W - P.r} y1={y(i * step)} y2={y(i * step)} stroke="rgba(255,255,255,.07)" />
          <text x={P.l - 6} y={y(i * step) + 3} fontSize="10" fill="var(--faint)" textAnchor="end">{i * step}</text>
        </g>
      ))}
      {days.map((d, i) => {
        const x0 = P.l + i * cw + (cw - bw * 3) / 2;
        return (
          <g key={d.day}>
            {[[d.invited, C_INV, "invited"], [d.accepted, C_ACC, "accepted"], [d.messages, C_MSG, "messages"]].map(([v, c, k], j) => (
              <rect key={k} x={x0 + j * bw} y={y(v)} width={bw - 1} height={Math.max(0, y(0) - y(v))} rx="2" fill={c}>
                <title>{dayLabel(d.day)} · {v} {k}</title>
              </rect>
            ))}
            {i % every === 0 && <text x={P.l + i * cw + cw / 2} y={H - 8} fontSize="10" fill="var(--faint)" textAnchor="middle">
              {days.length === 1 ? dayLabel(d.day) : new Date(d.day + "T12:00:00").toLocaleDateString([], { month: "short", day: "numeric" })}</text>}
          </g>
        );
      })}
    </svg>
  );
}

// Invitations by hour of the day (the viewer's clock).
function Hourly({ hours }) {
  const W = 400, H = 190, P = { l: 26, r: 6, t: 10, b: 22 };
  const max = Math.max(3, ...hours), step = Math.ceil(max / 3), top = step * 3;
  const cw = (W - P.l - P.r) / 24;
  const y = (v) => P.t + (H - P.t - P.b) * (1 - v / top);
  const lab = (h) => (h === 0 ? "12a" : h < 12 ? h + "a" : h === 12 ? "12p" : h - 12 + "p");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Invitations by hour">
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <line x1={P.l} x2={W - P.r} y1={y(i * step)} y2={y(i * step)} stroke="rgba(255,255,255,.07)" />
          <text x={P.l - 6} y={y(i * step) + 3} fontSize="10" fill="var(--faint)" textAnchor="end">{i * step}</text>
        </g>
      ))}
      {hours.map((v, h) => (
        <g key={h}>
          <rect x={P.l + h * cw + 2} y={y(v)} width={cw - 4} height={Math.max(0, y(0) - y(v))} rx="2" fill={C_INV} opacity={v ? 1 : 0}>
            <title>{lab(h)} · {v} invitations</title>
          </rect>
          {h % 3 === 0 && <text x={P.l + h * cw + cw / 2} y={H - 6} fontSize="10" fill="var(--faint)" textAnchor="middle">{lab(h)}</text>}
        </g>
      ))}
    </svg>
  );
}

const Legend = () => (
  <div style={{ display: "flex", gap: 14, fontSize: 12, color: "var(--muted)" }}>
    {[[C_INV, "Invited"], [C_ACC, "Accepted"], [C_MSG, "Messages"]].map(([c, l]) => (
      <span key={l} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><i style={{ width: 9, height: 9, borderRadius: 3, background: c, display: "inline-block" }} />{l}</span>
    ))}
  </div>
);

// One row per LinkedIn account, like the per-rep rows of the calls dashboard.
function Accounts({ list, team, table }) {
  const max = Math.max(1, ...list.map((a) => a.invited));
  if (!list.length) return <div className="lia-muted" style={{ fontSize: 13 }}>No LinkedIn accounts yet. Add one on the LinkedIn agent page.</div>;
  if (table) return (
    <div style={{ overflowX: "auto" }}>
      <table className="agd-tbl">
        <thead><tr>{[team ? "Rep" : null, "Account", "Status", "Found", "Invited", "Accepted", "Accept rate", "Messages", "Replies", "Incoming", "Waiting", "Today", "This week", "Last seen"].filter(Boolean).map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{list.map((a) => (
          <tr key={a.id}>
            {team && <td>{a.rep}</td>}
            <td>{a.label}{a.linkedinName ? " · " + a.linkedinName : ""}</td>
            <td>{(STATE[a.state] || STATE.offline).label}</td>
            <td>{a.found}</td><td>{a.invited}</td><td>{a.accepted}</td><td>{pct(a.acceptRate)}</td>
            <td>{a.messages}</td><td>{a.replies}</td><td>{a.incoming}</td><td>{a.waiting}</td>
            <td>{a.today ? a.today.sent + " / " + a.today.target : "—"}</td>
            <td>{a.today ? a.today.week + " / " + a.today.weekTarget : "—"}</td>
            <td>{ago(a.lastSeenAt)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
  return (
    <div className="agd-rows">
      <div className="agd-row agd-rowh"><span>Account</span><span>Invitations</span><span>Invited</span><span>Accepted</span><span>Rate</span><span>Msgs</span><span>Week</span></div>
      {list.map((a) => {
        const st = STATE[a.state] || STATE.offline;
        const why = a.state === "stopped" ? a.haltReason : a.state === "test" ? "Test mode is on: it sends nothing"
          : a.state === "offline" ? "PC last seen " + ago(a.lastSeenAt) : !a.findProspects ? "Find prospects is off" : a.activity;
        return (
          <div key={a.id} className={"agd-row" + (a.invited || a.accepted || a.messages ? "" : " idle")}>
            <span className="agd-who">
              <span className="lia-dot" style={{ background: st.tone }} title={st.label} />
              <span style={{ minWidth: 0 }}>
                <b>{team ? a.rep : a.label}</b>
                <em>{team ? a.label : a.linkedinName || ""}{a.needReply ? " · " + a.needReply + " to reply" : ""}</em>
                {why && <small title={why}>{st.label} · {why}</small>}
              </span>
            </span>
            <span className="agd-track" title={a.today ? `Today ${a.today.sent} of ${a.today.target}` : ""}>
              <i style={{ width: (a.invited / max) * 100 + "%", background: C_INV }} />
              <i style={{ width: (a.accepted / max) * 100 + "%", background: C_ACC }} />
            </span>
            <span className="num">{n(a.invited)}</span>
            <span className="num">{n(a.accepted)}</span>
            <span className="num">{pct(a.acceptRate)}</span>
            <span className="num">{n(a.messages)}</span>
            <span className="num" title="Invitations this week, of this week's target">{a.today ? a.today.week + "/" + a.today.weekTarget : "—"}</span>
          </div>
        );
      })}
    </div>
  );
}

export function AgentDashboardView({ onOpenAgent }) {
  const [range, setRange] = useState(() => { try { return localStorage.getItem("kc.agd.range") || "today"; } catch (e) { return "today"; } });
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [table, setTable] = useState(false);
  const [live, setLive] = useState(true);

  function load(r = range) {
    return agentDashboard(r).then((x) => { setD(x); setErr(""); }).catch((e) => setErr((e && e.message) || "Could not load the dashboard."));
  }
  useEffect(() => {
    try { localStorage.setItem("kc.agd.range", range); } catch (e) {}
    setD(null); load(range);
  }, [range]);
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => load(range), 60000);
    return () => clearInterval(t);
  }, [live, range]);

  const k = (d && d.kpi) || {};
  const list = (d && d.accounts) || [];
  const rangeName = (RANGES.find((r) => r[0] === range) || RANGES[0])[1].toLowerCase();

  return (
    <div className="agd">
      <div className="head">
        <div className="eyebrow">LinkedIn · agent</div>
        <h2>LinkedIn dashboard</h2>
        <p>{d && d.team ? "Every rep's LinkedIn accounts" : "Your LinkedIn accounts"}: what the agent found, invited, got accepted and sent{d && d.updatedAt ? " · updated " + new Date(d.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}.</p>
      </div>

      <div className="toprow" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div className="seg" role="group" aria-label="Range">
          {RANGES.map(([id, l]) => <button key={id} className={range === id ? "on" : ""} onClick={() => setRange(id)}>{l}</button>)}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label className="lia-muted" style={{ fontSize: 12.5, display: "inline-flex", gap: 6, whiteSpace: "nowrap", alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Auto-refresh
          </label>
          <button className="btn ghost sm" onClick={() => load()}>Refresh</button>
          {onOpenAgent && <button className="btn ghost sm" onClick={onOpenAgent}>Open the agent</button>}
        </div>
      </div>

      {err && <div className="err">⚠ {err}</div>}
      {!d && !err && <div className="panel" style={{ color: "var(--muted)" }}>Loading…</div>}

      {d && (
        <>
          <div className="agd-tiles">
            <Tile label="Accounts" value={`${k.online || 0}/${k.accounts || 0}`} sub={`online · ${k.working || 0} working right now`} tone={k.online ? GREEN : undefined} meter={k.accounts ? (k.online || 0) / k.accounts : null} />
            <Tile label="Found" value={n(k.found)} sub={`new prospects ${rangeName}`} />
            <Tile label="Invited" value={n(k.invited)} sub={`this week ${n(k.weekSent)} of ${n(k.weekTarget)}`} tone={C_INV} meter={k.weekTarget ? k.weekSent / k.weekTarget : null} />
            <Tile label="Accepted" value={n(k.accepted)} sub={`${pct(k.acceptRate)} of invitations sent ${rangeName} · ${n(k.waiting)} still waiting`} tone={C_ACC} meter={k.acceptRate} />
            <Tile label="Messages" value={n(k.messages + k.replies)} sub={`${n(k.messages)} first messages · ${n(k.replies)} replies · ${n(k.researched)} researched`} tone={C_MSG} />
            <Tile label="Incoming" value={n(k.incoming)} sub={k.needReply ? `${n(k.needReply)} need a reply` : "conversations with new messages"} tone={k.needReply ? AMBER : undefined} />
          </div>

          <div className="panel" style={{ marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 10, flexWrap: "wrap" }}>
              <div className="sect-title" style={{ margin: 0 }}>{d.team ? "Reps and accounts" : "Accounts"} · {rangeName}</div>
              <div className="seg" role="group" aria-label="View">
                <button className={table ? "" : "on"} onClick={() => setTable(false)}>Chart</button>
                <button className={table ? "on" : ""} onClick={() => setTable(true)}>Table</button>
              </div>
            </div>
            <Accounts list={list} team={d.team} table={table} />
            {k.problems > 0 && <p className="lia-muted" style={{ fontSize: 12.5, margin: "12px 0 0", color: RED }}>{k.problems} problem{k.problems === 1 ? "" : "s"} {rangeName} — see the log on the LinkedIn agent page.</p>}
          </div>

          <div className="agd-grid">
            <div className="panel">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 10, flexWrap: "wrap" }}>
                <div className="sect-title" style={{ margin: 0 }}>{d.daily.length > 1 ? "Day by day" : "Today so far"}</div>
                <Legend />
              </div>
              <Daily days={d.daily} />
            </div>
            <div className="panel">
              <div className="sect-title">Invitations by hour</div>
              <Hourly hours={d.hourly} />
              <p className="lia-muted" style={{ fontSize: 12, margin: "8px 0 0" }}>Your clock. The agent only works inside each account's hours.</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
