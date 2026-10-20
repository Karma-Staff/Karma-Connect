// The LinkedIn agent, run from Karma Connect. The agent itself is a small worker on a PC; it can
// run up to four LinkedIn accounts there, each in its own browser profile. This page is its whole
// control panel: the accounts side by side, and for the one picked, its LinkedIn sign-in,
// start/pause, dry run, "check now", limits and hours, and log. Plus the PCs. The worker checks
// in every few seconds and picks up whatever is set here.
import { useState, useEffect, useRef } from "react";
import { agentStatus, setAgentEnabled, saveAgentSettings, agentCommand, agentPairCode, revokeAgentDevice,
  agentEvents, downloadAgent, addAgentAccount, updateAgentAccount, removeAgentAccount } from "../lib/outreach.js";

const ONLINE_SEC = 90; // a worker that hasn't checked in for this long is treated as offline
const PICK_KEY = "kc.liagent.account";

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
const seenRecently = (t) => !!t && (Date.now() - new Date(t).getTime()) / 1000 < ONLINE_SEC;
const browserName = (b) => (b === "msedge" ? "Microsoft Edge" : b === "chrome" ? "Google Chrome" : b);

// One headline state for an account, from what the server knows about it.
function overall(a, devices) {
  const w = a.worker || {};
  const online = seenRecently(a.lastSeenAt) && w.state !== undefined;
  if (!online && !(devices || []).length) return { key: "nopc", label: "No PC connected", tone: "var(--faint)", online };
  if (!online) return { key: "offline", label: a.lastSeenAt ? "PC offline" : "Waiting for the PC", tone: "#E7B74B", online };
  if (w.state === "signing_in") return { key: "signin", label: "Waiting for sign-in", tone: "#E7B74B", online };
  if (w.state === "signed_out") return { key: "signedout", label: "LinkedIn signed out", tone: "#e24a4a", online };
  if (a.haltReason) return { key: "stopped", label: "Stopped", tone: "#e24a4a", online };
  if (a.enabled) return a.dryRun
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

function LinkedInName({ li, fallback }) {
  if (!li) return <span style={{ color: "var(--faint)" }}>{fallback}</span>;
  if (!li.handle) return <>{li.name}</>;
  return <a href={"https://www.linkedin.com/in/" + encodeURIComponent(li.handle) + "/"} target="_blank" rel="noopener noreferrer" style={{ color: "var(--ice)" }}>{li.name || li.handle}</a>;
}

// ── The accounts, side by side ──────────────────────────────────────
function AccountCard({ a, devices, picked, onPick, run, busy }) {
  const o = overall(a, devices);
  const c = a.counts || {}, L = a.limits || {};
  const li = a.worker && a.worker.linkedin;
  return (
    <div className="mcard" role="button" tabIndex={0} aria-pressed={picked} onClick={onPick} onKeyDown={(e) => e.key === "Enter" && onPick()}
      style={{ gap: 8, cursor: "pointer", borderColor: picked ? "rgba(124,92,255,.65)" : undefined, boxShadow: picked ? "0 0 0 1px rgba(124,92,255,.45) inset" : undefined }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="chip idx" title={"Account " + a.slot}>{a.slot}</span>
        <span style={{ fontWeight: 700, fontSize: 14, color: "var(--text)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.label}</span>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--muted)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {li ? (li.name || li.handle) : o.key === "signedout" ? "Signed out" : "Not signed in yet"}
      </div>
      <div><Pill tone={o.tone}>● {o.label}</Pill></div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>
        {c.day ?? 0}/{L.perDay ?? "?"} messages · {c.invDay ?? 0}/{L.invitesPerDay ?? "?"} invites today
        {a.ready ? " · " + a.ready + " ready" : ""}
      </div>
      {a.sameLinkedInAs && <div className="err" style={{ margin: 0, fontSize: 12 }}>Same LinkedIn as “{a.sameLinkedInAs}”</div>}
      <div className="mact" style={{ marginTop: "auto", paddingTop: 2 }} onClick={(e) => e.stopPropagation()}>
        {a.enabled
          ? <button className="btn ghost sm" disabled={busy !== ""} onClick={() => run("toggle", () => setAgentEnabled(false, a.id), a.label + " paused")}>Pause</button>
          : <button className="btn primary sm" disabled={busy !== ""} onClick={() => run("toggle", () => setAgentEnabled(true, a.id), a.label + (a.dryRun ? " started in dry run" : " started"))}>{a.haltReason ? "Clear & start" : "Start"}</button>}
      </div>
    </div>
  );
}

function AddAccountCard({ count, max, run, busy, onAdded }) {
  return (
    <button className="mcard" disabled={busy !== ""} onClick={async () => {
      const r = await run("add", () => addAgentAccount(""), "Added. Press Sign in to LinkedIn to sign it in on the PC");
      if (r && r.account) onAdded(r.account.id);
    }} style={{ alignItems: "center", justifyContent: "center", gap: 6, borderStyle: "dashed", cursor: "pointer", minHeight: 150, color: "var(--muted)", font: "inherit" }}>
      <span style={{ fontSize: 26, lineHeight: 1, color: "var(--text)" }}>+</span>
      <span style={{ fontWeight: 700, fontSize: 13.5, color: "var(--text)" }}>{busy === "add" ? "Adding…" : "Add a LinkedIn account"}</span>
      <span style={{ fontSize: 12 }}>{count} of {max} in use</span>
    </button>
  );
}

// ── The picked account: status and controls ────────────────────────
function AccountPanel({ a, st, run, busy, onOpenQueue, onRemoved }) {
  const devices = st.devices || [];
  const o = overall(a, devices);
  const w = a.worker || {};
  const li = w.linkedin;
  const working = busy !== "";
  const canCommand = o.online && o.key !== "signin";
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(a.label);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => { setNaming(false); setConfirmRemove(false); setName(a.label); }, [a.id, a.label]);
  const onlyOne = (st.accounts || []).length <= 1;
  const pcName = (id) => (devices.find((d) => d.id === id) || {}).name || "PC";

  return (
    <div className="panel" style={{ marginBottom: 16, borderColor: o.tone + "44" }}>
      <div className="toprow" style={{ margin: 0, flexWrap: "wrap", gap: 10 }}>
        {naming ? (
          <form style={{ display: "flex", gap: 8, alignItems: "center" }} onSubmit={(e) => { e.preventDefault(); run("name", () => updateAgentAccount(a.id, { label: name }), "Renamed").then(() => setNaming(false)); }}>
            <input value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} aria-label="Account name"
              style={{ padding: "7px 10px", borderRadius: 9, fontSize: 14, minWidth: 0, width: 220 }} />
            <button className="btn primary sm" disabled={working || !name.trim()}>Save</button>
            <button type="button" className="iconbtn" onClick={() => { setNaming(false); setName(a.label); }}>Cancel</button>
          </form>
        ) : (
          <>
            <PanelTitle>{a.label}</PanelTitle>
            <button className="iconbtn" onClick={() => setNaming(true)}>Rename</button>
          </>
        )}
        <Pill tone={o.tone}>● {o.label}</Pill>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {a.enabled
            ? <button className="btn ghost sm" disabled={working} onClick={() => run("toggle", () => setAgentEnabled(false, a.id), "Paused. Its browser closes")}>{busy === "toggle" ? "…" : "Pause"}</button>
            : <button className="btn primary sm" disabled={working} onClick={() => run("toggle", () => setAgentEnabled(true, a.id), a.dryRun ? "Started in dry run: nothing will be sent" : "Started")}>{busy === "toggle" ? "…" : a.haltReason ? "Clear & start" : "Start"}</button>}
        </div>
      </div>
      <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 8 }}>
        {o.online ? (w.activity || "Checking in") : a.lastSeenAt ? "Last seen " + ago(a.lastSeenAt) + (w.host ? " on " + w.host : "") : devices.length ? "The PC picks this account up on its next check-in (a few seconds) if it's on." : "Connect a PC below to get started."}
      </div>

      {a.haltReason && <div className="err" style={{ marginTop: 12 }}>{a.haltReason}{/signed out/i.test(a.haltReason) ? "" : " Check LinkedIn for this account on that PC, then press Clear & start."}</div>}
      {a.sameLinkedInAs && <div className="err" style={{ marginTop: 12 }}>This account is signed in to the same LinkedIn as “{a.sameLinkedInAs}”. Neither sends until one of them is signed in to a different LinkedIn: press Sign in to LinkedIn and use the other login.</div>}
      {o.key === "offline" && a.lastSeenAt && (
        <div className="hint" style={{ marginTop: 12, color: "var(--muted)" }}>
          The PC hasn't checked in for {ago(a.lastSeenAt).replace(" ago", "")}. Is it on and awake? The agent starts with Windows, so turning the PC on is usually enough.
          {" "}Nothing gets sent while it's offline; approved messages wait here.
        </div>
      )}
      {o.key === "signin" && (
        <div className="hint" style={{ marginTop: 12, color: "var(--muted)" }}>
          LinkedIn is open on <b>{w.host || "the PC"}</b> for <b>{a.label}</b>. Sign in there with this account's LinkedIn email and password (not "Continue with Google"). The window closes by itself when you're in.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14, marginTop: 16 }}>
        <Fact label="LinkedIn account"><LinkedInName li={li} fallback={o.key === "signedout" ? "Signed out" : "Not signed in yet"} /></Fact>
        <Fact label="PC">
          {devices.length > 1 ? (
            <select value={a.deviceId || ""} disabled={working} aria-label="Which PC runs this account"
              onChange={(e) => run("pc", () => updateAgentAccount(a.id, { deviceId: e.target.value || null }), "Saved. That PC takes it over on its next check-in")}
              style={{ padding: "4px 7px", borderRadius: 8, fontSize: 13, maxWidth: "100%" }}>
              <option value="">Any connected PC</option>
              {devices.map((d) => <option key={d.id} value={d.id}>{d.name || "PC"}</option>)}
            </select>
          ) : (w.host || (a.deviceId ? pcName(a.deviceId) : <span style={{ color: "var(--faint)" }}>—</span>))}
        </Fact>
        <Fact label="Browser">{w.browser ? browserName(w.browser) : <span style={{ color: "var(--faint)" }}>—</span>}</Fact>
        <Fact label="Inbox checked">{ago(w.lastInboxAt)}</Fact>
        <Fact label="Accepts checked">{ago(w.lastAcceptAt)}</Fact>
        <Fact label="Agent version">{w.version || <span style={{ color: "var(--faint)" }}>—</span>}</Fact>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
        <div className="seg" role="group" aria-label="Send for real or dry run">
          <button className={a.dryRun ? "" : "on"} disabled={working} onClick={() => a.dryRun && run("dry", () => saveAgentSettings({ accountId: a.id, dryRun: false }), "Dry run off: this account sends for real")}>Send for real</button>
          <button className={a.dryRun ? "on" : ""} disabled={working} onClick={() => !a.dryRun && run("dry", () => saveAgentSettings({ accountId: a.id, dryRun: true }), "Dry run on: it types everything but never presses Send")}>Dry run</button>
        </div>
        <button className="btn ghost sm" disabled={working || !canCommand} title={canCommand ? "" : "The PC needs to be online"}
          onClick={() => run("cmd", () => agentCommand("check_inbox", a.id), "It checks the inbox within a few seconds")}>Check inbox now</button>
        <button className="btn ghost sm" disabled={working || !canCommand} title={canCommand ? "" : "The PC needs to be online"}
          onClick={() => run("cmd", () => agentCommand("check_accepts", a.id), "It checks for accepts within a few seconds")}>Check accepts now</button>
        <button className={"btn sm " + (li ? "ghost" : "primary")} disabled={working || !canCommand} title={canCommand ? "Opens LinkedIn on the PC for this account, so someone there can sign in, or switch to another LinkedIn" : "The PC needs to be online"}
          onClick={() => run("cmd", () => agentCommand("linkedin_login", a.id), "LinkedIn opens on " + (w.host || "the PC") + ". Sign in there")}>{li ? "Switch LinkedIn account" : "Sign in to LinkedIn"}</button>
        {a.pendingCommand && <span className="hint" style={{ margin: 0, color: "var(--muted)" }}>Waiting for the PC to pick that up…</span>}
        {!canCommand && o.key !== "signin" && (
          <span className="hint" style={{ margin: 0, color: "#E7B74B", flexBasis: "100%" }}>
            {devices.length
              ? "These buttons work once the PC is online: turn it on, or start the agent there (npm run agent)."
              : "Connect a PC first (PCs → Connect a PC). Signing in opens LinkedIn on that PC, so it has to be running."}
          </span>
        )}
        {(a.needReply > 0 || a.firstMessages > 0) && (
          <button className="btn ai sm" style={{ marginLeft: "auto" }} onClick={onOpenQueue}>
            {[a.needReply ? a.needReply + (a.needReply === 1 ? " reply" : " replies") : "", a.firstMessages ? a.firstMessages + " new connection" + (a.firstMessages === 1 ? "" : "s") : ""].filter(Boolean).join(" · ")} to approve →
          </button>
        )}
      </div>
      {a.dryRun && <div className="hint" style={{ marginTop: 10, color: "var(--muted)" }}>Dry run: the agent opens each profile, presses Connect or Message and types the text, then clears it. Each item it tries counts as one failed attempt (three and it's parked), so press Retry on them in Send Queue afterwards.</div>}

      {!onlyOne && (
        <div className="mact" style={{ marginTop: 12 }}>
          {confirmRemove ? (
            <>
              <span style={{ fontSize: 12.5, color: "var(--muted)" }}>Remove “{a.label}”? Its unsent messages and invitations go from the first account instead, unanswered replies are skipped, and the PC deletes its saved LinkedIn sign-in.</span>
              <button className="btn sm" style={{ marginLeft: "auto", background: "#e24a4a", borderColor: "#e24a4a", color: "#fff" }} disabled={working}
                onClick={() => run("remove", () => removeAgentAccount(a.id), a.label + " removed").then((r) => r && onRemoved())}>Remove</button>
              <button className="iconbtn" onClick={() => setConfirmRemove(false)}>Cancel</button>
            </>
          ) : <button className="iconbtn" style={{ marginLeft: "auto" }} onClick={() => setConfirmRemove(true)}>Remove this account</button>}
        </div>
      )}
    </div>
  );
}

// ── Today, for the picked account ───────────────────────────────────
function TodayTiles({ a, onOpenQueue }) {
  const c = a.counts || {}, L = a.limits || {};
  return (
    <>
      <div className="sect-title" style={{ marginBottom: 10 }}>Today · {a.label}</div>
      <div className="dash-stats" style={{ marginBottom: 18 }}>
        <Tile label="Messages" value={(c.day ?? 0) + " / " + (L.perDay ?? "?")} sub={(c.hour ?? 0) + " / " + (L.perHour ?? "?") + " this hour · replies included"} warn={c.day >= L.perDay} />
        <Tile label="Invitations" value={(c.invDay ?? 0) + " / " + (L.invitesPerDay ?? "?")} sub={(c.invWeek ?? 0) + " / " + (L.invitesPerWeek ?? "?") + " this week"} warn={c.invDay >= L.invitesPerDay || c.invWeek >= L.invitesPerWeek} />
        <Tile label="Profile copies" value={(c.copies ?? 0) + " / " + (L.copiesPerDay ?? "?")} sub="Copy it with the agent" />
        <div className="dash-tile" style={{ minHeight: 84, cursor: "pointer" }} onClick={onOpenQueue} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpenQueue()}>
          <div style={{ minWidth: 0 }}>
            <div className="tl">In the queue</div>
            <div className="tv" style={{ fontSize: 26 }}>{a.ready ?? 0} <span style={{ fontSize: 13, fontFamily: "inherit", color: "var(--muted)", fontWeight: 600 }}>ready</span></div>
            <div className="ts">{a.waiting ?? 0} waiting for accept{a.inflight ? " · " + a.inflight + " sending" : ""} · Open Send Queue →</div>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Limits and hours, for the picked account ────────────────────────
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

function SettingsPanel({ a, st, run, busy }) {
  const eff = a.limits || {};
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
    run("settings", () => saveAgentSettings({ accountId: a.id, settings: out }), "Saved. " + a.label + " uses these from its next check-in").then(() => setDirty(false));
  }
  function reset() {
    run("settings", () => saveAgentSettings({ accountId: a.id, settings: {} }), "Back to the default limits").then(() => setDirty(false));
  }
  const custom = Object.keys(a.settings || {}).length > 0;

  return (
    <div className="panel">
      <div className="toprow" style={{ margin: "0 0 4px", flexWrap: "wrap", gap: 8 }}>
        <PanelTitle>Limits &amp; hours</PanelTitle>
        <span className="chip idx">{a.label}</span>
        {custom && <span className="chip idx">Own settings</span>}
      </div>
      <p className="hint" style={{ color: "var(--muted)", marginTop: 4 }}>For this LinkedIn account only; each account has its own. Lower is safer for the account. Each value has a ceiling the server won't go past.</p>

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
  const accounts = st.accounts || [];

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
      <p className="hint" style={{ color: "var(--muted)", marginTop: 4 }}>The PC that holds the LinkedIn sign-ins. One PC runs all your accounts, each in its own browser window. It starts the agent with Windows and needs to be on for anything to send.</p>

      {devices.length === 0 && !pair && <div className="hint" style={{ color: "var(--faint)" }}>No PC connected yet.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "8px 0 12px" }}>
        {devices.map((d) => {
          const live = seenRecently(d.last_used_at);
          const runs = accounts.filter((a) => a.deviceId === d.id).map((a) => a.label);
          const w = d.worker || {};
          return (
            <div key={d.id} className="mcard" style={{ padding: "10px 12px", flexDirection: "row", alignItems: "center", gap: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: 8, background: live ? "#52d39e" : "var(--faint)", flex: "0 0 8px" }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--text)" }}>{d.name || "PC"}</div>
                <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                  {live ? "Online" : "Last seen " + ago(d.last_used_at)} · connected {ago(d.paired_at)}{w.version ? " · agent " + w.version : ""}
                </div>
                {runs.length > 0 && <div style={{ fontSize: 11.5, color: "var(--faint)" }}>Runs {runs.join(", ")}</div>}
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
function ActivityLog({ events, label, all, setAll, multi }) {
  const [more, setMore] = useState(false);
  const shown = more ? events : events.slice(0, 25);
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="toprow" style={{ margin: "0 0 10px", flexWrap: "wrap", gap: 10 }}>
        <PanelTitle>Activity</PanelTitle>
        {multi && (
          <div className="seg" role="group" aria-label="Whose activity">
            <button className={all ? "" : "on"} onClick={() => setAll(false)}>{label}</button>
            <button className={all ? "on" : ""} onClick={() => setAll(true)}>All accounts</button>
          </div>
        )}
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--faint)" }}>Updates by itself</span>
      </div>
      {events.length === 0 && <div className="hint" style={{ color: "var(--faint)" }}>Nothing yet. Every step the agent takes shows up here.</div>}
      <div style={{ display: "flex", flexDirection: "column" }}>
        {shown.map((e) => (
          <div key={e.id} style={{ display: "flex", gap: 12, padding: "7px 0", borderTop: "1px solid var(--border)", fontSize: 13, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ flex: "0 0 128px", color: "var(--faint)", fontSize: 11.5, fontVariantNumeric: "tabular-nums" }}>{clock(e.at)}</span>
            <span style={{ width: 7, height: 7, borderRadius: 7, background: LEVEL_TONE[e.level] || LEVEL_TONE.info, flex: "0 0 7px", transform: "translateY(-1px)" }} />
            {multi && all && e.account_label && <span className="chip idx" style={{ fontSize: 11 }}>{e.account_label}</span>}
            <span style={{ color: e.level === "error" ? "#ffb3b3" : "var(--text)", minWidth: 0, flex: "1 1 200px", wordBreak: "break-word" }}>{e.text}</span>
          </div>
        ))}
      </div>
      {events.length > 25 && <button className="iconbtn" style={{ marginTop: 8 }} onClick={() => setMore(!more)}>{more ? "Show less" : "Show all " + events.length}</button>}
    </div>
  );
}

export function LinkedInAgentView({ showToast, onOpenQueue }) {
  const [st, setSt] = useState(null);
  const [events, setEvents] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [pick, setPickState] = useState(() => { try { return localStorage.getItem(PICK_KEY) || ""; } catch (e) { return ""; } });
  const [allLog, setAllLog] = useState(false);
  const setPick = (id) => { setPickState(id); try { localStorage.setItem(PICK_KEY, id); } catch (e) {} };

  const accounts = (st && st.accounts) || [];
  const a = accounts.find((x) => x.id === pick) || accounts[0] || null;
  const logFor = allLog || !a ? "" : a.id;
  const logRef = useRef(logFor);
  logRef.current = logFor;

  function load() {
    agentStatus().then((s) => { setSt(s); setErr(""); }).catch((e) => setErr((e && e.message) || "Could not load the agent."));
    const want = logRef.current;
    agentEvents(150, want).then((ev) => { if (logRef.current === want) setEvents(ev); }).catch(() => {});
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Another account, or all of them: its log now, not in 5 seconds.
  useEffect(() => {
    if (!st) return;
    agentEvents(150, logFor).then((ev) => { if (logRef.current === logFor) setEvents(ev); }).catch(() => {});
  }, [logFor]);

  // Every control goes through here: one action at a time, the fresh status on success.
  async function run(key, fn, ok) {
    setBusy(key); setErr("");
    let r = null;
    try {
      r = await fn();
      if (r && r.status) setSt(r.status);
      else if (r && r.accounts) setSt(r);
      if (ok) showToast(ok);
      load();
    } catch (e) { setErr((e && e.message) || "Something went wrong."); r = null; }
    setBusy("");
    return r;
  }

  const anyOn = accounts.some((x) => x.enabled);
  const max = (st && st.maxAccounts) || 4;

  return (
    <div>
      <div className="head">
        <div className="eyebrow">Outreach</div>
        <h2>LinkedIn agent</h2>
        <p>The agent works on a PC that's signed in to your LinkedIn accounts, up to {max}, and does only what you approved: connection requests, messages, replies. Each account has its own switch, limits and log. Control everything from here. What it sends, you approve in the Send Queue.</p>
      </div>
      {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}
      {!st && !err && <div className="panel" style={{ color: "var(--muted)" }}>Loading…</div>}
      {st && a && (
        <>
          <div className="toprow" style={{ margin: "0 0 10px", flexWrap: "wrap", gap: 10 }}>
            <div className="sect-title" style={{ margin: 0 }}>LinkedIn accounts <span style={{ color: "var(--faint)", fontWeight: 600 }}>· {accounts.length} of {max}</span></div>
            {accounts.length > 1 && (
              <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <button className="btn ghost sm" disabled={busy !== "" || !anyOn} onClick={() => run("all", () => setAgentEnabled(false, "all"), "All accounts paused")}>Pause all</button>
                <button className="btn primary sm" disabled={busy !== "" || accounts.every((x) => x.enabled)} onClick={() => run("all", () => setAgentEnabled(true, "all"), "All accounts started")}>Start all</button>
              </div>
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 220px), 1fr))", gap: 12, marginBottom: 18 }}>
            {accounts.map((x) => <AccountCard key={x.id} a={x} devices={st.devices} picked={x.id === a.id} onPick={() => setPick(x.id)} run={run} busy={busy} />)}
            {accounts.length < max && <AddAccountCard count={accounts.length} max={max} run={run} busy={busy} onAdded={setPick} />}
          </div>

          <AccountPanel a={a} st={st} run={run} busy={busy} onOpenQueue={onOpenQueue} onRemoved={() => setPick("")} />
          <TodayTiles a={a} onOpenQueue={onOpenQueue} />
          <div className="grid2" style={{ alignItems: "start" }}>
            <SettingsPanel key={a.id} a={a} st={st} run={run} busy={busy} />
            <PcsPanel st={st} run={run} busy={busy} showToast={showToast} />
          </div>
          <ActivityLog events={events} label={a.label} all={allLog} setAll={setAllLog} multi={accounts.length > 1} />
        </>
      )}
    </div>
  );
}
