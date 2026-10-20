// "Today" on the LinkedIn agent page: what the agent is doing right now, and everything it has
// done since midnight (GET /api/outreach/agent/today) — people found, invitations sent and
// accepted, connections researched, messages and replies sent, messages that came in, searches,
// problems. Each number opens the names behind it.
import { useState, useEffect, useRef } from "react";
import { agentToday } from "../lib/outreach.js";

const GREEN = "#52d39e", AMBER = "#E7B74B", RED = "#e24a4a";
const time = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
function ago(t) {
  if (!t) return "never";
  const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  return Math.round(s / 3600) + " h ago";
}

// The tiles, in the order the work happens.
const KINDS = [
  { k: "found", label: "Found", sub: (d) => "new prospects · " + d.searches + " search" + (d.searches === 1 ? "" : "es"), empty: "Nobody found yet today." },
  { k: "invited", label: "Invited", sub: (d, L) => "invitations sent" + (L.invitesPerDay ? " · limit " + L.invitesPerDay : ""), empty: "No invitations sent yet today." },
  { k: "accepted", label: "Accepted", sub: () => "new connections", empty: "Nobody has accepted yet today." },
  { k: "researched", label: "Researched", sub: () => "ready for you to approve", empty: "Nobody researched yet today. It happens a few minutes after someone accepts." },
  { k: "messages", label: "Messages", sub: (d, L) => "first messages sent" + (L.perDay ? " · limit " + L.perDay : ""), empty: "No messages sent yet today." },
  { k: "replies", label: "Replies", sub: () => "replies sent", empty: "No replies sent yet today." },
  { k: "incoming", label: "Incoming", sub: (d) => { const n = d.incoming.filter((x) => x.needs_reply).length; return n ? n + " need a reply" : "new messages"; }, empty: "No new messages today." },
  { k: "problems", label: "Problems", sub: (d) => (d.problems.length ? "need a look" : "all clear"), empty: "Nothing went wrong today." },
];

function Row({ k, x, multi, labels }) {
  const acct = multi && x.account_id && labels[x.account_id];
  if (k === "problems") return (
    <div className="lia-trow">
      <span className="lia-dot" style={{ background: x.level === "error" ? RED : AMBER }} />
      <span className="lia-trow-main" style={{ color: x.level === "error" ? "#ffb3b3" : undefined }}>{x.text}</span>
      <span className="lia-trow-at">{time(x.at)}</span>
    </div>
  );
  const name = x.name || "Someone";
  const what = k === "incoming" ? x.text : [x.title, x.company].filter(Boolean).join(" · ");
  return (
    <div className="lia-trow">
      <span className="lia-trow-main">
        {x.url ? <a href={x.url} target="_blank" rel="noopener noreferrer">{name}</a> : <b>{name}</b>}
        {what && <span className="lia-muted"> — {what}</span>}
        {k === "invited" && x.auto_found && <span className="lia-tag new" style={{ marginLeft: 8 }}>found by the agent</span>}
        {k === "incoming" && <span className={"lia-tag " + (x.outreach ? "out" : "new")} style={{ marginLeft: 8 }}>{x.outreach ? "your outreach" : "new contact"}</span>}
        {k === "researched" && x.state === "drafted" && <span className="lia-tag need" style={{ marginLeft: 8 }}>draft ready</span>}
        {acct && <span className="lia-tag" style={{ marginLeft: 8 }}>{acct}</span>}
      </span>
      <span className="lia-trow-at">{time(x.at)}</span>
    </div>
  );
}

export function AgentToday({ a, o, accounts, onOpenQueue }) {
  const multi = accounts.length > 1;
  const [mine, setMine] = useState(true);
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState("");
  const forId = multi && !mine ? "" : a.id;
  const want = useRef(forId);
  want.current = forId;

  useEffect(() => {
    let alive = true;
    const load = () => agentToday(forId).then((r) => { if (alive && want.current === forId) { setD(r); setErr(""); } })
      .catch((e) => alive && setErr((e && e.message) || "Couldn't load today."));
    load();
    const t = setInterval(load, 20000);
    return () => { alive = false; clearInterval(t); };
  }, [forId]);

  const w = a.worker || {};
  const L = a.limits || {};
  const labels = Object.fromEntries(accounts.map((x) => [x.id, x.label]));
  const now = o.online
    ? (w.activity || (a.enabled ? "Working" : "Paused"))
    : o.say;
  const tone = o.key === "running" ? GREEN : o.tone;
  const total = d ? KINDS.reduce((n, x) => n + (x.k === "problems" ? 0 : d[x.k].length), 0) : 0;

  return (
    <div className="panel lia-today2" style={{ marginTop: 14 }}>
      <div className="toprow" style={{ margin: "0 0 14px", gap: 10 }}>
        <div className="lia-h" style={{ margin: 0 }}>Today</div>
        {multi && (
          <div className="seg" role="group" aria-label="Whose day" style={{ marginLeft: "auto" }}>
            <button className={mine ? "on" : ""} onClick={() => setMine(true)}>{a.label}</button>
            <button className={mine ? "" : "on"} onClick={() => setMine(false)}>All accounts</button>
          </div>
        )}
      </div>

      <div className="lia-now">
        <span className="lia-now-k">Right now</span>
        <span className={"lia-dot" + (o.key === "running" || o.key === "dry" ? " pulse" : "")} style={{ background: tone }} />
        <span className="lia-now-t">{multi && !mine ? a.label + ": " : ""}{now}</span>
        <span className="lia-now-s">{o.online ? "checked in " + ago(a.lastSeenAt) + (w.host ? " · " + w.host : "") : a.lastSeenAt ? "last seen " + ago(a.lastSeenAt) : ""}</span>
      </div>

      {err && <div className="err" style={{ marginTop: 12 }}>{err}</div>}
      {!d && !err && <div className="lia-muted" style={{ fontSize: 13, marginTop: 12 }}>Loading…</div>}
      {d && (
        <>
          <div className="lia-tiles">
            {KINDS.map((x) => {
              const n = d[x.k].length;
              const bad = x.k === "problems" && n > 0;
              return (
                <button key={x.k} className={"lia-tile" + (open === x.k ? " on" : "") + (bad ? " bad" : "")} aria-expanded={open === x.k}
                  onClick={() => setOpen(open === x.k ? "" : x.k)}>
                  <span className="lia-tile-l">{x.label}</span>
                  <span className="lia-tile-v">{n}{n >= 60 ? "+" : ""}</span>
                  <span className="lia-tile-s">{x.sub(d, L)}</span>
                </button>
              );
            })}
          </div>

          {open ? (
            <div className="lia-tlist">
              {d[open].length === 0
                ? <div className="lia-muted" style={{ fontSize: 13 }}>{KINDS.find((x) => x.k === open).empty}</div>
                : d[open].map((x) => <Row key={x.id} k={open} x={x} multi={multi && !mine} labels={labels} />)}
              {open === "researched" && d.researched.length > 0 && (
                <button className="btn primary sm" style={{ marginTop: 10 }} onClick={onOpenQueue}>Approve their first messages in Send Queue →</button>
              )}
            </div>
          ) : (
            <div className="lia-muted" style={{ fontSize: 12.5, marginTop: 12 }}>
              {total ? "Click a number to see who." : "Nothing done yet today."}
              {" "}{a.ready ? a.ready + " ready to send · " : ""}{a.waiting ? a.waiting + " waiting for an accept · " : ""}
              <button className="lia-link" onClick={onOpenQueue}>open Send Queue →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
