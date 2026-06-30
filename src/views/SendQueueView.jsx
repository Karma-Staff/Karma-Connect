// The outreach Send Queue. Approved EMAIL items are auto-sent by the server agent; LINKEDIN
// items wait here for the human one-click hand-off (open LinkedIn + copy, you send, mark sent).
import { useState, useEffect } from "react";
import { listQueue, approveQueued, sendQueuedNow, markQueuedSent, skipQueued } from "../lib/outreach.js";

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

function QueueItem({ item, onChange, showToast }) {
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState(item.to_email || "");
  const [err, setErr] = useState("");
  const meta = STATUS_META[item.status] || { label: item.status, color: "var(--faint)" };
  const isEmail = item.channel === "email";
  // LinkedIn never auto-sends, so an approved LinkedIn item is "Ready to send" (waiting on you).
  const statusLabel = item.status === "approved" && !isEmail ? "Ready to send" : meta.label;

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
  // Pull the public handle out of a profile URL (…/in/<handle>) so we can deep-link to the chat.
  const handleFromUrl = (u) => { const m = String(u || "").match(/linkedin\.com\/in\/([^/?#]+)/i); return m ? m[1] : ""; };
  // Open LinkedIn's message composer for this person in a NEW TAB (the app stays put so you can
  // keep prospecting), and copy the message so you paste it straight into the chat. Falls back to
  // the profile, then a name search, if we don't have a usable link. The item stays here (Ready to
  // send) until you press Send on LinkedIn and click "Mark sent".
  function openChat() {
    copyMsg();
    const handle = handleFromUrl(item.linkedin_url);
    const profile = (item.linkedin_url || "").trim();
    const url = handle
      ? "https://www.linkedin.com/messaging/compose/?recipient=" + encodeURIComponent(handle)
      : (profile || "https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent(item.lead_label || ""));
    window.open(url, "_blank", "noopener");
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
        {item.step && <span className="chip idx" style={{ textTransform: "capitalize" }}>{String(item.step).replace(/_/g, " ")}</span>}
        <span style={{ fontWeight: 700, fontSize: 13.5, color: "var(--text)" }}>{item.lead_label || "Untitled lead"}</span>
        <span className="chip" style={{ marginLeft: "auto", background: "transparent", borderColor: meta.color + "66", color: meta.color }}>{statusLabel}</span>
      </div>

      {item.subject && <div className="msubj"><span className="msubj-l">Subject</span>{item.subject}</div>}
      <div className="mbody" style={{ maxHeight: 168, overflow: "auto" }}>{item.body}</div>

      {item.status === "sent" && <div className="hint" style={{ color: "var(--muted)" }}>Sent {fmt(item.sent_at)}{item.channel === "email" && item.to_email ? " · " + item.to_email : ""}</div>}
      {item.status === "approved" && isEmail && <div className="hint" style={{ color: "var(--muted)" }}>Auto-sends {item.scheduled_at ? fmt(item.scheduled_at) : "shortly"} → {item.to_email}</div>}
      {item.status === "approved" && !isEmail && <div className="hint" style={{ color: "var(--muted)" }}>Opens the chat in a new tab and copies this message — paste it in and press Send when you're ready. Keep working here meanwhile; it stays in the queue until you mark it sent.</div>}
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
            <button className="btn ghost sm" disabled={busy} onClick={openProfile}>Profile</button>
            <button className="btn ai sm" disabled={busy} onClick={openChat} style={{ marginLeft: "auto" }}>Open chat &amp; copy</button>
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

export function SendQueueView({ showToast }) {
  const [items, setItems] = useState(null);
  const [sendingOn, setSendingOn] = useState(true);
  const [err, setErr] = useState("");
  const [session, setSession] = useState(null); // blitz mode: { order: [ids], idx }

  function load() {
    listQueue().then(({ items, sendingOn }) => { setItems(items); setSendingOn(sendingOn); })
      .catch((e) => setErr((e && e.message) || "Could not load the queue."));
  }
  useEffect(() => { load(); /* refresh periodically so auto-sent items flip to Sent */
    const t = setInterval(load, 15000); return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function patch(next) {
    if (!next) return;
    setItems((cur) => (cur || []).map((it) => (it.id === next.id ? next : it)));
  }

  const list = items || [];
  const readyLinked = list.filter((it) => it.status === "approved" && it.channel === "linkedin");

  // ── Blitz mode: walk through every Ready LinkedIn item, opening its chat + copying as you go.
  // This is the fastest the human-send model can go — paste + Send + "Sent & next", repeat.
  function openChatFor(it) {
    if (!it) return;
    const text = (it.subject ? "Subject: " + it.subject + "\n\n" : "") + it.body;
    try { navigator.clipboard.writeText(text); } catch (e) {}
    const m = String(it.linkedin_url || "").match(/linkedin\.com\/in\/([^/?#]+)/i);
    const url = m ? "https://www.linkedin.com/messaging/compose/?recipient=" + encodeURIComponent(m[1])
      : (it.linkedin_url || "https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent(it.lead_label || ""));
    window.open(url, "_blank", "noopener");
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
      <div className="head"><div className="eyebrow">Outreach</div><h2>Send queue</h2><p>Approve a message and the agent sends it — email goes out automatically; LinkedIn opens for a one-click human send (keeps accounts safe).</p></div>

      {!sendingOn && <div className="hint" style={{ marginBottom: 14 }}>Email auto-send is off on this server (no email provider configured). Items will queue but won't send until it's set up.</div>}
      {err && <div className="err">{err}</div>}

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
              {rows.map((it) => <QueueItem key={it.id} item={it} onChange={patch} showToast={showToast} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
