"use strict";
/* Live calls — who is on the phone right now, and with which lead.

   Two sources, because neither knows the whole of it:

     the dialler   POST /api/calls/live from each rep's browser as a call
                   rings, connects, holds and ends, plus a heartbeat every
                   20s. Only Karma Connect knows WHICH LEAD a call is to.
     RingCentral   account presence, read live: catches calls the dialler
                   never saw (the desk phone, the RingCentral app, inbound),
                   and is the authority on whether a line is busy at all.

   The board is held in memory, not the database. It is a picture of this
   second — written every 20s per caller and worthless a minute later — and
   the activity log already keeps the permanent record of every call. A
   restart empties it; the next heartbeat refills it.

   One process holds it. That is how this service runs today; if it is ever
   scaled to several instances, this map has to move to shared storage or
   each instance sees a third of the floor. */

const express = require("express");
const { query } = require("./db");
const { requireUser, requireAdmin } = require("./auth");
const rc = require("./ringcentral");
const dash = require("./rc-dashboard");

const router = express.Router();

const STATES = new Set(["ringing", "live", "hold", "ended"]);
/* Three missed heartbeats and the call is presumed over — a closed tab or a
   dropped laptop never gets to say "ended". */
const STALE_MS = 65 * 1000;

const LIVE = new Map();            // lower(email) -> entry

const digits10 = (v) => {
  const d = String(v || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
};

/* Small lookups the board makes every few seconds, cached so it costs a query
   only when something changes. */
const leadCache = new Map(), phoneCache = new Map(), userCache = new Map();
async function leadById(id) {
  const hit = leadCache.get(id);
  if (hit && hit.until > Date.now()) return hit.v;
  const v = (await query(
    `SELECT id, kind, name, company, city, state, status, phone
       FROM leads WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0] || null;
  leadCache.set(id, { v, until: Date.now() + 5 * 60e3 });
  return v;
}
/* For calls the dialler did not place: the other party's number back to a
   lead. Only ever asked for the handful of numbers on a call right now. */
async function leadByPhone(num) {
  const d = digits10(num);
  if (!d) return null;
  const hit = phoneCache.get(d);
  if (hit && hit.until > Date.now()) return hit.v;
  const v = (await query(
    `SELECT id, kind, name, company, city, state, status, phone
       FROM leads
      WHERE deleted_at IS NULL AND NOT removed
        AND right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = $1
      ORDER BY id LIMIT 1`, [d])).rows[0] || null;
  phoneCache.set(d, { v, until: Date.now() + 5 * 60e3 });
  return v;
}
async function people() {
  const hit = userCache.get("all");
  if (hit && hit.until > Date.now()) return hit.v;
  const v = (await query(
    `SELECT lower(u.email) AS email,
            coalesce(nullif(btrim(u.display_name), ''), u.email) AS name,
            nullif(btrim(v.extension), '') AS ext,
            m.role AS role,
            lower(mu.email) AS manager
       FROM app_users u
       LEFT JOIN organization_memberships m ON m.user_id = u.id
       LEFT JOIN voice_identities v ON v.user_id = u.id AND v.provider = 'ringcentral'
       LEFT JOIN app_users mu ON mu.id = u.manager_id
         AND NOT mu.disabled AND mu.deleted_at IS NULL
      WHERE NOT u.disabled`)).rows;
  userCache.set("all", { v, until: Date.now() + 60e3 });
  return v;
}

const slimLead = (l) => l && { id: l.id, kind: l.kind, name: l.name || l.company,
  company: l.company, city: l.city, state: l.state, status: l.status };

/* ---------------- the dialler's side ---------------- */

router.post("/api/calls/live", requireUser, express.json({ limit: "2kb" }), async (req, res, next) => {
  try {
    const b = req.body || {};
    const state = STATES.has(b.state) ? b.state : null;
    if (!state) return res.status(400).json({ error: "state must be ringing, live, hold or ended" });
    const key = String(req.user.email).toLowerCase();
    if (state === "ended") { LIVE.delete(key); return res.json({ ok: true }); }

    const leadId = Number.isInteger(+b.lead_id) && +b.lead_id > 0 ? +b.lead_id : null;
    const ts = (v) => { const t = Date.parse(v); return Number.isFinite(t) && Math.abs(Date.now() - t) < 12 * 3600e3 ? t : null; };
    const prev = LIVE.get(key);
    LIVE.set(key, {
      email: key, name: req.user.name || req.user.email,
      state, leadId, number: String(b.number || "").slice(0, 32),
      dialAt: ts(b.dial_at) || prev?.dialAt || Date.now(),
      answerAt: ts(b.answer_at) || (state === "live" ? prev?.answerAt || Date.now() : prev?.answerAt || null),
      seen: Date.now(),
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------------- the board ---------------- */

const RC_STATE = { Ringing: "ringing", CallConnected: "live", OnHold: "hold", ParkedCall: "hold" };
const RANK = { live: 0, hold: 1, ringing: 2, available: 3, busy: 4, offline: 5 };

router.get("/api/calls/live", requireAdmin, async (req, res, next) => {
  try {
    const now = Date.now();
    for (const [k, v] of LIVE) if (now - v.seen > STALE_MS) LIVE.delete(k);

    const users = await people();
    const byExt = new Map(users.filter((u) => u.ext).map((u) => [u.ext, u]));
    const byEmail = new Map(users.map((u) => [u.email, u]));
    /* Show only our own people — sales reps, admins, owners. Other RingCentral
       users (other departments) stay off the board. Safety net: if nobody has
       a role yet, show everyone rather than an empty board. */
    const ROLE_OK = new Set(["owner", "admin", "sales_rep"]);
    const filterRoles = users.some((u) => ROLE_OK.has(u.role));
    const okUser = (u) => !filterRoles || (u && ROLE_OK.has(u.role));

    /* RingCentral presence, four seconds fresh: the board polls every five,
       and several managers watching it share one request. */
    let pres = null, exts = [], presenceError = null;
    if (rc.ENABLED) {
      try {
        [pres, exts] = await Promise.all([
          dash.cached("live-presence", 4000, async () =>
            (await dash.rcGet(req.user.id, "/restapi/v1.0/account/~/presence",
              { detailedTelephonyState: true, activeCalls: true, perPage: 1000 })).records || []),
          dash.extensions(req.user.id),
        ]);
      } catch (e) {
        presenceError = e.status === 428 ? "Connect your RingCentral account to see desk-phone calls too."
          : "RingCentral presence unavailable: " + e.message;
      }
    }

    const agents = [];
    const used = new Set();
    const extById = new Map(exts.map((e) => [e.id, e]));
    for (const p of pres || []) {
      const e = extById.get(String(p.extension?.id || ""));
      if (!e) continue;                                   // a queue or a device, not a person
      const u = byExt.get(e.ext);
      if (!okUser(u)) continue;                  // another department's extension
      const app = u ? LIVE.get(u.email) : null;
      if (u) used.add(u.email);
      const call = (p.activeCalls || [])[0] || null;
      const rcState = RC_STATE[p.telephonyStatus] || null;
      /* The dialler's report wins while it is fresh: it knows the lead, and
         it learns of a hold before presence catches up. Presence decides
         when there is no report — a desk-phone call. */
      const state = app ? app.state : rcState;
      let lead = null, number = "", direction = null, since = null, source = null;
      if (app) {
        lead = app.leadId ? slimLead(await leadById(app.leadId)) : null;
        number = app.number; direction = "Outbound"; source = "dialler";
        since = state === "ringing" ? app.dialAt : app.answerAt || app.dialAt;
      } else if (rcState) {
        source = "ringcentral";
        if (call) {
          direction = call.direction || null;
          number = direction === "Inbound" ? call.from : call.to;
          since = Date.parse(call.startTime) || null;
          lead = slimLead(await leadByPhone(number));
        }
      }
      const status = state || (p.presenceStatus === "Offline" ? "offline"
        : p.presenceStatus === "Busy" || p.dndStatus === "DoNotAcceptAnyCalls" ? "busy" : "available");
      /* The extension's owner is who RingCentral says it is. If someone else
         connected Karma Connect's dialler with that login, say so — the call
         is theirs, the seat is not. */
      const by = app && u && u.name !== e.name ? u.name : null;
      agents.push({ name: e.name, ext: e.ext, status, lead, number, direction,
        since, source, by, presence: p.presenceStatus || null,
        manager: u?.manager || null });
    }
    /* Dialler reports from people with no RingCentral presence row (no
       connected seat, or presence unavailable) still belong on the board. */
    for (const [email, app] of LIVE) {
      if (used.has(email)) continue;
      const u = byEmail.get(email);
      if (!okUser(u)) continue;
      agents.push({ name: u?.name || app.name, ext: u?.ext || "", status: app.state,
        lead: app.leadId ? slimLead(await leadById(app.leadId)) : null, number: app.number,
        direction: "Outbound", since: app.state === "ringing" ? app.dialAt : app.answerAt || app.dialAt,
        source: "dialler", presence: null, manager: u?.manager || null });
    }

    agents.sort((a, b) => (RANK[a.status] - RANK[b.status]) || ((a.since || now) - (b.since || now))
      || a.name.localeCompare(b.name));
    const count = (s) => agents.filter((a) => a.status === s).length;
    res.json({
      now, presenceError, you: String(req.user.email).toLowerCase(),
      counts: { live: count("live"), hold: count("hold"), ringing: count("ringing"),
        available: count("available") + count("busy"), offline: count("offline") },
      agents,
    });
  } catch (e) { next(e); }
});

module.exports = { router };
