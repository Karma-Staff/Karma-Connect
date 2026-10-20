// Incoming LinkedIn messages, on the LinkedIn agent page. The agent reads every conversation on
// each account (agent/inbox.cjs, readAll) and reports it; this lists them newest first, needing a
// reply on top. Click one: the whole conversation, Research (opens the person in the prospect
// tools — the agent copies their profile and the AI analyses it), and a reply box. Nothing is
// sent until someone presses Approve & send; the agent then sends it into that conversation.
import { useState, useEffect, useRef } from "react";
import { listInbox, saveThreadDraft, approveReply, setThreadHandled } from "../lib/outreach.js";
import { draftReply } from "../lib/replies.js";
import { SENDERS } from "../lib/senders.js";

const SENDER_KEY = "kc_reply_sender"; // shared with the Send Queue's "AI writes as"

function ago(t) {
  if (!t) return "";
  const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
}
const initials = (n) => String(n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const firstName = (n) => String(n || "").split(/\s+/)[0] || "them";
const fromOutreach = (t) => !!t.prospect_id && !String(t.prospect_id).startsWith("li-thread:");
const waiting = (t) => t.needs_reply && !t.reply_queued;

function Thread({ t, multi, onResearch, onChanged, showToast }) {
  const fresh = t.draft && t.draft_for === t.last_text ? t.draft : "";
  const [text, setText] = useState(fresh);
  const [replying, setReplying] = useState(waiting(t) && !!fresh);
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const end = useRef(null);
  useEffect(() => { end.current && end.current.scrollIntoView({ block: "nearest" }); }, [t.id]);
  const sender = (() => { let id = ""; try { id = localStorage.getItem(SENDER_KEY) || ""; } catch (e) {} return SENDERS.find((s) => s.id === id) || SENDERS[0]; })();

  async function draft() {
    setReplying(true); setDrafting(true); setErr("");
    try {
      const d = await draftReply(t, sender);
      setText(d);
      saveThreadDraft(t.id, d, t.last_text).catch(() => {});
    } catch (e) { setErr((e && e.message) || "Couldn't draft a reply."); }
    setDrafting(false);
  }
  async function run(fn, ok) {
    setBusy(true); setErr("");
    try { await fn(); if (ok) showToast(ok); onChanged(); }
    catch (e) { setErr((e && e.message) || "Something went wrong."); }
    setBusy(false);
  }

  return (
    <div className="lia-thread">
      <div className="lia-convo">
        {(t.messages || []).map((m, i) => (
          <div key={i} className={"lia-bubble " + (m.from === "me" ? "me" : "them")}>
            <div className="lia-bubble-who">{m.from === "me" ? "You" : t.name || "Them"}</div>
            {m.text}
          </div>
        ))}
        <div ref={end} />
      </div>

      <div className="lia-thread-act">
        <button className="btn ai sm" onClick={() => onResearch(t)} title={fromOutreach(t)
          ? "Open " + (t.lead_label || t.name) + " in the prospect tools, with this message filled in"
          : "The agent copies their LinkedIn profile and the AI researches them"}>
          Research {firstName(t.name)}
        </button>
        {!replying && !t.reply_queued && <button className="btn ghost sm" disabled={busy} onClick={draft}>Reply</button>}
        {t.thread_url && <button className="btn ghost sm" onClick={() => window.open(t.thread_url, "_blank", "noopener")}>Open on LinkedIn</button>}
        {waiting(t)
          ? <button className="iconbtn" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => run(() => setThreadHandled(t.id, true), "Marked done")}>Mark done</button>
          : !t.reply_queued && <span className="lia-muted" style={{ marginLeft: "auto", fontSize: 12 }}>Answered</span>}
        {t.reply_queued && <span className="lia-muted" style={{ marginLeft: "auto", fontSize: 12 }}>Your reply is queued; the agent sends it shortly</span>}
      </div>

      {replying && !t.reply_queued && (
        <div className="lia-reply">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} disabled={drafting}
            placeholder={drafting ? "Drafting a reply…" : "Write your reply"} />
          <div className="mact" style={{ flexWrap: "wrap" }}>
            <span className="lia-muted" style={{ fontSize: 12 }}>AI writes as {sender.name}{multi && t.account_label ? " · sent from " + t.account_label : ""}</span>
            <button className="btn ghost sm" style={{ marginLeft: "auto" }} disabled={busy || drafting} onClick={draft}>{drafting ? "Drafting…" : text ? "Redraft" : "Draft with AI"}</button>
            <button className="btn primary sm" disabled={busy || drafting || !text.trim()}
              onClick={() => run(() => approveReply(t.id, text), "Approved. The agent sends it into the conversation")}>Approve &amp; send</button>
          </div>
        </div>
      )}
      {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}
    </div>
  );
}

export function IncomingMessages({ accountId, accountLabel, multi, onResearch, showToast }) {
  const [threads, setThreads] = useState(null);
  const [err, setErr] = useState("");
  const [only, setOnly] = useState("all");     // all | reply
  const [mine, setMine] = useState(true);       // this account only
  const [open, setOpen] = useState("");
  const [more, setMore] = useState(false);

  function load() {
    listInbox().then((t) => { setThreads(t || []); setErr(""); }).catch((e) => setErr((e && e.message) || "Could not load the messages."));
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  const all = threads || [];
  const list = all
    .filter((t) => !multi || !mine || !accountId || t.li_account_id === accountId)
    .filter((t) => only === "all" || waiting(t));
  const needCount = all.filter((t) => (!multi || !mine || t.li_account_id === accountId) && waiting(t)).length;
  const shown = more ? list : list.slice(0, 12);

  return (
    <div className="panel" style={{ marginTop: 14 }} id="lia-incoming">
      <div className="toprow" style={{ margin: "0 0 12px", gap: 10 }}>
        <div className="lia-h" style={{ margin: 0 }}>Incoming messages{needCount ? <span className="lia-count">{needCount} to answer</span> : null}</div>
        <div className="seg" role="group" aria-label="Which messages" style={{ marginLeft: "auto" }}>
          <button className={only === "all" ? "on" : ""} onClick={() => setOnly("all")}>All</button>
          <button className={only === "reply" ? "on" : ""} onClick={() => setOnly("reply")}>Needs a reply</button>
        </div>
        {multi && (
          <div className="seg" role="group" aria-label="Which account">
            <button className={mine ? "on" : ""} onClick={() => setMine(true)}>{accountLabel}</button>
            <button className={mine ? "" : "on"} onClick={() => setMine(false)}>All accounts</button>
          </div>
        )}
      </div>
      {err && <div className="err">{err}</div>}
      {threads === null && !err && <div className="lia-muted" style={{ fontSize: 13 }}>Loading…</div>}
      {threads && list.length === 0 && (
        <div className="lia-muted" style={{ fontSize: 13 }}>
          {only === "reply" ? "Nothing waiting for a reply." : "No messages yet. The agent reads the LinkedIn inbox about every 15 minutes while it's running, and every conversation shows up here."}
        </div>
      )}
      <div className="lia-msgs">
        {shown.map((t) => {
          const isOpen = open === t.id;
          const last = t.last_text || "";
          return (
            <div key={t.id} className={"lia-msg" + (isOpen ? " open" : "") + (waiting(t) ? " unread" : "")}>
              <button className="lia-msg-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? "" : t.id)}>
                <span className="lia-av" aria-hidden="true">{initials(t.name)}</span>
                <span className="lia-msg-main">
                  <span className="lia-msg-top">
                    <b>{t.name || t.lead_label || "Someone"}</b>
                    {fromOutreach(t) ? <span className="lia-tag out">Your outreach</span> : <span className="lia-tag new">New contact</span>}
                    {multi && !mine && t.account_label && <span className="lia-tag">{t.account_label}</span>}
                  </span>
                  <span className="lia-msg-text">{t.last_from === "me" ? "You: " : ""}{last}</span>
                </span>
                <span className="lia-msg-side">
                  <span className="lia-msg-at">{ago(t.last_at)}</span>
                  {waiting(t) && <span className="lia-tag need">Needs a reply</span>}
                  {t.reply_queued && <span className="lia-tag">Reply queued</span>}
                </span>
              </button>
              {isOpen && <Thread t={t} multi={multi} onResearch={onResearch} onChanged={load} showToast={showToast} />}
            </div>
          );
        })}
      </div>
      {list.length > 12 && <button className="iconbtn" style={{ marginTop: 10 }} onClick={() => setMore(!more)}>{more ? "Show fewer" : "Show all " + list.length}</button>}
    </div>
  );
}
