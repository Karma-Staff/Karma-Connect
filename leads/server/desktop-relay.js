"use strict";
/* Every call goes through the Karma Connect Dialer desktop app (desktop/).

   The browser no longer runs a phone of its own. When a rep presses Call in
   the browser, the number is handed to the dialer app on their PC through
   here, and the app places the call; when the call ends and the rep saves the
   disposition, the app reports back, so a power-dialer session running in the
   browser moves on to the next lead exactly as it did when the browser dialled.

     browser   GET  /api/voice/desktop/status         is my dialer app online?
               POST /api/voice/desktop/call           ring this number on it
               GET  /api/voice/desktop/events?after=  what happened (long poll)
     app       GET  /api/voice/desktop/wait           calls for me (long poll)
               POST /api/voice/desktop/event          accepted / refused / ended / wrapped

   Why the server and not a karmaconnect://call link: a link can be followed
   by ANY website, which could then ring any number on the rep's line. Here the
   app only takes calls from the rep's own signed-in Karma Connect.

   Held in memory, like the live board (live.js): a call request is worth
   something for a few seconds and nothing after, and one process serves the
   site. A restart empties it; the app's next poll is back within seconds.

   CALLS_VIA_DESKTOP=0 turns it off: the browser dials by itself again. */

const express = require("express");
const { requireUser } = require("./auth");

const REQUIRED = process.env.CALLS_VIA_DESKTOP !== "0";
const WAIT_MS = 25 * 1000;          // one long poll
const ONLINE_MS = 40 * 1000;        // an app not seen for this long is offline
const CALL_TTL_MS = 20 * 1000;      // a call not picked up by then is dropped — never rung late
const EVENT_TTL_MS = 2 * 60 * 1000;
const EVENT_KINDS = new Set(["accepted", "refused", "ended", "wrapped"]);
const OUTCOMES = new Set(["connected", "no-answer", "busy", "failed", "cancelled", "placed"]);

function createRelay({ now = () => Date.now() } = {}) {
  const desks = new Map();          // userId -> { seen, registered, waiters: [], queue: [] }
  const feeds = new Map();          // userId -> { seq, events: [], waiters: [] }
  let nextId = 1;

  const desk = (uid) => {
    let d = desks.get(uid);
    if (!d) desks.set(uid, d = { seen: 0, registered: false, waiters: [], queue: [] });
    return d;
  };
  const feed = (uid) => {
    let f = feeds.get(uid);
    if (!f) feeds.set(uid, f = { seq: 0, events: [], waiters: [] });
    return f;
  };
  const fresh = (d) => { d.queue = d.queue.filter((c) => now() - c.at < CALL_TTL_MS); return d.queue; };

  function online(uid) {
    const d = desks.get(uid);
    return !!d && (d.waiters.length > 0 || now() - d.seen < ONLINE_MS);
  }
  function status(uid) {
    const d = desks.get(uid);
    const on = online(uid);
    return { required: REQUIRED, online: on, registered: on && !!d?.registered };
  }

  /* The app asks for work. Answers at once with anything queued, otherwise
     holds the request until a call arrives or the poll times out. Returns a
     function that drops the waiter (the request closed). */
  function wait(uid, { registered }, reply, timeoutMs = WAIT_MS) {
    const d = desk(uid);
    d.seen = now();
    d.registered = !!registered;
    const q = fresh(d);
    if (q.length) { d.queue = []; reply(q); return () => {}; }
    const w = { reply, timer: null };
    const drop = () => {
      clearTimeout(w.timer);
      d.waiters = d.waiters.filter((x) => x !== w);
      d.seen = now();                 // it was there until just now
    };
    w.timer = setTimeout(() => { drop(); reply([]); }, timeoutMs);
    d.waiters.push(w);
    return drop;
  }

  /* The browser asks for a call. null = no app online to take it. */
  function call(uid, { number, name, leadId, campaign }) {
    if (!online(uid)) return null;
    const c = { id: String(nextId++), type: "call", at: now(), number, name, leadId, campaign };
    const d = desk(uid);
    // the newest poll is the app that is surely still there
    const w = d.waiters.pop();
    if (w) { clearTimeout(w.timer); d.seen = now(); w.reply([c]); }
    else d.queue.push(c);
    return c;
  }

  function event(uid, ev) {
    const f = feed(uid);
    const e = { ...ev, seq: ++f.seq, at: now() };
    f.events = f.events.filter((x) => now() - x.at < EVENT_TTL_MS).concat(e).slice(-50);
    const ws = f.waiters; f.waiters = [];
    for (const w of ws) { clearTimeout(w.timer); w.reply([e], f.seq); }
    return e;
  }

  /* The browser waits for what the app reported after `after`. */
  function events(uid, after, reply, timeoutMs = WAIT_MS) {
    const f = feed(uid);
    f.events = f.events.filter((x) => now() - x.at < EVENT_TTL_MS);
    // after=-1: the browser just loaded and only wants the cursor, not old news
    if (after < 0) { reply([], f.seq); return () => {}; }
    const pending = f.events.filter((e) => e.seq > after);
    if (pending.length || after > f.seq) { reply(pending, f.seq); return () => {}; }
    const w = { reply, timer: null };
    const drop = () => { clearTimeout(w.timer); f.waiters = f.waiters.filter((x) => x !== w); };
    w.timer = setTimeout(() => { drop(); reply([], f.seq); }, timeoutMs);
    f.waiters.push(w);
    return drop;
  }

  return { status, online, wait, call, event, events };
}

/* What a browser may ask for. The number must look like a phone number, and
   everything else is trimmed to what the app shows and logs. */
function cleanCall(b) {
  const number = String(b?.number || "").replace(/[^0-9+]/g, "");
  if (!/^\+?\d{3,16}$/.test(number)) return null;
  const leadId = Number.isInteger(b?.leadId) && b.leadId !== 0 ? b.leadId : null;
  const cb = b?.campaign?.callback;
  const campaign = b?.campaign && typeof b.campaign.name === "string" ? {
    name: b.campaign.name.slice(0, 200),
    callback: cb && (cb.number || cb.ext) ? {
      number: String(cb.number || "").replace(/[^0-9+]/g, "").slice(0, 16) || null,
      ext: String(cb.ext || "").replace(/\D/g, "").slice(0, 10) || null,
    } : null,
  } : null;
  return { number, name: String(b?.name || "").slice(0, 200), leadId, campaign };
}

function cleanEvent(b) {
  if (!EVENT_KINDS.has(b?.kind)) return null;
  const e = { kind: b.kind, ref: String(b.ref || "").slice(0, 20) || null };
  if (Number.isInteger(b.leadId) && b.leadId !== 0) e.leadId = b.leadId;
  if (b.kind === "ended") e.outcome = OUTCOMES.has(b.outcome) ? b.outcome : "no-answer";
  if (b.kind === "wrapped") {
    e.label = b.label ? String(b.label).slice(0, 60) : null;
    e.note = b.note ? String(b.note).slice(0, 2000) : "";
  }
  if (b.kind === "refused") e.reason = String(b.reason || "").slice(0, 300);
  return e;
}

const relay = createRelay();
const router = express.Router();

router.get("/api/voice/desktop/status", requireUser, (req, res) => {
  res.json(relay.status(req.user.id));
});

router.post("/api/voice/desktop/call", requireUser, express.json(), (req, res) => {
  if (!REQUIRED) return res.status(409).json({ error: "Calls are not routed through the desktop app" });
  const c = cleanCall(req.body);
  if (!c) return res.status(400).json({ error: "That doesn't look like a phone number" });
  const sent = relay.call(req.user.id, c);
  if (!sent) return res.status(409).json({ error: "The Karma Connect Dialer app isn't open", offline: true });
  res.json({ id: sent.id });
});

router.get("/api/voice/desktop/events", requireUser, (req, res) => {
  const after = Number.parseInt(req.query.after, 10);
  const drop = relay.events(req.user.id, Number.isFinite(after) ? after : -1, (events, seq) => {
    if (!res.headersSent) res.json({ events, seq });
  });
  req.on("close", drop);
});

router.get("/api/voice/desktop/wait", requireUser, (req, res) => {
  const drop = relay.wait(req.user.id, { registered: req.query.registered === "1" }, (calls) => {
    if (!res.headersSent) res.json({ calls });
  });
  req.on("close", drop);
});

router.post("/api/voice/desktop/event", requireUser, express.json(), (req, res) => {
  const e = cleanEvent(req.body);
  if (!e) return res.status(400).json({ error: "Unknown event" });
  relay.event(req.user.id, e);
  res.json({ ok: true });
});

module.exports = { router, createRelay, cleanCall, cleanEvent, REQUIRED };
