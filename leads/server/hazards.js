"use strict";
/* The other three feeds behind Storm watch.

   The National Weather Service (alerts.js) says what the weather is about to
   do. It does not say that a wildfire is burning right now, that the ground
   shook, or that the federal government has formally declared a disaster —
   and those are the events that create the most restoration work of all.

   All four sources are official, free and need no key:

     FEMA   a declared disaster. The strongest signal there is: the federal
            government does not declare one for a bad afternoon. Per state,
            with the incident type, and it is the definition of catastrophic.
     NIFC   wildfires burning now, with acreage. Prescribed burns are
            excluded — a planned burn is not a customer.
     USGS   earthquakes. Magnitude decides whether it is news or damage.
     NHC    named tropical systems. Not tied to a state: a hurricane three
            days out has no landfall yet, and the NWS issues the state-level
            warnings when it does. Carried as a headline instead.

   Every fetch is isolated. One feed being down must cost its own layer and
   nothing else, so this uses allSettled throughout and each source returns
   an empty list rather than throwing. */

const { STATE_NAME } = require("./leads");

const UA = process.env.NWS_USER_AGENT
  || "KarmaLeads/1.0 (karmastaff.com; operations@karmastaff.com)";
const TIMEOUT_MS = 20000;
/* A declaration stays interesting while the cleanup runs, which is months —
   but as a "what happened" list, six weeks is the useful window. */
const FEMA_DAYS = 45;
const QUAKE_MIN = 4.0;            // below this, nothing needs restoring
const FIRE_MIN_ACRES = 100;       // smaller than this is a local crew's day

async function getJson(url, label) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`${label} returned ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

const isState = (c) => !!STATE_NAME[String(c || "").toUpperCase()];

/* ---------------- FEMA: declared disasters ---------------- */
async function fema() {
  const since = new Date(Date.now() - FEMA_DAYS * 86400e3).toISOString().slice(0, 10);
  const url = "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries"
    + `?$filter=declarationDate%20ge%20%27${since}%27`
    + "&$select=state,incidentType,declarationTitle,declarationDate,incidentBeginDate"
    + "&$orderby=declarationDate%20desc&$top=300";
  const d = await getJson(url, "FEMA");
  const rows = d.DisasterDeclarationsSummaries || [];
  /* One declaration covers many counties and arrives as many rows; collapse
     to one entry per state per event so the list is readable. */
  const seen = new Map();
  for (const r of rows) {
    const st = String(r.state || "").toUpperCase();
    if (!isState(st)) continue;
    const key = st + "|" + (r.declarationTitle || "");
    if (seen.has(key)) continue;
    seen.set(key, {
      source: "FEMA", tier: 3, states: [st],
      event: "Declared disaster — " + (r.incidentType || "incident"),
      area: String(r.declarationTitle || "").slice(0, 120),
      sent: r.declarationDate || r.incidentBeginDate || null,
    });
  }
  return [...seen.values()];
}

/* ---------------- NIFC: wildfires burning now ---------------- */
async function fires() {
  const url = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/"
    + "WFIGS_Incident_Locations_Current/FeatureServer/0/query"
    + "?where=1%3D1&outFields=*&returnGeometry=false&f=json&resultRecordCount=1000";
  const d = await getJson(url, "NIFC");
  const out = [];
  for (const f of (d.features || [])) {
    const a = f.attributes || {};
    // RX is a prescribed burn — deliberate, and not a customer
    if (String(a.IncidentTypeCategory || "").toUpperCase() !== "WF") continue;
    if (a.FireOutDateTime) continue;                       // already out
    // POOState arrives as "US-CA"
    const st = String(a.POOState || "").split("-").pop().toUpperCase();
    if (!isState(st)) continue;
    const acres = Number(a.DiscoveryAcres || a.FinalAcres || a.InitialResponseAcres || 0);
    if (acres < FIRE_MIN_ACRES) continue;
    out.push({
      source: "NIFC", tier: acres >= 1000 ? 3 : 2, states: [st],
      event: "Wildfire",
      area: `${String(a.IncidentName || "Unnamed fire").slice(0, 60)}`
        + (acres ? ` — ${Math.round(acres).toLocaleString()} acres` : "")
        + (a.POOCounty ? `, ${String(a.POOCounty).slice(0, 40)}` : ""),
      sent: a.FireDiscoveryDateTime ? new Date(a.FireDiscoveryDateTime).toISOString() : null,
    });
  }
  // biggest first, and cap it — California alone can have dozens
  out.sort((x, y) => y.tier - x.tier);
  return out.slice(0, 40);
}

/* ---------------- USGS: earthquakes ---------------- */
async function quakes() {
  const d = await getJson(
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson", "USGS");
  const out = [];
  for (const f of (d.features || [])) {
    const p = f.properties || {};
    const mag = Number(p.mag);
    if (!(mag >= QUAKE_MIN)) continue;
    /* "21 km WSW of Petrolia, CA" / "77 km WSW of Akhiok, Alaska" — the
       state is whatever follows the last comma, as a code or a full name. */
    const tail = String(p.place || "").split(",").pop().trim();
    const code = isState(tail.toUpperCase()) ? tail.toUpperCase()
      : Object.keys(STATE_NAME).find((k) => STATE_NAME[k].toLowerCase() === tail.toLowerCase());
    if (!code) continue;
    out.push({
      source: "USGS", tier: mag >= 5 ? 3 : 2, states: [code],
      event: `Magnitude ${mag.toFixed(1)} earthquake`,
      area: String(p.place || "").slice(0, 120),
      sent: p.time ? new Date(p.time).toISOString() : null,
    });
  }
  return out;
}

/* ---------------- NHC: named tropical systems ----------------
   Deliberately NOT given states. A storm in open water has no landfall yet,
   and guessing one would light up a coast on no evidence; when it does
   threaten land the NWS issues Hurricane and Storm Surge warnings, which
   alerts.js already reads. This is the heads-up above the map. */
async function storms() {
  const d = await getJson("https://www.nhc.noaa.gov/CurrentStorms.json", "NHC");
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  return (d.activeStorms || []).map((s) => ({
    name: String(s.name || "").slice(0, 40),
    kind: String(s.classification || "").toUpperCase(),       // TD / TS / HU / MH …
    intensityKt: num(s.intensity),                            // max sustained wind, knots
    pressureMb: num(s.pressure),                              // central pressure, mb
    lat: num(s.latitudeNumeric),
    lon: num(s.longitudeNumeric),
    moveDir: num(s.movementDir),                              // degrees, the way it is heading
    moveKt: num(s.movementSpeed),                             // knots
    basin: String(s.binNumber || "").slice(0, 8),
    /* Where to see the official forecast track / cone — the NHC's own map. */
    track: s.forecastGraphics?.url || s.trackCone?.zoomURL || s.publicAdvisory?.url || null,
    at: s.lastUpdate || null,
  })).slice(0, 8);
}

/* Everything, with whatever failed simply missing. */
async function all() {
  const [f, w, q, s] = await Promise.allSettled([fema(), fires(), quakes(), storms()]);
  const take = (r, label) => {
    if (r.status === "fulfilled") return r.value;
    console.warn(`[karma] hazards ${label}:`, r.reason && r.reason.message);
    return [];
  };
  return {
    events: [...take(f, "FEMA"), ...take(w, "NIFC"), ...take(q, "USGS")],
    storms: take(s, "NHC"),
    down: [["FEMA", f], ["NIFC", w], ["USGS", q], ["NHC", s]]
      .filter(([, r]) => r.status === "rejected").map(([n]) => n),
  };
}

module.exports = { all, fema, fires, quakes, storms };
