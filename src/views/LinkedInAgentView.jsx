// The LinkedIn agent, run from Karma Connect. The agent itself is a small worker on a PC; it can
// run up to four LinkedIn accounts there, each in its own browser profile. This page is its whole
// control panel, laid out so the one thing to do next is always the obvious one: a tab per
// account, one status card with one main button, the setup steps until the account is ready,
// today's numbers, and everything else (hours and limits, PCs, details, the log) folded away.
// The worker checks in every few seconds and picks up whatever is set here.
import { useState, useEffect, useRef } from "react";
import { agentStatus, setAgentEnabled, saveAgentSettings, agentCommand, agentPairCode, revokeAgentDevice,
  agentEvents, downloadAgent, addAgentAccount, updateAgentAccount, removeAgentAccount } from "../lib/outreach.js";
import { IncomingMessages } from "./IncomingMessages.jsx";
import { AgentToday } from "./AgentToday.jsx";
import { SENDERS } from "../lib/senders.js";

const ONLINE_SEC = 90; // a worker that hasn't checked in for this long is treated as offline
const PICK_KEY = "kc.liagent.account";
const GREEN = "#52d39e", AMBER = "#E7B74B", RED = "#e24a4a", VIOLET = "#7C5CFF";

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
const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");

// One headline state for an account, from what the server knows about it: a short label for the
// tab, a sentence for the status card, and its colour.
function overall(a, devices) {
  const w = a.worker || {};
  const online = seenRecently(a.lastSeenAt) && w.state !== undefined;
  const host = w.host || "the PC";
  if (!online && !(devices || []).length)
    return { key: "nopc", label: "Not set up", say: "Not set up yet", tone: "var(--faint)", online };
  if (!online) return { key: "offline", label: "PC offline", tone: AMBER, online,
    say: a.lastSeenAt ? "The PC is offline" : "Waiting for the PC to come on" };
  if (w.state === "signing_in") return { key: "signin", label: "Signing in", say: "Waiting for you to sign in on " + host, tone: AMBER, online };
  // the worker only knows who is signed in once the browser is open, so "signed out" is its word, not a guess
  if (w.state === "signed_out") return { key: "signedout", label: "Signed out", say: "Signed out of LinkedIn", tone: RED, online };
  if (a.sameLinkedInAs) return { key: "dupe", label: "Needs a different LinkedIn", say: "Signed in to the same LinkedIn as another account", tone: RED, online };
  if (a.haltReason) return { key: "stopped", label: "Stopped", say: "Stopped to keep the account safe", tone: RED, online };
  if (a.enabled) return a.dryRun
    ? { key: "dry", label: "Test mode", say: "Running in test mode: nothing is sent", tone: VIOLET, online }
    : { key: "running", label: "Running", say: "Running", tone: GREEN, online };
  return { key: "paused", label: "Paused", say: "Paused", tone: "var(--muted)", online };
}

// "0.5.0" < "0.6.0"
const verLt = (a, b) => {
  const x = String(a || "0").split(".").map(Number), y = String(b || "0").split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); }
  return false;
};
const PROSPECT_AGENT = "0.6.0";   // the first agent that finds prospects (agent/prospect.cjs)
/* Why "Find prospects" isn't finding or inviting anyone at this moment, in
   plain words — or null when nothing is in its way. */
function prospectBlock(a, w) {
  const L = a.limits || {};
  if (w && w.version && verLt(w.version, PROSPECT_AGENT))
    return `the agent on ${w.host || "the PC"} is an old version (${w.version}) that can't find prospects. Update it: download the agent again from PCs below and run Connect-this-PC.bat, or in the Karma Connect folder run  git pull  and restart it.`;
  if (a.dryRun) return "Test mode is on, so it doesn't search or send anything. Turn Test mode off.";
  if (!a.enabled) return "this account is paused. Press Start.";
  if (a.searchLimitHit) return "LinkedIn's monthly search limit is reached on this account; it searches again next month.";
  if (a.invites && a.invites.target > 0 && a.invites.today >= a.invites.target) return null;   // today's invitations are sent
  if ((a.searchesToday || 0) >= (a.searchesPerDay || 15))
    return `it ran all ${a.searchesPerDay || 15} of today's searches without finding enough new decision-makers${a.ready ? ` (${plural(a.ready, "invitation")} still waiting to go)` : ""}; it searches again tomorrow. The log below says who it left out and why.`;
  const now = new Date(), h = now.getHours(), day = now.getDay();
  if (L.weekdaysOnly && (day === 0 || day === 6)) return "it works weekdays only (Hours & limits); it starts again on Monday.";
  if (L.windowStart != null && L.windowEnd != null && (h < L.windowStart || h >= L.windowEnd))
    return `it works ${hourLabel(L.windowStart)}–${hourLabel(L.windowEnd)} (Hours & limits; the PC's time), so it waits until then.`;
  return null;
}

function Dot({ tone, pulse }) {
  return <span className={"lia-dot" + (pulse ? " pulse" : "")} style={{ background: tone }} aria-hidden="true" />;
}

// A folded section: the heading and a one-line summary show; the rest opens on a click.
function Section({ title, summary, open, onToggle, children }) {
  return (
    <details className="panel lia-sec" open={open} onToggle={(e) => onToggle && onToggle(e.currentTarget.open)}>
      <summary>
        <span className="lia-sec-t">{title}</span>
        {summary && <span className="lia-sec-s">{summary}</span>}
      </summary>
      <div className="lia-sec-b">{children}</div>
    </details>
  );
}

// ── The account tabs ────────────────────────────────────────────────
function AccountTabs({ accounts, devices, pickedId, onPick, max, run, busy, onAdded }) {
  const anyOn = accounts.some((x) => x.enabled);
  return (
    <div className="lia-tabs" role="tablist" aria-label="LinkedIn accounts">
      {accounts.map((x) => {
        const o = overall(x, devices);
        return (
          <button key={x.id} role="tab" aria-selected={x.id === pickedId} className={"lia-tab" + (x.id === pickedId ? " on" : "")} onClick={() => onPick(x.id)}>
            <Dot tone={o.tone} pulse={o.key === "running"} />
            <span className="lia-tab-n">{x.label}</span>
            <span className="lia-tab-s">{o.label}</span>
          </button>
        );
      })}
      {accounts.length < max && (
        <button className="lia-tab add" disabled={busy !== ""} onClick={async () => {
          const r = await run("add", () => addAgentAccount(""), "Account added. Follow its setup steps");
          if (r && r.account) onAdded(r.account.id);
        }}>{busy === "add" ? "Adding…" : "+ Add account"}</button>
      )}
      {accounts.length > 1 && (
        <span className="lia-tabs-all">
          {anyOn
            ? <button className="btn ghost sm" disabled={busy !== ""} onClick={() => run("all", () => setAgentEnabled(false, "all"), "All accounts paused")}>Pause all</button>
            : <button className="btn ghost sm" disabled={busy !== ""} onClick={() => run("all", () => setAgentEnabled(true, "all"), "All accounts started")}>Start all</button>}
        </span>
      )}
    </div>
  );
}

// ── The status card: what it's doing, and the one button that matters ─
function StatusCard({ a, st, run, busy, onOpenQueue }) {
  const devices = st.devices || [];
  const o = overall(a, devices);
  const w = a.worker || {};
  const host = w.host || "the PC";
  const working = busy !== "";
  const toApprove = (a.needReply || 0) + (a.firstMessages || 0);

  const start = () => run("toggle", () => setAgentEnabled(true, a.id), a.dryRun ? "Started in test mode: nothing will be sent" : "Started");
  const pause = () => run("toggle", () => setAgentEnabled(false, a.id), "Paused. Its browser closes");
  const signIn = () => run("cmd", () => agentCommand("linkedin_login", a.id), "LinkedIn opens on " + host + ". Sign in there");

  // The one main action for the state the account is in.
  let main = null;
  if (o.key === "nopc") main = null;   // the setup steps below carry it
  else if (o.key === "signedout" || o.key === "dupe") main = <button className="btn primary" disabled={working} onClick={signIn}>{busy === "cmd" ? "…" : "Sign in to LinkedIn"}</button>;
  else if (o.key === "offline" || o.key === "signin") main = null;
  else if (a.enabled) main = <button className="btn ghost" disabled={working} onClick={pause}>{busy === "toggle" ? "…" : "Pause"}</button>;
  else main = <button className="btn primary" disabled={working} onClick={start}>{busy === "toggle" ? "…" : a.haltReason ? "Clear & start again" : "Start"}</button>;

  // One plain sentence under the headline.
  let line;
  if (o.key === "nopc") line = "A few short steps below, about a minute. Nothing is sent until you press Start.";
  else if (o.key === "offline") line = (a.lastSeenAt ? "Last seen " + ago(a.lastSeenAt) + (w.host ? " on " + w.host : "") + ". " : "")
    + "Turn that PC on and wake it up; the agent starts with Windows. Approved messages wait here until it's back.";
  else if (o.key === "signin") line = "LinkedIn is open on " + host + ". Sign in there with this account's LinkedIn email and password (not “Continue with Google”). The window closes by itself once you're in.";
  else if (o.key === "signedout") line = "Press Sign in to LinkedIn: a LinkedIn window opens on " + host + " for you to sign in.";
  else if (o.key === "dupe") line = "This account uses the same LinkedIn as “" + a.sameLinkedInAs + "”, so neither sends. Sign one of them in to a different LinkedIn.";
  else if (a.haltReason) line = a.haltReason + (/signed out/i.test(a.haltReason) ? "" : " Check LinkedIn for this account on " + host + ", then press Clear & start again.");
  else if (a.enabled) line = w.activity || "Working through the messages you approved, inside its working hours.";
  else line = "Nothing is sent while it's paused. Press Start when you're ready" + (w.linkedin ? "." : ". New account? Sign in to LinkedIn first.");

  return (
    <div className="panel lia-hero" style={{ borderColor: o.tone === "var(--faint)" || o.tone === "var(--muted)" ? undefined : o.tone + "55" }}>
      <div className="lia-hero-top">
        <div style={{ minWidth: 0 }}>
          <div className="lia-hero-k">{a.label}{w.linkedin ? " · " + (w.linkedin.name || w.linkedin.handle) : ""}</div>
          <div className="lia-state"><Dot tone={o.tone} pulse={o.key === "running" || o.key === "dry"} />{o.say}</div>
          <p className="lia-line">{line}</p>
        </div>
        {main && (
          <div className="lia-hero-act">
            {main}
            {!a.enabled && !w.linkedin && (o.key === "paused" || o.key === "stopped") && (
              <button className="btn ghost sm" disabled={working} onClick={signIn}>Sign in to LinkedIn</button>
            )}
          </div>
        )}
      </div>

      {o.online && o.key !== "signin" && o.key !== "signedout" && o.key !== "dupe" && (
        <div className="lia-mode">
          <label className="lia-switch">
            <input type="checkbox" checked={!!a.dryRun} disabled={working}
              onChange={(e) => run("dry", () => saveAgentSettings({ accountId: a.id, dryRun: e.target.checked }),
                e.target.checked ? "Test mode on: it types everything but never presses Send" : "Test mode off: this account sends for real")} />
            <span className="lia-switch-ui" aria-hidden="true" />
            <span><b>Test mode</b> <span className="lia-muted">— {a.dryRun
              ? "it goes through every step but never presses Send. Afterwards, press Retry on those items in Send Queue."
              : "off: messages and invitations are sent for real."}</span></span>
          </label>
          {a.prospecting && (
            <label className="lia-switch" style={{ marginTop: 12 }}>
              <input type="checkbox" checked={!!a.prospectOn} disabled={working}
                onChange={(e) => run("prospect", () => updateAgentAccount(a.id, { prospectOn: e.target.checked }),
                  e.target.checked ? "Finding prospects: it searches for restoration decision-makers and invites them" : "Finding prospects: off")} />
              <span className="lia-switch-ui" aria-hidden="true" />
              <span><b>Find prospects for me</b> <span className="lia-muted">— {!a.prospectOn
                ? "off: it only invites the people you add."
                : "owners and operations leaders at restoration companies in the US and Canada, invited automatically"
                  + (a.notesLeft ? " with a short note" : " (this month's free notes are used up, so without a note)")
                  + ". Today: " + plural(a.foundToday || 0, "new prospect") + " from " + plural(a.searchesToday || 0, "search", "searches") + (a.invites ? " · invitations " + a.invites.today + " of today's " + a.invites.target : "") + "."}</span></span>
            </label>
          )}
          {a.prospecting && a.prospectOn && prospectBlock(a, w) && (
            <div className="lia-why" role="status">Not inviting right now: {prospectBlock(a, w)}</div>
          )}
        </div>
      )}

      {toApprove > 0 && (
        <button className="lia-approve" onClick={() => {
          const el = a.needReply ? document.getElementById("lia-incoming") : null;
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); else onOpenQueue();
        }}>
          <span><b>{plural(toApprove, "item")}</b> waiting for your approval
            <span className="lia-muted"> · {[a.needReply ? plural(a.needReply, "reply", "replies") : "", a.firstMessages ? plural(a.firstMessages, "new connection") : ""].filter(Boolean).join(" · ")}</span></span>
          <span className="lia-approve-go">{a.needReply ? "Answer below ↓" : "Review in Send Queue →"}</span>
        </button>
      )}
    </div>
  );
}

// ── The setup steps, until the account is ready ─────────────────────
function SetupSteps({ a, st, run, busy, onConnectPc }) {
  const devices = st.devices || [];
  const o = overall(a, devices);
  const w = a.worker || {};
  const steps = [
    { t: "Connect a PC", d: "The PC that holds the LinkedIn sign-in. It runs the agent in the background.",
      done: devices.length > 0, act: <button className="btn primary sm" disabled={busy !== ""} onClick={onConnectPc}>Connect a PC</button> },
    { t: "Make sure the PC is on", d: "The agent starts with Windows. It shows online here within a few seconds.",
      done: o.online, act: null },
    { t: "Sign in to LinkedIn", d: "Opens LinkedIn on " + (w.host || "the PC") + " so you can sign in there. Use the email and password, not Google.",
      done: !!w.linkedin,
      act: <button className="btn primary sm" disabled={busy !== "" || !o.online || o.key === "signin"}
        onClick={() => run("cmd", () => agentCommand("linkedin_login", a.id), "LinkedIn opens on " + (w.host || "the PC") + ". Sign in there")}>
        {o.key === "signin" ? "Waiting…" : "Sign in"}</button> },
    { t: "Press Start", d: "Try it in test mode first if you like: it does everything except press Send.",
      done: !!a.enabled, act: null },
  ];
  /* Only for an account that has never checked in. Once its PC has run it, the
     status card carries it (an offline PC, signing in, starting) — a PC switched
     off overnight is not a setup step. */
  if ((steps[0].done && steps[1].done) || (steps[0].done && a.lastSeenAt)) return null;
  const now = steps.findIndex((s) => !s.done);
  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="lia-h">Set up {a.label}</div>
      <ol className="lia-steps">
        {steps.map((s, i) => (
          <li key={i} className={"lia-step" + (s.done ? " done" : i === now ? " now" : "")}>
            <span className="n">{s.done ? "✓" : i + 1}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="t">{s.t}</div>
              {!s.done && <div className="d">{s.d}</div>}
            </div>
            {!s.done && i === now && s.act}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── Hours and limits ────────────────────────────────────────────────
const MAIN_FIELDS = [
  ["perDay", "Messages a day", "Replies count too"],
  ["invitesPerWeek", "Most invitations a week", "Each week sends a different total up to this (60–80 for 80), a different number each day; LinkedIn's own limit is about 100"],
];
const MORE_FIELDS = [
  ["perHour", "Messages an hour", ""],
  ["invitesPerDay", "Most invitations in one day", "No single day goes above this"],
  ["minGapSec", "Shortest gap (seconds)", "Between any two actions"],
  ["maxGapSec", "Longest gap (seconds)", "It waits a random time in between"],
  ["inboxEveryMin", "Check inbox every (minutes)", ""],
  ["acceptEveryMin", "Check accepts every (minutes)", ""],
  ["copiesPerDay", "Profile copies a day", ""],
];

function hoursSummary(L) {
  return (L.weekdaysOnly ? "Weekdays" : "Every day") + " " + hourLabel(L.windowStart ?? 9) + "–" + hourLabel(L.windowEnd ?? 17)
    + " · " + (L.perDay ?? "?") + " messages a day · " + (L.invitesPerWeek ?? "?") + " invitations a week";
}

function NumField({ k, label, help, form, set, b, d }) {
  return (
    <label className="lia-field">
      {label}
      <input type="number" min={(b[k] || [])[0]} max={(b[k] || [])[1]} value={form[k] ?? ""} onChange={(e) => set(k, e.target.value)} />
      <span>{help ? help + " · " : ""}default {d[k]}{b[k] ? " · max " + b[k][1] : ""}</span>
    </label>
  );
}

function HoursAndLimits({ a, st, run, busy, open, onToggle }) {
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
  const custom = Object.keys(a.settings || {}).length > 0;

  function save() {
    const out = {};
    for (const [k] of [...MAIN_FIELDS, ...MORE_FIELDS]) if (form[k] !== "" && form[k] != null) out[k] = Number(form[k]);
    out.windowStart = Number(form.windowStart);
    out.windowEnd = Number(form.windowEnd);
    out.weekdaysOnly = !!form.weekdaysOnly;
    run("settings", () => saveAgentSettings({ accountId: a.id, settings: out }), "Saved. " + a.label + " uses these from its next check-in").then(() => setDirty(false));
  }
  function reset() {
    run("settings", () => saveAgentSettings({ accountId: a.id, settings: {} }), "Back to the safe defaults").then(() => setDirty(false));
  }

  return (
    <Section title="Hours & limits" summary={hoursSummary(eff) + (custom ? " · own settings" : "")} open={open} onToggle={onToggle}>
      <p className="lia-muted" style={{ margin: "0 0 14px", fontSize: 13 }}>For {a.label} only. The defaults are set to keep the LinkedIn account safe; lower is safer still. Hours are the PC's own time.</p>
      <div className="lia-hours">
        <label className="lia-field">Works from
          <select value={form.windowStart ?? 9} onChange={(e) => set("windowStart", Number(e.target.value))}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </label>
        <label className="lia-field">until
          <select value={form.windowEnd ?? 17} onChange={(e) => set("windowEnd", Number(e.target.value))}>
            {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </label>
        <div className="seg" role="group" aria-label="Which days" style={{ alignSelf: "flex-end" }}>
          <button className={form.weekdaysOnly ? "on" : ""} onClick={() => set("weekdaysOnly", true)}>Weekdays</button>
          <button className={form.weekdaysOnly ? "" : "on"} onClick={() => set("weekdaysOnly", false)}>Every day</button>
        </div>
      </div>
      <div className="fgrid" style={{ marginTop: 14 }}>
        {MAIN_FIELDS.map(([k, label, help]) => <NumField key={k} k={k} label={label} help={help} form={form} set={set} b={b} d={d} />)}
      </div>
      {(() => {
        // the week can't add up if no day may go high enough
        const days = form.weekdaysOnly ? 5 : 7, most = Number(form.invitesPerDay) || 0, week = Number(form.invitesPerWeek) || 0;
        return most && week && most * days < week
          ? <p className="lia-muted" style={{ margin: "10px 0 0", fontSize: 13, color: "#E7B74B" }}>At most {most} a day, the week reaches only {most * days} of {week}. Raise "Most invitations in one day" under More limits.</p>
          : null;
      })()}
      <details className="lia-more">
        <summary>More limits</summary>
        <div className="fgrid" style={{ marginTop: 12 }}>
          {MORE_FIELDS.map(([k, label, help]) => <NumField key={k} k={k} label={label} help={help} form={form} set={set} b={b} d={d} />)}
        </div>
      </details>
      <div className="mact" style={{ marginTop: 14 }}>
        {custom && <button className="iconbtn" disabled={busy !== ""} onClick={reset}>Use the safe defaults</button>}
        {dirty && <span className="lia-muted" style={{ fontSize: 12.5 }}>Not saved yet</span>}
        <button className="btn primary sm" style={{ marginLeft: "auto" }} disabled={busy !== "" || !dirty} onClick={save}>{busy === "settings" ? "Saving…" : "Save"}</button>
      </div>
    </Section>
  );
}

// ── PCs ─────────────────────────────────────────────────────────────
function Pcs({ st, run, busy, showToast, open, onToggle, pairNow }) {
  const [pair, setPair] = useState(null); // { code, expiresAt }
  const [left, setLeft] = useState(0);
  const [dl, setDl] = useState(false);
  const known = useRef((st.devices || []).length);
  const devices = st.devices || [];
  const accounts = st.accounts || [];
  const online = devices.filter((d) => seenRecently(d.last_used_at)).length;

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
  // "Connect a PC" pressed on the status card or a setup step: open here with a fresh code.
  useEffect(() => {
    if (pairNow) makeCode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairNow]);

  // npm.cmd: in PowerShell plain "npm" is blocked ("running scripts is disabled on this system")
  const cmd = pair ? "npm.cmd run agent -- --pair " + pair.code : "";
  const copy = (t) => { try { navigator.clipboard.writeText(t); showToast("Copied"); } catch (e) {} };
  async function getZip() {
    setDl(true);
    try { await downloadAgent(); showToast("Downloaded. Unzip it and open SETUP.md"); } catch (e) { showToast((e && e.message) || "Download failed"); }
    setDl(false);
  }

  const summary = devices.length ? plural(devices.length, "PC") + " · " + (online ? online + " online" : "offline") : "None connected yet";
  return (
    <Section title="PCs" summary={summary} open={open} onToggle={onToggle}>
      <p className="lia-muted" style={{ margin: "0 0 12px", fontSize: 13 }}>One PC can run all your accounts, each in its own browser window. It needs to be on for anything to send.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        {devices.map((d) => {
          const live = seenRecently(d.last_used_at);
          const runs = accounts.filter((x) => x.deviceId === d.id).map((x) => x.label);
          const w = d.worker || {};
          return (
            <div key={d.id} className="lia-row">
              <Dot tone={live ? GREEN : "var(--faint)"} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--text)" }}>{d.name || "PC"}</div>
                <div className="lia-muted" style={{ fontSize: 12 }}>
                  {live ? "Online" : "Last seen " + ago(d.last_used_at)} · connected {ago(d.paired_at)}{w.version ? " · agent " + w.version : ""}{runs.length ? " · runs " + runs.join(", ") : ""}
                </div>
              </div>
              <button className="iconbtn" style={{ marginLeft: "auto" }} disabled={busy !== ""}
                onClick={() => run("revoke", () => revokeAgentDevice(d.id), (d.name || "PC") + " disconnected. Its key no longer works")}>Disconnect</button>
            </div>
          );
        })}
      </div>

      {pair ? (
        <div className="lia-pair">
          <div className="lia-h" style={{ fontSize: 14 }}>Connect a PC</div>
          <ol className="lia-howto">
            <li>On that PC, open the Karma Connect folder in a terminal.</li>
            <li>Paste this and press Enter:
              <div className="lia-code"><code>{cmd}</code><button className="btn ghost sm" onClick={() => copy(cmd)}>Copy</button></div>
            </li>
            <li>That's it. It shows up above within a few seconds, and starts with Windows from then on.</li>
          </ol>
          <div className="lia-muted" style={{ fontSize: 12 }}>
            Code <b style={{ color: "var(--text)", letterSpacing: ".08em" }}>{pair.code}</b> · {left > 0 ? "works for " + Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") : "expired"}.
            {" "}No Karma Connect folder on that PC? Download the agent below, unzip it, and double-click <b>Connect-this-PC</b> in it: it installs everything and asks for this code.
          </div>
          <div className="mact" style={{ marginTop: 10 }}>
            {left <= 0 && <button className="btn primary sm" onClick={makeCode}>New code</button>}
            <button className="btn ghost sm" disabled={dl} onClick={getZip}>{dl ? "…" : "Download agent"}</button>
            <button className="iconbtn" style={{ marginLeft: "auto" }} onClick={() => setPair(null)}>Close</button>
          </div>
        </div>
      ) : (
        <div className="mact">
          <button className="btn ghost sm" disabled={dl} onClick={getZip} title="For a PC without the Karma Connect folder">{dl ? "…" : "Download agent"}</button>
          <button className="btn primary sm" style={{ marginLeft: "auto" }} disabled={busy !== ""} onClick={makeCode}>{busy === "pair" ? "…" : devices.length ? "Connect another PC" : "Connect a PC"}</button>
        </div>
      )}
    </Section>
  );
}

// ── Account details: name, LinkedIn, PC, manual checks, remove ──────
function Details({ a, st, run, busy, onRemoved, open, onToggle }) {
  const devices = st.devices || [];
  const o = overall(a, devices);
  const w = a.worker || {};
  const li = w.linkedin;
  const working = busy !== "";
  const canCommand = o.online && o.key !== "signin";
  const [name, setName] = useState(a.label);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => { setConfirmRemove(false); setName(a.label); }, [a.id, a.label]);
  const onlyOne = (st.accounts || []).length <= 1;
  const pcName = (id) => (devices.find((d) => d.id === id) || {}).name || "PC";
  const offTitle = canCommand ? "" : "The PC needs to be online";

  return (
    <Section title="Account details" summary={(li ? (li.name || li.handle) : "No LinkedIn yet") + " · " + (w.host || (a.deviceId ? pcName(a.deviceId) : "any PC"))} open={open} onToggle={onToggle}>
      <div className="fgrid">
        <form className="lia-field" onSubmit={(e) => { e.preventDefault(); if (name.trim() && name !== a.label) run("name", () => updateAgentAccount(a.id, { label: name }), "Renamed"); }}>
          Name in Karma Connect
          <div style={{ display: "flex", gap: 8 }}>
            <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-label="Account name" style={{ flex: 1, minWidth: 0 }} />
            {name !== a.label && <button className="btn primary sm" disabled={working || !name.trim()}>Save</button>}
          </div>
        </form>
        <div className="lia-field">
          Runs on
          {devices.length > 1 ? (
            <select value={a.deviceId || ""} disabled={working} aria-label="Which PC runs this account"
              onChange={(e) => run("pc", () => updateAgentAccount(a.id, { deviceId: e.target.value || null }), "Saved. That PC takes it over on its next check-in")}>
              <option value="">Any connected PC</option>
              {devices.map((d) => <option key={d.id} value={d.id}>{d.name || "PC"}</option>)}
            </select>
          ) : <div className="lia-val">{w.host || (a.deviceId ? pcName(a.deviceId) : "—")}</div>}
        </div>
        <div className="lia-field">
          LinkedIn
          <div className="lia-val">
            {li ? (li.handle
              ? <a href={"https://www.linkedin.com/in/" + encodeURIComponent(li.handle) + "/"} target="_blank" rel="noopener noreferrer" style={{ color: "var(--ice)" }}>{li.name || li.handle}</a>
              : li.name) : <span className="lia-muted">Not signed in</span>}
          </div>
        </div>
        <div className="lia-field">
          Messages written as
          <select value={a.senderId || ""} disabled={working} aria-label="Who the AI writes as for this account"
            onChange={(e) => run("sender", () => updateAgentAccount(a.id, { senderId: e.target.value || null }), "Saved. New drafts for this account are written as " + ((SENDERS.find((s) => s.id === e.target.value) || {}).name || "the default"))}>
            <option value="">Default ({SENDERS[0].name})</option>
            {SENDERS.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.role}</option>)}
          </select>
        </div>
        <div className="lia-field">
          Last checks
          <div className="lia-val">Inbox {ago(w.lastInboxAt)} · accepts {ago(w.lastAcceptAt)}</div>
        </div>
      </div>

      <div className="mact" style={{ marginTop: 14, flexWrap: "wrap" }}>
        <button className="btn ghost sm" disabled={working || !canCommand} title={offTitle}
          onClick={() => run("cmd", () => agentCommand("check_inbox", a.id), "It checks the inbox within a few seconds")}>Check inbox now</button>
        <button className="btn ghost sm" disabled={working || !canCommand} title={offTitle}
          onClick={() => run("cmd", () => agentCommand("check_accepts", a.id), "It checks for accepts within a few seconds")}>Check accepts now</button>
        <button className="btn ghost sm" disabled={working || !canCommand} title={canCommand ? "Opens LinkedIn on the PC, to sign in or switch to another LinkedIn" : offTitle}
          onClick={() => run("cmd", () => agentCommand("linkedin_login", a.id), "LinkedIn opens on " + (w.host || "the PC") + ". Sign in there")}>{li ? "Switch LinkedIn account" : "Sign in to LinkedIn"}</button>
        {a.pendingCommand && <span className="lia-muted" style={{ fontSize: 12.5 }}>Waiting for the PC to pick that up…</span>}
      </div>
      <div className="lia-muted" style={{ fontSize: 12, marginTop: 10 }}>
        {w.browser ? browserName(w.browser) : "Browser —"} · agent {w.version || "—"}
      </div>

      {!onlyOne && (
        <div className="mact" style={{ marginTop: 14 }}>
          {confirmRemove ? (
            <>
              <span style={{ fontSize: 12.5, color: "var(--muted)" }}>Remove “{a.label}”? Its unsent messages and invitations go from the first account instead, unanswered replies are skipped, and the PC deletes its saved LinkedIn sign-in.</span>
              <button className="btn danger sm" style={{ marginLeft: "auto" }} disabled={working}
                onClick={() => run("remove", () => removeAgentAccount(a.id), a.label + " removed").then((r) => r && onRemoved())}>Remove</button>
              <button className="iconbtn" onClick={() => setConfirmRemove(false)}>Cancel</button>
            </>
          ) : <button className="iconbtn" style={{ marginLeft: "auto" }} onClick={() => setConfirmRemove(true)}>Remove this account</button>}
        </div>
      )}
    </Section>
  );
}

// ── Activity: the last few in view, the rest on a click ─────────────
const LEVEL_TONE = { success: GREEN, warn: AMBER, error: RED, info: "var(--faint)" };
function Activity({ events, label, all, setAll, multi }) {
  const [more, setMore] = useState(false);
  const shown = more ? events : events.slice(0, 6);
  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="toprow" style={{ margin: "0 0 8px", gap: 10 }}>
        <div className="lia-h" style={{ margin: 0 }}>What it's been doing</div>
        {multi && (
          <div className="seg" role="group" aria-label="Whose activity">
            <button className={all ? "" : "on"} onClick={() => setAll(false)}>{label}</button>
            <button className={all ? "on" : ""} onClick={() => setAll(true)}>All accounts</button>
          </div>
        )}
        <span className="lia-muted" style={{ marginLeft: "auto", fontSize: 12 }}>Updates by itself</span>
      </div>
      {events.length === 0 && <div className="lia-muted" style={{ fontSize: 13 }}>Nothing yet. Every step the agent takes shows up here.</div>}
      <div>
        {shown.map((e) => (
          <div key={e.id} className="lia-ev">
            <Dot tone={LEVEL_TONE[e.level] || LEVEL_TONE.info} />
            <span className="lia-ev-t" style={{ color: e.level === "error" ? "#ffb3b3" : undefined }}>
              {multi && all && e.account_label && <span className="chip idx" style={{ fontSize: 11, marginRight: 8 }}>{e.account_label}</span>}
              {e.text}
            </span>
            <span className="lia-ev-at" title={clock(e.at)}>{ago(e.at)}</span>
          </div>
        ))}
      </div>
      {events.length > 6 && <button className="iconbtn" style={{ marginTop: 10 }} onClick={() => setMore(!more)}>{more ? "Show less" : "Show all " + events.length}</button>}
    </div>
  );
}

export function LinkedInAgentView({ showToast, onOpenQueue, onResearch }) {
  const [st, setSt] = useState(null);
  const [events, setEvents] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [pick, setPickState] = useState(() => { try { return localStorage.getItem(PICK_KEY) || ""; } catch (e) { return ""; } });
  const [allLog, setAllLog] = useState(false);
  const [openSec, setOpenSec] = useState("");      // which folded section is open
  const [pairNow, setPairNow] = useState(0);       // bumped to open PCs with a fresh code
  const pcsRef = useRef(null);
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
  // Another account, or all of them: its log now, not in a few seconds.
  useEffect(() => {
    if (!st) return;
    agentEvents(150, logFor).then((ev) => { if (logRef.current === logFor) setEvents(ev); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  function connectPc() {
    setOpenSec("pcs");
    setPairNow((n) => n + 1);
    setTimeout(() => pcsRef.current && pcsRef.current.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  }
  const toggle = (k) => (isOpen) => setOpenSec((cur) => (isOpen ? k : cur === k ? "" : cur));
  const max = (st && st.maxAccounts) || 4;

  return (
    <div className="lia">
      <div className="head">
        <div className="eyebrow">Outreach</div>
        <h2>LinkedIn agent</h2>
        <p>It sends only what you approve (connection requests, first messages and replies) from up to {max} LinkedIn accounts, and brings every incoming message here to research and answer.</p>
      </div>
      {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}
      {!st && !err && <div className="panel" style={{ color: "var(--muted)" }}>Loading…</div>}
      {st && a && (
        <>
          <AccountTabs accounts={accounts} devices={st.devices} pickedId={a.id} onPick={setPick} max={max} run={run} busy={busy} onAdded={setPick} />
          <StatusCard a={a} st={st} run={run} busy={busy} onOpenQueue={onOpenQueue} />
          <SetupSteps a={a} st={st} run={run} busy={busy} onConnectPc={connectPc} />
          {(st.devices || []).length > 0 && <AgentToday a={a} o={overall(a, st.devices)} accounts={accounts} onOpenQueue={onOpenQueue} />}
          {(st.devices || []).length > 0 && (
            <IncomingMessages accountId={a.id} accountLabel={a.label} multi={accounts.length > 1} showToast={showToast}
              onResearch={(t) => (onResearch ? onResearch(t) : showToast("Research isn't available here"))} />
          )}
          <HoursAndLimits key={"h" + a.id} a={a} st={st} run={run} busy={busy} open={openSec === "hours"} onToggle={toggle("hours")} />
          <div ref={pcsRef}>
            <Pcs st={st} run={run} busy={busy} showToast={showToast} open={openSec === "pcs"} onToggle={toggle("pcs")} pairNow={pairNow} />
          </div>
          <Details key={"d" + a.id} a={a} st={st} run={run} busy={busy} onRemoved={() => setPick("")} open={openSec === "details"} onToggle={toggle("details")} />
          <Activity events={events} label={a.label} all={allLog} setAll={setAllLog} multi={accounts.length > 1} />
        </>
      )}
    </div>
  );
}
