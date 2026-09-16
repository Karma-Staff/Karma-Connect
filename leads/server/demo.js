"use strict";
/* DEMO MODE — synthetic leads and a synthetic team, held in memory.

   Why it exists: the assignments board cannot be looked at, let alone used,
   without a database, and pointing a laptop at the production one just to see
   a layout is a bad trade. With KARMA_DEMO=1 the board runs on invented data
   and assigning really works — the numbers move, the bars move, and a reload
   shows what you did.

   THIS IS NOT A FIXTURE FOR TESTS AND NOT A FALLBACK. It answers a handful of
   endpoints itself and never touches Postgres, so it must never be reachable
   where real data lives:

     1. NODE_ENV must not be "production" — render.yaml sets exactly that.
     2. KARMA_DEMO must be set deliberately. No default.
     3. Its router is only mounted when both hold (see server/index.js), so in
        any other configuration this file's handlers do not exist at all.

   Everything it returns is flagged demo:true, and the board shows a banner, so
   nobody can mistake these numbers for the real base. */

const express = require("express");

const ON = process.env.KARMA_DEMO === "1" && process.env.NODE_ENV !== "production";

/* Deterministic PRNG: the same team and the same pile sizes every restart, so
   a layout problem is reproducible instead of reshuffling under you. */
function mulberry32(seed) {
  return function next() {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEAM = [
  { email: "asha.raj@karmastaff.com",   display_name: "Asha Raj",        weight: 0.26 },
  { email: "ben.okafor@karmastaff.com", display_name: "Ben Okafor",      weight: 0.22 },
  { email: "chloe.dunn@karmastaff.com", display_name: "Chloe Dunn",      weight: 0.18 },
  { email: "diego.marin@karmastaff.com", display_name: "Diego Marín",    weight: 0.12 },
  { email: "priya.nair@karmastaff.com", display_name: "Priya Nair",      weight: 0.08 },
  // deliberately empty-handed: the manager's screen exists to find this person
  { email: "sam.whitfield@karmastaff.com", display_name: "Sam Whitfield", weight: 0 },
];

/* An owner string that is nobody's account — the old system wrote plain names
   for years. It holds real leads and has to be visible and redistributable,
   but it is not somewhere new work can be sent. */
const LEGACY_OWNER = "R. Menon (old CRM)";

const STATUSES = ["New", "Contacted", "Responded", "Qualified", "Not interested"];

function build() {
  const rand = mulberry32(20260916);
  const leads = [];
  const TOTAL = 1180;
  for (let i = 1; i <= TOTAL; i++) {
    const r = rand();
    // ~31% unclaimed, a little legacy, the rest spread over the team by weight
    let owner = null;
    if (r > 0.31) {
      const pick = rand();
      if (pick < 0.06) owner = LEGACY_OWNER;
      else {
        let acc = 0;
        const t = (pick - 0.06) / 0.94;
        for (const p of TEAM) { acc += p.weight; if (t <= acc) { owner = p.email; break; } }
        if (!owner) owner = TEAM[0].email;
      }
    }
    /* Unclaimed work skews heavily to New — that is what makes it unclaimed.
       Anything already owned has usually been touched. */
    const status = owner
      ? STATUSES[Math.floor(rand() * STATUSES.length)]
      : (rand() < 0.82 ? "New" : STATUSES[1 + Math.floor(rand() * 4)]);
    const hasPhone = rand() < 0.74;
    const hasEmail = rand() < 0.58;
    leads.push({
      id: i, owner, status,
      phone: hasPhone ? "555-01" + String(1000 + (i % 9000)) : "",
      email: hasEmail ? `contact${i}@example.com` : "",
    });
  }
  return leads;
}

// module-level so an assignment survives a page reload, the way a database would
const LEADS = ON ? build() : [];

// the same three predicates the real board counts, kept in one place here too
const isReady = (l) => l.status === "New" && !!String(l.phone || "").trim();
const isEnrich = (l) => !String(l.phone || "").trim() && !String(l.email || "").trim();
const isWorked = (l) => l.status !== "New";

function tally(rows) {
  return {
    total: rows.length,
    ready: rows.filter(isReady).length,
    enrich: rows.filter(isEnrich).length,
    worked: rows.filter(isWorked).length,
  };
}

const router = express.Router();

router.get("/api/assignments", (req, res) => {
  const people = [];
  for (const t of TEAM) {
    const mine = LEADS.filter((l) => l.owner === t.email);
    people.push({ value: t.email, label: t.display_name, team: true, ...tally(mine) });
  }
  const legacy = LEADS.filter((l) => l.owner === LEGACY_OWNER);
  if (legacy.length) {
    people.push({ value: LEGACY_OWNER, label: LEGACY_OWNER, team: false, ...tally(legacy) });
  }
  const pool = tally(LEADS.filter((l) => !l.owner));
  const assigned = people.reduce((a, p) => a + p.total, 0);
  res.json({
    demo: true,
    people,
    unassigned: { total: pool.total, ready: pool.ready, enrich: pool.enrich },
    totals: { leads: LEADS.length, assigned, members: TEAM.length },
  });
});

/* Only the distribute query is served here — the board asks for unassigned
   leads, optionally narrowed to callable ones. Anything else falls through to
   the real router (which will fail without a database, honestly, rather than
   quietly pretending). */
router.get("/api/leads", (req, res, next) => {
  const focus = String(req.query.focus || "");
  if (!focus.includes("unassigned")) return next();
  const wantReady = focus.includes("ready");
  const limit = Math.min(Math.max(+req.query.limit || 50, 1), 200);
  const rows = LEADS
    .filter((l) => !l.owner && (!wantReady || isReady(l)))
    .slice(0, limit)
    .map((l) => ({ Id: l.id, id: l.id, Status: l.status, Owner: "" }));
  res.json({ rows, demo: true });
});

router.post("/api/bulk/assign", express.json({ limit: "64kb" }), (req, res) => {
  const ids = new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number));
  const owner = String(req.body?.owner ?? "").trim() || null;
  let affected = 0;
  for (const l of LEADS) {
    if (!ids.has(l.id) || l.owner === owner) continue;   // no-ops are not changes
    l.owner = owner;
    affected++;
  }
  res.json({ affected, owner, demo: true });
});

/* The KPI row across the top, so the page is not half-populated while the
   board below it is full. Same predicates again. */
router.get("/api/counts", (req, res) => {
  const t = tally(LEADS);
  res.json({
    companies: Math.round(LEADS.length * 0.58), people: Math.round(LEADS.length * 0.3),
    jobs: Math.round(LEADS.length * 0.12), favorites: 24, removed: 17,
    status_new: LEADS.filter((l) => l.status === "New").length,
    qualified: LEADS.filter((l) => l.status === "Qualified").length,
    with_phone: LEADS.filter((l) => String(l.phone || "").trim()).length,
    with_email: LEADS.filter((l) => String(l.email || "").trim()).length,
    ready: t.ready, needs_enrichment: t.enrich,
    unassigned: LEADS.filter((l) => !l.owner).length,
    week: 96, prev_week: 81, demo: true,
  });
});

if (ON) {
  console.warn("[karma] DEMO MODE — /api/assignments, /api/counts and the "
    + "distribute path serve INVENTED data from memory. Never set KARMA_DEMO on a deploy.");
} else if (process.env.KARMA_DEMO === "1") {
  console.error("[karma] KARMA_DEMO IGNORED — NODE_ENV=production.");
}

module.exports = { router, ON };
