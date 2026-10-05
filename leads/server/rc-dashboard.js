"use strict";
/* GET /api/voice/rc/dashboard — the phone system's own numbers, for the
   manager's Dashboard tab.

   The Call report reads OUR log: calls placed through this app. This reads
   RingCentral's: every call on the account, including the ones a rep made
   from the desk phone or the RingCentral app, and every inbound call, which
   our log has never seen. The two answer different questions and both stay.

   WHERE EACH NUMBER COMES FROM
     call log   /account/~/call-log         tiles, hourly, weekly, agents,
                                            numbers, results, map
     presence   /account/~/presence         who is online / on a call now
     extensions /account/~/extension        names, departments, head count

   RATE LIMITS SHAPE THE DESIGN. The call log is RingCentral's "heavy" group:
   ten requests a minute for the whole app. So the log is fetched one LOCAL
   DAY at a time and each day is cached — a finished day for hours (it cannot
   change), today for a minute. A dashboard on auto-refresh then costs one
   request a minute, whatever range it shows. Filters (agent, department,
   number) are applied here over cached records and never refetch.

   Account-wide reads need an RingCentral admin role. A viewer without one
   falls back to their own extension's log, and the response says so rather
   than presenting one person's calls as the company's. */

const express = require("express");
const { requireAdmin } = require("./auth");
const rc = require("./ringcentral");
const { regionOf, countryOf } = require("./areacodes");

const router = express.Router();

const MAX_DAYS = 7;            // one heavy request per uncached day; see above
const PAGE = 1000;
const MAX_PAGES = 10;          // 10k calls in a day is past anything this floor does

/* ---------------- RingCentral, read-only ---------------- */

async function rcGet(userId, path, params = {}) {
  const tok = await rc.accessFor(userId);
  const url = new URL(rc.SERVER + path);
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: "Bearer " + tok.access_token } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(body.message || body.error_description || `RingCentral ${r.status}`);
    e.status = r.status;
    e.code = body.errorCode || null;
    e.retryAfter = +r.headers.get("retry-after") || null;
    throw e;
  }
  return body;
}

/* A small TTL cache with in-flight de-duplication: two admins opening the
   dashboard in the same second make one request, not two. */
const CACHE = new Map();
function cached(key, ttlMs, fn) {
  const hit = CACHE.get(key);
  if (hit?.pending) return hit.pending;
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.value);
  const pending = fn().then(
    (value) => { CACHE.set(key, { value, until: Date.now() + ttlMs }); return value; },
    (e) => {
      /* Serve the last good copy through a rate limit or a blip rather than
         blanking a screen someone is watching. */
      if (hit && "value" in hit) { CACHE.set(key, hit); return hit.value; }
      CACHE.delete(key);
      throw e;
    });
  CACHE.set(key, { ...(hit || {}), pending });
  return pending;
}

/* ---------------- time zones ----------------
   The browser says which zone it is in. Days and hours are bucketed there,
   because "calls at 9am" means 9am on the floor, not 9am UTC. */

function safeTz(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; }
  catch { return "America/New_York"; }
}

const PARTS = new Map();
function partsIn(tz) {
  if (!PARTS.has(tz)) PARTS.set(tz, new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" }));
  return PARTS.get(tz);
}
function wall(ms, tz) {
  const o = {};
  for (const p of partsIn(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}
/* Offset of `tz` at instant `ms`, in ms (wall clock minus UTC). */
function offsetAt(ms, tz) {
  const w = wall(ms, tz);
  const asUtc = Date.UTC(+w.year, +w.month - 1, +w.day, +w.hour, +w.minute, +w.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}
/* The UTC instant of local midnight on a YYYY-MM-DD in `tz`. Re-checked once
   so a DST change near midnight lands on the right side. */
function localMidnight(ymd, tz) {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetAt(guess, tz);
  t = guess - offsetAt(t, tz);
  return t;
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

/* ---------------- fetching ---------------- */

/* One local day of the call log, slimmed to the fields the charts use. */
async function fetchDay(userId, ymd, tz, scope) {
  const from = localMidnight(ymd, tz);
  const to = localMidnight(addDays(ymd, 1), tz);
  const done = to <= Date.now();
  const path = scope === "account"
    ? "/restapi/v1.0/account/~/call-log"
    : "/restapi/v1.0/account/~/extension/~/call-log";
  const key = `log:${scope}:${scope === "account" ? "" : userId}:${tz}:${ymd}`;
  return cached(key, done ? 6 * 3600e3 : 60e3, async () => {
    const out = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const d = await rcGet(userId, path, {
        dateFrom: new Date(from).toISOString(), dateTo: new Date(to).toISOString(),
        view: "Simple", type: "Voice", perPage: PAGE, page });
      for (const r of d.records || []) {
        out.push({
          id: r.id || null, recId: r.recording?.id ? String(r.recording.id) : null,
          t: Date.parse(r.startTime), dur: +r.duration || 0,
          dir: r.direction, res: r.result || "Unknown",
          fromLoc: r.from?.location || "", toLoc: r.to?.location || "",
          extId: r.extension?.id ? String(r.extension.id) : null,
          fromNum: r.from?.phoneNumber || "", fromName: r.from?.name || "",
          fromExt: r.from?.extensionNumber || "",
          toNum: r.to?.phoneNumber || "", toName: r.to?.name || "",
          toExt: r.to?.extensionNumber || "",
        });
      }
      if (!d.navigation?.nextPage || (d.records || []).length < PAGE) break;
    }
    return out;
  });
}

const extensions = (userId) => cached("ext", 10 * 60e3, async () => {
  const d = await rcGet(userId, "/restapi/v1.0/account/~/extension",
    { type: "User", status: "Enabled", perPage: 1000 });
  return (d.records || []).map((e) => ({
    id: String(e.id), ext: e.extensionNumber || "", name: e.name || `x${e.extensionNumber}`,
    dept: e.contact?.department || "",
  }));
});

const presence = (userId) => cached("presence", 20e3, async () => {
  const d = await rcGet(userId, "/restapi/v1.0/account/~/presence",
    { detailedTelephonyState: true, perPage: 1000 });
  return (d.records || []).map((p) => ({
    id: String(p.extension?.id || ""),
    status: p.presenceStatus || "Offline",
    phone: p.telephonyStatus || "NoCall",
    dnd: p.dndStatus || "",
  }));
});

const companyNumbers = (userId) => cached("numbers", 30 * 60e3, async () => {
  const d = await rcGet(userId, "/restapi/v1.0/account/~/phone-number", { perPage: 1000 });
  return (d.records || []).filter((n) => n.phoneNumber)
    .map((n) => ({ number: n.phoneNumber, usage: n.usageType || "",
      extId: n.extension?.id ? String(n.extension.id) : null }));
});

/* ---------------- shaping ---------------- */

const CONNECTED = new Set(["Accepted", "Call connected"]);
const isMissed = (c) => c.dir === "Inbound" && !CONNECTED.has(c.res);
const blank = () => ({ incoming: 0, outgoing: 0, missed: 0 });
function tally(o, c) {
  if (c.dir === "Inbound") { if (isMissed(c)) o.missed++; else o.incoming++; }
  else o.outgoing++;
}
/* The first n-1 rows, then everything after folded into one "Other" — a
   chart never grows a ninth colour or a forty-bar tail. */
function topN(rows, n, sumKeys) {
  if (rows.length <= n) return rows;
  const other = { label: "Other", other: true };
  for (const k of sumKeys) other[k] = rows.slice(n - 1).reduce((s, r) => s + r[k], 0);
  return [...rows.slice(0, n - 1), other];
}

function shape(calls, ctx) {
  const { tz, days, week, extById } = ctx;
  const agentOf = (c) => {
    if (c.extId && extById.has(c.extId)) return extById.get(c.extId);
    const ext = c.dir === "Outbound" ? c.fromExt : c.toExt;
    const name = c.dir === "Outbound" ? c.fromName : c.toName;
    if (ext) for (const e of extById.values()) if (e.ext === ext) return e;
    return name ? { id: "n:" + name, name, ext: ext || "" } : null;
  };

  const kpi = { incoming: { calls: 0, secs: 0 }, outgoing: { calls: 0, secs: 0, connected: 0 },
    missed: { calls: 0 }, total: { calls: 0, secs: 0 } };
  const hourly = Array.from({ length: 24 }, (_, h) => ({ h, ...blank() }));
  const daily = new Map(days.map((d) => [d, { date: d, ...blank() }]));
  const weekly = new Map(week.map((d) => [d, { date: d, ...blank() }]));
  const agents = new Map(), numbers = new Map(), results = new Map(), regions = new Map();
  const countries = new Map();
  let talkSecs = 0, talkCalls = 0, answered = 0;

  for (const c of calls) {
    const w = wall(c.t, tz);
    const ymd = `${w.year}-${w.month}-${w.day}`;
    if (weekly.has(ymd)) tally(weekly.get(ymd), c);
    if (!daily.has(ymd)) continue;          // the week reaches further back than the range
    tally(daily.get(ymd), c);
    tally(hourly[+w.hour], c);

    kpi.total.calls++; kpi.total.secs += c.dur;
    if (c.dir === "Inbound") {
      if (isMissed(c)) kpi.missed.calls++;
      else { kpi.incoming.calls++; kpi.incoming.secs += c.dur; answered++; }
    } else {
      kpi.outgoing.calls++; kpi.outgoing.secs += c.dur;
      if (CONNECTED.has(c.res)) kpi.outgoing.connected++;
    }
    if (CONNECTED.has(c.res) && c.dur > 0) { talkSecs += c.dur; talkCalls++; }

    const a = agentOf(c);
    if (a) {
      if (!agents.has(a.id)) agents.set(a.id, { id: a.id, name: a.name, ext: a.ext || "",
        ...blank(), connected: 0, talkSecs: 0 });
      const row = agents.get(a.id);
      tally(row, c);
      if (CONNECTED.has(c.res)) { row.connected++; row.talkSecs += c.dur; }
    }

    const ours = c.dir === "Outbound" ? c.fromNum : c.toNum;
    if (ours) {
      if (!numbers.has(ours)) numbers.set(ours, { number: ours, ...blank() });
      tally(numbers.get(ours), c);
    }

    results.set(c.res, (results.get(c.res) || 0) + 1);

    const theirs = c.dir === "Outbound" ? c.toNum : c.fromNum;
    const region = regionOf(theirs);
    if (region) regions.set(region, (regions.get(region) || 0) + 1);
    const country = countryOf(theirs);
    if (country) countries.set(country, (countries.get(country) || 0) + 1);
  }

  const total = (r) => r.incoming + r.outgoing + r.missed;
  const inbound = kpi.incoming.calls + kpi.missed.calls;
  return {
    kpi: { ...kpi,
      answerRate: inbound ? kpi.incoming.calls / inbound : null,
      connectRate: kpi.outgoing.calls ? kpi.outgoing.connected / kpi.outgoing.calls : null,
      avgTalk: talkCalls ? Math.round(talkSecs / talkCalls) : null },
    hourly,
    daily: [...daily.values()],
    week: [...weekly.values()].map((r) => ({ ...r,
      dow: wall(localMidnight(r.date, tz) + 12 * 3600e3, tz).weekday })),
    byAgent: [...agents.values()].sort((a, b) => total(b) - total(a)),
    byNumber: topN([...numbers.values()].sort((a, b) => total(b) - total(a)), 8,
      ["incoming", "outgoing", "missed"]),
    results: topN([...results].map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count), 6, ["count"]),
    byRegion: [...regions].map(([code, count]) => ({ code, count })),
    byCountry: [...countries].map(([code, count]) => ({ code, count })),
  };
}

/* ---------------- the route ---------------- */

router.get("/api/voice/rc/dashboard", requireAdmin, async (req, res, next) => {
  if (!rc.ENABLED) return res.status(503).json({ error: "RingCentral is not configured on this server" });
  const uid = req.user.id;
  try {
    const tz = safeTz(String(req.query.tz || ""));
    const today = (() => { const w = wall(Date.now(), tz); return `${w.year}-${w.month}-${w.day}`; })();
    let to = isYmd(req.query.to) ? req.query.to : today;
    let from = isYmd(req.query.from) ? req.query.from : to;
    if (to > today) to = today;
    if (from > to) from = to;
    const days = [];
    for (let d = from; d <= to && days.length < MAX_DAYS; d = addDays(d, 1)) days.push(d);
    to = days[days.length - 1];
    const week = Array.from({ length: 7 }, (_, i) => addDays(to, i - 6));
    const fetchList = [...new Set([...week, ...days])].sort();

    const warnings = [];
    /* Account scope first; a 403 there means this RingCentral user is not an
       admin, so fall back to their own calls and say so on the screen. */
    let scope = "account";
    const loadAll = async (s) => {
      const out = [];
      for (const d of fetchList) out.push(...await fetchDay(uid, d, tz, s));   // serial: heavy group
      return out;
    };
    let calls;
    try { calls = await loadAll("account"); }
    catch (e) {
      if (e.status !== 403) throw e;
      scope = "extension";
      warnings.push("Your RingCentral user can't read the whole company's call log, so this shows only your own calls. A RingCentral admin can grant the \"Company Call Log\" permission.");
      calls = await loadAll("extension");
    }

    const [exts, pres, nums] = await Promise.all([
      extensions(uid).catch((e) => { warnings.push("Agent names unavailable: " + e.message); return []; }),
      presence(uid).catch((e) => { warnings.push("Live presence unavailable: " + e.message); return null; }),
      companyNumbers(uid).catch(() => []),
    ]);
    const extById = new Map(exts.map((e) => [e.id, e]));

    /* Filters run over cached records — changing one never costs a request. */
    const agentF = String(req.query.agent || "");
    const deptF = String(req.query.dept || "");
    const numF = String(req.query.number || "");
    const inDept = deptF ? new Set(exts.filter((e) => e.dept === deptF).map((e) => e.id)) : null;
    const filtered = calls.filter((c) => {
      if (numF && (c.dir === "Outbound" ? c.fromNum : c.toNum) !== numF) return false;
      if (agentF && c.extId !== agentF) return false;
      if (inDept && !inDept.has(c.extId)) return false;
      return true;
    });

    const body = shape(filtered, { tz, days, week, extById });

    let agents = null;
    if (pres) {
      const scoped = exts.filter((e) => (!inDept || inDept.has(e.id)) && (!agentF || e.id === agentF));
      const byId = new Map(pres.map((p) => [p.id, p]));
      const list = scoped.map((e) => {
        const p = byId.get(e.id) || { status: "Offline", phone: "NoCall" };
        return { id: e.id, name: e.name, ext: e.ext, dept: e.dept,
          status: p.status, onCall: p.phone !== "NoCall" };
      });
      agents = {
        total: list.length,
        online: list.filter((a) => a.status !== "Offline").length,
        onCall: list.filter((a) => a.onCall).length,
        offline: list.filter((a) => a.status === "Offline").length,
        list: list.sort((a, b) => (b.onCall - a.onCall) || a.name.localeCompare(b.name)),
      };
    }

    res.json({
      range: { from: days[0], to, tz, days, today },
      scope, warnings, updatedAt: new Date().toISOString(),
      agents, ...body,
      filters: {
        departments: [...new Set(exts.map((e) => e.dept).filter(Boolean))].sort(),
        agents: exts.map((e) => ({ id: e.id, name: e.name, ext: e.ext }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        numbers: [...new Set([...nums.map((n) => n.number),
          ...body.byNumber.filter((n) => !n.other).map((n) => n.number)])].sort(),
      },
    });
  } catch (e) {
    if (e.status === 428) return res.status(428).json({
      error: "Connect your RingCentral account first — the dashboard reads RingCentral as you.",
      connectUrl: "/api/voice/rc/connect" });
    if (e.status === 429) return res.status(429).json({
      error: `RingCentral is rate-limiting us — try again in ${e.retryAfter || 60} seconds.` });
    if (e.status === 403) return res.status(403).json({
      error: "RingCentral refused: " + e.message + " (the app or your RingCentral role may be missing a permission)" });
    next(e);
  }
});

module.exports = { router, rcGet, cached, extensions, companyNumbers, fetchDay, safeTz, wall, localMidnight, addDays,
  _test: { localMidnight, addDays, shape, wall } };
