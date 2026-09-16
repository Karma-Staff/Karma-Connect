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
    const kind = rand() < 0.62 ? "company" : (rand() < 0.5 ? "person" : "job");
    const company = `Demo Company ${i}`;
    leads.push({
      id: i, lead_code: `KL-G${String(i).padStart(4, "0")}`,
      kind, name: kind === "company" ? company
        : (kind === "person" ? `Contact ${i}` : `Bookkeeper (posting ${i})`),
      company, title: null, contact: null, contact_title: null,
      website: null, job_url: null, category: null, industry: "Accounting",
      employees: null, revenue: null, certs: null,
      city: "Springfield", state: "TX",
      owner, status,
      phone: hasPhone ? "555-01" + String(1000 + (i % 9000)) : "",
      phone_key: hasPhone ? "55501" + String(1000 + (i % 9000)) : null,
      email: hasEmail ? `contact${i}@example.com` : "",
      favorite: i % 23 === 0, removed: false, notes: null,
      source: "Excel import", source_file: "generated",
      date_added: new Date(Date.now() - Math.floor(rand() * 40) * 864e5)
        .toISOString().slice(0, 10),
      company_lead_id: null,
    });
  }
  return leads;
}

/* KARMA_DEMO_XLSX points at a spreadsheet to use INSTEAD of the generated set —
   a real export makes the board behave like the real thing (real pile sizes,
   real proportion with a phone) without a database.

   The file is read from wherever it sits on disk and is never copied into the
   repo: these exports are real companies, names and phone numbers, and Leads'
   own .gitignore excludes *.xlsx for exactly that reason. Only this loader is
   committed. If the file is missing or unreadable the generated set is used,
   because a demo that cannot start is worse than an invented one. */
function fromSpreadsheet(file) {
  const XLSX = require("xlsx");
  // cellDates so "Posted On" arrives as a Date rather than an Excel serial
  const wb = XLSX.readFile(file, { cellDates: true });
  const raw = [];
  for (const sheet of wb.SheetNames) {
    for (const r of XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: "" })) raw.push(r);
  }
  // header names vary between exports, so match loosely rather than exactly
  const pick = (row, ...names) => {
    for (const n of names) {
      const key = Object.keys(row).find((k) => k.trim().toLowerCase() === n);
      if (key && String(row[key]).trim()) return String(row[key]).trim();
    }
    return "";
  };
  const date = (row, ...names) => {
    for (const n of names) {
      const key = Object.keys(row).find((k) => k.trim().toLowerCase() === n);
      const v = key ? row[key] : null;
      if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
      if (typeof v === "string" && v.trim()) {
        const d = new Date(v);
        if (!isNaN(d)) return d.toISOString().slice(0, 10);
      }
    }
    return null;
  };
  const digits = (p) => String(p || "").replace(/\D/g, "").slice(-10);
  const srcFile = file.split(/[\\/]/).pop();

  /* An Indeed export is a list of JOB POSTINGS, each belonging to a company, so
     it becomes two leads the way the real importer writes them: a company lead,
     and a job lead pointing back at it through company_lead_id. Emitting only
     one kind would leave either the Companies tab or the Job board empty and
     the app looking broken. Rows are shaped like the `leads` table because the
     client's fromApi() translates those column names directly. */
  const out = [];
  let id = 0;
  raw.forEach((r, i) => {
    const company = pick(r, "company", "employer") || `Company ${i + 1}`;
    const phone = pick(r, "phone", "phone number", "telephone");
    const common = {
      company,
      website: pick(r, "website", "site"),
      industry: pick(r, "industry", "category"),
      city: pick(r, "city", "town"),
      state: pick(r, "state / province", "state", "province"),
      phone,
      phone_key: digits(phone) || null,
      email: pick(r, "email", "email address") || null,
      status: pick(r, "lead status", "status") || "New",
      owner: pick(r, "owner", "assigned to") || null,
      removed: false,
      notes: pick(r, "notes", "note") || null,
      source: "Job board",
      source_file: srcFile,
      date_added: date(r, "posted on", "date added", "posted") || null,
      contact: null, contact_title: null, title: null,
      category: pick(r, "industry", "category") || null,
      employees: null, revenue: null, certs: null,
    };
    const companyId = ++id;
    out.push({
      ...common, id: companyId, lead_code: `KL-D${String(companyId).padStart(4, "0")}`,
      kind: "company", name: company, job_url: null, company_lead_id: null,
      // a handful of favorites so that tab is not a dead end in the demo
      favorite: i % 7 === 0,
    });
    const jobTitle = pick(r, "job title posted", "job title", "role");
    if (jobTitle) {
      const jobId = ++id;
      out.push({
        ...common, id: jobId, lead_code: `KL-D${String(jobId).padStart(4, "0")}`,
        kind: "job", name: jobTitle,
        job_url: pick(r, "indeed link", "job url", "link") || null,
        company_lead_id: companyId, favorite: false,
      });
    }
  });
  return out;
}

function load() {
  if (!ON) return { leads: [], source: null };
  const file = (process.env.KARMA_DEMO_XLSX || "").trim();
  if (file) {
    try {
      const leads = fromSpreadsheet(file);
      if (leads.length) {
        console.warn(`[karma] DEMO using ${leads.length} rows from ${file}`);
        return { leads, source: file.split(/[\\/]/).pop() };
      }
      console.error("[karma] DEMO spreadsheet had no rows — using generated data");
    } catch (e) {
      console.error("[karma] DEMO could not read the spreadsheet (" + e.message
        + ") — using generated data");
    }
  }
  return { leads: build(), source: null };
}

// module-level so an assignment survives a page reload, the way a database would
const loaded = load();
const LEADS = loaded.leads;
const SOURCE = loaded.source;

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

/* The demo router is mounted BEFORE the database-backed ones, so it must apply
   the same gates they do — otherwise it answers requests the real endpoint
   would refuse, which makes the demo lie about permissions and hides whether
   the real gate works at all. Same middleware, same source of truth. */
const auth = require("./auth");

router.get("/api/assignments", auth.requireAdmin, (req, res) => {
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
    demoSource: SOURCE,          // names the spreadsheet when one is loaded
    people,
    unassigned: { total: pool.total, ready: pool.ready, enrich: pool.enrich },
    totals: { leads: LEADS.length, assigned, members: TEAM.length },
  });
});

/* The whole list, not just the distribute query — otherwise the tabs sit empty
   while the KPI tiles show numbers, which reads as a broken app rather than a
   demo. Mirrors the real endpoint's filters and its {list,total,nextCursor}
   contract; paging is a plain offset because 70-odd rows do not need a keyset. */
router.get("/api/leads", auth.requireUser, (req, res) => {
  const p = req.query;
  const focus = String(p.focus || "");
  let rows = LEADS.slice();

  rows = rows.filter((l) => (p.removed === "true" ? l.removed : !l.removed));
  if (["company", "person", "job"].includes(p.kind)) rows = rows.filter((l) => l.kind === p.kind);
  if (p.favorite === "true") rows = rows.filter((l) => l.favorite);
  if (p.status) rows = rows.filter((l) => l.status === p.status);
  if (p.owner) rows = rows.filter((l) => (l.owner || "") === p.owner);
  if (p.state) {
    const want = String(p.state).toLowerCase();
    rows = rows.filter((l) => String(l.state || "").toLowerCase().startsWith(want));
  }
  if (p.q) {
    const q = String(p.q).toLowerCase();
    rows = rows.filter((l) => [l.name, l.company, l.email, l.city, l.contact]
      .some((v) => String(v || "").toLowerCase().includes(q)));
  }
  // the KPI tiles, same three predicates as everywhere else
  for (const key of focus.split(",")) {
    if (key === "ready") rows = rows.filter(isReady);
    else if (key === "enrich") rows = rows.filter(isEnrich);
    else if (key === "unassigned") rows = rows.filter((l) => !l.owner);
    else if (key === "week") rows = rows.filter((l) => l.date_added
      && (Date.now() - Date.parse(l.date_added)) < 7 * 864e5);
  }

  const total = rows.length;
  const limit = Math.min(Math.max(+p.limit || 50, 1), 200);
  const offset = Math.max(0, parseInt(p.cursor || "0", 10) || 0);
  const page = rows.slice(offset, offset + limit);
  res.json({
    list: page,
    rows: page,                       // the board's distribute call reads either
    total,
    nextCursor: offset + limit < total ? String(offset + limit) : null,
    demo: true,
  });
});

/* Opening a lead. The real endpoint answers by id or lead_code and includes a
   `related` block (the company a job belongs to, and its other postings), so
   the reading pane gets the same shape here. */
router.get("/api/leads/:key", auth.requireUser, (req, res) => {
  const key = String(req.params.key);
  const row = LEADS.find((l) => String(l.id) === key || l.lead_code === key);
  if (!row) return res.status(404).json({ error: "no such lead" });
  const related = { company: null, people: [], jobs: [], similar: null };
  if (row.company_lead_id) {
    related.company = LEADS.find((l) => l.id === row.company_lead_id) || null;
  }
  if (row.kind === "company") {
    related.jobs = LEADS.filter((l) => l.company_lead_id === row.id && l.kind === "job");
    related.people = LEADS.filter((l) => l.company_lead_id === row.id && l.kind === "person");
  }
  res.json({ ...row, related, demo: true });
});

router.post("/api/bulk/assign", auth.requireAdmin, express.json({ limit: "64kb" }), (req, res) => {
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
/* Counted from the same rows the list serves. Earlier these were fabricated
   percentages, which put numbers in the tiles while the tabs underneath were
   empty — a tile must never disagree with the list you get by clicking it. */
router.get("/api/counts", auth.requireUser, (req, res) => {
  const live = LEADS.filter((l) => !l.removed);
  const t = tally(live);
  const since = (days) => Date.now() - days * 864e5;
  const added = (from, to) => live.filter((l) => {
    if (!l.date_added) return false;
    const ms = Date.parse(l.date_added);
    return ms >= from && (to === null || ms < to);
  }).length;
  res.json({
    companies: live.filter((l) => l.kind === "company").length,
    people: live.filter((l) => l.kind === "person").length,
    jobs: live.filter((l) => l.kind === "job").length,
    favorites: live.filter((l) => l.favorite).length,
    removed: LEADS.filter((l) => l.removed).length,
    status_new: live.filter((l) => l.status === "New").length,
    qualified: live.filter((l) => l.status === "Qualified").length,
    with_phone: live.filter((l) => String(l.phone || "").trim()).length,
    with_email: live.filter((l) => String(l.email || "").trim()).length,
    ready: t.ready, needs_enrichment: t.enrich,
    unassigned: live.filter((l) => !l.owner).length,
    week: added(since(7), null),
    prev_week: added(since(14), since(7)),
    demo: true,
  });
});

if (ON) {
  console.warn("[karma] DEMO MODE — /api/assignments, /api/counts and the "
    + "distribute path serve INVENTED data from memory. Never set KARMA_DEMO on a deploy.");
} else if (process.env.KARMA_DEMO === "1") {
  console.error("[karma] KARMA_DEMO IGNORED — NODE_ENV=production.");
}

module.exports = { router, ON };
