// The outreach Send Queue. Approved EMAIL items are auto-sent by the server agent; LINKEDIN
// items — connection requests, messages, replies — are sent by the local LinkedIn agent, or by
// hand here (open LinkedIn + copy, you send, mark sent). LinkedIn replies from prospects show
// at the top with an AI draft that a person edits and approves before anything is sent.
import { useState, useEffect, useRef } from "react";
import { listQueue, approveQueued, sendQueuedNow, markQueuedSent, skipQueued, agentStatus, setAgentEnabled,
  listInbox, saveThreadDraft, approveReply, setThreadHandled, sendWithoutWaiting, setQueueAccount } from "../lib/outreach.js";
import { draftReply } from "../lib/replies.js";
import { listFollowups, prepareFollowup, saveFollowupDraft, approveFollowup, skipFollowup } from "../lib/followups.js";
import { SENDERS } from "../lib/senders.js";

const fmt = (t) => (t ? new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const STATUS_META = {
  pending:  { label: "Needs approval", color: "#E7B74B" },
  approved: { label: "Scheduled",      color: "#4a86c8" },
  sending:  { label: "Sending…",       color: "#7C5CFF" },
  sent:     { label: "Sent",           color: "#52d39e" },
  failed:   { label: "Failed",         color: "#e24a4a" },
  skipped:  { label: "Skipped",        color: "#65769e" },
};

function ChannelChip({ channel }) {
  const linked = channel === "linkedin";
  return (
    <span className="chip" style={{ background: linked ? "rgba(74,134,200,.16)" : "rgba(82,211,158,.12)", borderColor: linked ? "rgba(74,134,200,.34)" : "rgba(82,211,158,.34)", color: linked ? "var(--ice)" : "#bff0d8" }}>
      {linked ? "LinkedIn" : "Email"}
    </span>
  );
}

// Where a LinkedIn item is done by hand: an invitation from the profile, a reply in its thread,
// a message in the composer.
function linkedinUrlFor(it) {
  const profile = String(it.linkedin_url || "").trim();
  const search = "https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent(it.lead_label || "");
  if (it.action === "reply") return it.thread_url || profile || search;
  if (it.action === "invite") return profile || search;
  const m = profile.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? "https://www.linkedin.com/messaging/compose/?recipient=" + encodeURIComponent(m[1]) : (profile || search);
}

// Which LinkedIn account an item goes from, when the agent runs more than one. Unsent
// invitations and messages can be moved; a reply stays in its own account's conversation.
function FromAccount({ item, accounts, busy, run }) {
  if (!accounts || accounts.length < 2 || item.channel !== "linkedin") return null;
  const label = (id) => (accounts.find((a) => a.id === id) || {}).label;
  const eff = item.li_account_eff || item.li_account_id;
  const movable = item.action !== "reply" && ["pending", "approved", "failed"].includes(item.status);
  if (!movable) return label(eff) ? <span className="chip idx" title="LinkedIn account" style={{ alignSelf: "flex-start" }}>{(item.status === "sent" ? "Sent from " : "From ") + label(eff)}</span> : null;
  return (
    <label style={{ fontSize: 12, color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: 6, alignSelf: "flex-start" }}>From
      <select value={item.li_account_id || ""} disabled={busy} aria-label="Send from which LinkedIn account"
        onChange={(e) => run(() => setQueueAccount(item.id, e.target.value || null), "It goes from " + (label(e.target.value) || label(eff) || "the first account") + " now")}
        style={{ padding: "4px 7px", borderRadius: 8, fontSize: 12 }}>
        <option value="">Automatic{!item.li_account_id && label(eff) ? " (" + label(eff) + ")" : ""}</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
      </select>
    </label>
  );
}

function QueueItem({ item, onChange, showToast, accounts }) {
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState(item.to_email || "");
  const [err, setErr] = useState("");
  const meta = STATUS_META[item.status] || { label: item.status, color: "var(--faint)" };
  const isEmail = item.channel === "email";
  const action = item.action || "message";
  const isInvite = !isEmail && action === "invite";
  // An approved LinkedIn item is "Ready to send"; one held for an invitation says so; a sent
  // invitation says whether it was accepted.
  const statusLabel = item.status === "approved" && !isEmail
    ? (item.waiting ? "Waits for accept" : "Ready to send")
    : item.status === "sent" && isInvite ? (item.invite_state === "accepted" ? "Accepted" : "Invite sent") : meta.label;
  const statusColor = item.status === "approved" && item.waiting ? "#E7B74B" : meta.color;
  const stepLabel = isInvite ? "Connection request" : action === "reply" ? "Reply" : String(item.step || "").replace(/_/g, " ");

  async function run(fn, okMsg) {
    setBusy(true); setErr("");
    try { const next = await fn(); if (okMsg) showToast(okMsg); onChange(next); }
    catch (e) { setErr((e && e.message) || "Something went wrong."); }
    setBusy(false);
  }

  const msgText = () => (item.subject ? "Subject: " + item.subject + "\n\n" : "") + item.body;
  function copyMsg() {
    try { navigator.clipboard.writeText(msgText()); showToast("Message copied — paste it into the LinkedIn chat"); } catch (e) {}
  }
  // Open the right LinkedIn page for this item in a NEW TAB (the app stays put so you can keep
  // prospecting) — the composer, their profile for an invitation, or the thread for a reply —
  // and copy the text so you paste it straight in. Falls back to a name search with no link. The item stays here (Ready to
  // send) until you press Send on LinkedIn and click "Mark sent".
  function openChat() {
    copyMsg();
    window.open(linkedinUrlFor(item), "_blank", "noopener");
  }
  // Reliable fallback: just open the profile page (its "Message" button always works).
  function openProfile() {
    copyMsg();
    const profile = (item.linkedin_url || "").trim();
    const url = profile || ("https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent(item.lead_label || ""));
    window.open(url, "_blank", "noopener");
  }

  return (
    <div className="mcard" style={{ gap: 11 }}>
      <div className="mctop">
        <ChannelChip channel={item.channel} />
        {stepLabel && <span className="chip idx" style={{ textTransform: "capitalize" }}>{stepLabel}</span>}
        <span style={{ fontWeight: 700, fontSize: 13.5, color: "var(--text)" }}>{item.lead_label || "Untitled lead"}</span>
        <span className="chip" style={{ marginLeft: "auto", background: "transparent", borderColor: statusColor + "66", color: statusColor }}>{statusLabel}</span>
      </div>

      {item.subject && <div className="msubj"><span className="msubj-l">Subject</span>{item.subject}</div>}
      <div className="mbody" style={{ maxHeight: 168, overflow: "auto" }}>{item.body}</div>
      <FromAccount item={item} accounts={accounts} busy={busy} run={run} />

      {item.status === "sent" && <div className="hint" style={{ color: "var(--muted)" }}>Sent {fmt(item.sent_at)}{item.channel === "email" && item.to_email ? " · " + item.to_email : ""}</div>}
      {/* A sent row carrying an error is an UNCONFIRMED agent send — it's marked sent so it can
          never be auto-repeated, but a human needs to check the thread. Don't hide this. */}
      {item.status === "sent" && item.error && <div className="err">{item.error}</div>}
      {item.status === "approved" && isEmail && <div className="hint" style={{ color: "var(--muted)" }}>Auto-sends {item.scheduled_at ? fmt(item.scheduled_at) : "shortly"} → {item.to_email}</div>}
      {item.status === "approved" && !isEmail && item.waiting && <div className="hint" style={{ color: "var(--muted)" }}>Sends automatically once {item.lead_label || "they"} accepts your connection request. LinkedIn won't let you message them before that.</div>}
      {item.status === "approved" && !isEmail && !item.waiting && <div className="hint" style={{ color: "var(--muted)" }}>{isInvite
        ? "The agent sends this as a connection request with this note. By hand: open their profile, press Connect, Add a note, paste, Send, then mark it sent."
        : "The agent sends this when it's running. By hand: open the chat (it copies the message), paste it in and press Send, then mark it sent."}</div>}
      {item.status === "sent" && isInvite && item.invite_state !== "accepted" && <div className="hint" style={{ color: "var(--muted)" }}>Waiting for them to accept. The agent checks your new connections about once an hour.</div>}
      {item.status === "failed" && <div className="err">{item.error || "Send failed."}</div>}
      {err && <div className="err">{err}</div>}

      <div className="mact" style={{ flexWrap: "wrap" }}>
        {/* Pending: approve (email needs a recipient first; approving an email schedules the auto-send). */}
        {item.status === "pending" && (
          <>
            {isEmail && (
              <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@company.com" type="email"
                style={{ flex: "1 1 220px", minWidth: 0, padding: "8px 11px", fontSize: 12.5, borderRadius: 9 }} />
            )}
            <button className="btn primary sm" disabled={busy} onClick={() => run(() => approveQueued(item.id, { toEmail: isEmail ? to : undefined }), isEmail ? "Approved — sending automatically" : "Approved — ready to send")} style={{ marginLeft: isEmail ? 0 : "auto" }}>
              {busy ? "…" : isEmail ? "Approve & auto-send" : "Approve"}
            </button>
            <button className="iconbtn" disabled={busy} onClick={() => run(() => skipQueued(item.id).then(() => ({ ...item, status: "skipped" })), "Skipped")}>Skip</button>
          </>
        )}

        {/* Approved email: it auto-sends, but allow send-now. */}
        {item.status === "approved" && isEmail && (
          <>
            <button className="btn ai sm" disabled={busy} onClick={() => run(() => sendQueuedNow(item.id), "Sent")} style={{ marginLeft: "auto" }}>{busy ? "Sending…" : "Send now"}</button>
            <button className="iconbtn" disabled={busy} onClick={() => run(() => skipQueued(item.id).then(() => ({ ...item, status: "skipped" })), "Skipped")}>Cancel</button>
          </>
        )}

        {/* Approved LinkedIn: human hand-off. Open profile + copy, you paste & press Send on LinkedIn,
            then mark sent. The item is kept here until you do. */}
        {item.status === "approved" && !isEmail && (
          <>
            <button className="btn ghost sm" disabled={busy} onClick={copyMsg}>Copy</button>
            {!isInvite && <button className="btn ghost sm" disabled={busy} onClick={openProfile}>Profile</button>}
            {item.waiting && <button className="btn ghost sm" disabled={busy} onClick={() => run(() => sendWithoutWaiting(item.id).then((x) => ({ ...item, ...x, waiting: false })), "It will send without waiting")}>Send without waiting</button>}
            <button className="btn ai sm" disabled={busy} onClick={openChat} style={{ marginLeft: "auto" }}>{isInvite ? "Open profile & copy" : action === "reply" ? "Open conversation & copy" : "Open chat & copy"}</button>
            <button className="btn primary sm" disabled={busy} onClick={() => run(() => markQueuedSent(item.id), "Marked sent")}>Mark sent</button>
            <button className="iconbtn" disabled={busy} onClick={() => run(() => skipQueued(item.id).then(() => ({ ...item, status: "skipped" })), "Skipped")}>Skip</button>
          </>
        )}

        {/* Failed: retry (re-approve) or skip. */}
        {item.status === "failed" && (
          <>
            <button className="btn primary sm" disabled={busy} onClick={() => run(() => approveQueued(item.id, { toEmail: isEmail ? (to || item.to_email) : undefined }), "Retrying")} style={{ marginLeft: "auto" }}>Retry</button>
            <button className="iconbtn" disabled={busy} onClick={() => run(() => skipQueued(item.id).then(() => ({ ...item, status: "skipped" })), "Skipped")}>Skip</button>
          </>
        )}
      </div>
    </div>
  );
}

// One LinkedIn conversation that needs an answer. The AI drafts a reply as soon as the card
// appears (once per new message from them — the draft is saved with the thread, so it isn't
// paid for again); the person edits it and approves. Nothing is sent before that.
function ThreadCard({ thread, sender, onChanged, showToast, multi }) {
  const fresh = thread.draft && thread.draft_for === thread.last_text ? thread.draft : "";
  const [text, setText] = useState(fresh);
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const asked = useRef("");
  const open = thread.needs_reply && !thread.reply_queued;

  async function draft() {
    asked.current = thread.last_text;
    setDrafting(true); setErr("");
    try {
      const d = await draftReply(thread, sender);
      setText(d);
      saveThreadDraft(thread.id, d, thread.last_text).catch(() => {});
    } catch (e) { setErr((e && e.message) || "Couldn't draft a reply."); }
    setDrafting(false);
  }
  // A new message from them: start again from a new draft.
  useEffect(() => {
    if (!open) return;
    const saved = thread.draft && thread.draft_for === thread.last_text;
    if (saved) { if (asked.current !== thread.last_text) { setText(thread.draft); asked.current = thread.last_text; } return; }
    if (asked.current !== thread.last_text) draft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.last_text, open]);

  async function run(fn, ok) {
    setBusy(true); setErr("");
    try { await fn(); if (ok) showToast(ok); onChanged(); }
    catch (e) { setErr((e && e.message) || "Something went wrong."); }
    setBusy(false);
  }
  const msgs = (thread.messages || []).slice(-4);
  return (
    <div className="mcard" style={{ gap: 10 }}>
      <div className="mctop">
        <span className="chip" style={{ background: "rgba(74,134,200,.16)", borderColor: "rgba(74,134,200,.34)", color: "var(--ice)" }}>LinkedIn</span>
        <span style={{ fontWeight: 700, fontSize: 13.5, color: "var(--text)" }}>{thread.name || thread.lead_label}</span>
        {multi && thread.account_label && <span className="chip idx" title="The LinkedIn account this conversation is on; the reply goes from it">{thread.account_label}</span>}
        <span className="chip" style={{ marginLeft: "auto", background: "transparent",
          borderColor: (open ? "#E7B74B" : "#52d39e") + "66", color: open ? "#E7B74B" : "#52d39e" }}>
          {thread.reply_queued ? "Reply queued" : open ? "Needs a reply" : "Answered"}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflow: "auto" }}>
        {msgs.map((m, i) => (
          <div key={i} style={{ alignSelf: m.from === "me" ? "flex-end" : "flex-start", maxWidth: "88%", padding: "7px 11px", borderRadius: 12,
            fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap",
            background: m.from === "me" ? "rgba(74,134,200,.18)" : "rgba(255,255,255,.06)", color: "var(--text)" }}>
            {m.text}
          </div>
        ))}
      </div>
      {open && (
        <>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} disabled={drafting}
            placeholder={drafting ? "Drafting a reply…" : "Your reply"}
            style={{ width: "100%", padding: "9px 11px", fontSize: 13, borderRadius: 9, resize: "vertical", boxSizing: "border-box" }} />
          {err && <div className="err">{err}</div>}
          <div className="mact" style={{ flexWrap: "wrap" }}>
            <button className="btn ghost sm" disabled={busy || drafting} onClick={draft}>{drafting ? "Drafting…" : text ? "Redraft" : "Draft with AI"}</button>
            {thread.thread_url && <button className="btn ghost sm" onClick={() => window.open(thread.thread_url, "_blank", "noopener")}>Open on LinkedIn</button>}
            <button className="btn primary sm" style={{ marginLeft: "auto" }} disabled={busy || drafting || !text.trim()}
              onClick={() => run(() => approveReply(thread.id, text), "Approved. The agent sends it into the conversation")}>Approve &amp; send</button>
            <button className="iconbtn" disabled={busy} onClick={() => run(() => setThreadHandled(thread.id, true), "Marked done")}>Done</button>
          </div>
        </>
      )}
      {!open && !thread.reply_queued && (
        <div className="mact"><button className="iconbtn" style={{ marginLeft: "auto" }} disabled={busy}
          onClick={() => run(() => setThreadHandled(thread.id, false))}>Reply anyway</button></div>
      )}
    </div>
  );
}

// One person who accepted a connection request. The agent copied their profile; this card
// reads it, analyses them, saves both to the lead and drafts a first message — once, the
// draft is kept with the invitation — then a person edits it and approves. Nothing is sent
// before that.
function FollowupCard({ f, sender, onChanged, showToast }) {
  const [text, setText] = useState(f.followup_draft || "");
  const [step, setStep] = useState("");
  const [persona, setPersona] = useState((f.p_data && f.p_data.analysis && f.p_data.analysis.persona) || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const started = useRef(false);
  const ready = f.followup_state !== "needs_profile";

  async function prepare() {
    started.current = true;
    setErr(""); setStep("Starting…");
    try {
      const r = await prepareFollowup(f, sender, setStep);
      setText(r.message);
      if (r.analysis && r.analysis.persona) setPersona(r.analysis.persona);
      await saveFollowupDraft(f.id, r.message).catch(() => {});
    } catch (e) { setErr((e && e.message) || "Couldn't draft a message."); }
    setStep("");
  }
  useEffect(() => {
    if (ready && !f.followup_draft && !started.current) prepare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  async function run(fn, ok) {
    setBusy(true); setErr("");
    try { await fn(); if (ok) showToast(ok); onChanged(); }
    catch (e) { setErr((e && e.message) || "Something went wrong."); }
    setBusy(false);
  }
  const name = f.lead_label || f.p_label || "Your new connection";
  return (
    <div className="mcard" style={{ gap: 10 }}>
      <div className="mctop">
        <span className="chip" style={{ background: "rgba(74,134,200,.16)", borderColor: "rgba(74,134,200,.34)", color: "var(--ice)" }}>LinkedIn</span>
        <span className="chip idx">First message</span>
        <span style={{ fontWeight: 700, fontSize: 13.5, color: "var(--text)" }}>{name}</span>
        <span className="chip" style={{ marginLeft: "auto", background: "transparent", borderColor: "#52d39e66", color: "#52d39e" }}>Accepted</span>
      </div>
      {f.p_sub && <div className="hint" style={{ color: "var(--muted)", margin: 0 }}>{f.p_sub}</div>}
      {persona && <div className="hint" style={{ color: "var(--muted)", margin: 0 }}><span><b>Analysis:</b> {persona}</span></div>}
      {!ready && <div className="hint" style={{ color: "var(--muted)" }}>They accepted. The agent copies their profile on its next round (about hourly), then a first message is drafted here.</div>}
      {ready && (
        <>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} disabled={!!step}
            placeholder={step || "Your first message"}
            style={{ width: "100%", padding: "9px 11px", fontSize: 13, borderRadius: 9, resize: "vertical", boxSizing: "border-box" }} />
          {step && <div className="hint" style={{ color: "var(--muted)", margin: 0 }}>{step}</div>}
        </>
      )}
      {err && <div className="err">{err}</div>}
      <div className="mact" style={{ flexWrap: "wrap" }}>
        {ready && <button className="btn ghost sm" disabled={busy || !!step} onClick={prepare}>{step ? "Working…" : text ? "Redraft" : "Draft with AI"}</button>}
        {f.linkedin_url && <button className="btn ghost sm" onClick={() => window.open(f.linkedin_url, "_blank", "noopener")}>Profile</button>}
        {ready && <button className="btn primary sm" style={{ marginLeft: "auto" }} disabled={busy || !!step || !text.trim()}
          onClick={() => run(() => approveFollowup(f.id, text), "Approved. The agent sends it to " + name)}>Approve &amp; send</button>}
        <button className="iconbtn" style={ready ? undefined : { marginLeft: "auto" }} disabled={busy} onClick={() => run(() => skipFollowup(f.id), "Skipped")}>Skip</button>
      </div>
    </div>
  );
}

function FollowupsPanel({ followups, sender, onChanged, showToast }) {
  if (!followups || !followups.length) return null;
  return (
    <div style={{ marginBottom: 22 }}>
      <div className="sect-title" style={{ marginBottom: 10 }}>New connections <span style={{ color: "var(--faint)", fontWeight: 600 }}>· {followups.length} to welcome</span></div>
      <div className="grid2">{followups.map((f) => <FollowupCard key={f.id} f={f} sender={sender} onChanged={onChanged} showToast={showToast} />)}</div>
    </div>
  );
}

// Who the AI writes as, for replies and first messages. Remembered on this browser.
const SENDER_KEY = "kc_reply_sender";
function SenderPick({ senderId, onPick }) {
  return (
    <label style={{ fontSize: 12.5, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", flexShrink: 0 }}>
      AI writes as
      <select value={senderId} onChange={(e) => onPick(e.target.value)} style={{ padding: "5px 8px", fontSize: 12.5, borderRadius: 8 }}>
        {SENDERS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
  );
}

function RepliesPanel({ threads, sender, onChanged, showToast, multi }) {
  const [showAll, setShowAll] = useState(false);
  if (!threads || !threads.length) return null;
  const needs = threads.filter((t) => t.needs_reply && !t.reply_queued);
  const rest = threads.filter((t) => !(t.needs_reply && !t.reply_queued));
  return (
    <div style={{ marginBottom: 22 }}>
      <div className="toprow" style={{ marginBottom: 10, flexWrap: "wrap", gap: 10 }}>
        <div className="sect-title" style={{ margin: 0 }}>LinkedIn replies <span style={{ color: "var(--faint)", fontWeight: 600 }}>· {needs.length} to answer</span></div>
      </div>
      {needs.length > 0
        ? <div className="grid2">{needs.map((t) => <ThreadCard key={t.id} thread={t} sender={sender} onChanged={onChanged} showToast={showToast} multi={multi} />)}</div>
        : <div className="hint" style={{ color: "var(--muted)" }}>No replies waiting. The agent checks your LinkedIn inbox about every 15 minutes while it's running.</div>}
      {rest.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button className="iconbtn" onClick={() => setShowAll(!showAll)}>{showAll ? "Hide" : "Show"} {rest.length} answered conversation{rest.length === 1 ? "" : "s"}</button>
          {showAll && <div className="grid2" style={{ marginTop: 10 }}>{rest.map((t) => <ThreadCard key={t.id} thread={t} sender={sender} onChanged={onChanged} showToast={showToast} multi={multi} />)}</div>}
        </div>
      )}
    </div>
  );
}

// Status strip for the LinkedIn agent: each account, whether it's on, how much of today's cap it
// has used, and why it stopped if it stopped. Pause all is the kill switch — the next time the
// PC checks in it closes every browser. Everything else (one account at a time, PCs, dry run,
// limits, the log) is on the LinkedIn agent page.
function AgentStrip({ status, onToggle, busy, onOpenAgent }) {
  if (!status || !Array.isArray(status.accounts)) return null;
  const { accounts, enabled, ready = 0, waiting = 0, inflight = 0, needReply = 0, firstMessages = 0 } = status;
  // "Live" means the PC has actually checked in for that account recently (it does every 15
  // seconds) — switched on with no PC answering is a common and confusing state, so name it.
  const stateOf = (a) => {
    const online = !!a.worker && !!a.lastSeenAt && (Date.now() - new Date(a.lastSeenAt).getTime()) / 1000 < 90;
    if (a.haltReason) return { tone: "#e24a4a", label: "Stopped", online };
    if (a.enabled && online) return a.dryRun ? { tone: "#7C5CFF", label: "Dry run", online } : { tone: "#52d39e", label: "Running", online };
    if (a.enabled) return { tone: "#E7B74B", label: "PC offline", online };
    return { tone: "var(--faint)", label: "Paused", online };
  };
  const states = accounts.map(stateOf);
  const running = accounts.filter((a, i) => a.enabled && states[i].online).length;
  const stopped = accounts.filter((a) => a.haltReason);
  const offline = accounts.filter((a, i) => a.enabled && !states[i].online && !a.haltReason);
  const tone = stopped.length ? "#e24a4a" : running ? "#52d39e" : enabled ? "#E7B74B" : "var(--faint)";
  const one = accounts.length === 1;

  return (
    <div className="panel" style={{ marginBottom: 16, borderColor: tone + "44" }}>
      <div className="toprow" style={{ margin: 0, flexWrap: "wrap", gap: 10 }}>
        <span className="chip" style={{ background: "transparent", borderColor: tone + "66", color: tone }}>
          LinkedIn agent · {one ? states[0].label : running + " of " + accounts.length + " running"}
        </span>
        <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
          {ready ? ready + " ready" : "Nothing ready"}{waiting ? " · " + waiting + " waiting for accept" : ""}{inflight ? " · " + inflight + " in flight" : ""}
          {needReply ? " · " + needReply + (needReply === 1 ? " reply" : " replies") + " to answer" : ""}
          {firstMessages ? " · " + firstMessages + " new connection" + (firstMessages === 1 ? "" : "s") + " to welcome" : ""}
        </span>
        <button className="btn sm ghost" onClick={onOpenAgent} style={{ marginLeft: "auto" }}>Agent controls →</button>
        <button className={"btn sm " + (enabled ? "ghost" : "primary")} disabled={busy}
          onClick={() => onToggle(!enabled)}>
          {busy ? "…" : enabled ? (one ? "Pause" : "Pause all") : stopped.length ? "Clear & start" + (one ? "" : " all") : one ? "Start" : "Start all"}
        </button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        {accounts.map((a, i) => {
          const c = a.counts || {}, L = a.limits || {};
          return (
            <span key={a.id} className="chip" title={(a.worker && a.worker.linkedin && a.worker.linkedin.name) || ""}
              style={{ background: "transparent", borderColor: states[i].tone + "55", color: "var(--text)", fontWeight: 500 }}>
              <span style={{ color: states[i].tone }}>●</span>&nbsp;{a.label} · {states[i].label} · {c.day ?? 0}/{L.perDay ?? "?"} msgs · {a.invites ? a.invites.today + "/" + a.invites.target + " invites today" : (c.invDay ?? 0) + "/" + (L.invitesPerDay ?? "?") + " invites"}
            </span>
          );
        })}
      </div>
      {stopped.map((a) => (
        <div key={a.id} className="err" style={{ marginTop: 10 }}>
          {one ? "" : a.label + ": "}{a.haltReason} It stopped itself. Check LinkedIn for that account on its PC, then start it again.
        </div>
      ))}
      {offline.length > 0 && (
        <div className="hint" style={{ marginTop: 10, color: "var(--muted)" }}>
          No PC is answering{one ? "" : " for " + offline.map((a) => a.label).join(", ")}. Make sure the agent's PC is on, or connect one in <b>Agent controls</b>.
        </div>
      )}
    </div>
  );
}

export function SendQueueView({ showToast, onOpenAgent }) {
  const [items, setItems] = useState(null);
  const [sendingOn, setSendingOn] = useState(true);
  const [err, setErr] = useState("");
  const [session, setSession] = useState(null); // blitz mode: { order: [ids], idx }
  const [agent, setAgent] = useState(null);     // LinkedIn agent status, null until first load
  const [agentBusy, setAgentBusy] = useState(false);
  const [threads, setThreads] = useState([]);      // LinkedIn conversations with prospects
  const [followups, setFollowups] = useState([]);  // accepted connections waiting for a first message
  const [senderId, setSenderId] = useState(() => { try { return localStorage.getItem(SENDER_KEY) || SENDERS[0].id; } catch (e) { return SENDERS[0].id; } });
  const sender = SENDERS.find((x) => x.id === senderId) || SENDERS[0];
  const pickSender = (id) => { setSenderId(id); try { localStorage.setItem(SENDER_KEY, id); } catch (e) {} };
  const accounts = (agent && agent.accounts) || []; // the LinkedIn accounts on the agent

  function load() {
    listQueue().then(({ items, sendingOn }) => { setItems(items); setSendingOn(sendingOn); })
      .catch((e) => setErr((e && e.message) || "Could not load the queue."));
    // The agent strip is best-effort: an older server without the agent endpoints just hides it.
    agentStatus().then(setAgent).catch(() => setAgent(null));
    listInbox().then(setThreads).catch(() => {});
    listFollowups().then(setFollowups).catch(() => {});
  }
  useEffect(() => { load(); /* refresh periodically so auto-sent items flip to Sent */
    const t = setInterval(load, 15000); return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleAgent(next) {
    setAgentBusy(true);
    try {
      setAgent(await setAgentEnabled(next, "all"));
      showToast(next ? "Agent on. It sends the ready LinkedIn invitations and messages" : "Agent paused");
    } catch (e) { setErr((e && e.message) || "Could not change the agent."); }
    setAgentBusy(false);
  }

  function patch(next) {
    if (!next) return;
    setItems((cur) => (cur || []).map((it) => (it.id === next.id ? next : it)));
  }

  const list = items || [];
  const readyLinked = list.filter((it) => it.status === "approved" && it.channel === "linkedin" && !it.waiting);

  // ── Blitz mode: walk through every Ready LinkedIn item, opening its chat + copying as you go.
  // This is the fastest the human-send model can go — paste + Send + "Sent & next", repeat.
  function openChatFor(it) {
    if (!it) return;
    const text = (it.subject ? "Subject: " + it.subject + "\n\n" : "") + it.body;
    try { navigator.clipboard.writeText(text); } catch (e) {}
    window.open(linkedinUrlFor(it), "_blank", "noopener");
  }
  function startSession() {
    if (!readyLinked.length) return;
    setSession({ order: readyLinked.map((it) => it.id), idx: 0 });
    openChatFor(readyLinked[0]);
    showToast("Blitz: opened " + (readyLinked[0].lead_label || "lead") + " — paste, Send, then Sent & next");
  }
  async function sentAndNext() {
    if (!session) return;
    const cur = list.find((it) => it.id === session.order[session.idx]);
    if (cur) { try { await markQueuedSent(cur.id); } catch (e) {} patch({ ...cur, status: "sent", sent_at: new Date().toISOString() }); }
    let n = session.idx + 1;
    while (n < session.order.length) { const it = list.find((x) => x.id === session.order[n]); if (it && it.status === "approved") break; n++; }
    if (n >= session.order.length) { setSession(null); showToast("Blitz done — all opened. Mark any stragglers manually."); return; }
    setSession({ ...session, idx: n });
    openChatFor(list.find((x) => x.id === session.order[n]));
  }
  const sessionItem = session ? list.find((it) => it.id === session.order[session.idx]) : null;

  const groups = [
    ["pending", "Needs your approval"],
    ["approved", "Scheduled & ready"],
    ["sending", "Sending"],
    ["sent", "Sent"],
    ["failed", "Failed"],
  ];

  return (
    <div>
      <div className="head"><div className="eyebrow">Outreach</div><h2>Send queue</h2><p>Approve a message and it goes out. Email sends automatically. On LinkedIn the agent sends your connection requests; when someone accepts, it copies their profile so Karma Connect can analyse them and draft a first message; and it brings their replies here with an AI draft. You approve every message. No agent? Blitz mode walks you through them by hand.</p></div>

      {!sendingOn && <div className="hint" style={{ marginBottom: 14 }}>Email auto-send is off on this server (no email provider configured). Items will queue but won't send until it's set up.</div>}
      {err && <div className="err">{err}</div>}

      <AgentStrip status={agent} onToggle={toggleAgent} busy={agentBusy} onOpenAgent={onOpenAgent} />

      {(threads.length > 0 || followups.length > 0) && (
        <div className="toprow" style={{ marginBottom: 10, justifyContent: "flex-end" }}><SenderPick senderId={sender.id} onPick={pickSender} /></div>
      )}
      <FollowupsPanel followups={followups} sender={sender} onChanged={load} showToast={showToast} />
      <RepliesPanel threads={threads} sender={sender} onChanged={load} showToast={showToast} multi={accounts.length > 1} />

      {/* Blitz launcher: rip through all Ready LinkedIn items, one paste-and-send at a time. */}
      {!session && readyLinked.length > 0 && (
        <div className="toprow" style={{ marginBottom: 16 }}>
          <button className="btn ai" onClick={startSession}>⚡ Blitz {readyLinked.length} LinkedIn message{readyLinked.length > 1 ? "s" : ""}</button>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>Opens each chat + copies in turn — you just paste, Send, and tap “Sent &amp; next”.</span>
        </div>
      )}

      {/* Active blitz session panel. */}
      {session && sessionItem && (
        <div className="panel ai" style={{ marginBottom: 18, position: "sticky", top: 10, zIndex: 20 }}>
          <div className="sect-title" style={{ marginBottom: 10 }}>Blitz · {session.idx + 1} of {session.order.length} · <span style={{ color: "var(--text)" }}>{sessionItem.lead_label}</span></div>
          <div className="mbody" style={{ maxHeight: 120, overflow: "auto", marginBottom: 12 }}>{sessionItem.body}</div>
          <div className="toprow" style={{ margin: 0 }}>
            <button className="btn ghost sm" onClick={() => openChatFor(sessionItem)}>Re-open chat &amp; copy</button>
            <button className="btn primary sm" onClick={sentAndNext} style={{ marginLeft: "auto" }}>Sent &amp; next →</button>
            <button className="iconbtn" onClick={() => setSession(null)}>Stop</button>
          </div>
        </div>
      )}
      {items == null && !err && <div className="panel" style={{ color: "var(--muted)" }}>Loading…</div>}

      {items && list.length === 0 && (
        <div className="empty">
          <h3>Nothing queued yet</h3>
          <p>Generate a message in any outreach engine, then use “Queue to send” on it. Approved messages show up here for the agent to send.</p>
        </div>
      )}

      {groups.map(([key, title]) => {
        const rows = list.filter((it) => it.status === key);
        if (!rows.length) return null;
        return (
          <div key={key} style={{ marginBottom: 20 }}>
            <div className="sect-title">{title} <span style={{ color: "var(--faint)", fontWeight: 600 }}>· {rows.length}</span></div>
            <div className="grid2">
              {rows.map((it) => <QueueItem key={it.id} item={it} onChange={patch} showToast={showToast} accounts={accounts} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
