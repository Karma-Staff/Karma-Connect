"use strict";
/* Call logs — every call on the RingCentral account, one row each, with
   search, filters, paging, recordings and a download.

     GET /api/voice/rc/calllog          the rows (JSON), or ?format=csv|xlsx
     GET /api/voice/rc/recording/:id    a call recording, streamed through us

   Admin only, like the rest of Manage: it is the whole floor's calls and
   their recordings.

   The rows come from the same per-day call-log cache the Dashboard uses
   (rc-dashboard.js fetchDay), so the two never disagree and a finished day
   costs RingCentral nothing after its first read. A month is up to 31
   "heavy" requests on a cold cache, against a limit of ten a minute — so
   days are fetched in order and, if RingCentral says slow down, the page
   shows what it has and says how far it got; the next load picks up there.

   Two things only Karma Connect knows are joined on:
     lead          the other party's number matched to a lead, so "To" reads
                   "Homesley Construction" rather than a bare number;
     disposition   what the rep logged after the call (calls.js), matched to
                   the call by number and time.

   Recordings are proxied rather than linked: RingCentral's media URLs need
   our access token, which must never reach a browser. Range requests pass
   straight through, so the player can seek. */

const express = require("express");
const XLSX = require("xlsx");
const { query } = require("./db");
const { requireAdmin } = require("./auth");
const rc = require("./ringcentral");
const dash = require("./rc-dashboard");

const router = express.Router();

const MAX_DAYS = 31;
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const digits10 = (v) => {
  const d = String(v || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
};
const CONNECTED = new Set(["Accepted", "Call connected"]);

/* Every lead's number, once per ten minutes, as one map — a page of fifty
   calls then costs no queries at all to name. */
let phoneMap = { at: 0, map: null, pending: null };
async function leadsByPhone() {
  if (phoneMap.map && Date.now() - phoneMap.at < 10 * 60e3) return phoneMap.map;
  if (phoneMap.pending) return phoneMap.pending;
  phoneMap.pending = query(
    `SELECT id, kind, coalesce(nullif(btrim(name), ''), company) AS name, phone
       FROM leads
      WHERE deleted_at IS NULL AND NOT removed AND nullif(btrim(phone), '') IS NOT NULL
      ORDER BY id`).then(({ rows }) => {
    const map = new Map();
    for (const r of rows) {
      const d = digits10(r.phone);
      if (d && !map.has(d)) map.set(d, { id: r.id, kind: r.kind, name: r.name });   // first (oldest) wins
    }
    phoneMap = { at: Date.now(), map, pending: null };
    return map;
  }, (e) => { phoneMap.pending = null; throw e; });
  return phoneMap.pending;
}

/* Dispositions logged in the window, to be matched onto calls. */
async function dispositionsIn(fromMs, toMs) {
  const { rows } = await query(
    `SELECT at, meta->>'number' AS number, meta->>'disposition' AS disposition
       FROM activity_log
      WHERE action = 'call' AND meta ? 'disposition' AND at >= $1 AND at < $2`,
    [new Date(fromMs).toISOString(), new Date(toMs + 3600e3).toISOString()]);
  const by = new Map();
  for (const r of rows) {
    const d = digits10(r.number);
    if (!d) continue;
    if (!by.has(d)) by.set(d, []);
    by.get(d).push({ at: Date.parse(r.at), disposition: r.disposition });
  }
  return by;
}

/* Karma Connect's own record of every call the dialler placed, logged the
   moment the call ends (reportCall → calls.js). Used to fill the gaps in
   RingCentral's log: a call shows here at once, before RingCentral publishes
   it a minute or two later, and even for a leg RingCentral never logs. */
const OWN_RESULT = { connected: "Connected", "no-answer": "No Answer", busy: "Busy",
  failed: "Failed", cancelled: "Canceled", placed: "Placed" };
async function ownCalls(fromMs, toMs) {
  const { rows } = await query(
    `SELECT a.at, a.actor, a.user_id, a.lead_id,
            a.meta->>'number' AS number, a.meta->>'outcome' AS outcome,
            coalesce((a.meta->>'seconds')::int, 0) AS seconds,
            a.meta->>'direction' AS direction, a.meta->>'disposition' AS disposition,
            l.kind AS lead_kind, coalesce(nullif(btrim(l.name), ''), l.company) AS lead_name,
            coalesce(nullif(btrim(u.display_name), ''), a.actor) AS rep_name
       FROM activity_log a
       LEFT JOIN leads l ON l.id = a.lead_id AND l.deleted_at IS NULL
       LEFT JOIN app_users u ON lower(u.email) = lower(a.actor)
      WHERE a.action = 'call' AND a.meta ? 'number' AND a.at >= $1 AND a.at < $2`,
    [new Date(fromMs).toISOString(), new Date(toMs).toISOString()]);
  return rows.map((r) => ({ ...r, at: +new Date(r.at) }));
}
function ownRow(o, phones) {
  const out = o.direction !== "inbound";
  const theirs = o.number || "";
  const lead = phones.get(digits10(theirs))
    || (o.lead_id ? { id: o.lead_id, kind: o.lead_kind, name: o.lead_name } : null);
  const party = { name: lead?.name || o.lead_name || "", number: theirs, place: "",
    lead: lead ? { id: lead.id, kind: lead.kind } : null };
  const us = { name: o.rep_name || "", number: "" };
  return {
    id: null, at: o.at, seconds: o.outcome === "connected" ? o.seconds : 0,
    mode: out ? "outgoing" : "incoming",
    from: out ? us : party, to: out ? party : us,
    agent: us.name ? { id: null, name: us.name, ext: "" } : null,
    ours: "", result: OWN_RESULT[o.outcome] || o.outcome || "Logged",
    disposition: o.disposition || null, recording: null, source: "karma",
  };
}

async function buildRows(req) {
  const uid = req.user.id;
  const tz = dash.safeTz(String(req.query.tz || ""));
  const today = (() => { const w = dash.wall(Date.now(), tz); return `${w.year}-${w.month}-${w.day}`; })();
  let to = isYmd(req.query.to) ? req.query.to : today;
  let from = isYmd(req.query.from) ? req.query.from : to;
  if (to > today) to = today;
  if (from > to) from = to;
  const days = [];
  for (let d = from; d <= to && days.length < MAX_DAYS; d = dash.addDays(d, 1)) days.push(d);

  /* ?fresh=1 is the Refresh button: today is re-read rather than served
     from its one-minute cache (finished days cannot change). */
  const fresh = req.query.fresh === "1";
  const warnings = [];
  let calls = [], scope = "account", loaded = 0;
  for (const d of days) {
    try { calls.push(...await dash.fetchDay(uid, d, tz, scope, fresh)); loaded++; }
    catch (e) {
      if (e.status === 403 && scope === "account" && loaded === 0) {
        scope = "extension";
        warnings.push("Your RingCentral user can't read the whole company's call log, so these are only your own calls.");
        calls.push(...await dash.fetchDay(uid, d, tz, scope, fresh)); loaded++;
        continue;
      }
      if (e.status === 429) {
        warnings.push(`RingCentral asked us to slow down after ${loaded} of ${days.length} days — `
          + `showing those. Load again in a minute for the rest; the days already read are kept.`);
        break;
      }
      throw e;
    }
  }

  const exts = await dash.extensions(uid).catch(() => []);
  const extById = new Map(exts.map((e) => [e.id, e]));
  const extByNum = new Map(exts.map((e) => [e.ext, e]));
  const phones = await leadsByPhone().catch(() => new Map());
  const winFrom = dash.localMidnight(days[0], tz), winTo = dash.localMidnight(dash.addDays(days[days.length - 1], 1), tz);
  const dispos = await dispositionsIn(winFrom, winTo).catch(() => new Map());

  const rows = calls.map((c) => {
    const out = c.dir === "Outbound";
    const agent = (c.extId && extById.get(c.extId))
      || extByNum.get(out ? c.fromExt : c.toExt) || null;
    const theirs = out ? c.toNum : c.fromNum, ours = out ? c.fromNum : c.toNum;
    const lead = phones.get(digits10(theirs)) || null;
    const missed = !out && !CONNECTED.has(c.res);
    /* The dialler logs its call when it ends, so the closest log within five
       minutes of this call's end, to the same number, is this call's. */
    let disposition = null;
    const cand = dispos.get(digits10(theirs));
    if (cand) {
      const end = c.t + c.dur * 1000;
      let best = 5 * 60e3;
      for (const x of cand) { const gap = Math.abs(x.at - end); if (gap < best) { best = gap; disposition = x.disposition; } }
    }
    const party = { name: lead?.name || (out ? c.toName : c.fromName) || "", number: theirs,
      place: out ? c.toLoc : c.fromLoc, lead: lead ? { id: lead.id, kind: lead.kind } : null };
    const us = { name: agent?.name || (out ? c.fromName : c.toName) || "", number: ours };
    return {
      id: c.id, at: c.t, seconds: c.dur,
      mode: missed ? "missed" : out ? "outgoing" : "incoming",
      from: out ? us : party, to: out ? party : us,
      agent: agent ? { id: agent.id, name: agent.name, ext: agent.ext } : us.name ? { id: null, name: us.name, ext: "" } : null,
      ours, result: c.res, disposition, recording: c.recId,
    };
  });

  /* Fill the gaps with Karma Connect's own call records: add one only when
     RingCentral has no row for the same number within fifteen minutes, so a
     connected call RingCentral already logged is never listed twice. This
     only ADDS rows — RingCentral's own are left exactly as they are. */
  const rcByNum = new Map();
  for (const r of rows) {
    const d = digits10(r.mode === "outgoing" ? r.to.number : r.from.number);
    if (!d) continue;
    if (!rcByNum.has(d)) rcByNum.set(d, []);
    rcByNum.get(d).push(r.at);
  }
  const MATCH_MS = 15 * 60e3;
  const own = await ownCalls(winFrom, winTo).catch(() => []);
  for (const o of own) {
    const d = digits10(o.number);
    if (!d || o.at < winFrom || o.at >= winTo) continue;
    const near = rcByNum.get(d);
    if (near && near.some((t) => Math.abs(t - o.at) < MATCH_MS)) continue;   // RingCentral already has it
    rows.push(ownRow(o, phones));
  }
  rows.sort((a, b) => b.at - a.at);

  /* ---- filters (over the cached rows; none of them costs a request) ---- */
  const f = {
    agent: String(req.query.agent || ""), mode: String(req.query.mode || ""),
    result: String(req.query.result || ""), number: String(req.query.number || ""),
    disposition: String(req.query.disposition || ""), rec: req.query.rec === "1",
    q: String(req.query.q || "").trim().toLowerCase(),
  };
  const qDigits = f.q.replace(/\D/g, "");
  const kept = rows.filter((r) => {
    if (f.agent && r.agent?.id !== f.agent) return false;
    if (f.mode && r.mode !== f.mode) return false;
    if (f.result && r.result !== f.result) return false;
    if (f.number && r.ours !== f.number) return false;
    if (f.disposition && r.disposition !== f.disposition) return false;
    if (f.rec && !r.recording) return false;
    if (f.q) {
      const numHit = qDigits.length >= 3 && [r.from.number, r.to.number].some((n) => String(n).replace(/\D/g, "").includes(qDigits));
      const textHit = [r.from.name, r.to.name, r.agent?.name].some((s) => String(s || "").toLowerCase().includes(f.q));
      if (!numHit && !textHit) return false;
    }
    return true;
  });

  return {
    range: { from: days[0], to: days[days.length - 1], tz, today, loadedDays: loaded, days: days.length },
    scope, warnings, rows: kept,
    options: {
      agents: exts.map((e) => ({ id: e.id, name: e.name, ext: e.ext })).sort((a, b) => a.name.localeCompare(b.name)),
      results: [...new Set(rows.map((r) => r.result))].sort(),
      numbers: [...new Set(rows.map((r) => r.ours).filter(Boolean))].sort(),
      dispositions: [...new Set(rows.map((r) => r.disposition).filter(Boolean))].sort(),
    },
  };
}

const MODE_LABEL = { outgoing: "Outgoing", incoming: "Incoming", missed: "Missed" };
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

router.get("/api/voice/rc/calllog", requireAdmin, async (req, res, next) => {
  if (!rc.ENABLED) return res.status(503).json({ error: "RingCentral is not configured on this server" });
  try {
    const b = await buildRows(req);
    const format = String(req.query.format || "");

    if (format === "csv" || format === "xlsx") {
      const tz = b.range.tz;
      const dt = (ms) => { const w = dash.wall(ms, tz); return [`${w.year}-${w.month}-${w.day}`, `${w.hour}:${w.minute}:${w.second}`]; };
      const head = ["Mode", "From", "From number", "To", "To number", "Agent", "Extension",
        "Duration", "Seconds", "Date", "Time", "Result", "Disposition", "Recorded"];
      const data = b.rows.map((r) => {
        const [date, time] = dt(r.at);
        return [MODE_LABEL[r.mode], r.from.name, r.from.number, r.to.name, r.to.number,
          r.agent?.name || "", r.agent?.ext || "", mmss(r.seconds), r.seconds, date, time,
          r.result, r.disposition || "", r.recording ? "Yes" : "No"];
      });
      /* North American numbers as "(703) 555-0100": readable, and a shape no
         spreadsheet mistakes for arithmetic ("+17035550100" becomes the
         number 17035550100 and loses its plus). */
      const pretty = (n) => {
        const d = String(n || "").replace(/\D/g, "");
        const t = d.length === 11 && d[0] === "1" ? d.slice(1) : d;
        return t.length === 10 ? `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}` : String(n || "");
      };
      for (const row of data) { row[2] = pretty(row[2]); row[4] = pretty(row[4]); }
      const name = `call-logs_${b.range.from}_to_${b.range.to}`;
      if (format === "csv") {
        const cell = (v) => {
          const s = String(v ?? "");
          /* A cell starting = @ (or + / - followed by anything but a plain
             number) is run as a formula when the file is opened — names come
             from RingCentral and the lead base, so neutralise those. */
          const safe = /^[=@]/.test(s) || /^[+\-](?!\d+$)/.test(s) ? "'" + s : s;
          return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
        };
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`);
        return res.send("﻿" + [head, ...data].map((r) => r.map(cell).join(",")).join("\r\n"));
      }
      const ws = XLSX.utils.aoa_to_sheet([head, ...data]);
      ws["!cols"] = head.map((h) => ({ wch: Math.max(10, h.length + 2) }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Call logs");
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${name}.xlsx"`);
      return res.send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    }

    const per = Math.max(10, Math.min(200, +req.query.per || 50));
    const pages = Math.max(1, Math.ceil(b.rows.length / per));
    const page = Math.max(1, Math.min(pages, +req.query.page || 1));
    res.json({
      range: b.range, scope: b.scope, warnings: b.warnings, options: b.options,
      total: b.rows.length, page, pages, per,
      summary: {
        talkSecs: b.rows.reduce((s, r) => s + r.seconds, 0),
        recorded: b.rows.filter((r) => r.recording).length,
        missed: b.rows.filter((r) => r.mode === "missed").length,
      },
      rows: b.rows.slice((page - 1) * per, page * per),
    });
  } catch (e) {
    if (e.status === 428) return res.status(428).json({ error: "Connect your RingCentral account first — call logs are read from RingCentral as you." });
    if (e.status === 429) return res.status(429).json({ error: `RingCentral is rate-limiting us — try again in ${e.retryAfter || 60} seconds.` });
    next(e);
  }
});

router.get("/api/voice/rc/recording/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!/^\d{1,24}$/.test(id)) return res.status(400).json({ error: "bad recording id" });
    const tok = await rc.accessFor(req.user.id);
    const headers = { Authorization: "Bearer " + tok.access_token };
    if (req.headers.range) headers.Range = req.headers.range;
    const r = await fetch(`${rc.SERVER.replace("platform.", "media.")}/restapi/v1.0/account/~/recording/${id}/content`, { headers });
    if (!r.ok && r.status !== 206) {
      const msg = r.status === 404 ? "That recording no longer exists in RingCentral."
        : r.status === 403 ? "RingCentral refused: the app or your role may lack call-recording access." : `RingCentral ${r.status}`;
      return res.status(r.status === 404 ? 404 : 502).json({ error: msg });
    }
    res.status(r.status);
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = r.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader("Cache-Control", "private, no-store");
    if (req.query.download) res.setHeader("Content-Disposition", `attachment; filename="call-recording-${id}.mp3"`);
    const { Readable } = require("stream");
    Readable.fromWeb(r.body).pipe(res);
  } catch (e) {
    if (e.status === 428) return res.status(428).json({ error: "Connect your RingCentral account first." });
    next(e);
  }
});

/* ---------------- a recording link Zoho CRM can play ----------------

   Zoho's Calls record has a Voice Recording field with its own audio player,
   and that player fetches the URL directly — no Karma Connect login, so the
   admin-only route above answers it with an error ("doesn't have a playable
   audio URL"). This link plays without a login, but only with its signature:
   an HMAC of the recording id under a server secret, so a link cannot be
   guessed or altered to reach another recording. It does not expire, because
   Zoho keeps it on the record for good; changing RECORDING_LINK_SECRET (or,
   without it, AUTH_JWT_SECRET) revokes every link at once.

   The path ends in .mp3 and answers audio/mpeg with byte ranges, which is
   what a browser audio player — Zoho's included — expects.

   The recording is fetched with whichever connected RingCentral login can
   read it: an admin's first (they can read every extension's recordings),
   then anyone's. */
const crypto = require("crypto");
const recSecret = () => String(process.env.RECORDING_LINK_SECRET || process.env.AUTH_JWT_SECRET || "dev-only");
const recSig = (id) => crypto.createHmac("sha256", recSecret()).update("rec:" + id).digest("base64url").slice(0, 32);
const APP_URL = String(process.env.APP_URL || "").replace(/\/+$/, "");
const recordingLink = (id) => id && APP_URL ? `${APP_URL}/api/voice/rec/${id}/${recSig(id)}.mp3` : null;

let recUser = null;                          // the last login that could read a recording
async function recordingFetch(id, range) {
  const ids = (await query(
    `SELECT v.user_id FROM voice_identities v
       JOIN app_users u ON u.id = v.user_id
       LEFT JOIN organization_memberships m ON m.user_id = u.id
      WHERE v.provider = 'ringcentral' AND NOT u.disabled
      ORDER BY (v.user_id = $1) DESC, (m.role IN ('owner','admin')) DESC, v.last_used_at DESC NULLS LAST`,
    [recUser || 0])).rows.map((r) => r.user_id);
  let last = null;
  for (const uid of ids) {
    try {
      const tok = await rc.accessFor(uid);
      const headers = { Authorization: "Bearer " + tok.access_token };
      if (range) headers.Range = range;
      const r = await fetch(`${rc.SERVER.replace("platform.", "media.")}/restapi/v1.0/account/~/recording/${id}/content`, { headers });
      if (r.ok || r.status === 206) { recUser = uid; return r; }
      last = r;
      if (r.status === 404) return r;        // gone for everyone, not just this login
    } catch (e) { last = null; }
  }
  return last;
}

async function servePublicRecording(req, res, next) {
  try {
    const id = String(req.params.id);
    const sig = String(req.params.sig || "");
    const want = recSig(id);
    if (!/^\d{1,24}$/.test(id) || sig.length !== want.length
        || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)))
      return res.status(404).type("text/plain").send("Not found");
    const r = await recordingFetch(id, req.headers.range);
    if (!r || (!r.ok && r.status !== 206))
      return res.status(r && r.status === 404 ? 404 : 502).type("text/plain")
        .send(r && r.status === 404 ? "That recording no longer exists." : "The recording couldn't be fetched from RingCentral.");
    res.status(r.status);
    res.setHeader("Content-Type", (r.headers.get("content-type") || "audio/mpeg").split(";")[0] || "audio/mpeg");
    for (const h of ["content-length", "content-range", "accept-ranges"]) {
      const v = r.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!r.headers.get("accept-ranges")) res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Robots-Tag", "noindex");
    if (req.method === "HEAD") { r.body?.cancel?.(); return res.end(); }
    const { Readable } = require("stream");
    Readable.fromWeb(r.body).pipe(res);
  } catch (e) { next(e); }
}
router.get("/api/voice/rec/:id/:sig.mp3", servePublicRecording);
router.head("/api/voice/rec/:id/:sig.mp3", servePublicRecording);

module.exports = { router, recordingLink, _test: { recSig } };
