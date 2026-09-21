"use strict";
/* Storm watch — live severe-weather alerts, scored for restoration work and
   joined to the lead base.

   The pitch this exists to serve: a tornado goes through Tulsa, every
   restoration firm within fifty miles is suddenly turning work away for want
   of crews, and the first staffing company to ring them gets the business.
   Being second is being nowhere. So the question this answers is not "what
   is the weather" but "where did property just get damaged, and who do we
   already have on file there".

   Source is the US National Weather Service (api.weather.gov): official,
   free, no key, no rate limit worth worrying about. Canada is NOT covered —
   Environment Canada publishes CAP as a directory tree of XML rather than an
   API, and the lead base holds eight Canadian rows out of thirty-six
   thousand, so it earns its place the day that changes.

   The filtering is the product. A live fetch returns ~400 alerts and most
   are marine — Small Craft Advisory, Gale Watch, Beach Hazards — which mean
   nothing to a restoration company. What is left after RELEVANT below is the
   sixty or so that mean someone's roof came off. */

const express = require("express");
const { query } = require("./db");
const { requireUser } = require("./auth");
const { STATE_NAME } = require("./leads");

const router = express.Router();

const FEED = "https://api.weather.gov/alerts/active";
/* weather.gov asks for a User-Agent that identifies the caller and gives
   them someone to contact if we misbehave. They mean it — a generic agent
   gets 403. */
const UA = process.env.NWS_USER_AGENT
  || "KarmaLeads/1.0 (karmastaff.com; operations@karmastaff.com)";
/* The feed is ~2MB and changes on the order of minutes. Once every five
   minutes is far fresher than a sales team can act on, and it keeps us a
   polite caller. */
const TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20000;

/* What matters to a restoration company, and how much.

   tier 3 — property is being destroyed right now
   tier 2 — damage is likely and crews will be needed
   tier 1 — worth watching; may become work

   Matched on the event name containing the key, because the NWS emits
   dozens of variants ("Tornado Warning", "Tornado Watch", "PDS Tornado
   Warning") and a closed list would miss the one that matters. Order counts:
   the first match wins, so the specific sit above the general. */
const RELEVANT = [
  [3, "tornado"], [3, "hurricane"], [3, "storm surge"], [3, "flash flood"],
  [3, "ice storm"], [3, "blizzard"], [3, "extreme wind"],
  [2, "tropical storm"], [2, "severe thunderstorm"], [2, "winter storm"],
  [2, "high wind"], [2, "coastal flood"], [2, "flood"], [2, "fire warning"],
  [2, "red flag"], [2, "freezing rain"],
  [1, "winter weather"], [1, "wind advisory"], [1, "fire weather"],
  [1, "hard freeze"], [1, "freeze warning"], [1, "dense smoke"],
];

/* Marine and coastal-leisure zones are not states, and their alerts are not
   restoration work. UGC codes for them use these prefixes. */
const NOT_A_STATE = new Set(["AM", "AN", "GM", "LC", "LE", "LH", "LM", "LO",
  "LS", "PH", "PK", "PM", "PS", "PZ", "SL"]);

function tierOf(event) {
  const e = String(event || "").toLowerCase();
  for (const [tier, key] of RELEVANT) if (e.includes(key)) return tier;
  return 0;                            // not our business
}

/* UGC codes look like OHC001 (county) or TXZ091 (forecast zone); the first
   two characters are the state. */
function statesOf(props) {
  const ugc = (props.geocode && props.geocode.UGC) || [];
  const out = new Set();
  for (const u of ugc) {
    const s = String(u).slice(0, 2).toUpperCase();
    if (s.length === 2 && !NOT_A_STATE.has(s) && STATE_NAME[s]) out.add(s);
  }
  return [...out];
}

let cache = { at: 0, data: null, error: null };

async function fetchAlerts() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(FEED, {
      signal: ctl.signal,
      headers: { "User-Agent": UA, Accept: "application/geo+json" },
    });
    if (!r.ok) throw new Error(`weather.gov returned ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* Reduce the feed to what a salesperson can act on. Pure, so alerts.test.js
   can feed it real NWS shapes without the network. */
function digest(feed) {
  const features = (feed && Array.isArray(feed.features)) ? feed.features : [];
  const alerts = [];
  for (const f of features) {
    const p = (f && f.properties) || {};
    const tier = tierOf(p.event);
    if (!tier) continue;
    const states = statesOf(p);
    if (!states.length) continue;      // marine-only, or somewhere we do not work
    alerts.push({
      id: String(p.id || "").slice(-24),
      event: String(p.event || "Alert"),
      tier,
      severity: String(p.severity || "Unknown"),
      urgency: String(p.urgency || ""),
      area: String(p.areaDesc || "").slice(0, 300),
      states,
      sent: p.sent || null,
      expires: p.expires || p.ends || null,
      headline: String((p.parameters && p.parameters.NWSheadline && p.parameters.NWSheadline[0]) || p.headline || "").slice(0, 300),
    });
  }
  /* Worst first, then newest. A rep reads the top of this list and stops. */
  alerts.sort((a, b) => b.tier - a.tier
    || String(b.sent || "").localeCompare(String(a.sent || "")));
  return alerts;
}

/* Alerts per state, keeping the worst tier — the map colours on this. */
function byState(alerts) {
  const m = new Map();
  for (const a of alerts) {
    for (const s of a.states) {
      const cur = m.get(s) || { state: s, alerts: 0, tier: 0, events: new Set() };
      cur.alerts += 1;
      cur.tier = Math.max(cur.tier, a.tier);
      cur.events.add(a.event);
      m.set(s, cur);
    }
  }
  return [...m.values()].map((v) => ({ ...v, events: [...v.events].slice(0, 4) }));
}

/* How many leads sit in each affected state.

   Matched on BOTH spellings, because the base holds "FL" and "Florida" for
   the same place — a known data issue the state filter already absorbs, and
   counting only one spelling here would under-report Florida by 611. */
async function leadCounts(states) {
  if (!states.length) return {};
  const names = states.map((s) => STATE_NAME[s]).filter(Boolean);
  const rows = (await query(
    `SELECT upper(btrim(state)) AS raw, count(*)::int AS n,
            count(*) FILTER (WHERE nullif(btrim(owner), '') IS NULL)::int AS unassigned
       FROM leads
      WHERE deleted_at IS NULL AND NOT removed
        AND (upper(btrim(state)) = ANY($1) OR upper(btrim(state)) = ANY($2))
      GROUP BY 1`,
    [states, names.map((n) => n.toUpperCase())])).rows;

  const out = {};
  for (const s of states) out[s] = { leads: 0, unassigned: 0 };
  for (const r of rows) {
    // fold "FLORIDA" back onto "FL"
    const code = states.includes(r.raw)
      ? r.raw
      : states.find((s) => (STATE_NAME[s] || "").toUpperCase() === r.raw);
    if (!code) continue;
    out[code].leads += r.n;
    out[code].unassigned += r.unassigned;
  }
  return out;
}

async function load() {
  if (cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  const feed = await fetchAlerts();
  const alerts = digest(feed);
  const states = byState(alerts);
  const counts = await leadCounts(states.map((s) => s.state));
  const data = {
    fetchedAt: new Date().toISOString(),
    total: (feed.features || []).length,      // everything the NWS had
    relevant: alerts.length,                  // what survived the filter
    alerts: alerts.slice(0, 80),
    states: states
      .map((s) => ({ ...s, ...(counts[s.state] || { leads: 0, unassigned: 0 }),
        name: STATE_NAME[s.state] || s.state }))
      .sort((a, b) => b.tier - a.tier || b.leads - a.leads),
  };
  cache = { at: Date.now(), data, error: null };
  return data;
}

router.get("/api/alerts", requireUser, async (req, res, next) => {
  try {
    res.json(await load());
  } catch (e) {
    /* The NWS being down must not look like our bug, and a stale map beats
       no map — a storm from four minutes ago is still a storm. */
    console.warn("[karma] weather alerts:", e.message);
    if (cache.data) return res.json({ ...cache.data, stale: true, error: e.message });
    res.status(502).json({ error: "Could not reach the National Weather Service. " + e.message });
  }
});

module.exports = { router, digest, byState, tierOf, statesOf, RELEVANT };
