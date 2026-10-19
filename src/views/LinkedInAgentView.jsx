// The LinkedIn agent, run from Karma Connect. The agent itself is a small worker on a PC that
// holds the signed-in LinkedIn session; this page is its whole control panel: which PC and
// LinkedIn account it's using, start/pause, dry run, "check now", signing in to LinkedIn, the
// limits and hours, connecting or disconnecting PCs, and the activity log. The worker checks in
// about every 15 seconds and picks up whatever is set here.
import { useState, useEffect, useRef } from "react";
import { agentStatus, setAgentEnabled, saveAgentSettings, agentCommand, agentPairCode, revokeAgentDevice,
  agentEvents, downloadAgent } from "../lib/outreach.js";

const ONLINE_SEC = 90; // a worker that hasn't checked in for this long is treated as offline

function ago(t) {
  if (!t) return "never";
  const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
}
const clock = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const hourLabel = (h) => (h === 0 || h === 24 ? "12 am" : h === 12 ? "12 pm" : h < 12 ? h + " am" : h - 12 + " pm");

// One headline state for the agent, from what the server knows about it.
function overall(st) {
  const w = st.worker || {};
  const seen = st.lastSeenAt ? (Date.now() - new Date(st.lastSeenAt).getTime()) / 1000 : Infinity;
  const online = seen < ONLINE_SEC && w.state !== undefined;
  if (!online && !(st.devices || []).length) return { key: "nopc", label: "No PC connected", tone: "var(--faint)", online };
  if (!online) return { key: "offline", label: "PC offline", tone: "#E7B74B", online };
  if (w.state === "signing_in") return { key: "signin", label: "Waiting for LinkedIn sign-in", tone: "#E7B74B", online };
  if (w.state === "signed_out") return { key: "signedout", label: "LinkedIn signed out", tone: "#e24a4a", online };
  if (st.haltReason) return { key: "stopped", label: "Stopped", tone: "#e24a4a", online };
  if (st.enabled) return st.dryRun
    ? { key: "dry", label: "Running · dry run", tone: "#7C5CFF", online }
    : { key: "running", label: "Running", tone: "#52d39e", online };
  return { key: "paused", label: "Paused", tone: "var(--muted)", online };
}

function Pill({ tone, children }) {
  return <span className="chip" style={{ background: "transparent", borderColor: tone + "66", color: tone, fontWeight: 700 }}>{children}</span>;
}

function Fact({ label, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10.5, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--faint)", fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 13.5, color: "var(--text)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis" }}>{children}</div>
    </div>
  );
}

// A panel heading that reads as one: the shared .sect-title is a faint label meant for page sections.
function PanelTitle({ children }) {
  return <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--text)", letterSpacing: ".01em" }}>{children}</h3>;
}

function Tile({ label, value, sub, warn }) {
  return (
    <div className="dash-tile" style={{ minHeight: 84 }}>
      <div style={{ minWidth: 0 }}>
        <div className="tl">{label}</div>
        <div className="tv" style={{ fontSize: 26, color: warn ? "#E7B74B" : undefined }}>{value}</div>
        {sub && <div className="ts">{sub}</div>}
      </div>
    </div>
  );
}

// ── Status and controls ─────────────────────────────────────────────
function StatusPanel({ st, run, busy, onOpenQueue }) {
  const o = overall(st);
  const w = st.worker || {};
  const li = w.linkedin;
  const working = busy !== "";
  const canCommand = o.online && o.key !== "signin";
  return (
    <div className="panel" style={{ marginBottom: 16, borderColor: o.tone + "44" }}>
      <div className="toprow" style={{ margin: 0, flexWrap: "wrap", gap: 10 }}>
        <Pill tone={o.tone}>● {o.label}</Pill>
        <span style={{ color: "var(--muted)", fontSize: 13 }}>
          {o.online ? (w.activity || "Checking in") : st.lastSeenAt ? "Last seen " + ago(st.lastSeenAt) + (w.host ? " on " + w.host : "") : "Connect a PC below to get started."}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {st.enabled
            ? <button className="btn ghost sm" disabled={working} onClick={() => run("toggle", () => setAgentEnabled(false), "Paused. The agent closes its browser")}>{busy === "toggle" ? "…" : "Pause"}</button>
            : <button className="btn primary sm" disabled={working} onClick={() => run("toggle", () => setAgentEnabled(true), st.dryRun ? "Started in dry run: nothing will be sent" : "Started")}>{busy === "toggle" ? "…" : st.haltReason ? "Clear & start" : "Start"}</button>}
        </div>
      </div>

      {st.haltReason && <div className="err" style={{ marginTop: 12 }}>{st.haltReason}{/signed out/i.test(st.haltReason) ? "" : " Check LinkedIn on that PC, then press Clear & start."}</div>}
      {o.key === "offline" && (
        <div className="hint" style={{ marginTop: 12, color: "var(--muted)" }}>
          The PC hasn't checked in for {ago(st.lastSeenAt).replace(" ago", "")}. Is it on and awake? The agent starts with Windows, so turning the PC on is usually enough.
          {" "}Nothing gets sent while it's offline; approved messages wait here.
        </div>
      )}
      {o.key === "signin" && (
        <div className="hint" style={{ marginTop: 12, color: "var(--muted)" }}>
          LinkedIn is open on <b>{w.host || "the PC"}</b>. Sign in there with your LinkedIn email and password (not "Continue with Google"). The window closes by itself when you're in.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14, marginTop: 16 }}>
        <Fact label="LinkedIn account">
          {li ? (li.handle
            ? <a href={"https://www.linkedin.com/in/" + encodeURIComponent(li.handle) + "/"} target="_blank" rel="noopener noreferrer" style={{ color: "var(--ice)" }}>{li.name || li.handle}</a>
            : li.name) : <span style={{ color: "var(--faint)" }}>{o.key === "signedout" ? "Signed out" : "Not known yet"}</span>}
        </Fact>
        <Fact label="PC">{w.host || <span style={{ color: "var(--faint)" }}>—</span>}</Fact>
        <Fact label="Browser">{w.browser ? (w.browser === "msedge" ? "Microsoft Edge" : w.browser === "chrome" ? "Google Chrome" : w.browser) : <span style={{ color: "var(--faint)" }}>—</span>}</Fact>
        <Fact label="Inbox checked">{ago(w.lastInboxAt)}</Fact>
        <Fact label="Accepts checked">{ago(w.lastAcceptAt)}</Fact>
        <Fact label="Agent version">{w.version || <span style={{ color: "var(--faint)" }}>—</span>}</Fact>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
        <div className="seg" role="group" aria-label="Send for real or dry run">
          <button className={st.dryRun ? "" : "on"} disabled={working} onClick={() => st.dryRun && run("dry", () => saveAgentSettings({ dryRun: false }), "Dry run off: the agent sends for real")}>Send for real</button>
          <button className={st.dryRun ? "on" : ""} disabled={working} onClick={() => !st.dryRun && run("dry", () => saveAgentSettings({ dryRun: true }), "Dry run on: it types everything but never presses Send")}>Dry run</button>
        </div>
        <button className="btn ghost sm" disabled={working || !canCommand} title={canCommand ? "" : "The PC needs to be online"}
          onClick={() => run("cmd", () => agentCommand("check_inbox"), "The agent checks the inbox within 15 seconds")}>Check inbox now</button>
        <button className="btn ghost sm" disabled={working || !canCommand} title={canCommand ? "" : "The PC needs to be online"}
          onClick={() => run("cmd", () => agentCommand("check_accepts"), "The agent checks for accepts within 15 seconds")}>Check accepts now</button>
        <button className="btn ghost sm" disabled={working || !canCommand} title={canCommand ? "Opens LinkedIn on the PC so someone there can sign in, or switch account" : "The PC needs to be online"}
          onClick={() => run("cmd", () => agentCommand("linkedin_login"), "LinkedIn opens on " + (w.host || "the PC") + ". Sign in there")}>{li ? "Switch LinkedIn account" : "Sign in to LinkedIn"}</button>
        {st.pendingCommand && <span className="hint" style={{ margin: 0, color: "var(--muted)" }}>Waiting for the PC to pick that up…</span>}
        {(st.needReply > 0 || st.firstMessages > 0) && (
          <button className="btn ai sm" style={{ marginLeft: "auto" }} onClick={onOpenQueue}>
            {[st.needReply ? st.needReply + (st.needReply === 1 ? " reply" : " replies") : "", st.firstMessages ? st.firstMessages + " new connection" + (st.firstMessages === 1 ? "" : "s") : ""].filter(Boolean).join(" · ")} to approve →
          </button>
        )}
      </div>
      {st.dryRun && <div className="hint" style={{ marginTop: 10, color: "var(--muted)" }}>Dry run: the agent opens each profile, presses Connect or Message and types the text, then clears it. Each item it tries counts as one failed attempt (three and it's parked), so press Retry on them in Send Queue afterwards.</div>}
    </div>
  );
}

// ── Today ───────────────────────────────────────────────────────────
function TodayTiles({ st, onOpenQueue }) {
  const c = st.counts || {}, L = st.limits || {};
  return (
    <>
      <div className="sect-title" style={{ marginBottom: 10 }}>Today</div>
      <div className="dash-stats" style={{ marginBottom: 18 }}>
        <Tile label="Messages" value={(c.day ?? 0) + " / " + (L.perDay ?? "?")} sub={(c.hour ?? 0) + " / " + (L.perHour ?? "?") + " this hour · replies included"} warn={c.day >= L.perDay} />
        <Tile label="Invitations" value={(c.invDay ?? 0) + " / " + (L.invitesPerDay ?? "?")} sub={(c.invWeek ?? 0) + " / " + (L.invitesPerWeek ?? "?") + " this week"} warn={c.invDay >= L.invitesPerDay || c.invWeek >= L.invitesPerWeek} />
        <Tile label="Profile copies" value={(c.copies ?? 0) + " / " + (L.copiesPerDay ?? "?")} sub="Copy it with the agent" />
        <div className="dash-tile" style={{ minHeight: 84, cursor: "pointer" }} onClick={onOpenQueue} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpenQueue()}>
          <div style={{ minWidth: 0 }}>
            <div className="tl">In the queue</div>
            <div className="tv" style={{ fontSize: 26 }}>{st.ready ?? 0} <span style={{ fontSize: 13, fontFamily: "inherit", color: "var(--muted)", fontWeight: 600 }}>ready</span></div>
            <div className="ts">{st.waiting ?? 0} waiting for accept{st.inflight ? " · " + st.inflight + " sending" : ""} · Open Send Queue →</div>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Limits and hours ────────────────────────────────────────────────
const FIELDS = [
  ["perDay", "Messages a day", "Replies count too"],
  ["perHour", "Messages an hour", ""],
  ["invitesPerDay", "Invitations a day", ""],
  ["invitesPerWeek", "Invitations a week", "LinkedIn's own limit is about 100"],
  ["minGapSec", "Shortest gap (seconds)", "Between any two actions"],
  ["maxGapSec", "Longest gap (seconds)", "It waits a random time in between"],
  ["inboxEveryMin", "Check inbox every (minutes)", ""],
  ["acceptEveryMin", "Check accepts every (minutes)", ""],
  ["copiesPerDay", "Profile copies a day", ""],
];

function SettingsPanel({ st, run, busy }) {
  const eff = st.limits || {};
  const [form, setForm] = useState(() => ({ ...eff }));
  const [dirty, setDirty] = useState(false);
  // Follow the server until someone starts editing.
  const effKey = JSON.stringify(eff);
  useEffect(() => {
    if (!dirty) setForm(JSON.parse(effKey));
  }, [effKey, dirty]);
  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setDirty(true); };
  const b = st.bounds || {};
  const d = st.defaults || {};

  function save() {
    const out = {};
    for (const [k] of FIELDS) if (form[k] !== "" && form[k] != null) out[k] = Number(form[k]);
    out.windowStart = Number(form.windowStart);
    out.windowEnd = Number(form.windowEnd);
    out.weekdaysOnly = !!form.weekdaysOnly;
    run("settings", () => saveAgentSettings({ settings: out }), "Saved. The agent uses these from its next check-in").then(() => setDirty(false));
  }
  function reset() {
    run("settings", () => saveAgentSettings({ settings: {} }), "Back to the default limits").then(() => setDirty(false));
  }
  const custom = Object.keys(st.settings || {}).length > 0;

  return (
    <div className="panel">
      <div className="toprow" style={{ margin: "0 0 4px", flexWrap: "wrap", gap: 8 }}>
        <PanelTitle>Limits &amp; hours</PanelTitle>
        {custom && <span className="chip idx">Your own settings</span>}
      </div>
      <p className="hint" style={{ color: "var(--muted)", marginTop: 4 }}>Lower is safer for the LinkedIn account. Each value has a ceiling the server won't go past.</p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", margin: "6px 0 14px" }}>
        <label style={{ fontSize: 12.5, color: "var(--muted)" }}>Works from
          <select value={form.windowStart ?? 9} onChange={(e) => set("windowStart", Number(e.target.value))} style={{ display: "block", marginTop: 5, padding: "7px 9px", borderRadius: 9 }}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12.5, color: "var(--muted)" }}>until
          <select value={form.windowEnd ?? 17} onChange={(e) => set("windowEnd", Number(e.target.value))} style={{ display: "block", marginTop: 5, padding: "7px 9px", borderRadius: 9 }}>
            {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </label>
        <div className="seg" role="group" aria-label="Which days">
          <button className={form.weekdaysOnly ? "on" : ""} onClick={() => set("weekdaysOnly", true)}>Weekdays</button>
          <button className={form.weekdaysOnly ? "" : "on"} onClick={() => set("weekdaysOnly", false)}>Every day</button>
        </div>
      </div>
      <div className="hint" style={{ color: "var(--faint)", margin: "-6px 0 12px" }}>Hours are the PC's own time. Copying a profile you asked for works any time.</div>

      <div className="fgrid">
        {FIELDS.map(([k, label, help]) => (
          <label key={k} style={{ fontSize: 12.5, color: "var(--muted)" }}>
            {label}
            <input type="number" min={(b[k] || [])[0]} max={(b[k] || [])[1]} value={form[k] ?? ""} onChange={(e) => set(k, e.target.value)}
              style={{ display: "block", width: "100%", boxSizing: "border-box", marginTop: 5, padding: "8px 10px", borderRadius: 9, fontSize: 13 }} />
            <span style={{ fontSize: 11, color: "var(--faint)" }}>
              {help ? help + " · " : ""}default {d[k]}{b[k] ? " · max " + b[k][1] : ""}
            </span>
          </label>
        ))}
      </div>
      <div className="mact" style={{ marginTop: 14 }}>
        {custom && <button className="iconbtn" disabled={busy !== ""} onClick={reset}>Use defaults</button>}
        <button className="btn primary sm" style={{ marginLeft: "auto" }} disabled={busy !== "" || !dirty} onClick={save}>{busy === "settings" ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
}

// ── PCs ─────────────────────────────────────────────────────────────
function PcsPanel({ st, run, busy, showToast }) {
  const [pair, setPair] = useState(null); // { code, expiresAt }
  const [left, setLeft] = useState(0);
  const [dl, setDl] = useState(false);
  const known = useRef((st.devices || []).length);
  const devices = st.devices || [];

  useEffect(() => {
    if (!pair) return;
    const t = setInterval(() => setLeft(Math.max(0, Math.round((new Date(pair.expiresAt).getTime() - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  }, [pair]);
  // A new PC showed up while a code was on screen: it worked.
  useEffect(() => {
    if (pair && devices.length > known.current) { setPair(null); showToast("PC connected"); }
    known.current = devices.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices.length]);

  async function makeCode() {
    const r = await run("pair", () => agentPairCode());
    if (r && r.code) { setPair(r); setLeft(Math.round((new Date(r.expiresAt).getTime() - Date.now()) / 1000)); }
  }
  const cmd = pair ? "npm run agent -- --pair " + pair.code : "";
  const copy = (t) => { try { navigator.clipboard.writeText(t); showToast("Copied"); } catch (e) {} };
  async function getZip() {
    setDl(true);
    try { await downloadAgent(); showToast("Downloaded. Unzip it and open SETUP.md"); } catch (e) { showToast((e && e.message) || "Download failed"); }
    setDl(false);
  }

  return (
    <div className="panel">
      <PanelTitle>PCs</PanelTitle>
      <p className="hint" style={{ color: "var(--muted)", marginTop: 4 }}>The PC that holds the LinkedIn sign-in. It starts the agent with Windows and needs to be on for anything to send.</p>

      {devices.length === 0 && !pair && <div className="hint" style={{ color: "var(--faint)" }}>No PC connected yet.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "8px 0 12px" }}>
        {devices.map((d) => {
          const live = st.worker && st.worker.device && st.worker.device.id === d.id && (Date.now() - new Date(st.lastSeenAt).getTime()) / 1000 < ONLINE_SEC;
          return (
            <div key={d.id} className="mcard" style={{ padding: "10px 12px", flexDirection: "row", alignItems: "center", gap: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: 8, background: live ? "#52d39e" : "var(--faint)", flex: "0 0 8px" }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--text)" }}>{d.name || "PC"}</div>
                <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{live ? "Online" : "Last seen " + ago(d.last_used_at)} · connected {ago(d.paired_at)}</div>
              </div>
              <button className="iconbtn" style={{ marginLeft: "auto" }} disabled={busy !== ""}
                onClick={() => run("revoke", () => revokeAgentDevice(d.id), (d.name || "PC") + " disconnected. Its key no longer works")}>Disconnect</button>
            </div>
          );
        })}
      </div>

      {pair ? (
        <div className="mcard" style={{ gap: 10, borderColor: "rgba(124,92,255,.45)" }}>
          <div style={{ fontSize: 12.5, color: "var(--muted)" }}>On the PC, in the Karma Connect folder, run:</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <code style={{ fontSize: 14, padding: "8px 11px", borderRadius: 9, background: "rgba(0,0,0,.35)", color: "var(--text)", userSelect: "all", wordBreak: "break-all" }}>{cmd}</code>
            <button className="btn ghost sm" onClick={() => copy(cmd)}>Copy</button>
          </div>
          <div style={{ fontSize: 12, color: "var(--faint)" }}>
            Code <b style={{ color: "var(--text)", letterSpacing: ".08em" }}>{pair.code}</b> · {left > 0 ? "works for " + Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") : "expired"}.
            {" "}From the downloaded zip it's <code>npm run pair -- {pair.code}</code>. It starts in the background and with Windows from then on.
          </div>
          <div className="mact">
            {left <= 0 && <button className="btn primary sm" onClick={makeCode}>New code</button>}
            <button className="iconbtn" style={{ marginLeft: "auto" }} onClick={() => setPair(null)}>Close</button>
          </div>
        </div>
      ) : (
        <div className="mact">
          <button className="btn ghost sm" disabled={dl} onClick={getZip} title="For a PC without the Karma Connect folder">{dl ? "…" : "Download agent"}</button>
          <button className="btn primary sm" style={{ marginLeft: "auto" }} disabled={busy !== ""} onClick={makeCode}>{busy === "pair" ? "…" : devices.length ? "Connect another PC" : "Connect a PC"}</button>
        </div>
      )}
    </div>
  );
}

// ── Activity log ────────────────────────────────────────────────────
const LEVEL_TONE = { success: "#52d39e", warn: "#E7B74B", error: "#e24a4a", info: "var(--faint)" };
function ActivityLog({ events }) {
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, 25);
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="toprow" style={{ margin: "0 0 10px" }}>
        <PanelTitle>Activity</PanelTitle>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--faint)" }}>Updates by itself</span>
      </div>
      {events.length === 0 && <div className="hint" style={{ color: "var(--faint)" }}>Nothing yet. Every step the agent takes shows up here.</div>}
      <div style={{ display: "flex", flexDirection: "column" }}>
        {shown.map((e) => (
          <div key={e.id} style={{ display: "flex", gap: 12, padding: "7px 0", borderTop: "1px solid var(--border)", fontSize: 13, alignItems: "baseline" }}>
            <span style={{ flex: "0 0 128px", color: "var(--faint)", fontSize: 11.5, fontVariantNumeric: "tabular-nums" }}>{clock(e.at)}</span>
            <span style={{ width: 7, height: 7, borderRadius: 7, background: LEVEL_TONE[e.level] || LEVEL_TONE.info, flex: "0 0 7px", transform: "translateY(-1px)" }} />
            <span style={{ color: e.level === "error" ? "#ffb3b3" : "var(--text)", minWidth: 0, wordBreak: "break-word" }}>{e.text}</span>
          </div>
        ))}
      </div>
      {events.length > 25 && <button className="iconbtn" style={{ marginTop: 8 }} onClick={() => setAll(!all)}>{all ? "Show less" : "Show all " + events.length}</button>}
    </div>
  );
}

export function LinkedInAgentView({ showToast, onOpenQueue }) {
  const [st, setSt] = useState(null);
  const [events, setEvents] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");

  function load() {
    agentStatus().then((s) => { setSt(s); setErr(""); }).catch((e) => setErr((e && e.message) || "Could not load the agent."));
    agentEvents().then(setEvents).catch(() => {});
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  // Every control goes through here: one action at a time, the fresh status on success.
  async function run(key, fn, ok) {
    setBusy(key); setErr("");
    let r = null;
    try {
      r = await fn();
      if (r && r.status) setSt(r.status);
      else if (r && r.limits) setSt(r);
      if (ok) showToast(ok);
      load();
    } catch (e) { setErr((e && e.message) || "Something went wrong."); }
    setBusy("");
    return r;
  }

  return (
    <div>
      <div className="head">
        <div className="eyebrow">Outreach</div>
        <h2>LinkedIn agent</h2>
        <p>The agent works on a PC that's signed in to LinkedIn and does only what you approved: connection requests, messages, replies. Control everything from here. What it sends, you approve in the Send Queue.</p>
      </div>
      {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}
      {!st && !err && <div className="panel" style={{ color: "var(--muted)" }}>Loading…</div>}
      {st && (
        <>
          <StatusPanel st={st} run={run} busy={busy} onOpenQueue={onOpenQueue} />
          <TodayTiles st={st} onOpenQueue={onOpenQueue} />
          <div className="grid2" style={{ alignItems: "start" }}>
            <SettingsPanel st={st} run={run} busy={busy} />
            <PcsPanel st={st} run={run} busy={busy} showToast={showToast} />
          </div>
          <ActivityLog events={events} />
        </>
      )}
    </div>
  );
}
