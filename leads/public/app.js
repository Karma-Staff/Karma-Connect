/* Karma Connect, the lead floor — email-style client over the domain API */
"use strict";

const $ = (id) => document.getElementById(id);
const S = {
  me: null,            // {id, email, display_name, role} from /api/me
  tab: "companies",
  q: "",
  status: "",
  state: "",           // two-letter code, "" = everywhere
  board: "",           // job board source: linkedin | indeed | google, "" = all
  focus: "",           // armed KPI tile: ready | enrich | unassigned | week
  sort: "recent",
  list: [],
  page: 1,             // 1-based
  pageSize: 50,
  total: 0,
  cursors: [null],     // cursors[n] reaches page n+1 — keyset paging, not offset
  sel: null,           // {row, tkey}
  // Select is a mode an admin turns on in the filter row; the selection it
  // gathers is lead id -> {name, kind}, kept across paging (that's the point
  // of it) and dropped whenever the list itself changes.
  selectMode: false,
  picked: new Map(),
  recents: [],         // rows already joined with their leads — see loadRecents()
  segment: null,       // {category, state, label} while browsing one segment
};
const PAGE_SIZES = [25, 50, 100, 200];

/* Every tab is the same /api/leads query with different parameters — the old
   three-tables-merged-in-the-browser union (and its 1,000-row correctness cap)
   is gone; Favorites and DNC are just filters now. */
const TABS = {
  companies: { title: "Companies", kind: "company", pv: "Company", dateField: "Date Added" },
  people:    { title: "People",    kind: "person",  pv: "Name",    dateField: "Date Added" },
  jobs:      { title: "Job board", kind: "job",     pv: "Job Title", dateField: "Posted" },
  // "Recent" is an activity trail, not a date filter: the last 50 leads this
  // account actually touched, newest first. Starts empty for a new account.
  recent:    { title: "Recent activity", activity: true },
  favorites: { title: "Favorites", favorite: true },
  // admin-only: leads already in the Zoho call list (a Zoho CRM record linked),
  // so nobody calls or is assigned a person already being worked
  contacted: { title: "Contacted — registered in Zoho", contacted: true, admin: true },
  // admin-only under Manage: members remove with a 5s undo instead of a tab
  removed:   { title: "DNC — do not call", removedTab: true, admin: true },
  // admin-only, and not a list of leads at all: the team's action log
  stats:     { title: "Team activity", stats: true, admin: true },
  // admin-only, also not a list: who is carrying what, and the unclaimed pool
  assign:    { title: "Assignments", assign: true, admin: true },
  // admin-only: today's calls per person, and who is working right now
  calls:     { title: "Call report", calls: true, admin: true },
  // admin-only: RingCentral's own numbers for the whole account, live
  dash:      { title: "Dashboard", dash: true, admin: true },
  // admin-only: who is on the phone right now, and with which lead
  live:      { title: "Live calls", live: true, admin: true },
  // admin-only: every RingCentral call — search, filter, recordings, download
  calllog:   { title: "Call logs", calllog: true, admin: true },
  // admin-only: the team directory — phone system and Karma Connect, joined
  team:      { title: "Users", team: true, admin: true },
  // admin-only: power-dialer campaigns — build, assign, start, pause, end
  power:     { title: "Power dialer", power: true, admin: true },
  // admin-only: each outbound number's reputation — carrier status where a
  // provider is connected, and the Karma Connect Risk Score
  reputation: { title: "Caller reputation", reputation: true, admin: true },
  // everyone's own queue — not a filter over the base, so it is a pane of its
  // own like the ones above, and it is where a member lands
  tasks:     { title: "My tasks", tasks: true },
  // the briefings, gathered — the working copy lives inside each lead
  research:  { title: "Prospect research", research: true },
  // live severe weather, scored for restoration and joined to the base
  storm:     { title: "Storm watch", storm: true },
  // everyone's own phone, CRM, voicemail and audio — reps included
  me:        { title: "My settings", me: true },
  // everyone's own: the campaigns given to them and their own call history
  mycalls:   { title: "My calls", mycalls: true },
  // working an assigned list straight through, one lead at a time
  camp:      { title: "Call session", camp: true },
  // not in the sidebar: entered by clicking a segment tag in the reading pane
  segment:   { title: "Segment", kind: "company", pv: "Company",
               dateField: "Date Added", segment: true },
};
const UNION_KEYS = ["companies", "people", "jobs"];
const KIND_TAB = { company: "companies", person: "people", job: "jobs" };

/* The API speaks snake_case; the render layer below still reads the NocoDB-era
   title-case keys. This adapter is the whole translation, in one place, so the
   ~100 render call sites didn't have to change in the cutover. */
function fromApi(r) {
  const _t = KIND_TAB[r.kind] || "companies";
  return {
    _t, Id: r.id, "Lead Code": r.lead_code,
    Company: r.company, Name: r.kind === "person" ? r.name : r.company,
    "Job Title": r.kind === "job" ? r.name : null,
    Title: r.title, Contact: r.contact, "Contact Title": r.contact_title,
    Email: r.email, Phone: r.phone, "Phone Key": r.phone_key,
    Website: r.website, "Job URL": r.job_url, Logo: r.logo_url,
    Category: r.category, Industry: r.industry,
    Employees: r.employees, Revenue: r.revenue, Certs: r.certs,
    City: r.city, State: r.state,
    Status: r.status, Owner: r.owner,
    InZoho: !!r.in_zoho,
    ZohoKind: r.zoho_kind || (r.in_zoho ? "registered" : null),
    Favorite: r.favorite, Removed: r.removed,
    Source: r.source, "Source File": r.source_file,
    "Date Added": r.date_added, Posted: r.date_added,
    _related: r.related || null,
    ...(r.touched_at ? { _touchedAt: r.touched_at } : {}),
  };
}

const SRC_CHIP = {
  "Job board": "job", "Excel import": "excel", "Apollo export": "apollo",
  "Bitrix CRM": "bitrix", "Master DB": "master",
};
// lead statuses are not a fixed list any more: they follow Zoho's Call Result (loadStatusFilter)

/* Sort options — the keys go straight to /api/leads?sort=. An option is only
   offered where the underlying data exists: certifications only ever came in
   on companies, and job rows carry no revenue. */
const SORTS = [
  { key: "recent", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
  { key: "name", label: "Name A–Z" },
  { key: "name_z", label: "Name Z–A" },
  { key: "size", label: "Biggest company" },
  { key: "size_asc", label: "Smallest company" },
  { key: "certs", label: "Most certifications" },
  { key: "revenue", label: "Highest revenue" },
  { key: "state", label: "State A–Z" },
  { key: "city", label: "City A–Z" },
  { key: "status", label: "Status" },
];
const SORTLESS = { people: ["certs"], jobs: ["certs", "revenue"] };
const sortUsable = (key, tkey) => !(SORTLESS[tkey] || []).includes(key);

/* ---------------- api ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    // during boot a 401 just means "show the login screen" — only a session
    // dying mid-use triggers the full sign-out (else a cookie-less first
    // visit would reload forever)
    if (S.booted) logout();
    throw new Error("Not signed in");
  }
  if (!res.ok) {
    const text = await res.text();
    let msg;                          // the API sends {error: "readable message"}
    try {
      msg = JSON.parse(text).error;
      /* the main Karma Connect server shapes it {error: {message}} — read
         both, or a page ends up printing "[object Object]" */
      if (msg && typeof msg === "object") msg = msg.message || JSON.stringify(msg);
    } catch { /* not JSON */ }
    throw new Error(msg || `${path} -> ${res.status}: ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* ---------------- helpers ---------------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function initials(name) {
  if (!name) return "?";
  const w = String(name).trim().split(/\s+/);
  return ((w[0]?.[0] || "") + (w[1]?.[0] || "")).toUpperCase() || "?";
}
const AV_COLORS = ["#5470b8", "#8a5cb8", "#3f8f6b", "#b8745c", "#5c93b8", "#b85c85"];
function avColor(name) {
  let h = 0;
  for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}
function relTime(d) {
  if (!d) return "";
  const t = new Date(d).getTime();
  if (Number.isNaN(t)) return "";
  const s = (Date.now() - t) / 1000;
  if (s < 3600) return "just now";
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
/* absolute date for the detail grid — "Aug 12, 2026", never a raw ISO string.
   A leading YYYY-MM-DD is taken as a plain local date so it doesn't shift a
   day in negative-UTC timezones. */
function fmtDate(d) {
  if (!d) return "";
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const t = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(d);
  return Number.isNaN(t.getTime())
    ? String(d)
    : t.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function displayName(row, tkey) {
  return row[TABS[tkey].pv] || row.Company || "(no name)";
}
function chip(cls, label) {
  return label ? `<span class="chip ${cls}">${esc(label)}</span>` : "";
}
function statusChip(st) {
  const cls = "chip-st-" + (st || "New").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return chip(cls, st || "New");
}
/* The statuses leads actually have — they follow Zoho's Call Result now, so
   the list is the server's, not a fixed one. Fills the status filter. */
async function loadStatusFilter() {
  const sel = $("filter-status");
  if (!sel) return;
  try {
    const { statuses } = await api("/api/lead-statuses");
    const cur = sel.value;
    sel.innerHTML = `<option value="">All statuses</option>` + statuses.map((s) =>
      `<option value="${esc(s.status)}">${esc(s.status)}${s.n ? ` (${s.n.toLocaleString()})` : ""}</option>`).join("");
    if (cur && !statuses.some((s) => s.status === cur))
      sel.insertAdjacentHTML("beforeend", `<option value="${esc(cur)}">${esc(cur)}</option>`);
    sel.value = cur;
  } catch (e) { /* keep whatever the page shipped with */ }
}
function sourceChip(src) {
  return chip("chip-src-" + (SRC_CHIP[src] || "other"), src);
}
/* Already in the Zoho call list — a Zoho CRM record is linked to this lead,
   whether we created it or it was made in Zoho and matched back to us. */
/* Beside Scan Zoho: the automatic scan's setting, and — on hover — when the
   last scan ran and what it found. */
async function zohoAutoLoad() {
  const sel = $("zoho-auto");
  if (!sel || !isAdmin()) return;
  let s;
  try { s = await api("/api/crm/zoho/scan"); } catch (e) { sel.title = "Couldn't read the scan setting: " + e.message; return; }
  sel.value = s.auto ? String(s.every) : "off";
  sel.disabled = !s.enabled;
  const last = s.last;
  const read = last?.read ? Object.values(last.read).reduce((a, b) => a + b, 0) : 0;
  // relTime says "just now" for anything under an hour — too coarse for a 10-minute scan
  const relTime = (d) => {
    const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : window.relTime(d);
  };
  sel.title = !s.enabled ? "Zoho CRM isn't configured on this server"
    : [s.auto ? `Zoho is scanned by itself every ${s.every === 60 ? "hour" : s.every + " minutes"}.` : "Automatic scan is off.",
      last?.at ? `Last scan ${relTime(last.at)}: ${dashN(read)} Zoho record${read === 1 ? "" : "s"} read, ${
        dashN((last.labelled?.lead || 0) + (last.labelled?.registered || 0))} lead${(last.labelled?.lead || 0) + (last.labelled?.registered || 0) === 1 ? "" : "s"} newly labelled.`
        : "No scan has run yet.",
      last?.errors ? "Problems: " + Object.entries(last.errors).map(([m, e]) => `${m}: ${e}`).join("; ") : "",
      s.changedBy ? `Set by ${s.changedBy}${s.changedAt ? " " + relTime(s.changedAt) : ""}.` : ""].filter(Boolean).join("\n");
}

function zohoChip(on, kind) {
  if (!on) return "";
  /* Two kinds, from the 10-minute Zoho scan (zoho-scan.js): the number is a
     Zoho Lead (or Contact), or it is only in Zoho's call history. */
  return kind === "lead"
    ? `<span class="chip chip-zoho" title="This number is a Lead in Zoho CRM">Zoho Lead</span>`
    : `<span class="chip chip-zoho chip-zoho-reg" title="This number is in Zoho CRM's call history">In Zoho</span>`;
}

/* ---------------- auth ---------------- */
function logout() {
  // clear the sealed session server-side and end it at WorkOS too
  fetch("/api/auth/logout", { method: "POST" })
    .then((r) => r.json())
    .then((o) => { location.href = o.url || "/"; })
    .catch(() => location.reload());
}

/* ---------------- meta discovery ---------------- */
async function discover() {
  // one call answers both "who am I" and "am I invited" — the API's 403 body
  // ("x is not invited...") surfaces on the login screen via api()'s message
  S.me = await api("/api/me");
}

/* 35,271 -> "35.3k"; small numbers stay exact. The tile carries the precise
   figure in its title attribute. */
function compact(n) {
  if (n < 10000) return n.toLocaleString();
  if (n < 1e6) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
}
const pct = (n, total) => total > 0 ? (n / total) * 100 : 0;

/* ---------------- the KPI tiles ----------------
   Four work queues, each one clickable. The tile's number and the list you get
   by clicking it are the same predicate (FOCUS in server/leads.js), so a tile
   is a to-do count you can act on rather than a statistic you read past. */
const FOCUS_LABEL = {
  ready: "Ready to work",
  enrich: "Needs enrichment",
  unassigned: "Unassigned",
  week: "New this week",
};

function setTile(id, value, sideHtml, vizHtml) {
  const v = $("stat-" + id);
  if (v) {
    v.textContent = compact(value);
    v.title = value.toLocaleString() + " leads";
  }
  const s = $("side-" + id);
  if (s) s.innerHTML = sideHtml || "";
  const z = $("viz-" + id);
  if (z) z.innerHTML = vizHtml || "";
}

/* a queue as a share of the live base: the meter plus the percentage written
   out, so the ratio is never carried by bar length alone */
function queueTile(id, value, total) {
  const p = pct(value, total);
  setTile(id, value,
    `${p > 0 && p < 1 ? "<1" : Math.round(p)}% of base`,
    `<div class="meter${value ? "" : " is-empty"}"><span style="width:${p.toFixed(1)}%"></span></div>`);
}

/* S.focus is an overlay filter like S.status/S.state: it rides along with
   whichever tab you are on, so arming "Unassigned" inside Companies means
   unassigned companies. The armed tile is the filter's only control — click it
   again to clear. */
function paintTiles() {
  document.querySelectorAll(".stat[data-focus]").forEach((b) => {
    const on = b.dataset.focus === S.focus;
    b.classList.toggle("armed", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

/* The tabs that replace the list and reading panes with a full-width surface
   of their own. One table, so setTab, the KPI tiles and renderSortOptions
   cannot drift apart as more of them appear. */
const PANES = {
  stats:  "stats-pane",
  assign: "assign-pane",
  calls:  "calls-pane",
  dash:   "dash-pane",
  live:   "live-pane",
  calllog: "calllog-pane",
  team:   "team-pane",
  power:  "power-pane",
  reputation: "rep-pane",
  tasks:  "tasks-pane",
  research: "research-pane",
  storm: "storm-pane",
  me: "me-pane",
  mycalls: "mycalls-pane",
  camp: "camp-pane",
};
const paneOf = (tab) => Object.keys(PANES).find((k) => TABS[tab]?.[k]) || null;

function toggleFocus(key) {
  if (!FOCUS_LABEL[key]) return;
  S.focus = S.focus === key ? "" : key;
  paintTiles();
  // Team activity reads the log, not the leads table — there is no list there
  // to filter, so arming a queue from it means "show me those leads"
  if (S.focus && paneOf(S.tab)) return setTab("companies");
  const list = $("lead-list");
  if (list) list.scrollTop = 0;
  loadList(true);
}

let countsPending = false;
async function refreshCounts() {
  if (countsPending) return;            // coalesce the burst after a bulk import
  countsPending = true;
  try { await runCounts(); }
  catch (e) { console.warn("[karma] counts failed", e); }
  finally { countsPending = false; }
}

async function runCounts() {
  // one aggregate endpoint, one SQL pass, cached 30s server-side — this used
  // to be ~26 separate count queries per refresh
  const c = await api("/api/counts");
  const total = c.total;
  $("count-companies").textContent = c.companies.toLocaleString();
  $("count-people").textContent = c.people.toLocaleString();
  $("count-jobs").textContent = c.jobs.toLocaleString();
  $("count-favorites").textContent = c.favorites.toLocaleString();
  $("count-removed").textContent = c.removed.toLocaleString();
  // companies and people already in Zoho are counted here instead (admins)
  if ($("count-contacted")) $("count-contacted").textContent = c.contacted != null ? c.contacted.toLocaleString() : "";
  // ("Recent" is the activity trail — its badge comes from S.recents)

  // the three work queues, each as a count + its share of the live base
  queueTile("ready", c.ready, total);
  queueTile("enrich", c.needs_enrichment, total);
  queueTile("unassigned", c.unassigned, total);

  // new-this-week gets a two-bar comparison, not a share meter: a week's
  // intake against 35k would be a permanently empty bar, while against the
  // previous 7 days it is the comparison the delta is actually claiming.
  // A percentage off a near-zero baseline is noise ("↑8000%" for 1 -> 81), so
  // the delta only appears when the prior week is big enough to mean anything.
  const wk = c.week, prev = c.prev_week, top = Math.max(wk, prev, 1);
  const change = prev >= 10 ? Math.round(((wk - prev) / prev) * 100) : null;
  const arrow = change > 0 ? "↑" : change < 0 ? "↓" : "→";
  const dir = change > 0 ? " up" : change < 0 ? " down" : "";
  setTile("week", wk,
    change !== null
      ? `<span class="delta${dir}">${arrow} ${Math.abs(change)}%</span>` : "",
    `<div class="spark">
       <span style="height:${((prev / top) * 100).toFixed(1)}%"
             title="previous 7 days: ${prev.toLocaleString()}"></span>
       <span class="now" style="height:${((wk / top) * 100).toFixed(1)}%"
             title="this week: ${wk.toLocaleString()}"></span>
     </div>`);
  const sub = $("sub-week");
  if (sub) sub.innerHTML = change !== null
    ? `vs <b>${prev.toLocaleString()}</b> the previous 7 days`
    : wk ? `previous 7 days: <b>${prev.toLocaleString()}</b>`
         : "nothing added in 7 days";

  paintTiles();
}

/* ---------------- recents (the leads this account touched) ----------------
   The trail is kept per account by the server so it follows the person between
   browsers. Mutations (status, owner, favorite, remove, notes) land on it
   server-side inside their own endpoints now; the one event the client still
   reports is "open", because opening a lead is a read the server can't see.
   The GET returns full rows already joined with their leads, removed ones
   filtered out — no second lookup. */
const RECENT_MAX = 50;                   // keep in step with MAX in server/recents.js

function recentsBadge() {
  const el = $("count-recent");
  if (el) el.textContent = S.recents.length.toLocaleString();
}

async function loadRecents() {
  try {
    S.recents = ((await api("/api/recents")).list || []).map(fromApi);
    recentsBadge();
  } catch (e) {
    console.warn("[karma] recents unavailable", e);
  }
}

/* Record an open. Fire-and-forget on purpose — nothing the user does should
   ever wait on the trail being written. */
function touchLead(item) {
  if (!item || !UNION_KEYS.includes(item._t) || !item.Id) return;
  S.recents = [
    { ...item, _touchedAt: new Date().toISOString() },
    ...S.recents.filter((x) => x.Id !== item.Id),
  ].slice(0, RECENT_MAX);
  recentsBadge();
  // the list is deliberately not re-rendered on the response: reshuffling rows
  // under the pointer while someone is reading a lead is worse than being stale
  api("/api/recents", {
    method: "POST",
    body: JSON.stringify({ lead_id: item.Id }),
  }).catch((e) => console.warn("[karma] could not save recent", e));
}

/* The trail is 50 rows and already in the right order, so its search, status
   and state filters run here instead of as a where clause. */
/* The Recent tab pages its ≤50-row trail locally, so the armed tile has to be
   re-implemented client-side. Keep these in step with FOCUS in server/leads.js
   — same rule, two runtimes, exactly like the dedupe guards. */
const filled = (v) => !!String(v ?? "").trim();
const daysAgo = (n) => {                    // local YYYY-MM-DD, matching date_added
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const FOCUS_TEST = {
  ready:      (r) => filled(r.Phone) && (r.Status || "New") === "New",
  enrich:     (r) => !filled(r.Phone) && !filled(r.Email),
  unassigned: (r) => !filled(r.Owner),
  week:       (r) => !!r["Date Added"] && r["Date Added"] >= daysAgo(6),
};

function matchesFilters(r) {
  if (S.focus && !FOCUS_TEST[S.focus](r)) return false;
  if (S.status && (r.Status || "New") !== S.status) return false;
  if (S.state) {
    const st = String(r.State || "").trim().toLowerCase();
    const full = (STATE_NAME[S.state] || "").toLowerCase();
    if (st !== S.state.toLowerCase() && (!full || st !== full)) return false;
  }
  if (S.q) {
    const hay = [displayName(r, r._t), r.Company, r.Email, r.City, r.Contact]
      .filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(S.q.toLowerCase())) return false;
  }
  return true;
}

/* ---------------- list ----------------
   One endpoint serves every tab: /api/leads with different parameters. The
   sidebar tabs are kind filters, Favorites/DNC are boolean filters (no
   more browser-side union or its 1,000-row cap), and a segment is just
   category + state. Paging is keyset: cursors[n] reaches page n+1, so page
   400 costs what page 1 costs and rows can't shift underneath the pager. */
function listParams() {
  const cfg = TABS[S.tab];
  const p = new URLSearchParams();
  if (cfg.segment && S.segment) {
    p.set("kind", "company");
    p.set("category", S.segment.category);
    p.set("state", S.segment.state);
  } else {
    if (cfg.kind) p.set("kind", cfg.kind);
    if (cfg.favorite) p.set("favorite", "true");
    if (cfg.removedTab) p.set("removed", "true");
    if (cfg.contacted) p.set("inzoho", "true");   // already in the Zoho call list
    if (S.state) p.set("state", S.state);
  }
  if (S.q) p.set("q", S.q);
  if (S.status) p.set("status", S.status);
  // the board filter only means anything on the job board (its control is
  // hidden everywhere else), so the param only rides along there
  if (S.board && cfg.kind === "job") p.set("board", S.board);
  if (S.focus) p.set("focus", S.focus);          // an armed KPI tile
  p.set("sort", sortUsable(S.sort, S.tab) ? S.sort : "recent");
  p.set("limit", S.pageSize);
  const cur = S.cursors[S.page - 1];
  if (cur) p.set("cursor", cur);
  return p;
}

function openSegment(category, state, label) {
  S.segment = { category, state, label };
  S.tab = "segment";
  S.page = 1;
  S.cursors = [null];
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
  $("segment-back")?.classList.remove("hidden");
  $("seg-eyebrow")?.classList.remove("hidden");
  $("list-head")?.classList.add("in-segment");
  $("clear-recents")?.classList.add("hidden");
  $("board-ctl")?.classList.add("hidden");   // segments list companies
  renderSortOptions();
  $("lead-list").scrollTop = 0;
  loadList(true);
}

function exitSegment() {
  S.segment = null;
  setTab("companies");
}

async function loadList(resetPage = false) {
  // a new list is a new selection: paging keeps the ticks, changing tab,
  // search, filter or sort drops them rather than acting on rows nobody can
  // still see
  if (resetPage) { S.page = 1; S.cursors = [null]; S.picked.clear(); }
  const cfg = TABS[S.tab];
  // Team activity reads the log, not the leads table — no list, no pager
  if (cfg.stats) return loadStats();
  if (cfg.assign) return loadAssignments();
  if (cfg.calls) return loadCallReport();
  if (cfg.dash) return loadDash();
  if (cfg.live) return loadLive();
  if (cfg.calllog) return loadCallLog();
  if (cfg.team) return loadTeam();
  if (cfg.reputation) return loadRep();
  if (cfg.power) return loadPower();
  if (cfg.tasks) return loadTasks();
  if (cfg.research) return loadResearchCenter();
  if (cfg.storm) return loadStorm();
  if (cfg.me) return loadMySettings();
  if (cfg.mycalls) return loadMyCalls();
  if (cfg.camp) return loadCampaign();
  // the armed tile is named in the header too: a list that is short because a
  // KPI tile is filtering it should never look like a list that is just short
  $("list-title").textContent =
    (cfg.segment ? (S.segment?.label || "Segment") : cfg.title)
    + (S.focus ? ` · ${FOCUS_LABEL[S.focus]}` : "");

  if (cfg.activity) {
    // 50 rows at most: refetch the trail, filter and page locally
    await loadRecents();
    const rows = S.recents.filter(matchesFilters);
    S.total = rows.length;
    const start = (S.page - 1) * S.pageSize;
    S.list = rows.slice(start, start + S.pageSize);
  } else {
    if (cfg.segment && !S.segment) return exitSegment();
    const r = await api(`/api/leads?${listParams()}`);
    S.list = (r.list || []).map(fromApi);
    if (r.total != null) S.total = r.total;      // only sent on the first page
    S.cursors[S.page] = r.nextCursor;
    if (cfg.segment) {
      const eb = $("seg-eyebrow");
      if (eb) eb.textContent =
        `Segment · ${S.total.toLocaleString()} compan${S.total === 1 ? "y" : "ies"}`;
    }
  }
  // the page can fall off the end when rows leave the view (unfavorited, removed)
  if (!S.list.length && S.page > 1) {
    S.page = 1;
    S.cursors = [null];
    return loadList();
  }
  renderList();
  renderPager();
}

function pageCount() {
  return Math.max(1, Math.ceil(S.total / S.pageSize));
}

function goToPage(n) {
  let p = Math.min(Math.max(1, n), pageCount());
  // keyset paging can only reach pages whose cursor it has seen: any earlier
  // page (cursors are kept), or exactly one page forward. The activity tab
  // pages a 50-row local array and can jump anywhere.
  if (!TABS[S.tab].activity && p > S.page) {
    p = S.cursors[S.page] ? S.page + 1 : S.page;
  }
  if (p === S.page) return;
  S.page = p;
  $("lead-list").scrollTop = 0;
  loadList();
}

function renderPager() {
  // highlight the controls that are actually narrowing the list
  $("filter-state")?.closest(".ctl")?.classList.toggle("on", !!S.state);
  $("filter-status")?.closest(".ctl")?.classList.toggle("on", !!S.status);
  $("filter-board")?.closest(".ctl")?.classList.toggle("on", !!S.board);
  $("sort-by")?.closest(".ctl")?.classList.toggle("on",
    S.sort !== "recent" && !TABS[S.tab].activity && !TABS[S.tab].segment);
  const pages = pageCount();
  const from = S.total ? (S.page - 1) * S.pageSize + 1 : 0;
  const to = Math.min(S.page * S.pageSize, S.total);
  $("pager-range").textContent = S.total
    ? `${from.toLocaleString()}–${to.toLocaleString()} of ${S.total.toLocaleString()}`
    : "no leads";
  $("pager-page").textContent = `Page ${S.page} of ${pages.toLocaleString()}`;
  $("pager-first").disabled = $("pager-prev").disabled = S.page <= 1;
  const activity = TABS[S.tab].activity;
  $("pager-next").disabled = activity
    ? S.page >= pages
    : !S.cursors[S.page];               // keyset: next exists only via its cursor
  // "last" needs an arbitrary jump, which keyset paging deliberately gave up
  $("pager-last").disabled = activity ? S.page >= pages : true;
  $("pager-last").title = activity ? "Last page" : "Not available with fast paging";
  $("page-size").value = String(S.pageSize);
}

function rowSubtitle(r) {
  if (r._t === "jobs") return [r.Company, r.Contact].filter(Boolean).join(" · ");
  if (r._t === "people") return r.Title || "";
  return r.Category || "";
}

/* ---- fact formatting: location + size ---- */
const US_STATE_ABBR = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC",
};
/* abbreviation -> full name, for the state filter and every label that shows a
   state. "of" stays lowercase so DC doesn't read "District Of Columbia". */
const STATE_NAME = Object.fromEntries(Object.entries(US_STATE_ABBR)
  .map(([full, ab]) => [ab, full.replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\bOf\b/g, "of")]));

/* States are displayed in full, never abbreviated: the sources disagree
   ("FL" in one file, "Florida" in the next) and a mixed column reads as two
   different places. Filtering still keys off the abbreviation — only the
   label changes. */
function fullState(s) {
  if (!s) return "";
  const k = String(s).trim();
  return STATE_NAME[k.toUpperCase()] || titleCase(k);
}
function titleCase(s) {
  return String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
function locationLabel(r) {
  const city = r.City ? titleCase(r.City) : "";
  const st = fullState(r.State);
  if (city && st) return `${city}, ${st}`;
  return city || st || "";
}
/* Segment titles are stored as "Category · ST" by the rebuild; expand the
   state half for display without touching the stored value. */
function fullSegmentLabel(label) {
  const parts = String(label || "").split("·").map((p) => p.trim());
  if (parts.length < 2) return String(label || "");
  const last = parts[parts.length - 1];
  if (STATE_NAME[last.toUpperCase()]) parts[parts.length - 1] = STATE_NAME[last.toUpperCase()];
  return parts.join(" · ");
}
/* size band from headcount — the "label about size" on each card */
function sizeBand(n) {
  if (!n || n < 1) return null;
  if (n === 1) return { label: "Solo", cls: "size-1" };
  if (n <= 10) return { label: "Micro", cls: "size-2" };
  if (n <= 50) return { label: "Small", cls: "size-3" };
  if (n <= 200) return { label: "Mid", cls: "size-4" };
  return { label: "Large", cls: "size-5" };
}
function fmtMoney(v) {
  if (!v || v <= 0) return "";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${v}`;
}
/* one compact facts line: location · size · revenue · industry */
function factsHtml(r) {
  const out = [];
  const loc = locationLabel(r);
  if (loc) out.push(`<span class="fact"><span class="fact-ic">📍</span>${esc(loc)}</span>`);
  const band = sizeBand(r.Employees);
  if (band) {
    out.push(`<span class="fact"><span class="fact-ic">👥</span>${r.Employees.toLocaleString()}` +
      `<span class="size-tag ${band.cls}">${band.label}</span></span>`);
  }
  const rev = fmtMoney(r.Revenue);
  if (rev) out.push(`<span class="fact"><span class="fact-ic">💵</span>${rev}</span>`);
  if (r.Certs > 0)
    out.push(`<span class="fact" title="certifications on file"><span class="fact-ic">🏅</span>${r.Certs} cert${r.Certs > 1 ? "s" : ""}</span>`);
  if (r.Industry) out.push(`<span class="fact fact-industry">${esc(titleCase(r.Industry))}</span>`);
  return out.length ? `<div class="lead-facts">${out.join("")}</div>` : "";
}

/* the initials circle, overlaid by the real logo when the scrape brought one —
   a stale or blocked logo URL just falls back to the initials */
function avatarHtml(name, logo, cls = "avatar", style = "") {
  return `<span class="${cls}" style="${style}background:${avColor(name)}">${esc(initials(name))}${
    logo ? `<img class="avatar-img" src="${esc(logo)}" alt="" loading="lazy">` : ""}</span>`;
}
/* No inline handlers anywhere (the /leads CSP forbids inline script). A logo
   that fails to load is removed here instead — error does not bubble, so this
   listens in the capture phase — and buttons rendered into innerHTML name
   their action in data-act. */
document.addEventListener("error", (e) => {
  if (e.target instanceof HTMLImageElement && e.target.classList.contains("avatar-img")) e.target.remove();
}, true);
document.addEventListener("click", (e) => {
  const el = e.target.closest?.("[data-act]");
  const act = el && { loadDash, openNewCampaign }[el.dataset.act];
  if (act) act();
});

/* bulk imports gave most of the base the same Date Added, so the list column
   shows reachability instead — both slots always render so absence is visible */
function reachHtml(r) {
  return `<span class="lead-reach">` +
    `<span class="reach-ic${r.Email ? "" : " off"}" title="${r.Email ? "has email" : "no email"}">✉</span>` +
    `<span class="reach-ic${r.Phone ? "" : " off"}" title="${r.Phone ? "has phone" : "no phone"}">☎</span>` +
    `</span>`;
}

function renderList() {
  const el = $("lead-list");
  const canPick = isAdmin() && S.selectMode;
  el.innerHTML = S.list.map((r, i) => {
    const name = displayName(r, r._t);
    // jobs carry the company in the subtitle instead, so the title stays readable
    const co = r._t === "people" && r.Company && r.Company !== name
      ? ` <span class="co">· ${esc(r.Company)}</span>` : "";
    // the full name, for the tooltip on rows the ellipsis truncates
    const full = co ? `${name} · ${r.Company}` : name;
    // the activity trail's touched-at and a job's posting date are real
    // information; an import date is one bulk-load day — show reach instead
    const date = r._touchedAt || (r._t === "jobs" ? r[TABS[r._t].dateField] : "");
    const side = date ? `<span class="lead-date">${relTime(date)}</span>` : reachHtml(r);
    const sel = S.sel && S.sel.row.Id === r.Id && S.sel.tkey === r._t ? " selected" : "";
    const picked = S.picked.has(r.Id);
    return `
    <div class="lead-row${sel}${picked ? " picked" : ""}" data-i="${i}">
      ${canPick ? `<input type="checkbox" class="row-pick" data-pick="${i}"
              ${picked ? "checked" : ""} title="Select — shift-click for a range"
              aria-label="Select ${esc(name)}">` : ""}
      ${avatarHtml(name, r.Logo)}
      <div class="lead-row-main">
        <div class="lead-name" title="${esc(full)}">${esc(name)}${co}</div>
        ${rowSubtitle(r) ? `<div class="lead-sub">${esc(rowSubtitle(r))}</div>` : ""}
        ${factsHtml(r)}
        <div class="lead-meta">${sourceChip(r.Source || (r._t === "jobs" ? "Job board" : ""))}${statusChip(r.Status)}${zohoChip(r.InZoho, r.ZohoKind)}</div>
      </div>
      <div class="lead-side">
        <button class="fav-star${r.Favorite ? " on" : ""}" data-fav="${i}"
                title="${r.Favorite ? "Remove from favorites" : "Add to favorites"}">★</button>
        ${side}
      </div>
    </div>`;
  }).join("") || `<div class="detail-empty" style="height:200px"><p>${
    S.tab === "recent" && !S.recents.length
      ? "Nothing here yet — leads you open or update show up in this list"
      : "No leads match"}</p></div>`;
  el.querySelectorAll(".lead-row").forEach((row) =>
    row.addEventListener("click", () => select(S.list[+row.dataset.i])));
  el.querySelectorAll("[data-fav]").forEach((star) =>
    star.addEventListener("click", (e) => {
      e.stopPropagation();                       // don't open the lead
      toggleFavorite(S.list[+star.dataset.fav]);
    }));
  el.querySelectorAll("[data-pick]").forEach((box) =>
    box.addEventListener("click", (e) => {
      e.stopPropagation();                       // ticking is not opening
      onPick(+box.dataset.pick, box.checked, e.shiftKey);
    }));
  renderBulkTools();
}

/* ---------------- bulk selection (admin) ----------------
   Select is a mode, toggled from the filter row, because a permanent checkbox
   column turns a reading list into a form. With it on, every row grows a box
   and the three things that can happen to a selection — assign an owner, ban
   the numbers, bin the leads — sit beside the toggle. They are the same three
   mutations the reading pane offers on one lead, applied by the server under
   the same rules (server/bulk.js). Members never see any of it, and the routes
   403 them anyway. */
/* The same ladder the API enforces (leads/server/auth.js). Presentation
   only — every gate below is also a 403 — but it has to agree, or an owner
   loses the manager screens they outrank. */
const RANK = { member: 0, sales_rep: 0, admin: 1, owner: 2 };
/* sales_rep has a member's access; it marks whose calling the reports cover. */
const ROLE_LABEL = { owner: "Owner", admin: "Admin", member: "Member", sales_rep: "Sales rep" };
const roleLabel = (r) => ROLE_LABEL[r] || (r ? r[0].toUpperCase() + r.slice(1) : "");
const rankOf = (role) => RANK[role] ?? 0;
const isAdmin = () => rankOf(S.me?.role) >= RANK.admin;
const isOwner = () => rankOf(S.me?.role) >= RANK.owner;
const BULK_MAX = 500;                 // keep in step with MAX_IDS in server/bulk.js
let lastPick = null;                  // row index, for shift-click ranges

function setPick(r, on) {
  if (!r) return;
  if (on) {
    if (!S.picked.has(r.Id) && S.picked.size >= BULK_MAX) return;
    S.picked.set(r.Id, { name: displayName(r, r._t), kind: r._t });
  } else S.picked.delete(r.Id);
}

function onPick(i, on, shift) {
  if (shift && lastPick !== null && lastPick !== i) {
    const [a, b] = lastPick < i ? [lastPick, i] : [i, lastPick];
    for (let k = a; k <= b; k++) setPick(S.list[k], on);
  } else {
    setPick(S.list[i], on);
  }
  lastPick = i;
  if (S.picked.size >= BULK_MAX)
    toast(`${BULK_MAX} leads is the most one action can take`);
  paintPicks();
}

/* Rows are repainted in place, never re-rendered: replacing the list's HTML
   would throw a scrolled list back to the top halfway through a selection. */
function paintPicks() {
  $("lead-list")?.querySelectorAll("[data-pick]").forEach((box) => {
    const r = S.list[+box.dataset.pick];
    const on = !!r && S.picked.has(r.Id);
    box.checked = on;
    box.closest(".lead-row")?.classList.toggle("picked", on);
  });
  renderBulkTools();
}

/* the filter row's bulk half: the toggle is always there for an admin, the
   count and the three actions only while the mode is on */
function renderBulkTools() {
  const tools = $("bulk-tools");
  if (!tools || !isAdmin()) return;
  const on = S.selectMode;
  const n = S.picked.size;
  const onPage = S.list.filter((r) => S.picked.has(r.Id)).length;
  const toggle = $("bulk-toggle");
  toggle.classList.toggle("on", on);
  toggle.setAttribute("aria-pressed", String(on));
  toggle.title = on
    ? "Done selecting — hides the checkboxes and clears the selection"
    : "Select several leads at once";
  $("bulk-pick-all").classList.toggle("hidden", !on);
  ["bulk-assign", "bulk-dnc", "bulk-delete"].forEach((id) =>
    $(id).classList.toggle("hidden", !on));
  if (!on) return;
  $("bulk-count").textContent = n ? `${n.toLocaleString()} selected` : "none selected";
  const all = $("bulk-all");
  all.checked = !!S.list.length && onPage === S.list.length;
  all.indeterminate = onPage > 0 && onPage < S.list.length;
  $("bulk-assign").disabled = !n;
  $("bulk-delete").disabled = !n;
  // the DNC tab lists leads whose numbers are already banned
  $("bulk-dnc").disabled = !n || !!TABS[S.tab].removedTab;
}

/* Turning the mode off drops the selection — leaving ticks alive under a
   list with no checkboxes is how a later click deletes something nobody
   remembers picking. */
function setSelectMode(on) {
  S.selectMode = !!on;
  localStorage.setItem("kl_select_mode", S.selectMode ? "1" : "");
  if (!S.selectMode) {
    S.picked.clear();
    lastPick = null;
  }
  renderList();                        // rows gain or lose their checkbox
}

function clearPicks() {
  S.picked.clear();
  lastPick = null;
  paintPicks();
}

/* every bulk action ends the same way: the selection is spent, the list and
   the tiles are stale, and the reading pane may be showing a lead that just
   left the view */
async function afterBulk(ids, { closeDetail = false } = {}) {
  const openId = S.sel?.row?.Id;
  const hitOpen = openId != null && ids.includes(openId);
  clearPicks();
  closeModal();
  if (hitOpen && closeDetail) {
    S.sel = null;
    $("detail").classList.add("hidden");
    $("detail-empty").classList.remove("hidden");
  }
  await loadList();
  refreshCounts();
  if (hitOpen && !closeDetail) select(S.sel ? S.sel.row : { Id: openId });
}

/* ---------------- detail ---------------- */
async function select(item) {
  S.sel = { row: item, tkey: item._t };
  renderList();
  $("detail-empty").classList.add("hidden");
  const d = $("detail");
  d.classList.remove("hidden");
  d.innerHTML = `<p style="color:var(--ink-3)">Loading…</p>`;
  try {
    // one call returns the lead AND its related rows (company, colleagues,
    // jobs, similar-count) — this used to be four separate link fetches
    const row = fromApi(await api(`/api/leads/${item.Id}`));
    S.sel = { row, tkey: row._t };
    renderDetail(row);
    touchLead(row);             // only once the lead really loaded
    loadComments(row);
    renderRelated(row);
  } catch (e) {
    d.innerHTML = `<p style="color:var(--ink-3)">Could not load lead (${esc(e.message)})</p>`;
  }
}

function dgItem(label, valueHtml) {
  return valueHtml
    ? `<div class="dg-item"><div class="dg-label">${label}</div><div class="dg-value">${valueHtml}</div></div>`
    : "";
}

/* the four-colour Google G, inline so the page stays self-contained */
const GOOGLE_G = `<svg class="brand-ic" viewBox="0 0 48 48" aria-hidden="true">
  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.55 10.78l7.98-6.19z"/>
  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
</svg>`;
const LINKEDIN_IN = `<svg class="brand-ic" viewBox="0 0 24 24" aria-hidden="true">
  <rect width="24" height="24" rx="3" fill="#fff"/>
  <path fill="#0a66c2" d="M4.98 3.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM3 9.5h4v11H3v-11zm6.5 0h3.8v1.5h.05c.53-.95 1.83-1.95 3.77-1.95 4.03 0 4.78 2.5 4.78 5.76v5.69h-4v-5.05c0-1.2-.02-2.75-1.75-2.75-1.75 0-2.02 1.31-2.02 2.66v5.14h-4v-11z"/>
</svg>`;

/* one-click research.
   Google: company + where it is — location is what disambiguates a generic name.
   LinkedIn: person -> name + company, all-results. Company/job -> the company
   name alone in the companies vertical; a city in the keywords loses the page. */
function lookupHtml(r, fallbackName) {
  const person = r._t === "people";
  const company = r.Company || (r._t === "companies" ? fallbackName : "");
  const gq = [company || fallbackName, locationLabel(r)].filter(Boolean).join(" ");
  const lq = person ? [fallbackName, company].filter(Boolean).join(" ") : company;
  const liUrl = person
    ? "https://www.linkedin.com/search/results/all/?keywords="
    : "https://www.linkedin.com/search/results/companies/?keywords=";

  const btns = [];
  if (gq.trim()) {
    btns.push(`
      <a class="lookup-btn lookup-google" target="_blank" rel="noopener"
         title="Google &quot;${esc(gq)}&quot;"
         href="https://www.google.com/search?q=${encodeURIComponent(gq)}"
         >${GOOGLE_G}Google</a>`);
  }
  if (lq.trim()) {
    btns.push(`
      <a class="lookup-btn lookup-li" target="_blank" rel="noopener"
         title="${person ? "Search LinkedIn for" : "Find the LinkedIn company page for"} &quot;${esc(lq)}&quot;"
         href="${liUrl}${encodeURIComponent(lq)}"
         >${LINKEDIN_IN}LinkedIn</a>`);
  }
  return btns.length ? `<div class="detail-lookup">${btns.join("")}</div>` : "";
}

function renderDetail(r) {
  const tkey = r._t;
  const name = displayName(r, tkey);
  const dateField = TABS[tkey].dateField;
  const sub = tkey === "people"
    ? [r.Title, r.Company].filter(Boolean).join(" · ")
    : tkey === "jobs"
      ? [r.Company, r.Contact ? `contact: ${r.Contact}` : null].filter(Boolean).join(" · ")
      : [r.Category, locationLabel(r)].filter(Boolean).join(" · ");
  const band = sizeBand(r.Employees);


  $("detail").innerHTML = `
    <div class="detail-top">
      ${avatarHtml(name, r.Logo, "avatar", "width:44px;height:44px;font-size:16px;")}
      <div class="detail-headings">
        <div class="detail-name" title="${esc(name)}">${esc(name)}</div>
        <div class="detail-co">${esc(sub)}</div>
        <!-- the status select lives under the title, not beside it — inline it
             steals half the header width and wraps long company names. Own
             class: the density modes hide .lead-meta everywhere -->
        <div class="detail-meta">
          <span class="status-zoho" title="Status follows the call result logged in Zoho CRM — change it in Zoho">${statusChip(r.Status)}</span>
          ${sourceChip(r.Source || (tkey === "jobs" ? "Job board" : ""))}${zohoChip(r.InZoho, r.ZohoKind)}
        </div>
      </div>
      <div class="detail-actions">
        <button class="fav-btn" id="d-fav" title="Favorite">
          <span class="fav-star${r.Favorite ? " on" : ""}" style="font-size:20px">★</span>
        </button>
      </div>
    </div>

    ${lookupHtml(r, name)}

    <div class="detail-grid">
      ${dgItem("Email", r.Email
        ? `<button class="copyable" data-copy="${esc(r.Email)}"
                   title="Click to copy · shift-click to compose">${esc(r.Email)}</button>`
        : "")}
      ${dgItem("Phone", r.Phone
        ? `<a class="dial" href="tel:${esc(r.Phone)}" data-dial="${esc(r.Phone)}"
              data-dial-id="${esc(r.Id)}"
              data-dial-name="${esc(r.Company || r.Name || "")}"
              title="Call with Zoho Voice">${esc(r.Phone)}</a>`
        : "")}
      ${dgItem("Website", r.Website ? `<a href="${esc(/^https?:/.test(r.Website) ? r.Website : "https://" + r.Website)}" target="_blank">${esc(r.Website)}</a>` : "")}
      ${dgItem("Location", esc(locationLabel(r)))}
      ${band ? dgItem("Company size", `${r.Employees.toLocaleString()} employees <span class="size-tag ${band.cls}">${band.label}</span>`) : ""}
      ${fmtMoney(r.Revenue) ? dgItem("Annual revenue", esc(fmtMoney(r.Revenue))) : ""}
      ${r.Industry ? dgItem("Industry / trade", esc(titleCase(r.Industry))) : ""}
      ${r.Certs > 0 ? dgItem("Certifications", `${r.Certs} on file`) : ""}
      ${tkey === "jobs" && r["Job URL"] ? dgItem("Job posting", `<a href="${esc(r["Job URL"])}" target="_blank">Open on LinkedIn ↗</a>`) : ""}
      ${tkey === "jobs" ? dgItem("Contact title", esc(r["Contact Title"])) : ""}
      <div class="dg-item"><div class="dg-label">Owner</div>
        <div class="dg-value"><input id="d-owner" value="${esc(r.Owner || "")}" placeholder="unassigned"></div></div>
      ${dgItem("Added", esc(fmtDate(r[dateField])))}
      ${dgItem("Source file", esc(r["Source File"]))}
    </div>

    <!-- Follow back: the reminder you set as you hang up. Its own row so the
         current state ("Follow back tomorrow 9am") has somewhere to live. -->
    <div class="detail-section fu-row">
      <button class="btn-ghost fu-btn" id="fu-btn"
              title="Email me about this lead at a time I pick">⏰ Follow back</button>
      <span id="fu-state" class="fu-state"></span>
    </div>

    <!-- Prospect research. Above the notes because it is what a rep reads
         BEFORE the call, and the notes are what they write after. -->
    <div class="detail-section">
      <div class="rs-head">
        <h4>Research</h4>
        <button class="btn-ghost rs-btn" id="research-go"
                title="Look this prospect up and write a call briefing">Research this prospect</button>
      </div>
      <div id="research-body"><p class="rs-empty">Loading…</p></div>
    </div>

    <div class="detail-section">
      <h4>Notes</h4>
      <div id="comments"><p style="color:var(--ink-3);font-size:13px">Loading notes…</p></div>
      <div class="note-box">
        <input id="note-input" placeholder="Write a note…">
        <button class="note-send" id="note-send" title="Send">➤</button>
      </div>
    </div>

    <!-- the two destructive actions live below the notes, out of reach of the
         header: DNC bans the phone number and keeps the lead; delete (admins
         only) takes it out of the app into the trash bin. -->
    <div class="detail-danger">
      <button class="remove-btn" id="d-remove"
              title="${r.Removed ? "Restore this lead and un-ban its number" : "DNC — bans the phone number from calling"}">${
                r.Removed ? "↩ Restore" : "🚫 DNC"}</button>
      ${isAdmin() ? `<button class="delete-btn" id="d-delete"
              title="Delete — moves this lead to the trash bin">🗑 Delete</button>` : ""}
    </div>

    <div class="detail-section" id="related-section"></div>`;

  $("detail").querySelectorAll("[data-copy]").forEach((el) =>
    el.addEventListener("click", (e) => {
      const value = el.dataset.copy;
      if (e.shiftKey) { location.href = `mailto:${value}`; return; }
      copyText(value, el);
    }));
  $("d-fav").addEventListener("click", () => toggleFavorite(r));
  $("d-remove").addEventListener("click", () =>
    r.Removed ? doRestore(r) : openRemoveModal(r));
  $("d-delete")?.addEventListener("click", () => openDeleteModal(r));
  $("d-owner").addEventListener("change", async (e) => {
    await patchLead(r.Id, { owner: e.target.value || null });
    r.Owner = e.target.value;
  });
  $("fu-btn").addEventListener("click", () => openFollowupModal(r));
  loadFollowup(r);
  $("research-go").addEventListener("click", () => runResearch(r));
  loadResearch(r);                       // free: shows whatever we already hold
  $("note-send").addEventListener("click", () => sendNote(r));
  $("note-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendNote(r);
  });
}

/* navigator.clipboard needs a secure context — that's fine on localhost but not
   over http://<lan-ip>, so keep the old execCommand path as a fallback */
async function copyText(value, el) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(value);
    ok = true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    } catch { ok = false; }
  }
  if (el && ok) {
    el.classList.add("copied");
    setTimeout(() => el.classList.remove("copied"), 1200);
  }
  toast(ok ? `Copied ${value}` : "Could not copy — select it manually");
}

/* toggle favorite from anywhere; keeps list, detail and counts in sync */
async function toggleFavorite(item) {
  const next = !item.Favorite;
  item.Favorite = next;
  const li = S.list.find((x) => x.Id === item.Id && x._t === item._t);
  if (li) li.Favorite = next;
  if (S.sel && S.sel.row.Id === item.Id && S.sel.tkey === item._t)
    S.sel.row.Favorite = next;
  renderList();
  // update the open detail's star in place — a re-render would drop notes/related
  const star = document.querySelector("#d-fav .fav-star");
  if (star && S.sel && S.sel.row.Id === item.Id && S.sel.tkey === item._t)
    star.classList.toggle("on", next);
  try {
    await patchLead(item.Id, { favorite: next });   // server logs + touches trail
    if (S.tab === "favorites") loadList();
    refreshCounts();
  } catch (e) {
    item.Favorite = !next;                       // put it back if the save failed
    renderList();
  }
}

/* ban a number: the server blocklists it and sweeps every lead sharing it,
   in one transaction, and logs who did it and how many leads it took down */
async function removeLead(r, reason) {
  // {affected, ids} — ids are the exact sweep, so an undo can hand them back
  return api(`/api/leads/${r.Id}/remove`, {
    method: "POST", body: JSON.stringify({ reason: reason || "" }),
  });
}

async function restoreLead(r) {
  // un-removes the row and lifts the number's ban, server-side, logged
  await api(`/api/leads/${r.Id}/restore`, { method: "POST" });
}

async function patchLead(id, fields) {
  await api(`/api/leads/${id}`, {
    method: "PATCH", body: JSON.stringify(fields),
  });
}

/* ---------------- related ----------------
   People get an initials avatar — that reads as a person. Companies and job
   postings only get one when a scrape brought the real logo: an initials
   circle beside a company name looks like a logo we don't have, so logo-less
   rows stay plain text. */
function relatedRow(name, sub, onclickIdx, avatar = true, logo = null) {
  return `
  <div class="related-row${avatar || logo ? "" : " no-avatar"}" data-rel="${onclickIdx}">
    ${avatar || logo ? avatarHtml(name, logo, "avatar avatar-sm") : ""}
    <div class="related-main">
      <div class="related-name" title="${esc(name)}">${esc(name)}</div>
      ${sub ? `<div class="related-sub">${esc(sub)}</div>` : ""}
    </div>
  </div>`;
}

/* Related rows arrive embedded on the detail response (r._related): the
   company, colleagues, open jobs, and how many similar companies share this
   one's Category × State. The only extra fetch is the similar-companies
   preview, because six teaser rows aren't worth shipping on every open. */
async function renderRelated(r) {
  const el = $("related-section");
  if (!el) return;
  const rel = r._related || {};
  const actions = [];   // parallel to data-rel indices
  let html = "";
  try {
    if (r._t === "companies") {
      if (rel.people?.length) {
        html += `<h4>People at ${esc(r.Company)}</h4>`;
        for (const p of rel.people) {
          html += relatedRow(p.name || "?", p.title || "", actions.length);
          actions.push(() => select({ Id: p.id, _t: "people" }));
        }
      }
      if (rel.jobs?.length) {
        html += `<h4 style="margin-top:14px">Open jobs</h4>`;
        for (const j of rel.jobs) {
          html += relatedRow(j.name || "?", "", actions.length, false);
          actions.push(() => select({ Id: j.id, _t: "jobs" }));
        }
      }
      if (rel.similar?.count > 0) {
        const { category, state, count } = rel.similar;
        const label = `${category} · ${fullState(state)}`;
        const preview = await api(`/api/leads?kind=company&limit=7&` +
          `category=${encodeURIComponent(category)}&state=${encodeURIComponent(state)}`);
        const others = (preview.list || []).filter((x) => x.id !== r.Id).slice(0, 6);
        if (others.length) {
          // the segment name is the way into the full list — a preview of six
          // out of a few hundred is a teaser, not an answer
          html += `<h4 style="margin-top:14px">Similar companies
            <button class="seg-tag" data-seg-cat="${esc(category)}"
              data-seg-state="${esc(state)}" data-seg-label="${esc(label)}"
              title="Browse all ${count.toLocaleString()} companies in ${esc(label)}"
              >${esc(label)}</button>
            <span class="seg-count">${count.toLocaleString()}</span></h4>`;
          for (const c of others) {
            html += relatedRow(c.name || "?",
              locationLabel({ City: c.city, State: c.state }), actions.length,
              false, c.logo_url);
            actions.push(() => select({ Id: c.id, _t: "companies" }));
          }
          html += `<button class="seg-all" data-seg-cat="${esc(category)}"
            data-seg-state="${esc(state)}" data-seg-label="${esc(label)}"
            >See all ${count.toLocaleString()} in ${esc(label)} →</button>`;
        }
      }
    } else {
      if (rel.company) {
        html += `<h4>Company</h4>`;
        html += relatedRow(rel.company.name || "?", "View company record →",
          actions.length, false, rel.company.logo_url);
        actions.push(() => select({ Id: rel.company.id, _t: "companies" }));
      }
      if (r._t === "people" && rel.people?.length) {
        html += `<h4 style="margin-top:14px">Also at ${esc(rel.company?.name || r.Company)}</h4>`;
        for (const p of rel.people) {
          html += relatedRow(p.name || "?", p.title || "", actions.length);
          actions.push(() => select({ Id: p.id, _t: "people" }));
        }
      }
    }
  } catch (e) { /* related info is best-effort */ }
  el.innerHTML = html;
  el.querySelectorAll(".related-row").forEach((row) =>
    row.addEventListener("click", () => actions[+row.dataset.rel]()));
  el.querySelectorAll("[data-seg-cat]").forEach((b) =>
    b.addEventListener("click", () =>
      openSegment(b.dataset.segCat, b.dataset.segState, b.dataset.segLabel)));
}

/* ---------------- notes (first-class now, with edit and delete) ---------- */
async function loadComments(r) {
  const el = $("comments");
  if (!el) return;
  try {
    const list = (await api(`/api/leads/${r.Id}/comments`)).list || [];
    if (!list.length) {
      el.innerHTML = `<p style="color:var(--ink-3);font-size:13px">No notes yet — be the first.</p>`;
      return;
    }
    el.innerHTML = list.map((c) => {
      const who = c.author_email || "someone";
      const mine = c.author_user_id === S.me?.id || isAdmin();
      return `
      <div class="comment" data-cid="${c.id}">
        <span class="avatar avatar-sm" style="background:${avColor(who)}">${esc(initials(who))}</span>
        <div class="comment-body">
          <div class="comment-head"><b>${esc(who)}</b> · ${esc(relTime(c.created_at))}${
            c.updated_at ? " · edited" : ""}${
            mine ? ` <button class="note-act" data-edit="${c.id}" title="Edit note">✎</button>
                    <button class="note-act" data-del="${c.id}" title="Delete note">🗑</button>` : ""}</div>
          <div class="comment-text">${esc(c.body)}</div>
        </div>
      </div>`;
    }).join("");
    el.querySelectorAll("[data-edit]").forEach((b) =>
      b.addEventListener("click", () => {
        // swap the text for an input in place — Enter saves, Escape cancels
        const row = el.querySelector(`[data-cid="${b.dataset.edit}"] .comment-text`);
        if (!row || row.querySelector("input")) return;
        const old = row.textContent;
        row.innerHTML = "";
        const input = document.createElement("input");
        input.value = old;
        input.className = "note-edit";
        row.appendChild(input);
        input.focus();
        input.addEventListener("keydown", async (e) => {
          if (e.key === "Escape") { row.textContent = old; return; }
          if (e.key !== "Enter") return;
          const next = input.value.trim();
          if (!next || next === old) { row.textContent = old; return; }
          await api(`/api/comments/${b.dataset.edit}`, {
            method: "PATCH", body: JSON.stringify({ body: next }),
          });
          loadComments(r);
        });
      }));
    el.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api(`/api/comments/${b.dataset.del}`, { method: "DELETE" });
        loadComments(r);
      }));
  } catch (e) {
    el.innerHTML = `<p style="color:var(--ink-3);font-size:13px">Notes unavailable</p>`;
  }
}

async function sendNote(r) {
  const input = $("note-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  // the server records the note action in the team log and the trail
  await api(`/api/leads/${r.Id}/comments`, {
    method: "POST", body: JSON.stringify({ body: text }),
  });
  loadComments(r);
}

/* ---------------- import leads from a spreadsheet ---------------- */
const IMPORT_CATEGORIES = ["Restoration", "Vendor", "Independent Adjuster",
  "Public Adjuster", "Insurance", "Other"];

function openImportModal() {
  $("modal-title").textContent = "Import leads";
  $("modal-body").innerHTML = `
    <p class="modal-sub">Drop an Excel or CSV export here — columns are matched
      automatically and each row lands in Companies, People or Job board.</p>
    <div class="dropzone" id="dropzone">
      <div class="dz-art">📄</div>
      <div class="dz-main">Drag a file here</div>
      <div class="dz-sub">.xlsx · .xls · .csv &nbsp;·&nbsp; or <button type="button" class="linkish" id="dz-browse">browse</button></div>
      <input type="file" id="dz-file" accept=".xlsx,.xls,.csv" hidden>
    </div>
    <label class="modal-field">Category for these leads
      <select id="import-category">
        ${IMPORT_CATEGORIES.map((c) =>
          `<option${c === "Other" ? " selected" : ""}>${c}</option>`).join("")}
      </select>
    </label>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="modal-cancel">Close</button>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  $("dz-browse").addEventListener("click", () => $("dz-file").click());
  $("dz-file").addEventListener("change", (e) => {
    if (e.target.files[0]) runImport(e.target.files[0]);
  });
  const dz = $("dropzone");
  dz.addEventListener("click", () => $("dz-file").click());
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.add("over");
  }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.remove("over");
  }));
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) runImport(f);
  });
}

async function runImport(file) {
  const category = $("import-category")?.value || "Other";
  $("modal-body").innerHTML = `
    <div class="import-busy">
      <div class="spinner"></div>
      <div><strong>${esc(file.name)}</strong></div>
      <div class="dz-sub">Parsing and matching against existing leads…<br>
        large files can take a minute — don't close this window.</div>
    </div>`;
  try {
    // one import job: the server parses off-thread, stages, dedupes with the
    // franchise guards, commits, and logs the whole thing under this account
    const res = await fetch("/api/import-jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-filename": encodeURIComponent(file.name),
        "x-category": category,
      },
      body: file,
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || `upload failed (${res.status})`);
    renderImportResult(out);
    refreshCounts();
    loadList(true);
  } catch (e) {
    $("modal-body").innerHTML = `
      <div class="import-error">
        <div class="dz-art">⚠️</div>
        <p><strong>Import failed</strong></p>
        <p class="dz-sub">${esc(e.message)}</p>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="modal-cancel">Close</button>
        <button type="button" class="btn-primary" id="import-again">Try another file</button>
      </div>`;
    $("modal-cancel").addEventListener("click", closeModal);
    $("import-again").addEventListener("click", openImportModal);
  }
}

function renderImportResult(o) {
  const c = o.counts || {};
  const ins = c.inserted || {};
  const total = (ins.company || 0) + (ins.person || 0) + (ins.job || 0);
  const line = (label, n) => n
    ? `<div class="ir-row"><span>${label}</span><strong>${n.toLocaleString()}</strong></div>` : "";
  $("modal-body").innerHTML = `
    <div class="import-done">
      <div class="dz-art">${total ? "✅" : "🤔"}</div>
      <p><strong>${total.toLocaleString()} lead${total === 1 ? "" : "s"} added</strong>
         from ${esc(o.file)}</p>
      <p class="dz-sub">${(o.rows || 0).toLocaleString()} rows read · detected as a ${esc(o.detected || "lead list")}</p>
    </div>
    <div class="import-report">
      ${line("Companies", ins.company)}
      ${line("People", ins.person)}
      ${line("Job board", ins.job)}
      ${line("Skipped — already in the base", c.duplicates)}
      ${line("Added but hidden — blocked number", c.blocked)}
    </div>
    ${o.unmapped?.length ? `<p class="dz-sub">Columns ignored: ${esc(o.unmapped.slice(0, 12).join(", "))}${o.unmapped.length > 12 ? "…" : ""}</p>` : ""}
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="import-again">Import another</button>
      <button type="button" class="btn-primary" id="modal-cancel">Done</button>
    </div>`;
  $("modal-cancel").addEventListener("click", closeModal);
  $("import-again").addEventListener("click", openImportModal);
  if (total) toast(`Imported ${total.toLocaleString()} leads from ${o.file}`);
}

/* dropping a file anywhere in the app opens the importer. Import is admin-only,
   so for a member this stays inert apart from swallowing the drop — the
   browser navigating away to a spreadsheet is nobody's idea of a feature */
function wireGlobalDrop() {
  const hasFile = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");
  window.addEventListener("dragover", (e) => {
    if (!hasFile(e)) return;
    e.preventDefault();
    if (!isAdmin()) return;
    if ($("modal-backdrop").classList.contains("hidden")) openImportModal();
    document.body.classList.add("dragging");
  });
  window.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null) document.body.classList.remove("dragging");
  });
  window.addEventListener("drop", (e) => {
    if (!hasFile(e)) return;
    e.preventDefault();                     // never let the browser open the file
    document.body.classList.remove("dragging");
    if (!isAdmin()) return;
    const f = e.dataTransfer.files[0];
    if (f && $("dropzone")) runImport(f);
  });
}

function closeModal() {
  $("modal-backdrop").classList.add("hidden");
  document.querySelector(".modal")?.classList.remove("wide", "js-panel", "team-panel", "crm-panel");
}

/* ---------------- manage team (admin) ----------------
   The UI over server/users.js. @karmastaff.com accounts appear here on their
   own after first sign-in (auto-enrolment); this screen is for promoting
   admins, disabling leavers, and pre-inviting outside emails. The server
   holds the real rules — last-admin lockout etc. — we just show its errors. */
async function openUsersModal() {
  $("modal-title").textContent = "Manage team";
  /* Wide, with the explanation folded away: the list is what this screen
     is for, and at 420px every name and email was cut off. */
  document.querySelector(".modal")?.classList.add("team-panel");
  $("modal-body").innerHTML = `
    <details class="team-help">
      <summary>What each role can do</summary>
      <p>Anyone with a company email joins as a <b>member</b> the first time they sign in — they work the
        leads assigned to them. <b>Sales reps</b> have a member's access and are who the morning call report
        is about. <b>Admins</b> run the floor: assigning, imports, job search, the call report and Team
        activity. <b>Owners</b> hold what cannot be undone — appointing admins, emptying the bin, lifting a
        do-not-call ban. ${isOwner() ? "" : "Only the owner can change admin access."}
        Adding someone emails them a sign-up link; they still create their own sign-in.</p>
    </details>
    <div id="users-list" class="users-list"><div class="modal-sub">Loading…</div></div>
    <form id="user-add-row" class="user-add-row">
      <input type="email" id="user-add-email" placeholder="invite an email outside the company…" required>
      <select id="user-add-role">
        <option value="sales_rep" selected>Sales rep</option>
        <option value="member">Member</option>
        ${isOwner() ? `<option value="admin">Admin</option>
        <option value="owner">Owner</option>` : ""}
      </select>
      <button type="submit" class="btn-secondary">Add</button>
    </form>
    <div id="users-error" class="login-error hidden"></div>
    <div class="modal-actions">
      <span id="users-pending" class="users-pending"></span>
      <button type="button" class="btn-ghost hidden" id="users-discard">Discard</button>
      <button type="button" class="btn-secondary" id="modal-cancel">Close</button>
      <button type="button" class="btn-primary" id="users-save" disabled>Save changes</button>
    </div>`;
  USR.pending = new Map();
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", () => {
    if (USR.pending.size && !confirm("You have changes that aren't saved. Close without saving them?")) return;
    USR.pending.clear();
    closeModal();
  });
  $("users-discard").addEventListener("click", () => { USR.pending.clear(); paintUsers(); });
  $("users-save").addEventListener("click", saveUsers);
  $("user-add-row").addEventListener("submit", async (e) => {
    e.preventDefault();
    const who = $("user-add-email").value.trim();
    /* Say whether they were actually told. Adding somebody only creates
       their row — if the invite email did not go, the manager has to pass
       the word on themselves, and silence here is how a new starter sits
       waiting for access nobody knows they cannot reach. */
    const out = await usersCall("/api/users", "POST",
      { email: who, role: $("user-add-role").value });
    if (out && out.invited) toast("Added " + who + " and emailed them the sign-up link");
    else if (out) toast("Added " + who + ", but the invite email did not send"
      + (out.inviteError ? " (" + out.inviteError + ")" : "")
      + " — tell them to sign up at this site with that address.", 12000);
    $("user-add-email").value = "";
  });
  await renderUsersList();
}

async function usersCall(path, method, body) {
  const err = $("users-error");
  err.classList.add("hidden");
  try {
    const out = await api(path, { method, body: JSON.stringify(body) });
    /* handed back so the caller can report what the server actually did */
    /* The route can succeed and still not have done what the click meant —
       demoting someone the environment keeps as owner, for instance. Saying
       so beats leaving them to notice the row bounce back. */
    if (out?.warning) toast(out.warning, 8000);
    await renderUsersList();
    return out;
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove("hidden");
  }
}

/* Changes on this screen are held until Save: a role picked, an account
   disabled or restored, an account marked for deletion. Each row shows what
   will change; Save applies them one by one and says how it went. */
const USR = { list: [], pending: new Map() };

async function renderUsersList() {
  USR.list = (await api("/api/users")).list;
  paintUsers();
}

const roleLabelOr = (r) => roleLabel(r || "member");

function paintUsers() {
  const list = USR.list;
  /* Who can be picked as a rep's designated manager (migration 020): admins
     and owners who are on the team and not pending deletion. */
  const managers = list.filter((x) => rankOf(x.role) >= RANK.admin
    && !x.disabled && !USR.pending.get(x.id)?.delete);
  const mgrName = (idv) => {
    if (!idv) return "no manager";
    const m = list.find((x) => x.id === idv);
    return m ? (m.display_name || m.email.split("@")[0]) : ("#" + idv);
  };
  const rows = list.map((u) => {
    const me = u.id === S.me.id;
    const p = USR.pending.get(u.id) || {};
    const role = p.role ?? u.role;
    const disabled = p.disabled ?? u.disabled;
    const isRep = rankOf(u.role) < RANK.admin;
    const mgr = ("manager_id" in p) ? p.manager_id : (u.manager_id || null);
    /* A manager may build their own team but not change its shape: they can
       grant member, and they cannot touch anyone who already outranks one.
       Locked here as well as on the route so the control reads as
       unavailable rather than failing after the click. */
    const locked = !isOwner() && (rankOf(u.role) >= RANK.admin);
    const grantable = isOwner()
      ? ["sales_rep", "member", "admin", "owner"]
      : ["sales_rep", "member"];
    const who = esc(u.display_name || u.email.split("@")[0]);
    /* Delete: not yourself, not an owner fixed by OWNER_EMAILS, and only
       someone below you — the server holds the same rules. */
    const canDelete = !me && !locked && !u.ownerByConfig;
    const changes = [
      p.role && p.role !== u.role ? `${roleLabelOr(u.role)} → ${roleLabelOr(p.role)}` : "",
      "disabled" in p && p.disabled !== u.disabled ? (p.disabled ? "will be disabled" : "will be restored") : "",
      "manager_id" in p && (p.manager_id ?? null) !== (u.manager_id ?? null)
        ? `manager → ${mgrName(p.manager_id)}` : "",
    ].filter(Boolean);
    if (p.delete) return `
    <div class="user-row user-deleting">
      <span class="avatar" style="background:${avColor(u.display_name || u.email)}">${initials(u.display_name || u.email)}</span>
      <div class="user-id">
        <div class="user-name">${who}</div>
        <div class="user-sub">${esc(u.email)} · <b>will be deleted</b> when you save</div>
      </div>
      <button type="button" class="btn-ghost user-btn user-undo" data-id="${u.id}">Undo</button>
    </div>`;
    return `
    <div class="user-row${disabled ? " user-disabled" : ""}${changes.length ? " user-changed" : ""}">
      <span class="avatar" style="background:${avColor(u.display_name || u.email)}">${initials(u.display_name || u.email)}</span>
      <div class="user-id">
        <div class="user-name">${who}${me ? " <span class='user-you'>(you)</span>" : ""}</div>
        <div class="user-sub">${changes.length ? `<b class="user-change">${esc(changes.join(" · "))}</b>`
          : esc(u.email) + (u.disabled ? " · disabled" : u.last_active ? " · active " + relTime(u.last_active) : "")}</div>
      </div>
      ${isRep ? `<select class="user-manager" data-id="${u.id}" ${disabled ? "disabled" : ""}
              title="Who covers this rep's calls — picks up when they don't">
        <option value="">— no manager —</option>
        ${(mgr && !managers.some((x) => x.id === mgr)
          ? `<option value="${mgr}" selected>${esc(u.manager_name || ("#" + mgr))}</option>` : "")}
        ${managers.map((x) => `<option value="${x.id}"${x.id === mgr ? " selected" : ""}>${esc(x.display_name || x.email.split("@")[0])}</option>`).join("")}
      </select>` : `<span class="user-manager-gap"></span>`}
      <select class="user-role" data-id="${u.id}"
              ${disabled || locked ? "disabled" : ""}
              title="${locked ? "Only the owner can change this" : "Set this person's access"}">
        ${(grantable.includes(u.role) ? grantable : [u.role, ...grantable]).map((r) =>
          `<option value="${esc(r)}"${r === role ? " selected" : ""}>${esc(roleLabel(r))}</option>`).join("")}
      </select>
      <button type="button" class="btn-ghost user-btn user-toggle" data-id="${u.id}"
              ${locked ? "disabled" : ""}>
        ${disabled ? "Restore" : "Disable"}</button>
      ${canDelete ? `<button type="button" class="user-delete" data-id="${u.id}" title="Delete ${esc(u.email)}" aria-label="Delete ${esc(u.email)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>`
        : `<span class="user-delete-gap"></span>`}
    </div>`;
  }).join("");
  $("users-list").innerHTML = rows || `<div class="modal-sub">No accounts yet.</div>`;
  const stage = (id, change) => {
    const u = USR.list.find((x) => x.id === id);
    const p = { ...(USR.pending.get(id) || {}), ...change };
    for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
    // a change back to how it was is no change
    if (p.role === u.role) delete p.role;
    if (p.disabled === u.disabled) delete p.disabled;
    if ("manager_id" in p && (p.manager_id ?? null) === (u.manager_id ?? null)) delete p.manager_id;
    if (!p.delete) delete p.delete;
    if (Object.keys(p).length) USR.pending.set(id, p); else USR.pending.delete(id);
    paintUsers();
  };
  $("users-list").querySelectorAll(".user-role").forEach((sel) =>
    sel.addEventListener("change", () => stage(+sel.dataset.id, { role: sel.value })));
  $("users-list").querySelectorAll(".user-manager").forEach((sel) =>
    sel.addEventListener("change", () => stage(+sel.dataset.id, { manager_id: sel.value ? +sel.value : null })));
  $("users-list").querySelectorAll(".user-toggle").forEach((btn) =>
    btn.addEventListener("click", () => {
      const u = USR.list.find((x) => x.id === +btn.dataset.id);
      const now = USR.pending.get(u.id)?.disabled ?? u.disabled;
      stage(u.id, { disabled: !now });
    }));
  $("users-list").querySelectorAll(".user-delete").forEach((btn) =>
    btn.addEventListener("click", () => stage(+btn.dataset.id, { delete: true, role: undefined, disabled: undefined })));
  $("users-list").querySelectorAll(".user-undo").forEach((btn) =>
    btn.addEventListener("click", () => stage(+btn.dataset.id, { delete: false })));

  const n = USR.pending.size;
  if ($("users-save")) {
    $("users-save").disabled = !n;
    $("users-save").textContent = n ? `Save changes (${n})` : "Save changes";
    $("users-discard").classList.toggle("hidden", !n);
    $("users-pending").textContent = n ? `${n} unsaved change${n === 1 ? "" : "s"}` : "";
  }
}

async function saveUsers() {
  const err = $("users-error"), btn = $("users-save");
  const todo = [...USR.pending.entries()];
  if (!todo.length) return;
  const deleting = todo.filter(([, p]) => p.delete).map(([id]) => USR.list.find((u) => u.id === id));
  if (deleting.length && !confirm(`Delete ${deleting.map((u) => u.email).join(", ")}?\n\n`
    + "They lose access and can't sign back in unless you add them again. Their leads go back to "
    + "Unassigned, their reminders are cancelled and their RingCentral and Zoho connections are removed. "
    + "Their call history and notes stay.")) return;
  err.classList.add("hidden");
  btn.disabled = true; btn.textContent = "Saving…";
  const failed = [], notes = [];
  for (const [id, p] of todo) {
    const u = USR.list.find((x) => x.id === id);
    try {
      if (p.delete) {
        const r = await api(`/api/users/${id}`, { method: "DELETE" });
        notes.push(`${u.email} deleted${r.leads ? ` · ${r.leads} lead${r.leads === 1 ? "" : "s"} back in Unassigned` : ""}`);
      } else {
        const body = {};
        if ("role" in p) body.role = p.role;
        if ("disabled" in p) body.disabled = p.disabled;
        if ("manager_id" in p) body.manager_id = p.manager_id;
        const r = await api(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(body) });
        if (r?.warning) notes.push(r.warning);
      }
      USR.pending.delete(id);
    } catch (e) { failed.push(`${u.email}: ${e.message}`); }
  }
  await renderUsersList();
  if (failed.length) {
    err.textContent = "Not saved — " + failed.join(" · ");
    err.classList.remove("hidden");
  }
  const saved = todo.length - failed.length;
  if (saved) toast(`Saved ${saved} change${saved === 1 ? "" : "s"}${notes.length ? " — " + notes.join(" · ") : ""}`, 8000);
  if (deleting.length) runCounts();
}

/* ---------------- job search (Apify) ----------------
   The 🔎 button runs a search with the saved settings (confirm step first,
   with a hard max-cost figure); the ⚙ gear edits them. Settings live in
   localStorage — they're personal defaults, not shared state. The Apify
   token never reaches the browser: everything goes through the domain API.
   Three job boards, picked in settings: LinkedIn (the fantastic-jobs actor,
   full filter set), Indeed (valig/indeed-jobs-scraper — one boolean query per
   run, run in batches, at a twentieth of LinkedIn's per-job price) and Google
   Jobs (johnvc/google-jobs-scraper — one query line across every board Google
   indexes, priced per page of ten).
   The three take different inputs, so the settings form is really three forms
   wearing one skin: `.li-only` / `.in-only` / `.go-only` rows swap on the
   picker. */
const JS_LS = "kl_jobsearch";

/* The three boards are not interchangeable — one costs more and returns company
   records, one is one-title-one-location and jobs only, one is priced by the
   page and comes back without locations — so the picker is a row of brand
   cards, not a radio triplet, and the chosen board is named on the 🔎 button
   and in the confirm step. Brand marks are drawn (the nav has no emoji anywhere
   else either). */
const JS_MARK = {
  linkedin: `<svg class="board-mark" viewBox="0 0 24 24" aria-hidden="true">
    <rect width="24" height="24" rx="4" fill="#0a66c2"/>
    <path fill="#fff" d="M6.2 4.6a1.9 1.9 0 100 3.8 1.9 1.9 0 000-3.8zM4.5 9.9h3.4v9.6H4.5V9.9zm5.4 0h3.25v1.3h.05c.45-.82 1.56-1.68 3.22-1.68 3.45 0 4.08 2.16 4.08 4.97v5.01h-3.4v-4.44c0-1.06-.02-2.42-1.5-2.42s-1.73 1.15-1.73 2.34v4.52H9.9V9.9z"/>
  </svg>`,
  indeed: `<svg class="board-mark" viewBox="0 0 24 24" aria-hidden="true">
    <rect width="24" height="24" rx="4" fill="#003a9b"/>
    <circle cx="12" cy="6.6" r="2.2" fill="#fff"/>
    <path fill="#fff" d="M9.85 10.1h4.3v7.1c0 1.5.5 1.9 1.35 1.9v2.1c-3.7.35-5.65-.85-5.65-4.1v-7z"/>
  </svg>`,
  google: `<svg class="board-mark" viewBox="0 0 24 24" aria-hidden="true">
    <rect width="24" height="24" rx="4" fill="#fff" stroke="#dadce0"/>
    <path fill="#4285f4" d="M19.1 12.18c0-.5-.05-.99-.13-1.45H12v2.74h3.98a3.4 3.4 0 01-1.48 2.23v1.85h2.39c1.4-1.29 2.21-3.19 2.21-5.37z"/>
    <path fill="#34a853" d="M12 19.5c2 0 3.68-.66 4.9-1.8l-2.4-1.85c-.66.45-1.51.71-2.5.71-1.92 0-3.55-1.3-4.13-3.04H5.4v1.9A7.4 7.4 0 0012 19.5z"/>
    <path fill="#fbbc05" d="M7.87 13.52a4.44 4.44 0 010-2.84v-1.9H5.4a7.4 7.4 0 000 6.64l2.47-1.9z"/>
    <path fill="#ea4335" d="M12 8.06c1.08 0 2.05.37 2.82 1.1l2.11-2.11A7.4 7.4 0 005.4 8.78l2.47 1.9C8.45 8.94 10.08 8.06 12 8.06z"/>
  </svg>`,
};
/* `label` is the board's real name; `short` is what fits on a card in a
   three-up row and on the sidebar button's chip */
const JS_BOARDS = [
  { key: "linkedin", label: "LinkedIn", tag: "Richest data" },
  { key: "indeed", label: "Indeed", tag: "Cheapest" },
  { key: "google", label: "Google Jobs", short: "Google", tag: "Widest net" },
];
const JS_SCRAPERS = JS_BOARDS.map((b) => [b.key, b.label]);
const JS_KEYS = JS_BOARDS.map((b) => b.key);
const JS_RATES_FALLBACK = {
  linkedin: { perResultUsd: 0.005, recruiterPerResultUsd: 0.015, startUsd: 0,
    limitMin: 10, limitMax: 500, limitDefault: 100 },
  indeed: { perResultUsd: 0.0001, startUsd: 0.001,
    limitMin: 10, limitMax: 1000, limitDefault: 250 },
  // Google is billed per page of ~10 jobs, not per job — see jsMaxCost
  google: { perResultUsd: 0.011, pagePriceUsd: 0.11, resultsPerPage: 10,
    limitMin: 10, limitMax: 500, limitDefault: 100 },
};
const JS_TIME_RANGES = [["1h", "Last hour"], ["24h", "Last 24 hours"],
  ["7d", "Last 7 days"], ["6m", "All active jobs"]];
/* Indeed's own date filter — days, as the actor's schema spells them */
const JS_DATE_POSTED = [["1", "Last 24 hours"], ["3", "Last 3 days"],
  ["7", "Last 7 days"], ["14", "Last 14 days"], ["", "Any time"]];
const JS_MAX_QUERIES = 5;            // must match MAX_QUERIES in jobsearch.js
/* the actor's country enum; anything else is rejected at the actor */
const JS_COUNTRIES = [["us", "United States"], ["ca", "Canada"],
  ["uk", "United Kingdom"], ["ie", "Ireland"], ["au", "Australia"],
  ["nz", "New Zealand"], ["ar", "Argentina"], ["at", "Austria"],
  ["bh", "Bahrain"], ["be", "Belgium"], ["br", "Brazil"], ["cl", "Chile"],
  ["cn", "China"], ["co", "Colombia"], ["cr", "Costa Rica"],
  ["cz", "Czech Republic"], ["dk", "Denmark"], ["ec", "Ecuador"],
  ["eg", "Egypt"], ["fi", "Finland"], ["fr", "France"], ["de", "Germany"],
  ["gr", "Greece"], ["hk", "Hong Kong"], ["hu", "Hungary"], ["in", "India"],
  ["id", "Indonesia"], ["il", "Israel"], ["it", "Italy"], ["jp", "Japan"],
  ["kw", "Kuwait"], ["lu", "Luxembourg"], ["my", "Malaysia"], ["mx", "Mexico"],
  ["ma", "Morocco"], ["nl", "Netherlands"], ["ng", "Nigeria"], ["no", "Norway"],
  ["om", "Oman"], ["pk", "Pakistan"], ["pa", "Panama"], ["pe", "Peru"],
  ["ph", "Philippines"], ["pl", "Poland"], ["pt", "Portugal"], ["qa", "Qatar"],
  ["ro", "Romania"], ["sa", "Saudi Arabia"], ["sg", "Singapore"],
  ["za", "South Africa"], ["kr", "South Korea"], ["es", "Spain"],
  ["se", "Sweden"], ["ch", "Switzerland"], ["tw", "Taiwan"], ["th", "Thailand"],
  ["tr", "Turkey"], ["ua", "Ukraine"], ["ae", "United Arab Emirates"],
  ["uy", "Uruguay"], ["ve", "Venezuela"], ["vn", "Vietnam"]];
const JS_ARRANGEMENTS = ["On-site", "Hybrid", "Remote OK", "Remote Solely"];
const JS_EMPLOYMENT = [["FULL_TIME", "Full-time"], ["PART_TIME", "Part-time"],
  ["CONTRACTOR", "Contract"], ["TEMPORARY", "Temporary"], ["INTERN", "Internship"]];
const JS_SENIORITY = ["Internship", "Entry level", "Associate",
  "Mid-Senior level", "Director", "Executive"];

/* Pema's standard prospecting search, prefilled so a search is one click, not
   a fill-in operation: back-office roles at small (≤200-person) restoration
   companies anywhere in the US. Clearing a field and saving still means
   "blank on purpose" — defaults only apply where nothing was ever saved. */
/* "Medical Biller" is deliberately absent: it never co-occurs with restoration
   work. The insurance-billing role a restoration company actually posts is a
   Billing Specialist, Claims Coordinator or Insurance Coordinator. */
const JS_TITLES = ["Office Administrator", "Office Admin",
  "Administrative Assistant", "Office Manager", "Estimator", "Bookkeeper",
  "Bookkeeping", "Accounting Clerk", "Accounts Receivable",
  "Billing Specialist", "Claims Coordinator", "Insurance Coordinator",
  "Digital Marketer", "Marketing Coordinator", "Sales Representative",
  "Business Development Representative", "Customer Success",
  "Customer Service Representative", "Account Manager"];

/* Indeed takes one query per run, and the query goes straight to Indeed's
   search box — so boolean works and the whole title list is three runs, not
   nineteen. Grouped by function rather than crammed into one string: one
   19-title query over-filters and risks truncation. The industry clause is
   identical in all three, because that clause is the actual ICP; the same
   posting surfacing in two runs is expected and deduped on the job URL. */
const JS_RESTORATION = '(restoration OR "water damage" OR "mold remediation"'
  + ' OR "fire damage" OR mitigation)';
const JS_QUERY_GROUPS = [
  ["Office Administrator", "Office Admin", "Administrative Assistant",
    "Office Manager"],
  ["Estimator", "Bookkeeper", "Bookkeeping", "Accounting Clerk",
    "Accounts Receivable", "Billing Specialist", "Claims Coordinator",
    "Insurance Coordinator"],
  ["Digital Marketer", "Marketing Coordinator", "Sales Representative",
    "Business Development Representative", "Customer Success",
    "Customer Service Representative", "Account Manager"],
];
const jsQuery = (titles) =>
  `(${titles.map((t) => `title:"${t}"`).join(" OR ")}) AND ${JS_RESTORATION}`;

const JS_DEFAULTS = {
  titles: JS_TITLES.join(", "),
  indeedQueries: JS_QUERY_GROUPS.map(jsQuery).join("\n"),
  locations: "United States",
  timeRange: "7d",
  datePosted: "7",
  country: "us",
  limit: 50,
  indeedLimit: 250,
  employment: ["FULL_TIME"],
  description: ["restoration", "water damage", "fire damage",
    "mold remediation", "mitigation", "Xactimate", "Symbility", "IICRC",
    "disaster recovery", "storm damage"].join(", "),
  maxEmployees: 200,
  /* The Google twin of the search above, aimed at the same result set. Google
     Jobs takes one query line — no title list, no keyword list, no company-size
     or posted-within filter — so the eighteen titles and ten keywords compress
     to the ones that carry the search: quoted phrases OR'd inside a group, the
     two groups ANDed by sitting side by side. Verified live: it returns
     restoration office managers, estimators and admin assistants, which is
     exactly what the LinkedIn defaults return. Longer lines make Google vaguer,
     and vaguer costs the same $0.11 a page. */
  googleQuery: '("Office Manager" OR "Office Administrator" OR '
    + '"Administrative Assistant" OR "Bookkeeper" OR "Estimator" OR '
    + '"Accounts Receivable") (restoration OR "water damage" OR "mold remediation")',
};

let APIFY_USAGE = null;          // {usedUsd,maxUsd,remainingUsd,cycleEndsAt,daily,rates}

const jsRates = (scraper = "linkedin") =>
  APIFY_USAGE?.scraperRates?.[scraper] || JS_RATES_FALLBACK[scraper]
    || JS_RATES_FALLBACK.linkedin;
const jsBoard = (s) =>
  (JS_SCRAPERS.find(([v]) => v === s.scraper) || JS_SCRAPERS[0])[1];
/* the name as it reads in front of the word "jobs" — "Google Jobs jobs?" is
   the sentence you get from the full label */
const jsBoardShort = (s) => {
  const b = JS_BOARDS.find((x) => x.key === s.scraper) || JS_BOARDS[0];
  return b.short || b.label;
};
/* Indeed keeps its own result cap: at a twentieth of LinkedIn's price a 50-job
   ceiling would just throw away coverage, and one number can't serve both. */
const jsLimit = (s) => (s.scraper === "indeed" ? +s.indeedLimit : +s.limit)
  || jsRates(s.scraper).limitDefault;
const jsQueries = (s) => splitLines(s.indeedQueries).slice(0, JS_MAX_QUERIES);
/* Google charges by the page of ~10 jobs however full the page comes back, so
   its ceiling counts whole pages. */
const jsPerPage = () => jsRates("google").resultsPerPage || 10;
const jsPagePrice = () => {
  const r = jsRates("google");
  return r.pagePriceUsd ?? r.perResultUsd * jsPerPage();
};
const jsPages = (limit) =>
  Math.max(1, Math.ceil((+limit || jsRates("google").limitDefault) / jsPerPage()));
/* Every board's ceiling, in its own billing unit: pages on Google, per job
   returned on LinkedIn, and per job × per metered run on Indeed — it runs one
   run per query, so both halves of that scale with the batch. */
const jsMaxCost = (s) => {
  const r = jsRates(s.scraper);
  if (s.scraper === "google") return jsPages(jsLimit(s)) * jsPagePrice();
  if (s.scraper === "indeed") {
    const n = Math.max(1, jsQueries(s).length);
    return n * (jsLimit(s) * r.perResultUsd + (r.startUsd || 0));
  }
  return jsLimit(s) * (s.recruiterOnly
    ? r.recruiterPerResultUsd : r.perResultUsd);
};
const usd = (n) => n == null ? "—"
  : "$" + (+n >= 0.1 || +n === 0 ? (+n).toFixed(2) : (+n).toFixed(3));
const clampTo = (n, r) =>
  Math.min(Math.max(+n || r.limitDefault, r.limitMin), r.limitMax);
const splitCommas = (s) => String(s || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const splitLines = (s) => String(s || "").split(/[\n;]/).map((x) => x.trim()).filter(Boolean);

function jsSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(JS_LS)) || {}; } catch (e) { /* fresh */ }
  // ?? not || — a deliberately emptied-and-saved field must stay empty
  return {
    scraper: JS_KEYS.includes(s.scraper) ? s.scraper : "linkedin",
    googleQuery: s.googleQuery ?? JS_DEFAULTS.googleQuery,
    titles: s.titles ?? JS_DEFAULTS.titles,
    indeedQueries: s.indeedQueries ?? JS_DEFAULTS.indeedQueries,
    locations: s.locations ?? JS_DEFAULTS.locations,
    timeRange: s.timeRange || JS_DEFAULTS.timeRange,
    // "" is a real choice on Indeed's date filter (any time) — ?? not ||
    datePosted: s.datePosted ?? JS_DEFAULTS.datePosted,
    country: s.country || JS_DEFAULTS.country,
    limit: +s.limit || JS_DEFAULTS.limit,
    indeedLimit: +s.indeedLimit || JS_DEFAULTS.indeedLimit,
    arrangement: s.arrangement || [],
    employment: s.employment ?? JS_DEFAULTS.employment,
    seniority: s.seniority || [], hasSalary: !!s.hasSalary,
    removeAgency: s.removeAgency !== false,        // default on
    description: s.description ?? JS_DEFAULTS.description,
    maxEmployees: s.maxEmployees === undefined
      ? JS_DEFAULTS.maxEmployees : (+s.maxEmployees || null),
    recruiterOnly: !!s.recruiterOnly,
    saved: !!s.saved,
  };
}
const saveJsSettings = (s) => localStorage.setItem(JS_LS, JSON.stringify(s));

/* the 🔎 button names the board it is armed with — the choice lives in
   localStorage, so without this nothing on screen says which one runs */
function paintBoardTag() {
  const el = $("js-board-tag");
  if (!el) return;
  const s = jsSettings();
  el.textContent = jsBoardShort(s);         // the button is narrow — short name
  el.className = "js-board-tag board-chip board-chip-" + s.scraper;
}

async function loadApifyUsage() {
  paintBoardTag();
  try { APIFY_USAGE = await api("/api/apify-usage"); }
  catch (e) { console.warn("[karma] apify usage unavailable", e.message); }
  const el = $("credits-line");
  if (el) el.textContent = APIFY_USAGE?.remainingUsd != null
    ? `Apify credits: ${usd(APIFY_USAGE.remainingUsd)} left` : "";
}

/* daily spend as inline SVG bars — no chart library in this app */
function spendSparkline(daily) {
  if (!daily?.length) return `<div class="dz-sub">No usage yet this cycle.</div>`;
  const w = 360, h = 54, gap = 2;
  const max = Math.max(...daily.map((d) => d.usd), 0.01);
  const bw = Math.max(2, (w - gap * (daily.length - 1)) / daily.length);
  const bars = daily.map((d, i) => {
    const bh = Math.max(1.5, (d.usd / max) * (h - 4));
    return `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${(h - bh).toFixed(1)}"
      width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5">
      <title>${esc(d.date)} — ${usd(d.usd)}</title></rect>`;
  }).join("");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}</svg>
    <div class="usage-caption">Daily Apify spend this billing cycle · peak ${usd(max)}</div>`;
}

function usageCard() {
  const u = APIFY_USAGE;
  if (!u) return `<div class="modal-note">Couldn't reach Apify for credit info —
    searches may still work. Check the server log.</div>`;
  const pct = u.maxUsd ? Math.min(100, (u.usedUsd / u.maxUsd) * 100) : 0;
  const resets = u.cycleEndsAt ? new Date(u.cycleEndsAt)
    .toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;
  return `<div class="usage-card">
    <div class="usage-row"><span>Apify credits</span>
      <strong>${usd(u.usedUsd)} used${u.maxUsd != null ? ` of ${usd(u.maxUsd)}` : ""}</strong></div>
    <div class="usage-bar"><div class="usage-fill${pct > 85 ? " hot" : ""}"
      style="width:${pct.toFixed(1)}%"></div></div>
    <div class="usage-row usage-sub">
      <span>${u.remainingUsd != null ? usd(u.remainingUsd) + " remaining" : ""}</span>
      <span>${resets ? "resets " + resets : ""}</span></div>
    ${spendSparkline(u.daily)}
  </div>`;
}

/* ---- settings (the ⚙ gear) */
function openJobSearchSettings() {
  const s = jsSettings();
  const check = (group, value, label, on) =>
    `<label class="check"><input type="checkbox" data-g="${group}"
       value="${esc(value)}"${on ? " checked" : ""}> ${esc(label)}</label>`;
  const advancedUsed = s.arrangement.length || s.employment.length ||
    s.seniority.length || s.hasSalary || s.description || s.recruiterOnly;
  $("modal-title").textContent = "Job search settings";
  // its own size class, not the 520px .wide: three boards and three boards'
  // worth of filters need a working surface, not a dialog
  document.querySelector(".modal").classList.add("wide", "js-panel");
  $("modal-body").innerHTML = `
    ${usageCard()}
    <form id="js-form" class="js-${s.scraper}">
      <div class="js-group-label">Job Board Settings</div>
      <div class="board-picker">${JS_BOARDS.map((b) => `
        <label class="board-card board-${b.key}${b.key === s.scraper ? " on" : ""}">
          <input type="radio" name="js-scraper" value="${b.key}"
                 ${b.key === s.scraper ? " checked" : ""}>
          <span class="board-tick" aria-hidden="true">✓</span>
          <span class="board-head">
            ${JS_MARK[b.key]}
            <span class="board-name">${b.short || b.label}</span>
          </span>
          <span class="board-price">${usd(jsRates(b.key).perResultUsd * 1000)}
            <small>per 1,000${b.key === "google" ? " · by the page" : " jobs"}</small></span>
          <span class="board-tag">${b.tag}</span>
        </label>`).join("")}</div>
      <label class="g-only">Google search query — one line, quoted phrases and OR
        <textarea id="js-query" rows="3"
          placeholder="(&quot;Office Manager&quot; OR &quot;Estimator&quot;) (restoration OR &quot;water damage&quot;)"
          >${esc(s.googleQuery)}</textarea>
        <span class="js-hint">Google takes one query, not a title list — the two
          groups above are ANDed. It has no company-size or posted-within filter.</span>
      </label>
      <label class="li-only">Job titles — comma-separated, blank = any
        <input id="js-titles" value="${esc(s.titles)}"
               placeholder="Insurance Adjuster, Claims Adjuster">
      </label>
      <label class="in-only">Searches — one per line, each its own run
        <textarea id="js-queries" rows="6" spellcheck="false"
          placeholder='(title:"Office Manager" OR title:"Estimator") AND restoration'
          >${esc(s.indeedQueries)}</textarea>
        <span class="js-hint">Indeed’s own search box: <b>AND / OR / NOT</b>,
          parentheses, and <b>title:</b> / <b>company:</b> all work. Up to
          ${JS_MAX_QUERIES} lines — each is a separate metered run, and the
          same posting found twice is only imported once.</span>
      </label>
      <label>
        <span class="li-only">Locations — one per line, written as
          “City, State, Country”</span>
        <span class="in-only">Location — blank searches the whole country</span>
        <span class="g-only">Location — blank searches the United States</span>
        <textarea id="js-locations" rows="2"
          placeholder="Miami, Florida, United States">${esc(s.locations)}</textarea>
        <span class="js-hint g-only">Only the first line is used, and Google
          targets it loosely — leave it as “United States” to search nationwide.</span>
      </label>
      <div class="js-two">
        <label class="li-only">Posted within
          <select id="js-time">${JS_TIME_RANGES.map(([v, l]) =>
            `<option value="${v}"${v === s.timeRange ? " selected" : ""}>${l}</option>`).join("")}
          </select>
        </label>
        <!-- LinkedIn and Google share this cap; Indeed keeps its own, larger
             one below because its per-job price is a twentieth of LinkedIn's -->
        <label class="no-in">Max results (${jsRates("linkedin").limitMin}–${jsRates("linkedin").limitMax})
          <input id="js-limit" type="number" min="${jsRates("linkedin").limitMin}"
                 max="${jsRates("linkedin").limitMax}" value="${s.limit}">
          <span class="js-hint g-only">Google is billed by the page of ten, so
            this rounds up to a whole page — 55 pays for 60.</span>
        </label>
        <label class="in-only">Posted within
          <select id="js-dateposted">${JS_DATE_POSTED.map(([v, l]) =>
            `<option value="${v}"${v === s.datePosted ? " selected" : ""}>${l}</option>`).join("")}
          </select>
        </label>
        <label class="in-only">Max results per search
          (${jsRates("indeed").limitMin}–${jsRates("indeed").limitMax})
          <input id="js-indeed-limit" type="number" min="${jsRates("indeed").limitMin}"
                 max="${jsRates("indeed").limitMax}" value="${s.indeedLimit}">
        </label>
      </div>
      <label class="in-only">Country
        <select id="js-country">${JS_COUNTRIES.map(([v, l]) =>
          `<option value="${v}"${v === s.country ? " selected" : ""}>${l}</option>`).join("")}
        </select>
      </label>
      <details class="js-adv li-only"${advancedUsed ? " open" : ""}>
        <summary>Advanced filters</summary>
        <div class="js-group-label">Work arrangement</div>
        <div class="check-grid">${JS_ARRANGEMENTS.map((a) =>
          check("arr", a, a, s.arrangement.includes(a))).join("")}</div>
        <div class="js-group-label">Employment type</div>
        <div class="check-grid">${JS_EMPLOYMENT.map(([v, l]) =>
          check("emp", v, l, s.employment.includes(v))).join("")}</div>
        <div class="js-group-label">Seniority</div>
        <div class="check-grid">${JS_SENIORITY.map((v) =>
          check("sen", v, v, s.seniority.includes(v))).join("")}</div>
        <div class="js-group-label">Options</div>
        <label class="check"><input type="checkbox" id="js-salary"
          ${s.hasSalary ? " checked" : ""}> Only jobs with salary data</label>
        <label class="check"><input type="checkbox" id="js-agency"
          ${s.removeAgency ? " checked" : ""}> Hide staffing agencies</label>
        <label class="check"><input type="checkbox" id="js-recruiter"
          ${s.recruiterOnly ? " checked" : ""}> Include recruiter contacts
          <span class="js-price-warn">≈${Math.round(jsRates().recruiterPerResultUsd /
            jsRates().perResultUsd)}× cost</span></label>
        <label class="modal-field">Description keywords (ignored on “All active jobs”)
          <input id="js-desc" value="${esc(s.description)}" placeholder="restoration, Xactimate">
        </label>
        <label class="modal-field">Max company size, employees — blank = any
          <input id="js-maxemp" type="number" min="1"
                 value="${s.maxEmployees ?? ""}" placeholder="200">
        </label>
      </details>
      <div class="js-estimate" id="js-estimate"></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="js-reset"
                title="Back to the standard prospecting search">Reset</button>
        <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
        <button type="button" class="btn-secondary" id="js-save">Save</button>
        <button type="submit" class="btn-primary">Save &amp; search</button>
      </div>
    </form>`;
  $("modal-backdrop").classList.remove("hidden");

  const collect = () => {
    const picked = (document.querySelector('#js-form [name="js-scraper"]:checked')
      || {}).value;
    const scraper = JS_KEYS.includes(picked) ? picked : "linkedin";
    /* #js-limit serves LinkedIn and Google (Indeed keeps its own, bigger cap).
       Google sells whole pages of ten: asking for 55 pays for 60 either way. */
    let limit = clampTo(+$("js-limit").value, jsRates("linkedin"));
    if (scraper === "google") limit = jsPages(limit) * jsPerPage();
    return {
      scraper,
      googleQuery: $("js-query").value.trim(),
      titles: $("js-titles").value.trim(),
      indeedQueries: $("js-queries").value.trim(),
      locations: $("js-locations").value.trim(),
      timeRange: $("js-time").value,
      datePosted: $("js-dateposted").value,
      country: $("js-country").value,
      limit,
      indeedLimit: clampTo(+$("js-indeed-limit").value, jsRates("indeed")),
      arrangement: [...document.querySelectorAll('#js-form [data-g="arr"]:checked')].map((i) => i.value),
      employment: [...document.querySelectorAll('#js-form [data-g="emp"]:checked')].map((i) => i.value),
      seniority: [...document.querySelectorAll('#js-form [data-g="sen"]:checked')].map((i) => i.value),
      hasSalary: $("js-salary").checked,
      removeAgency: $("js-agency").checked,
      recruiterOnly: $("js-recruiter").checked,
      description: $("js-desc").value.trim(),
      maxEmployees: +$("js-maxemp").value || null,
      saved: true,
    };
  };
  const estimate = () => {
    const c = collect();
    // the picker doubles as a mode switch: each board hides what it can't use
    $("js-form").className = "js-" + c.scraper;
    document.querySelectorAll("#js-form .board-card").forEach((el) =>
      el.classList.toggle("on", el.classList.contains("board-" + c.scraper)));
    const recruiter = c.scraper === "linkedin" && c.recruiterOnly;
    const rate = recruiter
      ? jsRates(c.scraper).recruiterPerResultUsd : jsRates(c.scraper).perResultUsd;
    const per1k = "$" + (rate * 1000).toFixed(2) + " per 1,000";
    const asked = splitLines(c.indeedQueries).length;
    const n = jsQueries(c).length;
    /* Each board's ceiling is quoted in its own unit, because a number in the
       wrong unit lies: Indeed's is per search × searches, and Google's whole
       pages are bought up front, so that figure is the price, not a cap. */
    const tail = c.scraper === "google"
      ? ` for ${jsPages(jsLimit(c))} page${jsPages(jsLimit(c)) === 1 ? "" : "s"} of
         up to ${jsLimit(c)} jobs · ${usd(jsPagePrice())} a page, full or not`
      : c.scraper === "indeed"
        ? ` for up to ${jsLimit(c)} jobs × ${n || 1} search${n === 1 ? "" : "es"}`
          + ` · ${per1k}${asked > JS_MAX_QUERIES
            ? ` <span class="js-price-warn">only the first ${JS_MAX_QUERIES} searches run</span>` : ""}`
        : ` for up to ${jsLimit(c)} jobs${recruiter
          ? ` <span class="js-price-warn">recruiter rate — ${per1k}</span>`
          : ` · ${per1k}`}`;
    $("js-estimate").innerHTML = `Maximum cost on
      <span class="board-chip board-chip-${c.scraper}">${jsBoard(c)}</span>:
      <strong>${usd(jsMaxCost(c))}</strong>${tail}`;
  };
  estimate();
  $("js-form").addEventListener("input", estimate);
  $("modal-cancel").addEventListener("click", closeModal);
  $("js-reset").addEventListener("click", () => {
    localStorage.removeItem(JS_LS);
    paintBoardTag();
    toast("Search settings reset to defaults");
    openJobSearchSettings();
  });
  $("js-save").addEventListener("click", () => {
    const c = collect();
    saveJsSettings(c);
    paintBoardTag();
    toast(`Job search settings saved — searching ${jsBoard(c)}`);
    closeModal();
  });
  $("js-form").onsubmit = (e) => {
    e.preventDefault();
    saveJsSettings(collect());
    paintBoardTag();
    openJobSearchConfirm();
  };
}

/* ---- confirm (the 🔎 button) — nothing is spent without passing this */
function openJobSearchConfirm() {
  const s = jsSettings();
  if (!s.saved) { openJobSearchSettings(); return; }
  const indeed = s.scraper === "indeed";
  const google = s.scraper === "google";
  const one = indeed || google;     // both take ONE location, not a list
  /* confirm exactly what will be sent, not the settings the board will ignore:
     Indeed runs its own N searches, Google collapses to one query line */
  const queries = jsQueries(s);
  const titles = google ? [] : splitCommas(s.titles);
  const locations = one
    ? splitLines(s.locations).slice(0, 1) : splitLines(s.locations);
  if (indeed && !queries.length) {   // the server 400s on an empty batch
    toast("Indeed needs a search — add one in settings");
    openJobSearchSettings();
    return;
  }
  if (google && !s.googleQuery) {   // …and on a blank query
    toast("Google Jobs needs a search query — add one in settings");
    openJobSearchSettings();
    return;
  }
  const keywords = splitCommas(s.description);
  const timeLabel = indeed
    ? (JS_DATE_POSTED.find(([v]) => v === s.datePosted) || [, "?"])[1]
    : (JS_TIME_RANGES.find(([v]) => v === s.timeRange) || [, "?"])[1];
  const countryLabel = (JS_COUNTRIES.find(([v]) => v === s.country) || [, "?"])[1];
  const max = jsMaxCost(s);
  // 18 default titles would swallow the popup — show a few and count the rest
  const brief = (arr, n) => arr.length > n
    ? `${arr.slice(0, n).join(", ")} +${arr.length - n} more` : arr.join(", ");
  const row = (label, val) => val
    ? `<div class="ir-row"><span>${label}</span><strong>${esc(val)}</strong></div>` : "";
  // the Google query is a line of syntax, not a value — it gets the full width
  const queryRow = (val) => val
    ? `<div class="ir-row ir-wrap"><span>${"Search query"}</span>
       <strong class="ir-code">${esc(val)}</strong></div>` : "";
  $("modal-title").textContent = `Search ${jsBoardShort(s)} jobs?`;
  $("modal-body").innerHTML = `
    <div class="board-banner board-${s.scraper}">
      ${JS_MARK[s.scraper]}
      <div>
        <div class="board-banner-name">${jsBoard(s)}</div>
        <div class="board-banner-sub">${indeed
          ? `${queries.length} boolean search${queries.length === 1 ? "" : "es"},
             jobs only — no company records`
          : google
            ? "Every board Google indexes — jobs only, and without locations"
            : "Full filters — organizations also land as company leads"}</div>
      </div>
      <div class="board-swaps">${JS_BOARDS.filter((b) => b.key !== s.scraper)
        .map((b) => `<button type="button" class="board-swap" data-board="${b.key}"
          >Use ${b.short || b.label}</button>`).join("")}</div>
    </div>
    <div class="import-report">
      ${google ? queryRow(s.googleQuery) : ""}
      ${indeed
        ? queries.map((q, i) => row(i ? "" : "Searches",
            q.length > 96 ? q.slice(0, 96) + "…" : q)).join("")
        : google ? "" : row("Job titles", brief(titles, 3) || "Any")}
      ${row(one ? "Location" : "Locations",
        (one ? locations[0] : brief(locations, 2))
        || (indeed ? countryLabel : "Anywhere"))}
      ${one ? "" : row("Company keywords", brief(keywords, 3))}
      ${google ? "" : row("Posted within", timeLabel)}
      ${!one && s.maxEmployees ? row("Company size", `≤ ${s.maxEmployees} employees`) : ""}
      ${row(indeed ? "Max results per search" : "Max results", google
        ? `${jsLimit(s)} — ${jsPages(jsLimit(s))} page${jsPages(jsLimit(s)) === 1 ? "" : "s"} of 10`
        : String(jsLimit(s)))}
      ${!one && s.recruiterOnly ? row("Recruiter contacts", "On — higher rate") : ""}
    </div>
    <p class="modal-note">${google
      ? `Costs <strong>${usd(max)}</strong> — Google sells whole pages of ten, so a
         page that comes back half full still costs ${usd(jsPagePrice())}. Postings
         arrive with no city or state: Google reports the area you searched, not
         the job's, so this app stores neither.`
      : `Costs at most <strong>${usd(max)}</strong> — you only pay for jobs actually
         returned.`}${APIFY_USAGE?.remainingUsd != null
        ? ` You have <strong>${usd(APIFY_USAGE.remainingUsd)}</strong> in Apify credits.` : ""}</p>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="js-edit">⚙ Edit</button>
      <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
      <button type="button" class="btn-primary" id="js-go">Search · up to ${usd(max)}</button>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  $("js-edit").addEventListener("click", openJobSearchSettings);
  // one click to flip boards from the confirm step — the settings are otherwise
  // identical, and a board simply ignores what it can't use
  document.querySelectorAll("#modal-body .board-swap").forEach((btn) =>
    btn.addEventListener("click", () => {
      saveJsSettings({ ...s, scraper: btn.dataset.board });
      paintBoardTag();
      openJobSearchConfirm();
    }));
  $("js-go").addEventListener("click", runJobSearch);
}

async function runJobSearch() {
  const s = jsSettings();
  $("modal-title").textContent = `Searching ${jsBoard(s)}`;
  $("modal-body").innerHTML = `
    <div class="import-busy">
      <div class="spinner"></div>
      <div><strong>Searching ${jsBoardShort(s)} jobs…</strong></div>
      <div class="dz-sub">${s.scraper === "indeed"
        ? `Running ${jsQueries(s).length} searches at once — usually under
           two minutes.` : "Usually 10–60 seconds."}
        New jobs land in the Job board tab.</div>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  try {
    const out = await api("/api/job-search", {
      method: "POST",
      body: JSON.stringify({
        scraper: s.scraper,
        query: s.googleQuery,          // Google only; the others ignore it
        titleSearch: splitCommas(s.titles),
        indeedQueries: jsQueries(s),
        locationSearch: splitLines(s.locations),
        timeRange: s.timeRange,
        datePosted: s.datePosted,
        country: s.country,
        limit: jsLimit(s),
        aiWorkArrangementFilter: s.arrangement,
        aiEmploymentTypeFilter: s.employment,
        seniorityFilter: s.seniority,
        hasSalary: s.hasSalary,
        removeAgency: s.removeAgency,
        descriptionSearch: splitCommas(s.description),
        organizationEmployeesLte: s.maxEmployees || undefined,
        recruiterOnly: s.recruiterOnly,
      }),
    });
    renderJobSearchResult(out);
    loadApifyUsage();                       // refresh the credits line + graph data
    setTimeout(loadApifyUsage, 15000);      // …again once Apify's stats catch up
    refreshCounts();
    if (out.inserted && S.tab === "jobs") loadList(true);
  } catch (e) {
    const msg = (String(e.message).match(/"error"\s*:\s*"([^"]+)/) || [])[1] || e.message;
    $("modal-body").innerHTML = `
      <div class="import-error">
        <div class="dz-art">⚠️</div>
        <p><strong>Search failed</strong></p>
        <p class="dz-sub">${esc(msg)}</p>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="modal-cancel">Close</button>
        <button type="button" class="btn-primary" id="js-retry">Try again</button>
      </div>`;
    $("modal-cancel").addEventListener("click", closeModal);
    $("js-retry").addEventListener("click", openJobSearchConfirm);
  }
}

function renderJobSearchResult(o) {
  const line = (label, n) => n
    ? `<div class="ir-row"><span>${label}</span><strong>${(+n).toLocaleString()}</strong></div>` : "";
  const cost = o.cost?.usd != null ? usd(o.cost.usd) : "unavailable";
  $("modal-title").textContent = "Job search complete";
  $("modal-body").innerHTML = `
    <div class="import-done">
      <div class="dz-art">${o.inserted ? "✅" : "🤔"}</div>
      <p><strong>${o.inserted.toLocaleString()} new job${o.inserted === 1 ? "" : "s"} added</strong>
        to the Job board</p>
      <p class="dz-sub">${o.found.toLocaleString()} matched the search</p>
    </div>
    <div class="import-report">
      ${line("Jobs found", o.found)}
      ${line("Added to Job board", o.inserted)}
      ${line("Skipped — already in the base", o.duplicates)}
      ${line("New companies added", o.companies?.inserted)}
      ${line("Companies enriched (logo, website…)", o.companies?.updated)}
      ${line("Phone numbers matched from our data", o.companies?.phonesFilled)}
      ${o.queriesFailed
        ? `<div class="ir-row"><span>Searches that failed</span>
             <strong class="js-price-warn">${o.queriesFailed}</strong></div>` : ""}
      <div class="ir-row"><span>Actual cost charged</span><strong>${cost}</strong></div>
    </div>
    ${o.scraper === "google" && o.inserted
      ? `<p class="modal-note">Google postings land without a city or state —
         Google reports the area searched, not the job's.</p>` : ""}
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="js-again">Search again</button>
      <button type="button" class="btn-primary" id="modal-cancel">Done</button>
    </div>`;
  $("modal-cancel").addEventListener("click", closeModal);
  $("js-again").addEventListener("click", openJobSearchConfirm);
  if (o.inserted) toast(`${o.inserted.toLocaleString()} jobs added · cost ${cost}`);
}

/* ---------------- remove / ban ---------------- */
async function openRemoveModal(r) {
  const name = displayName(r, r._t);
  const key = r["Phone Key"];
  const phone = r.Phone;
  // count the blast radius before asking — shared/toll-free numbers hit many leads
  let n = 1;
  if (key) {
    try { n = (await api(`/api/leads/${r.Id}/remove-preview`)).affected || 1; }
    catch { /* preview is best-effort; the modal still warns generically */ }
  }
  $("modal-title").textContent = "Remove lead";
  $("modal-body").innerHTML = `<form id="remove-form">
    <p class="modal-note">
      ${key
        ? `This bans <b>${esc(phone)}</b> and removes
           <b>${n} lead${n === 1 ? "" : "s"}</b> sharing that number, across
           Companies, People and Job board. Future imports of that number stay
           out too.${n > 3 ? ` <b>Note:</b> that number is on ${n} records — check
           it isn't a shared switchboard before banning.` : ""}`
        : `<b>${esc(name)}</b> has no usable phone number on file, so only this
           one record is removed — nothing is added to the blocklist.`}
    </p>
    <label>Reason (optional)
      <input name="reason" placeholder="e.g. asked not to be contacted">
    </label>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
      <button type="submit" class="btn-danger">Remove${key ? " & ban number" : ""}</button>
    </div>
  </form>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  $("remove-form").onsubmit = async (e) => {
    e.preventDefault();
    const reason = new FormData(e.target).get("reason");
    const btn = e.target.querySelector(".btn-danger");
    btn.disabled = true; btn.textContent = "Removing…";
    try {
      const out = await removeLead(r, reason);
      closeModal();
      const msg = `Removed ${out.affected} lead${out.affected === 1 ? "" : "s"}${key ? ` · ${phone} banned` : ""}`;
      // a member has no DNC tab to dig a slip out of — give them 5s to undo
      if (isAdmin()) toast(msg);
      else showUndo(msg, r.Id, out.ids);
      S.sel = null;
      $("detail").classList.add("hidden");
      $("detail-empty").classList.remove("hidden");
      loadList(); refreshCounts();
    } catch (ex) {
      btn.disabled = false; btn.textContent = "Remove";
      toast("Could not remove: " + ex.message);
    }
  };
}

async function doRestore(r) {
  await restoreLead(r);
  toast("Lead restored" + (r["Phone Key"] ? " and number un-banned" : ""));
  S.sel = null;
  $("detail").classList.add("hidden");
  $("detail-empty").classList.remove("hidden");
  loadList(); refreshCounts();
}

/* ---------------- delete / trash bin (admin) ----------------
   Delete is not the DNC ban. Remove blocklists a phone number and keeps the
   lead under Manage → DNC; delete takes the lead out of the app and parks it
   in the bin, where it is destroyed for good after 30 days (or the moment the
   admin empties it). Deleting a company takes its job postings with it — a
   posting with no employer is noise — but deleting a job never touches the
   company the scrape built. The bin lives in the user menu, not the sidebar:
   it is a recovery hatch, not a view anyone works from. */
const TRASH_DAYS = 30;

async function openDeleteModal(r) {
  const name = displayName(r, r._t);
  let pv = { jobs: 0, purgeAfterDays: TRASH_DAYS };
  try { pv = await api(`/api/leads/${r.Id}/delete-preview`); }
  catch { /* best effort — the modal still states the rule */ }
  const jobs = pv.jobs || 0;
  $("modal-title").textContent = "Delete lead";
  $("modal-body").innerHTML = `
    <p class="modal-note">
      <b>${esc(name)}</b> goes to the trash bin${jobs
        ? `, and so do its <b>${jobs} job posting${jobs === 1 ? "" : "s"}</b>`
        : ""}. It disappears from every list, count and search straight away.
    </p>
    <div class="import-report">
      <div class="ir-row"><span>Recoverable from</span>
        <strong>Trash — in the user menu</strong></div>
      <div class="ir-row"><span>Destroyed for good</span>
        <strong>${pv.purgeAfterDays || TRASH_DAYS} days after deletion</strong></div>
      <div class="ir-row"><span>Phone number</span>
        <strong>Not banned — that's 🚫 Remove</strong></div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
      <button type="button" class="btn-danger" id="delete-go">Delete${
        jobs ? ` ${jobs + 1} leads` : ""}</button>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  $("delete-go").addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true; btn.textContent = "Deleting…";
    try {
      const out = await api(`/api/leads/${r.Id}`, { method: "DELETE" });
      closeModal();
      toast(`Moved ${out.affected} lead${out.affected === 1 ? "" : "s"} to the trash`);
      S.sel = null;
      $("detail").classList.add("hidden");
      $("detail-empty").classList.remove("hidden");
      loadList(); refreshCounts();
    } catch (ex) {
      btn.disabled = false; btn.textContent = "Delete";
      toast("Could not delete: " + ex.message);
    }
  });
}

async function openTrashModal() {
  $("modal-title").textContent = "Trash";
  document.querySelector(".modal").classList.add("wide");
  $("modal-body").innerHTML = `
    <p class="modal-sub">Deleted leads wait here for <b>${TRASH_DAYS} days</b>,
      then they are destroyed for good — the lead and its notes with it.
      Restoring puts a lead back exactly where it was.</p>
    <div id="trash-list" class="trash-list"><div class="modal-sub">Loading…</div></div>
    <div id="trash-error" class="login-error hidden"></div>
    <div class="modal-actions">
      ${isOwner()
        ? `<button type="button" class="btn-danger" id="trash-empty">Empty trash now</button>`
        : `<span class="modal-sub">Only the owner can empty the bin — restoring
             is the part a manager can undo.</span>`}
      <button type="button" class="btn-secondary" id="modal-cancel">Close</button>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  // two clicks, not a second modal: the first arms it, the second destroys
  $("trash-empty")?.addEventListener("click", async (e) => {
    const btn = e.target;
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.textContent = "Click again to destroy everything";
      setTimeout(() => {
        if (!btn.isConnected || btn.dataset.armed !== "1") return;
        btn.dataset.armed = "";
        btn.textContent = "Empty trash now";
      }, 5000);
      return;
    }
    btn.disabled = true; btn.textContent = "Emptying…";
    try {
      const out = await api("/api/trash", { method: "DELETE" });
      toast(`Destroyed ${out.destroyed} lead${out.destroyed === 1 ? "" : "s"}`);
      closeModal();
      refreshCounts();
    } catch (ex) {
      btn.disabled = false; btn.dataset.armed = "";
      btn.textContent = "Empty trash now";
      trashError(ex.message);
    }
  });
  await renderTrashList();
}

function trashError(msg) {
  const err = $("trash-error");
  if (!err) return;
  err.textContent = msg;
  err.classList.remove("hidden");
}

const KIND_LABEL = { company: "Company", person: "Person", job: "Job" };

async function renderTrashList() {
  const el = $("trash-list");
  if (!el) return;
  let d;
  try { d = await api("/api/trash"); }
  catch (ex) { el.innerHTML = ""; trashError(ex.message); return; }
  const days = d.purgeAfterDays || TRASH_DAYS;
  const rows = d.list.map((t) => {
    const left = Math.max(0, Math.ceil(
      (new Date(t.deleted_at).getTime() + days * 864e5 - Date.now()) / 864e5));
    const sub = [t.company && t.company !== t.name ? t.company : null,
      [t.city, t.state].filter(Boolean).join(", ") || null,
      t.deleted_by ? `deleted by ${t.deleted_by}` : null,
      relTime(t.deleted_at)].filter(Boolean).join(" · ");
    return `
    <div class="trash-row">
      <span class="trash-kind tk-${t.kind}">${KIND_LABEL[t.kind] || t.kind}</span>
      <div class="user-id">
        <div class="user-name">${esc(t.name || "(no name)")}</div>
        <div class="user-sub">${esc(sub)}</div>
      </div>
      <span class="trash-left${left <= 3 ? " soon" : ""}">${left === 0
        ? "purges today" : `${left}d left`}</span>
      <button type="button" class="btn-ghost trash-restore" data-id="${t.id}">↩ Restore</button>
    </div>`;
  }).join("");
  el.innerHTML = rows || `<div class="modal-sub">The trash is empty.</div>`;
  if (d.total > d.shown)
    el.insertAdjacentHTML("beforeend",
      `<div class="modal-sub">Showing the newest ${d.shown} of
        ${d.total.toLocaleString()} deleted leads.</div>`);
  const btn = $("trash-empty");
  if (btn) {
    btn.disabled = !d.total;
    btn.textContent = d.total
      ? `Empty trash now (${d.total.toLocaleString()})` : "Trash is empty";
  }
  el.querySelectorAll(".trash-restore").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true; b.textContent = "…";
      try {
        const out = await api(`/api/trash/${b.dataset.id}/restore`, { method: "POST" });
        toast(`Restored ${out.affected} lead${out.affected === 1 ? "" : "s"}`);
        await renderTrashList();
        loadList(); refreshCounts();
      } catch (ex) {
        b.disabled = false; b.textContent = "↩ Restore";
        trashError(ex.message);
      }
    }));
}

/* ---------------- bulk action modals (admin) ----------------
   Three modals over server/bulk.js, one per action in the filter row. They
   deliberately mirror their single-lead twins above: the same words, the same
   blast-radius line before the same destructive click. The only new idea is
   the owner search — assigning is a pick from a list (the team, plus the
   owners already on leads), never a free-text box, because leads.owner is
   matched on equality and "Maria", "maria" and "maria@karmastaff.com" are
   three different work queues. */

const pickedIds = () => [...S.picked.keys()];

/* name the first few: a destructive confirm should be about leads someone
   recognises, not about a number */
function pickedNames(max = 3) {
  const names = [...S.picked.values()].map((p) => p.name);
  const head = names.slice(0, max).join(", ");
  return names.length > max
    ? `${head} and ${(names.length - max).toLocaleString()} more` : head;
}

function bulkError(msg) {
  const err = $("bulk-error");
  if (!err) return;
  err.textContent = msg;
  err.classList.remove("hidden");
}

/* one call answers both destructive modals; a failed preview must not block
   the action, so it falls back to what we already know */
async function bulkPreview(ids) {
  try {
    return await api("/api/bulk/preview",
      { method: "POST", body: JSON.stringify({ ids }) });
  } catch {
    return { leads: ids.length, dnc: ids.length, jobs: 0 };
  }
}

const leadsWord = (n) => `${n.toLocaleString()} lead${n === 1 ? "" : "s"}`;

async function openAssignModal() {
  const ids = pickedIds();
  if (!ids.length) return;
  let chosen = null;                     // an /api/owners row, or {clear:true}
  $("modal-title").textContent = `Assign ${leadsWord(ids.length)}`;
  $("modal-body").innerHTML = `
    <p class="modal-sub">Search the team and the owners already on leads —
      picking an existing name keeps one person from becoming three owner
      filters.<br>Selected: ${esc(pickedNames())}</p>
    <input id="owner-q" class="owner-q" type="search" autocomplete="off"
           placeholder="Search a name or email…">
    <div id="owner-results" class="owner-results">
      <div class="modal-sub">Loading…</div></div>
    <div id="bulk-error" class="login-error hidden"></div>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
      <button type="button" class="btn-primary" id="assign-go" disabled>Assign</button>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  const go = $("assign-go");

  const paintChoice = () => {
    go.disabled = !chosen;
    go.textContent = !chosen ? "Assign"
      : chosen.clear ? `Unassign ${leadsWord(ids.length)}`
        : `Assign to ${chosen.label}`;
  };
  const mark = (btn) => {
    $("owner-results").querySelectorAll(".owner-row")
      .forEach((x) => x.classList.toggle("on", x === btn));
    paintChoice();
  };
  const render = (list) => {
    const el = $("owner-results");
    el.innerHTML = list.map((o, i) => {
      /* the value is always shown when it isn't the label: it is the string
         that lands in the owner column and drives the owner filter */
      const sub = [o.label === o.value ? null : o.value,
        o.team ? "team member" : "already on leads",
        o.leads ? `${leadsWord(o.leads)} owned` : null].filter(Boolean).join(" · ");
      return `
      <button type="button" class="owner-row" data-o="${i}">
        ${avatarHtml(o.label, null, "avatar avatar-sm")}
        <span class="owner-id">
          <span class="owner-name">${esc(o.label)}</span>
          <span class="owner-sub">${esc(sub)}</span>
        </span>
      </button>`;
    }).join("") || `<div class="modal-sub">Nobody matches. Teammates appear
      here once they have signed in at least once.</div>`;
    // unassigning is a real answer to "who owns these", so it is a row too
    el.insertAdjacentHTML("beforeend", `
      <button type="button" class="owner-row" data-clear="1">
        <span class="avatar avatar-sm owner-none">–</span>
        <span class="owner-id">
          <span class="owner-name">Leave unassigned</span>
          <span class="owner-sub">clears the owner on the selected leads</span>
        </span>
      </button>`);
    el.querySelectorAll("[data-o]").forEach((b) =>
      b.addEventListener("click", () => { chosen = list[+b.dataset.o]; mark(b); }));
    el.querySelectorAll("[data-clear]").forEach((b) =>
      b.addEventListener("click", () => { chosen = { clear: true }; mark(b); }));
  };
  const search = async (q) => {
    try { render((await api(`/api/owners?q=${encodeURIComponent(q)}`)).list || []); }
    catch (ex) { $("owner-results").innerHTML = ""; bulkError(ex.message); }
  };

  let debounce;
  $("owner-q").addEventListener("input", (e) => {
    chosen = null;
    paintChoice();
    clearTimeout(debounce);
    const q = e.target.value.trim();
    debounce = setTimeout(() => search(q), 200);
  });
  go.addEventListener("click", async () => {
    if (!chosen) return;
    go.disabled = true;
    go.textContent = "Saving…";
    try {
      const out = await api("/api/bulk/assign", {
        method: "POST",
        body: JSON.stringify({ ids, owner: chosen.clear ? "" : chosen.value }),
      });
      const zoho = out.skippedInZoho
        ? ` · ${leadsWord(out.skippedInZoho)} skipped (registered in Zoho)` : "";
      toast((out.affected
        ? `${leadsWord(out.affected)} ${chosen.clear
          ? "unassigned" : `assigned to ${chosen.label}`}`
        : (out.skippedInZoho ? "None assigned" : "Nothing to change — they already had that owner")) + zoho,
        out.skippedInZoho ? 6000 : undefined);
      await afterBulk(ids);
    } catch (ex) {
      paintChoice();
      bulkError(ex.message);
    }
  });
  await search("");
  $("owner-q").focus();
}

async function openBulkDncModal() {
  const ids = pickedIds();
  if (!ids.length) return;
  const pv = await bulkPreview(ids);
  const extra = Math.max(0, pv.dnc - pv.leads);
  $("modal-title").textContent = `DNC ${leadsWord(ids.length)}`;
  $("modal-body").innerHTML = `
    <p class="modal-note">
      This bans the phone numbers on the selected leads and removes
      <b>${leadsWord(pv.dnc)}</b>${extra
        ? ` — the ${pv.leads} selected plus <b>${leadsWord(extra)}</b> sharing
            those numbers, across Companies, People and Job board`
        : ""}. Future imports of those numbers stay out too.
      ${extra > pv.leads ? `<br><b>Note:</b> that is far more than you picked —
        check none of these are shared switchboards.` : ""}
    </p>
    <p class="modal-sub">Selected: ${esc(pickedNames())}</p>
    <label>Reason (optional)
      <input id="dnc-reason" placeholder="e.g. asked not to be contacted">
    </label>
    <div id="bulk-error" class="login-error hidden"></div>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
      <button type="button" class="btn-danger" id="dnc-go">Remove &amp; ban</button>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  $("dnc-go").addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "Removing…";
    try {
      const out = await api("/api/bulk/dnc", {
        method: "POST",
        body: JSON.stringify({ ids, reason: $("dnc-reason").value }),
      });
      toast(`Removed ${leadsWord(out.affected)}` +
        (out.numbers ? ` · ${out.numbers} number${out.numbers === 1 ? "" : "s"} banned` : ""));
      await afterBulk(ids, { closeDetail: true });
    } catch (ex) {
      btn.disabled = false;
      btn.textContent = "Remove & ban";
      bulkError(ex.message);
    }
  });
}

async function openBulkDeleteModal() {
  const ids = pickedIds();
  if (!ids.length) return;
  const pv = await bulkPreview(ids);
  const total = pv.leads + (pv.jobs || 0);
  $("modal-title").textContent = `Delete ${leadsWord(ids.length)}`;
  $("modal-body").innerHTML = `
    <p class="modal-note">
      <b>${leadsWord(pv.leads)}</b> go to the trash bin${pv.jobs
        ? `, and so do <b>${pv.jobs} job posting${pv.jobs === 1 ? "" : "s"}</b>
           belonging to the companies you picked` : ""}. They disappear from
      every list, count and search straight away.
    </p>
    <p class="modal-sub">Selected: ${esc(pickedNames())}</p>
    <div class="import-report">
      <div class="ir-row"><span>Recoverable from</span>
        <strong>Trash — in the user menu</strong></div>
      <div class="ir-row"><span>Destroyed for good</span>
        <strong>${TRASH_DAYS} days after deletion</strong></div>
      <div class="ir-row"><span>Phone numbers</span>
        <strong>Not banned — that's DNC</strong></div>
    </div>
    <div id="bulk-error" class="login-error hidden"></div>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
      <button type="button" class="btn-danger" id="bulk-delete-go">Delete ${
        leadsWord(total)}</button>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  $("bulk-delete-go").addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "Deleting…";
    try {
      const out = await api("/api/bulk/delete", {
        method: "POST", body: JSON.stringify({ ids }),
      });
      toast(`Moved ${leadsWord(out.affected)} to the trash`);
      await afterBulk(ids, { closeDetail: true });
    } catch (ex) {
      btn.disabled = false;
      btn.textContent = `Delete ${leadsWord(total)}`;
      bulkError(ex.message);
    }
  });
}

/* ---------------- Team activity (admin) ----------------
   Reads /api/activity — the append-only log the API writes on every mutation.
   The default view counts status changes only — the number the manager
   actually watches; opens, notes and favorites drowned it out. The Logs
   button flips the same two blocks (daily bars split per person, live feed
   with click-through to the lead) to the unfiltered log. The log starts
   at the migration cutover, and the empty state says so plainly rather than
   showing a convincing-looking flat chart. */
const ACT_SLOTS = 8;                     // --cat-1..8, validated in both themes
let actFull = false;                     // false = status changes, true = Logs

/* the Team activity pane's ☎ button: both phone-backfill layers over every
   phone-less job company in one click (POST /api/phone-refresh). The web pass
   is capped per click server-side so the request stays bounded — for a big
   backlog the result modal offers to keep going. */
async function runPhoneRefresh() {
  const btn = $("act-phones");
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = "Filling…";
  try {
    const o = await api("/api/phone-refresh", { method: "POST" });
    const line = (label, n) => n
      ? `<div class="ir-row"><span>${label}</span><strong>${(+n).toLocaleString()}</strong></div>` : "";
    $("modal-title").textContent = "Phone refresh";
    $("modal-body").innerHTML = `
      <div class="import-done">
        <div class="dz-art">${o.filled ? "📞" : "🤷"}</div>
        <p><strong>${o.filled.toLocaleString()} number${o.filled === 1 ? "" : "s"} filled</strong></p>
        <p class="dz-sub">${o.scanned.toLocaleString()} job compan${
          o.scanned === 1 ? "y" : "ies"} had none</p>
      </div>
      <div class="import-report">
        ${line("Matched from our own data", o.matched.domain + o.matched.namecity)}
        ${line("Read off their websites", o.web)}
        ${line("Sites that listed no number", o.miss.nophone + o.miss.ambiguous)}
        ${line("Sites dead or behind bot protection", o.miss.unreachable + o.miss.blocked)}
        ${line("Numbers on the DNC list, skipped", o.banned)}
        ${line("No website to read", o.noSite)}
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="modal-cancel">Close</button>
        ${o.webRemaining ? `<button type="button" class="btn-primary" id="pr-again">
          Keep going — ${o.webRemaining.toLocaleString()} site${
            o.webRemaining === 1 ? "" : "s"} left</button>` : ""}
      </div>`;
    $("modal-backdrop").classList.remove("hidden");
    $("modal-cancel").addEventListener("click", closeModal);
    $("pr-again")?.addEventListener("click", () => { closeModal(); runPhoneRefresh(); });
    refreshCounts();               // filled phones move the tiles
    loadStats();                   // …and the run just logged itself
  } catch (e) {
    toast(`Phone refresh failed — ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
}

/* ---------------- click-to-call (Zoho Voice) ----------------

   The number stays a real tel: link in the markup. If the softphone is
   configured AND loads AND registers, a click is intercepted and dialled
   in-page; in every other case the browser follows the link and the desk
   phone or Zoho's desktop app answers it, exactly as before. That ordering is
   deliberate: a telephony integration that is down must not cost somebody the
   ability to ring a lead.

   The SDK is fetched only when the server says the feature is on, so a team
   without Zoho pays nothing for it. */

const VOICE = { mode: "tel", dialUrl: "", countryCode: "+1", sdk: null, ready: false,
  loading: null,
  /* The call in progress. leadId is captured at the click, because by the time
     the SDK says the call ended the reading pane may be showing something
     else — attributing a call to whatever lead happens to be open would put
     it against the wrong company. */
  call: { leadId: null, number: null, connected: false, seconds: 0, reported: true } };

const CALL_OUTCOMES = ["connected", "no-answer", "busy", "failed", "cancelled", "placed"];

/* Tell the server how a call went. Fire-and-forget: a failure to record must
   never surface to someone who has just finished talking to a prospect, and
   the call itself already happened either way. Guarded against the SDK
   emitting several end-ish states for one call. */
function reportCall(raw, state) {
  const c = VOICE.call;
  /* A call with no lead (a number typed on the keypad, an unknown caller) is
     logged too, against the number: Zoho CRM is sent every logged call, and
     an unlogged one simply never reached it. */
  if (c.reported || (!c.leadId && !c.number)) return;
  c.reported = true;
  /* An exact outcome name is a caller telling us what happened; anything else
     is a raw SDK state string to be read. Kept in step with OUTCOMES in
     leads/server/calls.js, which rejects what it does not recognise. */
  const outcome = CALL_OUTCOMES.includes(state) ? state
    : c.connected ? "connected"
      : /busy/.test(state) ? "busy"
        : /cancel|reject|decline/.test(state) ? "cancelled"
          : /fail|error/.test(state) ? "failed"
            : "no-answer";
  /* A session is watching for exactly this. The softphone is the only
     thing that knows the call ended and whether anyone answered, so the
     hang-up is what should move a hands-free session on — not a button
     press after the fact. */
  if (c.leadId && typeof campaignCallEnded === "function") campaignCallEnded(c.leadId, outcome);
  /* A lead id greater than zero is a real lead, logged against it. A NEGATIVE
     id is an uploaded campaign row (campaign-upload.js) — a call list kept apart
     from the lead base — so its call is logged against the number like any
     lead-less call; the session still advances via campaignCallEnded above. */
  const realLead = c.leadId > 0;
  return c.logged = fetch(realLead ? "/api/leads/" + c.leadId + "/call" : "/api/calls/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      outcome,
      seconds: c.connected ? c.seconds : 0,
      provider: VOICE.provider || "zoho",
      direction: c.direction || undefined,
      callback_ext: c.callbackExt || undefined,
      campaign: c.campaign || undefined,
      call_id: raw?.callId || raw?.call_id || null,
      number: c.number,
    }),
  }).catch((e) => console.warn("[karma] could not record the call:", e.message));
}

/* The softphone authenticates locally and fails on the deploy, and the SDK
   reports every cause as "Unauthorized access" — a blocked request and a
   refused credential look identical from inside it. The browser does know the
   difference: it fires securitypolicyviolation naming the exact address it
   refused. Catch that and put it on screen, so the blocked host can be read off
   the page instead of hunted for in devtools. Only violations involving the
   phone system are shown; anything else is left to the console. */
/* Turn whatever the SDK threw into something readable. It may be an Error, a
   plain object, or a nested structure; JSON.stringify covers the common cases
   and the key list covers the ones it cannot serialise. */
function describeErr(err) {
  if (err == null) return "(no detail)";
  if (typeof err === "string") return err;
  /* A plain message on its own is the normal case and reads as a sentence —
     label it and the call report shows "message=Connect your RingCentral
     account first" to an owner who just wanted to know what went wrong. The
     key=value form stays for the objects that carry several fields, where
     the labels are the only thing making them legible. */
  const parts = [];
  for (const k of ["code", "status", "message", "description", "reason", "error", "type"]) {
    if (err[k] !== undefined && typeof err[k] !== "object") parts.push(k + "=" + err[k]);
  }
  if (parts.length === 1 && parts[0].startsWith("message=")) return parts[0].slice(8);
  if (parts.length) return parts.join(" ");
  try {
    const s = JSON.stringify(err);
    if (s && s !== "{}") return s.slice(0, 300);
  } catch (e) { /* circular — fall through */ }
  const keys = Object.keys(err || {});
  return keys.length ? "fields: " + keys.join(",") : String(err);
}

function watchVoiceBlocks() {
  document.addEventListener("securitypolicyviolation", (e) => {
    const uri = e.blockedURI || "(inline)";
    console.warn("[karma] CSP blocked", e.violatedDirective, uri);
    if (!/zoho/i.test(uri)) return;
    toast("Blocked by security policy: " + e.violatedDirective + " -> " + uri, 12000);
  });
}

/* The in-page softphone could not authenticate. Fall back to handing numbers
   to Zoho's own dialler, which needs no agent seat and works today.

   Deliberately quiet. While this was being set up, a 20-second diagnostic
   toast was the fastest way to see Zoho's own words for a failure; in front
   of a rep it is a wall of text about OAuth they can do nothing about, on
   every page load. The reason still goes to the console for whoever is
   debugging, and the numbers still dial. */
let softphoneWarned = false;
function softphoneUnavailable(reason) {
  VOICE.ready = false;
  /* NOT "web". The softphone failing to authenticate and Zoho Voice's web
     version refusing entry are the same licence: a Zoho Telephony agent
     gets "Access Denied" on voice.zoho.com, so opening it would swap one
     dead end for another with an extra tab. Copy the number instead — it
     is what a rep can actually act on, from a desk phone or Zoho's mobile
     app, which is what Zoho itself tells them to use. */
  VOICE.mode = "copy";
  if (softphoneWarned) return;
  softphoneWarned = true;
  console.warn("[karma] in-page softphone unavailable (" + reason
    + ") — copying numbers instead");
  /* Said once, plainly, because the alternative is a rep clicking a number
     and appearing to get nothing back. Zoho's own wording is the giveaway:
     a Telephony agent has no Voice web access and only an admin can change
     that, so the message points at what still works rather than at a
     setting no rep can reach. */
  if (!VOICE.saidUnavailable) {
    VOICE.saidUnavailable = true;
    toast("The in-page phone is not available on this Zoho account — numbers "
      + "are copied for you to dial on your phone or the Zoho app. "
      + "Ask your admin about a Zoho Voice licence.", 12000);
  }
}

/* The Zoho softphone is a 300x520 panel the SDK pins to the bottom-right at
   z-index 99999999 — directly over the reading pane, where it covers the
   lead's own controls. It is not ours to reposition (their markup, their
   classes, and both move between SDK versions), but we can decide whether
   it is on screen.

   So: collapsed by default, behind a phone button of our own, and opened
   automatically the moment a call starts. A dialler is needed for the
   seconds around a call and in the way for the rest of the day. */
function softphoneToggle(show) {
  const on = show === undefined
    ? document.body.classList.contains("zv-collapsed")
    : show;
  document.body.classList.toggle("zv-collapsed", !on);
  const btn = $("zv-toggle");
  if (btn) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on ? "Hide the dialler" : "Show the dialler";
  }
  try { localStorage.setItem("kl_zv_open", on ? "1" : ""); } catch (e) { /* fine */ }
}

/* ---------------- RingCentral ----------------

   Preferred over Zoho when this rep has connected their own account, because
   it is per seat: the call goes out as them, with their caller ID and their
   entry in RingCentral's own log. Zoho was one shared identity for everybody,
   which is also what the carriers have been labelling as spam.

   The whole provider-specific surface is this block: load a bundle, swap a
   short-lived SIP registration for a phone, place a call, listen for four
   events. Everything else — the queue, the countdown, the outcome logging —
   never knew which telephony vendor it was talking to. */

const RC_SDK = "https://cdn.jsdelivr.net/npm/ringcentral-web-phone@2.6.0/dist/index.iife.js";
/* Subresource integrity: the browser refuses the bundle if the CDN ever
   serves different bytes for this pinned version. The softphone runs with the
   microphone and the rep's session, so a swapped file must not run at all.
   Bumping the version means recomputing this (and the CSP path in server.js):
     curl -s <RC_SDK> | openssl dgst -sha384 -binary | openssl base64 -A */
const RC_SDK_SRI = "sha384-M4k2ywigqA3GWJ5g2f8HgjMqZzCsmFgiQvosZ71trFAv1tcbccwWb91/nrPRmoYK";

function loadRcSdk() {
  if (window.WebPhone) return Promise.resolve(window.WebPhone);
  if (VOICE.rcLoading) return VOICE.rcLoading;
  VOICE.rcLoading = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = RC_SDK;
    el.integrity = RC_SDK_SRI;
    el.crossOrigin = "anonymous";
    el.async = true;
    el.onerror = () => reject(new Error("could not load the RingCentral web phone"));
    el.onload = () => (window.WebPhone
      ? resolve(window.WebPhone)
      : reject(new Error("RingCentral loaded but exposed no WebPhone")));
    document.head.appendChild(el);
  });
  return VOICE.rcLoading;
}

/* Register a softphone for this rep. The browser never sees the client secret:
   the server hands back only a SIP registration, and that expires. */
async function rcStart() {
  const WP = await loadRcSdk();
  const s = await api("/api/voice/rc/session", { method: "POST" });
  if (!s || !s.sipInfo) throw new Error("RingCentral returned no SIP details");

  const phone = new WP({
    sipInfo: Array.isArray(s.sipInfo) ? s.sipInfo[0] : s.sipInfo,
    /* A stable id per browser, so RingCentral treats a reload as the same
       device rather than accumulating phantom registrations against the seat. */
    instanceId: rcInstanceId(),
    /* Asked for the mic and speaker at the start of every call, so the choice
       in Settings → Audio devices applies to the next call without re-registering. */
    deviceManager: kdDeviceManager(),
  });
  await phone.start();
  /* calls to this person's own number — see kdIncoming */
  phone.on("inboundCall", (s) => kdIncoming(s));

  VOICE.rc = phone;
  VOICE.sdk = phone;
  VOICE.mode = "sdk";
  VOICE.provider = "ringcentral";
  VOICE.ready = true;
  VOICE.sandbox = !!s.sandbox;
  VOICE.rcError = "";
  KD.registered = true;
  rcShowLauncher(true);
  kdRender();
  if (s.sandbox)
    toast("RingCentral is in SANDBOX — calls reach test numbers only", 12000);
  return phone;
}

function rcInstanceId() {
  try {
    let v = localStorage.getItem("kl_rc_instance");
    if (!v) {
      v = "karma-" + Math.random().toString(36).slice(2, 12);
      localStorage.setItem("kl_rc_instance", v);
    }
    return v;
  } catch (e) { return "karma-" + Math.random().toString(36).slice(2, 12); }
}

/* ---------------- the soft dialler ----------------

   RingCentral's SDK is HEADLESS. Zoho shipped a draggable widget with a
   dialpad, a timer and a mute button; ringcentral-web-phone ships the SIP
   engine and nothing else. So everything a rep touches on a call is here.

   The panel is one state object (KD) and one paint (kdRender). Vanilla, no
   framework, so the rule is: nothing reads the DOM to decide anything. Every
   control writes to KD and calls kdRender, and kdRender is the only thing that
   writes to the DOM. The old bar kept its truth in `aria-pressed` attributes
   and drifted the first time two of them disagreed.

   Inputs are the exception and are never re-created, only reconciled — the
   number field and the note are typed into, and replacing an element under a
   caret eats the keystroke.

   The keypad matters more than it looks. These are B2B numbers and most of
   them answer with a menu; without DTMF a rep cannot get past "press 1 for
   sales", which is most of the calls that matter. */

const KD = {
  view: "keypad",        // leads | keypad | lead
  ptab: "history",       // history | followup | lead
  phase: "idle",         // idle | calling | live | ended
  session: null,
  lead: null,            // the lead being called, if the call came from one
  number: "",            // what the keypad has typed
  started: 0, elapsed: 0,
  muted: false, held: false, rec: false,
  filter: "All", timeline: null, followup: null, extensions: null,
  dispo: "", open: { contact: true, lead: true },
  callerId: null, registered: false,
  timer: null, toastT: null, loadingTimeline: false,
};

const KD_DISPOS = [
  /* Each chip writes to the ONE place Karma Connect already keeps that fact —
     see kdSaveDispo. `kind` is what it touches, so nothing is stored twice.
     The labels are Zoho CRM's own Call Results (crm-sync.js RESULT), so what
     a rep picks is what the CRM shows. A follow-up is not a disposition: it
     is the "Remind me to call back" box under the notes. */
  /* A person worth a CRM record: asks for their name (email optional) and,
     on save, creates them as a Lead in Zoho before the call is sent there. */
  { label: "Prospect", kind: "prospect" },
  { label: "GK", kind: "log", title: "Gatekeeper" },
  { label: "CDM", kind: "log" },
  { label: "Email captured", kind: "log" },
  { label: "Wrong number", kind: "outcome", value: "failed" },
  { label: "No Answer", kind: "outcome", value: "no-answer" },
  { label: "DNC", kind: "dnc", title: "Do not contact — blocks this number" },
  { label: "VM", kind: "log", title: "Voicemail" },
  { label: "Busy", kind: "outcome", value: "busy" },
];
/* Every chip, whatever else it touches, is also written to the disposition
   log (POST /api/leads/:id/disposition — the list there must match this one).
   kind "log" chips touch nothing else: they are only a record of the call. */

const KD_IC = {
  phone: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z",
  note: "M5 4h10l4 4v12H5V4zM9 12h6M9 16h4",
  cal: "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 10h18M8 3v4M16 3v4",
  flag: "M5 21V4h11l-2 4 2 4H5",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  tag: "M3 12V4h8l10 10-8 8L3 12zM7.5 8h.01",
  ban: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.6 5.6l12.8 12.8",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
  micOff: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16",
  pad: "M6 6h.01M12 6h.01M18 6h.01M6 12h.01M12 12h.01M18 12h.01M6 18h.01M12 18h.01M18 18h.01",
  pause: "M9 5v14M15 5v14",
  play: "M8 5l11 7-11 7V5z",
  rec: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  vm: "M7 15a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm10 0a3 3 0 1 1 0-6 3 3 0 0 1 0 6zM7 15h10",
  transfer: "M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4",
  more: "M6 12h.01M12 12h.01M18 12h.01",
};

const kdSvg = (d, cls) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"${cls ? ` class="${cls}"` : ""}><path d="${d}"/></svg>`;

function kdEl(id) { return document.getElementById(id); }
function kdShow(id, on) { kdEl(id)?.classList.toggle("hidden", !on); }

/* 212 → (212), 2125551234 → (212) 555-1234. Anything with a + or an
   extension is left exactly as typed: reformatting an international number
   into a US shape is how you dial the wrong country. */
function kdFmtNum(v) {
  const raw = String(v || "").trim();
  /* +1XXXXXXXXXX is what RingCentral hands back for a US seat, and showing it
     raw in the Caller ID chip is the one number a rep most needs to read at a
     glance. Anything else international stays exactly as given — reformatting
     a foreign number into a US shape is how you dial the wrong country. */
  const us = raw.match(/^\+1(\d{10})$/);
  if (us) return "+1 " + kdFmtNum(us[1]);
  if (/[+a-z]/i.test(raw)) return raw;
  const x = raw.replace(/[^0-9*#]/g, "");
  if (/[*#]/.test(x) || x.length < 4) return x;
  if (x.length < 7) return `(${x.slice(0, 3)}) ${x.slice(3)}`;
  if (x.length <= 10) return `(${x.slice(0, 3)}) ${x.slice(3, 6)}-${x.slice(6)}`;
  return raw;
}

function kdInitials(name) {
  const w = String(name || "").replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!w.length) return "—";
  return ((w[0][0] || "") + (w[1] ? w[1][0] : "")).toUpperCase();
}

function kdClock(s) {
  const n = Math.max(0, Math.floor(s));
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}

/* Toast inside the panel rather than the page's own. The page toast appears
   bottom-right, which is exactly where the dialler is — it would land behind
   it, which is where the first version put every error message. */
function kdToast(msg, ms) {
  const el = kdEl("kd-toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(KD.toastT);
  KD.toastT = setTimeout(() => el.classList.add("hidden"), ms || 3600);
}

/* Every SDK control is wrapped: the SDK rejects rather than throwing, and an
   unhandled rejection in a click handler leaves the panel looking frozen with
   no clue why. */
function kdGuard(fn, what) {
  return Promise.resolve().then(fn).catch((e) => {
    console.warn("[karma] " + what + ":", e);
    kdToast("Could not " + what + " — " + (describeErr(e) || "unknown"));
    return Promise.reject(e);
  });
}

const kdActive = () => KD.phase === "calling" || KD.phase === "live";

/* ---------------- paint ---------------- */

function kdRender() {
  /* The Call session card follows the phone, panel open or not — so this
     runs before the early return below for a closed panel. */
  campPaintLive();
  const root = kdEl("rc-call");
  if (!root || root.classList.contains("hidden")) return;
  const live = KD.phase === "live", calling = KD.phase === "calling";
  const ended = KD.phase === "ended", active = kdActive();

  /* header, and the failure banner when the line would not register */
  const err = VOICE.rcError && !KD.registered;
  kdEl("kd-reg").textContent = err ? "Not connected"
    : KD.registered ? "Available" : "Connecting…";
  kdEl("kd-dot-reg").classList.toggle("off", !KD.registered);
  kdEl("kd-dot-reg").classList.toggle("err", !!err);
  kdShow("kd-err", !!err);
  if (err) {
    const [title, msg] = rcFriendlyError(VOICE.rcError);
    kdEl("kd-err-title").textContent = title;
    kdEl("kd-err-msg").textContent = msg;
    kdEl("kd-err").title = VOICE.rcError;
    const retry = kdEl("kd-retry");
    retry.disabled = !!VOICE.rcRetrying;
    retry.textContent = VOICE.rcRetrying ? "Retrying…" : "Retry";
  }
  /* during a campaign call the number the lead sees is the callback
     person's, so that is what the header says */
  kdEl("kd-cid-num").textContent = KD.callAs ? kdFmtNum(KD.callAs)
    : KD.callerId ? kdFmtNum(KD.callerId) : "—";

  /* the return strip: on a call, looking elsewhere */
  const showReturn = active && KD.view !== "lead";
  kdShow("kd-return", showReturn);
  if (showReturn) {
    kdEl("kd-return-who").textContent = KD.lead?.name || kdFmtNum(KD.number) || "On a call";
    kdEl("kd-return-time").textContent = kdClock(KD.elapsed);
  }

  /* which view */
  kdShow("kd-view-leads", KD.view === "leads");
  kdShow("kd-view-keypad", KD.view === "keypad");
  kdShow("kd-view-lead", KD.view === "lead");
  kdShow("kd-view-settings", KD.view === "settings");
  kdShow("kd-view-inbox", KD.view === "inbox");
  if (KD.view === "inbox") kdRenderInbox();
  /* The call clock repaints every second; rebuilding Settings under an open
     <select> would snap the dropdown shut, so leave it alone while focused. */
  if (KD.view === "settings" && !kdEl("kd-settings")?.contains(document.activeElement))
    kdRenderSettings();
  /* More is lead actions, which only mean something on a call; between calls
     the same slot is Settings. */
  kdShow("kd-nav-more", active);
  kdShow("kd-nav-settings", !active);
  document.querySelectorAll(".kd-nav button").forEach((b) => {
    const on = (b.dataset.nav === "keypad" && KD.view === "keypad")
      || (b.dataset.nav === "settings" && KD.view === "settings")
      || (b.dataset.nav === "leads" && KD.view === "leads")
      || (b.dataset.nav === "history" && KD.view === "lead" && KD.ptab === "history")
      || (b.dataset.nav === "inbox" && KD.view === "inbox");
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });

  /* keypad */
  /* Reconcile rather than overwrite, and compare DIGITS not the formatted
     string. When the rep is typing, the input handler has already put those
     digits in KD.number, so they match and nothing is written — the caret is
     safe. When a keypad button changed KD.number they differ, so it is
     written even though the field has focus. Guarding on activeElement alone
     (the obvious version) meant the keypad silently did nothing whenever the
     field was focused, which is every time the panel opens. */
  const numInput = kdEl("kd-num");
  const onCallPad = KD.phase === "live" && KD.session;
  if (numInput) {
    if (onCallPad) {
      const want = (KD.dtmf || "").slice(-18);          // the tones sent, not the dial number
      if (numInput.value !== want) numInput.value = want;
      numInput.placeholder = "Keypad tones for the menu";
    } else {
      if (numInput.value.replace(/[^0-9*#+]/g, "") !== KD.number) numInput.value = kdFmtNum(KD.number);
      numInput.placeholder = "(201) 555-0123";
    }
  }
  const go = kdEl("kd-go");
  if (go) go.disabled = active || !KD.number || !!err;

  /* the lead / call view */
  if (KD.view === "lead") kdRenderLead(live, calling, ended, active);

  /* the launcher doubles as the only sign of a call when the panel is shut */
  kdEl("rc-launch")?.classList.toggle("oncall", active || KD.phase === "incoming");
  kdDesktopState();
}

function kdRenderLead(live, calling, ended, active) {
  const L = KD.lead;
  const incoming = KD.phase === "incoming";
  const name = L?.name || (KD.number ? kdFmtNum(KD.number) : "No lead selected");
  kdEl("kd-avatar").textContent = L ? kdInitials(L.name) : "☎";
  kdEl("kd-avatar").classList.toggle("ring", calling || incoming);
  kdEl("kd-name").textContent = name;
  kdEl("kd-sub").textContent = L
    ? [L.industry, [L.city, L.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ")
    : incoming ? (KD.incoming?.info ? (KD.incoming.info.known ? "A lead in Karma Connect" : "Not in Karma Connect") : "Looking them up…")
      : "Not in the lead list";
  kdShow("kd-incoming", incoming);
  if (incoming) {
    const last = KD.incoming?.info?.last;
    kdEl("kd-inc-why").innerHTML = last
      ? `<b>Calling back</b> — ${esc(last.by)} called them ${esc(relTime(last.at))}${
          last.campaign ? ` in <b>${esc(last.campaign)}</b>` : ""}${
          last.disposition ? ` · logged “${esc(last.disposition)}”` : ""}`
      : `<b>Incoming call</b>${KD.incoming?.info ? " — no earlier call from here to this number" : ""}`;
  }
  kdEl("kd-phone").textContent = kdFmtNum(L?.phone || KD.number);

  const st = kdEl("kd-status-chip") || kdEl("kd-status");
  const chip = document.getElementById("kd-status");
  if (chip) {
    chip.textContent = L?.status || "";
    chip.classList.toggle("hidden", !L?.status);
  }

  /* status line */
  const label = KD.phase === "idle" ? "Ready to call"
    : incoming ? "Incoming call"
    : calling ? "Calling"
      : ended ? "Call ended"
        : KD.held ? "On hold" : "Connected";
  const stateEl = kdEl("kd-state");
  stateEl.textContent = label;
  stateEl.className = live && KD.held ? "hold" : live ? "live" : "";
  const dot = kdEl("kd-dot");
  dot.className = "kd-sdot" + (live && KD.held ? " hold" : live ? " live" : "");
  kdShow("kd-dots", calling);
  kdShow("kd-rec", live && KD.rec);
  kdEl("kd-time").textContent = kdClock(KD.elapsed);
  kdEl("kd-time").style.visibility = KD.phase === "idle" || incoming ? "hidden" : "";

  kdShow("kd-holdbar", live && KD.held);
  kdShow("kd-ready", KD.phase === "idle");
  kdShow("kd-controls", active);
  kdShow("kd-over", ended);
  const callBtn = kdEl("kd-call");
  if (callBtn) callBtn.disabled = !(L?.phone || KD.number);
  kdEl("kd-fromline").textContent = KD.callerId
    ? "Calling from " + kdFmtNum(KD.callerId) : "";
  kdEl("kd-overnote").textContent = "Duration " + kdClock(KD.elapsed);

  if (active) kdRenderControls(live);

  document.querySelectorAll(".kd-ptabs button").forEach((b) => {
    const on = b.dataset.tab === KD.ptab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
  kdRenderPanel();
}

/* ---------------- voicemail drop ----------------
   A rep records their voicemail message once (Settings → Voicemail). On a call
   that reaches an answering machine they wait for the beep and press VM drop:
   the recording plays into the line in place of their microphone, the call
   hangs up when it finishes, and it is logged as Voicemail. The recording is
   kept on the server (leads/server/vm-drop.js) so it follows them anywhere.

   How it plays into the call: the outgoing audio of a WebRTC call is one
   track on one RTCRtpSender. replaceTrack() swaps the microphone for a track
   fed from the decoded recording — no renegotiation, nothing the far end can
   tell apart from a person speaking. */
const VM = { meta: null, bytes: null, rec: null, draft: null, playing: null, playingSaved: false, drop: null };
const VM_MAX_SEC = 90;

async function vmLoad() {
  try { VM.meta = await api("/api/voice/vmdrop"); } catch (e) { VM.meta = null; }
  VM.bytes = null;                      // fetched on first use, then kept
  if (KD.session) kdRender();
}

async function vmBytes() {
  if (VM.bytes) return VM.bytes;
  const r = await fetch("/api/voice/vmdrop/audio", { credentials: "same-origin" });
  if (!r.ok) throw new Error("couldn't load your voicemail recording");
  VM.bytes = await r.arrayBuffer();
  return VM.bytes;
}

const vmClock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;

/* ---- recording one ---- */

async function vmRecordStart() {
  if (VM.rec) return;
  if (KD.session) return kdToast("Finish the call before recording your voicemail");
  let stream;
  try {
    const p = kdAudioPrefs();
    stream = await navigator.mediaDevices.getUserMedia({ audio:
      !p.system && p.input && p.input !== "default" ? { deviceId: { exact: p.input } } : true });
  } catch (e) { return kdToast("Microphone blocked — allow it in the browser to record"); }
  const type = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"]
    .find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    const secs = (Date.now() - VM.rec.at) / 1000;
    clearInterval(VM.rec.tick);
    const blob = new Blob(chunks, { type: (recorder.mimeType || type || "audio/webm").split(";")[0] });
    VM.rec = null;
    VM.draft = secs < 1 ? null : { blob, secs, url: URL.createObjectURL(blob) };
    if (!VM.draft) kdToast("That was too short — try again");
    kdRenderSettings();
  };
  VM.rec = { recorder, at: Date.now(),
    tick: setInterval(() => {
      const el = kdEl("vm-rec-time");
      const s = (Date.now() - VM.rec.at) / 1000;
      if (el) el.textContent = vmClock(s);
      if (s >= VM_MAX_SEC) vmRecordStop();
    }, 250) };
  recorder.start();
  kdRenderSettings();
}

function vmRecordStop() {
  if (VM.rec && VM.rec.recorder.state !== "inactive") VM.rec.recorder.stop();
}

function vmPlay(url, saved) {
  if (VM.playing) { VM.playing.pause(); VM.playing = null; VM.playingSaved = false; kdRenderSettings(); return; }
  const a = new Audio(url);
  const p = kdAudioPrefs();
  if (!p.system && p.output && a.setSinkId) a.setSinkId(p.output).catch(() => {});
  a.onended = () => { VM.playing = null; VM.playingSaved = false; kdRenderSettings(); };
  VM.playing = a;
  VM.playingSaved = !!saved;
  a.play().catch(() => { VM.playing = null; kdToast("Couldn't play it"); });
  kdRenderSettings();
}

async function vmSave() {
  if (!VM.draft) return;
  try {
    const r = await fetch("/api/voice/vmdrop", { method: "PUT", credentials: "same-origin",
      headers: { "Content-Type": VM.draft.blob.type || "audio/webm", "X-Seconds": String(VM.draft.secs.toFixed(2)) },
      body: VM.draft.blob });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
    URL.revokeObjectURL(VM.draft.url);
    VM.draft = null;
    await vmLoad();
    kdToast("Voicemail saved — use VM drop on your next voicemail");
  } catch (e) { kdToast("Couldn't save: " + e.message); }
  kdRenderSettings();
}

async function vmDelete() {
  if (!confirm("Delete your recorded voicemail?")) return;
  try { await api("/api/voice/vmdrop", { method: "DELETE" }); await vmLoad(); kdToast("Voicemail deleted"); }
  catch (e) { kdToast("Couldn't delete: " + e.message); }
  kdRenderSettings();
}

function vmRenderSettings(box) {
  const m = VM.meta || { has: false };
  const playingSaved = VM.playing && VM.playingSaved;
  if (VM.rec) {
    box.innerHTML = `
      <div class="vm-card vm-live">
        <span class="vm-dot"></span>
        <div class="vm-t"><b>Recording…</b><span>Speak your voicemail message. Stops by itself at ${vmClock(VM_MAX_SEC)}.</span></div>
        <span id="vm-rec-time" class="vm-time">0:00</span>
      </div>
      <button class="kd-primary vm-stop" data-set="vm-stop">Stop recording</button>`;
    return;
  }
  if (VM.draft) {
    box.innerHTML = `
      <div class="vm-card">
        <div class="vm-t"><b>New recording · ${vmClock(VM.draft.secs)}</b><span>Listen back, then save it — or record again.</span></div>
      </div>
      <div class="vm-btns">
        <button class="kd-pill" data-set="vm-play-draft">${VM.playing ? "Stop" : "Play"}</button>
        <button class="kd-pill" data-set="vm-rec">Record again</button>
        <button class="kd-pill" data-set="vm-discard">Discard</button>
      </div>
      <button class="kd-primary" data-set="vm-save">Save as my voicemail</button>`;
    return;
  }
  box.innerHTML = `
    <div class="vm-card">
      <div class="vm-t">${m.has
        ? `<b>Your voicemail · ${m.seconds ? vmClock(m.seconds) : "saved"}</b><span>Recorded ${esc(relTime(m.updatedAt))}</span>`
        : `<b>No voicemail recorded</b><span>Record it once, then drop it on any call that reaches voicemail.</span>`}</div>
    </div>
    <div class="vm-btns">
      ${m.has ? `<button class="kd-pill" data-set="vm-play">${playingSaved ? "Stop" : "Play"}</button>` : ""}
      <button class="kd-pill" data-set="vm-rec">${m.has ? "Re-record" : "Record"}</button>
      ${m.has ? `<button class="kd-pill" data-set="vm-del">Delete</button>` : ""}
    </div>
    <p class="kd-hint">On a call: when you hear the voicemail beep, press <b>VM drop</b>. Your message plays,
      the call hangs up when it ends, and it's logged as Voicemail.</p>`;
}

async function vmSettingAction(which) {
  if (which === "vm-rec") { if (VM.draft) { URL.revokeObjectURL(VM.draft.url); VM.draft = null; } return vmRecordStart(); }
  if (which === "vm-stop") return vmRecordStop();
  if (which === "vm-play-draft") return VM.draft && vmPlay(VM.draft.url);
  if (which === "vm-play") {
    if (VM.playing) return vmPlay();
    try {
      const url = URL.createObjectURL(new Blob([await vmBytes()], { type: VM.meta?.mime || "audio/webm" }));
      vmPlay(url, true);
    } catch (e) { kdToast(e.message); }
    return;
  }
  if (which === "vm-save") return vmSave();
  if (which === "vm-discard") { if (VM.draft) URL.revokeObjectURL(VM.draft.url); VM.draft = null; return kdRenderSettings(); }
  if (which === "vm-del") return vmDelete();
}

/* ---- dropping it into a call ---- */

async function kdVmDrop() {
  const s = KD.session;
  if (!s || KD.phase !== "live") return;        // phase leaves "live" the instant we background it, so a double-press is a no-op
  if (!VM.meta?.has) {
    KD.view = "settings"; KD.stab = "vm"; kdRender();
    return kdToast("Record your voicemail first — Settings → Voicemail");
  }
  const pc = s.rtcPeerConnection;
  const sender = pc?.getSenders?.().find((x) => x.track && x.track.kind === "audio");
  if (!sender) return kdToast("Voicemail drop isn't available on this call");
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    /* A context made on a click can start suspended; without this the
       voicemail plays into the line silent — the caller hears nothing. */
    await ctx.resume().catch(() => {});
    const buf = await ctx.decodeAudioData((await vmBytes()).slice(0));
    /* An empty or near-empty recording would "finish" the instant it starts,
       and onended hangs up — so the call would appear to drop the moment VM
       drop is pressed. Stop here and say why instead. */
    if (!buf || buf.duration < 0.5) {
      try { await ctx.close(); } catch (e) { /* fine */ }
      KD.view = "settings"; KD.stab = "vm"; kdRender();
      return kdToast("Your saved voicemail is empty — re-record it in Settings → Voicemail");
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest);
    /* The voicemail replaces the outgoing mic, and we stop listening to the
       far end: from here this call needs NEITHER the rep's microphone NOR
       their ears, which is exactly what frees them to start the next call
       while it finishes on its own. */
    await sender.replaceTrack(dest.stream.getAudioTracks()[0]);
    try { pc.getReceivers?.().forEach((r) => { if (r.track && r.track.kind === "audio") r.track.enabled = false; }); } catch (e) { /* fine */ }
    /* Recording is left to RingCentral's Automatic Call Recording — the dropped
       voicemail is captured on the call's recording like everything else. The
       app no longer starts an On-Demand recording here (it conflicted with
       Automatic and paused it). */
    /* Self-contained so it survives in the background whatever the rep does
       next: it plays to the end, then hangs up its own line. Nothing here
       touches KD.session, which is about to be freed (or the next call). */
    src.onended = () => {
      try { src.onended = null; src.stop(); } catch (e) { /* done */ }
      try { ctx.close(); } catch (e) { /* done */ }
      kdGuard(() => s.hangup(), "hang up").catch(() => {});
    };
    src.start();
    VM.drop = null;                 // nothing is playing in the FOREGROUND
    KD.vmDropped = true;            // finish() records this call as a Voicemail
    kdToast("Voicemail is sending in the background — go ahead, call the next one");
    /* Free the rep at once: log the call and move the session on WITHOUT
       hanging up the line — finish() resets the UI but never kills the RTC,
       so the call above keeps carrying the voicemail until it ends itself. */
    if (typeof VOICE.endCall === "function") VOICE.endCall("no-answer");
    else { reportCall(null, "no-answer"); kdLive("ended"); kdStopClock(); KD.phase = "ended"; KD.session = null; kdRender(); kdOpenWrap(); }
  } catch (e) {
    console.warn("[karma] voicemail drop:", e);
    try { pc.getReceivers?.().forEach((r) => { if (r.track && r.track.kind === "audio") r.track.enabled = true; }); } catch (_) { /* fine */ }
    kdToast("Couldn't play your voicemail — " + (describeErr(e) || "unknown"));
  }
}

/* Pressed again mid-message: stop it and give the rep their microphone back. */
function kdVmDropCancel() {
  if (!VM.drop) return;
  VM.drop.done = true;
  CAMP.vmPendingArm = null;          // back on the line — the held next lead is off
  const { sender, mic } = VM.drop;
  kdVmDropCleanup();
  if (sender && mic && mic.readyState === "live") sender.replaceTrack(mic).catch(() => {});
  kdToast("Voicemail stopped — you're back on the line");
  kdRender();
}

function kdVmDropCleanup() {
  const d = VM.drop;
  if (!d) return;
  clearInterval(d.tick);
  try { d.src.onended = null; d.src.stop(); } catch (e) { /* already stopped */ }
  d.ctx.close().catch(() => {});
  VM.drop = null;
}

function kdRenderControls(live) {
  /* Seven. "VM drop" plays the rep's recorded voicemail into the call — the
     SDK has no primitive for it (toVoicemail() sends an INCOMING call to
     voicemail, a different thing), so it swaps the outgoing audio track
     itself; see kdVmDrop. */
  const ctl = (key, label, icon, on, tone) =>
    `<div class="kd-ctl">
       <button data-ctl="${key}" class="${tone || ""}" aria-pressed="${on ? "true" : "false"}"
         aria-label="${label}" ${live ? "" : "disabled"}>${kdSvg(icon, key === "keypad" || key === "more" ? "kd-thick" : "")}</button>
       <span>${label}</span>
     </div>`;
  kdEl("kd-ctls").innerHTML = [
    ctl("mute", KD.muted ? "Unmute" : "Mute", KD.muted ? KD_IC.micOff : KD_IC.mic, KD.muted),
    ctl("keypad", "Keypad", KD_IC.pad, false),
    ctl("hold", KD.held ? "Resume" : "Hold", KD.held ? KD_IC.play : KD_IC.pause, KD.held, "gold"),
    /* No Record control: recording is RingCentral's Automatic Call Recording
       (server-side, the whole call). An in-app On-Demand toggle on an already
       auto-recorded call PAUSES that recording — which is what was cutting
       recordings off — so the app does not touch recording at all. */
    ctl("transfer", "Transfer", KD_IC.transfer, false),
    ctl("vmdrop", VM.drop ? "Stop · " + vmClock(Math.max(0, (VM.drop.ends - Date.now()) / 1000)) : "VM drop",
      KD_IC.vm, !!VM.drop, "gold"),
    ctl("more", "More", KD_IC.more, false),
  ].join("");
}

/* ---------------- the three panels ---------------- */

function kdRenderPanel() {
  const box = kdEl("kd-panel");
  if (!box) return;
  if (KD.ptab === "history") return kdRenderHistory(box);
  if (KD.ptab === "followup") return kdRenderFollowup(box);
  return kdRenderLeadSheet(box);
}

const KD_FILTERS = ["All", "Calls", "Notes", "Follow-ups"];

function kdRenderHistory(box) {
  if (!KD.lead) { box.innerHTML = `<div class="kd-empty">Pick a lead to see its history.</div>`; return; }
  if (KD.loadingTimeline) { box.innerHTML = `<div class="kd-empty">Loading…</div>`; return; }

  const items = (KD.timeline || []).filter((i) =>
    KD.filter === "All"
    || (KD.filter === "Calls" && i.kind === "call")
    || (KD.filter === "Notes" && i.kind === "note")
    || (KD.filter === "Follow-ups" && i.kind === "followup"));

  const filters = KD_FILTERS.map((f) =>
    `<button data-filter="${f}" class="${KD.filter === f ? "on" : ""}">${f}</button>`).join("");

  if (!items.length) {
    box.innerHTML = `<div class="kd-filters">${filters}</div>
      <div class="kd-empty">No ${KD.filter === "All" ? "activity" : KD.filter.toLowerCase()} for this lead yet.</div>`;
    return;
  }

  let lastDay = "";
  const rows = items.map((i, n) => {
    const day = kdDay(i.at);
    const show = day === lastDay ? "" : day;
    lastDay = day;
    const icon = i.kind === "call" ? KD_IC.phone : i.kind === "followup" ? KD_IC.cal : KD_IC.note;
    return `<li class="${n === 0 && kdActive() ? "hot" : ""}">
      <div class="kd-tl-rail"><div class="kd-tl-ic">${kdSvg(icon)}</div><div class="kd-tl-line"></div></div>
      <div class="kd-tl-body">
        ${show ? `<div class="kd-tl-day">${esc(show)}</div>` : ""}
        <div class="kd-tl-t">${esc(kdTitle(i))}</div>
        <div class="kd-tl-s">${esc(kdSubtitle(i))}</div>
      </div></li>`;
  }).join("");
  box.innerHTML = `<div class="kd-filters">${filters}</div><ul class="kd-tl">${rows}</ul>`;
}

function kdDay(at) {
  const d = new Date(at), now = new Date();
  const dayOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((dayOf(now) - dayOf(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function kdTitle(i) {
  if (i.kind === "call")
    return "Outbound call" + (i.seconds ? " — " + kdClock(i.seconds) : "");
  if (i.action === "status") return "Status changed";
  if (i.action === "owner") return "Reassigned";
  if (i.action === "enrich") return "Enriched";
  if (i.action === "remove") return "Added to Do Not Contact";
  if (i.action === "restore") return "Restored";
  // a note that records an event names it — e.g. "Registered in Zoho CRM" —
  // rather than the generic "Note added"
  if (i.action === "note" && i.to) return i.to;
  return "Note added";
}

/* The rep behind an entry, readable: the name before the @, and "via Zoho" for
   the ones Zoho itself raised (an inbound match or the backfill). */
function kdWho(a) {
  if (!a) return "";
  if (a === "zoho") return "via Zoho";
  return String(a).split("@")[0];
}

function kdSubtitle(i) {
  if (i.kind === "call") {
    const o = { connected: "Connected", "no-answer": "No answer", busy: "Busy",
      failed: "Failed", cancelled: "Cancelled", placed: "Placed" }[i.outcome] || i.outcome || "";
    // outcome · disposition · WHO contacted them
    return [o, i.disposition, kdWho(i.actor) && "by " + kdWho(i.actor)].filter(Boolean).join(" · ");
  }
  if (i.action === "status") return [i.from, i.to].filter(Boolean).join(" → ") || kdWho(i.actor);
  // an event note (Zoho link, etc.): the detail, and who/what raised it
  if (i.action === "note" && i.to) return [i.note, kdWho(i.actor) && "by " + kdWho(i.actor)].filter(Boolean).join(" · ");
  return i.note || i.to || kdWho(i.actor) || "";
}

function kdRenderFollowup(box) {
  if (!KD.lead) { box.innerHTML = `<div class="kd-empty">Pick a lead to set a follow-up.</div>`; return; }
  const f = KD.followup;
  if (!f) {
    box.innerHTML = `
      <div class="kd-empty" style="margin-bottom:12px">Nothing scheduled for this lead yet.</div>
      <button class="kd-dashed" data-open-wrap="1">${kdSvg(KD_IC.cal)}<span>Schedule follow-up</span></button>`;
    return;
  }
  const d = new Date(f.due_at);
  box.innerHTML = `
    <div class="kd-tl-day" style="margin-bottom:10px">Next follow-up</div>
    <div class="kd-fucard">
      <div class="kd-fudate">
        <b>${d.toLocaleDateString(undefined, { month: "short" }).toUpperCase()}</b>
        <span>${d.getDate()}</span>
      </div>
      <div class="kd-fumeta">
        <b>${esc(d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }))}</b>
        <div class="t">${esc(d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}</div>
        ${f.note ? `<div class="n">${esc(f.note)}</div>` : ""}
      </div>
    </div>
    <div class="kd-row2" style="margin-top:12px">
      <button class="kd-mini" data-open-wrap="1">Edit</button>
      <button class="kd-mini ghost" data-cancel-fu="1">Cancel</button>
    </div>`;
}

function kdRenderLeadSheet(box) {
  const L = KD.lead;
  if (!L) { box.innerHTML = `<div class="kd-empty">Pick a lead to see its details.</div>`; return; }
  const secs = [
    ["company", "Company", [["Company", L.company || L.name], ["Industry", L.industry],
      ["Location", [L.city, L.state].filter(Boolean).join(", ")]]],
    ["contact", "Contact", [["Phone", kdFmtNum(L.phone)], ["Email", L.email], ["Website", L.website]]],
    ["lead", "Lead", [["Code", L.code], ["Status", L.status], ["Owner", L.owner]]],
  ];
  box.innerHTML = secs.map(([id, title, rows]) => {
    const open = !!KD.open[id];
    const body = rows.filter(([, v]) => v).map(([k, v]) =>
      `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");
    return `<div class="kd-sec">
      <button data-sec="${id}" aria-expanded="${open}">
        <span>${esc(title)}</span>${kdSvg("M6 9l6 6 6-6")}
      </button>
      ${open ? `<dl class="kd-dl">${body || `<div><dt>—</dt><dd>Nothing recorded</dd></div>`}</dl>` : ""}
    </div>`;
  }).join("");
}

/* ---------------- the lead queue ---------------- */

function kdRenderQueue(rows, q) {
  const box = kdEl("kd-queue");
  if (!box) return;
  const term = (q || "").trim().toLowerCase();
  const list = (rows || []).filter((r) => !term
    || String(r.Name || "").toLowerCase().includes(term)
    || String(r.Phone || "").replace(/\D/g, "").includes(term.replace(/\D/g, "")));
  if (!list.length) {
    box.innerHTML = `<div class="kd-empty">${term ? "Nothing matches that." : "No leads with a phone number assigned to you."}</div>`;
    return;
  }
  box.innerHTML = list.slice(0, 60).map((r) => {
    const on = KD.lead && KD.lead.id === r.Id;
    return `<button class="kd-lrow ${on ? "on" : ""}" data-lead="${r.Id}">
      <span class="kd-ini">${esc(kdInitials(r.Name))}</span>
      <span class="kd-lrow-t"><b>${esc(r.Name || "—")}</b><span>${esc(kdFmtNum(r.Phone))}</span></span>
      <span class="kd-lrow-tag">${on && kdActive() ? "On call" : esc(r.Status || "")}</span>
    </button>`;
  }).join("");
}

/* The rep's own working list, newest first — the same leads the main table
   shows them, filtered to the ones that can actually be rung. */
async function kdLoadQueue() {
  try {
    const d = await api("/api/leads?limit=60");
    /* No has_phone filter exists server-side, and adding one would mean a
       fourth place that defines "callable". Filtered here instead: the page
       is 60 rows, so the cost is nothing. */
    KD.queue = (d.list || []).map(fromApi).filter((r) => String(r.Phone || "").trim());
    kdRenderQueue(KD.queue, kdEl("kd-q")?.value);
  } catch (e) {
    kdEl("kd-queue").innerHTML = `<div class="kd-empty">Could not load leads — ${esc(describeErr(e) || "unknown")}</div>`;
  }
}

async function kdLoadLead(leadId) {
  KD.timeline = null; KD.followup = null; KD.loadingTimeline = true;
  kdRender();
  const [tl, fu] = await Promise.allSettled([
    api("/api/leads/" + leadId + "/timeline?limit=40"),
    api("/api/leads/" + leadId + "/followup"),
  ]);
  KD.loadingTimeline = false;
  KD.timeline = tl.status === "fulfilled" ? (tl.value.items || []) : [];
  /* A lead with no reminder answers 404 here, which is not an error worth
     showing — it is the normal case for most leads. */
  KD.followup = fu.status === "fulfilled" ? (fu.value.followup || fu.value || null) : null;
  if (KD.followup && !KD.followup.due_at) KD.followup = null;
  kdRender();
}

/* ---------------- the clock ---------------- */

function kdTick() {
  if (KD.phase === "live" && !KD.held) KD.elapsed = (Date.now() - KD.started) / 1000;
  const t = kdEl("kd-time"); if (t) t.textContent = kdClock(KD.elapsed);
  const r = kdEl("kd-return-time"); if (r) r.textContent = kdClock(KD.elapsed);
}

function kdStartClock() {
  clearInterval(KD.timer);
  KD.timer = setInterval(kdTick, 1000);
}
function kdStopClock() { clearInterval(KD.timer); KD.timer = null; }

/* ---------------- opening and closing ---------------- */

function rcShowLauncher(on) {
  const b = kdEl("rc-launch");
  if (!b) return;
  b.classList.toggle("hidden", !on);
  /* A red dot on the button itself, so a failed line is visible with the
     panel shut — otherwise a rep only finds out by trying to dial. */
  const err = !!VOICE.rcError && !KD.registered;
  b.classList.toggle("err", err);
  b.title = err ? "Phone not connected — click for details" : "Dialler — type a number or use the keypad";
}

/* The SDK's errors are SIP and OAuth codes. A rep needs to know what to DO,
   so each known failure maps to a title and an action; the raw text stays in
   the banner's tooltip and the console for whoever debugs it. */
function rcFriendlyError(raw) {
  const s = String(raw || "");
  if (/603|too many contacts/i.test(s))
    return ["Too many phones signed in",
      "Your line is open in too many tabs. Close the extras, wait a minute, then retry."];
  if (/invalid_grant|expired|401|403|unauthori[sz]ed/i.test(s))
    return ["RingCentral sign-in expired", "Reconnect RingCentral from the Calls tab, then retry."];
  if (/could not load|network|websocket|socket|timed? ?out/i.test(s))
    return ["Can't reach RingCentral", "Check your internet connection, then retry."];
  return ["Phone not connected", "RingCentral didn't accept the line. Retry, or reconnect from the Calls tab."];
}

async function rcRetry() {
  if (VOICE.rcRetrying) return;
  VOICE.rcRetrying = true;
  kdRender();
  try {
    await rcStart();
    toast("Phone connected");
  } catch (e) {
    VOICE.rcError = describeErr(e) || "unknown error";
    console.warn("[karma] RingCentral retry failed:", VOICE.rcError, e);
  } finally {
    VOICE.rcRetrying = false;
    rcShowLauncher(true);
    kdRender();
  }
}

function rcPanelToggle(show) {
  const el = kdEl("rc-call");
  if (!el) return;
  const open = show === undefined ? el.classList.contains("hidden") : show;
  el.classList.toggle("hidden", !open);
  kdEl("rc-launch")?.setAttribute("aria-expanded", String(open));
  if (!open) return;
  kdPlace();
  /* nothing to show on the call screen → the keypad; but a ringing incoming
     call IS the call screen, even before the lookup has named the caller */
  if (!kdActive() && KD.phase !== "incoming" && KD.view === "lead" && !KD.lead) KD.view = "keypad";
  kdRender();
  if (KD.view === "leads") kdLoadQueue();
  if (KD.view === "keypad") kdEl("kd-num")?.focus();
  kdLoadMe();
}

/* Embed mode plumbing. The extension injects this app as an <iframe> and can
   ask it to dial — click-to-call from a number selected on any website. We only
   obey a dial message that carries the one-time token the extension also put in
   our URL (?k=…), so a host page that happens to find the iframe cannot drive
   the softphone. Within the iframe the header is not a drag handle — the
   extension drags the whole floating panel — so kdPlace/kdWireDrag stand down
   (see the guards there). */
function kcWireEmbed(token) {
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.kc !== "dial" || !m.number) return;
    /* Security audit, 14 Oct 2026. Only the frame's own parent may send a
       number, and only with the token — never a blank one. Before this, a page
       opened WITHOUT ?k= skipped the check, so any website could window.open
       this view and post it a number (premium-rate, anything) to ring on the
       rep's line. And it never dials by itself any more: the number is filled
       in and the rep presses Call. (With the extension switched off nothing
       can frame this view, so this listener has no sender at all.) */
    if (window.parent === window || e.source !== window.parent) return;
    if (!token || m.k !== token) return;
    KD.number = String(m.number).replace(/[^0-9*#+]/g, "");
    KD.lead = null;
    KD.view = "keypad";
    rcPanelToggle(true);
    kdRender();
  });
}
const kcEmbedded = () => document.body.classList.contains("kc-embed");

/* Caller ID is fetched once per page, not per open: it is a round trip to
   RingCentral and the number does not change between calls. */
let kdMeDone = false;
async function kdLoadMe() {
  if (kdMeDone) return;
  kdMeDone = true;
  try {
    const d = await api("/api/voice/rc/me");
    KD.callerId = d.callerId || null;
    kdRender();
  } catch (e) { /* the header falls back to "—"; not worth a toast */ }
}

/* ---------------- moving the panel ----------------

   The header is a drag handle. A rep parks the dialler wherever it covers the
   least of what they are working on, and it stays there: the spot is kept per
   browser, and re-clamped on every open and resize so a smaller window can
   never strand it off-screen with no way to grab it back. Double-click the
   header to send it home to the corner. Phones get the full-bleed panel and
   no dragging — there is nowhere to drag it to. */
const KD_POS_KEY = "kl_kd_pos";
const kdPhone = () => window.matchMedia("(max-width: 520px)").matches;

function kdPlace(pos) {
  const el = kdEl("rc-call");
  if (!el || el.classList.contains("hidden")) return;
  if (kcEmbedded()) return;   // the extension docks and carries the panel, not this
  if (pos === undefined) {
    try { pos = JSON.parse(localStorage.getItem(KD_POS_KEY) || "null"); } catch (e) { pos = null; }
  }
  if (!pos || kdPhone()) {
    el.style.left = el.style.top = el.style.right = el.style.bottom = "";
    return;
  }
  const r = el.getBoundingClientRect();
  const x = Math.max(8, Math.min(pos.x, innerWidth - r.width - 8));
  const y = Math.max(8, Math.min(pos.y, innerHeight - r.height - 8));
  Object.assign(el.style, { left: x + "px", top: y + "px", right: "auto", bottom: "auto" });
  return { x, y };
}

function kdWireDrag(root) {
  const head = root.querySelector(".kd-head");
  if (!head) return;
  let drag = null;

  head.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || kdPhone() || kcEmbedded() || e.target.closest("button, input, a")) return;
    const r = root.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, at: null };
    head.setPointerCapture(e.pointerId);
    root.classList.add("dragging");
    e.preventDefault();
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.at = kdPlace({ x: e.clientX - drag.dx, y: e.clientY - drag.dy });
  });
  const drop = () => {
    if (!drag) return;
    if (drag.at) try { localStorage.setItem(KD_POS_KEY, JSON.stringify(drag.at)); } catch (e) { /* session only */ }
    drag = null;
    root.classList.remove("dragging");
  };
  head.addEventListener("pointerup", drop);
  head.addEventListener("pointercancel", drop);

  head.addEventListener("dblclick", (e) => {
    if (e.target.closest("button")) return;
    try { localStorage.removeItem(KD_POS_KEY); } catch (err) { /* fine */ }
    kdPlace(null);
  });
  window.addEventListener("resize", () => kdPlace());
}

/* ---------------- reminders ----------------

   Every follow-up this rep has set, across all their leads, in one place.
   Before this a follow-up was only visible from inside its own lead, so to
   find out what was due a rep had to remember which lead they had set it on —
   which is the thing a reminder exists to save them from.

   Polled once a minute (the server's own sweeper runs on the same beat). A
   follow-up that falls due while the page is open raises a toast and the
   badge, so it does not depend on the reminder email being noticed.

   /api/followups gives an admin the whole floor's; this list is filtered to
   the caller's own, because "my reminders" with forty strangers' in it is
   not a reminder list. */
const KD_FU_POLL_MS = 60 * 1000;

/* Started from boot(), not from wiring: wire() runs before sign-in resolves,
   and "mine" filtered against a user who is not known yet is an empty list —
   which the first-load summary would then record as "nothing was due". */
let kdRemindersOn = false;
function kdStartReminders() {
  if (kdRemindersOn) return;
  kdRemindersOn = true;
  kdLoadFollowups();
  setInterval(kdLoadFollowups, KD_FU_POLL_MS);
}

async function kdLoadFollowups() {
  if (!S.me?.email) return;
  kdLoadMissed();
  try {
    const d = await api("/api/followups");
    const me = String(S.me?.email || "").trim().toLowerCase();
    KD.fus = (d.list || []).filter((f) => String(f.owner || "").trim().toLowerCase() === me);
  } catch (e) {
    KD.fus = KD.fus || [];
  }
  kdNotifyDue();
  kdBadge();
  if (KD.view === "inbox") kdRenderInbox();
}

const kdDue = (f) => new Date(f.due_at).getTime() <= Date.now();

function kdBadge() {
  const n = (KD.fus || []).filter(kdDue).length + (KD.missed || []).filter((m) => m.open).length;
  const txt = n > 99 ? "99+" : String(n);
  const nav = kdEl("kd-badge");
  if (nav) { nav.textContent = txt; nav.classList.toggle("hidden", !n); }
  const launch = kdEl("rc-launch");
  if (launch) {
    if (n) launch.dataset.count = txt; else delete launch.dataset.count;
  }
  kdDesktopState();
}

/* The desktop app's bubble (desktop/bubble.html) shows presence, the
   reminders count and a ringing / live call while the dialer is minimised;
   it learns them from here (desktop/dialer-preload.js dedupes). A no-op
   outside the desktop app. */
function kdDesktopState() {
  const send = window.kcDesktop?.state;
  if (!send) return;
  const badge = (KD.fus || []).filter(kdDue).length + (KD.missed || []).filter((m) => m.open).length;
  const call = KD.phase === "live" ? "live"
    : (KD.phase === "calling" || KD.phase === "incoming") ? "ring" : "";
  send({ registered: !!KD.registered, badge, call });
}

/* The first load only summarises — ten overdue items arriving as ten toasts
   on page open is noise. After that, each one that crosses its due time while
   the page is open gets its own. */
function kdNotifyDue() {
  const due = (KD.fus || []).filter(kdDue);
  if (!KD.fuSeen) {
    KD.fuSeen = new Set(due.map((f) => f.id));
    if (due.length) toast(`You have ${due.length} follow-up${due.length === 1 ? "" : "s"} due`, 6000);
    return;
  }
  for (const f of due) {
    if (KD.fuSeen.has(f.id)) continue;
    KD.fuSeen.add(f.id);
    toast(`Follow-up due: ${f.name || f.company || "a lead"}${f.note ? " — " + f.note : ""}`, 10000);
  }
}

function kdFuWhen(iso) {
  const d = new Date(iso), now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((day(d) - day(now)) / 86400000);
  if (d <= now) {
    const mins = Math.round((now - d) / 60000);
    if (mins < 60) return mins <= 1 ? "Due now" : `${mins} min overdue`;
    if (mins < 24 * 60) return `${Math.round(mins / 60)}h overdue`;
    return `${Math.round(mins / 1440)}d overdue`;
  }
  if (diffDays === 0) return "Today · " + time;
  if (diffDays === 1) return "Tomorrow · " + time;
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + " · " + time;
}

/* ---------------- missed calls ----------------
   Callers nobody picked up, and the voicemails they left (missed.js on the
   server logs them from RingCentral's call log). Each can be played, read,
   called back, or ticked off; one that anyone has rung back since clears
   itself. Polled with the reminders; the bell counts both. */
async function kdLoadMissed() {
  try {
    const d = await api("/api/calls/missed?days=7");
    const prevText = new Map((KD.missed || []).map((m) => [m.id, m.vm_text]));
    KD.missed = (d.list || []).map((m) => ({ ...m, vm_text: m.vm_text || prevText.get(m.id) || null }));
  } catch (e) { KD.missed = KD.missed || []; }
  kdNotifyMissed();
  kdBadge();
  if (KD.view === "inbox" && KD.itab === "missed") kdRenderInbox();
}

function kdNotifyMissed() {
  const open = (KD.missed || []).filter((m) => m.open);
  if (!KD.missedSeen) {
    KD.missedSeen = new Set((KD.missed || []).map((m) => m.id));
    if (open.length) toast(`${open.length} missed call${open.length === 1 ? "" : "s"} to call back`, 6000);
    return;
  }
  for (const m of open) {
    if (KD.missedSeen.has(m.id)) continue;
    KD.missedSeen.add(m.id);
    const who = m.lead_name || kdFmtNum(m.number || "") || "Someone";
    toast(m.voicemail ? `${who} left a voicemail` : `Missed call from ${who}`, 10000);
  }
}

function kdRenderMissed(box) {
  const list = KD.missed;
  const sum = kdEl("kd-inbox-sum");
  if (!list) { box.innerHTML = `<div class="kd-empty">Loading…</div>`; return; }
  const open = list.filter((m) => m.open), done = list.filter((m) => !m.open);
  if (sum) sum.textContent = list.length ? `${open.length} to call back · last 7 days` : "";
  if (!list.length) {
    box.innerHTML = `
      <div class="kd-allclear">
        <i>${kdSvg("M20 6L9 17l-5-5")}</i>
        <b>No missed calls</b>
        <span>When a lead rings and nobody picks up — or leaves a voicemail — it shows here, and you get a heads-up.</span>
      </div>`;
    return;
  }
  const row = (m) => {
    const name = m.lead_name || kdFmtNum(m.number || "") || "Unknown caller";
    const state = m.called_back_at
      ? `called back ${relTime(m.called_back_at)}${m.called_back_by ? " by " + m.called_back_by : ""}`
      : m.handled_at ? `done${m.handled_by ? " · " + m.handled_by : ""}` : "";
    return `
      <div class="kd-fu-row kd-miss${m.open ? " due" : " done"}" data-mrow="${m.id}">
        <div class="kd-fu-main">
          <div class="kd-ini">${esc(kdInitials(name))}</div>
          <div class="kd-lrow-t">
            <b>${esc(name)} ${m.voicemail ? `<span class="kd-vm-chip">Voicemail</span>` : ""}</b>
            <span class="kd-fu-when">${esc(relTime(m.at))}${m.lead_name && m.number ? " · " + esc(kdFmtNum(m.number)) : ""}${
              m.agent ? " · rang " + esc(m.agent) : ""}</span>
            ${state ? `<span class="kd-fu-note">${esc(state)}</span>` : ""}
            ${m.vm_text ? `<span class="kd-vm-text">“${esc(m.vm_text)}”</span>` : ""}
            <div class="kd-miss-acts">
              ${m.number ? `<button class="kd-miss-btn call" data-mcall="${m.id}">${kdSvg(KD_IC.phone)} Call back</button>` : ""}
              ${m.voicemail ? `<button class="kd-miss-btn" data-mplay="${m.id}">▶ Play</button>` : ""}
              ${m.voicemail && !m.vm_text ? `<button class="kd-miss-btn" data-mtext="${m.id}">Read it</button>` : ""}
            </div>
            <div class="kd-miss-audio" id="kd-maudio-${m.id}"></div>
          </div>
        </div>
        ${m.open ? `<button class="kd-fu-done" data-mdone="${m.id}" title="Mark done" aria-label="Mark ${esc(name)} done">
          ${kdSvg("M20 6L9 17l-5-5")}</button>` : `<button class="kd-fu-done" data-mundo="${m.id}" title="Put back" aria-label="Put ${esc(name)} back">↺</button>`}
      </div>`;
  };
  box.innerHTML = [
    open.length ? `<div class="kd-fu-group"><div class="kd-fu-label due">To call back <span>${open.length}</span></div>${open.map(row).join("")}</div>` : "",
    done.length ? `<div class="kd-fu-group"><div class="kd-fu-label">Dealt with <span>${done.length}</span></div>${done.map(row).join("")}</div>` : "",
  ].join("");
}

async function kdMissedDone(id, undo) {
  const m = (KD.missed || []).find((x) => x.id === id);
  if (!m) return;
  m.open = !!undo; m.handled_at = undo ? null : new Date().toISOString(); m.handled_by = undo ? null : S.me?.email;
  kdBadge(); kdRenderInbox();                      // optimistic: it feels instant
  try { await api(`/api/calls/missed/${id}/done`, { method: "POST", body: JSON.stringify(undo ? { undo: true } : {}) }); }
  catch (e) { kdToast("Couldn't save that — " + e.message); kdLoadMissed(); }
}

/* Ring them back from the dialler, as the lead when it is one — so the
   call is logged on the lead, and this missed call clears itself. */
function kdMissedCall(id) {
  const m = (KD.missed || []).find((x) => x.id === id);
  if (!m || !m.number) return;
  if (kdActive()) return kdToast("Finish this call first");
  if (m.lead_id) {
    KD.lead = { id: m.lead_id, name: m.lead_name || kdFmtNum(m.number), phone: m.number };
    KD.ptab = "history";
    kdLoadLead(m.lead_id);
    kdDial();
  } else {
    KD.lead = null;
    KD.number = String(m.number).replace(/[^0-9*#+]/g, "");
    kdDial(true);
  }
}

function kdMissedPlay(id) {
  const slot = kdEl("kd-maudio-" + id);
  if (!slot) return;
  if (slot.firstChild) { slot.innerHTML = ""; return; }   // pressed again: hide it
  slot.innerHTML = `<audio controls autoplay preload="none" src="/api/calls/missed/${id}/voicemail"></audio>`;
  slot.querySelector("audio").addEventListener("error", async () => {
    let why = "couldn't play it";
    try { await api(`/api/calls/missed/${id}/voicemail`); } catch (e) { why = e.message; }
    slot.innerHTML = `<span class="kd-miss-err">${esc(why)}</span>`;
  });
}

async function kdMissedText(id) {
  const m = (KD.missed || []).find((x) => x.id === id);
  if (!m) return;
  try {
    const r = await api(`/api/calls/missed/${id}/voicemail-text`);
    m.vm_text = r.text || null;
    if (!m.vm_text) kdToast("RingCentral has no transcript of this one — press Play");
  } catch (e) { kdToast("Couldn't read it — " + e.message); }
  kdRenderInbox();
}

function kdRenderInbox() {
  const box = kdEl("kd-inbox");
  if (!box) return;
  const tab = KD.itab || "reminders";
  const openMissed = (KD.missed || []).filter((m) => m.open).length;
  const dueFus = (KD.fus || []).filter(kdDue).length;
  document.querySelectorAll("[data-itab]").forEach((b) => {
    const n = b.dataset.itab === "missed" ? openMissed : dueFus;
    b.classList.toggle("on", b.dataset.itab === tab);
    b.innerHTML = (b.dataset.itab === "missed" ? "Missed calls" : "Reminders") + (n ? ` <i class="kd-itab-n">${n}</i>` : "");
  });
  if (tab === "missed") return kdRenderMissed(box);
  if (!KD.fus) { box.innerHTML = `<div class="kd-empty">Loading…</div>`; return; }

  const today = new Date(); today.setHours(23, 59, 59, 999);
  const groups = [
    ["Due now", KD.fus.filter(kdDue), "due"],
    ["Later today", KD.fus.filter((f) => !kdDue(f) && new Date(f.due_at) <= today), ""],
    ["Upcoming", KD.fus.filter((f) => new Date(f.due_at) > today), ""],
  ].filter(([, rows]) => rows.length);

  const due = groups.find(([, , k]) => k === "due")?.[1].length || 0;
  const sum = kdEl("kd-inbox-sum");
  if (sum) sum.textContent = KD.fus.length
    ? `${due ? due + " due · " : ""}${KD.fus.length} open` : "";

  if (!KD.fus.length) {
    box.innerHTML = `
      <div class="kd-allclear">
        <i>${kdSvg("M20 6L9 17l-5-5")}</i>
        <b>You're all caught up</b>
        <span>Follow-ups you set on a call land here, and you get a heads-up when one is due.</span>
      </div>`;
    return;
  }

  box.innerHTML = groups.map(([label, rows, kind]) => `
    <div class="kd-fu-group">
      <div class="kd-fu-label${kind ? " " + kind : ""}">${esc(label)} <span>${rows.length}</span></div>
      ${rows.map((f) => {
        const name = f.name || f.company || "Unnamed lead";
        return `
        <div class="kd-fu-row${kind ? " " + kind : ""}">
          <button class="kd-fu-main" data-fulead="${f.id}" title="Open ${esc(name)}">
            <div class="kd-ini">${esc(kdInitials(name))}</div>
            <div class="kd-lrow-t">
              <b>${esc(name)}</b>
              <span class="kd-fu-when">${esc(kdFuWhen(f.due_at))}</span>
              ${f.note ? `<span class="kd-fu-note">${esc(f.note)}</span>` : ""}
            </div>
          </button>
          <button class="kd-fu-done" data-fudone="${f.id}" title="Mark done" aria-label="Mark ${esc(name)} done">
            ${kdSvg("M20 6L9 17l-5-5")}</button>
        </div>`;
      }).join("")}
    </div>`).join("");
}

/* Open the follow-up's lead on the call screen, ready to dial, with its
   follow-up tab showing what the rep wrote to themselves. */
function kdOpenFollowLead(id) {
  const f = (KD.fus || []).find((x) => x.id === id);
  if (!f) return;
  KD.lead = {
    id: f.lead_id, name: f.name || f.company, company: f.company, phone: f.phone,
    status: f.status, city: f.city, state: f.state, code: f.lead_code,
  };
  KD.view = "lead"; KD.ptab = "followup";
  kdRender();
  kdLoadLead(f.lead_id);
}

async function kdFollowDone(id) {
  const keep = KD.fus;
  KD.fus = (KD.fus || []).filter((f) => f.id !== id);   // optimistic: it feels instant
  kdBadge(); kdRenderInbox();
  try {
    await api("/api/followups/" + id + "/done", { method: "POST" });
    kdToast("Marked done");
  } catch (e) {
    KD.fus = keep; kdBadge(); kdRenderInbox();
    kdToast("Could not update — " + (describeErr(e) || "unknown"));
  }
}

/* ---------------- settings ----------------

   Modelled on Zoho's dialler settings, but only the parts that do something
   here. Silent mode, Do Not Disturb and ringtone routing are absent on
   purpose: this phone places calls and does not take inbound ones yet, so
   those switches would be decoration. Chrome already applies noise
   suppression to getUserMedia audio by default, so that one is absent too.

   Audio choice is per browser (localStorage), because device ids are per
   machine — a headset id from one laptop means nothing on another. */
const KD_AUDIO_KEY = "kl_kd_audio";

function kdAudioPrefs() {
  /* ringtone: "default" is the built-in synth ring; "custom" plays the file
     the person uploaded (held in IndexedDB, see kdRingStore). ringName is
     only what the settings screen shows — the bytes never touch localStorage,
     which is too small for an audio file. */
  const base = { system: true, input: "", output: "", ringtone: "default", ringName: "" };
  try { return { ...base, ...JSON.parse(localStorage.getItem(KD_AUDIO_KEY) || "{}") }; }
  catch (e) { return base; }
}
function kdSaveAudio(p) {
  try { localStorage.setItem(KD_AUDIO_KEY, JSON.stringify(p)); } catch (e) { /* session only */ }
}

/* The custom ringtone's audio file, kept in IndexedDB rather than
   localStorage because it is a blob and can be a megabyte or two. One
   record under a fixed key: uploading replaces it, "Use default" leaves it
   but the pref stops pointing at it. All wrapped so a private window or a
   browser without IndexedDB simply falls back to the built-in ring. */
const KD_RING_DB = "kl_ringtone", KD_RING_KEY = "current";
function kdRingDB() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(KD_RING_DB, 1); }
    catch (e) { return reject(e); }
    req.onupgradeneeded = () => { req.result.createObjectStore("files"); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kdRingPut(blob) {
  const db = await kdRingDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("files", "readwrite");
    tx.objectStore("files").put(blob, KD_RING_KEY);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
async function kdRingGet() {
  const db = await kdRingDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("files", "readonly");
    const r = tx.objectStore("files").get(KD_RING_KEY);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

/* The chosen device if it is still plugged in, otherwise the system default.
   A headset unplugged since it was picked must not leave a call silent. */
async function kdPickDevice(kind) {
  const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind);
  const p = kdAudioPrefs();
  const want = p.system ? "" : (kind === "audioinput" ? p.input : p.output);
  const hit = want && list.find((d) => d.deviceId === want);
  if (hit) return hit.deviceId;
  /* Where the browser hides device ids (no persistent mic permission — the
     desktop app did, before its permission fix) every id is "". Asking the
     SDK for exactly "" fails the call with OverconstrainedError; no id means
     "the default device", which is what we want. */
  return (list.find((d) => d.deviceId === "default") || list[0])?.deviceId || undefined;
}

/* The SDK's own manager always takes the first device in the list; this one
   answers from Settings instead. A function, not a const, so rcStart can
   reach it however early voice init runs. */
function kdDeviceManager() {
  return {
    getInputDeviceId: () => kdPickDevice("audioinput"),
    getOutputDeviceId: () => kdPickDevice("audiooutput"),
  };
}

/* Mid-call switch: the rep plugs in a headset and picks it without hanging up. */
async function kdApplyAudio() {
  const s = KD.session;
  if (!s) return;
  try {
    const inId = await kdPickDevice("audioinput");
    if (inId && s.changeInputDevice) await s.changeInputDevice(inId);
    const outId = await kdPickDevice("audiooutput");
    if (outId && s.audioElement?.setSinkId && s.changeOutputDevice) await s.changeOutputDevice(outId);
  } catch (e) { kdToast("Couldn't switch the audio device"); }
}

/* Labels come back blank until the page has had microphone permission once,
   so the lists would read "Microphone 1, Microphone 2". `labeled` drives the
   "Allow access" prompt. */
let kdDevWatch = false;
async function kdLoadDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    KD.devices = {
      inputs: all.filter((d) => d.kind === "audioinput"),
      outputs: all.filter((d) => d.kind === "audiooutput"),
      labeled: all.some((d) => d.label),
    };
  } catch (e) { KD.devices = { inputs: [], outputs: [], labeled: false }; }
  if (!kdDevWatch && navigator.mediaDevices?.addEventListener) {
    kdDevWatch = true;
    navigator.mediaDevices.addEventListener("devicechange", kdLoadDevices);
  }
  if (KD.view === "settings") kdRenderSettings();
}

async function kdAskMic() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch (e) { kdToast("Microphone access was blocked — allow it in the address bar"); }
  kdLoadDevices();
}

/* Test: a short tone through the chosen speaker, then five seconds of live
   mic level, so "can they hear me" is answered before the call, not on it. */
async function kdAudioTest() {
  if (KD.testing) return;
  KD.testing = true;
  kdRenderSettings();
  let stream, ctx;
  try {
    const inId = await kdPickDevice("audioinput");
    const outId = await kdPickDevice("audiooutput");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: inId ? { deviceId: { exact: inId } } : true });
    ctx = new AudioContext();
    if (outId && ctx.setSinkId) await ctx.setSinkId(outId).catch(() => {});

    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.15, t0 + 0.05);
    gain.gain.setValueAtTime(0.15, t0 + 0.6);
    gain.gain.linearRampToValueAtTime(0, t0 + 0.7);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + 0.75);

    const an = ctx.createAnalyser();
    an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const until = performance.now() + 5000;
    await new Promise((done) => {
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        const bar = kdEl("kd-meter-bar");
        if (bar) bar.style.width = Math.min(100, (peak / 64) * 100) + "%";
        if (performance.now() < until) requestAnimationFrame(tick); else done();
      };
      tick();
    });
  } catch (e) {
    kdToast("Couldn't test audio — " + (e.message || "check the microphone permission"));
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
    ctx?.close();
    KD.testing = false;
    kdLoadDevices();          // permission may have just been granted: labels appear
  }
}

function kdSwitch(id, on, label) {
  return `<button class="kd-switch" data-set="${id}" role="switch" aria-checked="${on}"
    aria-label="${esc(label)}"><i></i></button>`;
}

function kdRenderSettings() {
  const box = kdEl("kd-settings");
  if (!box) return;
  const tab = KD.stab || "general";
  document.querySelectorAll("[data-stab]").forEach((b) => {
    b.classList.toggle("on", b.dataset.stab === tab);
    b.setAttribute("aria-pressed", String(b.dataset.stab === tab));
  });

  if (tab === "general") {
    const name = S.me?.display_name || (S.me?.email || "").split("@")[0] || "You";
    const err = VOICE.rcError && !KD.registered;
    const dark = document.documentElement.dataset.theme !== "light";
    box.innerHTML = `
      <div class="kd-prof">
        <div class="kd-avatar">${esc(kdInitials(name))}</div>
        <div class="kd-prof-t"><b>${esc(name)}</b><span>${esc(S.me?.email || "")}</span></div>
      </div>
      <div class="kd-group">
        <div class="kd-row">
          <div class="kd-row-t"><b>Phone line</b>
            <span>${err ? esc(rcFriendlyError(VOICE.rcError)[0])
              : KD.registered ? "Connected to RingCentral" : "Connecting…"}</span></div>
          ${err ? `<button class="kd-pill" data-set="retry"${VOICE.rcRetrying ? " disabled" : ""}>
                     ${VOICE.rcRetrying ? "Retrying…" : "Retry"}</button>`
            : `<span class="kd-state-pill${KD.registered ? " ok" : ""}">
                 <i></i>${KD.registered ? "Available" : "Offline"}</span>`}
        </div>
        <div class="kd-row"><div class="kd-row-t"><b>Extension</b></div>
          <span class="kd-row-v">${VOICE.rcExtension ? "x" + esc(VOICE.rcExtension) : "—"}</span></div>
        <div class="kd-row"><div class="kd-row-t"><b>Caller ID</b>
          <span>The number your calls go out as</span></div>
          <span class="kd-row-v">${KD.callerId ? esc(kdFmtNum(KD.callerId)) : "—"}</span></div>
      </div>
      ${CRMME && CRMME.enabled ? `<div class="kd-group">
        <div class="kd-row">
          <div class="kd-row-t"><b>Zoho CRM</b>
            <span>${CRMME.connected
              ? (CRMME.lastError ? "Refused — going in under the shared account"
                : "Calls and leads filed under " + esc(CRMME.name || CRMME.email || "you"))
              : "Not connected — calls go in under the shared account"}</span></div>
          ${CRMME.connected && !CRMME.lastError
            ? `<span class="kd-state-pill ok"><i></i>Connected</span>`
            : `<a class="kd-pill" href="${esc(CRMME.connectUrl)}">${CRMME.connected ? "Reconnect" : "Connect"}</a>`}
        </div>
      </div>` : ""}
      <div class="kd-group">
        <div class="kd-row">
          <div class="kd-row-t"><b>Dark mode</b><span>Same switch as the theme button up top</span></div>
          ${kdSwitch("theme", dark, "Dark mode")}
        </div>
      </div>
      <a class="kd-linkbtn" href="/api/voice/rc/connect">Reconnect RingCentral account</a>`;
    return;
  }

  if (tab === "vm") return vmRenderSettings(box);

  const p = kdAudioPrefs();
  const dv = KD.devices || { inputs: [], outputs: [], labeled: false };
  const sinkOk = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
  const opts = (list, cur, word) => list.map((d, i) =>
    `<option value="${esc(d.deviceId)}"${d.deviceId === cur ? " selected" : ""}>${
      esc(d.label || `${word} ${i + 1}`)}</option>`).join("")
    || `<option value="">No ${word.toLowerCase()} found</option>`;
  box.innerHTML = `
    <div class="kd-group">
      <div class="kd-row">
        <div class="kd-row-t"><b>Use system settings</b>
          <span>Follow the computer's default speaker and microphone. Turn off to pick your own.</span></div>
        ${kdSwitch("system", p.system, "Use system settings")}
      </div>
    </div>
    ${dv.labeled ? "" : `<button class="kd-linkbtn" data-set="perm">Allow microphone access to list devices</button>`}
    <div class="kd-field${p.system ? " off" : ""}">
      <label for="kd-out">Speaker <span>(audio output)</span></label>
      <select id="kd-out" class="kd-select"${p.system || !sinkOk ? " disabled" : ""}>
        ${opts(dv.outputs, p.output || "default", "Speaker")}</select>
      ${sinkOk ? "" : `<p class="kd-hint">This browser can't choose a speaker — calls use the system one.</p>`}
    </div>
    <div class="kd-field${p.system ? " off" : ""}">
      <label for="kd-in">Microphone <span>(audio input)</span></label>
      <select id="kd-in" class="kd-select"${p.system ? " disabled" : ""}>
        ${opts(dv.inputs, p.input || "default", "Microphone")}</select>
    </div>
    <div class="kd-meter" aria-hidden="true"><i id="kd-meter-bar"></i></div>
    <button class="kd-primary kd-test" data-set="test"${KD.testing ? " disabled" : ""}>
      ${KD.testing ? "Testing — speak now…" : "Test speaker & microphone"}</button>
    <div class="kd-group kd-ringgroup">
      <div class="kd-row">
        <div class="kd-row-t"><b>Ringtone</b>
          <span>${p.ringtone === "custom"
            ? "Playing your own: " + esc(p.ringName || "custom sound")
            : "The built-in ring"}</span></div>
      </div>
      <div class="kd-ringbtns">
        <button class="kd-linkbtn" data-set="ring-pick">Choose a sound…</button>
        <button class="kd-linkbtn" data-set="ring-preview"${KD.ringPlaying ? " disabled" : ""}>
          ${KD.ringPlaying ? "Playing…" : "Preview"}</button>
        ${p.ringtone === "custom" ? `<button class="kd-linkbtn" data-set="ring-default">Use default ring</button>` : ""}
      </div>
      <input id="kd-ring-file" type="file" accept="audio/*" hidden>
      <p class="kd-hint">An audio file from this computer (mp3, m4a, wav…), under 3&nbsp;MB. Kept on this browser only.</p>
    </div>
    <p class="kd-hint">${KD.session ? "Changes apply to this call straight away."
      : "Changes apply from your next call."}</p>`;
}

function kdSetting(which) {
  if (String(which).startsWith("vm-")) return vmSettingAction(which);
  if (which === "theme") { kdEl("theme-toggle")?.click(); return kdRenderSettings(); }
  if (which === "retry") return rcRetry().then(kdRenderSettings);
  if (which === "perm") return kdAskMic();
  if (which === "test") return kdAudioTest();
  if (which === "ring-pick") { kdEl("kd-ring-file")?.click(); return; }
  if (which === "ring-preview") return kdRingPreview();
  if (which === "ring-default") {
    const p = kdAudioPrefs();
    p.ringtone = "default"; p.ringName = "";
    kdSaveAudio(p);
    return kdRenderSettings();
  }
  if (which === "system") {
    const p = kdAudioPrefs();
    p.system = !p.system;
    kdSaveAudio(p);
    kdRenderSettings();
    kdApplyAudio();
  }
}

/* ---------------- wiring ---------------- */

function rcWireBar() {
  const root = kdEl("rc-call");
  if (!root) return;

  on("rc-launch", "click", () => rcPanelToggle());
  on("kd-close", "click", () => rcPanelToggle(false));
  // the desktop app's window controls (desktop/dialer-preload.js); no-ops elsewhere
  on("kd-win-min", "click", () => window.kcDesktop?.minimize?.());
  on("kd-win-close", "click", () => window.kcDesktop?.close?.());
  on("kd-retry", "click", () => rcRetry());
  kdWireDrag(root);

  /* One delegated listener. The panel re-renders its lists constantly, and
     per-element handlers would be re-bound (or leak) on every paint. */
  root.addEventListener("click", (e) => {
    const t = (sel) => e.target.closest(sel);
    let b;

    if ((b = t("[data-nav]"))) return kdNav(b.dataset.nav);
    if ((b = t("[data-stab]"))) { KD.stab = b.dataset.stab; if (KD.stab === "audio") kdLoadDevices(); return kdRenderSettings(); }
    if ((b = t("[data-set]"))) return kdSetting(b.dataset.set);
    if ((b = t("[data-itab]"))) { KD.itab = b.dataset.itab; if (KD.itab === "missed") kdLoadMissed(); return kdRenderInbox(); }
    if ((b = t("[data-mdone]"))) return kdMissedDone(+b.dataset.mdone);
    if ((b = t("[data-mundo]"))) return kdMissedDone(+b.dataset.mundo, true);
    if ((b = t("[data-mcall]"))) return kdMissedCall(+b.dataset.mcall);
    if ((b = t("[data-mplay]"))) return kdMissedPlay(+b.dataset.mplay);
    if ((b = t("[data-mtext]"))) return kdMissedText(+b.dataset.mtext);
    if ((b = t("[data-fudone]"))) return kdFollowDone(+b.dataset.fudone);
    if ((b = t("[data-fulead]"))) return kdOpenFollowLead(+b.dataset.fulead);
    if ((b = t("[data-tab]"))) { KD.ptab = b.dataset.tab; return kdRender(); }
    if ((b = t("[data-filter]"))) { KD.filter = b.dataset.filter; return kdRender(); }
    if ((b = t("[data-sec]"))) { KD.open[b.dataset.sec] = !KD.open[b.dataset.sec]; return kdRender(); }
    if ((b = t("[data-close]"))) return kdShow(b.dataset.close, false);
    if ((b = t("[data-k]"))) return kdKey(b.dataset.k);
    if ((b = t("[data-lead]"))) return kdPickLead(+b.dataset.lead);
    if ((b = t("[data-ctl]"))) return kdControl(b.dataset.ctl);
    if ((b = t("[data-dispo]"))) { KD.dispo = KD.dispo === b.dataset.dispo ? "" : b.dataset.dispo; return kdRenderDispos(); }
    if ((b = t("[data-menu]"))) return kdMenuPick(b.dataset.menu);
    if ((b = t("[data-ext]"))) return kdDoTransfer(b.dataset.ext);
    if (t("[data-open-wrap]")) return kdOpenWrap();
    if (t("[data-cancel-fu]")) return kdCancelFollowup();

    if (e.target.closest("#kd-return")) { KD.view = "lead"; return kdRender(); }
    if (e.target.closest("#kd-del")) {
      if (KD.phase === "live" && KD.session) return;   // can't un-send a tone mid-call
      KD.number = KD.number.slice(0, -1); return kdRender();
    }
    if (e.target.closest("#kd-go")) return kdDial(true);
    if (e.target.closest("#kd-call") || e.target.closest("#kd-again")) return kdDial();
    if (e.target.closest("#kd-end")) return kdHangup();
    if (e.target.closest("#kd-answer")) return kdAnswer();
    if (e.target.closest("#kd-decline")) return kdDecline();
    if (e.target.closest("#kd-resume")) return kdControl("hold");
    if (e.target.closest("#kd-save")) return kdSaveDispo();
    if (e.target.closest("#kd-skip")) { kdShow("kd-wrap", false); return kdAfterWrap(null); }
    /* Tapping the dimmed area behind a sheet closes it, as every sheet does. */
    if (e.target.classList.contains("kd-scrim")) return e.target.classList.add("hidden");
  });

  kdEl("kd-num")?.addEventListener("input", (e) => {
    /* On a live call the field is a tone sender, not the dial box: send the
       digits the rep just typed as DTMF and keep the field showing what has
       been sent, rather than editing the company's number. */
    if (KD.phase === "live" && KD.session) {
      const typed = e.target.value.replace(/[^0-9*#]/g, "");
      const prev = KD.dtmf || "";
      if (typed.length > prev.length && typed.startsWith(prev))
        for (const ch of typed.slice(prev.length)) kdKey(ch);   // sends each new tone
      e.target.value = (KD.dtmf || "").slice(-18);               // resync; never the dial number
      return;
    }
    KD.number = e.target.value.replace(/[^0-9*#+]/g, "").slice(0, 18);
    /* The Call button is enabled by kdRender, so without this a pasted (or
       typed) number left it greyed out until some other click repainted the
       panel. Safe under the caret: the field's digits now match KD.number,
       so kdRender leaves the field alone. */
    kdRender();
  });
  kdEl("kd-num")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !(KD.phase === "live" && KD.session)) kdDial(true);
  });
  kdEl("kd-q")?.addEventListener("input", (e) => kdRenderQueue(KD.queue, e.target.value));
  root.addEventListener("change", (e) => {
    if (e.target.id === "kd-fu-on") { KD.wantFu = e.target.checked; return kdRenderDispos(); }
    if (e.target.id === "kd-ring-file") { kdRingUpload(e.target.files?.[0]); e.target.value = ""; return; }
    if (e.target.id !== "kd-in" && e.target.id !== "kd-out") return;
    const p = kdAudioPrefs();
    p[e.target.id === "kd-in" ? "input" : "output"] = e.target.value;
    kdSaveAudio(p);
    kdApplyAudio();
  });

  /* Esc closes the top sheet, then the panel. */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || kdEl("rc-call")?.classList.contains("hidden")) return;
    for (const id of ["kd-wrap", "kd-menu"]) {
      if (!kdEl(id)?.classList.contains("hidden")) return kdShow(id, false);
    }
    rcPanelToggle(false);
  });

  /* The desktop dialer is a phone, so the keyboard dials it: digits typed
     anywhere in the window go on the number (or as touch-tones on a live
     call), Backspace deletes, Enter calls — not only after clicking into the
     number box, which reps reasonably took for "typing doesn't work". Never
     while a text box, the disposition sheet or a menu has the keys. Embed only:
     on the website the same keys belong to the dashboard. */
  document.addEventListener("keydown", (e) => {
    if (!kcEmbedded() || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (kdEl("rc-call")?.classList.contains("hidden")) return;
    if (["kd-wrap", "kd-menu"].some((id) => !kdEl(id)?.classList.contains("hidden"))) return;
    const live = KD.phase === "live" && KD.session;
    if (/^[0-9*#+]$/.test(e.key)) {
      if (!live) {
        if (kdActive() || KD.phase === "incoming") return;
        if (KD.view !== "keypad") { KD.view = "keypad"; kdRender(); }
      }
      e.preventDefault();
      kdKey(e.key);
      return;
    }
    if (live || KD.view !== "keypad") return;
    if (e.key === "Backspace") { e.preventDefault(); KD.number = KD.number.slice(0, -1); kdRender(); }
    else if (e.key === "Enter") { e.preventDefault(); kdDial(true); }
  });
  // back from the bubble: the caret is in the number box, ready to type
  window.addEventListener("focus", () => {
    if (kcEmbedded() && KD.view === "keypad" && !kdActive()) kdEl("kd-num")?.focus();
  });
}

function kdNav(which) {
  if (which === "more") return kdOpenMenu();
  if (which === "settings") { KD.view = "settings"; kdLoadDevices(); return kdRender(); }
  if (which === "inbox") { KD.view = "inbox"; kdRender(); return kdLoadFollowups(); }
  if (which === "keypad") { KD.view = kdActive() ? "lead" : "keypad"; }
  else if (which === "leads") { KD.view = "leads"; kdLoadQueue(); }
  else { KD.view = "lead"; KD.ptab = which; }
  kdRender();
  if (KD.view === "keypad") kdEl("kd-num")?.focus();
}

/* A key types when idle and sends a tone when on a call — the behaviour of
   every phone anyone has used. */
function kdKey(k) {
  /* On a live call the keypad sends touch-tones (DTMF) to the far end — for
     "press 2 for sales" menus — and never edits the number being shown. The
     digits sent are kept in KD.dtmf and mirrored into the number field so the
     rep sees what they have entered into the menu, not the company's number. */
  if (KD.phase === "live" && KD.session) {
    kdGuard(() => KD.session.sendDtmf(k), "send " + k).catch(() => {});
    KD.dtmf = ((KD.dtmf || "") + k).slice(-32);
    const sent = kdEl("kd-dtmf-sent");
    if (sent) sent.textContent = KD.dtmf.slice(-18);
    const numInput = kdEl("kd-num");
    if (numInput) numInput.value = KD.dtmf.slice(-18);
    return;
  }
  if (KD.number.length < 18) { KD.number += k; kdRender(); }
}

function kdPickLead(id) {
  const r = (KD.queue || []).find((x) => x.Id === id);
  if (!r) return;
  KD.lead = {
    id, name: r.Name, company: r.Company, phone: r.Phone, status: r.Status,
    city: r.City, state: r.State, email: r.Email, website: r.Website,
    industry: r.Industry, owner: r.Owner, code: r["Lead Code"],
  };
  KD.view = "lead"; KD.ptab = "history";
  kdRender();
  kdLoadLead(id);
}

async function kdDial(fromPad) {
  /* The keypad dials what is typed on it. KD.lead outlives the call it came
     from, so preferring its phone here rang the last lead again whatever the
     rep had just typed. It stays only when the typed number is that lead's —
     then the call is still logged against them. */
  const last10 = (s) => String(s || "").replace(/\D/g, "").slice(-10);
  if (fromPad && KD.lead && last10(KD.lead.phone) !== last10(KD.number)) KD.lead = null;
  const num = fromPad ? KD.number : KD.lead?.phone || KD.number;
  if (!num) return kdToast("Type a number first");
  if (kdActive() || KD.lookingUp) return;
  /* A typed number is often a lead's. Without the lead the call is neither
     logged (reportCall needs one) nor offered a wrap-up, so a keypad call
     left no trace and no disposition. Ask the same whois the incoming pop-up
     uses; a failed lookup still dials, just without the lead. */
  if (fromPad && !KD.lead) {
    KD.lookingUp = true;
    try {
      const l = (await api("/api/calls/whois?number=" + encodeURIComponent(num))).lead;
      if (l) {
        KD.lead = { id: l.id, name: l.name || l.company, company: l.company, phone: num,
          status: l.status, city: l.city, state: l.state, industry: l.industry, owner: l.owner };
        KD.ptab = "history";
        kdLoadLead(l.id);
      }
    } catch (e) { /* dial anyway */ }
    finally { KD.lookingUp = false; }
    if (kdActive()) return;
  }
  /* Calling hours first, on the keypad. Switching to the lead view before the
     answer showed the LAST call's "Call ended" screen — its disposition
     buttons — while the check ran, and left the rep stuck there when the hour
     was closed, as if the call had failed straight into the wrap-up. */
  KD.lookingUp = true;
  let ok = false;
  try { ok = await callHoursOk(num, KD.lead?.id || null); } finally { KD.lookingUp = false; }
  if (!ok) { KD.view = "keypad"; return kdRender(); }   // callHoursOk has said why
  if (kdActive()) return;
  const sent = kdEl("kd-dtmf-sent"); if (sent) sent.textContent = "";
  KD.view = "lead";
  /* dialNow is the same path the lead table's Call button takes once its hour
     is checked, so the call is logged and attributed identically. */
  if (!dialNow(num, KD.lead?.name || num, KD.lead?.id || null))
    kdToast("Calling is not set up on this account");
}

function kdHangup() {
  if (!KD.session) return;
  const s = KD.session;
  const ringing = KD.phase === "calling";
  /* Before the far end answers there is only an invitation: SIP withdraws it
     with CANCEL, and a BYE is refused. The SDK can throw inside cancel() on an
     early/odd session state ("reading 'match'"), so try the sensible methods
     in turn and swallow the error — the rep has still ended the call, and a
     failure must not leave a scary toast or a call stuck on "Calling". */
  (async () => {
    const order = ringing ? ["cancel", "hangup", "dispose", "terminate"]
      : ["hangup", "bye", "dispose", "terminate"];
    for (const m of order) {
      if (typeof s[m] !== "function") continue;
      try { await s[m](); return; } catch (e) { console.warn("[karma] end call (" + m + "):", e); }
    }
  })();
  /* Safety net: if the SDK never fires its end event (because it threw), the
     call would sit on "Calling" forever. After a moment, if this is still the
     session and it has not ended, return the UI to idle ourselves. A real end
     event firing first moves KD.phase off calling/live, making this a no-op;
     reportCall's own guard stops a double-log. */
  setTimeout(() => {
    if (KD.session !== s || (KD.phase !== "calling" && KD.phase !== "live")) return;
    reportCall(null, ringing ? "cancelled" : "connected");
    kdLive("ended");
    kdStopClock();
    KD.phase = "ended"; KD.session = null; KD.dialAt = KD.answerAt = null;
    KD.muted = KD.held = KD.rec = false;
    if (VOICE.rcSession === s) VOICE.rcSession = null;
    kdRender();
  }, 1500);
}

function kdControl(which) {
  const s = KD.session;
  if (!s || KD.phase !== "live") return;
  if (which === "mute") {
    KD.muted = !KD.muted;
    kdGuard(() => (KD.muted ? s.mute() : s.unmute()), KD.muted ? "mute" : "unmute")
      .catch(() => { KD.muted = !KD.muted; kdRender(); });
    return kdRender();
  }
  if (which === "hold") {
    KD.held = !KD.held;
    /* The clock is wall-clock from answer, so a hold has to bank the elapsed
       time and re-base on resume or the paused seconds reappear. */
    if (KD.held) KD.elapsed = (Date.now() - KD.started) / 1000;
    else KD.started = Date.now() - KD.elapsed * 1000;
    kdGuard(() => (KD.held ? s.hold() : s.unhold()), KD.held ? "hold" : "resume")
      .then(() => kdLive(KD.held ? "hold" : "live"))
      .catch(() => { KD.held = !KD.held; kdRender(); });
    return kdRender();
  }
  if (which === "rec") {
    const want = !KD.rec;
    /* On-demand recording is an account setting in RingCentral, not something
       the SDK can turn on. If it is off this rejects, and the message says so
       rather than leaving a button that silently does nothing. */
    /* RingCentral answers a refused request with a result code rather than
       an error, so a resolved promise is not success — code 0 is. */
    if (want) s.__kdRecStarting = true;              // block auto-record racing this
    (want ? s.startRecording() : s.stopRecording())
      .then((r) => {
        s.__kdRecStarting = false;
        if (r && r.code !== undefined && +r.code !== 0)
          throw new Error(r.description || r.message || "code " + r.code);
        s.__kdRecording = want;                      // keep the session flag in step
        KD.rec = want; kdRender();
        kdToast(want ? "Recording this call" : "Recording stopped");
      })
      .catch((e) => {
        s.__kdRecStarting = false;
        console.warn("[karma] recording:", e);
        kdToast("Couldn't " + (want ? "start" : "stop") + " recording — " + (describeErr(e)
          || "on-demand recording may be off for this RingCentral account"));
      });
    return;
  }
  if (which === "keypad") { KD.view = "keypad"; return kdRender(); }
  if (which === "vmdrop") return kdVmDrop();
  if (which === "transfer") return kdOpenTransfer();
  if (which === "more") return kdOpenMenu();
}

/* ---------------- transfer ---------------- */

async function kdOpenTransfer() {
  if (!KD.extensions) {
    try { KD.extensions = (await api("/api/voice/rc/extensions")).people || []; }
    catch (e) { KD.extensions = []; }
  }
  const box = kdEl("kd-menu-items");
  if (!KD.extensions.length) {
    box.innerHTML = `<div class="kd-empty">Nobody else on the team has connected a RingCentral seat yet.</div>`;
  } else {
    box.innerHTML = KD.extensions.map((p) =>
      `<button data-ext="${esc(p.extension)}"><i>${kdSvg(KD_IC.transfer)}</i>
        <span>${esc(p.name)}</span><span class="kd-lrow-tag">x${esc(p.extension)}</span></button>`).join("");
  }
  kdShow("kd-menu", true);
}

function kdDoTransfer(ext) {
  kdShow("kd-menu", false);
  if (!KD.session) return;
  kdGuard(() => KD.session.transfer(ext), "transfer the call")
    .then(() => kdToast("Transferred to x" + ext))
    .catch(() => {});
}

/* ---------------- the More sheet ---------------- */

function kdOpenMenu() {
  const items = [
    ["dispo", "Disposition", KD_IC.flag],
    ["note", "Add note", KD_IC.note],
    ["followup", "Schedule follow-up", KD_IC.cal],
    ["lead", "View lead", KD_IC.eye],
    ["audio", "Audio devices", KD_IC.mic],
    ["dnc", "Do not contact", KD_IC.ban, "danger"],
  ];
  kdEl("kd-menu-items").innerHTML = items.map(([k, label, icon, cls]) =>
    `<button data-menu="${k}" class="${cls || ""}"><i>${kdSvg(icon)}</i><span>${esc(label)}</span></button>`).join("");
  kdShow("kd-menu", true);
}

function kdMenuPick(k) {
  kdShow("kd-menu", false);
  if (k === "audio") { KD.view = "settings"; KD.stab = "audio"; kdLoadDevices(); return kdRender(); }
  if (!KD.lead && k !== "dispo") return kdToast("Pick a lead first");
  if (k === "dispo" || k === "note") return kdOpenWrap();
  if (k === "followup") { KD.wantFu = true; return kdOpenWrap(); }
  if (k === "lead") { KD.view = "lead"; KD.ptab = "lead"; return kdRender(); }
  if (k === "dnc") { KD.dispo = "DNC"; return kdOpenWrap(); }
}

/* ---------------- the disposition sheet ---------------- */

/* Chips that need a lead — a status, a follow-up, Do Not Contact, a Zoho
   Lead — are left off for a call to a number that is no lead's; the rest
   describe the call itself, and that call is logged against the number. */
/* A call with no lead (a hand-dialled number) gets the chips that describe
   the call, plus Prospect (saves them as a lead, then to Zoho CRM —
   /api/calls/prospect) and DNC (bans the number — /api/calls/dnc). Status and
   follow-up still need a lead to live on. */
const KD_DISPO_NO_LEAD = new Set(["outcome", "log", "prospect", "dnc"]);
/* no row in `leads` behind this call: a hand-dialled number, or an uploaded
   campaign contact (negative id) */
const kdNoLeadRow = () => !KD.lead || KD.lead.id < 0;
const kdDispoChoices = () => KD.lead ? KD_DISPOS : KD_DISPOS.filter((d) => KD_DISPO_NO_LEAD.has(d.kind));

function kdOpenWrap() {
  if (!KD.lead && !KD.number) return kdToast("This call has no lead or number to log against");
  /* The Prospect form belongs to ONE call. It used to be cleared only after a
     Prospect/DNC save, so skipping the sheet (or saving VM) left the last
     contact's name and company in it — and the next uploaded contact's
     company never replaced it, saving Beta's number as "Acme". */
  const callKey = (KD.number || "") + "|" + (KD.lead?.id ?? "");
  if (KD.crmFor !== callKey) {
    KD.crmFor = callKey;
    for (const i of ["kd-crm-first", "kd-crm-last", "kd-crm-email", "kd-crm-company"]) if (kdEl(i)) kdEl(i).value = "";
  }
  kdEl("kd-wrapsub").textContent = KD.phase === "live"
    ? "The call stays connected."
    : KD.phase === "ended" ? "Call ended · " + kdClock(KD.elapsed)
      : "Log an outcome for this lead.";
  /* Pre-select what the line already told us, so a rep who just wants to add a
     note is not also forced to re-state a fact the softphone recorded. */
  if (!KD.dispo && KD.phase === "ended" && KD.lastOutcome) {
    const m = KD_DISPOS.find((d) => d.kind === "outcome" && d.value === KD.lastOutcome);
    if (m) KD.dispo = m.label;
  }
  if (KD.followup) {
    const el = kdEl("kd-fu-at");
    if (el) el.value = new Date(KD.followup.due_at).toISOString().slice(0, 16);
  }
  kdRenderDispos();
  kdShow("kd-wrap", true);
}

/* ---------------- Zoho CRM: is it on, and creating a lead ----------------
   Checked at sign-in and every five minutes; the owner's switch lives in
   Call logs. Creating a lead is one request — the server checks the CRM for
   the number first and links instead of duplicating. */
async function crmCheck() {
  try { VOICE.crmOn = !!(await api("/api/crm/sync/on")).on; } catch (e) { VOICE.crmOn = false; }
}
function crmStart() {
  crmCheck();
  setInterval(crmCheck, 5 * 60 * 1000);
}
async function crmCreateLead(leadId, first, last, email) {
  const r = await api(`/api/leads/${leadId}/crm-lead`, { method: "POST",
    body: JSON.stringify({ first_name: first, last_name: last, email }) });
  return r.created ? `Created in Zoho CRM: ${[first, last].filter(Boolean).join(" ")}`
    : `Already in Zoho CRM (${r.module}${r.name ? ": " + r.name : ""}) — linked, not duplicated`;
}

function kdRenderDispos() {
  if (KD.dispo && !kdDispoChoices().some((d) => d.label === KD.dispo)) KD.dispo = "";
  kdEl("kd-dispos").innerHTML = kdDispoChoices().map((d) =>
    `<button data-dispo="${esc(d.label)}" aria-pressed="${KD.dispo === d.label}"${d.title ? ` title="${esc(d.title)}"` : ""}>${esc(d.label)}</button>`).join("");
  const picked = KD_DISPOS.find((d) => d.label === KD.dispo);
  /* the call-back reminder: any call to a lead, whatever the outcome */
  kdShow("kd-fu", !!KD.lead);
  const fuOn = kdEl("kd-fu-on");
  if (fuOn) fuOn.checked = !!KD.wantFu;
  kdShow("kd-fu-when", !!KD.wantFu);
  /* The prospect's name — for Prospect. On a lead's call it is only asked
     while the Zoho CRM sync is on, since that is where it goes; on a call
     with no lead it is always asked, because it becomes a lead here first
     (with a Company field, pre-filled from an uploaded list). */
  const noRow = kdNoLeadRow();
  const askName = picked?.kind === "prospect" && (noRow || !!VOICE.crmOn);
  kdShow("kd-crm", askName);
  kdShow("kd-crm-company", askName && noRow);
  const hint = kdEl("kd-crm-hint");
  if (hint) hint.textContent = noRow
    ? "Saved as a lead in Karma Connect (yours), then as a Lead in Zoho CRM with this call on it. Already a lead? It's linked, not duplicated."
    : "Saved as a Lead in Zoho CRM, with this call on it. Already there? It's linked, not duplicated.";
  const co = kdEl("kd-crm-company");
  if (askName && noRow && co && !co.value && KD.lead?.company) co.value = KD.lead.company;
  if (askName) setTimeout(() => kdEl("kd-crm-first")?.focus(), 0);
  if (KD.wantFu && !kdEl("kd-fu-at").value) {
    /* A sensible default beats an empty field: tomorrow, same hour, on the
       hour. A rep picking "call back later" means soon, not never. */
    const d = new Date(Date.now() + 864e5);
    d.setMinutes(0, 0, 0);
    kdEl("kd-fu-at").value = new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  }
}

/* Each chip writes to the ONE place that already holds that fact. Nothing is
   duplicated: the outcome chips describe the call, which reportCall has
   already logged, so they only write when the rep CONTRADICTS what the line
   reported — that correction is the new information. */
async function kdSaveDispo() {
  const L = KD.lead;
  if (!L) return kdSaveNumberDispo();
  if (L.id < 0) return kdSaveUploadDispo();   // uploaded campaign lead — no leads row to write to
  await VOICE.call?.logged;                // the call's row is what the disposition stamps
  const note = (kdEl("kd-note")?.value || "").trim();
  const picked = KD_DISPOS.find((d) => d.label === KD.dispo);
  const jobs = [];

  if (note) jobs.push(api("/api/leads/" + L.id + "/comments",
    { method: "POST", body: JSON.stringify({ body: note }) }));

  if (picked?.kind === "status" && picked.value !== L.status)
    jobs.push(patchLead(L.id, { status: picked.value }).then(() => { L.status = picked.value; }));

  if (KD.wantFu) {
    const at = kdEl("kd-fu-at")?.value;
    if (!at) return kdToast("Pick a date and time for the follow-up");
    jobs.push(api("/api/leads/" + L.id + "/followup", {
      method: "POST",
      body: JSON.stringify({ due_at: new Date(at).toISOString(), note: note || KD.dispo || "Call back" }),
    }).then((r) => { KD.followup = r.followup || { due_at: new Date(at).toISOString(), note }; }));
  }

  if (picked?.kind === "dnc") {
    if (!confirm(`Add ${L.name} to Do Not Contact?\n\nThis blocks ${kdFmtNum(L.phone)} and sweeps every lead sharing that number.`))
      return;
    jobs.push(api("/api/leads/" + L.id + "/remove",
      { method: "POST", body: JSON.stringify({ reason: "Marked Do Not Contact on a call" }) }));
  }

  /* A Prospect needs a name to become a Lead in Zoho; the email is optional. */
  let prospect = null;
  if (picked?.kind === "prospect" && VOICE.crmOn) {
    prospect = {
      first_name: (kdEl("kd-crm-first")?.value || "").trim(),
      last_name: (kdEl("kd-crm-last")?.value || "").trim(),
      email: (kdEl("kd-crm-email")?.value || "").trim(),
    };
    if (!prospect.last_name) { kdEl("kd-crm-last")?.focus(); return kdToast("Enter their last name to save the prospect"); }
    if (prospect.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(prospect.email)) {
      kdEl("kd-crm-email")?.focus(); return kdToast("That email doesn't look right");
    }
  }

  /* The disposition itself, for the log and the Dashboard. Stamped onto
     this call server-side (calls.js), which also sends the call to Zoho CRM
     right away — creating the Prospect as a Lead first, so the call lands
     on it. What the CRM said comes back in r.crm. */
  let crm = null;
  if (picked) jobs.push(api("/api/leads/" + L.id + "/disposition", {
    method: "POST", body: JSON.stringify({ disposition: picked.label, note, ...(prospect ? { prospect } : {}) }) })
    .then((r) => { crm = r.crm || null; }));

  if (picked?.kind === "outcome" && KD.lastOutcome && picked.value !== KD.lastOutcome)
    jobs.push(api("/api/leads/" + L.id + "/comments", {
      method: "POST",
      body: JSON.stringify({ body: `Call marked "${KD.dispo}" by the rep (the line reported ${KD.lastOutcome}).` }),
    }));

  if (!jobs.length) { kdShow("kd-wrap", false); kdAfterWrap(null); return kdToast("Nothing to save"); }

  try {
    await Promise.all(jobs);
    kdShow("kd-wrap", false);
    kdEl("kd-note").value = "";
    for (const i of ["kd-crm-first", "kd-crm-last", "kd-crm-email"]) if (kdEl(i)) kdEl(i).value = "";
    KD.dispo = "";
    kdToast(crm?.sent ? "Saved · sent to Zoho CRM" : "Saved");
    /* Say what happened in the CRM — and say it plainly when it didn't, so
       a rep never assumes a Lead exists that does not. */
    if (crm?.lead) toast(crm.lead.created
      ? `Lead created in Zoho CRM: ${[prospect.first_name, prospect.last_name].filter(Boolean).join(" ")}`
      : `Already in Zoho CRM (${crm.lead.module}${crm.lead.name ? ": " + crm.lead.name : ""}) — linked, not duplicated`, 6000);
    if (crm?.leadError) toast("Zoho CRM lead not created: " + crm.leadError, 9000);
    if (crm?.sendError) toast("Call saved, but Zoho CRM refused it for now — it will retry: " + crm.sendError, 9000);
    kdLoadLead(L.id);
    if (KD.wantFu) kdLoadFollowups();
    KD.wantFu = false;
    kdAfterWrap(picked || null);
  } catch (e) {
    kdToast("Could not save — " + (describeErr(e) || "unknown"));
  }
}

/* The wrap-up for a call to a number that is no lead's: the disposition and
   note go onto that call's row (POST /api/calls/disposition), which sends it
   to Zoho CRM with its Call Result. There is no lead for a note of its own. */
/* Prospect and DNC for a call with no lead row. Returns the server's answer,
   or null when the rep backed out (DNC confirm) or a field needs fixing — the
   toast has said which. Throws on a server refusal. */
async function kdNoLeadSpecial(picked, note) {
  if (picked.kind === "dnc") {
    if (!confirm(`Add ${kdFmtNum(KD.number)} to Do Not Contact?\n\nThis blocks the number and sweeps every lead sharing it.`))
      return null;
    return api("/api/calls/dnc", { method: "POST", body: JSON.stringify({ number: KD.number, note }) });
  }
  const p = {
    first_name: (kdEl("kd-crm-first")?.value || "").trim(),
    last_name: (kdEl("kd-crm-last")?.value || "").trim(),
    email: (kdEl("kd-crm-email")?.value || "").trim(),
    company: (kdEl("kd-crm-company")?.value || "").trim(),
  };
  if (!p.last_name) { kdEl("kd-crm-last")?.focus(); kdToast("Enter their last name to save the prospect"); return null; }
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) {
    kdEl("kd-crm-email")?.focus(); kdToast("That email doesn't look right"); return null;
  }
  return api("/api/calls/prospect", { method: "POST", body: JSON.stringify({ number: KD.number, note, ...p }) });
}
/* What a Prospect / DNC save says back to the rep, Zoho's part included. */
function kdNoLeadReport(picked, r) {
  for (const i of ["kd-crm-first", "kd-crm-last", "kd-crm-email", "kd-crm-company"]) if (kdEl(i)) kdEl(i).value = "";
  if (picked.kind === "dnc") {
    kdToast(r.affected ? `Do Not Contact · ${r.affected} lead${r.affected === 1 ? "" : "s"} removed` : "Do Not Contact · number blocked");
  } else {
    kdToast((r.created ? "Saved as a new lead" : `Linked to the existing lead: ${r.lead?.name || ""}`) + (r.crm?.sent ? " · sent to Zoho CRM" : ""));
    if (r.crm?.leadError) toast("The lead is saved in Karma Connect, but Zoho CRM did not create it: " + r.crm.leadError, 10000);
  }
  if (r.crm?.sendError) toast("Call saved, but Zoho CRM refused it for now — it will retry: " + r.crm.sendError, 9000);
}

async function kdSaveNumberDispo() {
  const picked = kdDispoChoices().find((d) => d.label === KD.dispo);
  if (!picked) return kdToast("Pick an outcome for this call");
  const note = (kdEl("kd-note")?.value || "").trim();
  try {
    await VOICE.call.logged;      // the row this is stamped onto
    if (picked.kind === "prospect" || picked.kind === "dnc") {
      const r = await kdNoLeadSpecial(picked, note);
      if (!r) return;
      kdShow("kd-wrap", false);
      kdEl("kd-note").value = "";
      KD.dispo = "";
      kdNoLeadReport(picked, r);
      return;
    }
    const r = await api("/api/calls/disposition", {
      method: "POST", body: JSON.stringify({ number: KD.number, disposition: picked.label, note }) });
    kdShow("kd-wrap", false);
    kdEl("kd-note").value = "";
    KD.dispo = "";
    kdToast(r?.crm?.sent ? "Saved · sent to Zoho CRM" : "Saved");
    if (r?.crm?.sendError) toast("Call saved, but Zoho CRM refused it for now — it will retry: " + r.crm.sendError, 9000);
  } catch (e) {
    kdToast("Could not save — " + (describeErr(e) || "unknown"));
  }
}

/* The disposition for an uploaded campaign lead. There is no row in `leads` to
   attach notes, status or follow-ups to (the list is kept apart on purpose), so
   this writes nowhere under /api/leads — which was the "bad lead id" error. The
   fine disposition and note are stamped onto the call row by number (for the
   call log and Zoho), and both are carried into the campaign's own record of
   the call, which campaign-upload.js saves to campaign_leads as it advances. */
async function kdSaveUploadDispo() {
  const picked = KD_DISPOS.find((d) => d.label === KD.dispo);
  const note = (kdEl("kd-note")?.value || "").trim();
  try {
    await VOICE.call?.logged;                 // the call row this stamps onto
    /* Prospect / DNC do what they do for a hand-dialled number: the contact
       becomes a lead (and a Zoho CRM Lead), or the number is banned. A refusal
       keeps the sheet open so nothing is lost; the campaign waits. */
    let special = null;
    if (picked && (picked.kind === "prospect" || picked.kind === "dnc")) {
      special = await kdNoLeadSpecial(picked, note);
      if (!special) return;
    } else if (picked) await api("/api/calls/disposition", {
      method: "POST", body: JSON.stringify({ number: KD.number, disposition: picked.label, note }) }).catch(() => {});
    // carry the disposition + note into the campaign's record of this call
    const campNote = [picked?.label, note].filter(Boolean).join(" — ");
    if (campNote && $("camp-note")) $("camp-note").value = campNote;
    kdShow("kd-wrap", false);
    if (kdEl("kd-note")) kdEl("kd-note").value = "";
    KD.dispo = "";
    if (special) kdNoLeadReport(picked, special); else kdToast("Saved");
    kdAfterWrap(picked || null);              // advance the campaign (records to campaign_leads)
  } catch (e) {
    kdToast("Could not save — " + (describeErr(e) || "unknown"));
  }
}

async function kdCancelFollowup() {
  if (!KD.lead) return;
  try {
    await api("/api/leads/" + KD.lead.id + "/followup", { method: "DELETE" });
    KD.followup = null;
    kdToast("Follow-up cancelled");
    kdRender();
    kdLoadFollowups();
  } catch (e) { kdToast("Could not cancel — " + (describeErr(e) || "unknown")); }
}

/* ---------------- the call itself ----------------

   Place a call and wire its states onto the same reportCall() the Zoho path
   uses, so a call is logged identically whichever vendor carried it. */
/* Tell the manager's Live calls board what this phone is doing. Best effort:
   a board that misses a beat is fine, a call that fails because the board
   was unreachable is not — so errors are swallowed. While a call is up it
   re-reports every 20s; the server drops a caller after ~65s of silence, so
   a closed tab clears itself. */
let kdLiveBeat = null;
function kdLive(state) {
  clearInterval(kdLiveBeat);
  kdLiveBeat = null;
  const send = (s) => api("/api/calls/live", { method: "POST", body: JSON.stringify({
    state: s, lead_id: KD.lead?.id || null, number: KD.number || "",
    dial_at: KD.dialAt ? new Date(KD.dialAt).toISOString() : null,
    answer_at: KD.answerAt ? new Date(KD.answerAt).toISOString() : null,
  }) }).catch(() => {});
  send(state);
  if (state !== "ended")
    kdLiveBeat = setInterval(() => send(KD.held ? "hold" : KD.phase === "live" ? "live" : "ringing"), 20000);
}

/* ---------------- incoming calls ----------------
   The phone rings for calls to this person's own number — in practice, a
   lead ringing back after a power-dialer campaign that showed it. The panel
   opens on who it is and why they are calling before anyone answers.

   Busy on another call, it does nothing: RingCentral keeps ringing the
   person's other phones and then voicemail, exactly as before. Declining
   sends it to voicemail rather than hanging up on a returning lead. */

/* The ring for an incoming call — made to be heard.

   It used to be nearly silent in practice: a new AudioContext was made when
   the call arrived, which the browser keeps muted unless the page was
   clicked very recently; the volume was 5%; and each burst was re-armed with
   setInterval, which a background tab runs about once a minute — one burst,
   then silence. Now one AudioContext is unlocked by the first click or key
   anywhere on the page and kept; a minute of ring pattern is scheduled on
   the audio clock up front (audio is not throttled in a background tab);
   it is louder; the tab title flashes; and a desktop notification says who
   it is, when the person has allowed them (My settings → Call alerts). */
let kdRinger = null, kdAudio = null;
function kdAudioCtx() {
  try {
    if (!kdAudio) kdAudio = new (window.AudioContext || window.webkitAudioContext)();
    if (kdAudio.state === "suspended") kdAudio.resume().catch(() => {});
    return kdAudio;
  } catch (e) { return null; }
}
for (const ev of ["pointerdown", "keydown"])
  document.addEventListener(ev, () => kdAudioCtx(), { once: true, capture: true });

/* The built-in ring: a US ring cadence synthesised on the audio clock, so a
   background tab still plays the whole minute. */
function kdSynthRing(r, seconds) {
  const ctx = kdAudioCtx();
  if (!ctx) return;
  r.out = ctx.createGain();
  r.out.gain.value = 0.25;
  r.out.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.05;
  for (let k = 0; k < Math.ceil(seconds / 3); k++) {
    for (const [start, f] of [[0, 440], [0, 480], [0.5, 440], [0.5, 480]]) {
      const o = ctx.createOscillator(), g = ctx.createGain(), a = t0 + k * 3 + start;
      o.frequency.value = f;
      g.gain.setValueAtTime(0, a);
      g.gain.linearRampToValueAtTime(1, a + 0.02);
      g.gain.setValueAtTime(1, a + 0.38);
      g.gain.linearRampToValueAtTime(0, a + 0.4);
      o.connect(g).connect(r.out);
      o.start(a); o.stop(a + 0.42);
    }
  }
}

/* The person's own ringtone, looped through their chosen speaker. Returns
   false — so the caller can fall back to the synth — when there is no file,
   or the browser refuses to play it (e.g. no user gesture yet). r.stopped is
   set if the ring was cancelled while the file was still loading. */
async function kdCustomRing(r) {
  let blob;
  try { blob = await kdRingGet(); } catch (e) { return false; }
  if (!blob || r.stopped) return !!r.stopped;        // stopped mid-load: don't also synth
  try {
    const el = new Audio(URL.createObjectURL(blob));
    el.loop = true;
    el.volume = 0.6;
    r.el = el;
    const p = kdAudioPrefs();
    if (!p.system && p.output && el.setSinkId) { try { await el.setSinkId(p.output); } catch (e) { /* default */ } }
    await el.play();
    return true;
  } catch (e) { try { r.el?.pause(); } catch (_) { /* fine */ } r.el = null; return false; }
}

function kdRing(on, seconds = 60) {
  if (kdRinger) {
    kdRinger.stopped = true;
    try { kdRinger.out?.disconnect(); } catch (e) { /* already gone */ }
    try { if (kdRinger.el) { kdRinger.el.pause(); URL.revokeObjectURL(kdRinger.el.src); } } catch (e) { /* fine */ }
    clearInterval(kdRinger.flash);
    document.title = kdRinger.title;
    try { kdRinger.note?.close(); } catch (e) { /* fine */ }
    kdRinger = null;
  }
  if (!on) return;
  const r = { title: document.title };
  kdRinger = r;
  /* A chosen ringtone plays the file; anything else (or a file that won't
     load) uses the built-in ring. */
  if (kdAudioPrefs().ringtone === "custom")
    kdCustomRing(r).then((ok) => { if (!ok && kdRinger === r) kdSynthRing(r, seconds); });
  else kdSynthRing(r, seconds);
  let alt = false;
  r.flash = setInterval(() => { alt = !alt; document.title = alt ? "📞 Incoming call" : r.title; }, 1000);
}

/* Save an uploaded ringtone and switch to it. Kept small and local: audio
   only, under 3 MB (a ring, not a song), stored on this browser. */
async function kdRingUpload(file) {
  if (!file) return;
  if (!/^audio\//.test(file.type)) return kdToast("Pick an audio file (mp3, m4a, wav…)");
  if (file.size > 3 * 1024 * 1024) return kdToast("That file is over 3 MB — pick a shorter clip");
  try {
    await kdRingPut(file);
    const p = kdAudioPrefs();
    p.ringtone = "custom"; p.ringName = String(file.name || "custom sound").slice(0, 60);
    kdSaveAudio(p);
    kdToast("Ringtone set — press Preview to hear it");
    kdRenderSettings();
  } catch (e) { kdToast("Couldn't save the ringtone on this browser"); }
}

/* Hear the current ringtone from Settings. A second press stops it. Does not
   touch the real ringer (kdRinger) or the tab title. */
let kdPreviewEl = null;
async function kdRingPreview() {
  if (KD.ringPlaying) {
    try { kdPreviewEl?.pause(); if (kdPreviewEl) URL.revokeObjectURL(kdPreviewEl.src); } catch (e) { /* fine */ }
    try { kdPreviewEl?.out?.disconnect?.(); } catch (e) { /* synth preview */ }
    kdPreviewEl = null; KD.ringPlaying = false;
    return kdRenderSettings();
  }
  const p = kdAudioPrefs();
  if (p.ringtone === "custom") {
    let blob = null;
    try { blob = await kdRingGet(); } catch (e) { /* fall through to synth */ }
    if (blob) {
      const el = new Audio(URL.createObjectURL(blob));
      el.volume = 0.6;
      if (!p.system && p.output && el.setSinkId) { try { await el.setSinkId(p.output); } catch (e) { /* default */ } }
      el.onended = () => { KD.ringPlaying = false; try { URL.revokeObjectURL(el.src); } catch (_) {} kdPreviewEl = null; if (KD.view === "settings") kdRenderSettings(); };
      kdPreviewEl = el; KD.ringPlaying = true; kdRenderSettings();
      try { await el.play(); }
      catch (e) { KD.ringPlaying = false; kdPreviewEl = null; kdToast("Couldn't play it — click the page, then try again"); kdRenderSettings(); }
      return;
    }
  }
  /* default: a few seconds of the built-in ring */
  const r = {}; kdSynthRing(r, 4);
  kdPreviewEl = r; KD.ringPlaying = true; kdRenderSettings();
  setTimeout(() => {
    if (kdPreviewEl !== r) return;
    try { r.out?.disconnect(); } catch (e) { /* fine */ }
    kdPreviewEl = null; KD.ringPlaying = false;
    if (KD.view === "settings") kdRenderSettings();
  }, 4200);
}

/* The desktop notification for a ringing call — shown even when another
   window is in front. Replaced (same tag) when the caller is identified. */
function kdNotifyCall(title, body) {
  if (!kdRinger || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    kdRinger.note?.close();
    const n = new Notification(title, { body, tag: "kd-incoming", renotify: true, requireInteraction: true,
      icon: "/leads/icon-256.png" });
    n.onclick = () => { window.focus(); rcPanelToggle(true); n.close(); };
    kdRinger.note = n;
  } catch (e) { /* notifications unavailable here */ }
}

function kdIncoming(session) {
  if (kdActive() || KD.incoming) return;
  const number = String(session.remoteNumber || "");
  KD.incoming = { session, number, info: null, at: Date.now() };
  KD.phase = "incoming";
  KD.number = number;
  KD.lead = null;
  KD.view = "lead"; KD.ptab = "history";
  rcPanelToggle(true);
  kdRing(true);
  kdNotifyCall("Incoming call", kdFmtNum(number) + " — open Karma Connect to answer");
  kdRender();
  api("/api/calls/whois?number=" + encodeURIComponent(number)).then((d) => {
    if (KD.incoming?.session !== session && KD.session !== session) return;
    if (KD.incoming) KD.incoming.info = d;
    if (d.lead) {
      const l = d.lead;
      KD.lead = { id: l.id, name: l.name || l.company, company: l.company, phone: number,
        status: l.status, city: l.city, state: l.state, industry: l.industry, owner: l.owner };
      kdLoadLead(l.id);
    }
    if (KD.incoming?.session === session) kdNotifyCall("Incoming call from " + (d.lead ? (d.lead.name || d.lead.company) : kdFmtNum(number)),
      d.last ? `Calling back — ${d.last.by} called them ${relTime(d.last.at)}` : kdFmtNum(number));
    kdRender();
  }).catch(() => { if (KD.incoming) { KD.incoming.info = { known: false, last: null }; kdRender(); } });

  /* the caller gave up, or another phone answered it */
  session.on("disposed", () => {
    if (KD.incoming?.session !== session) return;
    kdRing(false);
    const who = KD.lead?.name || kdFmtNum(number);
    KD.incoming = null;
    KD.phase = "idle";
    kdRender();
    toast(`Missed call from ${who}`, 8000);
  });
}

/* Recording is RingCentral's Automatic Call Recording now — server-side, the
   whole call, on by account setting for the rep extensions — so the app does
   NOT record calls itself.
//
   It used to fire On-Demand recording (startRecording / the *9 toggle) on every
   answer. With Automatic Call Recording ALSO on, that On-Demand toggle lands on
   a call RingCentral is already recording and PAUSES it — which is exactly why
   some recordings began and then cut out mid-call. The app stepping away from
   recording entirely removes that conflict; Automatic captures every call in
   full. Kept as a no-op so the existing call sites need no change. */
function kdAutoRecord() { /* no-op — see above; Automatic Call Recording handles it */ }

async function kdAnswer() {
  const inc = KD.incoming;
  if (!inc) return;
  kdRing(false);
  const s = inc.session;
  try { await s.answer(); }
  catch (e) { kdToast("Couldn't answer — " + (describeErr(e) || "unknown")); return; }
  KD.incoming = null;
  VOICE.call = { leadId: KD.lead?.id || null, number: inc.number, connected: true,
    seconds: 0, reported: false, direction: "inbound" };
  VOICE.rcSession = s;
  KD.session = s;
  KD.phase = "live";
  KD.dtmf = "";
  KD.muted = KD.held = KD.rec = false;
  KD.started = Date.now(); KD.elapsed = 0;
  KD.dialAt = inc.at; KD.answerAt = KD.started;
  kdStartClock();
  kdLive("live");
  kdRender();
  kdAutoRecord(s);
  const answeredAt = Date.now();
  s.on("disposed", () => {
    VOICE.call.seconds = Math.max(0, Math.round((Date.now() - answeredAt) / 1000));
    reportCall(null, "connected");
    kdLive("ended");
    KD.dialAt = KD.answerAt = null;
    kdStopClock();
    KD.lastOutcome = "connected";
    KD.phase = "ended";
    KD.session = null;
    KD.muted = KD.held = KD.rec = false;
    kdRender();
    /* A voicemail drop already opened the disposition when it was pressed, and
       may already have moved the session on — so do not pop it a second time
       here. The flag is per call; clear it for the next one. */
    if (!KD.vmDropped) { kdOpenWrap(); if (KD.lead) kdLoadLead(KD.lead.id); }
    KD.vmDropped = false;
    if (VOICE.rcSession === s) VOICE.rcSession = null;
  });
}

async function kdDecline() {
  const inc = KD.incoming;
  if (!inc) return;
  kdRing(false);
  KD.incoming = null;
  KD.phase = "idle";
  kdRender();
  try { await inc.session.toVoicemail(); }
  catch (e) { try { await inc.session.decline(); } catch (err) { /* already gone */ } }
}

async function rcCall(digits, name, leadId) {
  reportCall(null, "cancelled");          // close out anything left open
  /* A power-dialer campaign can name who callbacks go to: its calls then
     show THAT person's direct number, so a lead who rings back reaches them
     — RingCentral routes the number to its owner, nothing to configure. */
  const camp = CAMP.s?.campaign && leadId && String(CAMP.s.current?.lead?.id) === String(leadId) ? CAMP.s.campaign : null;
  const callAs = camp?.callback?.number ? camp.callback.number.replace(/\D/g, "") : undefined;
  VOICE.call = { leadId: leadId || null, number: digits,
    connected: false, seconds: 0, reported: false,
    callbackExt: camp?.callback?.ext || null, campaign: camp?.name || null };
  KD.callAs = camp?.callback?.number || null;

  /* RingCentral's call() does not return until the far end ANSWERS (or the
     call fails), and it fires "answered" just before returning. Listening
     after the await therefore missed every answer: the dialler sat on
     "calling", the in-call controls stayed disabled, a ringing call could
     not be hung up, and every call was logged as no-answer. The session is
     handed out by the phone's "outboundCall" event the moment it exists,
     before anything is sent — so everything is wired there instead. */
  let session = null;
  const started = Date.now();
  const adopt = (s) => {
    session = s;
    VOICE.rcSession = s;
    KD.session = s;
    wire(s);
  };
  const onOutbound = (s) => { VOICE.rc.off("outboundCall", onOutbound); adopt(s); };

  KD.phase = "calling";
  KD.number = digits;
  KD.muted = false; KD.held = false; KD.rec = false; KD.vmDropped = false; KD.dtmf = "";
  KD.elapsed = 0; KD.started = started;
  KD.lastOutcome = null;
  KD.view = "lead";
  /* Called from the lead table rather than from the panel: adopt that lead so
     the panel is not showing a different company from the one that is ringing. */
  if (leadId && KD.lead?.id !== leadId) {
    KD.lead = { id: leadId, name, phone: digits };
    KD.ptab = "history";
    kdLoadLead(leadId);
  } else if (!leadId) {
    KD.lead = null;
  }
  rcPanelToggle(true);
  kdStartClock();
  KD.dialAt = started; KD.answerAt = null;
  kdLive("ringing");

  const wire = (session) => {
    session.on("ringing", () => { KD.phase = "calling"; kdRender(); });
    session.on("answered", () => {
      VOICE.call.connected = true;
      KD.phase = "live";
      /* The clock restarts on answer so it reads talk time rather than time
         since dialling — the number a rep glances at mid-call is "how long have
         I had this person", not "how long ago did I press the button". */
      KD.started = Date.now(); KD.elapsed = 0;
      KD.answerAt = KD.started;
      kdLive("live");
      kdRender();
      kdToast("Connected to " + (name || kdFmtNum(digits)));
      kdAutoRecord(session);
    });
    /* A refused call fires "failed" and then "disposed"; finish runs once. */
    session.on("disposed", () => finish(VOICE.call.connected ? "connected" : "no-answer"));
    /* RingCentral says why an unanswered call ended: busy, nobody picked up
       (or the rep cancelled while it rang), or a real failure such as a bad
       number. Each is logged as what it was rather than all as "failed". */
    session.on("failed", (why) => finish(
      /486|600|busy/i.test(why) ? "busy"
        : /487|480|408|terminated|unavailable|timeout/i.test(why) ? "no-answer" : "failed"));
  };

  /* RingCentral has no timer event, so the duration is measured here. It is
     wall-clock from dial to hang-up, which includes ringing — the honest
     label for it is "call length", not "talk time". */
  let finished = false;
  const finish = (state) => {
    if (finished) return;
    finished = true;
    VOICE.call.seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
    kdVmDropCleanup();
    const logged = reportCall(null, state);
    kdLive("ended");
    KD.dialAt = KD.answerAt = null;
    KD.callAs = null;
    kdStopClock();
    KD.lastOutcome = VOICE.call.connected ? "connected" : state;
    KD.phase = "ended";
    KD.session = null;
    KD.muted = KD.held = KD.rec = false;
    kdRender();
    /* Straight into the wrap-up. A disposition asked for a minute later is a
       disposition nobody fills in, and this is the one moment the rep still
       remembers what was said. With no lead it is logged against the number. */
    /* A Call session or power-dialer campaign asks for the disposition too —
       it is what Zoho CRM gets as the Call Result. campaignCallEnded (run
       from reportCall above) has marked the session as waiting for it; the
       next lead rings once it is saved or skipped (kdAfterWrap). */
    const inSession = !!CAMP.awaitDispo;
    /* A voicemail drop is its own disposition: log "VM" straight away
       (after the call row exists, so it lands on it — and from there into
       Zoho CRM) instead of asking the rep what just happened. */
    if (KD.vmDropped && KD.lead && !inSession) {
      const L = KD.lead;
      KD.vmDropped = false;
      Promise.resolve(logged).catch(() => {}).then(() => api("/api/leads/" + L.id + "/disposition", {
        method: "POST", body: JSON.stringify({ disposition: "VM", note: "Voicemail drop left" }) }))
        .then((r) => kdToast(r?.crm?.sent ? "Voicemail left · logged and sent to Zoho CRM" : "Voicemail left · logged"))
        .catch((e) => kdToast("Voicemail left, but couldn't log it — " + (describeErr(e) || "unknown")));
      kdLoadLead(L.id);
    } else {
      // in a session a voicemail drop is offered as VM, ready to save
      if (inSession && KD.vmDropped) { KD.dispo = "VM"; KD.vmDropped = false; }
      kdOpenWrap();
      if (KD.lead) kdLoadLead(KD.lead.id);
    }
    if (VOICE.rcSession === session) VOICE.rcSession = null;
  };
  /* Exposed so a voicemail drop can free the UI for this call (log it, move
     on) WITHOUT hanging up the line — the drop keeps the call alive in the
     background to finish the message. finish() is idempotent (the later real
     disposed event is a no-op), and never touches the RTC session itself. */
  VOICE.endCall = finish;

  VOICE.rc.on("outboundCall", onOutbound);
  try {
    await VOICE.rc.call(digits, callAs);
  } catch (e) {
    if (session) finish("failed");
    else { KD.phase = "idle"; kdStopClock(); kdLive("ended"); kdRender(); }
    throw e;
  } finally {
    VOICE.rc.off("outboundCall", onOutbound);
  }
  return session;
}

async function voiceInit() {
  watchVoiceBlocks();

  /* RingCentral first: if this rep has connected their own account it wins,
     and Zoho is never loaded. */
  try {
    const rc = await api("/api/voice/rc/status");
    VOICE.rcEnabled = !!rc.enabled;
    try {
      const pv = await api("/api/voice/providers");
      VOICE.zohoOff = !!(pv.zoho && pv.zoho.off);
    } catch (e) { VOICE.zohoOff = false; }
    VOICE.rcConnected = !!rc.connected;
    VOICE.rcExtension = rc.extension || "";
    if (rc.enabled && rc.connected) {
      await rcStart();
      return;
    }
  } catch (e) {
    /* The SDK rejects with objects that have no .message, so the first
       version of this logged "RingCentral unavailable: undefined" — which
       told nobody anything, and the real cause (a CSP blocking the SIP
       socket) was only visible in the browser's own error a line above.
       describeErr serialises whatever it is given. */
    VOICE.rcError = describeErr(e) || "unknown error";
    console.warn("[karma] RingCentral unavailable:", VOICE.rcError, e);
    /* Connected but not registered: keep the launcher. Hiding it was the
       original behaviour, and to a rep the phone simply vanished — the reason
       sat in the console. The panel now opens onto the reason and a Retry. */
    if (VOICE.rcConnected) rcShowLauncher(true);
  }

  try {
    const cfg = await api("/api/voice/config");
    VOICE.mode = cfg.mode || "tel";
    VOICE.dialUrl = cfg.dialUrl || "";
    VOICE.scopeWarning = cfg.scopeWarning || "";
    if (cfg.countryCode !== undefined) VOICE.countryCode = cfg.countryCode;
    /* Zoho puts "Invalid OAuth scope" in its own red banner, which tells a
       salesperson nothing they can act on and looks like our bug. Say what
       it is once, where it will be read, and only to someone who can fix
       it — a rep cannot mint an OAuth token. */
    if (VOICE.scopeWarning && isAdmin()) console.warn("[karma] " + VOICE.scopeWarning);
  } catch (e) { VOICE.mode = "tel"; }     // config unreachable = stay on tel:
  /* Zoho's in-page softphone is retired (Oct 2026): its bundle came from an
     unpinned /latest/ URL that no integrity check could cover. "sdk" from an
     old server config hands off to Zoho's web dialler instead. */
  if (VOICE.mode === "sdk") VOICE.mode = "web";
}

/* Leads carry numbers as people wrote them — "(702) 834-3440", "702.834.3440",
   sometimes with an extension. Zoho rejects anything but digits
   ("Invalid character found in calleeNumber"), and a tel: link is happier with
   digits too, so both paths normalise first.

   A bare 10-digit number is local, and Zoho wants it in international form, so
   the configured country code is added. Anything already carrying a + is
   trusted as-is beyond stripping punctuation — it was written deliberately. */
function normalizeNumber(raw) {
  /* Drop a trailing extension first. "702 834 3440 ext 12" would otherwise
     become +702834344012 — the extension silently glued onto the number, which
     dials something that is not the lead. Zoho has no way to know. */
  const s = String(raw || "").trim()
    .replace(/\s*(?:ext\.?|extension|x|#|,)\s*\d+\s*$/i, "")
    .trim();
  if (s.startsWith("+")) return "+" + s.slice(1).replace(/\D/g, "");
  const d = s.replace(/\D/g, "");
  const cc = VOICE.countryCode || "";
  if (!cc) return d;
  if (d.length === 10) return cc + d;                    // 7028343440 -> +17028343440
  if (cc === "+1" && d.length === 11 && d[0] === "1") return "+" + d;  // already has the 1
  /* More than 11 digits with no "+" is almost always an extension typed
     without "ext": 941 234 5678 1234 is not Sri Lanka (+94). Dial the North
     American number in front when there is one (area code and exchange both
     start 2-9); a real foreign number is written with its "+". The lead's
     stored number is repaired by Manage → Assignments → Phone numbers. */
  if (cc === "+1" && d.length > 11) {
    const nanp = /^[2-9]\d{2}[2-9]\d{6}/;
    if (d[0] === "1" && nanp.test(d.slice(1))) return "+" + d.slice(0, 11);
    if (nanp.test(d)) return "+1" + d.slice(0, 10);
  }
  return d.length > 11 ? "+" + d : d;                    // long = already international
}

/* Hand the number to Zoho's own dialler in a tab, or failing that onto the
   clipboard. Used by the "web" mode and as the SDK's fallback — a softphone
   that has not finished loading must not drop the click back onto the tel:
   link, because the browser then asks Windows which application should
   handle it and the rep gets a chooser dialog instead of a call. */
function dialHandOff(number, leadId) {
  const digits = normalizeNumber(number);
  recordHandOff(digits, leadId);
  /* Always copy, whatever happens next. It costs nothing and it is the one
     thing that works in every case — including the ones below where we
     deliberately open nothing. */
  copyText(digits);

  /* A dial URL carrying {number} arrives already filled in, which is as
     close to "pasted into the dialler" as one website can get to another:
     browsers do not let us type into a page we do not own.

     This wins over everything, including a softphone that was refused,
     because a URL only exists if somebody configured it — and they chose a
     dialler this account can actually reach. It also covers tel:{number},
     which hands the call to whichever app owns tel: links on the machine.
     See ZOHO_DIAL_URL in .env.example. */
  if (VOICE.dialUrl && VOICE.dialUrl.includes("{number}")) {
    const url = VOICE.dialUrl.replace("{number}", encodeURIComponent(digits));
    /* One reused tab, not a new one per click: a rep working a list would
       otherwise end the morning with forty diallers open. A tel: URL opens
       no tab at all — the OS takes it. */
    window.open(url, /^tel:/i.test(url) ? "_self" : "zohoDialer");
    toast("Dialling " + digits + " — it is also on your clipboard", 5000);
    return true;
  }

  /* No placeholder, so opening it would land them on a page they still have
     to paste into — and when the softphone was refused, on a page that
     refuses them outright. Hand over the number instead. */
  if (VOICE.mode === "copy" || !VOICE.dialUrl) {
    toast(digits + " copied — dial it on your phone or the Zoho app", 6000);
    return true;
  }

  window.open(VOICE.dialUrl, "zohoDialer");
  toast(digits + " copied — paste it into the dialler (Ctrl+V)");
  return true;
}

/* Handing off means we never learn how the call went — the conversation
   happens somewhere we don't own. Record the attempt as 'placed' so the
   manager's report still shows who is working the list; it deliberately
   does NOT count as connected. */
function recordHandOff(digits, leadId) {
  if (!leadId) return;
  VOICE.call = { leadId, number: digits, connected: false, seconds: 0, reported: false };
  reportCall(null, "placed");
}

/* Handles the click. Returns true when it dealt with the number, which is the
   caller's signal to stop the tel: link.

   Only the explicit "tel" mode ever returns false. Every other mode handles
   the click itself even when its preferred route is unavailable, because
   falling through to tel: on a desktop opens the OS application chooser —
   a dialog the rep has to dismiss, with no call at the end of it.

   Never throws at a click handler. */
/* Calling hours for EVERY call, not only the power dialer's: 8am-9pm in the
   called person's own time (server/calltime.js, asked through
   /api/calltime). Before this, a number pressed by hand was never checked,
   and a rep rang someone at 5am.

   So dialInPage only asks, and dialNow places the call once the answer is
   yes. It answers "handled" straight away, as it always has; the one mode
   that used to answer "not handled" (tel — the OS dials) is given its tel:
   link once the hour checks out. If the check cannot be made, nothing is
   dialled: the call can wait a minute, a call at the wrong hour cannot be
   taken back. */
function dialInPage(number, name, leadId) {
  callHoursOk(number, leadId).then((ok) => {
    if (ok) {
      if (!dialNow(number, name, leadId)) window.location.href = "tel:" + normalizeNumber(number);
      return;
    }
    // a power-dialer lead whose hour has just closed: the server moves it on
    const cur = CAMP.s?.current?.lead;
    if (cur && leadId && String(cur.id) === String(leadId)) {
      cancelAutoDial();
      loadCampaign();
    }
  });
  return true;
}

const hourWord = (h) => (h % 12 || 12) + (h < 12 || h === 24 ? "am" : "pm");
async function callHoursOk(number, leadId) {
  const say = (msg) => { toast(msg, 9000); kdToast(msg, 9000); };
  let ct;
  try {
    ct = await api("/api/calltime?phone=" + encodeURIComponent(normalizeNumber(number))
      + (leadId ? "&leadId=" + encodeURIComponent(leadId) : ""));
  } catch (e) {
    say("Could not check the time where this number is — not dialled, try again in a moment");
    return false;
  }
  if (ct.open) return true;
  const [o, c] = ct.hours || [8, 21];
  const at = ct.opensAt ? new Date(ct.opensAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  say(`Not dialled — it is ${ct.local} ${ct.zone} time there. Calls are allowed ${hourWord(o)}–${hourWord(c)}`
    + ` their time${at ? `; you can call from ${at} your time` : ""}.`);
  return false;
}

function dialNow(number, name, leadId) {
  if (VOICE.mode === "tel") return false;            // deliberately the OS's job

  /* RingCentral, where this rep has connected their own seat. Checked before
     the Zoho branch because both report mode "sdk". */
  if (VOICE.provider === "ringcentral" && VOICE.rc && VOICE.ready) {
    const digits = normalizeNumber(number);
    /* No softphoneToggle here: that reveals Zohos widget, and RingCentrals
       SDK is headless. The call bar below is our own. */
    rcCall(digits, name, leadId).catch((e) => {
      console.warn("[karma] RingCentral could not dial:", e.message);
      reportCall(null, "failed");
      /* A seat that has lost its grant should say so rather than silently
         falling back to copy-and-paste, because signing in again fixes it. */
      toast(/428|connect/i.test(e.message)
        ? "Your RingCentral sign-in has expired — reconnect it in Call report"
        : "Could not dial: " + e.message, 9000);
      dialHandOff(number, leadId);
    });
    return true;
  }

  if (VOICE.mode === "sdk") {
    if (VOICE.sdk && VOICE.ready) {
      try {
        const digits = normalizeNumber(number);
        /* A previous call that never emitted an end state would otherwise
           block this one from ever being reported. Close it out first. */
        reportCall(null, "cancelled");
        VOICE.call = { leadId: leadId || null, number: digits,
          connected: false, seconds: 0, reported: false };
        softphoneToggle(true);            // you are about to need it
      VOICE.sdk.makeCall({ number: digits, name: name || undefined });
        toast("Calling " + (name || number) + "…");
        return true;
      } catch (e) {
        console.warn("[karma] could not dial:", e.message);
        reportCall(null, "failed");     // don't leave the attempt open
        return dialHandOff(number, leadId);
      }
    }
    /* Still loading, or the token never arrived. voiceInit() already said so
       on screen; here we just get the rep their number. */
    console.warn("[karma] softphone not ready — handing the number off instead");
    return dialHandOff(number, leadId);
  }

  return dialHandOff(number, leadId);                // "web", and anything new
}

/* Clipboard with a fallback: the async API needs a secure context and a
   permission the browser may refuse, and failing to copy must not stop the
   dialler opening. */
function copyText(text) {
  /* writeText REJECTS, it does not throw — a try/catch around it catches
     nothing and the rejection escapes as an uncaught error while the
     fallback below never runs. That is the case this function exists for:
     the permission is refused, or the page is not a secure context. So
     catch the promise and fall through from inside it. */
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
      return;
    }
  } catch (e) { /* fall through */ }
  legacyCopy(text);
}

function legacyCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:absolute;left:-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  } catch (e) { /* the number is still on screen to read */ }
}

/* ---------------- assignments board (admin) ----------------

   Read-only on the way in: GET /api/assignments is one aggregate pass.
   On the way out it uses the SAME /api/bulk/assign the selection toolbar uses,
   so the owner change is logged once, skips no-ops and invalidates the counts
   cache exactly as it does everywhere else. No second write path. */

// one list call caps at 200, and bulk assign caps at 500; 200 keeps a
// distribute to a single round trip, which keeps it atomic from the user's
// point of view
const ASSIGN_MAX = 200;

async function loadAssignments() {
  const el = $("assign-body");
  if (!el) return;
  el.innerHTML = `<p class="act-empty">Counting the board…</p>`;
  try {
    renderAssignments(await api("/api/assignments"));
  } catch (e) {
    el.innerHTML = `<p class="act-empty">Could not load assignments (${esc(e.message)})</p>`;
  }
}

function renderAssignments(d) {
  const el = $("assign-body");
  const people = d.people || [];
  const pool = d.unassigned || { total: 0, ready: 0, enrich: 0 };
  // bars are relative to the biggest pile, so the shape of the distribution
  // reads at a glance rather than the absolute numbers fighting each other
  const peak = Math.max(1, ...people.map((p) => p.total));
  const assignable = people.filter((p) => p.team);

  const options = assignable.map((p) =>
    `<option value="${esc(p.value)}">${esc(p.label)}</option>`).join("");

  el.innerHTML = `
    ${d.demo ? `<div class="asg-demo">Demo mode — held in memory, nothing
      here touches the real base, and assigning really works so the board can be
      tried out. ${d.demoSource
        ? `Leads loaded from <b>${esc(d.demoSource)}</b>; the team is invented.`
        : "The team and the leads are both invented."}</div>` : ""}
    <div class="act-card asg-pool">
      <h4>Unassigned</h4>
      <div class="asg-pool-row">
        <div class="asg-pool-n">
          <b>${pool.total.toLocaleString()}</b>
          <span>lead${pool.total === 1 ? "" : "s"} with no owner</span>
          <div class="asg-pool-sub">${pool.ready.toLocaleString()} ready to work ·
            ${pool.enrich.toLocaleString()} need enrichment</div>
        </div>
        ${assignable.length && pool.total ? `
        <form class="asg-give" id="asg-give">
          <label>Give
            <input id="asg-n" type="number" min="1" max="${Math.min(ASSIGN_MAX, pool.total)}"
                   value="${Math.min(25, pool.total)}" inputmode="numeric">
          </label>
          <label>to
            <select id="asg-who">${options}</select>
          </label>
          <label class="asg-ready-only">
            <input id="asg-ready" type="checkbox" checked>
            ready to work only
          </label>
          <button class="btn-primary" type="submit" id="asg-go">Assign</button>
        </form>` : ""}
      </div>
      ${!assignable.length ? `<p class="act-empty">No team accounts yet — add
        people under Manage team before assigning.</p>` : ""}
      <div id="asg-msg" class="asg-msg hidden"></div>
    </div>

    <div id="phone-check"></div>

    <div class="act-card">
      <h4>Workload — ${d.totals.assigned.toLocaleString()} of
        ${d.totals.leads.toLocaleString()} leads assigned across
        ${d.totals.members} ${d.totals.members === 1 ? "person" : "people"}</h4>
      <table class="asg-table">
        <thead><tr>
          <th>Person</th><th class="n">Total</th><th class="n">Ready</th>
          <th class="n">Worked</th><th class="n">Needs info</th><th>Share</th><th></th>
        </tr></thead>
        <tbody>
          ${people.map((p) => `
            <tr${p.team ? "" : ' class="asg-ghost"'}>
              <td>
                <span class="avatar avatar-sm" style="background:${avColor(p.value)}">${esc(initials(p.label))}</span>
                <span class="asg-name">${esc(p.label)}</span>
                ${p.team ? "" : `<span class="asg-tag" title="Not a team account — an owner string from an import or someone who has left">no account</span>`}
              </td>
              <td class="n"><b>${p.total.toLocaleString()}</b></td>
              <td class="n">${p.ready.toLocaleString()}</td>
              <td class="n">${p.worked.toLocaleString()}</td>
              <td class="n">${p.enrich.toLocaleString()}</td>
              <td class="asg-bar-cell">
                <span class="asg-bar" style="width:${Math.round((p.total / peak) * 100)}%"></span>
              </td>
              <td class="asg-act">${p.total ? `<button type="button" class="btn-ghost asg-un"
                data-asg-un="${esc(p.value)}">Unassign</button>` : ""}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      ${people.some((p) => !p.team) ? `<p class="asg-foot">Rows marked
        <b>no account</b> hold leads under an owner name that is nobody's
        account — an old import, or someone who has left. Unassign them to put
        them back in the pool, or reassign them from the list using the owner filter.</p>` : ""}
    </div>`;

  $("asg-give")?.addEventListener("submit", (e) => {
    e.preventDefault();
    distribute(pool.total);
  });
  loadPhoneCheck();
  el.querySelectorAll("[data-asg-un]").forEach((b) => b.addEventListener("click", () => {
    const p = people.find((x) => x.value === b.dataset.asgUn);
    if (p) openUnassignPerson(p);
  }));
}

/* Phone numbers with extension digits glued on — dialled as international
   (941 234 5678 1234 rang Sri Lanka). Shown only when there is something to
   fix; the server recomputes every change, and moves the extra digits into
   the lead's notes (phonefix.js). */
async function loadPhoneCheck() {
  const el = $("phone-check");
  if (!el) return;
  let c;
  try { c = await api("/api/phones/check"); } catch (e) { el.innerHTML = ""; return; }
  if (!c.fixable && !c.unreadable) { el.innerHTML = ""; return; }
  const row = (f) => `<tr><td>${esc(f.name || "")}</td><td class="ph-from">${esc(f.from)}</td>
    <td>${f.to ? `${esc(f.to)} <span class="dash-mute">· ext ${esc(f.ext)} to notes</span>` : `<span class="dash-mute">can't be read — fix by hand</span>`}</td></tr>`;
  el.innerHTML = `<div class="act-card ph-card">
    <h4>Phone numbers</h4>
    <p class="ph-sum">${c.fixable ? `<b>${c.fixable.toLocaleString()}</b> number${c.fixable === 1 ? " has" : "s have"} extra digits on the end,
      so the dialler reads ${c.fixable === 1 ? "it" : "them"} as international and the call fails.
      Fixing keeps the real number and moves the extra digits into the lead's notes.` : ""}
      ${c.dnc ? ` <b>${c.dnc}</b> of the fixed numbers ${c.dnc === 1 ? "is" : "are"} on the DNC list and will be removed, as an import would.` : ""}
      ${c.unreadable ? ` <span class="dash-mute">${c.unreadable.toLocaleString()} more can't be read automatically (too short, or no area code) — listed below to fix by hand.</span>` : ""}</p>
    <details class="ph-list"><summary>See them</summary>
      <table class="asg-table"><thead><tr><th>Lead</th><th>Now</th><th>After</th></tr></thead>
        <tbody>${c.fixes.map(row).join("")}${c.bad.map(row).join("")}</tbody></table>
      ${c.fixable > c.fixes.length || c.unreadable > c.bad.length ? `<p class="asg-foot">Showing the first ${c.fixes.length + c.bad.length}.</p>` : ""}
    </details>
    ${c.fixable ? `<button type="button" class="btn-primary" id="ph-fix">Fix ${c.fixable.toLocaleString()} number${c.fixable === 1 ? "" : "s"}</button>` : ""}
    <div id="ph-msg" class="asg-msg hidden"></div>
  </div>`;
  $("ph-fix")?.addEventListener("click", async (e) => {
    const b = e.currentTarget, msg = $("ph-msg");
    b.disabled = true; b.textContent = "Fixing…";
    try {
      const r = await api("/api/phones/fix", { method: "POST", body: "{}" });
      toast(`${r.fixed.toLocaleString()} phone number${r.fixed === 1 ? "" : "s"} fixed${r.removed ? ` · ${r.removed} on the DNC list removed` : ""}`, 6000);
      runCounts();
      loadPhoneCheck();
    } catch (ex) {
      msg.textContent = "Couldn't fix them: " + ex.message; msg.classList.remove("hidden"); msg.classList.add("bad");
      b.disabled = false; b.textContent = "Try again";
    }
  });
}

/* Unassign one person's leads back to the pool: the ones not yet worked
   (still New), or all of them. POST /api/assignments/unassign does it in one
   statement with one log row, whatever the count. */
function openUnassignPerson(p) {
  const unworked = Math.max(0, p.total - p.worked);
  $("modal-title").textContent = `Unassign leads — ${p.label}`;
  $("modal-body").innerHTML = `
    <p class="modal-sub">The leads go back to <b>Unassigned</b>, off ${esc(p.label)}'s list, ready to give to someone else
      or to use in a power-dialer campaign. Nothing else about them changes.</p>
    <form id="asg-un-form" class="pd-form">
      <label class="pd-choice"><input type="radio" name="asg-un" value="unworked" ${unworked ? "checked" : "disabled"}>
        <span><b>Not yet worked</b> · ${unworked.toLocaleString()} lead${unworked === 1 ? "" : "s"} still New</span></label>
      <label class="pd-choice"><input type="radio" name="asg-un" value="all" ${unworked ? "" : "checked"}>
        <span><b>All their leads</b> · ${p.total.toLocaleString()}, including the ${p.worked.toLocaleString()} already worked</span></label>
      <div id="asg-un-err" class="login-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
        <button type="submit" class="btn-primary" id="asg-un-go">Unassign</button>
      </div>
    </form>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  $("asg-un-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("asg-un-go"), err = $("asg-un-err");
    btn.disabled = true; btn.textContent = "Unassigning…";
    try {
      const which = document.querySelector('input[name="asg-un"]:checked').value;
      const r = await api("/api/assignments/unassign", { method: "POST", body: JSON.stringify({ owner: p.value, which }) });
      closeModal();
      toast(`${r.unassigned.toLocaleString()} lead${r.unassigned === 1 ? "" : "s"} unassigned from ${p.label}`, 5000);
      await loadAssignments();
      runCounts();                    // the Unassigned tile just changed
    } catch (ex) {
      err.textContent = ex.message; err.classList.remove("hidden");
      btn.disabled = false; btn.textContent = "Unassign";
    }
  });
}

/* Take the next N unassigned leads and hand them over. Two existing endpoints,
   no new ones: the list decides WHICH leads (same filters, same ordering the
   manager would see on screen), bulk assign does the write. */
async function distribute(poolTotal) {
  const btn = $("asg-go"), msg = $("asg-msg");
  const who = $("asg-who");
  const owner = who.value;
  const label = who.options[who.selectedIndex]?.text || owner;
  const readyOnly = $("asg-ready")?.checked;
  let n = Math.floor(+$("asg-n").value || 0);
  n = Math.max(1, Math.min(n, ASSIGN_MAX, poolTotal));

  const say = (text, bad) => {
    msg.textContent = text;
    msg.classList.remove("hidden");
    msg.classList.toggle("bad", !!bad);
  };

  btn.disabled = true;
  say("Finding leads…");
  try {
    /* The server picks the leads, using the same FOCUS predicates the KPI
       tiles count — "unassigned" alone, or combined with "ready" to mean work
       that is both unclaimed and actually callable today. Handing someone 50
       leads with no phone number is not giving them work. */
    const p = new URLSearchParams({
      focus: readyOnly ? "unassigned,ready" : "unassigned",
      limit: String(n), sort: "recent",
    });
    const found = await api("/api/leads?" + p.toString());
    const rows = found.rows || found.list || [];
    const ids = rows.map((r) => r.Id ?? r.id).filter(Boolean).slice(0, n);
    if (!ids.length) { say("No matching unassigned leads left.", true); return; }

    say(`Assigning ${ids.length}…`);
    const out = await api("/api/bulk/assign", {
      method: "POST",
      body: JSON.stringify({ ids, owner }),
    });
    const zoho = out.skippedInZoho ? ` (${out.skippedInZoho} skipped — registered in Zoho)` : "";
    say(`${out.affected} lead${out.affected === 1 ? "" : "s"} assigned to ${label}.${zoho}`);
    toast(`${out.affected} assigned to ${label}${zoho}`);
    await loadAssignments();
    runCounts();                      // the Unassigned tile just changed
  } catch (e) {
    say("Could not assign: " + e.message, true);
  } finally {
    if ($("asg-go")) $("asg-go").disabled = false;
  }
}

/* ---------------- Follow back ----------------
   A reminder on a lead: pick a date and time, get an email when it falls
   due, and find the lead waiting at the top of My tasks.

   The picker is a native datetime-local, and what is sent is an absolute
   instant (toISOString), never the wall-clock string — "3pm" has to mean
   3pm where the rep is, not 3pm on a server in Virginia. */

/* Quick offsets, because almost every follow-up is one of these and nobody
   wants to operate a calendar to say "tomorrow morning". */
const FOLLOW_PRESETS = [
  { label: "Tomorrow 9am", days: 1, hour: 9 },
  { label: "In 3 days", days: 3, hour: 9 },
  { label: "Next week", days: 7, hour: 9 },
];

function presetDate(p) {
  const d = new Date();
  d.setDate(d.getDate() + p.days);
  d.setHours(p.hour, 0, 0, 0);
  return d;
}

/* datetime-local wants local wall-clock with no zone, so the offset has to
   come off before slicing — toISOString() alone would show a rep in Tulsa a
   time five hours out. */
function toLocalInput(d) {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

async function loadFollowup(r) {
  const el = $("fu-state");
  if (!el) return;
  try {
    const { followup } = await api(`/api/leads/${r.Id}/followup`);
    renderFollowupState(r, followup);
  } catch (e) { el.textContent = ""; }
}

function renderFollowupState(r, f) {
  const el = $("fu-state");
  const btn = $("fu-btn");
  if (!el) return;
  if (!f) {
    el.innerHTML = "";
    if (btn) btn.textContent = "⏰ Follow back";
    return;
  }
  const when = new Date(f.due_at);
  const overdue = when.getTime() < Date.now();
  if (btn) btn.textContent = "⏰ Change";
  el.innerHTML = `<span class="fu-chip${overdue ? " overdue" : ""}">
      ${overdue ? "Was due" : "Follow back"} ${esc(fmtWhen(when))}
      ${f.note ? `· ${esc(f.note)}` : ""}
    </span>
    <button type="button" class="fu-clear" id="fu-clear" title="Cancel this reminder">✕</button>`;
  $("fu-clear")?.addEventListener("click", async () => {
    try {
      await api(`/api/leads/${r.Id}/followup`, { method: "DELETE" });
      renderFollowupState(r, null);
      toast("Reminder cancelled");
    } catch (e) { toast("Could not cancel: " + e.message); }
  });
}

function fmtWhen(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86400000);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (diff === 0) return "today " + time;
  if (diff === 1) return "tomorrow " + time;
  if (diff === -1) return "yesterday " + time;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + time;
}

function openFollowupModal(r) {
  const name = displayName(r, r._t);
  $("modal-title").textContent = "Follow back";
  $("modal-body").innerHTML = `<form id="fu-form">
    <p class="modal-note">An email lands in your inbox at the time you pick, with
      ${esc(name)}'s number and your note. It also sits at the top of My tasks.</p>
    <div class="fu-presets">
      ${FOLLOW_PRESETS.map((p, i) =>
        `<button type="button" class="btn-ghost fu-preset" data-pi="${i}">${esc(p.label)}</button>`).join("")}
    </div>
    <label class="fu-label">When
      <input type="datetime-local" id="fu-when" value="${toLocalInput(presetDate(FOLLOW_PRESETS[0]))}" required>
    </label>
    <label class="fu-label">Note to yourself (optional)
      <input id="fu-note" maxlength="500" placeholder="Ring back about the winter crew">
    </label>
    <div id="fu-err" class="login-error hidden"></div>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
      <button type="submit" class="btn-primary" id="fu-save">Set reminder</button>
    </div>
  </form>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  $("modal-body").querySelectorAll(".fu-preset").forEach((b) =>
    b.addEventListener("click", () => {
      $("fu-when").value = toLocalInput(presetDate(FOLLOW_PRESETS[+b.dataset.pi]));
    }));

  $("fu-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("fu-err"), save = $("fu-save");
    const raw = $("fu-when").value;
    if (!raw) return;
    err.classList.add("hidden");
    save.disabled = true;
    try {
      const { followup } = await api(`/api/leads/${r.Id}/followup`, {
        method: "POST",
        // an absolute instant, so the server never has to guess the zone
        body: JSON.stringify({ due_at: new Date(raw).toISOString(), note: $("fu-note").value }),
      });
      closeModal();
      renderFollowupState(r, followup);
      toast("Reminder set for " + fmtWhen(new Date(followup.due_at)));
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove("hidden");
      save.disabled = false;
    }
  });
}

/* ---------------- hanging up moves it on ----------------
   The softphone is the only thing that knows a call ended and whether
   anyone answered. So the hang-up is what advances a hands-free session —
   pressing an outcome afterwards was the manual step this was supposed to
   remove.

   It does not advance the instant the line drops: the disposition sheet
   opens and the session waits for it, because the disposition is what
   Zoho CRM records as the call's result. Saving or skipping it moves on
   (kdAfterWrap); the outcome buttons on the card stay live as well. */

/* The SDK's verdict, mapped to what a session records. The SDK knows
   whether the line connected; it cannot know that the person said no,
   which is why the rep can still override. */
function wrapOutcomeOf(sdkOutcome) {
  if (sdkOutcome === "connected") return { outcome: "connected", status: "Contacted", label: "Connected" };
  if (sdkOutcome === "busy") return { outcome: "busy", status: "", label: "Busy" };
  return { outcome: "no-answer", status: "Contacted", label: "No answer" };
}

/* Called from reportCall when the softphone says the call is over. */
function campaignCallEnded(leadId, sdkOutcome) {
  const d = CAMP.s;
  if (!d || !d.current || CAMP.busy) return;
  // only for the lead this session is actually on
  if (String(d.current.lead.id) !== String(leadId)) return;

  /* No more logging by itself after a few seconds: that recorded only
     "Connected" or "No answer", so a campaign call reached Zoho CRM with no
     Call Result. The disposition sheet opens (rcCall's finish) and the
     session waits for it; kdAfterWrap moves it on. */
  cancelAutoDial();
  const w = CAMP.awaitDispo = { leadId, sdkOutcome };
  const el = $("camp-auto-state");
  if (el) el.textContent = "call ended — pick a disposition; the next lead rings once it's saved";
  /* A RingCentral call that ends normally opens the sheet itself (rcCall's
     finish, straight after this). Every other ending — a call that failed
     to connect, a Zoho Voice call, a number handed off or copied — opens
     nothing, and the session would wait for a sheet that never comes. */
  setTimeout(() => { if (CAMP.awaitDispo === w && kdEl("kd-wrap")?.classList.contains("hidden")) campOpenWrap(); }, 250);
  campPaintLive();
}

/* Open the disposition sheet on the session's current lead — for an ending
   that did not open it, and for the bar's Disposition button after the rep
   closed it. */
function campOpenWrap() {
  const cur = CAMP.s?.current?.lead;
  if (!cur || kdActive()) return;
  if (String(KD.lead?.id) !== String(cur.id))
    KD.lead = { id: cur.id, name: cur.name || cur.company, company: cur.company, phone: cur.phone, status: cur.status };
  KD.number = String(cur.phone || "").replace(/[^0-9*#+]/g, "");
  rcPanelToggle(true);
  kdOpenWrap();
}

/* The disposition sheet was saved (picked) or skipped (null) for a session
   call: record the session's outcome — VM, No Answer and Busy say what it
   was; anything else keeps what the line reported — and move on, which
   rings the next lead when auto-dial is on. */
function kdAfterWrap(picked) {
  const w = CAMP.awaitDispo;
  if (!w) return;
  CAMP.awaitDispo = null;
  const line = wrapOutcomeOf(w.sdkOutcome);
  const said = { "No Answer": "no-answer", Busy: "busy", VM: "voicemail" }[picked?.label];
  submitOutcome({ outcome: said || line.outcome, status: said === "busy" ? "" : line.status });
}

function cancelWrap(reason) {
  if (CAMP.wrapTimer) { clearInterval(CAMP.wrapTimer); CAMP.wrapTimer = null; }
  CAMP.wrap = 0;
  const bar = $("camp-auto");
  if (bar) bar.classList.remove("wrapping");
  const el = $("camp-auto-state");
  if (el && reason) el.textContent = reason;
}

/* ---------------- auto-dial ----------------
   With this on, recording an outcome starts a countdown and then rings the
   next lead by itself. The rep says what happened and keeps talking; nobody
   goes looking for a button.

   Three things it will not do, each for a reason that is not taste:

   It never rings the FIRST lead of a session on its own. A browser hands a
   microphone to a call the user asked for, not to one a script started, so
   the first call has to be a real click — and that click is what buys the
   permission every later call reuses.

   It only runs with the in-page softphone. In hand-off mode a "call" is a
   new browser tab, and a loop that opens one every few seconds is a
   runaway, not a dialler.

   It always counts down in the open, with a visible Pause. The gap is the
   only moment a rep can stop the next stranger being rung — write the note,
   take a breath, look at who is next. Zero seconds would not be a feature. */

const AUTO_GAP_DEFAULT = 6;          // seconds between hanging up and the next ring

/* In a manager's power-dialer campaign the manager decides: auto-dial is on
   exactly while the campaign is "ongoing", at the gap they set, whatever the
   rep's own switch says. Outside a campaign it is the rep's switch. */
const campOf = () => CAMP.s?.campaign || null;
const autoOn = () => {
  const c = campOf();
  if (c) return c.status === "ongoing";
  try { return !!localStorage.getItem("kl_camp_auto"); } catch (e) { return false; }
};
const setAutoOn = (v) => { try { localStorage.setItem("kl_camp_auto", v ? "1" : ""); } catch (e) { /* fine */ } };
const autoGap = () => {
  const c = campOf();
  if (c?.gap) return Math.max(2, Math.min(60, c.gap));
  const n = +(localStorage.getItem("kl_camp_gap") || AUTO_GAP_DEFAULT);
  return Number.isFinite(n) ? Math.max(2, Math.min(60, n)) : AUTO_GAP_DEFAULT;
};

/* Can it actually dial without a person? Says why not, so the switch can
   explain itself instead of silently doing nothing. */
function autoReady() {
  if (VOICE.provider === "ringcentral")
    return VOICE.ready
      ? { ok: true, why: "" }
      : { ok: false, why: "the RingCentral phone has not registered yet" };
  /* Not connected, but it could be — point at the fix rather than at the
     limitation, since connecting is something the rep can do themselves. */
  if (VOICE.rcEnabled && !VOICE.rcConnected)
    return { ok: false, why: "connect your RingCentral account to dial from here" };
  if (VOICE.mode !== "sdk") return { ok: false, why: "needs the in-page softphone — right now numbers open in Zoho's dialler" };
  if (!VOICE.ready) return { ok: false, why: "the softphone has not connected yet" };
  return { ok: true, why: "" };
}

/* One tick a second for the countdown — from tick-worker.js where the
   browser allows it, because a page timer in a background tab is slowed to
   about once a minute. Returns the function that stops it. */
let CAMP_WORKER;
function campTicker(fn) {
  if (CAMP_WORKER === undefined) {
    try { CAMP_WORKER = new Worker("tick-worker.js"); } catch (e) { CAMP_WORKER = null; }
  }
  if (CAMP_WORKER) {
    CAMP_WORKER.onmessage = fn;
    CAMP_WORKER.postMessage("start");
    return () => { CAMP_WORKER.onmessage = null; CAMP_WORKER.postMessage("stop"); };
  }
  const id = setInterval(fn, 1000);
  return () => clearInterval(id);
}

function cancelAutoDial(reason) {
  const was = !!CAMP.timer;
  if (CAMP.timer) { CAMP.timer(); CAMP.timer = null; }
  CAMP.countdown = 0;
  CAMP.nextDial = null;
  const el = $("camp-auto-state");
  if (el && reason) el.textContent = reason;
  if (was) campPaintLive();
}

/* "Call now": skip the rest of the countdown and ring the next lead straight
   away. The wait is there so a rep can gather themselves, but it is theirs to
   skip — nobody should have to watch a timer when they are ready. Same
   dialInPage path as the countdown, so the call is logged identically. */
function campSkipWait() {
  const next = CAMP.nextDial;
  if (!CAMP.timer || !next) return;
  cancelAutoDial();
  const placed = dialInPage(next.phone, next.name, next.id);
  const el = $("camp-auto-state");
  if (el) el.textContent = placed ? "calling " + next.name + "…" : "could not dial — call it by hand";
  if (!placed) setAutoOn(false);
}

/* Start the countdown to the current lead. Called after an outcome, never
   on the first render of a session. */
function armAutoDial(r, name) {
  const ready = autoReady();
  if (!autoOn() || !ready.ok) return;
  /* The one line is still busy leaving a voicemail: hold the next lead until
     it finishes (the VM-drop's onended fires this again when the line frees),
     so we never ring a stranger over the voicemail still playing. */
  if (VM.drop) {
    CAMP.vmPendingArm = { r, name };
    const el = $("camp-auto-state");
    if (el) el.textContent = "leaving your voicemail — the next lead rings when it finishes";
    return;
  }
  cancelAutoDial();
  /* The lead the countdown will ring, so "Call now" can ring it immediately
     without waiting out the gap. */
  CAMP.nextDial = { phone: r.Phone, name, id: r.Id };
  CAMP.countdown = autoGap();
  const dueAt = Date.now() + CAMP.countdown * 1000;
  const paint = () => {
    const el = $("camp-auto-state");
    if (el) el.textContent = `calling ${name} in ${CAMP.countdown}s`;
    pdRunPaint();
  };
  paint();
  CAMP.timer = campTicker(() => {
    CAMP.countdown = Math.max(0, Math.ceil((dueAt - Date.now()) / 1000));
    if (CAMP.countdown > 0) return paint();
    cancelAutoDial();
    const el = $("camp-auto-state");
    /* dialInPage is the same path the button uses, so the call is logged
       and attributed exactly as a manual one is. */
    const placed = dialInPage(r.Phone, name, r.Id);
    if (el) el.textContent = placed ? "calling " + name + "…" : "could not dial — call it by hand";
    if (!placed) setAutoOn(false);       // stop rather than fail silently each time
    pdRunPaint();
  });
  campPaintLive();                         // the bar offers Pause while it counts
}

/* The bar's one action (Start calling / Pause / Resume) — wired on its own,
   because campPaintLive swaps it as the phone moves on. */
function wireCampAction(r, name) {
  /* The rep's one real click: it rings the first lead, and that gesture is
     what lets every later call in the campaign start on its own. */
  $("pd-join")?.addEventListener("click", () => {
    CAMP.joined = true;
    const placed = dialInPage(r.Phone, name, r.Id);
    if (!placed) { CAMP.joined = false; toast("Couldn't place the call — check the phone connection", 6000); }
    renderCampaign(CAMP.s);
  });
  $("camp-auto-pause")?.addEventListener("click", () => {
    cancelWrap();
    cancelAutoDial("paused — press the number when you are ready");
    campPaintLive();
  });
  $("camp-callnow")?.addEventListener("click", campSkipWait);
  $("pd-pause")?.addEventListener("click", () => campPause(false));
  $("pd-resume")?.addEventListener("click", () => campPause(true));
  $("cs-dispo")?.addEventListener("click", campOpenWrap);
}

function wireAutoDial(r, name) {
  wireCampAction(r, name);
  $("camp-auto")?.addEventListener("change", (e) => {
    setAutoOn(e.target.checked);
    cancelAutoDial();
    renderCampaign(CAMP.s);            // repaint the strip, do not start a call
  });
  $("camp-gap")?.addEventListener("change", (e) => {
    try { localStorage.setItem("kl_camp_gap", String(e.target.value)); } catch (err) { /* fine */ }
  });
}

/* A break in a manager's campaign, taken by whoever is dialling it. It is
   the campaign's own pause (POST /api/campaign/pause), so the manager's list
   shows it and who took it; only the manager can end the campaign. */
function campPausedText(c) {
  const mine = c.pausedBy && S.me?.email && c.pausedBy.toLowerCase() === S.me.email.toLowerCase();
  return mine ? "paused — you're on a break; press Resume when you're back"
    : `paused by ${c.pausedBy || "your manager"} — finish this call; nothing else will ring`;
}

async function campPause(resume) {
  const c = campOf();
  if (!c) return;
  if (!resume) { cancelWrap(); cancelAutoDial("pausing…"); }
  try {
    await api("/api/campaign/pause", { method: "POST", body: JSON.stringify({ resume }) });
  } catch (e) { return toast("Couldn't " + (resume ? "resume" : "pause") + " — " + e.message, 6000); }
  c.status = resume ? "ongoing" : "paused";
  c.pausedBy = resume ? null : S.me?.email || null;
  campPaintLive();
  if (PDR.last) Object.assign(PDR.last, { status: c.status, pausedBy: c.pausedBy });
  toast(resume ? "Resumed — the next lead rings by itself" : "Campaign paused — nothing else will ring", 4000);
  if (kdActive() || CAMP.busy || CAMP.awaitDispo) {
    const st = $("camp-auto-state");
    if (st) st.textContent = resume ? "resumed — the next lead rings after this call" : campPausedText(c);
    return;
  }
  const note = $("camp-note")?.value || "";
  /* resumed after Join: carry straight on to the next lead, as a manager's
     Resume does */
  CAMP.advanced = resume && CAMP.joined;
  renderCampaign(CAMP.s);
  if ($("camp-note")) $("camp-note").value = note;
}

/* ---------------- Call session ----------------
   One lead at a time, its number ready, and an outcome that records the
   call, sets the status, books a follow-back and moves on in one press.

   The screen deliberately holds everything needed to make the call and
   nothing else. A rep on a dialler is not browsing — they are reading a
   name, a number and one line of context, then talking. */

let CAMP = { s: null, busy: false, timer: null, countdown: 0, advanced: false,
  wrapTimer: null, wrap: 0, joined: false };

const CAMP_OUTCOMES = [
  { key: "connected", label: "Connected", status: "Contacted", tone: "good" },
  { key: "no-answer", label: "No answer", status: "Contacted" },
  { key: "busy", label: "Busy", status: "" },
  { key: "voicemail", label: "Left voicemail", status: "Contacted" },
];

async function loadCampaign() {
  const el = $("camp-body");
  if (!el) return;
  el.innerHTML = `<p class="act-empty">Loading…</p>`;
  try {
    const d = await api("/api/campaign/current");
    CAMP.s = d.session === null ? null : d;
    if (!CAMP.s || !CAMP.s.id) return renderCampStart();
    renderCampaign(CAMP.s);
  } catch (e) {
    el.innerHTML = `<p class="act-empty">Could not load the session (${esc(e.message)})</p>`;
  }
}

/* The start screen: whose list, how many are callable. */
async function renderCampStart(preOwner) {
  const el = $("camp-body");
  $("camp-pane")?.classList.remove("cs-mode");
  const admin = isAdmin();
  let owners = [];
  if (admin) {
    try { owners = (await api("/api/owners")).list || []; } catch (e) { /* own list only */ }
  }
  const who = preOwner || S.me?.email || "";
  el.innerHTML = `
    <div class="act-card camp-start">
      <h4>Start a calling session</h4>
      <p class="rc-how">Works through the leads assigned to someone — those with a phone
        number and an open status — oldest-neglected first. One lead at a time: dial,
        record what happened, and it moves on. Your place is kept if you stop.</p>
      <div class="camp-startrow">
        ${admin && owners.length ? `<label class="fu-label">Whose list
          <select id="camp-owner">
            ${owners.map((o) => `<option value="${esc(o.value)}"${o.value === who ? " selected" : ""}>${esc(o.label)}</option>`).join("")}
          </select></label>`
        : `<p class="rs-text">Your own assigned leads.</p>`}
        <div id="camp-count" class="camp-count"></div>
      </div>
      <div class="toprow" style="margin-top:14px">
        <button class="btn-primary" id="camp-go">Start calling</button>
      </div>
      <div id="camp-err" class="login-error hidden"></div>
    </div>`;

  const count = async () => {
    const o = $("camp-owner") ? $("camp-owner").value : "";
    try {
      const p = await api("/api/campaign/preview" + (o ? "?owner=" + encodeURIComponent(o) : ""));
      $("camp-count").innerHTML = p.callable
        ? `<b>${p.callable.toLocaleString()}</b> callable${p.callable > p.max ? ` — this session will take the first ${p.max}` : ""}`
        : `<span class="camp-none">Nothing callable — they need leads with a phone number and an open status.</span>`;
      $("camp-go").disabled = !p.callable;
    } catch (e) { $("camp-count").textContent = ""; }
  };
  $("camp-owner")?.addEventListener("change", count);
  count();

  $("camp-go").addEventListener("click", async () => {
    const btn = $("camp-go");
    btn.disabled = true; btn.textContent = "Building the list…";
    try {
      const o = $("camp-owner") ? $("camp-owner").value : undefined;
      CAMP.s = await api("/api/campaign/start", {
        method: "POST", body: JSON.stringify(o ? { owner: o } : {}) });
      renderCampaign(CAMP.s);
    } catch (e) {
      const err = $("camp-err");
      err.textContent = e.message; err.classList.remove("hidden");
      btn.disabled = false; btn.textContent = "Start calling";
    }
  });
}

/* ---------------- the Call session screen ----------------
   One lead at a time, in the power-dialer layout: a header (whose list,
   assigned by whom, the caller ID), then one card — a bar with the state,
   the progress and the one action that matters now; the lead, its number
   and its clock; the opener and what they do; and the manual log for a
   call made some other way.

   The state follows the phone as it happens (campPaintLive, called from the
   dialler's own render): Ready → Calling → Connected → the disposition →
   Ready, or Paused. Every control keeps the id the session logic already
   drives (camp-auto-state, pd-join, pd-pause, pd-resume, camp-skip, …), so
   pausing, resuming, joining, the countdown and the wrap-up behave exactly
   as before. */
const CS_LOOK = {
  ready:     { label: "Ready",       eyebrow: "Up next",      cls: "ready" },
  waiting:   { label: "Not started", eyebrow: "Up next",      cls: "idle" },
  calling:   { label: "Calling",     eyebrow: "Calling now",  cls: "calling" },
  connected: { label: "Connected",   eyebrow: "On call",      cls: "live" },
  wrapup:    { label: "Wrap-up",     eyebrow: "Just called",  cls: "live" },
  hours:     { label: "Waiting",     eyebrow: "Up next",      cls: "idle" },
  paused:    { label: "Paused",      eyebrow: "Current lead", cls: "idle" },
  off:       { label: "Manual",      eyebrow: "Current lead", cls: "idle" },
};

function campPhase(d) {
  const c = d?.campaign;
  if (kdActive()) return KD.phase === "live" ? "connected" : "calling";
  if (c?.status === "paused") return "paused";
  if (c?.status === "draft") return "waiting";
  if (CAMP.awaitDispo) return "wrapup";
  if (d?.current?.callTime?.waiting) return "hours";
  if (!c && !(autoOn() && autoReady().ok)) return "off";
  return "ready";
}

const CS_IC = {
  phone: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`,
  copy: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  play: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4l14 8-14 8z"/></svg>`,
  pause: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>`,
  next: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
};

/* The one action for the state the session is in. */
function campAction(d, phase) {
  const c = d.campaign, ready = autoReady();
  if (CAMP.awaitDispo && !kdActive())
    return `<button type="button" class="cs-btn cs-primary" id="cs-dispo" title="Pick what happened on this call">${CS_IC.play}<span>Disposition</span></button>`;
  if (c) {
    if (c.status === "paused") return `<button type="button" class="cs-btn cs-primary" id="pd-resume">${CS_IC.play}<span>Resume</span></button>`;
    if (c.status === "draft") return "";
    if (c.status === "ongoing" && ready.ok && !CAMP.joined && !kdActive())
      return `<button type="button" class="cs-btn cs-primary" id="pd-join">${CS_IC.play}<span>Start calling</span></button>`;
    if (c.status === "ongoing")
      return campSkipBtn() + `<button type="button" class="cs-btn cs-dark" id="pd-pause" title="Take a break: nothing else rings until you resume">${CS_IC.pause}<span>Pause</span></button>`;
    return "";
  }
  if (phase === "calling" || phase === "connected") return "";
  if (CAMP.timer) return campSkipBtn() + `<button type="button" class="cs-btn cs-dark" id="camp-auto-pause">${CS_IC.pause}<span>Pause</span></button>`;
  return "";
}

/* The "Call now" button, shown only while the between-call countdown runs. */
function campSkipBtn() {
  return CAMP.timer
    ? `<button type="button" class="cs-btn cs-primary" id="camp-callnow" title="Skip the wait and call the next lead now">${CS_IC.play}<span>Call now</span></button>`
    : "";
}

/* What the state line in the bar says when nothing more specific is
   running (countdowns and the wrap-up write their own text into it). */
function campStateText(d) {
  const c = d.campaign, ready = autoReady();
  if (!ready.ok) return ready.why;
  if (c) {
    if (c.status === "paused") return campPausedText(c);
    if (c.status === "draft") return "waiting for your manager to start it";
    if (CAMP.awaitDispo) return "call ended — pick a disposition; the next lead rings once it's saved";
    if (!CAMP.joined && !kdActive()) return "press Start calling — after that each lead rings by itself";
    return `on — after each call and its disposition, the next lead rings in ${autoGap()}s`;
  }
  if (CAMP.awaitDispo) return "call ended — pick a disposition";
  return autoOn() ? "auto-dial on — after each call, the next lead rings by itself" : "auto-dial off — press the number to call";
}

/* The progress bar: one segment per lead for a short list (as designed),
   a single bar for a long one — a 50,000-lead campaign is not 50,000 ticks. */
function campProgress(d) {
  const total = Math.max(0, d.total), pos = Math.min(d.pos, total);
  const label = `<div class="cs-prog-t"><b>${dashN(Math.min(pos + 1, total))} / ${dashN(total)} leads</b> · ${dashN(d.called)} called · ${dashN(d.connected)} connected${d.skipped ? ` · ${dashN(d.skipped)} skipped` : ""}</div>`;
  if (total <= 24) return `${label}<div class="cs-segs" style="grid-template-columns:repeat(${total || 1},minmax(0,1fr))" aria-hidden="true">${
    Array.from({ length: total || 1 }, (_, i) => `<span class="${i < pos ? "done" : i === pos ? "now" : ""}"></span>`).join("")}</div>`;
  return `${label}<div class="cs-bar" aria-hidden="true"><i style="width:${total ? Math.round((pos / total) * 100) : 0}%"></i></div>`;
}

function renderCampaign(d) {
  const el = $("camp-body");
  $("camp-pane")?.classList.add("cs-mode");
  if (d.done || !d.current) return renderCampDone(d);

  const r = fromApi(d.current.lead);
  const name = displayName(r, r._t);
  const b = d.current.brief;
  const opener = (b && (b.congratulations?.[0] || b.talkingPoints?.[0])) || "";
  const about = b && (b.whatTheyDo || b.headline);
  const c = d.campaign;
  const phase = campPhase(d);
  const look = CS_LOOK[phase];
  /* A rep cannot end a campaign their manager assigned — they can leave the
     screen, and it is waiting where they left it. */
  const canEnd = !c || isAdmin();
  const ct = d.current.callTime;
  const meta = [[r.City, r.State].filter(Boolean).join(", "), r.Industry ? titleCase(r.Industry) : "",
    r.Employees ? r.Employees.toLocaleString() + " employees" : "",
    ct?.local ? `${ct.local} ${ct.zone}` : ""].filter(Boolean);
  const last = d.current.lastCall;
  const callerId = c?.callback?.name
    ? `<span class="cs-cid-k">Caller ID</span><span><b>${esc(c.callback.name)}</b> · callbacks ring ${esc(String(c.callback.name).split(" ")[0])}</span>`
    : KD.callerId ? `<span class="cs-cid-k">Caller ID</span><span><b>${esc(kdFmtNum(KD.callerId))}</b> · your own number</span>` : "";

  el.innerHTML = `<div class="cs-wrap">
    <div class="cs-head">
      <div class="cs-titles">
        <h1>Call session</h1>
        <div class="cs-sub">${c
          ? `<b>${esc(c.name)}</b> · assigned by ${esc(c.createdBy || "your manager")}`
          : `<b>${d.owner && d.owner !== S.me?.email ? esc(d.owner) + "'s list" : "Your list"}</b> · ${dashN(d.total)} leads, oldest-untouched first`}</div>
      </div>
      <div class="cs-headr">
        ${callerId ? `<div class="cs-cid">${callerId}</div>` : ""}
        <button type="button" class="cs-btn cs-quiet" id="camp-end" title="${canEnd ? "End this session" : "Leave — the campaign waits where you left it"}">${canEnd ? "Stop" : "Leave"}</button>
      </div>
    </div>

    <section class="cs-card${phase === "wrapup" ? " wrapping" : ""}" id="cs-card" aria-label="Power dialer">
      <div class="cs-bar-top">
        <div class="cs-brand"><span class="cs-brand-ic">${CS_IC.phone}</span><span>${c ? "Power dialer" : "Call session"}</span></div>
        <div class="cs-pill ${look.cls}" id="cs-pill" role="status"><i class="${phase === "calling" ? "cs-pulse" : ""}"></i><span>${look.label}</span></div>
        <span class="cs-spacer"></span>
        ${!c ? `<label class="cs-auto" title="Ring the next lead by itself after each call">
            <input type="checkbox" id="camp-auto" ${autoOn() && autoReady().ok ? "checked" : ""} ${autoReady().ok ? "" : "disabled"}>
            <span>Auto-dial</span></label>
          <label class="cs-gap" title="Seconds between calls">gap <input type="number" id="camp-gap" min="2" max="60" value="${autoGap()}"> s</label>` : ""}
        <div class="cs-prog">${campProgress(d)}</div>
        <span id="cs-act">${campAction(d, phase)}</span>
        <button type="button" class="cs-btn cs-ghost camp-skip" id="camp-skip" title="Leave it untouched and move on"><span>Skip</span>${CS_IC.next}</button>
      </div>
      <div class="cs-status"><span id="camp-auto-state" class="camp-auto-state cs-msg">${esc(campStateText(d))}</span></div>
      ${VOICE.mode === "copy" ? `<div class="cs-warn">No in-page phone on this Zoho account — numbers are copied for you; log each call below.</div>`
        : VOICE.scopeWarning ? `<div class="cs-warn">${esc(VOICE.scopeWarning)}</div>` : ""}

      <div class="cs-lead">
        <div class="cs-eyebrow" id="cs-eyebrow">${look.eyebrow}</div>
        <h2>${esc(name)}</h2>
        <div class="cs-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join(`<span aria-hidden="true">·</span>`)}${
          ct && !ct.open && ct.local ? `<span class="cs-closed" title="Calls are allowed 8am–9pm in the lead's local time">outside calling hours</span>` : ""}${
          ct?.deferred ? `<span class="cs-moved">${ct.deferred} lead${ct.deferred === 1 ? "" : "s"} it's too early or late for moved to later</span>` : ""}</div>
        <div class="cs-phone-row">
          <div class="cs-phone">
            <span class="cs-phone-ic">${CS_IC.phone}</span>
            <a class="dial camp-dial cs-num" href="tel:${esc(r.Phone)}" data-dial="${esc(r.Phone)}"
               data-dial-id="${esc(r.Id)}" data-dial-name="${esc(name)}" title="Call ${esc(name)}">${esc(dashPhone(r.Phone) || r.Phone || "")}</a>
            <button type="button" class="cs-btn cs-icon" data-cs-copy="${esc(r.Phone || "")}" aria-label="Copy phone number">${CS_IC.copy}</button>
          </div>
          ${last ? `<div class="cs-last"><span class="cs-out ${esc(last.to_value || "")}"><i></i>${esc(OUTCOME_WORDS[last.to_value] || last.to_value || "Called")}</span>
            <span>Last called ${esc(relTime(last.at))} · ${esc(String(last.actor || "").split("@")[0])}</span></div>`
            : `<div class="cs-last"><span class="cs-out"><i></i>Not called yet</span></div>`}
        </div>
      </div>

      ${(() => {
        /* The note that came in on the uploaded spreadsheet, and the AI's
           one-line read of it — the first thing a rep should see for an
           uploaded campaign. (Empty for an ordinary lead-base campaign.) */
        const sum = d.current.sheetSummary, raw = d.current.sheetNote;
        if (!sum && !raw) return "";
        return `<div class="cs-sheet">
          <div class="cs-k"><span>From the sheet</span></div>
          ${sum ? `<p class="cs-sheet-sum">${esc(sum)}</p>` : ""}
          ${raw ? `<p class="cs-sheet-note">${esc(raw)}</p>` : ""}
        </div>`;
      })()}
      ${opener || about || d.current.notes.length ? `<div class="cs-info">
        ${opener ? `<div class="cs-opener">
          <div class="cs-k"><span>Opener</span>
            <button type="button" class="cs-btn cs-mini" data-cs-copy="${esc(opener)}">${CS_IC.copy}<span>Copy</span></button></div>
          <p>“${esc(opener)}”</p>
        </div>` : ""}
        <div class="cs-about">
          ${about ? `<div class="cs-k"><span>About</span></div><p>${esc(about)}</p>${b?.size ? `<div class="cs-dim">${esc(b.size)}</div>` : ""}` : ""}
          ${d.current.notes.length ? `<div class="cs-k cs-k2"><span>Recent notes</span></div>
            ${d.current.notes.map((n) => `<p class="cs-note">${esc(n.body)} <i>— ${esc(String(n.author_email).split("@")[0])}</i></p>`).join("")}` : ""}
        </div>
      </div>` : ""}

      <details class="cs-log"${VOICE.mode === "copy" || !autoReady().ok ? " open" : ""}>
        <summary>Log this call yourself <span>— only for a call made some other way; the disposition after each call does it for you</span></summary>
        <div class="cs-log-b">
          <div class="cs-outs">
            ${CAMP_OUTCOMES.map((o) => `<button type="button" class="cs-btn cs-chip camp-out${o.tone ? " " + o.tone : ""}"
              data-out="${o.key}" data-status="${o.status}">${o.label}</button>`).join("")}
            <button type="button" class="cs-btn cs-chip camp-out" data-out="not-interested" data-status="Not interested">Not interested</button>
          </div>
          <textarea id="camp-note" class="cs-note-in" rows="2" placeholder="What happened? (saved as a note on the lead)"></textarea>
          <label class="cs-follow"><input type="checkbox" id="camp-fu"> Remind me to follow back
            <input type="datetime-local" id="camp-fu-when" disabled></label>
          ${VOICE.crmOn ? `<details class="camp-crm">
            <summary>＋ Add to Zoho CRM as a lead</summary>
            <div class="camp-crm-row">
              <input id="camp-crm-first" placeholder="First name" autocomplete="off" aria-label="First name">
              <input id="camp-crm-last" placeholder="Last name" autocomplete="off" aria-label="Last name">
              <input id="camp-crm-email" type="email" placeholder="Email (optional)" autocomplete="off" aria-label="Email">
            </div>
          </details>` : ""}
        </div>
      </details>
    </section>
  </div>`;

  const fu = $("camp-fu"), fuWhen = $("camp-fu-when");
  fu.addEventListener("change", () => {
    fuWhen.disabled = !fu.checked;
    if (fu.checked && !fuWhen.value) fuWhen.value = toLocalInput(presetDate(FOLLOW_PRESETS[0]));
  });
  el.querySelectorAll(".camp-out").forEach((btn) =>
    btn.addEventListener("click", () => submitOutcome({
      outcome: btn.dataset.out === "not-interested" ? "connected" : btn.dataset.out,
      status: btn.dataset.status,
    })));
  $("camp-skip").addEventListener("click", () => submitOutcome({ skip: true }));
  $("camp-end").addEventListener("click", () => {
    if (canEnd) return endCampaign();
    cancelAutoDial(); cancelWrap();
    CAMP.joined = false;
    setTab("tasks");
  });
  el.querySelectorAll("[data-cs-copy]").forEach((btn) => btn.addEventListener("click", () => {
    copyText(btn.dataset.csCopy);
    toast("Copied", 1500);
  }));
  $("cs-act").dataset.html = campAction(d, phase);
  CAMP.lastPhase = phase;
  wireAutoDial(r, name);
  /* Registered in Zoho since the campaign was built (the 10-minute scan): the
     builder leaves Zoho leads out, but one can turn up mid-campaign. Nothing
     rings until the rep has seen it and chosen — skip it, or call anyway. */
  if (d.current.zoho && CAMP.zohoOk !== String(r.Id)) {
    const keep = CAMP.advanced;
    CAMP.advanced = false;
    cancelAutoDial("already registered in Zoho — skip it or call anyway");
    return campZohoWarn(d.current.zoho, name, r.Phone,
      () => { CAMP.zohoOk = String(r.Id); CAMP.advanced = keep; renderCampaign(CAMP.s); },
      () => { CAMP.zohoOk = ""; submitOutcome({ skip: true }); });
  }
  /* Nobody in reach can be called yet (calling hours): hold auto-dial and
     look again when the soonest lead's 8am comes round. */
  if (d.current.callTime?.waiting) return holdForHours(d.current.callTime);
  /* Only after an outcome, never on the first paint of a session — the
     opening call has to be a real click so the browser grants the
     microphone, and every later call reuses that permission. */
  if (CAMP.advanced) armAutoDial(r, name);
  CAMP.advanced = false;
}

/* "Already registered in Zoho" — a pop-up over whatever screen the rep is on
   (the power dialer keeps running in the background). Skip is the default:
   the lead is being worked in Zoho. */
function campZohoWarn(kind, name, phone, onCall, onSkip) {
  $("modal-title").textContent = "Already registered in Zoho";
  $("modal-body").innerHTML = `
    <p class="modal-sub"><b>${esc(name)}</b>${phone ? ` · ${esc(kdFmtNum(phone))}` : ""} ${kind === "lead"
      ? "is a <b>Lead in Zoho CRM</b>" : "is in <b>Zoho CRM's call history</b>"} — someone may already be working them.</p>
    <p class="modal-sub">Nothing will ring until you choose.</p>
    <div class="modal-actions">
      <button class="btn-ghost" id="zw-call">Call anyway</button>
      <button class="btn-primary" id="zw-skip">Skip this lead</button>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  $("zw-skip").focus();
  $("zw-skip").addEventListener("click", () => { closeModal(); onSkip(); });
  $("zw-call").addEventListener("click", () => { closeModal(); onCall(); });
  toast(`${name} is already registered in Zoho`, 6000);
}

/* The phone moved on (ringing, answered, ended): keep the card's state,
   eyebrow and action in step without repainting the lead — a note being
   typed must survive a call connecting. Called from kdRender. */
function campPaintLive() {
  pdRunPaint();                            // the bar on other screens follows the phone too
  if (S.tab !== "camp" || !$("cs-card")) return;
  const d = CAMP.s;
  if (!d?.current) return;
  const phase = campPhase(d), look = CS_LOOK[phase];
  const pill = $("cs-pill");
  if (pill && (pill.textContent.trim() !== look.label || !pill.classList.contains(look.cls))) {
    pill.className = "cs-pill " + look.cls;
    pill.innerHTML = `<i class="${phase === "calling" ? "cs-pulse" : ""}"></i><span>${look.label}</span>`;
  }
  const eb = $("cs-eyebrow");
  if (eb) eb.textContent = look.eyebrow;
  $("cs-card").classList.toggle("wrapping", phase === "wrapup");
  const act = $("cs-act"), html = campAction(d, phase);
  if (act && act.dataset.html !== html) {
    act.dataset.html = html;
    act.innerHTML = html;
    const r = fromApi(d.current.lead);
    wireCampAction(r, displayName(r, r._t));
  }
  /* The state line says what the phone is doing — once per change, so a
     countdown or a calling-hours message written meanwhile is left alone. */
  if (phase !== CAMP.lastPhase) {
    CAMP.lastPhase = phase;
    const st = $("camp-auto-state");
    if (st && !CAMP.timer) st.textContent =
      phase === "calling" ? `calling ${d.current.lead?.name || d.current.lead?.company || "the lead"}…`
        : phase === "connected" ? "on the call — the disposition opens when you hang up"
          : campStateText(d);
  }
}

function holdForHours(ct) {
  const keep = CAMP.advanced;
  CAMP.advanced = false;
  cancelAutoDial();
  clearTimeout(CAMP.hoursTimer);
  const at = ct.opensAt ? new Date(ct.opensAt) : null;
  const el = $("camp-auto-state");
  if (el) el.textContent = `outside calling hours for every lead up next — nothing will ring${at
    ? ` until ${at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} your time` : ""}`;
  // look again when it opens (or every 10 minutes, whichever is sooner)
  const wait = at ? Math.max(60e3, Math.min(at.getTime() - Date.now() + 5e3, 10 * 60e3)) : 10 * 60e3;
  CAMP.hoursTimer = setTimeout(() => {
    if (kdActive() || CAMP.busy) return;
    CAMP.advanced = keep;
    loadCampaign();
  }, wait);
}

async function submitOutcome(extra) {
  if (CAMP.busy) return;                       // a double press must not skip a lead
  CAMP.busy = true;
  // pressed on the card instead of saving the sheet: the sheet's question is answered
  if (CAMP.awaitDispo) { CAMP.awaitDispo = null; kdShow("kd-wrap", false); }
  document.querySelectorAll(".camp-out, .camp-skip").forEach((b) => (b.disabled = true));
  const fu = $("camp-fu");
  try {
    cancelAutoDial();                      // whatever was counting is stale now
    cancelWrap();                          // a pressed button beats the timer
    /* a name typed into "Add to Zoho CRM" goes in before the card moves on —
       a CRM hiccup is reported but never blocks the outcome */
    const crmLast = ($("camp-crm-last")?.value || "").trim();
    if (crmLast && !extra.skip && CAMP.s?.current?.lead?.id > 0) {
      try {
        toast(await crmCreateLead(CAMP.s.current.lead.id, ($("camp-crm-first")?.value || "").trim(), crmLast,
          ($("camp-crm-email")?.value || "").trim()), 6000);
      } catch (e) { toast("Zoho CRM: " + e.message, 8000); }
    }
    CAMP.advanced = true;
    CAMP.s = await api("/api/campaign/outcome", {
      method: "POST",
      body: JSON.stringify({
        ...extra,
        leadId: CAMP.s?.current?.lead?.id ?? null,
        note: $("camp-note") ? $("camp-note").value : "",
        followUpAt: fu && fu.checked && $("camp-fu-when").value
          ? new Date($("camp-fu-when").value).toISOString() : null,
      }),
    });
    renderCampaign(CAMP.s);
  } catch (e) {
    toast("Could not record that: " + e.message, 8000);
    document.querySelectorAll(".camp-out, .camp-skip").forEach((b) => (b.disabled = false));
  }
  CAMP.busy = false;
}

function renderCampDone(d) {
  cancelAutoDial(); cancelWrap();
  $("camp-pane")?.classList.remove("cs-mode");
  $("camp-body").innerHTML = `
    <div class="act-card camp-done">
      <h4>Session finished</h4>
      <div class="kpi-strip">
        ${kpiTile("Called", String(d.called), `of ${d.total} on the list`)}
        ${kpiTile("Connected", String(d.connected),
          d.called ? `${Math.round((d.connected / d.called) * 100)}% of calls` : "none")}
        ${kpiTile("Skipped", String(d.skipped), "left untouched")}
      </div>
      <button class="btn-primary" id="camp-again">Start another session</button>
    </div>`;
  $("camp-again").addEventListener("click", () => renderCampStart(d.owner));
}

async function endCampaign() {
  cancelAutoDial(); cancelWrap();
  try {
    const out = await api("/api/campaign/end", { method: "POST" });
    renderCampDone({ ...out, done: true, owner: CAMP.s?.owner });
  } catch (e) { toast("Could not stop the session: " + e.message); }
}

/* ---------------- Storm watch ----------------
   Where property just got damaged, and who we already have on file there.

   A tile grid rather than a drawn coastline. Three reasons, and they are
   not laziness: the alerts arrive as state and county codes, not shapes, so
   a state is the finest honest unit; every state gets equal room, which a
   real map does not — Rhode Island and Delaware carry real lead counts and
   vanish on a projection; and it needs no tile server, no map library and
   no change to the content-security policy. Each square is a state, laid
   out roughly where it sits.

   Canada is on the grid but never lit: the alert feed is the US National
   Weather Service. Environment Canada publishes CAP as a tree of XML files
   rather than an API, and the base holds eight Canadian leads, so it earns
   the work the day that changes. */





let STORM = { data: null, timer: null };

/* ---------------- My calls ----------------
   A rep's own view of their calling, under Calling: the power-dialer
   campaigns they were given (GET /api/campaign/mine) and their own call
   history (GET /api/calls/mine) — nobody else's calls, whatever the role. */
const MC = { tab: "campaigns", days: 30, outcome: "", q: "", rows: [], more: false, summary: null, camps: null, seq: 0 };

async function loadMyCalls() {
  document.querySelectorAll("[data-mc]").forEach((b) => b.classList.toggle("on", b.dataset.mc === MC.tab));
  if (MC.tab === "campaigns") return loadMyCampaigns();
  return loadMyHistory(false);
}

async function loadMyCampaigns() {
  const el = $("mc-body");
  el.innerHTML = `<p class="act-empty">Loading…</p>`;
  try { MC.camps = (await api("/api/campaign/mine")).list; }
  catch (e) { el.innerHTML = `<p class="act-empty">Couldn't load your campaigns (${esc(e.message)})</p>`; return; }
  const list = MC.camps;
  const open = list.filter((c) => c.status === "ongoing" || c.status === "paused" || c.status === "draft");
  $("mc-sub").textContent = list.length ? `${list.length} campaign${list.length === 1 ? "" : "s"}${open.length ? ` · ${open.length} open` : ""}` : "";
  if (!list.length) {
    el.innerHTML = `<div class="live-quiet pd-empty"><b>No campaigns yet</b>
      <span>When your manager gives you a power-dialer campaign it shows here, and a banner offers Join when it starts.</span></div>`;
    return;
  }
  el.innerHTML = `<div class="cl-tablewrap"><table class="cl-table pd-table mc-table">
    <thead><tr><th>Campaign</th><th>Status</th><th>Progress</th><th class="n">Contacts</th><th class="n">Called</th>
      <th class="n">Connected</th><th>Given by</th><th></th></tr></thead>
    <tbody>${list.map((c) => {
      const pct = c.total ? Math.round((c.completed / c.total) * 100) : 0;
      const [label, cls] = PD_STATUS[c.status] || [c.status, "draft"];
      const when = c.endedAt ? "ended " + new Date(c.endedAt).toLocaleDateString([], { month: "short", day: "numeric" })
        : "since " + new Date(c.createdAt).toLocaleDateString([], { month: "short", day: "numeric" });
      const live = c.status === "ongoing" || c.status === "paused";
      return `<tr class="pd-${cls}">
        <td><div class="cl-party"><b>${esc(c.name)}</b><span>${esc(when)}${c.callback ? ` · callbacks ring ${esc(c.callback.name)}` : ""}</span></div></td>
        <td><span class="pd-status ${cls}"><i></i>${esc(label)}</span>${c.status === "paused" && c.pausedBy ? `<span class="pd-by">by ${esc(c.pausedBy)}</span>` : ""}</td>
        <td class="pd-progc"><div class="pd-prog"><i style="width:${pct}%"></i></div><span>${pct}% · ${dashN(c.pending)} left</span></td>
        <td class="n">${dashN(c.total)}</td><td class="n">${dashN(c.called)}</td><td class="n">${dashN(c.connected)}</td>
        <td>${esc(c.createdBy || "—")}</td>
        <td class="pd-acts">${live ? `<button class="btn-primary pd-btn" data-mc-go="1">Go to campaign</button>` : ""}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

async function loadMyHistory(more) {
  const el = $("mc-body");
  const seq = ++MC.seq;
  if (!more) {
    MC.rows = [];
    el.innerHTML = `
      <div class="mc-filters">
        <select id="mc-days" aria-label="Period">
          ${[[1, "Today"], [7, "Last 7 days"], [30, "Last 30 days"], [90, "Last 90 days"]].map(([v, l]) =>
            `<option value="${v}"${v === MC.days ? " selected" : ""}>${l}</option>`).join("")}
        </select>
        <select id="mc-outcome" aria-label="Outcome">
          <option value="">All outcomes</option>
          ${Object.entries(OUTCOME_WORDS).filter(([k]) => k !== "unknown").map(([k, l]) =>
            `<option value="${k}"${k === MC.outcome ? " selected" : ""}>${esc(l)}</option>`).join("")}
        </select>
        <input type="search" id="mc-q" placeholder="Search a lead or number" value="${esc(MC.q)}" autocomplete="off">
      </div>
      <div id="mc-sum" class="mc-sum"></div>
      <div id="mc-list"><p class="act-empty">Loading…</p></div>`;
    $("mc-days").addEventListener("change", (e) => { MC.days = +e.target.value; loadMyHistory(false); });
    $("mc-outcome").addEventListener("change", (e) => { MC.outcome = e.target.value; loadMyHistory(false); });
    let t;
    $("mc-q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { MC.q = e.target.value.trim(); loadMyHistory(false); }, 350); });
  }
  const p = new URLSearchParams({ days: MC.days });
  if (MC.outcome) p.set("outcome", MC.outcome);
  if (MC.q) p.set("q", MC.q);
  if (more && MC.rows.length) p.set("before", MC.rows[MC.rows.length - 1].at);
  let d;
  try { d = await api("/api/calls/mine?" + p); }
  catch (e) { if (seq === MC.seq) $("mc-list").innerHTML = `<p class="act-empty">Couldn't load your calls (${esc(e.message)})</p>`; return; }
  if (seq !== MC.seq) return;                     // a newer search answered first
  MC.rows = more ? MC.rows.concat(d.list) : d.list;
  MC.more = d.more;
  const s = d.summary;
  $("mc-sub").textContent = `Only your own calls`;
  $("mc-sum").innerHTML = `<b>${dashN(s.calls)}</b> call${s.calls === 1 ? "" : "s"} · <b>${dashN(s.connected)}</b> connected${
    s.calls ? ` (${Math.round((s.connected / s.calls) * 100)}%)` : ""} · <b>${dashDur(s.seconds)}</b> talking`;
  const rows = MC.rows;
  $("mc-list").innerHTML = !rows.length ? `<p class="act-empty">No calls${MC.q || MC.outcome ? " match" : " in this period"}.</p>` : `
    <div class="cl-tablewrap"><table class="cl-table mc-table">
      <thead><tr><th>When</th><th>Lead</th><th>Number</th><th>Outcome</th><th class="n">Length</th><th>Recording</th><th>Disposition</th><th>Campaign</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><div class="cl-party"><b>${esc(new Date(r.at).toLocaleDateString([], { month: "short", day: "numeric" }))}</b>
          <span>${esc(new Date(r.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}${r.direction === "inbound" ? " · incoming" : ""}</span></div></td>
        <td>${r.lead_id && r.lead_kind ? `<a href="#" class="person-lead" data-lead="${r.lead_id}" data-kind="${esc(r.lead_kind)}">${esc(r.lead_name || "—")}</a>`
          : esc(r.lead_name || "—")}</td>
        <td>${esc(r.number ? dashPhone(r.number) : "—")}</td>
        <td><span class="mc-out ${esc(r.outcome || "")}">${esc(OUTCOME_WORDS[r.outcome] || r.outcome || "—")}</span></td>
        <td class="n">${r.outcome === "connected" ? esc(dashDur(r.seconds)) : "—"}</td>
        <td>${r.recording ? `<button type="button" class="mc-play" data-rec="${esc(r.recording)}" title="Play this call">▶ Play</button>` : `<span class="dash-mute">—</span>`}</td>
        <td>${r.disposition ? `<span class="dash-chip">${esc(r.disposition)}</span>` : `<span class="dash-mute">—</span>`}${
          r.note ? `<div class="mc-note">${esc(r.note)}</div>` : ""}</td>
        <td>${esc(r.campaign || "")}</td></tr>`).join("")}</tbody></table></div>
    ${MC.more ? `<div class="mc-more"><button class="btn-ghost" id="mc-more">Show more</button></div>` : ""}`;
  $("mc-more")?.addEventListener("click", () => loadMyHistory(true));
  $("mc-list").querySelectorAll(".mc-play").forEach((b) =>
    b.addEventListener("click", () => {
      const a = document.createElement("audio");
      a.controls = true; a.autoplay = true; a.preload = "none"; a.className = "mc-audio"; a.src = b.dataset.rec;
      b.replaceWith(a);
    }));
}

/* ---------------- My settings ----------------
   Each person's own connections, on a page every role can open — a sales
   rep's RingCentral and Zoho CRM sign-ins used to live only on the Call
   report, which is admin-only. The server already let anyone connect their
   own (requireUser); this is the place to do it. Both sign-ins come back
   here (?tab=me). */
async function loadMySettings() {
  const el = $("me-body");
  if (!el) return;
  el.innerHTML = `<p class="act-empty">Loading…</p>`;
  await Promise.all([crmMeLoad().catch(() => {}), vmLoad().catch(() => {})]);
  renderMySettings();
}

function renderMySettings() {
  const el = $("me-body");
  if (!el) return;
  const rcFailed = VOICE.rcEnabled && VOICE.rcConnected && VOICE.rcError;
  const rc = !VOICE.rcEnabled
    ? `<p class="me-state">RingCentral isn't set up on this server yet — ask an admin.</p>`
    : rcFailed
      ? `<p class="me-state bad"><span class="me-dot bad"></span>Connected, but the phone didn't register: ${esc(VOICE.rcError)}</p>
         <div class="me-acts"><a class="btn-primary" href="/api/voice/rc/connect">Reconnect</a>
           <button class="btn-ghost" data-me="rc-off">Disconnect</button></div>`
      : VOICE.rcConnected
        ? `<p class="me-state ok"><span class="me-dot ok"></span>Connected${VOICE.rcExtension ? " · extension " + esc(VOICE.rcExtension) : ""}${
            VOICE.sandbox ? " · sandbox, test numbers only" : ""}</p>
           <div class="me-acts"><a class="btn-ghost" href="/api/voice/rc/connect">Switch account</a>
             <button class="btn-ghost" data-me="rc-off">Disconnect</button></div>`
        : `<p class="me-state"><span class="me-dot"></span>Not connected — calls can't go out from the dialler yet.</p>
           <div class="me-acts"><a class="btn-primary" href="/api/voice/rc/connect">Connect RingCentral</a></div>`;

  const c = CRMME;
  const crm = !c ? `<p class="me-state">Couldn't check Zoho CRM right now.</p>`
    : !c.enabled ? `<p class="me-state">Personal Zoho CRM sign-in isn't set up on this server — your calls and leads go into Zoho under the shared account.</p>`
      : c.connected && c.lastError
        ? `<p class="me-state bad"><span class="me-dot bad"></span>Zoho refused your sign-in: ${esc(c.lastError)} — your calls are going in under the shared account.</p>
           <div class="me-acts"><a class="btn-primary" href="${esc(c.connectUrl)}">Reconnect Zoho CRM</a>
             ${isAdmin() ? `<button class="btn-ghost" data-me="crm-off">Disconnect</button>` : ""}</div>`
        : c.connected
          ? `<p class="me-state ok"><span class="me-dot ok"></span>Connected${c.name || c.email ? " as " + esc(c.name || c.email) : ""} — your calls and leads are filed under you</p>
             <div class="me-acts">${isAdmin() ? `<button class="btn-ghost" data-me="crm-off">Disconnect</button>` : ""}</div>`
          : `<p class="me-state"><span class="me-dot"></span>Not connected — your calls and leads go into Zoho under the shared account.</p>
             <div class="me-acts"><a class="btn-primary" href="${esc(c.connectUrl)}">Connect Zoho CRM</a></div>`;

  const vm = VM.meta?.has
    ? `<p class="me-state ok"><span class="me-dot ok"></span>Recorded${VM.meta.seconds ? " · " + vmClock(VM.meta.seconds) : ""}${VM.meta.updatedAt ? " · " + esc(relTime(VM.meta.updatedAt)) : ""}</p>`
    : `<p class="me-state"><span class="me-dot"></span>Not recorded yet — record it once, then drop it on any call that reaches voicemail.</p>`;

  const me = S.me || {};
  el.innerHTML = `<div class="me-grid">
    <div class="act-card me-card">
      <h4>Phone — RingCentral</h4>
      <p class="me-why">Sign in with your own RingCentral account so calls go out from your extension, with your caller ID, in your call log.</p>
      ${rc}
    </div>
    <div class="act-card me-card">
      <h4>Zoho CRM</h4>
      <p class="me-why">Connect your own Zoho CRM so the calls and leads you create are filed under you, not the shared account.</p>
      ${crm}
    </div>
    <div class="act-card me-card">
      <h4>Voicemail drop</h4>
      <p class="me-why">The message played when you press VM drop on a call that reaches voicemail.</p>
      ${vm}
      <div class="me-acts"><button class="${VM.meta?.has ? "btn-ghost" : "btn-primary"}" data-me="vm">${VM.meta?.has ? "Change it" : "Record it"}</button></div>
    </div>
    <div class="act-card me-card">
      <h4>Call alerts</h4>
      <p class="me-why">When a call comes in, the dialler opens and rings, the tab title flashes, and — if you allow it — a desktop notification shows who it is even when another window is in front.</p>
      ${!("Notification" in window) ? `<p class="me-state">This browser can't show desktop notifications.</p>`
        : Notification.permission === "granted" ? `<p class="me-state ok"><span class="me-dot ok"></span>Desktop notifications are on</p>`
          : Notification.permission === "denied" ? `<p class="me-state bad"><span class="me-dot bad"></span>Notifications are blocked for this site — allow them from the lock icon in the address bar</p>`
            : `<p class="me-state"><span class="me-dot"></span>Desktop notifications are off</p>`}
      <div class="me-acts">${"Notification" in window && Notification.permission === "default"
        ? `<button class="btn-primary" data-me="notify">Turn on notifications</button>` : ""}
        <button class="btn-ghost" data-me="ring">Test the ring</button></div>
    </div>
    <div class="act-card me-card">
      <h4>Microphone &amp; speaker</h4>
      <p class="me-why">Pick your headset, test the microphone, and choose where calls play.</p>
      <div class="me-acts"><button class="btn-ghost" data-me="audio">Open audio settings</button></div>
    </div>
    <div class="act-card me-card">
      <h4>Your account</h4>
      <p class="me-state">${esc(me.display_name || me.email || "")}${me.display_name ? ` · ${esc(me.email)}` : ""}</p>
      <p class="me-why">Access: <b>${esc(roleLabel(me.role || "member"))}</b>${isAdmin() ? "" : " — an admin changes this in Manage team."}</p>
    </div>
  </div>`;
}

/* The dialler holds the voicemail recorder and the audio picker: open it
   on the right page rather than building them twice. */
function meOpenDialler(stab) {
  rcPanelToggle(true);
  KD.view = "settings"; KD.stab = stab;
  if (stab === "audio") kdLoadDevices();
  kdRender();
}

async function meAction(what) {
  if (what === "notify") {
    try { await Notification.requestPermission(); } catch (e) { /* older browsers */ }
    if (Notification.permission === "granted") new Notification("Call alerts are on", { body: "You'll see who is calling here, even when Karma Connect is behind another window.", icon: "/leads/icon-256.png" });
    return renderMySettings();
  }
  if (what === "ring") {
    kdRing(true, 3);
    if (kdRinger) setTimeout(() => kdRing(false), 3200);
    return toast("That's the ring for an incoming call", 3000);
  }
  if (what === "vm") return meOpenDialler("vm");
  if (what === "audio") return meOpenDialler("audio");
  if (what === "rc-off") {
    if (!confirm("Disconnect RingCentral? You won't be able to dial from Karma Connect until you connect again.")) return;
    try {
      await api("/api/voice/rc/connect", { method: "DELETE" });
      VOICE.rcConnected = false; VOICE.provider = ""; VOICE.ready = false;
      toast("RingCentral disconnected");
    } catch (e) { toast("Could not disconnect: " + e.message, 8000); }
    return renderMySettings();
  }
  if (what === "crm-off") {
    if (!confirm("Disconnect Zoho CRM? Your calls and leads will go into Zoho under the shared account until you connect again.")) return;
    try { await api("/api/crm/me/connect", { method: "DELETE" }); toast("Zoho CRM disconnected"); }
    catch (e) { toast("Could not disconnect: " + e.message, 8000); }
    return loadMySettings();
  }
}

async function loadStorm() {
  const el = $("storm-body");
  if (!el) return;
  if (!STORM.data) el.innerHTML = `<p class="act-empty">Reading the National Weather Service…</p>`;
  try {
    STORM.data = await api("/api/alerts");
    renderStorm(STORM.data);
  } catch (e) {
    el.innerHTML = `<p class="act-empty">Could not load alerts (${esc(e.message)})</p>`;
  }
}

function renderStorm(d) {
  const el = $("storm-body");
  const byState = new Map((d.states || []).map((s) => [s.state, s]));
  const hit = (d.states || []).filter((s) => s.tier > 0);
  const reach = hit.reduce((a, s) => a + s.leads, 0);

  const badge = $("count-storm");
  if (badge) badge.textContent = hit.length ? String(hit.length) : "";

  el.innerHTML = `
    <div class="kpi-strip">
      ${kpiTile("Live events", String(d.relevant),
        `${d.hazards || 0} disasters and fires, the rest weather`)}
      ${kpiTile("States affected", String(hit.length), "right now")}
      ${kpiTile("Leads in range", reach.toLocaleString(),
        `${hit.reduce((a, s) => a + s.unassigned, 0).toLocaleString()} unassigned`)}
      ${kpiTile("Worst", hit.length ? TIER_WORD[Math.max(...hit.map((s) => s.tier))] : "Quiet",
        d.stale ? "feed stale — showing the last good read" : "updated " + esc(relTime(d.fetchedAt)))}
    </div>

    ${(d.storms || []).length ? `<div class="act-card sm-tropical">
      <h4>🌀 Active tropical systems <span class="sm-count">${d.storms.length}</span></h4>
      <div class="sm-storm-grid">${d.storms.map((s, i) => stormCard(s, d, i)).join("")}</div>
      <p class="asg-foot">Live from the National Hurricane Center. Position, strength and track are
        the NHC's official advisory; "threatening" lists the US states under an active hurricane,
        tropical-storm or storm-surge warning right now. Follow a storm's link for the full forecast cone.</p>
    </div>` : ""}

    <div class="act-card">
      <h4>North America — click a state to work its leads</h4>
      <div class="sm-scene">
        ${naMapSvg(byState, d.storms)}
      </div>
      <div class="sm-key">
        <span><i class="sm-sw t3"></i>Destroying property now</span>
        <span><i class="sm-sw t2"></i>Damage likely</span>
        <span><i class="sm-sw t1"></i>Worth watching</span>
        <span><i class="sm-sw t0"></i>Nothing active</span>
        ${(d.storms || []).length ? `<span class="sm-storm-leg">🌀 Storm — the cyclone is where it is, the cone where it's heading</span>` : ""}
        <span class="sm-note">A state's colour is how severe the weather is; the number is leads on file there.
          Canada is unlit — US feed only. Equal-area projection; Hawaii is an inset.</span>
      </div>
    </div>

    <div class="act-card">
      <h4>Alerts — worst first</h4>
      ${(d.alerts || []).length ? `<div class="task-list">
        ${d.alerts.slice(0, 25).map((a) => `
          <div class="task-row sm-alert" data-states="${esc(a.states.join(","))}">
            <span class="sm-tier t${a.tier}">${TIER_WORD[a.tier]}</span>
            <div class="task-main">
              <b>${esc(a.event)}</b>
              <span class="sm-src s-${esc(String(a.source || "NWS").toLowerCase())}">${esc(a.source || "NWS")}</span>
              <span class="task-sub">${esc(a.area)}</span>
            </div>
            <span class="sm-states">${esc(a.states.join(" "))}</span>
            <span class="task-when">${a.expires ? "until " + esc(shortWhen(a.expires)) : ""}</span>
          </div>`).join("")}
      </div>` : `<p class="act-empty">Nothing severe anywhere in the US right now.
        That is good news and an unusual screenshot.</p>`}
      <p class="asg-foot">Sources, refreshed every five minutes:
        <b>NWS</b> severe-weather warnings (marine and beach advisories filtered out),
        <b>FEMA</b> declared disasters, <b>NIFC</b> wildfires burning now
        (prescribed burns excluded), <b>USGS</b> earthquakes from magnitude 4.
        ${(d.down || []).length ? `<span class="sm-down">Not answering right now: ${esc(d.down.join(", "))}.</span>` : ""}</p>
    </div>`;

  el.querySelectorAll(".sm-reg:not(.off)").forEach((gEl) => {
    const go = () => openStateLeads(gEl.dataset.state);
    gEl.addEventListener("click", go);
    // reachable without a mouse, since each region is a real control
    gEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
  });
  el.querySelectorAll(".sm-alert").forEach((row) =>
    row.addEventListener("click", () => {
      const first = (row.dataset.states || "").split(",")[0];
      if (first) openStateLeads(first);
    }));
  el.querySelectorAll(".sm-sys.sm-click").forEach((c) => {
    const open = () => stormModal(+c.dataset.storm);
    c.addEventListener("click", open);
    c.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

/* Everything we know about one storm, in-app — no trip to a website. Position,
   strength, how it is moving, who it threatens, and a straight-line projection
   of where its current track points over the next couple of days. */
function stormModal(i) {
  const d = STORM.data; if (!d) return;
  const s = (d.storms || [])[i]; if (!s) return;
  const cat = STORM_CAT(s.intensityKt), mph = KT_TO_MPH(s.intensityKt), moveMph = KT_TO_MPH(s.moveKt);
  const kindName = STORM_KIND[s.kind] || "Tropical system";
  const states = [...new Set((d.alerts || [])
    .filter((a) => /hurricane|tropical storm|storm surge|typhoon/i.test(a.event || ""))
    .flatMap((a) => a.states || []))];
  const proj = [];
  if (s.lat != null && s.lon != null && s.moveDir != null && s.moveKt) {
    for (const h of [12, 24, 48]) {
      const [lo, la] = stormAhead(s.lat, s.lon, s.moveDir, s.moveKt * 1.151 * h);
      proj.push({ h, label: stormCoord(la, lo) });
    }
  }
  const stat = (lbl, val) => val ? `<div><span>${lbl}</span><b>${esc(val)}</b></div>` : "";
  $("modal-title").textContent = s.name || "Tropical system";
  $("modal-body").innerHTML = `
    <div class="st-modal ${stormSev(s)}">
      <div class="st-m-head">
        <b>${esc(kindName)}${cat ? " · Category " + cat : ""}</b>
        ${cat ? `<span class="sm-cat">Cat ${cat}</span>` : `<span class="sm-cat ts">${esc(s.kind || "")}</span>`}
      </div>
      <div class="st-m-stats">
        ${stat("Max winds", mph != null ? mph + " mph" : "")}
        ${stat("Pressure", s.pressureMb != null ? s.pressureMb + " mb" : "")}
        ${stat("Moving", s.moveKt != null ? `${s.moveDir != null ? dirToCompass(s.moveDir) + " " : ""}${moveMph} mph` : "")}
        ${stat("Position now", stormCoord(s.lat, s.lon))}
        ${stat("Basin", s.basin)}
        ${stat("Updated", s.at ? relTime(s.at) : "")}
      </div>
      ${states.length ? `<div class="st-m-threat"><span>Threatening right now</span><div>${states.map((x) => `<span class="sm-st">${esc(x)}</span>`).join("")}</div></div>` : ""}
      ${proj.length ? `<h4 class="st-m-h">Where its current track points</h4>
        <div class="st-m-fc">
          <div class="st-m-row"><span>Now</span><b>${esc(stormCoord(s.lat, s.lon))}</b></div>
          ${proj.map((p) => `<div class="st-m-row"><span>in ${p.h}h</span><b>${esc(p.label)}</b></div>`).join("")}
        </div>
        <p class="dash-mute crm-fine">A straight-line projection from the current heading and speed — real storms curve, so read it as a direction, not a destination. The official forecast curve is the NHC's.</p>` : ""}
      ${s.track ? `<p class="st-m-link"><a href="${esc(s.track)}" target="_blank" rel="noopener">Open the NHC's official forecast cone ↗</a></p>` : ""}
      <div class="modal-actions"><button type="button" class="btn-secondary" id="modal-cancel">Close</button></div>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
}

/* The map itself. Real geometry — Natural Earth admin-1, Albers equal-area,
   simplified and projected offline into na-geo.js — so there is no map
   library, no tile server and nothing new for the CSP to allow.

   Equal-area, not Mercator, on purpose: Mercator would show Nunavut larger
   than the entire lower 48, and on a page about where the work is that
   would read as meaning something.

   Drawn twice when tilted. An SVG cannot extrude, so the "3D" view stacks
   copies of each lit state behind itself to make a wall, then puts the face
   on top. Cheap, and it needs no WebGL. */
function naMapSvg(byState, storms) {
  const g = window.NA_GEO;
  if (!g) return `<p class="act-empty">Map data did not load (na-geo.js).</p>`;

  const shapes = Object.keys(g.shapes).map((code) => {
    const st = byState.get(code);
    const t = st ? st.tier : 0;
    const m = g.meta[code] || {};
    const title = st
      ? `${st.name}: ${st.alerts} alert(s) — ${st.events.join(", ")}. ${st.leads} leads, ${st.unassigned} unassigned.`
      : m.country === "CA" ? `${m.name || code} — no Canadian alert feed`
        : `${m.name || code} — nothing active`;
    return `<g class="sm-reg t${t}${m.country === "CA" ? " ca" : ""}${st ? "" : " off"}"
      data-state="${esc(code)}" role="button" tabindex="${st ? 0 : -1}">
      <title>${esc(title)}</title>
      <path class="sm-face" d="${g.shapes[code]}"/>
    </g>`;
  }).join("");

  const labels = Object.keys(g.labels).map((code) => {
    const st = byState.get(code);
    if (!st || !st.leads) return "";
    const [x, y] = g.labels[code];
    const n = st.leads > 999 ? (st.leads / 1000).toFixed(1) + "k" : st.leads;
    return `<text class="sm-lab t${st.tier}" x="${x}" y="${y}">
      <tspan class="sm-labc" x="${x}" dy="0">${esc(code)}</tspan>
      <tspan class="sm-labn" x="${x}" dy="9">${esc(String(n))}</tspan>
    </text>`;
  }).join("");

  // the generator's frame: the US with headroom for southern Canada
  const view = g.view || [0, 0, g.width, g.height];
  const vb = view.join(" ");
  /* A faint lat/long graticule over the sea — drawn before the land, which
     covers it, so only the water shows the lines. */
  let grat = "";
  for (let lon = -170; lon <= -40; lon += 10) {
    let d = ""; for (let lat = 8; lat <= 76; lat += 3) { const [x, y] = stormXY(lon, lat); d += (d ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1); }
    grat += `<path d="${d}"/>`;
  }
  for (let lat = 20; lat <= 70; lat += 10) {
    let d = ""; for (let lon = -170; lon <= -40; lon += 3) { const [x, y] = stormXY(lon, lat); d += (d ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1); }
    grat += `<path d="${d}"/>`;
  }
  return `<svg class="sm-map" viewBox="${vb}"
    preserveAspectRatio="xMidYMid meet" role="img"
    aria-label="Severe weather by state and province across the United States and Canada">
    <defs>
      <radialGradient id="sm-ocean" cx="42%" cy="28%" r="95%">
        <stop class="sm-o0" offset="0%"/><stop class="sm-o1" offset="55%"/><stop class="sm-o2" offset="100%"/>
      </radialGradient>
      <linearGradient id="sm-terrain" x1="0" y1="0" x2="0" y2="1">
        <stop class="sm-l0" offset="0%"/><stop class="sm-l1" offset="100%"/>
      </linearGradient>
      <filter id="sm-landsh" x="-5%" y="-5%" width="110%" height="110%">
        <feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-color="#030a06" flood-opacity="0.5"/>
      </filter>
    </defs>
    <rect class="sm-ocean-r" x="${view[0]}" y="${view[1]}" width="${view[2]}" height="${view[3]}"/>
    <g class="sm-grat">${grat}</g>
    <g class="sm-land" filter="url(#sm-landsh)">${shapes}</g>
    <g class="sm-labels">${labels}</g>
    ${stormOverlay(storms)}
  </svg>`;
}

const TIER_WORD = { 0: "—", 1: "Watch", 2: "Likely", 3: "Severe" };

/* ---------------- active tropical systems ---------------- */
const KT_TO_MPH = (kt) => (kt == null ? null : Math.round(kt * 1.151));
const STORM_CAT = (kt) => (kt == null ? null
  : kt >= 137 ? 5 : kt >= 113 ? 4 : kt >= 96 ? 3 : kt >= 83 ? 2 : kt >= 64 ? 1 : 0);
const STORM_KIND = { TD: "Tropical Depression", TS: "Tropical Storm", HU: "Hurricane",
  MH: "Major Hurricane", STS: "Subtropical Storm", SD: "Subtropical Depression",
  SS: "Subtropical Storm", STD: "Subtropical Depression", PTC: "Potential Tropical Cyclone" };
const COMPASS16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const dirToCompass = (deg) => (deg == null ? "" : COMPASS16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]);
const stormCoord = (lat, lon) => (lat == null || lon == null) ? ""
  : `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(1)}°${lon < 0 ? "W" : "E"}`;

/* lon/lat -> the na-geo map's coordinate space. The same Albers equal-area
   conic the geometry is built with (leads/scripts/build-na-geo.mjs), then the
   affine fit to the shipped state centroids (change-report/calibrate.mjs:
   RMS ~11px on a 1000px map — close enough for a storm marker; the NHC link
   has the exact cone). */
const stormXY = (() => {
  const D = Math.PI / 180, lam0 = -100 * D, phi0 = 45 * D, phi1 = 29.5 * D, phi2 = 57 * D;
  const n = 0.5 * (Math.sin(phi1) + Math.sin(phi2));
  const C = Math.cos(phi1) ** 2 + 2 * n * Math.sin(phi1);
  const rho0 = Math.sqrt(C - 2 * n * Math.sin(phi0)) / n;
  const S = 845.3959, TX = 575.413, TY = 511.331;
  return (lon, lat) => {
    const phi = lat * D; let lam = lon * D - lam0;
    while (lam > Math.PI) lam -= 2 * Math.PI;
    while (lam < -Math.PI) lam += 2 * Math.PI;
    const q = C - 2 * n * Math.sin(phi);
    const rho = Math.sqrt(Math.max(q, 0)) / n, theta = n * lam;
    return [S * (rho * Math.sin(theta)) + TX, S * (rho * Math.cos(theta) - rho0) + TY];
  };
})();
/* A point `miles` ahead on bearing `brg` (great-circle), to draw the heading. */
function stormAhead(lat, lon, brg, miles) {
  const R = 3958.8, d = miles / R, b = brg * Math.PI / 180;
  const la1 = lat * Math.PI / 180, lo1 = lon * Math.PI / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [lo2 * 180 / Math.PI, la2 * 180 / Math.PI];
}
const stormSev = (s) => {
  const cat = STORM_CAT(s.intensityKt);
  return (cat != null && cat >= 3) ? "sev3"
    : (s.kind === "HU" || s.kind === "MH" || (cat != null && cat >= 1)) ? "sev2" : "sev1";
};

/* The cyclone glyph, meant to read like the satellite view rather than a
   symbol: a tinted cloud mass in the storm's colour, three tapered rain bands
   in white spiralling out from a bright eyewall, and a dark, calm eye.

   The bands are logarithmic spirals — the curve real bands follow — traced
   clockwise outward, which is how a northern-hemisphere storm looks from
   above; the whole cloud then turns slowly anticlockwise, the way the storm
   itself does. A soft glow in the category colour lifts the glyph off the
   terrain, and the shadow under the cloud keeps it legible on land that has
   lit up the same hue.

   Drawn once in unit space (cloud radius 1) and scaled to `r`, so one set of
   shapes serves every category. Colour arrives through currentColor from the
   severity class on the enclosing group; the masks and filters it leans on
   are shared, and live in stormOverlay's <defs>. */
function stormCyc(x, y, r) {
  /* One band: a log spiral rad = R0·e^(K·t). It starts under the core so it
     emerges from the cloud mass rather than butting against it, swells, then
     tapers to a point; the radial fade on the whole cloud (sm-m-cloud)
     dissolves the tails instead of leaving hairlines. `span` is the sweep in
     radians, `wmax` the half-width at its fullest. */
  const band = (th0, R0, R1, span, wmax) => {
    const K = Math.log(R1 / R0) / span, N = 32, outer = [], inner = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N, rad = R0 * Math.exp(K * span * u), th = th0 + span * u;
      const w = 0.004 + wmax * Math.pow(1 - u, 1.3) * Math.min(1, u * 5);
      const c = Math.cos(th), s = Math.sin(th);
      outer.push([(rad + w) * c, (rad + w) * s]);
      inner.push([(rad - w) * c, (rad - w) * s]);
    }
    const pt = (p) => `${p[0].toFixed(3)} ${p[1].toFixed(3)}`;
    return `M${pt(outer[0])} L${outer.slice(1).map(pt).join(" L")} L${inner.reverse().map(pt).join(" L")} Z`;
  };
  // three main bands, and three fainter wisps between them further out
  const main = [0, 2.094, 4.189].map((a) => `<path class="sm-cyc-cloud" d="${band(a, 0.36, 1.15, 4.0, 0.115)}"/>`).join("");
  const wisp = [1.047, 3.142, 5.236].map((a) => `<path class="sm-cyc-wisp" d="${band(a, 0.5, 1.2, 3.3, 0.06)}"/>`).join("");
  return `<g class="sm-cyc" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
    <circle class="sm-cyc-glow" r="${(r * 1.85).toFixed(1)}" mask="url(#sm-m-glow)"/>
    <g transform="scale(${r.toFixed(2)})">
      <circle class="sm-cyc-disc" r="1.04" mask="url(#sm-m-disc)"/>
      <g filter="url(#sm-cloudsh)">
        <g class="sm-cyc-spin" mask="url(#sm-m-cloud)">
          <circle r="1.2" fill="none"/>
          ${wisp}
          <circle class="sm-cyc-cloud" r="0.5"/>
          ${main}
        </g>
      </g>
      <circle class="sm-cyc-eye" r="0.13"/>
    </g>
  </g>`;
}

/* The storm layer drawn over the map: where each system is (a cyclone glyph),
   a forecast cone + track dots in the way it is heading (its place a day ahead
   at its current bearing and speed), and a name/strength label. Systems far
   out at sea fall outside the frame and are simply clipped. */
function stormOverlay(storms) {
  const f1 = (v) => v.toFixed(1);
  let defs = "";
  const marks = (storms || []).map((s, i) => {
    if (s.lat == null || s.lon == null) return "";
    const [x, y] = stormXY(s.lon, s.lat);
    const cls = stormSev(s);
    const cat = STORM_CAT(s.intensityKt), mph = KT_TO_MPH(s.intensityKt);
    const r = cat >= 4 ? 13 : cat >= 3 ? 11 : cls !== "sev1" ? 9 : 7.5;
    let cone = "", track = "", dots = "";
    if (s.moveDir != null && s.moveKt) {
      const mi = Math.min(s.moveKt * 1.151 * 24, 780);
      const [alon, alat] = stormAhead(s.lat, s.lon, s.moveDir, mi);
      const [ax, ay] = stormXY(alon, alat);
      const dx = ax - x, dy = ay - y, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len, px = -uy, py = ux;
      /* The cone of uncertainty, drawn the way the NHC draws theirs: the
         envelope of circles that grow along the track, so the sides are
         straight and the far end is round. Its fill is masked by a gradient
         running along the heading, dense at the storm and thin a day out —
         confidence fading with distance — and softened at the edges so it
         sits on the map like weather rather than a cut-out. */
      const w0 = r * 0.6, W = len * 0.3 + 9;
      const d = `M${f1(x + px * w0)} ${f1(y + py * w0)} L${f1(ax + px * W)} ${f1(ay + py * W)}`
        + ` A${f1(W)} ${f1(W)} 0 0 0 ${f1(ax - px * W)} ${f1(ay - py * W)}`
        + ` L${f1(x - px * w0)} ${f1(y - py * w0)} A${f1(w0)} ${f1(w0)} 0 0 0 ${f1(x + px * w0)} ${f1(y + py * w0)} Z`;
      const bx = Math.min(x, ax) - W - 12, by = Math.min(y, ay) - W - 12;
      const bw = Math.abs(ax - x) + 2 * W + 24, bh = Math.abs(ay - y) + 2 * W + 24;
      defs += `<linearGradient id="sm-cg${i}" gradientUnits="userSpaceOnUse" x1="${f1(x)}" y1="${f1(y)}" x2="${f1(ax)}" y2="${f1(ay)}">
          <stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#fff" stop-opacity=".58"/><stop offset="1" stop-color="#fff" stop-opacity=".2"/>
        </linearGradient>
        <mask id="sm-cm${i}" maskUnits="userSpaceOnUse" x="${f1(bx)}" y="${f1(by)}" width="${f1(bw)}" height="${f1(bh)}">
          <rect x="${f1(bx)}" y="${f1(by)}" width="${f1(bw)}" height="${f1(bh)}" fill="url(#sm-cg${i})"/>
        </mask>`;
      cone = `<g mask="url(#sm-cm${i})">
        <path class="sm-cone" d="${d}" filter="url(#sm-soft)"/>
        <path class="sm-cone-edge" d="${d}"/>
      </g>`;
      // the centre line and the forecast positions along it (~10h, 17h, 24h)
      const tx = x + ux * r * 0.9, ty = y + uy * r * 0.9;
      track = `<path class="sm-trk-u" d="M${f1(tx)} ${f1(ty)} L${f1(ax)} ${f1(ay)}"/>
        <path class="sm-trk" d="M${f1(tx)} ${f1(ty)} L${f1(ax)} ${f1(ay)}"/>`;
      for (const f of [0.4, 0.7, 1.0]) {
        const [lo, la] = stormAhead(s.lat, s.lon, s.moveDir, mi * f);
        const [fx, fy] = stormXY(lo, la);
        dots += `<circle class="sm-fdot" cx="${f1(fx)}" cy="${f1(fy)}" r="${f === 1 ? 3 : 2.4}"/>`;
      }
    }
    /* The label sits just above the glyph and the pill grows with the name.
       A storm near the edge of the frame keeps its pill inside it — the
       Atlantic ones sit right at the eastern edge. */
    const name = s.name || "", meta = `${cat ? "Cat " + cat : "TS"}${mph != null ? " · " + mph + " mph" : ""}`;
    const pw = Math.max(72, Math.round(Math.max(name.length * 8.2, meta.length * 5.6) + 20));
    const view = (window.NA_GEO && window.NA_GEO.view) || [0, 0, 1e4, 1e4];
    const lx = Math.min(Math.max(x, view[0] + pw / 2 + 6), view[0] + view[2] - pw / 2 - 6);
    const label = `<g class="sm-lab-g" transform="translate(${f1(lx)} ${f1(y - r * 1.7 - 14)})">
      <rect class="sm-pill" x="${-pw / 2}" y="-12.5" width="${pw}" height="25" rx="8" filter="url(#sm-pillsh)"/>
      <text class="sm-name" y="-1.5">${esc(name)}</text>
      <text class="sm-meta" y="8.5">${esc(meta)}</text>
    </g>`;
    return `<g class="sm-sys-g ${cls}">${cone}${track}${dots}${stormCyc(x, y, r)}${label}</g>`;
  }).join("");
  if (!marks) return "";
  /* Shared plumbing for the glyph. The fades are masks rather than coloured
     gradients so the one shape set can take its colour from currentColor;
     the shadow filter is in bounding-box units so it scales with the glyph. */
  return `<defs>
      <radialGradient id="sm-rg-glow"><stop offset="0" stop-color="#fff"/><stop offset=".4" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
      <mask id="sm-m-glow" maskContentUnits="objectBoundingBox"><circle cx=".5" cy=".5" r=".5" fill="url(#sm-rg-glow)"/></mask>
      <radialGradient id="sm-rg-disc"><stop offset="0" stop-color="#fff"/><stop offset=".7" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
      <mask id="sm-m-disc" maskContentUnits="objectBoundingBox"><circle cx=".5" cy=".5" r=".5" fill="url(#sm-rg-disc)"/></mask>
      <radialGradient id="sm-rg-cloud"><stop offset="0" stop-color="#fff"/><stop offset=".6" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
      <mask id="sm-m-cloud" maskContentUnits="objectBoundingBox"><circle cx=".5" cy=".5" r=".5" fill="url(#sm-rg-cloud)"/></mask>
      <filter id="sm-cloudsh" x="-.4" y="-.4" width="1.8" height="1.8" primitiveUnits="objectBoundingBox">
        <feDropShadow dx="0" dy=".03" stdDeviation=".028" flood-color="#06101e" flood-opacity=".55"/>
      </filter>
      <filter id="sm-soft" x="-15%" y="-15%" width="130%" height="130%"><feGaussianBlur stdDeviation="1.8"/></filter>
      <filter id="sm-pillsh" x="-10%" y="-30%" width="120%" height="170%">
        <feDropShadow dx="0" dy="1.2" stdDeviation="1.6" flood-color="#000" flood-opacity=".45"/>
      </filter>
      ${defs}
    </defs>
    <g class="sm-storm-layer">${marks}</g>`;
}

/* One card per active storm: where it is, how strong, which way it is heading,
   and which US states are under a related warning right now. */
function stormCard(s, d, i) {
  const cat = STORM_CAT(s.intensityKt);
  const isHurr = s.kind === "HU" || s.kind === "MH" || (cat != null && cat >= 1);
  const kindName = STORM_KIND[s.kind] || "Tropical system";
  const mph = KT_TO_MPH(s.intensityKt), moveMph = KT_TO_MPH(s.moveKt);
  const states = [...new Set((d.alerts || [])
    .filter((a) => /hurricane|tropical storm|storm surge|typhoon/i.test(a.event || ""))
    .flatMap((a) => a.states || []))];
  const sev = (cat != null && cat >= 3) ? "sev3" : (isHurr ? "sev2" : "sev1");
  return `<article class="sm-sys sm-click ${sev}" data-storm="${i}" role="button" tabindex="0" title="See everything about this storm">
    <header class="sm-sys-h">
      <div class="sm-sys-name"><b>${esc(s.name || "Unnamed")}</b><span>${esc(kindName)}</span></div>
      ${cat ? `<span class="sm-cat">Cat ${cat}</span>` : `<span class="sm-cat ts">${esc(s.kind || "")}</span>`}
    </header>
    <div class="sm-sys-stats">
      ${mph != null ? `<div><span class="k">Winds</span><b>${mph} mph</b></div>` : ""}
      ${s.pressureMb != null ? `<div><span class="k">Pressure</span><b>${s.pressureMb} mb</b></div>` : ""}
      ${s.moveKt != null ? `<div><span class="k">Moving</span><b>${s.moveDir != null ? esc(dirToCompass(s.moveDir)) + " " : ""}${moveMph} mph</b></div>` : ""}
      ${stormCoord(s.lat, s.lon) ? `<div><span class="k">Position</span><b>${esc(stormCoord(s.lat, s.lon))}</b></div>` : ""}
    </div>
    ${states.length ? `<div class="sm-threat"><span class="k">Threatening</span>${states.map((x) => `<span class="sm-st">${esc(x)}</span>`).join("")}</div>` : ""}
    <footer class="sm-sys-f">
      <span class="sm-track">Full details &amp; forecast →</span>
      <span class="sm-upd">${s.at ? "updated " + esc(relTime(s.at)) : ""}</span>
    </footer>
  </article>`;
}

/* Flat by default. A tilted map is better at "where is it bad" and worse at
   reading any single tile, so the choice is the reader's and it sticks. */
function storm3d() {
  try { return !!localStorage.getItem("kl_storm_3d"); } catch (e) { return false; }
}

function shortWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/* The whole point of the screen: a state that just got hit becomes a call
   list. Companies, filtered to that state, ready to work. */
function openStateLeads(code) {
  S.state = code;
  const sel = $("filter-state");
  if (sel) sel.value = code;
  setTab("companies");
  toast("Companies in " + (STATE_NAME[code] || code));
}

/* ---------------- Research, the section ----------------
   The same briefings the reading pane shows, gathered in one place.

   The panel inside a lead is where research is USED — beside the phone
   number, above the notes you write after the call. But a panel below the
   fold of a reading pane is not a place anyone finds, and this was looked
   for in the sidebar three times before it was put there. Both exist: this
   is the way in and the record, that is the working surface. */

async function loadResearchCenter() {
  const el = $("research-center");
  if (!el) return;
  el.innerHTML = `<p class="act-empty">Loading briefings…</p>`;
  try {
    renderResearchCenter(await api("/api/research/recent"));
  } catch (e) {
    el.innerHTML = `<p class="act-empty">Could not load briefings (${esc(e.message)})</p>`;
  }
}

function renderResearchCenter(d) {
  const el = $("research-center");
  const rows = d.list || [];
  const badge = $("count-research");
  if (badge) badge.textContent = rows.length ? String(rows.length) : "";

  el.innerHTML = `
    <div class="act-card">
      <h4>How this works</h4>
      <p class="rc-how">Open any lead and press <b>Research this prospect</b> in its
        reading pane. It scrapes LinkedIn for what they do, anything recent worth
        congratulating them on, and what not to raise — about half a minute. The
        briefing is kept, so it costs nothing to read again.</p>
      <p class="rc-meter"><span class="rs-used">${d.used} of ${d.cap} used today</span></p>
    </div>

    <div class="act-card">
      <h4>Researched${rows.length ? ` — ${rows.length} lead${rows.length === 1 ? "" : "s"}` : ""}</h4>
      ${rows.length ? `<div class="task-list">${rows.map((r, i) => {
        const b = r.brief || {};
        const title = r.company || r.name || r.lead_code || "(no name)";
        const where = [r.city, r.state].filter(Boolean).join(", ");
        return `<div class="task-row rc-row" data-ri="${i}">
          <span class="avatar avatar-sm" style="background:${avColor(title)}">${esc(initials(title))}</span>
          <div class="task-main">
            <b>${esc(title)}</b>
            <span class="task-sub">${esc(b.headline || where || "")}</span>
          </div>
          ${b.congratulations && b.congratulations.length
            ? `<span class="rc-hook" title="${esc(b.congratulations[0])}">★ opener</span>` : ""}
          ${b.confidence ? `<span class="rs-conf rs-conf-${esc(b.confidence)}">${esc(b.confidence)}</span>` : ""}
          <span class="task-when">${esc(relTime(r.created_at))}</span>
        </div>`;
      }).join("")}</div>`
      : `<p class="act-empty">Nothing researched yet. Open a lead and press
           <b>Research this prospect</b> — it will appear here.</p>`}
    </div>`;

  /* Clicking a row goes to the lead itself, which is where the full briefing
     and everything you would do next already live. */
  el.querySelectorAll(".rc-row").forEach((row) =>
    row.addEventListener("click", () => {
      const r = rows[+row.dataset.ri];
      if (!r) return;
      const tab = KIND_TAB[r.kind] || "companies";
      setTab(tab);
      select({ Id: r.lead_id, _t: tab });
    }));
}

/* ---------------- Prospect research ----------------
   The briefing a rep reads before they dial: what this outfit does, what
   they have just done that is worth congratulating, what to open with, and
   what not to raise.

   Never fires on its own. Each briefing is a paid web search, there are
   36,000 leads, and a pane that researched whatever you clicked would spend
   the budget on browsing. One button, one lead; after that it is stored and
   re-read for free.

   Everything renders only if it has content. The server lets the model
   answer "I could not verify that" with an empty field, and an empty field
   must look like absence, not like a heading with nothing under it. */

const RESEARCH_STAGES = [
  "Looking them up…", "Reading their site…", "Checking recent news…",
  "Finding an opener…", "Writing the briefing…",
];

/* Called from renderDetail. Loads what we already hold — free — and leaves
   the button to buy a new one. */
async function loadResearch(r) {
  const box = $("research-body");
  if (!box) return;
  try {
    const d = await api(`/api/leads/${r.Id}/research`);
    renderResearch(r, d);
  } catch (e) {
    box.innerHTML = `<p class="rs-empty">Could not load the briefing (${esc(e.message)})</p>`;
  }
}

function runResearch(r) {
  const box = $("research-body");
  const btn = $("research-go");
  if (!box || !btn) return;
  btn.disabled = true;
  btn.textContent = "Researching…";

  /* The stages are honest about what is happening — a web search takes
     15-30 seconds and a bare spinner for that long reads as a hang. */
  let i = 0;
  box.innerHTML = `<p class="rs-working"><span class="rs-spin"></span><span id="rs-stage">${RESEARCH_STAGES[0]}</span></p>`;
  const tick = setInterval(() => {
    i = Math.min(i + 1, RESEARCH_STAGES.length - 1);
    const el = $("rs-stage");
    if (el) el.textContent = RESEARCH_STAGES[i];
  }, 4000);

  api(`/api/leads/${r.Id}/research`, { method: "POST" })
    .then((d) => {
      renderResearch(r, d);
      toast("Briefing ready");
    })
    .catch((e) => {
      box.innerHTML = `<p class="rs-empty">${esc(e.message)}</p>`;
    })
    .finally(() => {
      clearInterval(tick);
      /* The pane may have moved on to another lead while this ran — only
         touch the button if it is still the one we disabled. */
      const b = $("research-go");
      if (b) { b.disabled = false; b.textContent = "Research again"; }
    });
}

const rsList = (title, items, cls) => items.length ? `
  <div class="rs-block${cls ? " " + cls : ""}">
    <div class="rs-label">${title}</div>
    <ul class="rs-ul">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
  </div>` : "";

const rsLine = (title, value) => value ? `
  <div class="rs-block">
    <div class="rs-label">${title}</div>
    <p class="rs-text">${esc(value)}</p>
  </div>` : "";

function renderResearch(r, d) {
  const box = $("research-body");
  const btn = $("research-go");
  if (!box) return;
  const b = d.brief;

  if (btn) {
    btn.textContent = b ? "Research again" : "Research this prospect";
    btn.disabled = false;
  }

  if (!b) {
    box.innerHTML = `<p class="rs-empty">No briefing yet. Research pulls together
      what they do, anything recent worth congratulating them on, and what to
      open with — about half a minute.
      <span class="rs-used">${d.used} of ${d.cap} used today</span></p>`;
    return;
  }

  const p = b.person || {};
  const personBits = [
    rsLine("Their role", roleLabel(p.role)),
    rsLine("Background", p.background),
    rsLine("Education", p.education),
    rsList("Interests", p.interests || []),
  ].join("");

  box.innerHTML = `
    ${b.headline ? `<p class="rs-headline">${esc(b.headline)}</p>` : ""}
    ${b.confidence ? `<span class="rs-conf rs-conf-${esc(b.confidence)}"
      title="How much of this the model could verify, rather than infer">${esc(b.confidence)} confidence</span>` : ""}

    ${rsLine("What they do", b.whatTheyDo)}
    ${rsLine("Size", b.size)}
    ${rsList("Recent", b.recentSignals)}
    ${rsList("Worth congratulating them on", b.congratulations, "rs-good")}
    ${personBits}
    ${rsList("Talking points", b.talkingPoints)}
    ${rsList("Don't raise", b.avoid, "rs-avoid")}

    ${b.sources.length ? `<div class="rs-block">
      <div class="rs-label">Sources</div>
      <ul class="rs-ul rs-sources">${b.sources.map((u) => {
        let host = u;
        try { host = new URL(u).hostname.replace(/^www\./, ""); } catch (e) { /* show it raw */ }
        return `<li><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(host)}</a></li>`;
      }).join("")}</ul>
    </div>` : ""}

    <p class="rs-foot">
      ${d.meta ? `${b.source === "linkedin" ? "From LinkedIn" : "From a web search"}
        · researched ${esc(relTime(d.meta.at))} by ${esc(d.meta.actor)}` : ""}
      <span class="rs-used">${d.used} of ${d.cap} used today</span>
    </p>
    <p class="rs-warn">${b.source === "linkedin"
      ? "Summarised from LinkedIn's own page for them."
      : "Written from a web search."} Check anything you plan to say out loud —
      a wrong detail is worse than none.</p>`;
}

/* ---------------- Call report (admin) ----------------
   Today's calls per person, and who is working right now. Deliberately narrow:
   this answers "what is happening on the floor this morning", and Team
   activity answers "what happened over the last month".

   Two honesty rules are baked into the rendering, because the data cannot
   carry them on its own:
     - a call recorded as 'placed' went out through Zoho's own dialler, so no
       result came back. It counts as a call and never as a connection, and
       the pane says so when there are any.
     - only calls made through this app exist at all. Someone dialling from
       their handset shows as zero, which is why the heading counts callers
       rather than claiming the rest made no calls. */

let callPollTimer = null;

function stopCallPolling() {
  if (!callPollTimer) return;
  clearInterval(callPollTimer);
  callPollTimer = null;
  $("calls-live")?.setAttribute("aria-pressed", "false");
}

function toggleCallPolling() {
  if (callPollTimer) return stopCallPolling();
  callPollTimer = setInterval(() => loadCallReport(true), 30000);
  $("calls-live")?.setAttribute("aria-pressed", "true");
  loadCallReport(true);
}

/* quiet=true is the poll: repaint without the "Loading…" flash, or the pane
   would blink every 30 seconds under someone who is reading it. */
/* Which day the report is showing. Empty means today — and today is the only
   day read live, so leaving it empty is also what keeps auto-refresh useful. */
let callsDate = "";

async function loadCallReport(quiet = false) {
  const el = $("calls-body");
  if (!el) return;
  callsPerson = ""; callsPersonLabel = "";   // back to the whole team
  if (!quiet) el.innerHTML = `<p class="act-empty">Reading calls…</p>`;
  const minutes = +$("calls-minutes")?.value || 15;
  const q = `/api/calls/report?minutes=${minutes}&days=30`
    + (callsDate ? `&date=${encodeURIComponent(callsDate)}` : "");
  try {
    const d = await api(q);
    callsDate = d.date;
    const picker = $("calls-date");
    if (picker) { picker.value = d.date; picker.max = d.today; }
    renderCallReport(d);
  } catch (e) {
    if (quiet) return;                   // a failed poll keeps the last good view
    el.innerHTML = `<p class="act-empty">Could not load the call report (${esc(e.message)})</p>`;
  }
}

/* ---------------- downloading the report ----------------

   Who the download is for follows what you are looking at: on the team report
   it is everyone, and while a person's record is open it is that person. That
   is the behaviour people expect from a Download button and it saves a second
   control that would only ever be set to match the screen. */
let callsPerson = "";               // whose record is open; "" = the whole team
let callsPersonLabel = "";          // their display name, for the download panel


const ymd = (d) => d.toISOString().slice(0, 10);

/* The period, as from/to. Weeks start Monday: a sales week does, and a Sunday
   start puts Monday's calls in "last week" every Monday morning. */
function dlRange(kind) {
  const now = new Date();
  const t = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dow = (t.getUTCDay() + 6) % 7;                 // Mon = 0
  const monday = new Date(t); monday.setUTCDate(t.getUTCDate() - dow);
  switch (kind) {
    case "week":  return { from: ymd(monday), to: ymd(t) };
    case "lastweek": {
      const s = new Date(monday); s.setUTCDate(monday.getUTCDate() - 7);
      const e = new Date(monday); e.setUTCDate(monday.getUTCDate() - 1);
      return { from: ymd(s), to: ymd(e) };
    }
    case "month":
      return { from: ymd(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1))), to: ymd(t) };
    case "lastmonth": {
      const s = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1));
      const e = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0));
      return { from: ymd(s), to: ymd(e) };
    }
    default:
      return { from: $("calls-dl-from")?.value || ymd(t),
               to: $("calls-dl-to")?.value || ymd(t) };
  }
}

function downloadCallReport() {
  const kind = $("calls-dl-range")?.value || "week";
  const { from, to } = dlRange(kind);
  if (!from || !to) return toast("Pick both dates first");
  const shape = $("calls-dl-shape")?.value || "summary";
  const q = new URLSearchParams({ from, to, shape });
  if (callsPerson) q.set("who", callsPerson);
  /* A plain navigation, not fetch(): the browser then handles the download,
     the filename from Content-Disposition is honoured, and the cookie goes
     with it. Reading it into memory first would buy nothing. */
  window.location.href = "/api/calls/export?" + q.toString();
  toast(`Downloading ${from === to ? from : from + " to " + to}`
    + (callsPerson ? " for " + callsPerson.split("@")[0] : "") + "…");
}

/* Step a day at a time. Never past today — there is nothing there, and an
   empty tomorrow looks like a bug rather than the calendar. */
function stepCallDate(delta) {
  const base = callsDate || new Date().toISOString().slice(0, 10);
  const d = new Date(base + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  const next = d.toISOString().slice(0, 10);
  const max = $("calls-date")?.max || next;
  callsDate = next > max ? max : next;
  stopCallPolling();                     // polling a fixed past day is pointless
  loadCallReport();
}

function fmtDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  if (!s) return "–";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

/* What someone is doing, in words a manager reads rather than a log verb. */
const ACT_WORDS = {
  call: "on a call", open: "reading", status: "updating a status",
  note: "writing a note", owner: "reassigning", favorite: "starring",
  unfavorite: "unstarring", remove: "adding a DNC", import: "importing",
  jobsearch: "running a job search", enrich: "enriching",
};

function renderCallReport(d) {
  const el = $("calls-body");
  const t = d.totals;
  const people = (d.people || []).slice().sort((a, b) =>
    (b.calls - a.calls) || (b.assigned - a.assigned) ||
    a.label.localeCompare(b.label));
  const peak = Math.max(1, ...people.map((p) => p.calls));
  const live = people.filter((p) => p.active);

  /* Connecting a phone is the rep's own job — nobody can do it for them — so
     the prompt lives where they already look at their calling. */
  /* Switching the old provider off is the owner's call, and it belongs next
     to the evidence that the new one is working rather than in a settings
     screen nobody opens. */
  const zohoSwitch = !isOwner() ? "" : VOICE.zohoOff
    ? `<button class="btn-ghost rc-zoho" id="zoho-on"
         title="Reps without RingCentral will be handed to Zoho again">Zoho off — turn back on</button>`
    : `<button class="btn-ghost rc-zoho" id="zoho-off"
         title="Reps without RingCentral will copy numbers instead of opening Zoho">Turn off Zoho</button>`;

  /* THREE states, not two, and the switch is NOT nested inside them.

     It used to be: `!VOICE.rcEnabled ? "" : connected ? <bar + switch> : <connect>`.
     Two traps came out of that one line.

     First, the Zoho switch lived inside the connected branch, so the moment
     RingCentral was unconfigured or a seat dropped, the owner lost the only
     control for turning Zoho back ON — exactly when they most need it. It is
     its own row now and renders for an owner whatever the phone is doing.

     Second, registering can FAIL after connecting (an expired grant, a CSP
     blocking the SIP socket, no VoIP permission on the app). The bar said
     "connected", no launcher appeared, and nothing anywhere said why. The
     failure is now a state of its own, carrying the reason. */
  const rcFailed = VOICE.rcEnabled && VOICE.rcConnected && VOICE.rcError;
  const rcBar = !VOICE.rcEnabled
    ? `<div class="rc-bar">
         <b>RingCentral is not set up on this server.</b>
         Set RINGCENTRAL_CLIENT_ID and RINGCENTRAL_CLIENT_SECRET in the
         environment — until then every rep falls back to ${VOICE.zohoOff ? "copying numbers" : "Zoho"}.
       </div>`
    : rcFailed
      ? `<div class="rc-bar">
           <span class="rc-dot"></span>
           <b>RingCentral did not register — the dialler is off.</b>
           ${esc(VOICE.rcError)}
           <a class="btn-primary rc-go" href="/api/voice/rc/connect">Reconnect</a>
           <button class="btn-ghost rc-off" id="rc-disconnect">Disconnect</button>
         </div>`
      : VOICE.rcConnected
        ? `<div class="rc-bar on">
             <span class="rc-dot"></span>
             RingCentral connected${VOICE.rcExtension ? " · extension " + esc(VOICE.rcExtension) : ""}${
               VOICE.sandbox ? ` <span class="asg-tag">sandbox — test numbers only</span>` : ""}
             <button class="btn-ghost rc-off" id="rc-disconnect">Disconnect</button>
           </div>`
        : `<div class="rc-bar">
             <b>Dial from your own RingCentral extension.</b>
             Sign in once and calls go out as you — your caller ID, your call log.
             <a class="btn-primary rc-go" href="/api/voice/rc/connect">Connect RingCentral</a>
           </div>`;

  const zohoBar = !zohoSwitch ? "" : `<div class="rc-bar">
      <span>Fallback for reps without RingCentral:
        <b>${VOICE.zohoOff ? "off — they copy the number" : "Zoho"}</b></span>
      ${zohoSwitch}
    </div>`;

  /* The 30-day strip. This is the whole point of storing days: the shape of
     the last month, rather than one number that resets every midnight. */
  const hist = d.history || [];
  const hPeak = Math.max(1, ...hist.map((h) => h.calls));
  const histHtml = hist.length ? `
    <div class="act-card">
      <h4>Last ${hist.length} days — ${hist.reduce((a, h) => a + h.calls, 0).toLocaleString()} calls</h4>
      <div class="hist-strip">
        ${hist.map((h) => `
          <button class="hist-col${h.date === d.date ? " on" : ""}${h.today ? " is-today" : ""}"
                  data-date="${h.date}"
                  title="${esc(h.date)} — ${h.calls} call${h.calls === 1 ? "" : "s"}, ${h.connected} connected${h.today ? " (today, still counting)" : ""}">
            <span class="hist-bar" style="height:${Math.max(2, Math.round((h.calls / hPeak) * 100))}%">
              <span class="hist-fill" style="height:${h.calls ? Math.round((h.connected / h.calls) * 100) : 0}%"></span>
            </span>
          </button>`).join("")}
      </div>
      <p class="asg-foot">Each bar is a day; the solid part is the calls that
        connected. Click one to read that day. The last bar is today and is
        still counting.</p>
    </div>` : "";

  el.innerHTML = `
    ${rcBar}
    ${crmMeBar()}
    ${zohoBar}
    <div class="kpi-strip">
      ${kpiTile(d.isToday ? "Calls today" : "Calls", t.calls.toLocaleString(),
        t.callers === 1 ? "by 1 person" : `by ${t.callers} people`)}
      ${kpiTile("Connected", t.connected.toLocaleString(),
        t.calls ? `${Math.round((t.connected / t.calls) * 100)}% of calls` : "none yet")}
      ${kpiTile("Talk time", fmtDuration(t.seconds),
        t.seconds ? "total" : "not reported by the hand-off dialler")}
      ${kpiTile("Working now", String(t.activeNow),
        `active in the last ${d.liveMinutes} min`)}
    </div>

    ${d.isToday ? "" : `<div class="asg-demo">Showing <b>${esc(dayLabel(d.date))}</b>,
      read from the stored daily record. “Working now” is always live and so
      refers to right now, not to that day.</div>`}

    ${histHtml}

    ${t.placed ? `<div class="asg-demo">${t.placed.toLocaleString()} of today's
      calls were handed to Zoho's own dialler, which never tells us how they
      went — they count as calls and never as connections. Switching
      ZOHO_DIAL_MODE to the in-page softphone is what makes the connected
      figure complete.</div>` : ""}

    <div class="act-card">
      <h4>Working now${live.length ? "" : " — nobody in the last "
        + d.liveMinutes + " minutes"}</h4>
      ${live.length ? `<div class="live-grid">
        ${live.map((p) => `
          <div class="live-card${p.active.action === "call" ? " on-call" : ""}">
            <span class="avatar" style="background:${avColor(p.email)}">${esc(initials(p.label))}</span>
            <div class="live-who">
              <b>${esc(p.label)}</b>
              <span class="live-doing">${esc(ACT_WORDS[p.active.action] || p.active.action)}${
                p.active.leadName ? " · " + esc(p.active.leadName) : ""}</span>
              <span class="live-when">${esc(relTime(p.active.at))}</span>
            </div>
          </div>`).join("")}
      </div>` : `<p class="act-empty">Nothing in the last ${d.liveMinutes} minutes.
        Only work done inside this app shows here — a call dialled from a
        handset is invisible to us.</p>`}
    </div>

    <div class="act-card">
      <h4>Today, per person — ${t.members} on the team</h4>
      <table class="asg-table">
        <thead><tr>
          <th>Person</th><th class="n">Calls</th><th class="n">Connected</th>
          <th class="n">Talk time</th><th class="n">Assigned</th><th>Share of calls</th>
        </tr></thead>
        <tbody>
          ${people.map((p) => `
            <tr class="person-row${p.ghost ? " asg-ghost" : ""}" data-person="${esc(p.email)}"
                title="Open ${esc(p.label)}'s record">
              <td>
                <span class="avatar avatar-sm" style="background:${avColor(p.email)}">${esc(initials(p.label))}</span>
                <span class="asg-name">${esc(p.label)}</span>
                ${p.role !== "member" ? `<span class="asg-tag">${esc(roleLabel(p.role))}</span>` : ""}
                ${p.ghost ? `<span class="asg-tag" title="Calls under a name that is nobody's account">no account</span>` : ""}
                ${p.active ? `<span class="live-dot" title="Active just now"></span>` : ""}
              </td>
              <td class="n"><b>${p.calls.toLocaleString()}</b></td>
              <td class="n">${p.connected.toLocaleString()}${
                p.placed ? ` <span class="asg-tag" title="Handed to Zoho's dialler — the result never came back">+${p.placed} unknown</span>` : ""}</td>
              <td class="n">${fmtDuration(p.seconds)}</td>
              <td class="n">${p.assigned.toLocaleString()}</td>
              <td class="asg-bar-cell">
                <span class="asg-bar" style="width:${Math.round((p.calls / peak) * 100)}%"></span>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>
      <p class="asg-foot">Calls are recorded by the browser that made them, so
        this counts calls placed <b>through the dashboard</b>. A rep who dials
        from their handset or the Zoho app directly appears here as zero.</p>
    </div>`;
}

/* "Wed 29 Sep" from "2026-09-29". Noon UTC so the date cannot slip a day
   either side of a timezone. */
function dayLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00Z");
  return d.toLocaleDateString(undefined,
    { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/* ---------- one person, in depth ----------

   The team table answers "who is calling". This answers the question a manager
   asks next — what is this person actually doing — which needs a different
   shape: a run of days, the outcome mix, and the calls themselves with the
   companies named. */
async function openPerson(email) {
  const el = $("calls-body");
  if (!el) return;
  stopCallPolling();
  callsPerson = email;            // Download now means this person
  callsPersonLabel = email;
  el.innerHTML = `<p class="act-empty">Reading ${esc(email)}…</p>`;
  try {
    renderPerson(await api(`/api/calls/person/${encodeURIComponent(email)}?days=30`));
  } catch (e) {
    el.innerHTML = `<p class="act-empty">Could not open that person (${esc(e.message)})
      <button class="btn-ghost" id="person-back">Back to the report</button></p>`;
    $("person-back")?.addEventListener("click", () => loadCallReport());
  }
}

const OUTCOME_WORDS = {
  connected: "Connected", "no-answer": "No answer", busy: "Busy",
  failed: "Failed", cancelled: "Cancelled", placed: "Handed to Zoho",
  unknown: "Not recorded",
};

function renderPerson(p) {
  const el = $("calls-body");
  callsPersonLabel = p.label;          // the download panel names who it is for
  const t = p.totals;
  const peak = Math.max(1, ...p.daily.map((d) => +d.calls));
  const rate = t.calls ? Math.round((t.connected / t.calls) * 100) : 0;
  const oTotal = p.outcomes.reduce((a, o) => a + o.n, 0) || 1;

  el.innerHTML = `
    <div class="person-head">
      <button class="btn-ghost" id="person-back">‹ All people</button>
      <span class="avatar" style="background:${avColor(p.email)}">${esc(initials(p.label))}</span>
      <div class="person-who">
        <h3>${esc(p.label)}</h3>
        <span class="person-sub">${esc(p.email)}
          ${p.role ? `<span class="asg-tag">${esc(roleLabel(p.role))}</span>` : ""}
          ${!p.account ? `<span class="asg-tag" title="Calls logged under a name that is nobody's account">no account</span>` : ""}
          ${p.disabled ? `<span class="asg-tag">disabled</span>` : ""}</span>
      </div>
    </div>

    <div class="kpi-strip">
      ${kpiTile("Calls", t.calls.toLocaleString(), `in the last ${p.days} days`)}
      ${kpiTile("Connected", t.connected.toLocaleString(),
        t.calls ? `${rate}% of their calls` : "none yet")}
      ${kpiTile("Busiest average", String(p.perActiveDay),
        t.activeDays ? `per day, over ${t.activeDays} day${t.activeDays === 1 ? "" : "s"} they called` : "no days with calls")}
      ${kpiTile("Open follow-ups", String(p.followups.open),
        p.followups.overdue ? `${p.followups.overdue} overdue` : "none overdue")}
    </div>

    <div class="act-card">
      <h4>Their day, for ${p.days} days</h4>
      <div class="hist-strip tall">
        ${p.daily.map((d) => `
          <button class="hist-col${d.today ? " is-today" : ""}" data-day="${d.date}"
            title="${esc(dayLabel(d.date))} — ${d.calls} call${+d.calls === 1 ? "" : "s"}, ${d.connected} connected">
            <span class="hist-bar" style="height:${Math.max(2, Math.round((+d.calls / peak) * 100))}%">
              <span class="hist-fill" style="height:${+d.calls ? Math.round((+d.connected / +d.calls) * 100) : 0}%"></span>
            </span>
          </button>`).join("")}
      </div>
      <p class="asg-foot">Solid part connected. Empty days are days with no
        calls logged through the dashboard — which is not the same as a day off.</p>
    </div>

    <div class="person-cols">
      <div class="act-card">
        <h4>How the calls went</h4>
        ${p.outcomes.length ? `<table class="asg-table">
          <tbody>${p.outcomes.map((o) => `
            <tr><td>${esc(OUTCOME_WORDS[o.outcome] || o.outcome)}</td>
                <td class="n"><b>${o.n}</b></td>
                <td class="asg-bar-cell"><span class="asg-bar"
                  style="width:${Math.round((o.n / oTotal) * 100)}%"></span></td></tr>`).join("")}
          </tbody></table>`
          : `<p class="act-empty">No calls in this window.</p>`}
      </div>

      <div class="act-card">
        <h4>Their book</h4>
        <table class="asg-table"><tbody>
          <tr><td>Leads assigned</td><td class="n"><b>${(+p.book.assigned).toLocaleString()}</b></td></tr>
          <tr><td>With a phone number</td><td class="n">${(+p.book.callable).toLocaleString()}</td></tr>
          <tr><td>Worked at least once</td><td class="n">${(+p.book.worked).toLocaleString()}</td></tr>
          <tr><td>Never touched</td><td class="n">${(+p.book.untouched).toLocaleString()}</td></tr>
        </tbody></table>
      </div>

      <div class="act-card">
        <h4>Everything else they did</h4>
        ${p.actions.length ? `<table class="asg-table"><tbody>
          ${p.actions.map((a) => `<tr>
            <td>${esc(ACT_WORDS[a.action] || a.action)}</td>
            <td class="n"><b>${a.n}</b></td>
            <td class="n">${esc(relTime(a.last))}</td></tr>`).join("")}
        </tbody></table>` : `<p class="act-empty">Nothing logged in this window.</p>`}
      </div>
    </div>

    <div class="act-card">
      <h4>Their last ${p.recent.length} call${p.recent.length === 1 ? "" : "s"}</h4>
      ${p.recent.length ? `<table class="asg-table">
        <thead><tr><th>When</th><th>Company</th><th>Outcome</th><th class="n">Length</th></tr></thead>
        <tbody>${p.recent.map((c) => `
          <tr>
            <td>${esc(relTime(c.at))}</td>
            <td>${c.lead_id && c.lead_kind
              ? `<a href="#" class="person-lead" data-lead="${c.lead_id}" data-kind="${esc(c.lead_kind)}">${esc(c.lead_name || c.lead_code || "—")}</a>`
              : esc(c.lead_name || c.lead_code || "—")}</td>
            <td><span class="asg-tag">${esc(OUTCOME_WORDS[c.outcome] || c.outcome || "—")}</span></td>
            <td class="n">${c.seconds ? fmtDuration(c.seconds) : "—"}</td>
          </tr>`).join("")}
        </tbody></table>`
        : `<p class="act-empty">No calls recorded for this person yet.</p>`}
      <p class="asg-foot">Only calls placed through the dashboard. A call made
        from a handset or the Zoho app never reaches us and cannot appear here.</p>
    </div>`;

  $("person-back")?.addEventListener("click", () => loadCallReport());
  /* Same route into a lead the activity feed uses: switch to the tab that
     holds that kind, then select it. */
  el.querySelectorAll(".person-lead").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const tab = KIND_TAB[a.dataset.kind];
      if (!tab) return;
      setTab(tab);
      select({ Id: +a.dataset.lead, _t: tab });
    }));
}

function kpiTile(label, value, sub) {
  return `<div class="kpi-tile"><div class="kpi-label">${esc(label)}</div>
    <div class="kpi-value">${esc(value)}</div>
    <div class="kpi-sub">${esc(sub)}</div></div>`;
}

/* ---------------- My tasks ----------------
   Everyone's own queue, the manager's included. The order is the point: a
   lead this person has never opened outranks one they worked this morning,
   so the top of the list is always the most neglected thing they own. */

async function loadTasks() {
  const el = $("tasks-body");
  if (!el) return;
  el.innerHTML = `<p class="act-empty">Building your queue…</p>`;
  try {
    renderTasks(await api("/api/tasks"));
  } catch (e) {
    el.innerHTML = `<p class="act-empty">Could not load your tasks (${esc(e.message)})</p>`;
  }
}

function taskRows(rows, emptyText) {
  if (!rows.length) return `<p class="act-empty">${emptyText}</p>`;
  return `<div class="task-list">${rows.map((r, i) => {
    const row = fromApi(r);
    const name = displayName(row, row._t);
    return `<div class="task-row" data-ti="${i}">
      <span class="avatar avatar-sm" style="background:${avColor(name)}">${esc(initials(name))}</span>
      <div class="task-main">
        <b>${esc(name)}</b>
        <span class="task-sub">${esc([row.City, row.State].filter(Boolean).join(", ")
          || row.Industry || row["Lead Code"] || "")}</span>
      </div>
      ${statusChip(row.Status)}
      <span class="task-when">${r.touched_at
        ? esc(relTime(r.touched_at)) : `<i class="task-fresh">never opened</i>`}</span>
      ${row.Phone ? `<a class="dial task-dial" href="tel:${esc(row.Phone)}"
          data-dial="${esc(row.Phone)}" data-dial-id="${esc(row.Id)}"
          data-dial-name="${esc(name)}" title="Call with Zoho Voice">☎</a>` : ""}
    </div>`;
  }).join("")}</div>`;
}

function renderTasks(d) {
  const el = $("tasks-body");
  const c = d.counts || {};
  /* The badge is the open count, not the whole book: a nav badge is a
     to-do, and 900 qualified leads is not one. */
  const badge = $("count-tasks");
  if (badge) badge.textContent = c.open ? c.open.toLocaleString() : "";
  const done = d.done || {};
  const queue = d.queue || [];
  const starred = d.starred || [];
  const fu = d.followups || [];

  el.innerHTML = `
    <div class="kpi-strip">
      ${kpiTile("Assigned to me", (c.assigned || 0).toLocaleString(),
        `${(c.open || 0).toLocaleString()} still to work`)}
      ${kpiTile("Calls today", (done.calls || 0).toLocaleString(),
        `${(done.connected || 0).toLocaleString()} connected`)}
      ${kpiTile("Leads worked today", (done.leads_worked || 0).toLocaleString(),
        `${(done.statuses || 0).toLocaleString()} status changes`)}
      ${kpiTile("Qualified", (c.Qualified || 0).toLocaleString(), "all time, mine")}
    </div>

    ${fu.length ? `<div class="act-card">
      <h4>⏰ Follow back${fu.some((f) => new Date(f.due_at) <= new Date())
        ? ` — ${fu.filter((f) => new Date(f.due_at) <= new Date()).length} due now` : ""}</h4>
      <div class="task-list">${fu.map((f, i) => {
        const overdue = new Date(f.due_at) <= new Date();
        const title = f.company || f.name || f.lead_code || "(no name)";
        return `<div class="task-row fu-task" data-fi="${i}">
          <span class="avatar avatar-sm" style="background:${avColor(title)}">${esc(initials(title))}</span>
          <div class="task-main">
            <b>${esc(title)}</b>
            <span class="task-sub">${esc(f.note || [f.city, f.state].filter(Boolean).join(", "))}</span>
          </div>
          <span class="fu-chip${overdue ? " overdue" : ""}">${esc(fmtWhen(new Date(f.due_at)))}</span>
          <button type="button" class="btn-ghost fu-done" data-fd="${i}"
                  title="Done — stop reminding me">✓</button>
        </div>`;
      }).join("")}</div>
    </div>` : ""}

    <div class="act-card">
      <h4>Next up — oldest first${queue.length >= d.limit
        ? `, showing ${d.limit} of ${(c.open || 0).toLocaleString()}` : ""}</h4>
      ${taskRows(queue, c.assigned
        ? "Nothing open — everything assigned to you is either qualified or closed."
        : "Nothing is assigned to you yet. Your manager assigns leads from the Assignments board.")}
    </div>

    <div class="act-card">
      <h4>★ Starred</h4>
      ${taskRows(starred, "Nothing starred. Use the ★ on a lead to keep it here.")}
    </div>`;

  /* One handler per section, reading back the row the index came from — the
     dial link inside a row is left alone, since the delegated a.dial handler
     already owns it and clicking the phone should not also open the lead. */
  const open = (rows) => (e) => {
    if (e.target.closest("a.dial")) return;
    const r = rows[+e.currentTarget.dataset.ti];
    if (!r) return;
    const row = fromApi(r);
    setTab(row._t);                      // leaves this pane, shows the list
    select(row);
  };
  el.querySelectorAll(".fu-task").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".fu-done")) return;   // the tick is not "open it"
      const f = fu[+row.dataset.fi];
      if (!f) return;
      const tab = KIND_TAB[f.kind] || "companies";
      setTab(tab);
      select({ Id: f.lead_id, _t: tab });
    });
  });
  el.querySelectorAll(".fu-done").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const f = fu[+btn.dataset.fd];
      if (!f) return;
      btn.disabled = true;
      try { await api(`/api/followups/${f.id}/done`, { method: "POST" }); loadTasks(); }
      catch (ex) { toast("Could not mark it done: " + ex.message); btn.disabled = false; }
    }));

  const cards = el.querySelectorAll(".act-card");
  /* The follow-back card is optional, so address these by content rather
     than by position — an index that shifts when a card appears is how the
     starred list ends up opening queue rows. */
  const cardFor = (heading) => [...cards].find((c) =>
    (c.querySelector("h4")?.textContent || "").includes(heading));
  cardFor("Next up")?.querySelectorAll(".task-row").forEach((r) =>
    r.addEventListener("click", open(queue)));
  cardFor("Starred")?.querySelectorAll(".task-row").forEach((r) =>
    r.addEventListener("click", open(starred)));
}

async function loadStats() {
  const el = $("stats-body");
  if (!el) return;
  $("act-logs")?.setAttribute("aria-pressed", String(actFull));
  el.innerHTML = `<p class="act-empty">Loading the log…</p>`;
  try {
    renderStats(await api(
      `/api/activity?days=${$("act-days")?.value || 30}${actFull ? "&full=1" : ""}`));
  } catch (e) {
    el.innerHTML = `<p class="act-empty">Could not load activity (${esc(e.message)})</p>`;
  }
}

/* stable person -> colour slot, by share of the window's activity; past 8
   people the tail folds into a grey "Other" rather than inventing hues */
function actSlots(perPerson) {
  const map = new Map();
  perPerson.slice(0, ACT_SLOTS).forEach((p, i) => map.set(p.who, i + 1));
  return map;
}
const actColor = (slot) => slot ? `var(--cat-${slot})` : "var(--ink-3)";

function actChart(d, slots) {
  const days = d.perDay;
  const w = 720, h = 120, gap = days.length > 45 ? 1 : 2;
  const max = Math.max(...days.map((x) => x.total), 1);
  const bw = Math.max(2, (w - gap * (days.length - 1)) / days.length);
  let bars = "";
  days.forEach((day, i) => {
    const x = (i * (bw + gap)).toFixed(1);
    let y = h;                            // stack up from the baseline
    const entries = Object.entries(day.by_who)
      .sort((a, b) => (slots.get(a[0]) || 99) - (slots.get(b[0]) || 99));
    for (const [who, n] of entries) {
      const bh = (n / max) * (h - 6);
      y -= bh;
      bars += `<rect x="${x}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}"
        height="${Math.max(bh - 1, 0.5).toFixed(1)}"
        fill="${actColor(slots.get(who))}"
        ><title>${esc(day.date)} — ${esc(who)}: ${n} ${d.full ? "action" : "status change"}${n === 1 ? "" : "s"}</title></rect>`;
    }
  });
  return `<div class="act-chart">
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}</svg>
    <div class="act-axis"><span>${esc(days[0]?.date || "")}</span>
      <span>peak ${max.toLocaleString()} / day</span>
      <span>${esc(days[days.length - 1]?.date || "")}</span></div>
  </div>`;
}

function actLegend(perPerson, slots) {
  if (!perPerson.length) return "";
  const item = (p) => {
    const acts = Object.entries(p.by_action)
      .map(([a, n]) => `${a} ${n}`).join(" · ");
    return `<span class="fact" title="${esc(acts)}">
      <i class="dot" style="background:${actColor(slots.get(p.who))}"></i>
      ${esc(p.who)} <b>${p.total.toLocaleString()}</b></span>`;
  };
  return `<div class="act-legend">${perPerson.map(item).join("")}</div>`;
}

/* one feed line: who did what to which lead, in words */
function feedLine(f) {
  const name = f.lead_name ? `<b>${esc(f.lead_name)}</b>` : "a lead";
  const m = f.meta || {};
  /* A bulk action is one log row for the whole selection (server/bulk.js) —
     writing 300 of them would push every other line off this feed. lead_name
     is already "300 leads", so these read as sentences; there is no single
     lead to click through to, which .no-lead handles. */
  if (m.bulk) {
    switch (f.action) {
      case "owner": return `assigned ${name} to <b>${esc(f.to_value)}</b>` +
        ` <span class="feed-what">(in bulk)</span>`;
      case "remove": return `banned ${m.numbers ?? "?"} number${m.numbers === 1 ? "" : "s"}` +
        ` and removed ${name}` +
        (f.to_value ? ` <span class="feed-what">(${esc(f.to_value)})</span>` : "");
      case "delete": return `deleted ${name} to the trash` +
        (m.jobs > 0 ? ` <span class="feed-what">including ${m.jobs} job posting${
          m.jobs === 1 ? "" : "s"}</span>` : "");
      default: break;
    }
  }
  switch (f.action) {
    case "open": return `opened ${name}`;
    case "status": return `set ${name} to <b>${esc(f.to_value)}</b>` +
      (f.from_value ? ` <span class="feed-what">(was ${esc(f.from_value)})</span>` : "");
    case "owner": return `assigned ${name} to <b>${esc(f.to_value)}</b>`;
    case "favorite": return `favorited ${name}`;
    case "unfavorite": return `unfavorited ${name}`;
    case "note": return `noted on ${name}<span class="feed-what">: ${esc(f.to_value || "")}</span>`;
    case "remove": return `removed ${name}` +
      (m.affected > 1 ? ` <span class="feed-what">and ${m.affected - 1} more sharing its number</span>` : "") +
      (f.to_value ? ` <span class="feed-what">(${esc(f.to_value)})</span>` : "");
    case "restore": return `restored ${name}`;
    case "delete": return `deleted ${name} to the trash` +
      (m.jobs > 0 ? ` <span class="feed-what">with ${m.jobs} job posting${m.jobs === 1 ? "" : "s"}</span>` : "");
    case "undelete": return `restored ${name} from the trash` +
      (m.affected > 1 ? ` <span class="feed-what">with ${m.affected - 1} more</span>` : "");
    case "purge": return `emptied the trash <span class="feed-what">(${
      m.count ?? "?"} lead${m.count === 1 ? "" : "s"} destroyed)</span>`;
    case "import": return `imported <b>${esc(f.to_value || "a file")}</b>` +
      (m.inserted ? ` <span class="feed-what">(${JSON.stringify(m.inserted).replace(/[{}"]/g, "")})</span>` : "");
    case "jobsearch": return `ran a${{ indeed: "n Indeed", google: " Google Jobs" }[m.scraper]
      || " LinkedIn"} job search <span class="feed-what">(${m.found ?? "?"} found, ${m.inserted ?? "?"} new${
      m.companies ? `, ${m.companies} compan${m.companies === 1 ? "y" : "ies"}` : ""}${
      m.phonesFilled ? `, ${m.phonesFilled} phone${m.phonesFilled === 1 ? "" : "s"} matched` : ""})</span>`;
    case "enrich": {
      const how = [
        m.domain ? `${m.domain} by website match` : "",
        m.namecity ? `${m.namecity} by name+city` : "",
        m.web ? `${m.web} read off their websites` : "",
      ].filter(Boolean).join(", ");
      return `matched phone numbers for <b>${m.filled ?? "?"}</b> of ${
        m.scanned ?? "?"} phone-less job companies` +
        (how ? ` <span class="feed-what">(${how})</span>` : "");
    }
    default: return esc(f.action);
  }
}

function renderStats(d) {
  const el = $("stats-body");
  const slots = actSlots(d.perPerson);
  if (!d.total) {
    el.innerHTML = `<div class="act-card"><p class="act-empty">${d.full
      ? `Nothing in the log for this window. Activity is recorded from the
         moment the new system went live — as the team opens leads, sets
         statuses and writes notes, it shows up here.`
      : `No status changes in this window. The Logs button shows everything
         else the team did — opens, notes, favorites, imports.`}</p></div>`;
    return;
  }
  el.innerHTML = `
    <div class="act-card">
      <h4>${d.full ? "Actions" : "Status changes"} per day — ${d.total.toLocaleString()} in the last ${d.days} days</h4>
      ${actChart(d, slots)}
      ${actLegend(d.perPerson, slots)}
    </div>
    <div class="act-card">
      <h4>${d.full ? "Latest activity" : "Latest status changes"}</h4>
      ${d.feed.map((f, i) => `
        <div class="feed-row${f.lead_id && f.lead_kind ? "" : " no-lead"}" data-fi="${i}">
          <span class="avatar avatar-sm" style="background:${avColor(f.actor)}">${esc(initials(f.actor))}</span>
          <div class="feed-main"><b>${esc(f.actor)}</b> ${feedLine(f)}</div>
          <span class="feed-when">${esc(relTime(f.at))}</span>
        </div>`).join("")}
    </div>`;
  el.querySelectorAll(".feed-row:not(.no-lead)").forEach((row) =>
    row.addEventListener("click", () => {
      const f = d.feed[+row.dataset.fi];
      const tab = KIND_TAB[f.lead_kind];
      if (!tab) return;
      setTab(tab);                       // leaves the stats pane, shows the list
      select({ Id: f.lead_id, _t: tab });
    }));
}

let toastTimer;
// ms is optional: a diagnostic worth copying down needs longer than a
// confirmation that something saved.
function toast(msg, ms) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms || 3500);
}

/* Undo toast (bottom right, 5 seconds): restores exactly the id set the
   remove swept — ban lifted too. The window is deliberately short; after it
   closes the lead is the manager's to restore from the DNC tab. */
let undoTimer;
function showUndo(msg, anchorId, ids) {
  const el = $("undo-toast");
  $("undo-msg").textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => el.classList.add("hidden"), 5000);
  $("undo-btn").onclick = async () => {
    clearTimeout(undoTimer);
    el.classList.add("hidden");
    try {
      await api(`/api/leads/${anchorId}/restore`, {
        method: "POST", body: JSON.stringify({ ids: ids || [] }),
      });
      toast("Removal undone");
      loadList(); refreshCounts();
    } catch (ex) {
      toast("Could not undo: " + ex.message);
    }
  };
}

/* ---------------- boot + events ---------------- */
/* ---------------- world clocks ----------------
   Five clocks in the top bar, each with its own time zone. The floor sits
   in India and rings the US, so "is it a decent hour in Texas?" is asked all
   day. Click a clock to change its zone; choices live in this browser.

   Everything comes from Intl — the abbreviation (EDT/EST, BST/GMT, IST)
   and the offset follow daylight saving by themselves. */
const CLOCK_KEY = "kl_clocks";
const CLOCK_DEFAULT = ["Asia/Kolkata", "America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London"];
const CLOCK_COUNT = CLOCK_DEFAULT.length;
const CLOCK_COMMON = [
  ["Asia/Kolkata", "India"], ["America/New_York", "US Eastern"], ["America/Chicago", "US Central"],
  ["America/Denver", "US Mountain"], ["America/Phoenix", "Arizona"], ["America/Los_Angeles", "US Pacific"],
  ["America/Anchorage", "Alaska"], ["Pacific/Honolulu", "Hawaii"], ["America/Toronto", "Toronto"],
  ["America/Vancouver", "Vancouver"], ["Europe/London", "London"], ["Europe/Dublin", "Dublin"],
  ["Europe/Paris", "Paris"], ["Europe/Berlin", "Berlin"], ["Asia/Dubai", "Dubai"],
  ["Asia/Kathmandu", "Nepal"], ["Asia/Thimphu", "Bhutan"], ["Asia/Dhaka", "Bangladesh"],
  ["Asia/Manila", "Manila"], ["Asia/Singapore", "Singapore"], ["Asia/Tokyo", "Tokyo"],
  ["Australia/Sydney", "Sydney"], ["Pacific/Auckland", "Auckland"], ["UTC", "UTC"],
];

function clockZones() {
  try {
    const z = JSON.parse(localStorage.getItem(CLOCK_KEY) || "null");
    if (Array.isArray(z) && z.length && z.every(clockValid)) {
      /* Saved from when there were three: keep those picks, in their places,
         and fill the new slots with defaults not already showing. */
      const out = z.slice(0, CLOCK_COUNT);
      for (const d of CLOCK_DEFAULT) if (out.length < CLOCK_COUNT && !out.includes(d)) out.push(d);
      return out;
    }
  } catch (e) { /* defaults */ }
  return CLOCK_DEFAULT.slice();
}
function clockValid(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch (e) { return false; }
}
/* "EDT", "BST", "IST" where a locale has a real abbreviation; otherwise the
   city — never a bare "GMT+5:30", which reads as a formula. */
function clockAbbr(tz, d = new Date()) {
  for (const loc of ["en-US", "en-GB", "en-IN", "en-AU", "en-NZ"]) {
    try {
      const n = new Intl.DateTimeFormat(loc, { timeZone: tz, timeZoneName: "short" })
        .formatToParts(d).find((p) => p.type === "timeZoneName")?.value || "";
      if (/^[A-Z]{2,5}$/.test(n) && !/^(GMT|UTC)$/.test(n) || (tz === "UTC" && n)) return n;
      /* London and Dublin in winter really are "GMT" — only a zero offset earns it */
      if (n === "GMT" && clockOffset(tz, d) === "+0:00") return n;
    } catch (e) { /* next */ }
  }
  return (CLOCK_COMMON.find(([z]) => z === tz)?.[1] || tz.split("/").pop().replace(/_/g, " "));
}
function clockOffset(tz, d = new Date()) {
  try {
    const n = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(d).find((p) => p.type === "timeZoneName")?.value || "";
    const m = n.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!m) return "+0:00";
    return `${m[1]}${+m[2]}:${m[3]}`;
  } catch (e) { return ""; }
}
function clockName(tz) {
  return CLOCK_COMMON.find(([z]) => z === tz)?.[1] || tz.split("/").pop().replace(/_/g, " ");
}

function clocksPaint() {
  const box = $("clocks");
  if (!box) return;
  const now = new Date();
  const zones = clockZones();
  if (box.children.length !== zones.length) {
    box.innerHTML = zones.map((_, i) => `<button type="button" class="clock" data-clock="${i}"
      aria-haspopup="listbox"><span class="clock-l"></span><b class="clock-t"></b></button>`).join("");
  }
  zones.forEach((tz, i) => {
    const btn = box.children[i];
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
    const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
    const label = `${clockAbbr(tz, now)} (${clockOffset(tz, now)})`;
    btn.querySelector(".clock-l").textContent = label;
    btn.querySelector(".clock-t").textContent = time;
    btn.title = `${clockName(tz)} · ${day} ${time} — click to change`;
  });
}

function clockPicker(i, anchor) {
  document.getElementById("clock-pop")?.remove();
  const zones = clockZones();
  let all = [];
  try { all = Intl.supportedValuesOf("timeZone"); } catch (e) { all = CLOCK_COMMON.map(([z]) => z); }
  const pop = document.createElement("div");
  pop.id = "clock-pop";
  pop.className = "clock-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Choose a time zone");
  pop.innerHTML = `<input type="search" class="clock-q" placeholder="Search a city or zone" aria-label="Search time zones">
    <div class="clock-list" role="listbox"></div>`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = r.bottom + 8 + "px";
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - 300)) + "px";
  const list = pop.querySelector(".clock-list"), q = pop.querySelector(".clock-q");
  const row = (tz, label) => `<button type="button" role="option" data-tz="${esc(tz)}" aria-selected="${tz === zones[i]}">
    <span>${esc(label)}</span><em>${esc(clockAbbr(tz))} ${esc(clockOffset(tz))}</em></button>`;
  const paint = () => {
    const t = q.value.trim().toLowerCase();
    const common = CLOCK_COMMON.filter(([z, n]) => !t || n.toLowerCase().includes(t) || z.toLowerCase().includes(t));
    const rest = t ? all.filter((z) => z.toLowerCase().replace(/_/g, " ").includes(t) && !CLOCK_COMMON.some(([c]) => c === z)).slice(0, 40) : [];
    list.innerHTML = (common.length ? `<div class="clock-sec">Common</div>${common.map(([z, n]) => row(z, n)).join("")}` : "")
      + (rest.length ? `<div class="clock-sec">All time zones</div>${rest.map((z) => row(z, z.replace(/_/g, " "))).join("")}` : "")
      || `<p class="clock-none">No time zone matches “${esc(q.value)}”.</p>`;
  };
  paint();
  q.focus();
  q.addEventListener("input", paint);
  list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tz]");
    if (!b) return;
    const next = clockZones();
    next[i] = b.dataset.tz;
    try { localStorage.setItem(CLOCK_KEY, JSON.stringify(next)); } catch (err) { /* this session only */ }
    pop.remove();
    clocksPaint();
  });
  const close = (e) => {
    if (e.type === "keydown" && e.key !== "Escape") return;
    if (e.type === "mousedown" && (pop.contains(e.target) || anchor.contains(e.target))) return;
    pop.remove();
    document.removeEventListener("mousedown", close, true);
    document.removeEventListener("keydown", close, true);
  };
  document.addEventListener("mousedown", close, true);
  document.addEventListener("keydown", close, true);
}

function clocksWire() {
  clocksPaint();
  $("clocks")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-clock]");
    if (b) clockPicker(+b.dataset.clock, b);
  });
  /* tick on the minute boundary, then every minute — a clock that shows
     minutes need not repaint every second */
  setTimeout(() => { clocksPaint(); setInterval(clocksPaint, 60000); }, 60000 - (Date.now() % 60000) + 50);
}

/* ---------------- the sidebar: groups and the icon rail ----------------
   Sections fold. Which are open is remembered per browser; the section that
   holds the current page is always opened, so you can see where you are.
   The rail (sidebar collapsed to icons) is remembered too. */
const NAV_KEY = "kl_nav_open", RAIL_KEY = "kl_nav_rail";
function navOpenSet() {
  try { return new Set(JSON.parse(localStorage.getItem(NAV_KEY) || '["leads"]')); }
  catch (e) { return new Set(["leads"]); }
}
function navSetOpen(group, open, remember = true) {
  const g = document.querySelector(`.nav-group[data-group="${group}"]`);
  if (!g) return;
  g.classList.toggle("open", open);
  g.querySelector(".nav-group-h")?.setAttribute("aria-expanded", String(open));
  if (!remember) return;
  const s = navOpenSet();
  if (open) s.add(group); else s.delete(group);
  try { localStorage.setItem(NAV_KEY, JSON.stringify([...s])); } catch (e) { /* session only */ }
}
function navReveal(tab) {
  const item = document.querySelector(`.nav-item[data-tab="${tab}"]`);
  const g = item?.closest(".nav-group");
  if (g) navSetOpen(g.dataset.group, true, false);
  document.querySelectorAll(".nav-group").forEach((x) =>
    x.classList.toggle("has-active", !!x.querySelector(".nav-item.active")));
}
function navWire() {
  const open = navOpenSet();
  document.querySelectorAll(".nav-group").forEach((g) => navSetOpen(g.dataset.group, open.has(g.dataset.group), false));
  document.querySelectorAll(".nav-group-h").forEach((h) => h.addEventListener("click", () => {
    const g = h.closest(".nav-group");
    /* in the rail a section header has nowhere to unfold into: go to its
       first page instead */
    if ($("app-main")?.classList.contains("rail")) {
      const first = [...g.querySelectorAll(".nav-item")].find((b) => !b.classList.contains("hidden"));
      if (first) setTab(first.dataset.tab);
      return;
    }
    navSetOpen(g.dataset.group, !g.classList.contains("open"));
  }));
  const setRail = (on) => {
    $("app-main")?.classList.toggle("rail", on);
    const b = $("nav-collapse");
    if (b) { b.title = on ? "Expand the sidebar" : "Collapse the sidebar"; b.setAttribute("aria-pressed", String(on)); }
    try { localStorage.setItem(RAIL_KEY, on ? "1" : ""); } catch (e) { /* fine */ }
  };
  let rail = false;
  try { rail = !!localStorage.getItem(RAIL_KEY); } catch (e) { /* default open */ }
  setRail(rail);
  on("nav-collapse", "click", () => setRail(!$("app-main").classList.contains("rail")));
}

function setTab(tab) {
  // an admin tab reached without the role — a stale deep link, say — lands on
  // Companies instead of an empty pane. The endpoint 403s regardless.
  if (TABS[tab]?.admin && !isAdmin()) tab = "companies";
  S.tab = tab;
  S.segment = null;                     // any sidebar tab leaves segment browsing
  $("segment-back")?.classList.add("hidden");
  $("seg-eyebrow")?.classList.add("hidden");
  $("list-head")?.classList.remove("in-segment");
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab));
  navReveal(tab);
  /* The four lead tiles count and filter LEADS. On a page that is not a
     lead list (Dashboard, Call logs, Users…) they are someone else's
     numbers taking the top of the screen, so they step aside. */
  $("stats")?.classList.toggle("hidden", !!paneOf(tab));
  $("clear-recents")?.classList.toggle("hidden", !TABS[tab].activity);
  $("zoho-scan")?.classList.toggle("hidden", !TABS[tab].contacted);
  $("zoho-auto")?.classList.toggle("hidden", !TABS[tab].contacted);
  if (TABS[tab].contacted) zohoAutoLoad();
  // the board filter is a job-board thing; S.board is kept, so flipping to
  // People and back does not lose the pick
  $("board-ctl")?.classList.toggle("hidden", tab !== "jobs");
  /* Team activity is not a list of leads: it takes the whole width instead of
     leaving an empty reading pane beside a chart */
  const pane = paneOf(tab);                  // none of these are lists of leads
  for (const [key, id] of Object.entries(PANES))
    $(id)?.classList.toggle("hidden", key !== pane);
  const wide = !!pane;
  /* Leaving the call report stops its polling — a hidden pane refreshing in
     the background is a query every 30 seconds for nobody to read. */
  if (pane !== "calls") stopCallPolling();
  if (pane !== "dash") dashStopLive();
  if (pane !== "live") liveStop();
  if (pane !== "power") pdStop();
  if (pane !== "reputation") clearTimeout(REP.poll);
  /* The power dialer keeps going on every screen (it used to stop here, so
     a countdown would not ring somebody unseen). It is never unseen now: off
     the Call session screen, a bar on every page says what it is doing and
     who it rings next, with Pause and Open. */
  pdRunPaint();
  document.querySelector(".list-pane")?.classList.toggle("hidden", wide);
  $("detail-pane")?.classList.toggle("hidden", wide);
  renderSortOptions();
  loadList(true);
}

/* only offer sorts the current tab can actually do — no "certifications" on
   People, no "revenue" on the job board */
function renderSortOptions() {
  const sel = $("sort-by");
  if (!sel) return;
  if (paneOf(S.tab)) return;              // their controls live in their own panes
  if (TABS[S.tab].activity) {
    // the trail has exactly one meaningful order; leave S.sort alone so the
    // last real choice is still there when the user goes back to a lead tab
    sel.innerHTML = `<option value="">Last interacted</option>`;
    sel.disabled = true;
    return;
  }
  // (segments sort like any other list now — the old "Segment order" lockout
  //  existed because NocoDB's link endpoint silently ignored `sort`)
  sel.disabled = false;
  const mixed = !TABS[S.tab].kind;         // favorites/removed span all kinds
  const keys = mixed ? UNION_KEYS : [S.tab];
  const usable = SORTS.filter((s) => keys.every((k) => sortUsable(s.key, k)));
  if (!usable.some((s) => s.key === S.sort)) S.sort = "recent";
  sel.innerHTML = usable.map((s) =>
    `<option value="${s.key}"${s.key === S.sort ? " selected" : ""}>${s.label}</option>`).join("");
}

function renderStateOptions() {
  const sel = $("filter-state");
  if (!sel) return;
  const states = Object.entries(STATE_NAME).sort((a, b) => a[1].localeCompare(b[1]));
  // value stays the abbreviation (that's what buildWhere matches on); only the
  // visible label is spelled out
  sel.innerHTML = `<option value="">All states</option>` + states.map(([ab, full]) =>
    `<option value="${ab}"${ab === S.state ? " selected" : ""}>${full}</option>`).join("");
}

/* ---------------- density + resizable panes ---------------- */
const DENSITIES = ["compact", "cozy", "comfortable"];
function setDensity(d) {
  if (!DENSITIES.includes(d)) d = "compact";
  document.body.classList.remove(...DENSITIES.map((x) => "d-" + x));
  document.body.classList.add("d-" + d);
  localStorage.setItem("kl_density", d);
  document.querySelectorAll("[data-density]").forEach((b) =>
    b.classList.toggle("on", b.dataset.density === d));
}

function setDetailWidth(px) {
  const w = Math.min(Math.max(px, 320), Math.max(360, window.innerWidth - 640));
  document.documentElement.style.setProperty("--detail-w", w + "px");
  localStorage.setItem("kl_detail_w", w);
}

function wireSplitter() {
  const handle = $("splitter");
  if (!handle) return;
  let dragging = false;
  const move = (e) => {
    if (!dragging) return;
    e.preventDefault();
    setDetailWidth(window.innerWidth - e.clientX - 20);   // 20px page padding
  };
  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    document.body.classList.add("resizing");
    e.preventDefault();
  });
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", () => {
    dragging = false;
    document.body.classList.remove("resizing");
  });
  handle.addEventListener("dblclick", () => setDetailWidth(460));  // reset
}

/* ---------------- tour ---------------- */
/* A guided walkthrough: a spotlight glides between the app's controls with a
   card explaining each one. Steps whose targets are hidden are skipped at
   start, so one script serves both roles — the admin-only steps simply vanish
   for a member. Runs once by itself on a first visit (kl_tour_done), and again
   any time from the ? button in the top bar. Purely presentational: it never
   clicks anything or touches S. */
const TOUR_STEPS = [
  { title: "Welcome to Karma Connect",
    body: "This is the team lead dashboard. Every company, contact and job " +
      "posting lives here in one place, already deduped. This tour points " +
      "out where everything is." },
  { sel: ".searchbox", pos: "below", title: "Search",
    body: "Searches the view you are in by name, contact or city. It works " +
      "together with the filters below." },
  { sel: "#stats", pos: "below", title: "The four tiles",
    body: "Each tile is a button. Click one and the list filters down to " +
      "those leads. Click it again to clear." },
  { sel: '.nav-item[data-tab="companies"], .nav-item[data-tab="people"], ' +
      '.nav-item[data-tab="jobs"], .nav-item[data-tab="recent"], ' +
      '.nav-item[data-tab="favorites"]', pos: "right", title: "Views",
    body: "Companies, People and Job board are the three kinds of leads. " +
      "Recent is the last leads you touched. Favorites is where your " +
      "starred leads go." },
  { sel: '.nav-item[data-tab="stats"], .nav-item[data-tab="removed"]',
    pos: "right", title: "Manage (admin)",
    body: "Team activity is the log of what everyone did. DNC is the list " +
      "of banned phone numbers." },
  { sel: ".list-controls", pos: "below", title: "Sort and filter",
    body: "Sorts the list, or narrows it down by state or status. These " +
      "stack with the search box and the tiles." },
  { sel: "#bulk-tools", pos: "below", title: "Bulk actions (admin)",
    body: "Turn on Select and every row gets a checkbox. You can assign, " +
      "DNC or delete the whole selection at once." },
  { sel: "#lead-list", pos: "right", title: "The lead list",
    body: "Every lead in the current view. Click a row to open it. The " +
      "tour opens the first one for you now." },
  // the steps below read the open lead: `open` makes the tour click the
  // first row if nothing is selected yet, then wait for the panel to render
  { sel: ".detail-lookup", pos: "left", open: true,
    title: "Google and LinkedIn",
    body: "One click searches Google or LinkedIn for this lead. No typing " +
      "the name out yourself." },
  { sel: "#d-status", pos: "left", open: true, title: "Status",
    body: "Move the lead from New to Contacted, Responded, Qualified or " +
      "Not interested. The list and the tiles update right away." },
  { sel: "#d-owner", pos: "left", open: true, title: "Owner",
    body: "Type a name here to assign the lead. Assigned leads leave the " +
      "Unassigned tile." },
  { sel: "#comments, .note-box", pos: "left", open: true, title: "Notes",
    body: "Notes save on the lead and the whole team can read them. Write " +
      "one and press enter." },
  { sel: "#d-fav", pos: "left", open: true, title: "Favorite",
    body: "The star saves this lead to your Favorites view." },
  { sel: ".detail-danger", pos: "left", open: true, title: "DNC and delete",
    body: "DNC bans the phone number so nobody on the team calls it again. " +
      "Delete moves the lead to the trash bin, where it sits for 30 days." },
  { sel: ".pager", pos: "above", title: "Paging",
    body: "Flip through pages here and pick how many rows show at once." },
  { sel: "#job-search-btn, #import-btn", pos: "right",
    title: "Bringing leads in (admin)",
    body: "Find jobs runs the job board scraper. Import leads takes " +
      "spreadsheet files. An import never overwrites a filled field with " +
      "a blank." },
  { sel: "#theme-toggle", pos: "below", title: "Light or dark",
    body: "Switches the theme. It stays how you leave it." },
  { sel: "#user-avatar", pos: "below", title: "Your account",
    body: "Sign out here. Admins also get Manage team and the Trash." },
  { title: "That is the tour",
    body: "That is everything. Press the ? button up top to watch it again." },
];

let tour = null;   // {steps, i, root, spot, card} while one is running

function tourTargets(step) {
  if (!step.sel) return null;                       // centered welcome/finish
  const els = [...document.querySelectorAll(step.sel)]
    .filter((el) => el.offsetParent !== null);      // skip admin-only on members
  return els.length ? els : null;
}

/* one box around every element the selector matched — that's how "Views"
   rings five sidebar buttons at once */
function tourBox(step) {
  const els = tourTargets(step);
  if (!els) return null;
  return els.map((el) => el.getBoundingClientRect()).reduce((a, r) => ({
    left: Math.min(a.left, r.left), top: Math.min(a.top, r.top),
    right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom),
  }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
}

function placeTourCard(box, pos) {
  const card = tour.card;
  const m = 14, vw = innerWidth, vh = innerHeight;
  const cw = card.offsetWidth, ch = card.offsetHeight;
  let left, top;
  if (!box) { left = (vw - cw) / 2; top = (vh - ch) / 2; }
  else {
    const room = {                       // px to spare on each side, can be <0
      below: vh - box.bottom - m - ch,
      above: box.top - m - ch,
      right: vw - box.right - m - cw,
      left: box.left - m - cw,
    };
    const order = pos ? [pos, "below", "above", "right", "left"]
      : ["below", "above", "right", "left"];
    const side = order.find((k) => room[k] > 0) || "below";
    if (side === "below" || side === "above") {
      left = (box.left + box.right) / 2 - cw / 2;
      top = side === "below" ? box.bottom + m : box.top - m - ch;
    } else {
      top = (box.top + box.bottom) / 2 - ch / 2;
      left = side === "right" ? box.right + m : box.left - m - cw;
    }
  }
  card.style.left = Math.max(10, Math.min(left, vw - cw - 10)) + "px";
  card.style.top = Math.max(10, Math.min(top, vh - ch - 10)) + "px";
}

function tourShow() {
  const step = tour.steps[tour.i];
  const last = tour.i === tour.steps.length - 1;
  const box = tourBox(step);
  const { spot, root } = tour;
  const pad = 6;
  spot.classList.toggle("bare", !box);
  if (box) {
    spot.style.left = box.left - pad + "px";
    spot.style.top = box.top - pad + "px";
    spot.style.width = box.right - box.left + pad * 2 + "px";
    spot.style.height = box.bottom - box.top + pad * 2 + "px";
  } else {                       // no target: collapse to a mid-screen point
    spot.style.left = innerWidth / 2 + "px";
    spot.style.top = innerHeight / 2 + "px";
    spot.style.width = "0px";
    spot.style.height = "0px";
  }
  root.querySelector(".tour-count").textContent =
    `Step ${tour.i + 1} of ${tour.steps.length}`;
  root.querySelector(".tour-title").textContent = step.title;
  root.querySelector(".tour-body").textContent = step.body;
  root.querySelectorAll(".tour-dot").forEach((d, n) =>
    d.classList.toggle("on", n === tour.i));
  root.querySelector(".tour-back").style.visibility =
    tour.i === 0 ? "hidden" : "visible";
  root.querySelector(".tour-next").textContent =
    last ? "Finish" : tour.i === 0 ? "Show me around" : "Next";
  placeTourCard(box, step.pos);          // content is set, so the size is real
}

async function tourGo(i) {
  if (!tour) return;
  const dir = i >= tour.i ? 1 : -1;      // skip past dead steps the same way
  i = Math.max(0, Math.min(i, tour.steps.length - 1));
  const step = tour.steps[i];
  const gen = ++tour.gen;                // stale async guard: last call wins
  if (step.open && !tourTargets(step)) {
    // this step reads the lead panel: open the first lead, real click, then
    // wait out select()'s fetch. Nothing to open means nothing to show.
    document.querySelector("#lead-list .lead-row")?.click();
    for (let t = 0; t < 25 && !tourTargets(step); t++)
      await new Promise((res) => setTimeout(res, 100));
    if (!tour || tour.gen !== gen) return;
  }
  if (step.sel && !tourTargets(step) && i > 0 && i < tour.steps.length - 1)
    return tourGo(i + dir);              // first and last are always sel-less
  tour.i = i;
  (tourTargets(step) || [])[0]?.scrollIntoView({ block: "nearest" });
  tourShow();
  if (step.open) setTimeout(() => {      // notes land async; re-ring once
    if (tour && tour.gen === gen) tourShow();
  }, 800);
}

function tourNext() {
  if (tour.i >= tour.steps.length - 1) endTour();
  else tourGo(tour.i + 1);
}

function tourReflow() { if (tour) tourShow(); }

function tourKeys(e) {
  if (!tour) return;
  if (e.key === "Escape") endTour();
  else if (e.key === "ArrowRight" || e.key === "Enter") tourNext();
  else if (e.key === "ArrowLeft") tourGo(tour.i - 1);
  else return;
  e.preventDefault();
  e.stopPropagation();       // capture phase — the app never sees these keys
}

function endTour() {
  if (!tour) return;
  // any exit counts as "seen" — the tour must never nag a returning user
  localStorage.setItem("kl_tour_done", "1");
  document.removeEventListener("keydown", tourKeys, true);
  removeEventListener("resize", tourReflow);
  tour.root.remove();
  tour = null;
}

function startTour() {
  if (tour) return;
  /* the tour points into every section of the sidebar: unfold them all
     (and leave the icon rail) so no step is skipped for being folded away */
  $("app-main")?.classList.remove("rail");
  document.querySelectorAll(".nav-group").forEach((g) => navSetOpen(g.dataset.group, true, false));
  // open steps stay in: their targets only exist once a lead is clicked
  const steps = TOUR_STEPS.filter((s) => !s.sel || s.open || tourTargets(s));
  const root = document.createElement("div");
  root.className = "tour";
  root.innerHTML = `
    <div class="tour-spot"></div>
    <div class="tour-card" role="dialog" aria-modal="true" aria-label="Guided tour">
      <button class="tour-skip" title="End the tour (Esc)">✕ Skip</button>
      <div class="tour-count"></div>
      <h3 class="tour-title"></h3>
      <p class="tour-body"></p>
      <div class="tour-foot">
        <div class="tour-dots">${steps.map(() => '<i class="tour-dot"></i>').join("")}</div>
        <div class="tour-btns">
          <button class="btn-ghost tour-back">Back</button>
          <button class="btn-primary tour-next">Next</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(root);
  tour = { steps, i: 0, gen: 0, root,
    spot: root.querySelector(".tour-spot"),
    card: root.querySelector(".tour-card") };
  root.querySelector(".tour-skip").addEventListener("click", endTour);
  root.querySelector(".tour-back").addEventListener("click", () => tourGo(tour.i - 1));
  root.querySelector(".tour-next").addEventListener("click", tourNext);
  // the spotlight ignores pointer events, so a click anywhere on the dimmed
  // page lands on the root — advance, like flipping a page
  root.addEventListener("click", (e) => { if (e.target === root) tourNext(); });
  document.addEventListener("keydown", tourKeys, true);
  addEventListener("resize", tourReflow);
  tourGo(0);
}

/* One stale cached file used to blank the whole app: a missing element threw
   out of wire(), init() stopped, and nothing was ever shown. Wiring is
   best-effort now — a mismatched control goes dead, the app still loads. */
function on(id, ev, fn) {
  const el = $(id);
  if (el) el.addEventListener(ev, fn);
  else console.warn(`[karma] #${id} missing — stale index.html? hard-refresh`);
}

function wire() {
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.addEventListener("click", () => setTab(b.dataset.tab)));
  navWire();
  clocksWire();
  document.querySelectorAll("[data-density]").forEach((b) =>
    b.addEventListener("click", () => setDensity(b.dataset.density)));
  // the KPI tiles are the filter control for the queues they count
  document.querySelectorAll(".stat[data-focus]").forEach((b) =>
    b.addEventListener("click", () => toggleFocus(b.dataset.focus)));
  wireSplitter();
  let debounce;
  on("search", "input", (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { S.q = e.target.value.trim(); loadList(true); }, 300);
  });
  on("filter-status", "change", (e) => { S.status = e.target.value; loadList(true); });
  loadStatusFilter();
  on("filter-state", "change", (e) => { S.state = e.target.value; loadList(true); });
  on("filter-board", "change", (e) => { S.board = e.target.value; loadList(true); });
  on("sort-by", "change", (e) => {
    S.sort = e.target.value;
    localStorage.setItem("kl_sort", S.sort);
    loadList(true);
  });
  on("pager-first", "click", () => goToPage(1));
  on("pager-prev", "click", () => goToPage(S.page - 1));
  on("pager-next", "click", () => goToPage(S.page + 1));
  on("pager-last", "click", () => goToPage(pageCount()));
  on("page-size", "change", (e) => {
    // keep the first row of the current page visible after the size changes
    const anchor = (S.page - 1) * S.pageSize;
    S.pageSize = +e.target.value;
    localStorage.setItem("kl_page_size", S.pageSize);
    S.page = Math.floor(anchor / S.pageSize) + 1;
    loadList();
  });
  on("theme-toggle", "click", () => {
    const light = document.documentElement.dataset.theme !== "light";
    document.documentElement.dataset.theme = light ? "light" : "dark";
    localStorage.setItem("kl_theme", light ? "light" : "dark");
  });
  on("help-btn", "click", startTour);
  on("user-avatar", "click", (e) => {
    e.stopPropagation();
    $("user-dropdown").classList.toggle("hidden");
  });
  document.addEventListener("click", () => $("user-dropdown")?.classList.add("hidden"));
  on("logout-btn", "click", logout);
  on("manage-users-btn", "click", () => {
    $("user-dropdown").classList.add("hidden");
    openUsersModal();
  });
  on("trash-btn", "click", () => {
    $("user-dropdown").classList.add("hidden");
    openTrashModal();
  });
  on("team-dashboard-btn", "click", () => {
    $("user-dropdown").classList.add("hidden");
    setTab("stats");                     // Team activity — the team overview
  });
  on("clear-recents", "click", async () => {
    // only forgets the trail — the leads themselves are untouched
    S.recents = [];
    recentsBadge();
    loadList(true);
    try { await api("/api/recents", { method: "DELETE" }); }
    catch (e) { console.warn("[karma] could not clear recents", e); }
    toast("Recent activity cleared");
  });
  /* the automatic scan: off, or every 10 / 30 / 60 minutes (zoho-scan.js) */
  on("zoho-auto", "change", async (e) => {
    const v = e.target.value;
    const body = v === "off" ? { auto: false } : { auto: true, every: +v };
    e.target.disabled = true;
    try {
      await api("/api/crm/zoho/scan/config", { method: "PUT", body: JSON.stringify(body) });
      toast(v === "off" ? "Automatic Zoho scan is off — use Scan Zoho when you want one"
        : `Zoho is now scanned automatically every ${v === "60" ? "hour" : v + " minutes"}`, 5000);
    } catch (ex) { toast("Couldn't change it: " + ex.message, 6000); }
    e.target.disabled = false;
    zohoAutoLoad();
  });
  on("zoho-scan", "click", async () => {
    const btn = $("zoho-scan");
    btn.disabled = true; const label = btn.textContent; btn.textContent = "Scanning Zoho…";
    try {
      const r = await api("/api/crm/zoho/backfill", { method: "POST" });
      toast(`Scanned ${dashN(r.scanned)} Zoho record${r.scanned === 1 ? "" : "s"} — ${
        dashN(r.flagged)} newly flagged (${dashN(r.matched)} matched here)`, 7000);
      loadList(true);
      zohoAutoLoad();
    } catch (e) {
      toast("Couldn't scan Zoho: " + (e.message || "unknown"), 8000);
    } finally { btn.disabled = false; btn.textContent = label; }
  });
  // the bulk half of the filter row — admin-only in the markup, and on the routes
  on("bulk-toggle", "click", () => setSelectMode(!S.selectMode));
  on("bulk-all", "change", (e) => {
    S.list.forEach((r) => setPick(r, e.target.checked));
    lastPick = null;
    if (e.target.checked && S.picked.size >= BULK_MAX)
      toast(`${BULK_MAX} leads is the most one action can take`);
    paintPicks();
  });
  on("bulk-assign", "click", openAssignModal);
  on("bulk-dnc", "click", openBulkDncModal);
  on("bulk-delete", "click", openBulkDeleteModal);
  on("segment-back", "click", exitSegment);
  on("act-days", "change", loadStats);
  on("act-refresh", "click", loadStats);
  on("assign-refresh", "click", loadAssignments);
  on("tasks-refresh", "click", loadTasks);
  on("research-refresh", "click", loadResearchCenter);
  on("storm-refresh", "click", () => { STORM.data = null; loadStorm(); });
  /* My calls: the two tabs, a lead link, the way into a running campaign */
  document.querySelectorAll("[data-mc]").forEach((b) => b.addEventListener("click", () => { MC.tab = b.dataset.mc; loadMyCalls(); }));
  $("mc-body")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-mc-go]")) return setTab("camp");
    const a = e.target.closest(".person-lead");
    if (!a) return;
    e.preventDefault();
    const tab = KIND_TAB[a.dataset.kind];
    if (tab) { setTab(tab); select({ Id: +a.dataset.lead, _t: tab }); }
  });
  /* My settings: connect / disconnect / open the dialler's recorder and audio */
  $("me-body")?.addEventListener("click", (e) => { const b = e.target.closest("[data-me]"); if (b) meAction(b.dataset.me); });
  on("calls-refresh", "click", () => loadCallReport());
  on("calls-live", "click", toggleCallPolling);
  on("calls-minutes", "change", () => loadCallReport());
  on("calls-dl-open", "click", (e) => {
    e.stopPropagation();
    const pop = $("calls-dl-pop");
    const show = pop.classList.contains("hidden");
    pop.classList.toggle("hidden", !show);
    $("calls-dl-open")?.setAttribute("aria-expanded", String(show));
    /* Say what will be downloaded. The button is the same button on both
       screens, so without this there is no way to tell the overall report
       from one person's. */
    if (show && $("calls-dl-scope"))
      $("calls-dl-scope").textContent = callsPerson
        ? "Just " + (callsPersonLabel || callsPerson) : "The whole team";
  });
  /* Click-away, but not when the click is inside the panel — a date picker
     closing the thing it lives in would be maddening. */
  document.addEventListener("click", (e) => {
    const pop = $("calls-dl-pop");
    if (!pop || pop.classList.contains("hidden")) return;
    if (pop.contains(e.target) || e.target.closest("#calls-dl-open")) return;
    pop.classList.add("hidden");
    $("calls-dl-open")?.setAttribute("aria-expanded", "false");
  });
  on("calls-dl", "click", () => { $("calls-dl-pop")?.classList.add("hidden"); downloadCallReport(); });
  on("calls-dl-range", "change", (e) => {
    const custom = e.target.value === "custom";
    $("calls-dl-custom")?.classList.toggle("hidden", !custom);
    /* Seed the custom inputs from the period just shown, so "Custom" starts
       from something real rather than from 1970. */
    if (custom) {
      const r = dlRange("month");
      if ($("calls-dl-from") && !$("calls-dl-from").value) $("calls-dl-from").value = r.from;
      if ($("calls-dl-to") && !$("calls-dl-to").value) $("calls-dl-to").value = r.to;
    }
  });
  on("calls-prev", "click", () => stepCallDate(-1));
  on("calls-next", "click", () => stepCallDate(1));
  on("calls-today", "click", () => { callsDate = ""; loadCallReport(); });
  on("calls-date", "change", (e) => {
    callsDate = e.target.value; stopCallPolling(); loadCallReport();
  });
  /* Delegated, because the report repaints on every load and per-element
     listeners would have to be rebound each time. */
  $("calls-body")?.addEventListener("click", (e) => {
    const bar = e.target.closest(".hist-col[data-date]");
    if (bar) { callsDate = bar.dataset.date; stopCallPolling(); return loadCallReport(); }
    const row = e.target.closest(".person-row[data-person]");
    if (row) return openPerson(row.dataset.person);
    const zt = e.target.closest("#zoho-off, #zoho-on");
    if (zt) {
      const off = zt.id === "zoho-off";
      if (off && !confirm("Turn Zoho off? Reps who have not connected RingCentral will have numbers copied to their clipboard instead of opening Zoho.")) return;
      api("/api/voice/providers", { method: "PUT", body: JSON.stringify({ zohoOff: off }) })
        .then(() => { VOICE.zohoOff = off;
          toast(off ? "Zoho turned off" : "Zoho turned back on"); loadCallReport(); })
        /* The server refuses to leave the floor with no dialler at all; say
           so rather than letting the button look broken. */
        .catch((err) => toast(err.message, 9000));
      return;
    }
    if (e.target.closest("#crm-disconnect")) {
      if (!confirm("Disconnect Zoho CRM? Your calls and leads will go into Zoho under the shared account until you connect again.")) return;
      api("/api/crm/me/connect", { method: "DELETE" })
        .then(() => { toast("Zoho CRM disconnected"); return crmMeLoad(); })
        .catch((err) => toast("Could not disconnect: " + err.message));
      return;
    }
    if (e.target.closest("#rc-disconnect")) {
      if (!confirm("Disconnect RingCentral? You will dial from the shared line until you sign in again.")) return;
      api("/api/voice/rc/connect", { method: "DELETE" })
        .then(() => { VOICE.rcConnected = false; VOICE.provider = ""; VOICE.ready = false;
          toast("RingCentral disconnected"); loadCallReport(); })
        .catch((err) => toast("Could not disconnect: " + err.message));
    }
  });

  /* Delegated so it covers the reading pane, which is re-rendered constantly.
     A modified click (new tab, copy link) is left alone — the number is still
     an ordinary link and should behave like one. */
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.("a.dial");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    if (dialInPage(a.dataset.dial, a.dataset.dialName, +a.dataset.dialId || null))
      e.preventDefault();
    // otherwise: not prevented, so the browser follows tel: as it always did
  });
  rcWireBar();
  voiceInit();
  on("act-phones", "click", runPhoneRefresh);
  on("act-logs", "click", () => { actFull = !actFull; loadStats(); });
  on("import-btn", "click", openImportModal);
  on("job-search-btn", "click", openJobSearchConfirm);
  on("job-search-settings", "click", openJobSearchSettings);
  wireGlobalDrop();
  on("modal-backdrop", "click", (e) => {
    if (e.target === $("modal-backdrop")) closeModal();
  });
}

/* ================= Dashboard — RingCentral, read live =================

   The manager's wall: every call on the RingCentral account (inbound too,
   and calls made from desk phones and the RingCentral app, which our own log
   never sees), who is on a call right now, and where the calls go.

   Drawn by hand in SVG and HTML like Team activity and Storm watch: no chart
   library, nothing new for the CSP. Charts are measured at their real width
   and redrawn on resize, so text stays the size it says it is.

   Colour: incoming / outgoing / missed are --cat-3 / --cat-1 / --cat-8, in
   that stacking order. Validated (dataviz validator, both themes): green
   beside red failed colour-blind separation, so missed always sits next to
   outgoing, never next to incoming. Every chart has a legend and a table
   view, which the light theme's green needs (2.8:1 on white). */

const DASH = {
  range: "today", date: "", dept: "", agent: "", number: "",
  live: false, timer: null, data: null, error: null,
  tables: new Set(), tips: [], wired: false,
};
const DASH_SERIES = [
  ["incoming", "Incoming", "var(--cat-3)"],
  ["outgoing", "Outgoing", "var(--cat-1)"],
  ["missed", "Missed", "var(--cat-8)"],
];
/* Call results keep one colour each however the list is filtered — colour
   follows the result, never its rank. Anything unlisted folds to grey. */
const DASH_RESULT_SLOT = {
  "Call connected": 1, "Accepted": 3, "Hang Up": 2, "No Answer": 4, "Busy": 5,
  "Rejected": 6, "Voicemail": 7, "Missed": 8,
};

const dashYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function dashSpan() {
  const now = new Date();
  if (DASH.date) return { from: DASH.date, to: DASH.date };
  if (DASH.range === "yesterday") {
    const y = new Date(now); y.setDate(y.getDate() - 1);
    return { from: dashYmd(y), to: dashYmd(y) };
  }
  if (DASH.range === "week") {
    const f = new Date(now); f.setDate(f.getDate() - 6);
    return { from: dashYmd(f), to: dashYmd(now) };
  }
  return { from: dashYmd(now), to: dashYmd(now) };
}
function dashTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { return ""; }
}

function dashDur(secs) {
  if (!secs) return "0m";
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
const dashPct = (v) => v == null ? "—" : Math.round(v * 100) + "%";
const dashN = (n) => (n || 0).toLocaleString();
function dashPhone(n) {
  const d = String(n || "").replace(/\D/g, "");
  const t = d.length === 11 && d[0] === "1" ? d.slice(1) : d;
  return t.length === 10 ? `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}` : String(n || "");
}
const dashTotal = (r) => r.incoming + r.outgoing + r.missed;
/* Clean y-axis ticks: a whole-number step from 1/2/5 × 10ⁿ (2.5 only once the
   step is ≥ 25), about four of them — so 0/2/4/6/8/10, never 0/3/5/8/10. */
function dashTicks(v) {
  const raw = Math.max(1, v) / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p)
    .find((s) => s >= raw && Number.isInteger(s)) || 10 * p;
  const max = Math.max(step, Math.ceil(v / step) * step);
  const ticks = [];
  for (let t = 0; t <= max + 1e-9; t += step) ticks.push(t);
  return { max, ticks };
}
const dashTip = (html) => { DASH.tips.push(html); return DASH.tips.length - 1; };
const dashTipRows = (r) => DASH_SERIES.map(([k, label, c]) =>
  `<div class="dash-tip-row"><i style="background:${c}"></i>${label}<b>${dashN(r[k])}</b></div>`).join("");

/* ---------- loading ---------- */

async function loadDash(quiet = false) {
  dashWire();
  const body = $("dash-body");
  if (!DASH.data) body.innerHTML = `<div class="dash-empty"><div class="dash-spin"></div>Reading RingCentral…</div>`;
  else body.classList.add("dash-stale");          // hold the last render, no skeleton flash
  const { from, to } = dashSpan();
  const q = new URLSearchParams({ from, to, tz: dashTz(),
    dept: DASH.dept, agent: DASH.agent, number: DASH.number });
  /* Dispositions are ours, not RingCentral's: the same local days, turned
     into instants here, and the agent filter as their extension number. */
  const start = new Date(from + "T00:00"), end = new Date(to + "T00:00");
  end.setDate(end.getDate() + 1);
  const ext = (DASH.data?.filters?.agents || []).find((a) => a.id === DASH.agent)?.ext || "";
  const dq = new URLSearchParams({ from: start.toISOString(), to: end.toISOString(), ext });
  const [rcRes, dRes] = await Promise.allSettled([
    api("/api/voice/rc/dashboard?" + q),
    api("/api/calls/dispositions?" + dq),
  ]);
  if (rcRes.status === "fulfilled") { DASH.data = rcRes.value; DASH.error = null; }
  else DASH.error = rcRes.reason?.message || String(rcRes.reason);   // keep the last good data on screen
  if (dRes.status === "fulfilled") { DASH.dispo = dRes.value; DASH.dispoError = null; }
  else DASH.dispoError = dRes.reason?.message || String(dRes.reason);
  body.classList.remove("dash-stale");
  renderDash();
}

function dashStartLive() {
  dashStopLive();
  DASH.timer = setInterval(() => {
    if (S.tab === "dash" && !document.hidden) loadDash(true);
  }, 60 * 1000);
}
function dashStopLive() {
  if (DASH.timer) clearInterval(DASH.timer);
  DASH.timer = null;
}

function dashWire() {
  if (DASH.wired) return;
  DASH.wired = true;
  try { DASH.live = localStorage.getItem("kl_dash_live") === "1"; } catch (e) { /* default off */ }

  document.querySelectorAll("#dash-pane [data-range]").forEach((b) =>
    b.addEventListener("click", () => {
      DASH.range = b.dataset.range; DASH.date = "";
      $("dash-date").value = "";
      loadDash();
    }));
  on("dash-date", "change", (e) => { DASH.date = e.target.value; loadDash(); });
  for (const [id, key] of [["dash-dept", "dept"], ["dash-agent", "agent"], ["dash-number", "number"]])
    on(id, "change", (e) => { DASH[key] = e.target.value; loadDash(); });
  on("dash-refresh", "click", () => loadDash());
  on("dash-live", "click", () => {
    DASH.live = !DASH.live;
    try { localStorage.setItem("kl_dash_live", DASH.live ? "1" : ""); } catch (e) { /* fine */ }
    paintDashFilters();
    if (DASH.live) { dashStartLive(); loadDash(true); } else dashStopLive();
  });

  const body = $("dash-body"), tip = $("dash-tip");
  const show = (e) => {
    const t = e.target.closest?.("[data-tip]");
    if (!t || !body.contains(t)) return tip.classList.add("hidden");
    tip.innerHTML = DASH.tips[+t.dataset.tip] || "";
    tip.classList.remove("hidden");
    const pane = $("dash-pane").getBoundingClientRect();
    const r = t.getBoundingClientRect();
    const x = (e.clientX ?? (r.left + r.width / 2)) - pane.left;
    const y = (e.clientY ?? r.top) - pane.top;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(Math.max(8, x + 14), pane.width - w - 8) + "px";
    tip.style.top = (y - h - 12 < 8 ? y + 18 : y - h - 12) + "px";
  };
  body.addEventListener("mousemove", show);
  body.addEventListener("focusin", show);
  body.addEventListener("mouseleave", () => tip.classList.add("hidden"));
  body.addEventListener("focusout", () => tip.classList.add("hidden"));
  body.addEventListener("click", (e) => {
    const mv = e.target.closest("[data-mapview]");
    if (mv) { DASH.mapView = mv.dataset.mapview; return renderDash(); }
    const b = e.target.closest("[data-tbl]");
    if (!b) return;
    const k = b.dataset.tbl;
    if (DASH.tables.has(k)) DASH.tables.delete(k); else DASH.tables.add(k);
    renderDash();
  });
  let t;
  window.addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(() => { if (S.tab === "dash" && DASH.data) renderDash(); }, 150);
  });
  if (DASH.live) dashStartLive();
}

function paintDashFilters() {
  document.querySelectorAll("#dash-pane [data-range]").forEach((b) => {
    const on_ = !DASH.date && b.dataset.range === DASH.range;
    b.classList.toggle("on", on_);
    b.setAttribute("aria-pressed", String(on_));
  });
  const di = $("dash-date");
  if (di) { di.max = dashYmd(new Date()); if (DASH.date) di.value = DASH.date; }
  const f = DASH.data?.filters;
  const fill = (id, rows, all, cur) => {
    const el = $(id);
    if (!el || !rows) return;
    el.innerHTML = `<option value="">${all}</option>` + rows.map(([v, l]) =>
      `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("");
    el.closest(".ctl")?.classList.toggle("on", !!cur);
  };
  if (f) {
    fill("dash-dept", f.departments.map((d) => [d, d]), "All departments", DASH.dept);
    $("dash-dept-wrap")?.classList.toggle("hidden", !f.departments.length);
    fill("dash-agent", f.agents.map((a) => [a.id, a.ext ? `${a.name} · x${a.ext}` : a.name]), "All agents", DASH.agent);
    fill("dash-number", f.numbers.map((n) => [n, dashPhone(n)]), "All numbers", DASH.number);
  }
  const live = $("dash-live");
  if (live) live.setAttribute("aria-checked", String(DASH.live));
}

/* ---------- the page ---------- */

function renderDash() {
  paintDashFilters();
  const body = $("dash-body"), d = DASH.data;
  DASH.tips = [];
  const sub = $("dash-sub");

  if (!d) {
    const connect = /connect your ringcentral/i.test(DASH.error || "");
    if (sub) sub.textContent = "";
    body.innerHTML = `<div class="dash-empty">
      <b>${connect ? "Connect RingCentral to see the dashboard" : "The dashboard couldn't load"}</b>
      <span>${esc(DASH.error || "")}</span>
      ${connect ? `<a class="btn-primary" href="/api/voice/rc/connect">Connect RingCentral</a>`
        : `<button class="btn-ghost" data-act="loadDash">Try again</button>`}</div>`;
    return;
  }

  const upd = new Date(d.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const rangeTxt = d.range.from === d.range.to
    ? (d.range.from === d.range.today ? "Today"
      : new Date(d.range.from + "T12:00").toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }))
    : `${new Date(d.range.from + "T12:00").toLocaleDateString([], { month: "short", day: "numeric" })} – ${
        new Date(d.range.to + "T12:00").toLocaleDateString([], { month: "short", day: "numeric" })}`;
  if (sub) sub.innerHTML = `${esc(rangeTxt)} · updated ${esc(upd)}${DASH.live ? ` <span class="dash-livetag"><i></i>Live</span>` : ""}`
    + (DASH.error ? ` · <span class="dash-errtag" title="${esc(DASH.error)}">last refresh failed</span>` : "");

  const warn = (d.warnings || []).map((w) => `<div class="dash-warn">${esc(w)}</div>`).join("");
  body.innerHTML = `${warn}
    <div class="dash-tiles">${dashTiles(d)}</div>
    <div class="dash-grid">
      ${dashCard("hourly", "Hourly call load", "Calls started in each hour", "dash-a-hourly")}
      ${dashCard("week", "Last 7 days", "Ending " + (d.range.to === d.range.today ? "today" : d.range.to), "dash-a-week")}
      ${dashCard("agents", "Agent stats", "Calls, connects and talk time per person", "dash-a-agents")}
      ${dashCard("results", "Call results", "How calls ended", "dash-a-results")}
      ${dashCard("numbers", "Number stats", "Calls per company number", "dash-a-numbers")}
      ${dashCard("dispo", "Dispositions", "What reps logged after their calls", "dash-a-dispo")}
      ${dashCard("dlog", "Disposition log", dashDlogSub(), "dash-a-dlog", "", false)}
      ${dashCard("map", "Where we're calling", "By the other party's phone number", "dash-a-map", dashMapSeg())}
    </div>`;

  const plots = {
    hourly: dashHourly, week: dashWeek, results: dashResults,
    agents: dashAgents, numbers: dashNumbers, map: dashMap,
    dispo: dashDispo, dlog: dashDlog,
  };
  for (const [k, fn] of Object.entries(plots)) {
    const el = body.querySelector(`[data-plot="${k}"]`);
    if (el) el.innerHTML = fn(d, el.clientWidth || 600, DASH.tables.has(k));
  }
}

function dashCard(key, title, sub, cls = "", extra = "", tableToggle = true) {
  const t = DASH.tables.has(key);
  return `<section class="dash-card ${cls}">
    <header><div><h3>${esc(title)}</h3><span>${esc(sub)}</span></div>
      <div class="dash-card-tools">${extra}${tableToggle ? `<button class="dash-tbl" data-tbl="${key}" aria-pressed="${t}"
        title="${t ? "Show the chart" : "Show the numbers as a table"}">${t ? "Chart" : "Table"}</button>` : ""}</div></header>
    <div class="dash-plot" data-plot="${key}"></div></section>`;
}

function dashLegend() {
  return `<div class="dash-legend">${DASH_SERIES.map(([, label, c]) =>
    `<span><i style="background:${c}"></i>${label}</span>`).join("")}</div>`;
}

/* ---------- tiles ---------- */

const DASH_IC = {
  in: "M16 3h5v5M21 3l-6 6M5 4h3.5l1.7 4.3-2.1 1.3a9.5 9.5 0 0 0 4.3 4.3l1.3-2.1 4.3 1.7V17a2 2 0 0 1-2 2A14 14 0 0 1 3 6a2 2 0 0 1 2-2z",
  out: "M21 8V3h-5M15 9l6-6M5 4h3.5l1.7 4.3-2.1 1.3a9.5 9.5 0 0 0 4.3 4.3l1.3-2.1 4.3 1.7V17a2 2 0 0 1-2 2A14 14 0 0 1 3 6a2 2 0 0 1 2-2z",
  miss: "M16 3l5 5M21 3l-5 5M5 4h3.5l1.7 4.3-2.1 1.3a9.5 9.5 0 0 0 4.3 4.3l1.3-2.1 4.3 1.7V17a2 2 0 0 1-2 2A14 14 0 0 1 3 6a2 2 0 0 1 2-2z",
  all: "M5 4h3.5l1.7 4.3-2.1 1.3a9.5 9.5 0 0 0 4.3 4.3l1.3-2.1 4.3 1.7V17a2 2 0 0 1-2 2A14 14 0 0 1 3 6a2 2 0 0 1 2-2z",
  people: "M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM20 20v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.6a3.5 3.5 0 0 1 0 6.8",
};
const dashIc = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

function dashTiles(d) {
  const k = d.kpi, tot = k.total.calls || 0;
  const share = (n) => tot ? Math.max(n ? 2 : 0, Math.round((n / tot) * 100)) : 0;
  const tile = (cls, ic, label, value, unit, stats, meter) => `
    <div class="dash-tile ${cls}">
      <div class="dash-tile-top"><span class="dash-tile-l">${label}</span><span class="dash-tile-ic">${dashIc(ic)}</span></div>
      <div class="dash-tile-v">${value}<small>${unit}</small></div>
      <div class="dash-tile-s">${stats}</div>
      ${meter}
    </div>`;
  const meter = (pct, color, title) =>
    `<div class="dash-meter" title="${esc(title)}"><i style="width:${pct}%;background:${color}"></i></div>`;

  const a = d.agents;
  const agentMeter = a && a.total
    ? `<div class="dash-meter dash-meter-split" title="${a.onCall} on a call · ${a.online - a.onCall} available · ${a.offline} offline">
         <i style="width:${(a.onCall / a.total) * 100}%;background:var(--cat-1)"></i>
         <i style="width:${((a.online - a.onCall) / a.total) * 100}%;background:var(--good)"></i>
         <i style="width:${(a.offline / a.total) * 100}%;background:var(--ink-3);opacity:.45"></i></div>`
    : `<div class="dash-meter"></div>`;

  return [
    tile("in", DASH_IC.in, "Incoming", dashN(k.incoming.calls), "calls",
      `<span><b>${dashDur(k.incoming.secs)}</b> talk</span><span><b>${dashPct(k.answerRate)}</b> answered</span>`,
      meter(share(k.incoming.calls), "var(--cat-3)", `${share(k.incoming.calls)}% of all calls`)),
    tile("out", DASH_IC.out, "Outgoing", dashN(k.outgoing.calls), "calls",
      `<span><b>${dashDur(k.outgoing.secs)}</b> talk</span><span><b>${dashPct(k.connectRate)}</b> connected</span>`,
      meter(share(k.outgoing.calls), "var(--cat-1)", `${share(k.outgoing.calls)}% of all calls`)),
    tile("miss", DASH_IC.miss, "Missed", dashN(k.missed.calls), "calls",
      `<span>inbound calls nobody picked up</span>`,
      meter(share(k.missed.calls), "var(--cat-8)", `${share(k.missed.calls)}% of all calls`)),
    tile("all", DASH_IC.all, "Total calls", dashN(tot), "calls",
      `<span><b>${dashDur(k.total.secs)}</b> total</span><span><b>${k.avgTalk ? dashDur(k.avgTalk) : "—"}</b> avg talk</span>`,
      meter(tot ? 100 : 0, "var(--accent)", "")),
    a ? tile("agents", DASH_IC.people, "Agents", dashN(a.online), `of ${a.total} online`,
      `<span><b>${a.onCall}</b> on a call</span><span><b>${a.offline}</b> offline</span>`, agentMeter)
      : tile("agents", DASH_IC.people, "Agents", "—", "", `<span>presence unavailable</span>`, `<div class="dash-meter"></div>`),
  ].join("");
}

/* ---------- charts ---------- */

const dashNone = (msg = "No calls in this period") => `<div class="dash-none">${msg}</div>`;
function dashTable(head, rows) {
  return `<div class="dash-tablewrap"><table class="dash-table"><thead><tr>${head.map((h, i) =>
    `<th${i ? ' class="n"' : ""}>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) =>
    `<tr>${r.map((c, i) => `<td${i ? ' class="n"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

/* Hourly: three 2px lines over the working day, a crosshair band per hour. */
function dashHourly(d, W, table) {
  const rows = d.hourly;
  const any = rows.filter((r) => dashTotal(r));
  if (!any.length) return dashNone();
  const lo = Math.min(8, any[0].h), hi = Math.max(18, any[any.length - 1].h);
  const pts = rows.filter((r) => r.h >= lo && r.h <= hi);
  const hl = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });
  if (table) return dashTable(["Hour", "Incoming", "Outgoing", "Missed", "Total"],
    pts.map((r) => [hl(r.h), dashN(r.incoming), dashN(r.outgoing), dashN(r.missed), `<b>${dashN(dashTotal(r))}</b>`]));

  const H = 230, L = 34, R = 14, T = 12, B = 26;
  const { max, ticks } = dashTicks(Math.max(...pts.map((r) => Math.max(r.incoming, r.outgoing, r.missed))));
  const x = (i) => L + (pts.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (pts.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const grid = ticks.map((v) =>
    `<line class="dash-grid-l" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="dash-ax" x="${L - 8}" y="${y(v) + 3.5}" text-anchor="end">${dashN(v)}</text>`).join("");
  /* Today, the lines stop at the current hour: an afternoon that has not
     happened yet is not an afternoon with no calls. The axis keeps the whole
     working day so the morning reads in context. */
  const nowH = d.range.from === d.range.today && d.range.to === d.range.today
    ? new Date().getHours() : 99;
  const drawn = pts.filter((r) => r.h <= nowH);
  const step = Math.ceil(pts.length / Math.max(2, Math.floor((W - L - R) / 56)));
  const xlab = pts.map((r, i) => i % step ? "" :
    `<text class="dash-ax" x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(hl(r.h))}</text>`).join("");
  const line = (k) => drawn.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(r[k]).toFixed(1)}`).join("");
  const lines = DASH_SERIES.map(([k, , c]) =>
    `<path class="dash-line" d="${line(k)}" stroke="${c}"/>`).join("");
  /* the newest point of each line gets its end-dot, ringed in the surface */
  const ends = drawn.length ? DASH_SERIES.map(([k, , c]) =>
    `<circle class="dash-end" cx="${x(drawn.length - 1)}" cy="${y(drawn[drawn.length - 1][k])}" r="4" fill="${c}"/>`).join("") : "";
  const band = (W - L - R) / Math.max(1, pts.length - 1);
  const hits = drawn.map((r, i) => {
    const tip = dashTip(`<div class="dash-tip-h">${esc(hl(r.h))} – ${esc(hl(r.h + 1))}</div>${dashTipRows(r)}`);
    return `<g class="dash-hit" data-tip="${tip}" tabindex="0">
      <rect x="${x(i) - band / 2}" y="${T}" width="${band}" height="${H - T - B}" fill="transparent"/>
      <line class="dash-cross" x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${H - B}"/>
      ${DASH_SERIES.map(([k, , c]) => `<circle class="dash-dot" cx="${x(i)}" cy="${y(r[k])}" r="4" fill="${c}"/>`).join("")}
    </g>`;
  }).join("");
  return `${dashLegend()}<svg class="dash-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
    aria-label="Calls per hour: incoming, outgoing and missed">${grid}${xlab}${lines}${ends}${hits}</svg>`;
}

/* 7 days: stacked columns, incoming at the base, a 2px gap between segments,
   the total on the cap. Today's label is the one in bold. */
function dashWeek(d, W, table) {
  const rows = d.week;
  const dl = (r) => new Date(r.date + "T12:00").toLocaleDateString([], { weekday: "short", day: "numeric" });
  if (table) return dashTable(["Day", "Incoming", "Outgoing", "Missed", "Total"],
    rows.map((r) => [esc(dl(r)), dashN(r.incoming), dashN(r.outgoing), dashN(r.missed), `<b>${dashN(dashTotal(r))}</b>`]));
  if (!rows.some(dashTotal)) return dashNone("No calls in the last 7 days");

  const H = 230, L = 34, R = 8, T = 18, B = 26, GAP = 2;
  const { max, ticks } = dashTicks(Math.max(...rows.map(dashTotal)));
  const slot = (W - L - R) / rows.length;
  const bw = Math.min(24, slot * 0.56);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const grid = ticks.map((v) =>
    `<line class="dash-grid-l" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="dash-ax" x="${L - 8}" y="${y(v) + 3.5}" text-anchor="end">${dashN(v)}</text>`).join("");
  const cols = rows.map((r, i) => {
    const cx = L + slot * i + slot / 2, x0 = cx - bw / 2;
    let base = H - B;
    const segs = DASH_SERIES.filter(([k]) => r[k]).map(([k, , c], j, arr) => {
      const h = Math.max(1, (H - T - B) * (r[k] / max) - (j ? GAP : 0));
      const top = base - (j ? GAP : 0) - h;
      const last = j === arr.length - 1;
      base = top;
      /* only the cap is rounded: square at the baseline, 4px at the data end */
      return last
        ? `<path d="M${x0} ${top + h}V${top + 4}q0 -4 4 -4h${bw - 8}q4 0 4 4V${top + h}z" fill="${c}"/>`
        : `<rect x="${x0}" y="${top}" width="${bw}" height="${h}" fill="${c}"/>`;
    }).join("");
    const tot = dashTotal(r);
    const isToday = r.date === d.range.today;
    const tip = dashTip(`<div class="dash-tip-h">${esc(new Date(r.date + "T12:00").toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }))}</div>${dashTipRows(r)}`);
    return `<g class="dash-hit" data-tip="${tip}" tabindex="0">
      <rect x="${L + slot * i}" y="${T - 14}" width="${slot}" height="${H - T - B + 14}" fill="transparent"/>
      ${segs}
      ${tot ? `<text class="dash-cap" x="${cx}" y="${y(tot) - 6}" text-anchor="middle">${dashN(tot)}</text>` : ""}
      <text class="dash-ax${isToday ? " today" : ""}" x="${cx}" y="${H - 6}" text-anchor="middle">${esc(dl(r))}</text>
    </g>`;
  }).join("");
  return `${dashLegend()}<svg class="dash-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
    aria-label="Calls per day for the last seven days">${grid}${cols}</svg>`;
}

/* Results: a donut, ≤6 slices with a 2px surface gap, the total in the hole,
   and a legend carrying count and share so nothing depends on the colour. */
function dashResults(d, W, table) {
  const rows = d.results || [];
  const tot = rows.reduce((s, r) => s + r.count, 0);
  if (!tot) return dashNone();
  const color = (r) => r.other || !DASH_RESULT_SLOT[r.label] ? "var(--ink-3)" : `var(--cat-${DASH_RESULT_SLOT[r.label]})`;
  if (table) return dashTable(["Result", "Calls", "Share"],
    rows.map((r) => [esc(r.label), dashN(r.count), dashPct(r.count / tot)]));

  const S_ = 168, C = S_ / 2, RO = 76, RI = 52;
  let a0 = -Math.PI / 2;
  const gap = rows.length > 1 ? 0.018 : 0;
  const arcs = rows.map((r) => {
    const a = (r.count / tot) * Math.PI * 2;
    const s = a0 + gap / 2, e = a0 + a - gap / 2;
    a0 += a;
    const big = e - s > Math.PI ? 1 : 0;
    const p = (rad, ang) => `${(C + rad * Math.cos(ang)).toFixed(2)} ${(C + rad * Math.sin(ang)).toFixed(2)}`;
    const path = rows.length === 1
      ? `M${C} ${C - RO}a${RO} ${RO} 0 1 1 -0.01 0zM${C} ${C - RI}a${RI} ${RI} 0 1 0 0.01 0z`
      : `M${p(RO, s)}A${RO} ${RO} 0 ${big} 1 ${p(RO, e)}L${p(RI, e)}A${RI} ${RI} 0 ${big} 0 ${p(RI, s)}z`;
    const tip = dashTip(`<div class="dash-tip-h">${esc(r.label)}</div><div class="dash-tip-row"><i style="background:${color(r)}"></i>${dashN(r.count)} calls<b>${dashPct(r.count / tot)}</b></div>`);
    return `<path class="dash-arc" d="${path}" fill="${color(r)}" fill-rule="evenodd" data-tip="${tip}" tabindex="0"/>`;
  }).join("");
  const legend = rows.map((r) => `<li><i style="background:${color(r)}"></i><span>${esc(r.label)}</span>
    <b>${dashN(r.count)}</b><em>${dashPct(r.count / tot)}</em></li>`).join("");
  return `<div class="dash-donut">
    <svg width="${S_}" height="${S_}" viewBox="0 0 ${S_} ${S_}" role="img" aria-label="Calls by result">${arcs}
      <text class="dash-donut-v" x="${C}" y="${C + 2}" text-anchor="middle">${dashN(tot)}</text>
      <text class="dash-donut-l" x="${C}" y="${C + 18}" text-anchor="middle">calls</text></svg>
    <ul class="dash-rlegend">${legend}</ul></div>`;
}

/* Dispositions: one series, so one colour — a bar per disposition, longest
   first, count and share at the end. Logged by reps in the dialler's wrap-up
   (POST /api/leads/:id/disposition), so this is OUR data, not RingCentral's;
   it only knows calls wrapped up in Karma Connect. */
function dashDispo(d, W, table) {
  if (DASH.dispoError) return dashNone("Couldn't load dispositions — " + esc(DASH.dispoError));
  const rows = DASH.dispo?.counts || [];
  const tot = rows.reduce((s, r) => s + r.count, 0);
  if (!tot) return `<div class="dash-none dash-none-tall">No dispositions logged in this period.<br>
    <span class="dash-mute">They're recorded when a rep picks one after a call in the dialler.</span></div>`;
  if (table) return dashTable(["Disposition", "Calls", "Share"],
    rows.map((r) => [esc(r.disposition), dashN(r.count), dashPct(r.count / tot)]));
  const max = rows[0].count;
  return `<div class="dash-rows dash-dispos">${rows.map((r) => {
    const tip = dashTip(`<div class="dash-tip-h">${esc(r.disposition)}</div>
      <div class="dash-tip-row">${dashN(r.count)} call${r.count === 1 ? "" : "s"}<b>${dashPct(r.count / tot)}</b></div>`);
    return `<div class="dash-row" data-tip="${tip}" tabindex="0">
      <span class="dash-who"><b>${esc(r.disposition)}</b></span>
      <span class="dash-track"><div class="dash-bar"><i style="flex:0 0 ${Math.max(1.5, (r.count / max) * 100)}%;background:var(--accent)"></i></div></span>
      <span class="n"><b>${dashN(r.count)}</b></span>
      <span class="n dash-mute">${dashPct(r.count / tot)}</span></div>`;
  }).join("")}</div>`;
}

function dashDlogSub() {
  const t = DASH.dispo?.total || 0;
  if (!t) return "Every disposition, newest first";
  return t > 200 ? `Latest 200 of ${dashN(t)}` : `${dashN(t)} logged, newest first`;
}

/* The log itself: a table is the chart here — who, which lead, what, when. */
function dashDlog() {
  if (DASH.dispoError) return dashNone("Couldn't load the disposition log — " + esc(DASH.dispoError));
  const rows = DASH.dispo?.log || [];
  if (!rows.length) return `<div class="dash-none dash-none-tall">Nothing logged yet for this period.</div>`;
  const oneDay = DASH.data && DASH.data.range.from === DASH.data.range.to;
  const when = (at) => {
    const t = new Date(at);
    const time = t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return oneDay ? time : t.toLocaleDateString([], { weekday: "short", day: "numeric" }) + " · " + time;
  };
  const line = (r) => !r.onCall ? `<span class="dash-mute">no call</span>`
    : [({ connected: "Connected", "no-answer": "No answer", busy: "Busy", failed: "Failed",
      cancelled: "Cancelled", placed: "Placed" })[r.outcome] || r.outcome || "",
    r.seconds ? dashDur(r.seconds) : ""].filter(Boolean).map(esc).join(" · ");
  return `<div class="dash-tablewrap dash-dlog"><table class="dash-table">
    <thead><tr><th>When</th><th>Agent</th><th>Lead</th><th>Disposition</th><th>Line</th><th>Note</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td class="dash-nowrap">${esc(when(r.at))}</td>
      <td class="dash-nowrap">${esc(r.name)}</td>
      <td>${esc(r.lead_name || "—")}</td>
      <td><span class="dash-chip">${esc(r.disposition)}</span></td>
      <td class="dash-nowrap">${line(r)}</td>
      <td class="dash-note">${esc(r.note || "")}</td></tr>`).join("")}</tbody></table></div>`;
}

/* A horizontal stacked bar per row, as HTML: names stay horizontal and
   readable however many people there are — the rotated labels in the
   screenshot this replaces are the first thing people complain about. */
function dashBars(rows, max) {
  return rows.map((r) => {
    const tot = dashTotal(r);
    const segs = DASH_SERIES.filter(([k]) => r[k]).map(([k, , c]) =>
      `<i style="flex:${r[k]} 0 0;background:${c}"></i>`).join("");
    return { tot, html: `<div class="dash-bar" style="width:${max ? Math.max(tot ? 1.5 : 0, (tot / max) * 100) : 0}%">${segs}</div>` };
  });
}

function dashAgents(d, W, table) {
  const live = new Map((d.agents?.list || []).map((a) => [a.id, a]));
  const rows = d.byAgent.map((r) => ({ ...r, live: live.get(r.id) }));
  /* People who are signed in but have made no calls belong on this board:
     an empty row is the most useful thing on it. */
  const seen = new Set(rows.map((r) => r.id));
  for (const a of d.agents?.list || [])
    if (!seen.has(a.id)) rows.push({ id: a.id, name: a.name, ext: a.ext, incoming: 0, outgoing: 0,
      missed: 0, connected: 0, talkSecs: 0, live: a });
  if (!rows.length) return dashNone("No agents yet");
  const status = (a) => !a ? ["", "Unknown"] : a.onCall ? ["oncall", "On a call"]
    : a.status === "Offline" ? ["off", "Offline"] : ["avail", a.status === "Busy" ? "Busy" : "Available"];
  if (table) return dashTable(["Agent", "Status", "Incoming", "Outgoing", "Missed", "Connected", "Talk time"],
    rows.map((r) => [esc(r.name) + (r.ext ? ` <span class="dash-mute">x${esc(r.ext)}</span>` : ""), esc(status(r.live)[1]),
      dashN(r.incoming), dashN(r.outgoing), dashN(r.missed), dashN(r.connected), dashDur(r.talkSecs)]));

  const max = Math.max(...rows.map(dashTotal), 1);
  const bars = dashBars(rows, max);
  return `${dashLegend()}<div class="dash-rows dash-agents">
    <div class="dash-rowh"><span>Agent</span><span></span><span class="n">Calls</span><span class="n">Connected</span><span class="n">Talk</span></div>
    ${rows.map((r, i) => {
      const [cls, label] = status(r.live);
      const tip = dashTip(`<div class="dash-tip-h">${esc(r.name)}${r.ext ? " · x" + esc(r.ext) : ""}</div>${dashTipRows(r)}
        <div class="dash-tip-row dash-tip-sep">Talk time<b>${dashDur(r.talkSecs)}</b></div>`);
      return `<div class="dash-row${bars[i].tot ? "" : " idle"}" data-tip="${tip}" tabindex="0">
        <span class="dash-who"><i class="dash-pres ${cls}" title="${esc(label)}"></i><b>${esc(r.name)}</b>${r.ext ? `<em>x${esc(r.ext)}</em>` : ""}</span>
        <span class="dash-track">${bars[i].html}</span>
        <span class="n"><b>${dashN(bars[i].tot)}</b></span>
        <span class="n">${dashN(r.connected)}</span>
        <span class="n">${dashDur(r.talkSecs)}</span>
      </div>`;
    }).join("")}</div>`;
}

function dashNumbers(d, W, table) {
  const rows = d.byNumber || [];
  if (!rows.length) return dashNone();
  const label = (r) => r.other ? "Other numbers" : dashPhone(r.number);
  if (table) return dashTable(["Number", "Incoming", "Outgoing", "Missed", "Total"],
    rows.map((r) => [esc(label(r)), dashN(r.incoming), dashN(r.outgoing), dashN(r.missed), `<b>${dashN(dashTotal(r))}</b>`]));
  const max = Math.max(...rows.map(dashTotal), 1);
  const bars = dashBars(rows, max);
  return `${dashLegend()}<div class="dash-rows dash-nums">${rows.map((r, i) => {
    const tip = dashTip(`<div class="dash-tip-h">${esc(label(r))}</div>${dashTipRows(r)}`);
    return `<div class="dash-row" data-tip="${tip}" tabindex="0">
      <span class="dash-who"><b class="dash-num">${esc(label(r))}</b></span>
      <span class="dash-track">${bars[i].html}</span>
      <span class="n"><b>${dashN(bars[i].tot)}</b></span></div>`;
  }).join("")}</div>`;
}

/* The map card: the world by default, with US & Canada by state/province a
   click away. Both are shaded on one sequential hue — more calls, deeper
   blue — in five classes, with the scale shown; a place with no calls stays
   a quiet outline. */
const DASH_STEPS = [22, 40, 58, 78, 100];
/* Land with no calls: a faint ink tint rather than --surface-2, which on the
   light theme is one shade off white and makes the continents disappear. */
const DASH_LAND = "color-mix(in srgb, var(--ink) 8%, var(--surface))";
const dashShade = (c) => c < 0 ? DASH_LAND
  : `color-mix(in srgb, var(--cat-1) ${DASH_STEPS[c]}%, var(--surface-2))`;
const dashClass = (n, max) => !n ? -1 : Math.min(4, Math.floor(((n - 1) / Math.max(1, max)) * 5));

function dashMap(d, W, table) {
  return (DASH.mapView || "world") === "na" ? dashNaMap(d, W, table) : dashWorldMap(d, W, table);
}
function dashMapSeg() {
  const view = DASH.mapView || "world";
  const b = (v, label) => `<button data-mapview="${v}" class="${view === v ? "on" : ""}" aria-pressed="${view === v}">${label}</button>`;
  return `<div class="dash-seg dash-mapseg" role="group" aria-label="Map">${b("world", "World")}${b("na", "US &amp; Canada")}</div>`;
}

/* The world: Natural Earth countries, Equal Earth projection (world-geo.js).
   Tibet is its own region, drawn over China with its own outline, tint and
   a "Tibet" label that is always on — see build-world-geo.mjs. India, where
   the floor sits, is picked out the same way in its own colour (orange). */
function dashWorldMap(d, W, table) {
  const g = window.WORLD_GEO;
  const rows = (d.byCountry || []).slice().sort((a, b) => b.count - a.count);
  const nameOf = (c) => g?.meta?.[c]?.name || c;
  if (table || !g) {
    if (!rows.length) return dashNone("No calls with a recognisable country in this period");
    return dashTable(["Country", "Calls"], rows.map((r) => [esc(nameOf(r.code)), dashN(r.count)]));
  }
  const max = rows[0]?.count || 0;
  const by = new Map(rows.map((r) => [r.code, r.count]));
  /* India and Tibet last, Tibet on top: their highlighted borders meet, and
     Tibet's must not be painted over. */
  const order = (g.order || Object.keys(g.shapes)).filter((c) => c !== "IN" && c !== "TIB");
  if (g.shapes.IN) order.push("IN");
  if (g.shapes.TIB || g.parts?.TIB) order.push("TIB");
  const shapes = order.map((code) => {
    const n = by.get(code) || 0, c = dashClass(n, max);
    const tibet = code === "TIB", india = code === "IN";
    const fill = tibet && !n ? "color-mix(in srgb, var(--gold) 30%, var(--surface))"
      : india ? `color-mix(in srgb, var(--cat-2) ${n ? 55 : 32}%, var(--surface))` : dashShade(c);
    const tip = dashTip(`<div class="dash-tip-h">${esc(nameOf(code))}</div>${
      tibet ? `<div class="dash-tip-row dash-mute">Ü-Tsang · Kham · Amdo</div>` : ""}<div class="dash-tip-row">${
      n ? dashN(n) + " call" + (n === 1 ? "" : "s") : "No calls"}</div>`);
    /* Tibet arrives as overlapping pieces (see build-world-geo.mjs). Two
       passes make it one region: every piece stroked gold first, then every
       piece filled on top — the fill buries the inner edges, so only the
       outer border shows. The fill pass carries a hairline stroke in its own
       colour to close the sub-pixel seams where pieces meet. */
    if (tibet && g.parts?.TIB) {
      const p = g.parts.TIB;
      return `<g class="dash-tibet-g" data-tip="${tip}" tabindex="0">
        ${p.map((d) => `<path class="dash-tib-o" d="${d}" fill="${fill}"/>`).join("")}
        ${p.map((d) => `<path class="dash-tib-f" d="${d}" fill="${fill}" stroke="${fill}"/>`).join("")}</g>`;
    }
    return `<path class="dash-reg${n ? " lit" : ""}${tibet ? " dash-tibet" : ""}${india ? " dash-india" : ""}" d="${g.shapes[code]}"
      fill="${fill}" data-tip="${tip}"${n || tibet || india ? ' tabindex="0"' : ""}/>`;
  }).join("");
  const lab = (code, text, sub, cls = "") => {
    const p = g.labels[code];
    if (!p) return "";
    return `<text class="dash-wlab ${cls}" x="${p[0]}" y="${p[1]}" text-anchor="middle">${esc(text)}${
      sub ? `<tspan class="n" x="${p[0]}" dy="9">${esc(sub)}</tspan>` : ""}</text>`;
  };
  const labels = rows.filter((r) => r.code !== "TIB" && r.code !== "IN").slice(0, 8)
    .map((r) => lab(r.code, r.code, dashN(r.count), dashClass(r.count, max) >= 3 ? "on-dark" : "")).join("")
    + lab("IN", "INDIA", by.get("IN") ? dashN(by.get("IN")) : "", "dash-inlab")
    + lab("TIB", "TIBET", by.get("TIB") ? dashN(by.get("TIB")) : "", "dash-tiblab");
  const top = rows.slice(0, 6).map((r) => `<li><span>${esc(nameOf(r.code))}</span>
    <i style="width:${(r.count / max) * 100}%"></i><b>${dashN(r.count)}</b></li>`).join("");
  const scale = max ? `<div class="dash-scale"><span>Fewer</span>${DASH_STEPS.map((s) =>
    `<i style="background:color-mix(in srgb, var(--cat-1) ${s}%, var(--surface-2))"></i>`).join("")}<span>More</span></div>` : "";
  return `<div class="dash-mapwrap">
    <svg class="dash-map dash-world" viewBox="0 0 ${g.width} ${g.height}" preserveAspectRatio="xMidYMid meet"
      role="img" aria-label="Calls by country">${shapes}${labels}</svg>
    <aside class="dash-maplist">
      <h4>Top countries</h4>
      ${rows.length ? `<ul>${top}</ul>` : `<p class="dash-mute">No calls with a recognisable country yet.</p>`}
      ${scale}
      <p class="dash-mute dash-fine">From the other party's country code. Tibet — Ü-Tsang, Kham and Amdo — is shown as its own country; India is picked out in orange.</p>
    </aside></div>`;
}

function dashNaMap(d, W, table) {
  const g = window.NA_GEO;
  const rows = (d.byRegion || []).slice().sort((a, b) => b.count - a.count);
  const nameOf = (c) => g?.meta?.[c]?.name || STATE_NAME[c] || c;
  if (table || !g) {
    if (!rows.length) return dashNone("No calls to a US or Canadian number in this period");
    return dashTable(["State / province", "Calls"], rows.map((r) => [esc(nameOf(r.code)), dashN(r.count)]));
  }
  const max = rows[0]?.count || 0;
  const STEPS = [22, 40, 58, 78, 100];
  const cls = (n) => !n ? -1 : Math.min(4, Math.floor(((n - 1) / Math.max(1, max)) * 5));
  const by = new Map(rows.map((r) => [r.code, r.count]));
  const shapes = Object.keys(g.shapes).map((code) => {
    const n = by.get(code) || 0, c = cls(n);
    const fill = c < 0 ? DASH_LAND : `color-mix(in srgb, var(--cat-1) ${STEPS[c]}%, var(--surface-2))`;
    const tip = dashTip(`<div class="dash-tip-h">${esc(nameOf(code))}</div><div class="dash-tip-row">${n ? dashN(n) + " call" + (n === 1 ? "" : "s") : "No calls"}</div>`);
    return `<path class="dash-reg${n ? " lit" : ""}" d="${g.shapes[code]}" fill="${fill}" data-tip="${tip}"${n ? ' tabindex="0"' : ""}/>`;
  }).join("");
  const labels = rows.filter((r) => g.labels[r.code]).map((r) => {
    const [x, y] = g.labels[r.code];
    const dark = cls(r.count) >= 3;
    return `<text class="dash-maplab${dark ? " on-dark" : ""}" x="${x}" y="${y}" text-anchor="middle">
      <tspan x="${x}" dy="0">${esc(r.code)}</tspan><tspan class="n" x="${x}" dy="9">${dashN(r.count)}</tspan></text>`;
  }).join("");
  const vb = (g.view || [0, 0, g.width, g.height]).join(" ");
  const top = rows.slice(0, 6).map((r) => `<li><span>${esc(nameOf(r.code))}</span>
    <i style="width:${(r.count / max) * 100}%"></i><b>${dashN(r.count)}</b></li>`).join("");
  const scale = max ? `<div class="dash-scale"><span>Fewer</span>${STEPS.map((s) =>
    `<i style="background:color-mix(in srgb, var(--cat-1) ${s}%, var(--surface-2))"></i>`).join("")}<span>More</span></div>` : "";
  return `<div class="dash-mapwrap">
    <svg class="dash-map" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" role="img"
      aria-label="Calls by state and province">${shapes}${labels}</svg>
    <aside class="dash-maplist">
      <h4>Top regions</h4>
      ${rows.length ? `<ul>${top}</ul>` : `<p class="dash-mute">No calls to a US or Canadian number yet.</p>`}
      ${scale}
      <p class="dash-mute dash-fine">From the other party's area code — where a number was issued, not necessarily where they are.</p>
    </aside></div>`;
}

/* ================= Call logs — every RingCentral call =================

   One search row (date, free text) and one filter row (agent, type, result,
   number, disposition, recorded) scope the table, the totals and the
   download alike — what you download is what you are looking at, every
   page of it. Filters are applied server-side over the cached call log, so
   changing one is quick and costs RingCentral nothing. */

const CL = {
  preset: "today", from: "", to: "", q: "", agent: "", mode: "", result: "",
  number: "", disposition: "", rec: false, page: 1, per: 50,
  data: null, error: null, wired: false, seq: 0,
};

function clSpan() {
  const now = new Date(), ymd = dashYmd;
  const back = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return ymd(d); };
  switch (CL.preset) {
    case "yesterday": return { from: back(1), to: back(1) };
    case "7": return { from: back(6), to: ymd(now) };
    case "30": return { from: back(29), to: ymd(now) };
    case "month": return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) };
    case "custom": return { from: CL.from || ymd(now), to: CL.to || CL.from || ymd(now) };
    default: return { from: ymd(now), to: ymd(now) };
  }
}
function clQuery(extra = {}) {
  const { from, to } = clSpan();
  const q = new URLSearchParams({ from, to, tz: dashTz(), page: CL.page, per: CL.per, ...extra });
  for (const [k, v] of [["q", CL.q], ["agent", CL.agent], ["mode", CL.mode], ["result", CL.result],
    ["number", CL.number], ["disposition", CL.disposition]]) if (v) q.set(k, v);
  if (CL.rec) q.set("rec", "1");
  return q;
}

async function loadCallLog(fresh = false) {
  clWire();
  const body = $("cl-body");
  if (!CL.data) body.innerHTML = `<div class="dash-empty"><div class="dash-spin"></div>Reading the call log from RingCentral…</div>`;
  else body.classList.add("dash-stale");
  const seq = ++CL.seq;                     // a slow answer to an old search never overwrites a newer one
  try {
    const d = await api("/api/voice/rc/calllog?" + clQuery(fresh ? { fresh: 1 } : {}));
    if (seq !== CL.seq) return;
    CL.data = d; CL.error = null;
  } catch (e) {
    if (seq !== CL.seq) return;
    CL.error = e.message || String(e);
  }
  body.classList.remove("dash-stale");
  renderCallLog();
  if (fresh) toast(CL.error ? "Couldn't refresh — " + CL.error : "Call logs refreshed");
}

function clWire() {
  if (CL.wired) return;
  CL.wired = true;
  on("cl-crm", "click", openCrmSync);
  /* Same page, same filters — only newer. Disabled while it reads so a
     double click is one request. */
  on("cl-refresh", "click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true; b.textContent = "Refreshing…";
    try { await loadCallLog(true); } finally { b.disabled = false; b.textContent = "Refresh"; }
  });
  crmPaintChip();
  const reload = () => { CL.page = 1; loadCallLog(); };
  on("cl-preset", "change", (e) => {
    CL.preset = e.target.value;
    const custom = CL.preset === "custom";
    for (const id of ["cl-from", "cl-arrow", "cl-to"]) $(id).classList.toggle("hidden", !custom);
    if (custom && !CL.from) { const s = clSpan(); $("cl-from").value = CL.from = s.from; $("cl-to").value = CL.to = s.to; }
    reload();
  });
  on("cl-from", "change", (e) => { CL.from = e.target.value; if (CL.to && CL.to < CL.from) $("cl-to").value = CL.to = CL.from; reload(); });
  on("cl-to", "change", (e) => { CL.to = e.target.value; reload(); });
  let t;
  on("cl-q", "input", (e) => { clearTimeout(t); t = setTimeout(() => { CL.q = e.target.value.trim(); reload(); }, 350); });
  for (const [id, key] of [["cl-agent", "agent"], ["cl-mode", "mode"], ["cl-result", "result"],
    ["cl-number", "number"], ["cl-dispo", "disposition"]])
    on(id, "change", (e) => { CL[key] = e.target.value; reload(); });
  on("cl-rec", "click", () => { CL.rec = !CL.rec; reload(); });
  on("cl-clear", "click", () => {
    Object.assign(CL, { q: "", agent: "", mode: "", result: "", number: "", disposition: "", rec: false });
    $("cl-q").value = "";
    reload();
  });

  const pop = $("cl-dl-pop"), open = $("cl-dl-open");
  on("cl-dl-open", "click", (e) => {
    e.stopPropagation();
    const show = pop.classList.contains("hidden");
    pop.classList.toggle("hidden", !show);
    open.setAttribute("aria-expanded", String(show));
  });
  document.addEventListener("click", (e) => {
    if (!pop.classList.contains("hidden") && !e.target.closest("#cl-dl-pop")) {
      pop.classList.add("hidden"); open.setAttribute("aria-expanded", "false");
    }
  });
  pop.addEventListener("click", (e) => {
    const b = e.target.closest("[data-format]");
    if (!b) return;
    const q = clQuery({ format: b.dataset.format });
    q.delete("page"); q.delete("per");
    const a = document.createElement("a");
    a.href = "/api/voice/rc/calllog?" + q;
    a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    pop.classList.add("hidden"); open.setAttribute("aria-expanded", "false");
    toast("Preparing your download…", 3000);
  });

  const body = $("cl-body");
  body.addEventListener("click", (e) => {
    const lead = e.target.closest("[data-cl-lead]");
    if (lead) {
      const tab = KIND_TAB[lead.dataset.kind] || "companies";
      setTab(tab);
      return select({ Id: +lead.dataset.clLead, _t: tab });
    }
    const play = e.target.closest("[data-play]");
    if (play) {
      const id = play.dataset.play;
      play.closest(".cl-rec").innerHTML = `<audio controls autoplay preload="none" src="/api/voice/rc/recording/${encodeURIComponent(id)}"></audio>
        <a class="cl-recdl" href="/api/voice/rc/recording/${encodeURIComponent(id)}?download=1" title="Download the recording" aria-label="Download the recording">⤓</a>`;
      return;
    }
    const pg = e.target.closest("[data-page]");
    if (pg && !pg.disabled) { CL.page = +pg.dataset.page; loadCallLog(); body.scrollTop = 0; }
  });
  body.addEventListener("change", (e) => {
    if (e.target.id === "cl-per") { CL.per = +e.target.value; CL.page = 1; loadCallLog(); }
  });
  /* One recording at a time: starting one pauses whichever was playing. */
  body.addEventListener("play", (e) => {
    body.querySelectorAll("audio").forEach((a) => { if (a !== e.target) a.pause(); });
  }, true);
}

/* ---------------- Zoho CRM sync: the chip and its panel ---------------- */

async function crmPaintChip() {
  const chip = $("cl-crm"), txt = $("cl-crm-text");
  if (!chip) return;
  try {
    const s = await api("/api/crm/sync");
    CL.crm = s;
    chip.classList.toggle("on", s.on);
    chip.classList.toggle("warn", s.on && s.stats.errors > 0);
    txt.textContent = !s.configured ? "Zoho CRM · not set up"
      : !s.on ? "Zoho CRM · off"
        : `Zoho CRM · on · ${dashN(s.stats.today)} sent today${s.stats.errors ? ` · ${s.stats.errors} failed` : ""}`;
  } catch (e) { txt.textContent = "Zoho CRM · unavailable"; }
}

/* ---------- each person's own Zoho CRM sign-in ----------
   Optional, and each rep does it themselves: once connected, the calls and
   Leads Karma Connect creates in Zoho are filed under them instead of the
   shared account (server/crm-identity.js). */
let CRMME = null;

async function crmMeLoad() {
  try { CRMME = await api("/api/crm/me"); } catch (e) { CRMME = null; }
  const bar = $("crm-me-bar");
  if (bar) bar.outerHTML = crmMeBar();
  kdRenderSettings();          // a no-op unless the settings panel is open
}

function crmMeBar() {
  const c = CRMME;
  if (!c) return `<div id="crm-me-bar" hidden></div>`;
  if (!c.enabled) return isAdmin()
    ? `<div id="crm-me-bar" class="rc-bar"><span>Personal Zoho CRM sign-in isn't set up on this server yet,
        so every call and Lead goes into Zoho under the shared account.${c.missing && c.missing.length
          ? ` Missing on the server: <b>${c.missing.map(esc).join(", ")}</b>.` : ""}</span></div>`
    : `<div id="crm-me-bar" hidden></div>`;
  if (c.connected && c.lastError) return `<div id="crm-me-bar" class="rc-bar">
      <b>Zoho CRM refused your sign-in.</b> ${esc(c.lastError)} — your calls are going in under the shared account.
      <a class="btn-primary rc-go" href="${esc(c.connectUrl)}">Reconnect Zoho CRM</a>
      ${isAdmin() ? `<button class="btn-ghost rc-off" id="crm-disconnect">Disconnect</button>` : ""}</div>`;
  if (c.connected) return `<div id="crm-me-bar" class="rc-bar on">
      <span class="rc-dot"></span>
      Zoho CRM connected${c.name || c.email ? " as " + esc(c.name || c.email) : ""} — your calls and leads are filed under you
      ${isAdmin() ? `<button class="btn-ghost rc-off" id="crm-disconnect">Disconnect</button>` : ""}</div>`;
  return `<div id="crm-me-bar" class="rc-bar">
      <b>Connect your Zoho CRM.</b> The calls and leads you create are then filed under you in Zoho —
      until then they go in under the shared account.
      <a class="btn-primary rc-go" href="${esc(c.connectUrl)}">Connect Zoho CRM</a></div>`;
}

/* ---------------- Zoho CRM call logging: the panel ----------------
   One wide modal (.modal.crm-panel), read top to bottom:
     header   — On/Off, who changed it, the owner's switch
     health   — four quiet tiles; a tile only colours when it is a problem
     attention— failed sends / missing recordings and their retry buttons,
                rendered only when there is something to fix
     tabs     — "Next calls" (the preview, each Description folded away) and
                "Sign-ins" (the admin roster); no nested scroll boxes, the
                modal itself scrolls
   Same three reads as before (/api/crm/sync, /sync/preview, /people), same
   handlers, same confirms, same role gating (isOwner for the switch; the
   roster is whatever /api/crm/people returns, which is admin-only). */

/* sub is HTML (the recordings tile colours one phrase of it); label and value are text */
function crmTile(label, value, sub, mood) {
  return `<div class="crm-tile${mood ? " " + mood : ""}"><div class="crm-tile-l">${esc(label)}</div>
    <div class="crm-tile-v">${esc(value)}</div>${sub ? `<div class="crm-tile-s">${sub}</div>` : ""}</div>`;
}

/* one call from the preview — the long Description sits behind Show details */
function crmPreviewCard(it) {
  if (it.error) return `<div class="crm-card"><div class="crm-card-h"><b>${esc(it.lead || "Call")}</b></div>
    <p class="login-error">${esc(it.error)}</p></div>`;
  const c = it.call;
  const start = new Date(c.Call_Start_Time);
  const meta = [
    it.as === "rep" ? `Filed under <b>${esc(it.asName)}</b>` : "Shared account",
    esc(Number.isNaN(start.getTime()) ? c.Call_Start_Time : start.toLocaleString()),
    esc(c.Call_Duration),
    c.Call_Result ? `Call Result <b>${esc(c.Call_Result)}</b>` : "",
  ].filter(Boolean).join(" · ");
  return `<div class="crm-card">
    <div class="crm-card-h"><b>${esc(c.Subject)}</b>
      ${it.link ? `<span class="dash-chip">${esc(it.link.module)} · ${esc(it.link.name || it.link.id)}</span>`
        : `<span class="dash-chip crm-chip-warn">No CRM match — logged unattached</span>`}</div>
    <div class="crm-card-m">${meta}</div>
    ${c.Description ? `<details class="crm-more"><summary><span class="crm-more-show">Show details</span><span class="crm-more-hide">Hide details</span></summary>
      <pre>${esc(c.Description)}</pre></details>` : ""}
  </div>`;
}

/* one person on the roster: name, their connection state, Disconnect */
function crmPersonRow(p) {
  const connected = !!p.connected_at;
  const state = !connected ? `<span class="dash-chip">Not connected</span>`
    : p.last_error ? `<span class="dash-chip bad" title="${esc(p.last_error)}">Refused — needs to reconnect</span>`
      : `<span class="dash-chip ok">Connected as ${esc(p.zoho_name || p.zoho_email || "themselves")}</span>`;
  const when = connected ? `<span title="connected ${esc(new Date(p.connected_at).toLocaleString())}">${
    p.last_used_at ? "used " + esc(relTime(p.last_used_at)) : "since " + esc(relTime(p.connected_at))}</span>` : "";
  return `<div class="crm-row${connected ? "" : " off"}">
    <span class="avatar avatar-sm" style="background:${avColor(p.email)}">${esc(initials(p.name))}</span>
    <div class="crm-row-id">
      <div class="crm-row-n">${esc(p.name)}${p.role === "sales_rep" ? `<span class="asg-tag">Sales rep</span>` : ""}</div>
      <div class="crm-row-s">${state}${when}</div>
    </div>
    ${connected ? `<button type="button" class="btn-ghost crm-row-off" data-crm-off="${esc(p.email)}">Disconnect</button>` : ""}
  </div>`;
}

function crmShowTab(name) {
  document.querySelectorAll("[data-crm-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.crmTab === name)));
  document.querySelectorAll("[data-crm-pane]").forEach((p) => p.toggleAttribute("hidden", p.dataset.crmPane !== name));
}

async function openCrmSync() {
  $("modal-title").textContent = "Zoho CRM call logging";
  document.querySelector(".modal")?.classList.add("crm-panel");
  $("modal-body").innerHTML = `<p class="modal-sub">Loading…</p>`;
  $("modal-backdrop").classList.remove("hidden");
  let tab = "preview";                    // which tab is open; kept across repaints
  const paint = async () => {
    let s, prev = null;
    try { s = await api("/api/crm/sync"); } catch (e) {
      $("modal-body").innerHTML = `<p class="login-error">${esc(e.message)}</p>
        <div class="modal-actions"><button type="button" class="btn-secondary" id="modal-cancel">Close</button></div>`;
      $("modal-cancel").addEventListener("click", closeModal);
      return;
    }
    try { prev = await api("/api/crm/sync/preview"); } catch (e) { prev = { error: e.message }; }
    let ppl = null;
    try { ppl = await api("/api/crm/people"); } catch (e) { ppl = null; }
    const st = s.stats;
    const n = (v) => dashN(v || 0);
    const plural = (v, w) => `${n(v)} ${w}${v === 1 ? "" : "s"}`;

    /* ---- header: state, who flipped it, the owner's switch ---- */
    const changed = s.changedBy
      ? `Changed by <b>${esc(s.changedBy)}</b>${s.changedAt ? ` <span title="${esc(new Date(s.changedAt).toLocaleString())}">${esc(relTime(s.changedAt))}</span>` : ""}`
      : "Never turned on";
    const head = `<div class="crm-head">
      <span class="pd-status ${s.on ? "ongoing" : "draft"}"><i></i>${s.on ? "On" : "Off"}</span>
      <span class="crm-head-s">${s.since ? `Logging since ${esc(fmtDate(s.since))} · ` : ""}${changed}</span>
      ${isOwner() && s.configured
        ? `<button type="button" class="${s.on ? "btn-ghost" : "btn-primary"}" id="crm-toggle">${s.on ? "Turn off" : "Turn on"}</button>`
        : `<span class="crm-head-gate">${s.configured ? "Only an owner can turn it on or off." : "Zoho CRM is not configured on this server."}</span>`}
    </div>
    <p class="crm-lead">Each RingCentral call placed here is logged in Zoho CRM's <b>Calls</b> against the matching
      Lead, Account or Contact; a connected call can also become a <b>Lead</b>.</p>`;

    /* ---- health: four tiles, quiet unless something is wrong ---- */
    let health = "", attention = "";
    if (s.since) {
      const recBits = ["attached"];
      if (st.recPending) recBits.push(`${n(st.recPending)} waiting`);
      if (st.recMissing) recBits.push(`<span class="crm-warn-ink">${n(st.recMissing)} missing</span>`);
      health = `<div class="crm-tiles">
        ${crmTile("Sent today", n(st.today), `${n(st.synced)} in total${st.lastSyncedAt ? " · last sent " + relTime(st.lastSyncedAt) : ""}`)}
        ${crmTile("Waiting", n(st.pending), st.pending ? "go out within minutes" : "nothing queued")}
        ${crmTile("Failed", n(st.errors), st.errors ? "needs a retry" : "none", st.errors ? "bad" : "")}
        ${crmTile("Recordings", n(st.recAttached), recBits.join(" · "), st.recMissing ? "warn" : "")}
      </div>`;

      const rows = [];
      if (st.errors || st.lastError) rows.push({
        t: st.errors ? `${plural(st.errors, "call")} failed to send` : "The last send failed",
        d: st.lastError,
        b: st.errors ? `<button type="button" class="btn-ghost crm-attn-btn" id="crm-failed-retry"
          title="Send the ${plural(st.errors, "failed call")} again — a stale lead link is dropped so they still land (unattached)">Retry ${plural(st.errors, "failed send")}</button>` : "",
      });
      if (st.recMissing || st.lastRecError) rows.push({
        t: st.recMissing ? `${plural(st.recMissing, "call")} sent without a recording` : "A recording couldn't be attached",
        d: st.lastRecError ? `${relTime(st.lastRecError.at)}: ${st.lastRecError.error}` : "",
        b: st.recMissing ? `<button type="button" class="btn-ghost crm-attn-btn" id="crm-rec-retry"
          title="Look again in RingCentral for these calls' recordings and attach any it has">Retry missing recordings</button>` : "",
      });
      if (rows.length) attention = `<section class="crm-attn"><h4 class="crm-h">Needs attention</h4>
        ${rows.map((r) => `<div class="crm-attn-row"><div class="crm-attn-t"><b>${esc(r.t)}</b>${r.d ? `<div class="crm-attn-d">${esc(r.d)}</div>` : ""}</div>${r.b}</div>`).join("")}
      </section>`;
    } else {
      health = `<p class="crm-empty">Nothing has been sent yet${s.configured ? " — calls start logging the moment it is turned on" : ""}.</p>`;
    }

    /* ---- tabs: the preview, and (admins) the roster ---- */
    if (tab === "people" && !ppl) tab = "preview";
    const items = prev.items || [];
    const connectedN = ppl ? ppl.people.filter((p) => p.connected_at && !p.last_error).length : 0;
    const tabs = `<div class="crm-tabs" role="tablist">
      <button type="button" class="crm-tab" role="tab" data-crm-tab="preview" aria-selected="${tab === "preview"}">Next calls${prev.error ? "" : ` <em>${n(items.length)}</em>`}</button>
      ${ppl ? `<button type="button" class="crm-tab" role="tab" data-crm-tab="people" aria-selected="${tab === "people"}">Sign-ins <em>${n(connectedN)} of ${n(ppl.people.length)}</em></button>` : ""}
    </div>`;

    const preview = `<div class="crm-pane" data-crm-pane="preview"${tab === "preview" ? "" : " hidden"}>
      ${prev.error ? `<p class="login-error">${esc(prev.error)}</p>`
        : !items.length ? `<p class="crm-empty">No RingCentral calls waiting to be sent${s.since ? "" : " in the last 7 days"}.</p>`
          : `<p class="crm-note">${esc(prev.note || "")}</p><div class="crm-list">${items.map(crmPreviewCard).join("")}</div>`}
    </div>`;

    const people = ppl ? `<div class="crm-pane" data-crm-pane="people"${tab === "people" ? "" : " hidden"}>
      <p class="crm-note">Connected people file calls and leads in Zoho under their own name; everyone else goes in under the shared account.</p>
      ${ppl.enabled ? "" : `<p class="crm-note crm-warn-ink">Personal sign-in isn't set up on this server (ZOHO_CRM_OAUTH_CLIENT_ID / _SECRET) — everything goes in under the shared account.</p>`}
      <div class="crm-roster">${ppl.people.map(crmPersonRow).join("")}</div>
      <p class="crm-note crm-note-foot">Each person connects from the Calls tab or the dialler's Settings; only an admin can disconnect someone.</p>
    </div>` : "";

    $("modal-body").innerHTML = head + health + attention + tabs + preview + people +
      `<div class="modal-actions"><button type="button" class="btn-secondary" id="modal-cancel">Close</button></div>`;

    /* ---- handlers ---- */
    $("modal-cancel").addEventListener("click", closeModal);
    document.querySelectorAll("[data-crm-tab]").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.crmTab; crmShowTab(tab); }));
    document.querySelectorAll("[data-crm-off]").forEach((btn) => btn.addEventListener("click", async () => {
      const who = btn.dataset.crmOff;
      if (!confirm(`Disconnect ${who}'s Zoho CRM sign-in?\n\nTheir calls and leads will go into Zoho under the shared account until they connect again.`)) return;
      btn.disabled = true;
      try {
        await api(`/api/crm/people/${encodeURIComponent(who)}/connect`, { method: "DELETE" });
        toast(`Zoho CRM disconnected for ${who}`, 4000);
        paint();
      } catch (ex) { toast("Couldn't disconnect: " + ex.message, 6000); btn.disabled = false; }
    }));
    $("crm-rec-retry")?.addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await api("/api/crm/sync/recordings/retry", { method: "POST", body: "{}" });
        toast(`Looking again for ${r.queued} recording${r.queued === 1 ? "" : "s"} — any RingCentral has are attached within a few minutes`, 6000);
        paint();
      } catch (ex) { toast("Couldn't retry: " + ex.message, 6000); e.currentTarget.disabled = false; }
    });
    $("crm-failed-retry")?.addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await api("/api/crm/sync/failed/retry", { method: "POST", body: "{}" });
        toast(`Re-queued ${r.queued} failed call${r.queued === 1 ? "" : "s"} — they send again within a few minutes`, 6000);
        paint();
      } catch (ex) { toast("Couldn't retry: " + ex.message, 6000); e.currentTarget.disabled = false; }
    });
    $("crm-toggle")?.addEventListener("click", async () => {
      if (!s.on && !confirm("Turn on Zoho CRM call logging?\n\nFrom now on, RingCentral calls placed in Karma Connect will be written into Zoho CRM's call log, and reps can create CRM leads from connected calls.")) return;
      try {
        await api("/api/crm/sync", { method: "PUT", body: JSON.stringify({ on: !s.on }) });
        toast(s.on ? "Zoho CRM call logging is off" : "Zoho CRM call logging is on", 4000);
        crmCheck(); crmPaintChip(); paint();
      } catch (e) { toast("Couldn't change it: " + e.message, 6000); }
    });
  };
  paint();
}

function clFillSelect(id, rows, cur) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = `<option value="">All</option>` + rows.map(([v, l]) =>
    `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("");
  el.closest(".cl-chip")?.classList.toggle("on", !!cur);
}

const CL_MODE = {
  outgoing: ["Outgoing", DASH_IC.out], incoming: ["Incoming", DASH_IC.in], missed: ["Missed", DASH_IC.miss],
};

function renderCallLog() {
  const d = CL.data, body = $("cl-body");
  const filtered = CL.q || CL.agent || CL.mode || CL.result || CL.number || CL.disposition || CL.rec;
  $("cl-clear")?.classList.toggle("hidden", !filtered);
  const rec = $("cl-rec");
  if (rec) { rec.setAttribute("aria-pressed", String(CL.rec)); rec.classList.toggle("on", CL.rec); }
  const modeSel = $("cl-mode");
  if (modeSel) { modeSel.value = CL.mode; modeSel.closest(".cl-chip").classList.toggle("on", !!CL.mode); }

  if (!d) {
    const connect = /connect your ringcentral/i.test(CL.error || "");
    body.innerHTML = `<div class="dash-empty"><b>${connect ? "Connect RingCentral to see call logs" : "Call logs couldn't load"}</b>
      <span>${esc(CL.error || "")}</span>${connect ? `<a class="btn-primary" href="/api/voice/rc/connect">Connect RingCentral</a>` : ""}</div>`;
    return;
  }

  const o = d.options;
  clFillSelect("cl-agent", o.agents.map((a) => [a.id, a.ext ? `${a.name} · x${a.ext}` : a.name]), CL.agent);
  clFillSelect("cl-result", o.results.map((r) => [r, r]), CL.result);
  clFillSelect("cl-number", o.numbers.map((n) => [n, dashPhone(n)]), CL.number);
  clFillSelect("cl-dispo", o.dispositions.map((x) => [x, x]), CL.disposition);

  const span = d.range.from === d.range.to
    ? new Date(d.range.from + "T12:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" })
    : `${new Date(d.range.from + "T12:00").toLocaleDateString([], { month: "short", day: "numeric" })} – ${
        new Date(d.range.to + "T12:00").toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`;
  $("cl-sub").textContent = `${span} · ${dashN(d.total)} call${d.total === 1 ? "" : "s"} · ${dashDur(d.summary.talkSecs)} talk · ${dashN(d.summary.recorded)} recorded`;
  $("cl-total").innerHTML = `Total logs: <b>${dashN(d.total)}</b>`;
  $("cl-dl-scope").textContent = `${span} · ${dashN(d.total)} call${d.total === 1 ? "" : "s"}${filtered ? " (filtered)" : ""}`;

  const warn = (d.warnings || []).map((w) => `<div class="dash-warn">${esc(w)}</div>`).join("")
    + (CL.error ? `<div class="dash-warn">Last refresh failed: ${esc(CL.error)}</div>` : "");
  if (!d.rows.length) {
    body.innerHTML = `${warn}<div class="dash-empty"><b>No calls ${filtered ? "match these filters" : "in this period"}</b>
      <span>${filtered ? "Try clearing a filter or widening the dates." : "Pick a wider date range above."}</span></div>`;
    return;
  }

  const party = (p) => {
    const name = p.lead
      ? `<button class="cl-lead" data-cl-lead="${p.lead.id}" data-kind="${esc(p.lead.kind || "")}" title="Open this lead">${esc(p.name)}</button>`
      : p.name ? `<b>${esc(p.name)}</b>` : `<b class="dash-mute">${esc(p.place || "Unknown")}</b>`;
    return `<div class="cl-party">${name}<span>${esc(dashPhone(p.number) || "—")}</span></div>`;
  };
  const when = (ms) => {
    const t = new Date(ms);
    return `<div class="cl-when"><b>${esc(t.toLocaleDateString([], { month: "short", day: "numeric" }))}</b>
      <span>${esc(t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}</span></div>`;
  };
  const rows = d.rows.map((r) => {
    const [label, ic] = CL_MODE[r.mode];
    return `<tr class="cl-${r.mode}">
      <td><span class="cl-mode ${r.mode}" title="${label}">${dashIc(ic)}<span class="kd-sr">${label}</span></span></td>
      <td>${party(r.from)}</td>
      <td>${party(r.to)}</td>
      <td>${r.agent ? `<div class="cl-party"><b>${esc(r.agent.name)}</b>${r.agent.ext ? `<span>x${esc(r.agent.ext)}</span>` : ""}</div>` : `<span class="dash-mute">—</span>`}</td>
      <td class="n cl-dur">${r.seconds ? esc(liveClock(r.seconds * 1000)) : `<span class="dash-mute">0:00</span>`}</td>
      <td>${when(r.at)}</td>
      <td><span class="cl-result${/connected|accepted/i.test(r.result) ? " ok" : ""}">${esc(r.result)}</span></td>
      <td>${r.disposition ? `<span class="dash-chip">${esc(r.disposition)}</span>` : `<span class="dash-mute">—</span>`}</td>
      <td class="cl-rec">${r.recording
        ? `<button class="cl-play" data-play="${esc(r.recording)}" title="Play the recording">
             <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7V5z"/></svg>Play</button>`
        : `<span class="dash-mute">—</span>`}</td>
    </tr>`;
  }).join("");

  const first = (d.page - 1) * d.per + 1, last = Math.min(d.total, d.page * d.per);
  body.innerHTML = `${warn}
    <div class="cl-tablewrap"><table class="cl-table">
      <thead><tr><th>Mode</th><th>From</th><th>To</th><th>Agent</th><th class="n">Duration</th>
        <th>Date / time</th><th>Result</th><th>Disposition</th><th>Recording</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="cl-pager">
      <span>${dashN(first)}–${dashN(last)} of ${dashN(d.total)}</span>
      <label>Per page <select id="cl-per">${[50, 100, 200].map((n) =>
        `<option value="${n}"${n === d.per ? " selected" : ""}>${n}</option>`).join("")}</select></label>
      <div class="cl-pages">
        <button class="btn-ghost" data-page="${d.page - 1}"${d.page <= 1 ? " disabled" : ""}>‹ Prev</button>
        <span>Page ${d.page} of ${d.pages}</span>
        <button class="btn-ghost" data-page="${d.page + 1}"${d.page >= d.pages ? " disabled" : ""}>Next ›</button>
      </div>
    </div>`;
}

/* ================= Power dialer — the manager's side =================

   A campaign is a rep's assigned leads, snapshotted, that the manager starts.
   While it is "ongoing" the rep's Call session dials it by itself (see the
   CAMP code); "paused" stops it after the current call. The list polls every
   10s while open so progress moves without a refresh. */

const PD = { q: "", status: "", data: null, error: null, poll: null, wired: false, busy: new Set() };
const PD_STATUS = {
  draft: ["Ready", "draft"], ongoing: ["Ongoing", "ongoing"], paused: ["Paused", "paused"],
  completed: ["Completed", "completed"], ended: ["Ended", "ended"],
};

async function loadPower() {
  pdWire();
  if (!PD.data) $("pd-body").innerHTML = `<div class="dash-empty"><div class="dash-spin"></div>Loading campaigns…</div>`;
  await pdFetch();
  pdStop();
  PD.poll = setInterval(() => { if (!document.hidden) pdFetch(); }, 10000);
}
function pdStop() { clearInterval(PD.poll); PD.poll = null; }
async function pdFetch() {
  try {
    const q = new URLSearchParams();
    if (PD.q) q.set("q", PD.q);
    if (PD.status) q.set("status", PD.status);
    PD.data = await api("/api/dialer/campaigns?" + q);
    PD.error = null;
  } catch (e) { PD.error = e.message || String(e); }
  if (S.tab === "power") renderPower();
}

function pdWire() {
  if (PD.wired) return;
  PD.wired = true;
  let t;
  on("pd-q", "input", (e) => { clearTimeout(t); t = setTimeout(() => { PD.q = e.target.value.trim(); pdFetch(); }, 300); });
  on("pd-status", "change", (e) => { PD.status = e.target.value; e.target.closest(".cl-chip").classList.toggle("on", !!PD.status); pdFetch(); });
  on("pd-new", "click", openNewCampaign);
  on("pd-groups", "click", () => openRepGroups());
  on("pd-upload", "click", openUploadCampaign);
  $("pd-body").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-pd-act]");
    if (!b) return;
    const id = +b.dataset.pdId, act = b.dataset.pdAct;
    const c = PD.data?.list.find((x) => x.id === id);
    if (act === "unassign") return c && openUnassign(c);
    if (act === "end" && c?.status === "draft") return openDeleteDraft(c);
    if (act === "end" && !confirm(`End "${c?.name}"? ${c ? c.pending + " lead(s) not yet called will be dropped from it." : ""}`)) return;
    PD.busy.add(id); renderPower();
    try {
      await api(`/api/dialer/campaigns/${id}/state`, { method: "POST", body: JSON.stringify({ action: act }) });
      toast({ start: "Campaign started — the rep's dialler will pick it up", pause: "Paused — the rep stops after their current call",
        resume: "Resumed", end: "Campaign ended" }[act], 4000);
    } catch (err) { toast("Couldn't update the campaign: " + err.message, 6000); }
    PD.busy.delete(id);
    pdFetch();
  });
}

function renderPower() {
  const d = PD.data, body = $("pd-body");
  if (!d) { body.innerHTML = `<div class="dash-empty"><b>Campaigns couldn't load</b><span>${esc(PD.error || "")}</span></div>`; return; }
  const live = d.list.filter((c) => c.status === "ongoing").length;
  const nav = $("count-power");
  if (nav) { nav.textContent = live || ""; nav.classList.toggle("hidden", !live); }
  $("pd-sub").textContent = `${dashN(d.total)} campaign${d.total === 1 ? "" : "s"}${live ? ` · ${live} running now` : ""}`;

  if (!d.list.length) {
    body.innerHTML = `<div class="live-quiet pd-empty"><div class="live-quiet-ic">${dashIc("M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z")}</div>
      <b>${PD.q || PD.status ? "No campaigns match" : "No campaigns yet"}</b>
      <span>Build one from a rep's assigned leads, press Start, and their dialler rings each lead in turn.</span>
      ${PD.q || PD.status ? "" : `<button class="btn-primary" data-act="openNewCampaign">+ New campaign</button>`}</div>`;
    return;
  }

  const actions = (c) => {
    const dis = PD.busy.has(c.id) ? " disabled" : "";
    const btn = (act, label, cls = "btn-ghost") => `<button class="${cls} pd-btn" data-pd-act="${act}" data-pd-id="${c.id}"${dis}>${label}</button>`;
    const un = btn("unassign", "Unassign leads");
    /* an uploaded campaign can be exported — notes, AI summaries and outcomes
       back out to CSV — and its leads are its own, so "unassign" never applies */
    const exp = c.source === "upload"
      ? `<a class="btn-ghost pd-btn" href="/api/dialer/campaigns/${c.id}/export" title="Download this list with notes and outcomes">Export CSV</a>` : "";
    if (c.source === "upload") {
      if (c.status === "ongoing") return btn("pause", "❚❚ Pause") + btn("end", "End") + exp;
      if (c.status === "paused") return btn("resume", "▶ Resume", "btn-primary") + btn("end", "End") + exp;
      return `<span class="dash-mute">${c.endedAt ? esc(new Date(c.endedAt).toLocaleDateString([], { month: "short", day: "numeric" })) : ""}</span>` + exp;
    }
    if (c.status === "draft") return btn("start", "▶ Start", "btn-primary") + btn("end", "Delete") + un;
    if (c.status === "ongoing") return btn("pause", "❚❚ Pause") + btn("end", "End");
    if (c.status === "paused") return btn("resume", "▶ Resume", "btn-primary") + btn("end", "End") + un;
    return `<span class="dash-mute">${c.endedAt ? esc(new Date(c.endedAt).toLocaleDateString([], { month: "short", day: "numeric" })) : ""}</span>` + un;
  };
  body.innerHTML = `<div class="cl-tablewrap"><table class="cl-table pd-table">
    <thead><tr><th>Campaign</th><th class="n">Contacts</th><th class="n">Completed</th><th class="n">Pending</th>
      <th>Progress</th><th>Created by</th><th>Assigned to</th><th>Callbacks to</th><th>Status</th><th></th></tr></thead>
    <tbody>${d.list.map((c) => {
      const pct = c.total ? Math.round((c.completed / c.total) * 100) : 0;
      const [label, cls] = PD_STATUS[c.status] || [c.status, "draft"];
      return `<tr class="pd-${cls}">
        <td><div class="cl-party"><b>${esc(c.name)}</b><span>${esc(new Date(c.createdAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }))} · ${c.gap || 6}s between calls${
          c.group ? ` · <span class="pd-grptag" title="Shared at random between ${c.group.size} reps">${esc(c.group.name || "Group")} · ${c.group.size} reps</span>` : ""}${
          c.unique ? ` · unique numbers` : ""}</span></div></td>
        <td class="n"><b>${dashN(c.total)}</b></td>
        <td class="n">${dashN(c.completed)}</td>
        <td class="n">${dashN(c.pending)}</td>
        <td class="pd-progc"><div class="pd-prog" title="${c.called} called · ${c.connected} connected · ${c.skipped} skipped">
          <i style="width:${pct}%"></i></div><span>${pct}% · ${dashN(c.connected)} connected</span></td>
        <td>${esc(c.creatorName || c.createdBy || "—")}</td>
        <td><span class="pd-who"><span class="live-av pd-av">${esc(initials(c.ownerName))}</span>${esc(c.ownerName)}</span></td>
        <td>${c.callback ? `<div class="cl-party"><b>${esc(c.callback.name)}</b><span>x${esc(c.callback.ext)} · ${esc(dashPhone(c.callback.number))}</span></div>`
          : `<span class="dash-mute">Rep's own number</span>`}</td>
        <td><span class="pd-status ${cls}"><i></i>${esc(label)}</span>${
          c.status === "paused" && c.pausedBy ? `<span class="pd-by">by ${esc(c.pausedBy)}</span>` : ""}</td>
        <td class="pd-acts">${actions(c)}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

/* Deleting a campaign that never started. One built from new unassigned
   leads gave them to the rep when it was created, so deleting it offers to
   give them back — ticked by default for those, since the rep never asked
   for them. Unassigning ends the campaign by itself (same endpoint as
   Unassign leads), so it is one request either way. */
function openDeleteDraft(c) {
  const fromPool = c.source === "unassigned";
  $("modal-title").textContent = `Delete “${c.name}”?`;
  $("modal-body").innerHTML = `
    <p class="modal-sub">It never started, so nothing has been called.</p>
    <form id="pd-del-form" class="pd-form">
      <label class="pd-choice"><input type="checkbox" id="pd-del-un" ${fromPool ? "checked" : ""}>
        <span><b>Also put its ${dashN(c.total)} lead${c.total === 1 ? "" : "s"} back in Unassigned</b>${fromPool
          ? ` — they were given to ${esc(c.ownerName)} when this campaign was made`
          : ` — they were already ${esc(c.ownerName)}'s; leave unticked to keep them on their list`}</span></label>
      <div id="pd-del-err" class="login-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
        <button type="submit" class="btn-primary" id="pd-del-go">Delete campaign</button>
      </div>
    </form>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  $("pd-del-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("pd-del-go"), err = $("pd-del-err"), un = $("pd-del-un").checked;
    btn.disabled = true; btn.textContent = "Deleting…";
    try {
      const r = un
        ? await api(`/api/dialer/campaigns/${c.id}/unassign`, { method: "POST", body: JSON.stringify({ which: "all" }) })
        : await api(`/api/dialer/campaigns/${c.id}/state`, { method: "POST", body: JSON.stringify({ action: "end" }) });
      closeModal();
      toast(un ? `Campaign deleted · ${dashN(r.unassigned)} lead${r.unassigned === 1 ? "" : "s"} back in Unassigned` : "Campaign deleted", 5000);
      pdFetch();
    } catch (ex) {
      err.textContent = ex.message; err.classList.remove("hidden");
      btn.disabled = false; btn.textContent = "Delete campaign";
    }
  });
}

/* Unassign a campaign's leads from its rep: back to the unassigned pool.
   The server only touches leads that rep still owns, and ends a campaign
   that is still open, since its uncalled leads are no longer theirs. */
function openUnassign(c) {
  const open = c.status === "draft" || c.status === "paused";
  $("modal-title").textContent = `Unassign leads — ${c.name}`;
  $("modal-body").innerHTML = `
    <p class="modal-sub">The leads go back to <b>Unassigned</b>: off ${esc(c.ownerName)}'s list and out of any later campaign.
      Leads since given to someone else are left alone.</p>
    <form id="pd-un-form" class="pd-form">
      <label class="pd-choice"><input type="radio" name="pd-un" value="pending" checked>
        <span><b>Not yet called</b> · ${dashN(c.pending)} lead${c.pending === 1 ? "" : "s"}</span></label>
      <label class="pd-choice"><input type="radio" name="pd-un" value="all">
        <span><b>Every lead in this campaign</b> · ${dashN(c.total)}, including the ${dashN(c.completed)} already called</span></label>
      ${open ? `<p class="pd-help">This campaign is still open, so it will be ended.</p>` : ""}
      <div id="pd-un-err" class="login-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
        <button type="submit" class="btn-primary" id="pd-un-go">Unassign</button>
      </div>
    </form>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  $("pd-un-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("pd-un-go"), err = $("pd-un-err");
    btn.disabled = true; btn.textContent = "Unassigning…";
    try {
      const which = document.querySelector('input[name="pd-un"]:checked').value;
      const r = await api(`/api/dialer/campaigns/${c.id}/unassign`, { method: "POST", body: JSON.stringify({ which }) });
      closeModal();
      toast(`${dashN(r.unassigned)} lead${r.unassigned === 1 ? "" : "s"} unassigned${r.ended ? " — campaign ended" : ""}`, 5000);
      pdFetch();
    } catch (ex) {
      err.textContent = ex.message; err.classList.remove("hidden");
      btn.disabled = false; btn.textContent = "Unassign";
    }
  });
}

/* Upload a spreadsheet straight into a campaign. The rows become a call list
   of their own (kept apart from the lead base), the AI reads the phone and the
   notes column, and a one-line summary of each note is generated in the
   background so the rep sees it on the dialer. */
async function openUploadCampaign() {
  $("modal-title").textContent = "Upload a spreadsheet as a campaign";
  $("modal-body").innerHTML = `<p class="modal-sub">Loading the team…</p>`;
  $("modal-backdrop").classList.remove("hidden");
  let reps, targets = { targets: [] };
  try {
    [reps, targets] = await Promise.all([api("/api/dialer/campaigns/reps"),
      api("/api/dialer/callback-targets").catch(() => ({ targets: [] }))]);
  } catch (e) { $("modal-body").innerHTML = `<p class="login-error">${esc(e.message)}</p>`; return; }
  const today = new Date().toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "numeric" }).replace(/\D/g, "");
  $("modal-body").innerHTML = `
    <p class="modal-sub">Drop in an Excel or CSV file of people to call. We find the phone-number column for you,
      read any notes column, and write a one-line AI summary of each note that the rep sees on the dialer.
      These rows are a call list of their own — they are <b>not</b> added to your leads. Export the results any time.</p>
    <form id="pu-form" class="pd-form">
      <label class="modal-field">Campaign name
        <input id="pu-name" maxlength="80" required placeholder="e.g. Hail list ${today}"></label>
      <label class="modal-field">Assign to
        <select id="pu-owner" required>
          <option value="">Choose a person…</option>
          ${reps.reps.map((r) => `<option value="${esc(r.email)}"${r.busy_with ? " disabled" : ""}>
            ${esc(r.name)}${r.busy_with ? ` (busy: ${esc(r.busy_kind === "campaign" ? r.busy_with : "own session")})` : ""}</option>`).join("")}
        </select>
        <span class="pd-help">They can only work one campaign at a time — pick someone free.</span></label>
      <label class="modal-field">Inbound callbacks go to
        <select id="pu-callback">
          <option value="">The rep's own number (default)</option>
          ${targets.targets.map((t) => `<option value="${esc(t.ext)}">${esc(t.name)} · x${esc(t.ext)}</option>`).join("")}
        </select></label>
      <label class="modal-field">Spreadsheet (.xlsx, .xls or .csv)
        <input id="pu-file" type="file" accept=".xlsx,.xls,.csv" required></label>
      <label class="modal-field">Seconds between calls
        <input id="pu-gap" type="number" min="2" max="60" value="6"></label>
      <div id="pu-err" class="login-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
        <button type="submit" class="btn-primary" id="pu-create">Upload &amp; create</button>
      </div>
    </form>`;
  $("modal-cancel").addEventListener("click", closeModal);
  $("pu-name").focus();
  $("pu-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("pu-err"), btn = $("pu-create");
    const file = $("pu-file").files[0];
    err.classList.add("hidden");
    if (!file) { err.textContent = "Pick a file first."; err.classList.remove("hidden"); return; }
    btn.disabled = true; btn.textContent = "Uploading…";
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch("/api/dialer/campaigns/upload", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-filename": encodeURIComponent(file.name),
          "x-campaign-name": encodeURIComponent($("pu-name").value),
          "x-owner": $("pu-owner").value,
          "x-gap": String(+$("pu-gap").value || 6),
          "x-callback-ext": $("pu-callback").value || "",
        },
        body: buf,
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || ("Upload failed (" + res.status + ")"));
      closeModal();
      toast(`Uploaded ${dashN(out.total)} contact${out.total === 1 ? "" : "s"}${
        out.skipped ? ` (${dashN(out.skipped)} skipped — no usable phone)` : ""}${
        out.skippedInZoho ? ` · ${dashN(out.skippedInZoho)} left out — already in Zoho` : ""} — AI note summaries are generating.`, 8000);
      pdFetch();
    } catch (e2) {
      err.textContent = e2.message; err.classList.remove("hidden");
      btn.disabled = false; btn.textContent = "Upload & create";
    }
  });
}

/* New campaign, in three steps: who makes the calls, which leads (with a
   plain-English box the AI turns into the filters), how many and a name.
   The preview is the server's — it counts exactly what Create would hand
   out — and the filter chips above it are the one place to see, and clear,
   everything that narrows the list, however it was set. */
const PD_KINDS = [["company", "Companies"], ["person", "People"], ["job", "Job postings"]];
/* `source` — whose leads the campaign is built from. campaign.js: unassigned
   and any give the picked leads to the rep who gets them; assigned only
   draws from what each rep already owns. */
const PD_SOURCES = [
  ["unassigned", "Nobody's yet", "Leads with no owner. They become the rep's when the campaign is made."],
  ["assigned", "Each rep's own", "Only leads already on that rep's list. Nothing changes hands."],
  ["any", "Anyone's", "Any lead, whoever owns it. It moves to the rep who gets it."],
];
async function openNewCampaign() {
  $("modal-title").textContent = "New campaign";
  $("modal-body").innerHTML = `<p class="modal-sub">Loading the team…</p>`;
  document.querySelector(".modal")?.classList.add("team-panel");
  $("modal-backdrop").classList.remove("hidden");
  let reps, targets = { targets: [] }, groups = { groups: [] }, sts = { statuses: [] };
  try {
    [reps, targets, groups, sts] = await Promise.all([api("/api/dialer/campaigns/reps"),
      api("/api/dialer/callback-targets").catch((e) => ({ targets: [], error: e.message })),
      api("/api/dialer/groups").catch(() => ({ groups: [] })),
      api("/api/lead-statuses").catch(() => ({ statuses: [{ status: "New", n: 0 }] }))]);
  } catch (e) { $("modal-body").innerHTML = `<p class="login-error">${esc(e.message)}</p>`; return; }
  const STATES = reps.states || {};
  const today = new Date().toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "numeric" }).replace(/\D/g, "");
  const busyOf = (r) => r.busy_with ? ` (busy: ${r.busy_kind === "campaign" ? r.busy_with : "own session"})` : "";
  const repOpts = reps.reps.map((r) => `<option value="${esc(r.email)}"${r.busy_with ? " disabled" : ""}>${esc(r.name)}${esc(busyOf(r))}</option>`).join("");
  $("modal-body").innerHTML = `
    <form id="pd-form" class="pd-form pd-form2" autocomplete="off">
      <section class="pd-step">
        <h4 class="pd-step-h"><span>1</span>Who makes the calls</h4>
        <div class="pd-seg" role="radiogroup" aria-label="One rep or a group">
          <label><input type="radio" name="pd-to" value="one" checked><span>One rep</span></label>
          <label><input type="radio" name="pd-to" value="group"${groups.groups.length ? "" : " disabled"}><span>A group</span></label>
        </div>
        <div id="pd-one"><select id="pd-owner" aria-label="Rep"><option value="">Choose a rep…</option>${repOpts}</select></div>
        <div id="pd-grp" class="hidden">
          <div class="pd-grprow">
            <select id="pd-group" aria-label="Group">${groups.groups.map((g) => `<option value="${g.id}">${esc(g.name)} · ${g.members.length} rep${g.members.length === 1 ? "" : "s"}</option>`).join("")}</select>
            <button type="button" class="btn-ghost" id="pd-groups-edit">Edit groups</button>
          </div>
          <div id="pd-members" class="pd-members"></div>
          <p class="pd-help">Untick anyone who shouldn't get a share. The numbers are split evenly, at random.</p>
        </div>
        ${groups.groups.length ? "" : `<p class="pd-help">No groups yet — <a href="#" id="pd-groups-new">make one</a> to give a campaign to several reps at once.</p>`}
      </section>

      <section class="pd-step">
        <h4 class="pd-step-h"><span>2</span>Which leads</h4>
        <div class="pd-ai">
          <label class="pd-ai-l" for="pd-ai-text"><i>AI</i>Describe the leads and the filters below fill themselves in</label>
          <div class="pd-ai-row">
            <input id="pd-ai-text" maxlength="500" placeholder="e.g. No Answer and VM companies in Texas called last week, unique numbers only">
            <button type="button" class="btn-primary" id="pd-ai-go">Fill in filters</button>
          </div>
          <div id="pd-ai-out" class="pd-ai-out hidden" aria-live="polite"></div>
        </div>

        <div class="pd-f">
          <div class="pd-f-l">Status <span class="pd-help-inline">— the call result from Zoho</span></div>
          <div class="pd-chips" id="pd-sts">${sts.statuses.map((s) => `<label class="pd-chip"><input type="checkbox" name="pd-st" value="${esc(s.status)}"${s.status === "New" ? " checked" : ""}>
            <span>${esc(s.status)} <i>${dashN(s.n)}</i></span></label>`).join("")}</div>
        </div>

        <div class="pd-f">
          <div class="pd-f-l">Whose leads</div>
          <div class="pd-src" role="radiogroup" aria-label="Whose leads">${PD_SOURCES.map(([v, t, h], i) =>
            `<label class="pd-choice"><input type="radio" name="pd-src" value="${v}"${i ? "" : " checked"}><span><b>${t}</b><small>${h}</small></span></label>`).join("")}</div>
        </div>

        <div class="pd-f">
          <div class="pd-f-l">Lead type</div>
          <div class="pd-chips pd-kinds">${PD_KINDS.map(([v, t]) => `<label class="pd-chip"><input type="checkbox" name="pd-kind" value="${v}" checked><span>${t}</span></label>`).join("")}</div>
          <label class="pd-check"><input type="checkbox" id="pd-unique" checked>
            <span><b>Unique numbers only</b> — never called from Karma Connect, and not in Zoho</span></label>
        </div>

        <div class="pd-f pd-f-3">
          <label class="modal-field">State
            <input id="pd-fstate" list="pd-fstate-list" placeholder="Any — e.g. TX, Florida">
            <span class="pd-help pd-fstate-bad hidden" id="pd-fstate-bad"></span></label>
          <datalist id="pd-fstate-list">${Object.entries(STATES).map(([k, v]) => `<option value="${esc(v)}">${k}</option>`).join("")}</datalist>
          <label class="modal-field">City<input id="pd-fcity" maxlength="60" placeholder="Any"></label>
          <label class="modal-field">Name contains<input id="pd-fq" maxlength="80" placeholder="e.g. Servpro"></label>
        </div>

        <div class="pd-f">
          <div class="pd-f-l">Dates <span class="pd-help-inline">— any time unless you set a range</span></div>
          <div class="pd-dates">
            <select id="pd-datebasis" aria-label="Which date">
              <option value="called">Last called</option>
              <option value="added">Date added</option>
            </select>
            <input type="date" id="pd-from" aria-label="From">
            <span class="dash-mute">to</span>
            <input type="date" id="pd-to" aria-label="To">
            <button type="button" class="btn-ghost pd-clear" id="pd-dates-clear" title="Any date">Clear</button>
          </div>
        </div>
      </section>

      <section class="pd-step">
        <h4 class="pd-step-h"><span>3</span>How many, and a name</h4>
        <div class="pd-row">
          <label class="modal-field">Numbers in total
            <input id="pd-limit" type="number" min="1" max="${reps.max}" value="300">
            <span class="pd-help">A group shares these out evenly.</span></label>
          <label class="modal-field">Campaign name
            <input id="pd-name" maxlength="80" required placeholder="e.g. Water restoration ${today}"></label>
        </div>
        <details class="pd-more">
          <summary>Call settings</summary>
          <div class="pd-row">
            <label class="modal-field">Seconds between calls
              <input id="pd-gap" type="number" min="2" max="60" value="6"></label>
            <label class="modal-field">Inbound callbacks go to
              <select id="pd-callback">
                <option value="">Each rep's own number (default)</option>
                ${targets.targets.map((t) => `<option value="${esc(t.ext)}">${esc(t.name)} · x${esc(t.ext)} · ${esc(dashPhone(t.number))}</option>`).join("")}
              </select>
              ${targets.error ? `<span class="pd-help">${esc(targets.error)}</span>` : ""}</label>
          </div>
          <label class="pd-check"><input type="checkbox" id="pd-start">
            <span><b>Start straight away</b> — otherwise it waits as a draft until you press Start</span></label>
        </details>
      </section>

      <div class="pd-preview">
        <div class="pd-active" id="pd-active"></div>
        <div id="pd-count" aria-live="polite"></div>
      </div>
      <div id="pd-err" class="login-error hidden"></div>
      <div class="modal-actions">
        <span class="pd-foot" id="pd-foot"></span>
        <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
        <button type="submit" class="btn-primary" id="pd-create">Create campaign</button>
      </div>
    </form>`;
  $("modal-cancel").addEventListener("click", closeModal);
  $("pd-owner").focus();
  const form = $("pd-form");
  const toGroup = () => document.querySelector('input[name="pd-to"]:checked')?.value === "group";
  const busy = new Map(reps.reps.filter((r) => r.busy_with).map((r) => [r.email, busyOf(r)]));
  /* the ticked members of the chosen group — editable for this campaign only */
  const paintMembers = () => {
    const g = groups.groups.find((x) => String(x.id) === $("pd-group").value);
    $("pd-members").innerHTML = !g ? "" : !g.members.length ? `<span class="dash-mute">Nobody in this group yet.</span>`
      : g.members.map((m) => `<label class="pd-chip${busy.has(m.email) ? " off" : ""}" title="${esc(busy.get(m.email) || m.email)}">
          <input type="checkbox" name="pd-mem" value="${esc(m.email)}"${busy.has(m.email) ? " disabled" : " checked"}>
          <span>${esc(m.name)}${busy.has(m.email) ? " <i>busy</i>" : ""}</span></label>`).join("");
  };
  const who = () => toGroup()
    ? [...document.querySelectorAll('input[name="pd-mem"]:checked')].map((x) => x.value)
    : $("pd-owner").value ? [$("pd-owner").value] : [];
  /* the State box takes "TX" or "Texas", several with commas; unknown words
     are said back rather than silently ignored */
  const stateOf = (t) => {
    const v = t.trim(); if (!v) return null;
    if (STATES[v.toUpperCase()]) return v.toUpperCase();
    return Object.keys(STATES).find((k) => STATES[k].toLowerCase() === v.toLowerCase()) || null;
  };
  const states = () => {
    const ok = [], bad = [];
    for (const t of $("pd-fstate").value.split(/[,;]/)) { const c = stateOf(t); if (c) { if (!ok.includes(c)) ok.push(c); } else if (t.trim()) bad.push(t.trim()); }
    return { ok, bad };
  };
  const spec = () => ({
    owners: who(), group_id: toGroup() ? +$("pd-group").value || undefined : undefined,
    statuses: [...document.querySelectorAll('input[name="pd-st"]:checked')].map((x) => x.value),
    kinds: [...document.querySelectorAll('input[name="pd-kind"]:checked')].map((x) => x.value),
    unique: $("pd-unique").checked,
    dateBasis: $("pd-datebasis").value, from: $("pd-from").value || undefined, to: $("pd-to").value || undefined,
    source: document.querySelector('input[name="pd-src"]:checked')?.value || "unassigned",
    limit: +$("pd-limit").value,
    states: states().ok, city: $("pd-fcity").value.trim() || undefined, q: $("pd-fq").value.trim() || undefined,
  });
  /* the chips: everything narrowing the list, each with an × that clears it */
  const fmtDay = (d) => new Date(d + "T00:00:00").toLocaleDateString([], { day: "numeric", month: "short" });
  const paintActive = () => {
    const s = spec(), tags = [];
    const tag = (label, clear, strong) => tags.push(`<span class="pd-tag">${strong ? `<b>${esc(strong)}</b> ` : ""}${esc(label)}<button type="button" data-clear="${esc(clear)}" aria-label="Remove ${esc(label)}">×</button></span>`);
    s.statuses.forEach((st) => tag(st, "st:" + st));
    if (s.kinds.length && s.kinds.length < PD_KINDS.length) s.kinds.forEach((k) => tag(PD_KINDS.find((x) => x[0] === k)[1], "kind:" + k));
    if (s.unique) tag("Unique numbers", "unique");
    s.states.forEach((st) => tag(STATES[st] || st, "state:" + st));
    if (s.city) tag(s.city, "city", "City");
    if (s.q) tag(`“${s.q}”`, "q", "Name");
    if (s.from || s.to) tag(s.from && s.to ? `${fmtDay(s.from)} – ${fmtDay(s.to)}` : s.from ? `since ${fmtDay(s.from)}` : `up to ${fmtDay(s.to)}`, "dates", s.dateBasis === "added" ? "Added" : "Last called");
    const bad = states().bad, badEl = $("pd-fstate-bad");
    badEl.textContent = bad.length ? `Not a state: ${bad.join(", ")}` : "";
    badEl.classList.toggle("hidden", !bad.length);
    /* rewritten only when it changed: a rebuild under the pointer (a blur-
       change arriving as a chip is pressed) would swallow the click */
    const html = tags.length ? tags.join("") : `<span class="pd-tag pd-tag-none">Any lead with a phone number</span>`;
    if ($("pd-active").innerHTML !== html) $("pd-active").innerHTML = html;
  };
  /* the live preview: asked of the server, so it counts exactly what
     Create would hand out — status, type, unique, dates, Zoho and all */
  let seq = 0, t = null;
  const preview = () => {
    paintActive();
    clearTimeout(t);
    t = setTimeout(async () => {
      const my = ++seq, out = $("pd-count"), s = spec();
      /* the footer repeats the count beside Create, for when the preview has scrolled away */
      const foot = (txt, bad) => { const f = $("pd-foot"); if (f) { f.textContent = txt; f.classList.toggle("bad", !!bad); } };
      if (!s.owners.length) { out.innerHTML = `<span class="dash-mute">Choose ${toGroup() ? "who in the group calls" : "a rep"} in step 1 to see who gets what.</span>`; foot("Choose who calls first"); return; }
      if (!s.statuses.length && !s.unique) { out.innerHTML = `<span class="login-error">Tick at least one status, or Unique numbers only.</span>`; foot("Tick a status", true); return; }
      out.classList.add("loading");
      try {
        const p = await api("/api/dialer/campaigns/preview", { method: "POST", body: JSON.stringify(s) });
        if (my !== seq) return;
        out.innerHTML = !p.total
          ? `<span class="login-error">No numbers match these filters${p.inZoho ? ` (${dashN(p.inZoho)} left out — already in Zoho)` : ""}.</span>`
          : `<div class="pd-pv-h"><b>${dashN(p.total)}</b> number${p.total === 1 ? "" : "s"} in this campaign
               <span class="dash-mute">of ${dashN(p.available)} that match${p.inZoho ? ` · ${dashN(p.inZoho)} left out — already in Zoho` : ""}</span></div>
             ${p.perRep.length > 1 || s.source !== "assigned" ? `<div class="pd-pv-reps">${p.perRep.map((r) =>
               `<span class="pd-pv-rep"><span class="live-av pd-av">${esc(initials(r.name))}</span>${esc(r.name)} <b>${dashN(r.n)}</b></span>`).join("")}</div>` : ""}
             ${p.busy.length ? `<div class="login-error">Busy with another session: ${p.busy.map(esc).join(", ")} — end it first.</div>` : ""}`;
        foot(p.total ? `${dashN(p.total)} number${p.total === 1 ? "" : "s"}${p.perRep.length > 1 ? ` across ${p.perRep.length} reps` : ""}` : "No numbers match", !p.total);
      } catch (e) { if (my === seq) { out.innerHTML = `<span class="login-error">${esc(e.message)}</span>`; foot("Preview failed", true); } }
      finally { if (my === seq) out.classList.remove("loading"); }
    }, 250);
  };
  const paintWho = () => {
    $("pd-one").classList.toggle("hidden", toGroup());
    $("pd-grp").classList.toggle("hidden", !toGroup());
    if (toGroup()) paintMembers();
  };
  const NOT_FILTERS = new Set(["pd-ai-text", "pd-name", "pd-gap", "pd-callback", "pd-start"]);
  form.addEventListener("change", (e) => {
    if (NOT_FILTERS.has(e.target.id)) return;
    if (e.target.name === "pd-to") paintWho();
    if (e.target.id === "pd-group") paintMembers();
    preview();
  });
  const LIVE = new Set(["pd-fstate", "pd-fcity", "pd-fq"]);
  form.addEventListener("input", (e) => { if (e.target.type === "number" || LIVE.has(e.target.id)) preview(); });
  $("pd-dates-clear").addEventListener("click", () => { $("pd-from").value = ""; $("pd-to").value = ""; preview(); });
  $("pd-active").addEventListener("click", (e) => {
    const b = e.target.closest("[data-clear]");
    if (!b) return;
    const [what, val] = b.dataset.clear.split(/:(.*)/s);
    if (what === "st") form.querySelector(`input[name="pd-st"][value="${CSS.escape(val)}"]`).checked = false;
    else if (what === "kind") form.querySelector(`input[name="pd-kind"][value="${CSS.escape(val)}"]`).checked = false;
    else if (what === "unique") $("pd-unique").checked = false;
    else if (what === "state") $("pd-fstate").value = states().ok.filter((s) => s !== val).map((s) => STATES[s]).join(", ");
    else if (what === "city") $("pd-fcity").value = "";
    else if (what === "q") $("pd-fq").value = "";
    else if (what === "dates") { $("pd-from").value = ""; $("pd-to").value = ""; }
    preview();
  });
  const toGroups = (e) => { e.preventDefault(); openRepGroups(reps, openNewCampaign); };
  $("pd-groups-edit")?.addEventListener("click", toGroups);
  $("pd-groups-new")?.addEventListener("click", toGroups);

  /* The AI box: the description becomes a filter spec (validated on the
     server) that is written into the form — a field the text didn't mention
     goes back to its default, so the box describes the whole list. The
     manager still sees the chips and the preview, and still presses Create. */
  const applyAi = (s) => {
    form.querySelectorAll('input[name="pd-st"]').forEach((x) => { x.checked = s.statuses.includes(x.value); });
    const kinds = s.kinds.length ? s.kinds : PD_KINDS.map((k) => k[0]);
    form.querySelectorAll('input[name="pd-kind"]').forEach((x) => { x.checked = kinds.includes(x.value); });
    $("pd-unique").checked = s.unique ?? true;
    $("pd-datebasis").value = s.dateBasis || "called";
    $("pd-from").value = s.from || ""; $("pd-to").value = s.to || "";
    form.querySelector(`input[name="pd-src"][value="${s.source || "unassigned"}"]`).checked = true;
    if (s.limit) $("pd-limit").value = s.limit;
    $("pd-fstate").value = s.states.map((k) => STATES[k] || k).join(", ");
    $("pd-fcity").value = s.city || ""; $("pd-fq").value = s.q || "";
    preview();
  };
  const aiGo = async () => {
    const text = $("pd-ai-text").value.trim(), btn = $("pd-ai-go"), out = $("pd-ai-out");
    if (!text) { $("pd-ai-text").focus(); return; }
    btn.disabled = true; btn.textContent = "Reading…";
    out.className = "pd-ai-out"; out.textContent = "Working out the filters…";
    try {
      const r = await api("/api/dialer/campaigns/ai-filter", { method: "POST", body: JSON.stringify({ text }) });
      applyAi(r.spec);
      out.innerHTML = `<b>Set to:</b> ${esc(r.summary)}${r.unmapped?.length
        ? `<span class="pd-ai-miss">Couldn't use: ${r.unmapped.map(esc).join(" · ")} — set those by hand if the form has them.</span>` : ""}`;
    } catch (e) { out.className = "pd-ai-out bad"; out.textContent = e.message; }
    btn.disabled = false; btn.textContent = "Fill in filters";
  };
  $("pd-ai-go").addEventListener("click", aiGo);
  $("pd-ai-text").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); aiGo(); } });

  paintWho(); preview();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("pd-err"), btn = $("pd-create");
    err.classList.add("hidden");
    const s = spec();
    if (!s.owners.length) { err.textContent = toGroup() ? "Tick at least one rep in the group." : "Choose who makes the calls (step 1)."; err.classList.remove("hidden"); return; }
    btn.disabled = true; btn.textContent = "Creating…";
    try {
      const out = await api("/api/dialer/campaigns", { method: "POST", body: JSON.stringify({
        ...s, name: $("pd-name").value, gap: +$("pd-gap").value, start: $("pd-start").checked,
        callback_ext: $("pd-callback").value || undefined }) });
      closeModal();
      const split = out.perRep && out.perRep.length > 1 ? ` between ${out.perRep.length} reps (${out.perRep.map((r) => `${r.name} ${dashN(r.total)}`).join(", ")})` : "";
      toast(`Campaign created with ${dashN(out.total)} number${out.total === 1 ? "" : "s"}${split}${
        out.skippedInZoho ? ` · ${dashN(out.skippedInZoho)} left out — already in Zoho` : ""}${out.status === "ongoing" ? " — started" : " — press Start when ready"}`, 8000);
      if (S.tab !== "power") setTab("power"); else pdFetch();
    } catch (ex) {
      err.textContent = ex.message; err.classList.remove("hidden");
      btn.disabled = false; btn.textContent = "Create campaign";
    }
  });
}

/* Rep groups: named sets of reps a campaign can be given to at once. Made
   here by a manager; who is in each is entirely their choice. `back`
   reopens whatever sent us here (the New campaign form). */
async function openRepGroups(reps, back) {
  $("modal-title").textContent = "Rep groups";
  document.querySelector(".modal")?.classList.add("team-panel");
  $("modal-backdrop").classList.remove("hidden");
  if (!reps) {
    try { reps = await api("/api/dialer/campaigns/reps"); }
    catch (e) { $("modal-body").innerHTML = `<p class="login-error">${esc(e.message)}</p>`; return; }
  }
  let groups = [];
  const load = async () => { groups = (await api("/api/dialer/groups")).groups; };
  const repList = (sel, name) => `<div class="pd-members">${reps.reps.map((r) =>
    `<label class="pd-chip"><input type="checkbox" name="${name}" value="${r.id}"${sel.has(r.id) ? " checked" : ""}><span>${esc(r.name)}</span></label>`).join("")}</div>`;
  const paint = () => {
    $("modal-body").innerHTML = `
      <p class="modal-sub">Put together the reps who work a campaign together. A campaign given to a group shares
        its numbers out at random and evenly between them.</p>
      <div class="rg-list">${groups.map((g) => `
        <div class="rg-card" data-g="${g.id}">
          <div class="rg-head">
            <input class="rg-name" value="${esc(g.name)}" maxlength="60" aria-label="Group name">
            <span class="dash-mute">${g.members.length} rep${g.members.length === 1 ? "" : "s"}</span>
          </div>
          ${repList(new Set(g.members.map((m) => m.id)), "rg-m-" + g.id)}
          <div class="rg-acts">
            <button class="btn-ghost rg-del" data-del="${g.id}">Delete</button>
            <button class="btn-primary rg-save" data-save="${g.id}">Save</button>
          </div>
        </div>`).join("") || `<p class="dash-mute">No groups yet.</p>`}
      </div>
      <div class="rg-card rg-new">
        <div class="rg-head"><input class="rg-name" id="rg-new-name" maxlength="60" placeholder="New group name, e.g. Team A"></div>
        ${repList(new Set(), "rg-m-new")}
        <div class="rg-acts"><button class="btn-primary" id="rg-create">Create group</button></div>
      </div>
      <div id="rg-err" class="login-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="modal-cancel">${back ? "Back to the campaign" : "Close"}</button>
      </div>`;
    const err = (m) => { const x = $("rg-err"); x.textContent = m; x.classList.toggle("hidden", !m); };
    const picked = (name) => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((x) => +x.value);
    $("modal-cancel").addEventListener("click", () => { closeModal(); if (back) back(); });
    $("rg-create").addEventListener("click", async () => {
      try {
        groups = (await api("/api/dialer/groups", { method: "POST", body: JSON.stringify({ name: $("rg-new-name").value, members: picked("rg-m-new") }) })).groups;
        toast("Group created"); paint();
      } catch (e) { err(e.message); }
    });
    $("modal-body").querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", async () => {
      const id = b.dataset.save, card = b.closest(".rg-card");
      try {
        groups = (await api(`/api/dialer/groups/${id}`, { method: "PUT",
          body: JSON.stringify({ name: card.querySelector(".rg-name").value, members: picked("rg-m-" + id) }) })).groups;
        toast("Group saved"); paint();
      } catch (e) { err(e.message); }
    }));
    $("modal-body").querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      const g = groups.find((x) => String(x.id) === b.dataset.del);
      if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = `Delete "${g?.name}"?`; b.classList.add("btn-danger"); return; }
      try { groups = (await api(`/api/dialer/groups/${b.dataset.del}`, { method: "DELETE" })).groups; toast("Group deleted"); paint(); }
      catch (e) { err(e.message); }
    }));
  };
  try { await load(); } catch (e) { $("modal-body").innerHTML = `<p class="login-error">${esc(e.message)}</p>`; return; }
  paint();
}

/* ---------------- Power dialer: the rep's side ----------------
   Every signed-in person's page asks /api/campaign/state every 15s (one
   indexed row). When a manager starts their campaign a banner offers Join
   wherever they are in the app; when it is paused the dialler stops after
   the current call; resumed, it carries on by itself — the first Join click
   already bought the browser permission every later call reuses. */

const PDR = { last: null, poll: null, dismissed: "" };

function pdRepStart() {
  if (PDR.poll) return;
  pdRepCheck();
  PDR.poll = setInterval(pdRepCheck, 15000);
}

async function pdRepCheck() {
  /* not skipped when the tab is hidden: a manager's pause must reach a
     dialer that is running in the background */
  if (document.hidden && !CAMP.joined) return;
  let c;
  try { c = (await api("/api/campaign/state")).campaign; } catch (e) { return; }
  PDR.last = c;

  /* Keep an open Call session in step with what the manager just did. */
  if (S.tab === "camp" && c && (!CAMP.s || CAMP.s.id !== c.id)) loadCampaign();
  if (CAMP.s?.campaign && c && CAMP.s.id === c.id && CAMP.s.campaign.status !== c.status) {
    CAMP.s.campaign.status = c.status;
    CAMP.s.campaign.pausedBy = c.pausedBy || null;
    campPaintLive();
    const idle = !kdActive() && !CAMP.wrapTimer && !CAMP.awaitDispo && !CAMP.busy;
    if (c.status !== "ongoing") cancelAutoDial("paused by your manager");
    if (idle && (S.tab === "camp" || CAMP.joined)) {
      const note = $("camp-note")?.value || "";
      /* resumed after Join: carry straight on to the next lead */
      CAMP.advanced = c.status === "ongoing" && CAMP.joined;
      renderCampaign(CAMP.s);
      if ($("camp-note")) $("camp-note").value = note;
    } else if (S.tab === "camp" && c.status !== "ongoing") {
      const st = $("camp-auto-state");
      if (st) st.textContent = campPausedText(CAMP.s.campaign);
    }
  }
  // the "a campaign has started — Join" alert is for a rep who has not joined it yet
  const joinedThis = CAMP.joined && CAMP.s?.id === c?.id;
  pdBanner(c && c.status === "ongoing" && S.tab !== "camp" && !joinedThis && PDR.dismissed !== c.id + ":" + c.status ? c : null);
  pdRunPaint();
}

/* The power dialer running behind another screen: a bar on every page saying
   what it is doing — counting down to the next lead, on a call, waiting for
   the wrap-up, paused — with Pause/Resume and Open. Switching screens used to
   stop the dialer so nothing rang unseen; now it keeps going, in plain view. */
function pdRunActive() {
  const cur = CAMP.s?.current;
  if (!cur || CAMP.s.done) return false;
  const onThisLead = kdActive() && String(KD.lead?.id) === String(cur.lead?.id);
  return !!(CAMP.joined || CAMP.timer || CAMP.awaitDispo || onThisLead);
}
function pdRunPaint() {
  let el = $("pd-run");
  if (S.tab === "camp" || !pdRunActive()) { el?.remove(); return; }
  const d = CAMP.s, c = d.campaign;
  const paused = c && c.status !== "ongoing";
  const next = CAMP.nextDial?.name;
  const state = CAMP.timer && next ? `Calling ${next} in ${CAMP.countdown}s`
    : kdActive() ? `On a call${KD.lead?.name ? " with " + KD.lead.name : ""}`
      : CAMP.awaitDispo ? "Wrap up the last call to move on"
        : paused ? campPausedText(c)
          : ($("camp-auto-state")?.textContent || "Running");
  if (!el) {
    el = document.createElement("div");
    el.id = "pd-run";
    el.className = "pd-run";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
    el.addEventListener("click", (e) => {
      if (e.target.closest("#pd-run-open")) return setTab("camp");
      if (e.target.closest("#pd-run-pause")) {
        const cc = campOf();
        if (cc) return campPause(cc.status !== "ongoing");
        cancelAutoDial("paused — press the number when you are ready");
        return pdRunPaint();
      }
    });
  }
  const pos = Math.min(d.total, (d.pos || 0) + 1);
  const html = `<span class="pd-run-dot${paused ? " paused" : ""}"></span>
    <span class="pd-run-t"><b>Power dialer</b> · ${esc(c?.name || "Call session")} · ${dashN(pos)}/${dashN(d.total)}</span>
    <span class="pd-run-s">${esc(state)}</span>
    ${c || CAMP.timer ? `<button type="button" class="btn-ghost" id="pd-run-pause">${paused ? "Resume" : "Pause"}</button>` : ""}
    <button type="button" class="btn-primary" id="pd-run-open">Open</button>`;
  if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
}

function pdBanner(c) {
  let el = $("pd-banner");
  if (!c) { el?.remove(); return; }
  if (!el) {
    el = document.createElement("div");
    el.id = "pd-banner";
    el.className = "pd-banner";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
    el.addEventListener("click", (e) => {
      const k = PDR.last ? PDR.last.id + ":" + PDR.last.status : "";
      if (e.target.closest("#pd-banner-x")) { PDR.dismissed = k; return el.remove(); }
      if (e.target.closest("#pd-banner-go")) { PDR.dismissed = k; el.remove(); setTab("camp"); }
    });
  }
  const left = Math.max(0, c.total - c.pos);
  el.innerHTML = `<div class="pd-alert" role="alertdialog" aria-label="A power-dialer campaign has started">
      <button class="pd-banner-x" id="pd-banner-x" aria-label="Dismiss">✕</button>
      <span class="pd-alert-ic">${dashIc("M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z")}</span>
      <div class="pd-alert-t">
        <b>${esc(c.createdBy || "Your manager")} started “${esc(c.name)}”</b>
        <span>${dashN(left)} lead${left === 1 ? "" : "s"} to call — join now and they ring one after another</span>
      </div>
      <button class="btn-primary pd-alert-go" id="pd-banner-go">Join the campaign</button>
    </div>`;
}

/* ================= Caller reputation =================

   Two questions, never blended into one score (server/reputation.js):
     "Is my number flagged?"  — only a carrier / caller-ID analytics provider
       knows. Without one connected, the answer is "Unable to determine", in
       those words — never "not flagged".
     "How risky does our calling look?" — the Karma Connect Risk Score, from
       the call log, always labelled as ours.
   One row per outbound number; a row opens into the full breakdown: every
   signal with its state, the score's history, and review requests. */

const REP = { data: null, error: null, filter: "all", risk: "", open: null, detail: {}, tables: new Set(),
  checking: false, wired: false, seq: 0, poll: null };

const REP_STATUS = {
  good: { label: "Good", tone: "good", ic: "●" },
  at_risk: { label: "At risk", tone: "warn", ic: "▲" },
  potentially_flagged: { label: "Potentially flagged", tone: "serious", ic: "◆" },
  flagged: { label: "Flagged as spam", tone: "bad", ic: "■" },
  unknown: { label: "Unable to determine", tone: "none", ic: "○" },
};
const REP_BAND = { low: "good", moderate: "warn", high: "serious", critical: "bad" };
const REP_SIGNAL = {
  verified: { label: "Verified", tone: "info" }, detected: { label: "Detected", tone: "bad" },
  not_detected: { label: "Not detected", tone: "good" }, unknown: { label: "Unknown", tone: "none" },
};
const repDigits = (n) => String(n || "").replace(/\D/g, "");
const repBadge = (st) => { const s = REP_STATUS[st] || REP_STATUS.unknown;
  return `<span class="rep-badge ${s.tone}"><i aria-hidden="true">${s.ic}</i>${esc(s.label)}</span>`; };
const repRisk = (r) => r ? `<span class="rep-risk"><b>${r.score}</b><span>/100</span>
    <span class="rep-band ${REP_BAND[r.band] || "none"}">${esc(r.label)}</span></span>` : `<span class="dash-mute">Not checked</span>`;
const repSpam = (rep) => !rep.verified ? `<span class="dash-mute">Unknown</span>`
  : rep.spamFlag === true ? `<b class="rep-yes">Yes</b>` : rep.spamFlag === false ? "No" : `<span class="dash-mute">Unknown</span>`;

async function loadRep() {
  repWire();
  const body = $("rep-body");
  if (!REP.data) body.innerHTML = `<div class="dash-empty"><div class="dash-spin"></div>Reading your numbers…</div>`;
  const seq = ++REP.seq;
  try {
    const d = await api("/api/reputation");
    if (seq !== REP.seq) return;
    REP.data = d; REP.error = null;
  } catch (e) { if (seq === REP.seq) REP.error = e.message || String(e); }
  renderRep();
  /* The first visit starts a check in the background: look again shortly. */
  clearTimeout(REP.poll);
  if (REP.data?.checking && S.tab === "reputation") REP.poll = setTimeout(loadRep, 4000);
}

function repWire() {
  if (REP.wired) return;
  REP.wired = true;
  on("rep-check", "click", repCheckNow);
  on("rep-info", "click", repAbout);
  on("rep-settings", "click", repSettings);
  $("rep-filters").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rep-f]");
    if (!b) return;
    REP.filter = b.dataset.repF;
    renderRep();
  });
  on("rep-risk-f", "change", (e) => { REP.risk = e.target.value; renderRep(); });
  const body = $("rep-body");
  body.addEventListener("click", (e) => {
    const t = e.target.closest("[data-rep-tbl]");
    if (t) { const k = t.dataset.repTbl; if (REP.tables.has(k)) REP.tables.delete(k); else REP.tables.add(k); return renderRep(); }
    if (e.target.closest("[data-rep-review]")) return repRequestReview(e.target.closest("[data-rep-review]").dataset.repReview);
    if (e.target.closest("[data-rep-about]")) return repAbout();
    const row = e.target.closest("[data-rep-num]");
    if (!row || e.target.closest("a, select, button")) return;
    const n = row.dataset.repNum;
    REP.open = REP.open === n ? null : n;
    renderRep();
    if (REP.open) repLoadDetail(REP.open);
  });
  body.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-rep-num]")) { e.preventDefault(); e.target.click(); }
  });
  body.addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-rev-id]");
    if (!sel) return;
    try {
      await api(`/api/reputation/reviews/${sel.dataset.revId}`, { method: "PATCH", body: JSON.stringify({ status: sel.value }) });
      toast("Review status updated");
      repLoadDetail(REP.open, true);
    } catch (err) { toast("Couldn't update: " + err.message, 6000); }
  });
  /* the chart's hover read-out, as on the Dashboard */
  const tip = $("rep-tip");
  const show = (e) => {
    const t = e.target.closest?.("[data-rep-tip]");
    if (!t || !body.contains(t)) return tip.classList.add("hidden");
    tip.innerHTML = t.dataset.repTip;
    tip.classList.remove("hidden");
    const pane = $("rep-pane").getBoundingClientRect(), r = t.getBoundingClientRect();
    const x = (e.clientX ?? (r.left + r.width / 2)) - pane.left, y = (e.clientY ?? r.top) - pane.top;
    tip.style.left = Math.min(Math.max(8, x + 14), pane.width - tip.offsetWidth - 8) + "px";
    tip.style.top = (y - tip.offsetHeight - 12 < 8 ? y + 18 : y - tip.offsetHeight - 12) + "px";
  };
  body.addEventListener("mousemove", show);
  body.addEventListener("focusin", show);
  body.addEventListener("mouseleave", () => tip.classList.add("hidden"));
}

async function repCheckNow() {
  if (REP.checking) return;
  REP.checking = true;
  const b = $("rep-check");
  b.disabled = true; b.textContent = "Checking…";
  try {
    const r = await api("/api/reputation/check", { method: "POST", body: "{}" });
    toast(`Checked ${r.checked} number${r.checked === 1 ? "" : "s"}${r.alerts ? ` · ${r.alerts} alert${r.alerts === 1 ? "" : "s"}` : ""}`);
    REP.detail = {};
    await loadRep();
    if (REP.open) repLoadDetail(REP.open);
  } catch (e) { toast("Check failed: " + e.message, 8000); }
  REP.checking = false;
  b.disabled = false; b.textContent = "Check now";
}

async function repLoadDetail(num, force) {
  if (REP.detail[num] && !force) return renderRep();
  try { REP.detail[num] = await api("/api/reputation/number/" + repDigits(num)); }
  catch (e) { REP.detail[num] = { error: e.message }; }
  if (REP.open === num) renderRep();
}

function renderRep() {
  const d = REP.data, body = $("rep-body");
  if (!d) { body.innerHTML = `<div class="dash-empty"><b>Caller reputation couldn't load</b><span>${esc(REP.error || "")}</span></div>`; return; }
  const nums = d.numbers;
  const last = nums.map((n) => n.checkedAt).filter(Boolean).sort().pop();
  $("rep-sub").textContent = nums.length
    ? `${nums.length} outbound number${nums.length === 1 ? "" : "s"} · last checked ${last ? tmSince(last) : "never"}`
    : d.checking ? "Running the first check…" : "No numbers checked yet";

  /* filters: the verified status, and separately our own risk band */
  const vs = (n) => n.reputation.status;
  const counts = { all: nums.length, good: nums.filter((n) => vs(n) === "good").length,
    at_risk: nums.filter((n) => ["at_risk", "potentially_flagged"].includes(vs(n))).length,
    flagged: nums.filter((n) => vs(n) === "flagged").length, unknown: nums.filter((n) => vs(n) === "unknown").length };
  $("rep-filters").querySelectorAll("[data-rep-f]").forEach((b) => {
    b.classList.toggle("on", b.dataset.repF === REP.filter);
    b.setAttribute("aria-pressed", String(b.dataset.repF === REP.filter));
    const c = b.querySelector("em"); if (c) c.textContent = counts[b.dataset.repF];
  });
  const shown = nums.filter((n) =>
    (REP.filter === "all" || (REP.filter === "at_risk" ? ["at_risk", "potentially_flagged"].includes(vs(n)) : vs(n) === REP.filter))
    && (!REP.risk || n.risk?.band === REP.risk));

  const notice = d.sources.carrier ? "" : `<div class="rep-notice">
      <div class="rep-notice-ic" aria-hidden="true">i</div>
      <div><b>Carrier spam status can't currently be verified.</b>
        RingCentral doesn't share spam labels, and no caller-reputation provider is connected — so every number shows
        <b>Unable to determine</b> rather than a guess. The scores are <b>Karma Connect's own risk assessment</b> of how
        each number has been used, not a carrier spam label.
        <span class="rep-notice-links"><button class="rep-link" data-rep-about>About this status</button> ·
        <a href="${esc(d.registry)}" target="_blank" rel="noopener">Register your numbers free with the carriers' analytics engines →</a></span></div>
    </div>`;
  const alerts = (d.alerts || []).slice(0, 3).map((a) => `<div class="rep-alert ${a.kind === "warning" ? "bad" : "good"}">
      <b>${a.kind === "warning" ? "Number reputation warning" : "Number reputation healthy"}</b>
      <span>${esc(dashPhone(a.number))} — ${esc(a.text)} <em>${esc(tmSince(a.at))}</em></span></div>`).join("");

  if (!nums.length) {
    body.innerHTML = notice + `<div class="dash-empty">${d.checking ? `<div class="dash-spin"></div>Checking your RingCentral numbers — this takes a few seconds…`
      : `<b>No numbers checked yet</b><span>Press Check now.</span>`}</div>`;
    return;
  }
  const rows = shown.map((n) => {
    const open = REP.open === n.number;
    const who = [n.ext && "x" + n.ext, n.usage === "MainCompanyNumber" ? "Main number" : "", n.callerIdName && `“${n.callerIdName}”`]
      .filter(Boolean).join(" · ");
    return `<tr class="tm-row rep-row${open ? " open" : ""}" data-rep-num="${esc(n.number)}" tabindex="0" aria-expanded="${open}">
      <td><div class="cl-party"><b>${esc(dashPhone(n.number))}</b><span>${esc(who || "—")}</span></div></td>
      <td>${repBadge(n.reputation.status)}${n.reputation.verified ? `<span class="rep-src">${esc(n.reputation.source)}</span>` : ""}</td>
      <td>${repSpam(n.reputation)}</td>
      <td>${repRisk(n.risk)}</td>
      <td class="rep-why">${n.risk?.reasons?.length ? esc(n.risk.reasons.join(" · ")) : `<span class="dash-mute">No risk signals</span>`}</td>
      <td class="rep-when">${n.checkedAt ? esc(tmSince(n.checkedAt)) : "—"}${n.stale ? ` <span class="rep-stale" title="Due for a fresh check">due</span>` : ""}</td>
      <td class="tm-chev"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></td>
    </tr>${open ? `<tr class="tm-detail"><td colspan="7">${repDetail(n)}</td></tr>` : ""}`;
  }).join("");
  body.innerHTML = notice + alerts + `<div class="cl-tablewrap"><table class="cl-table rep-table">
    <thead><tr><th>Number</th><th>Reputation <span class="rep-th-sub">carrier / provider</span></th><th>Spam flag</th>
      <th>Karma Connect risk</th><th>Why</th><th>Last checked</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7"><div class="dash-empty"><b>No numbers match</b><span>Try another filter.</span></div></td></tr>`}</tbody>
  </table></div>`;
}

function repDetail(n) {
  const x = REP.detail[n.number];
  if (!x) return `<div class="tm-card"><div class="dash-empty"><div class="dash-spin"></div>Loading…</div></div>`;
  if (x.error) return `<div class="tm-card"><div class="dash-warn">${esc(x.error)}</div></div>`;
  const rep = x.reputation, risk = x.risk;
  const srcLine = (label, on, onText, offText) => `<div class="rep-srcrow"><span>${esc(label)}</span>
    <b class="${on ? "" : "dash-mute"}">${esc(on ? onText : offText)}</b></div>`;
  const flags = rep.verified ? (rep.spamFlag ? "1 detected" : "0 detected") : "Unknown";

  const verifiedCard = `<section class="rep-card">
      <h4>Is this number flagged? <span>verified sources only</span></h4>
      <div class="rep-big">${repBadge(rep.status)}</div>
      ${rep.verified ? "" : `<p class="rep-unv"><b>Reputation status cannot currently be verified.</b>
        Karma Connect has analysed the available calling signals, but carrier-level spam labelling is not accessible for this number.</p>`}
      <div class="tm-grid tm-grid2">
        <div class="tm-f"><span>Spam flags</span><b>${esc(flags)}</b></div>
        <div class="tm-f"><span>Last updated</span><b>${esc(tmSince(rep.checkedAt || x.checkedAt))}</b></div>
      </div>
      <h5>Status sources</h5>
      ${srcLine("Carrier reputation", x.sources.carrier, "Available (Hiya)", "Not connected")}
      ${srcLine("Caller ID reputation", x.sources.callerIdentity, "Available", "Unknown — no provider")}
      ${srcLine("Spam databases", x.sources.carrier, "Available (Hiya)", "Unknown — no provider")}
      ${srcLine("RingCentral", true, "Connected — no spam data in its API", "")}
      ${srcLine("Karma Connect risk score", !!risk, risk ? `${risk.score}/100` : "", "Not checked")}
      ${rep.verified && ["flagged", "potentially_flagged"].includes(rep.status)
        ? `<button class="btn-primary rep-review-btn" data-rep-review="${esc(n.number)}">Request reputation review</button>` : ""}
    </section>`;

  const riskCard = risk ? `<section class="rep-card">
      <h4>Karma Connect Risk Assessment: ${esc(risk.label)} <span>our analysis — not a carrier spam label</span></h4>
      <div class="rep-gauge" role="img" aria-label="Risk score ${risk.score} of 100, ${esc(risk.label)}">
        <div class="rep-gauge-track"><i class="${REP_BAND[risk.band]}" style="width:${Math.max(2, risk.score)}%"></i></div>
        <div class="rep-gauge-ticks"><span>0</span><span style="left:30%">30</span><span style="left:60%">60</span><span style="left:80%">80</span><span style="left:100%">100</span></div>
      </div>
      <div class="tm-grid tm-grid2">
        <div class="tm-f"><span>Risk score</span><b>${risk.score} / 100</b></div>
        <div class="tm-f"><span>Confidence</span><b>${risk.confidence >= 0.8 ? "High" : risk.confidence >= 0.6 ? "Medium" : "Low"}</b></div>
        <div class="tm-f"><span>Calls (7 days)</span><b>${dashN(risk.volume?.recent)}</b></div>
        <div class="tm-f"><span>Answered</span><b>${dashN(risk.volume?.answered)}</b></div>
        <div class="tm-f"><span>Previous 7 days</span><b>${dashN(risk.volume?.previous)}</b></div>
        <div class="tm-f"><span>Share of company calls</span><b>${x.share === null ? "—" : Math.round(x.share * 100) + "%"}</b></div>
      </div>
      <p class="rep-fine">0–29 Low · 30–59 Moderate · 60–79 High · 80–100 Critical. Built from this number's calls in RingCentral's call log and the dispositions reps record.</p>
    </section>` : "";

  const sigRows = x.signals.map((s) => { const t = REP_SIGNAL[s.state] || REP_SIGNAL.unknown;
    return `<tr><td><b>${esc(s.label)}</b><div class="rep-sig-d">${esc(s.detail || "")}</div></td>
      <td><span class="rep-sig ${t.tone}">${esc(t.label)}</span></td>
      <td>${esc(s.value || "")}</td><td class="n">${s.points ? "+" + s.points : `<span class="dash-mute">0</span>`}</td></tr>`; }).join("");

  const reviews = x.reviews.length ? `<table class="cl-table rep-rev"><thead><tr><th>Submitted</th><th>Provider</th><th>Reason</th><th>Status</th><th>Resolved</th></tr></thead>
    <tbody>${x.reviews.map((r) => `<tr><td>${esc(new Date(r.submitted_at).toLocaleDateString())}<div class="rep-sig-d">${esc(r.submitted_by)}</div></td>
      <td>${esc(x.reviewLinks[r.provider]?.name || r.provider)}</td><td>${esc(r.reason || "—")}</td>
      <td><select data-rev-id="${r.id}" aria-label="Review status">${["submitted", "under_review", "resolved", "rejected"].map((s) =>
        `<option value="${s}"${s === r.status ? " selected" : ""}>${{ submitted: "Submitted", under_review: "Under review", resolved: "Resolved", rejected: "Rejected" }[s]}</option>`).join("")}</select></td>
      <td>${r.resolved_at ? esc(new Date(r.resolved_at).toLocaleDateString()) : "—"}</td></tr>`).join("")}</tbody></table>`
    : `<p class="dash-mute rep-fine">No review requests. A review can be requested only when a provider reports this number as flagged —
        there's nothing to dispute in Karma Connect's own score.</p>`;

  const tblKey = "hist:" + n.number;
  return `<div class="tm-card rep-detail">
    <div class="rep-cards">${verifiedCard}${riskCard}</div>
    <section class="rep-sec"><header><h4>Reputation history</h4>
      <button class="dash-tbl" data-rep-tbl="${esc(tblKey)}" aria-pressed="${REP.tables.has(tblKey)}">Table</button></header>
      ${repHistory(x.history, REP.tables.has(tblKey))}</section>
    <section class="rep-sec"><h4>Reputation signals</h4>
      <table class="cl-table rep-sigs"><thead><tr><th>Signal</th><th>Status</th><th>Reading</th><th class="n">Points</th></tr></thead>
        <tbody>${sigRows}</tbody></table></section>
    <section class="rep-sec"><h4>Reputation review requests</h4>${reviews}</section>
  </div>`;
}

/* The Karma Connect Risk Score per day — one series, so no legend box; the
   band edges are drawn as recessive reference lines with their names. */
function repHistory(hist, table) {
  const pts = hist.filter((h) => h.provider === "internal" && h.score !== null);
  const carrier = hist.filter((h) => h.provider === "carrier");
  const statusOn = (day) => carrier.find((c) => c.day === day)?.status || null;
  const fmtDay = (day) => new Date(day + "T12:00").toLocaleDateString([], { month: "short", day: "numeric" });
  if (!pts.length) return `<div class="dash-none">History builds up as checks run — one point per day.</div>`;
  if (table) return `<table class="cl-table rep-hist-t"><thead><tr><th>Date</th><th class="n">Risk score</th><th>Band</th><th>Carrier status</th></tr></thead>
    <tbody>${pts.slice().reverse().map((p) => `<tr><td>${esc(fmtDay(p.day))}</td><td class="n"><b>${p.score}</b></td>
      <td>${esc(bandLabel(p.score))}</td><td>${statusOn(p.day) ? esc(REP_STATUS[statusOn(p.day)]?.label || statusOn(p.day)) : `<span class="dash-mute">Unknown</span>`}</td></tr>`).join("")}</tbody></table>`;

  const W = Math.max(320, Math.min(860, ($("rep-body")?.clientWidth || 900) - 80)), H = 190, L = 34, R = 74, T = 12, B = 26;
  const x = (i) => pts.length === 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (pts.length - 1);
  const y = (v) => T + (H - T - B) * (1 - v / 100);
  const grid = [0, 50, 100].map((v) => `<line class="dash-grid-l" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>
    <text class="dash-ax" x="${L - 8}" y="${y(v) + 3.5}" text-anchor="end">${v}</text>`).join("");
  const bands = [[30, "Moderate"], [60, "High"], [80, "Critical"]].map(([v, l]) =>
    `<line class="rep-ref" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>
     <text class="dash-ax rep-ref-t" x="${W - R + 6}" y="${y(v) + 3.5}">${l} ${v}</text>`).join("");
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.score).toFixed(1)}`).join(" ");
  const every = Math.ceil(pts.length / 8);
  const marks = pts.map((p, i) => {
    const st = statusOn(p.day);
    const tip = `<div class="dash-tip-h">${esc(fmtDay(p.day))}</div>
      <div class="dash-tip-row"><i style="background:var(--cat-1)"></i>Karma Connect risk<b>${p.score} · ${esc(bandLabel(p.score))}</b></div>
      <div class="dash-tip-row">Carrier status<b>${esc(st ? REP_STATUS[st]?.label || st : "Unknown")}</b></div>`;
    return `<g class="dash-hit" data-rep-tip="${esc(tip)}" tabindex="0">
      <rect x="${x(i) - (W - L - R) / Math.max(2, pts.length) / 2}" y="${T}" width="${(W - L - R) / Math.max(2, pts.length)}" height="${H - T - B}" fill="transparent"/>
      <circle cx="${x(i)}" cy="${y(p.score)}" r="4" class="rep-dot"/>
      ${i % every === 0 || i === pts.length - 1 ? `<text class="dash-ax" x="${x(i)}" y="${H - 7}" text-anchor="middle">${esc(fmtDay(p.day))}</text>` : ""}
    </g>`;
  }).join("");
  const lastP = pts[pts.length - 1];
  return `<svg class="dash-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Karma Connect Risk Score by day; latest ${lastP.score}">${grid}${bands}
    <path d="${line}" class="rep-line"/>${marks}
    <text class="dash-cap" x="${x(pts.length - 1)}" y="${y(lastP.score) - 10}" text-anchor="middle">${lastP.score}</text></svg>
    <p class="rep-fine">Karma Connect Risk Score, the last check of each day. Hover a point for that day's carrier status.</p>`;
}
const bandLabel = (s) => s >= 80 ? "Critical" : s >= 60 ? "High" : s >= 30 ? "Moderate" : "Low";

function repAbout() {
  $("modal-title").textContent = "About this status";
  $("modal-body").innerHTML = `
    <p class="modal-sub">Carrier spam labels ("Spam Likely", "Scam Likely") are controlled by telecom carriers and the
      caller-ID analytics providers behind them — Hiya for AT&amp;T, First Orion for T-Mobile, TNS for Verizon.
      Karma Connect can only show a verified status where an authorised data source provides it.
      RingCentral's API does not expose one.</p>
    <p class="modal-sub">Otherwise the score shown is <b>Karma Connect's own analysis</b> of how each number has been
      used — answer rate, calls hung up within seconds, bursts of volume, repeat dialling, opt-outs, caller-ID set-up.
      Those are the behaviours the providers' engines react to, so a rising score is worth acting on. But it is
      <b>not a carrier spam label</b>, and a low score does not mean a number is unflagged.</p>
    <p class="modal-sub">To see real labels, a provider such as Hiya's Number Reputation service (paid; your business and
      numbers registered first) can be connected. Registering your numbers is free at
      <a href="https://www.freecallerregistry.com/" target="_blank" rel="noopener">freecallerregistry.com</a>,
      which reaches all three engines.</p>
    <div class="modal-actions"><button type="button" class="btn-secondary" id="modal-cancel">Close</button></div>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
}

async function repSettings() {
  let s;
  try { s = await api("/api/reputation/settings"); } catch (e) { return toast(e.message, 6000); }
  $("modal-title").textContent = "Reputation alerts";
  $("modal-body").innerHTML = `
    <p class="modal-sub">Alerts are sent when something changes: a number's Karma Connect Risk Score rises to the
      threshold or above, a reputation provider newly flags a number, or a number recovers.
      They appear at the top of Caller reputation and, if switched on, are emailed to admins and owners.</p>
    <label class="rep-set"><span>Warn when the risk score reaches</span>
      <input type="number" id="rep-at" min="10" max="100" step="1" value="${s.alertAt}"> <em>/ 100</em></label>
    <label class="rep-set rep-set-cb"><input type="checkbox" id="rep-email"${s.email ? " checked" : ""}>
      <span>Email admins and owners</span></label>
    <div id="rep-set-err" class="login-error hidden"></div>
    <div class="modal-actions"><button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
      <button type="button" class="btn-primary" id="rep-save">Save</button></div>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  $("rep-save").addEventListener("click", async () => {
    try {
      await api("/api/reputation/settings", { method: "PUT",
        body: JSON.stringify({ alertAt: +$("rep-at").value, email: $("rep-email").checked }) });
      closeModal(); toast("Alert settings saved"); loadRep();
    } catch (e) { const el = $("rep-set-err"); el.textContent = e.message; el.classList.remove("hidden"); }
  });
}

async function repRequestReview(num) {
  const reason = prompt(`Request a reputation review for ${dashPhone(num)}.\n\nWhy is the label wrong? (e.g. "Legitimate business calls to our own customers")`);
  if (reason === null) return;
  try {
    const r = await api("/api/reputation/number/" + repDigits(num) + "/reviews", { method: "POST",
      body: JSON.stringify({ provider: "carrier", reason }) });
    toast(`Review recorded — opening ${r.submitTo.name}'s request form to submit it`, 7000);
    window.open(r.submitTo.url, "_blank", "noopener");
    repLoadDetail(num, true);
  } catch (e) { toast("Couldn't record the review: " + e.message, 8000); }
}

/* ================= Users — the team directory =================

   Everyone on the phone system and everyone with a Karma Connect account,
   joined by email. A row opens into the full card (role, extension,
   department, language, time zone, status, devices, numbers, Karma Connect
   access). Read-only for RingCentral; "Manage access" opens the existing
   Karma Connect users dialog for invites and roles. */

const TM = { q: "", status: "active", role: "", dept: "", agent: "", data: null, error: null,
  open: new Set(), wired: false, seq: 0 };

function tmQuery(extra = {}) {
  const q = new URLSearchParams({ tz: dashTz(), status: TM.status, ...extra });
  for (const [k, v] of [["q", TM.q], ["role", TM.role], ["dept", TM.dept], ["agent", TM.agent]]) if (v) q.set(k, v);
  return q;
}

async function loadTeam() {
  tmWire();
  const body = $("tm-body");
  if (!TM.data) body.innerHTML = `<div class="dash-empty"><div class="dash-spin"></div>Gathering the team…</div>`;
  else body.classList.add("dash-stale");
  const seq = ++TM.seq;
  try {
    const d = await api("/api/voice/rc/users?" + tmQuery());
    if (seq !== TM.seq) return;
    TM.data = d; TM.error = null;
  } catch (e) { if (seq === TM.seq) TM.error = e.message || String(e); }
  body.classList.remove("dash-stale");
  renderTeam();
}

function tmWire() {
  if (TM.wired) return;
  TM.wired = true;
  let t;
  on("tm-q", "input", (e) => { clearTimeout(t); t = setTimeout(() => { TM.q = e.target.value.trim(); loadTeam(); }, 300); });
  for (const [id, key] of [["tm-status", "status"], ["tm-role", "role"], ["tm-dept", "dept"], ["tm-agent", "agent"]])
    on(id, "change", (e) => { TM[key] = e.target.value; loadTeam(); });
  on("tm-access", "click", () => openUsersModal());

  const pop = $("tm-dl-pop"), open = $("tm-dl-open");
  on("tm-dl-open", "click", (e) => {
    e.stopPropagation();
    const show = pop.classList.contains("hidden");
    pop.classList.toggle("hidden", !show);
    open.setAttribute("aria-expanded", String(show));
  });
  document.addEventListener("click", (e) => {
    if (!pop.classList.contains("hidden") && !e.target.closest("#tm-dl-pop")) {
      pop.classList.add("hidden"); open.setAttribute("aria-expanded", "false");
    }
  });
  pop.addEventListener("click", (e) => {
    const b = e.target.closest("[data-format]");
    if (!b) return;
    const a = document.createElement("a");
    a.href = "/api/voice/rc/users?" + tmQuery({ format: b.dataset.format });
    document.body.appendChild(a); a.click(); a.remove();
    pop.classList.add("hidden"); open.setAttribute("aria-expanded", "false");
  });

  $("tm-body").addEventListener("click", (e) => {
    const row = e.target.closest("[data-tm-key]");
    if (!row || e.target.closest("a")) return;
    const k = row.dataset.tmKey;
    if (TM.open.has(k)) TM.open.delete(k); else TM.open.add(k);
    renderTeam();
  });
  $("tm-body").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-tm-key]")) { e.preventDefault(); e.target.click(); }
  });
}

const TM_AGENT = {
  "Available": "avail", "On call": "live", "Ringing": "ring", "On hold": "hold", "Busy": "busy",
  "Do not disturb": "busy", "Offline": "off", "No phone seat": "none", "Using another seat": "warn", "Unknown": "none",
};
const tmSince = (iso) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 2) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
};

function renderTeam() {
  const d = TM.data, body = $("tm-body");
  if (!d) {
    body.innerHTML = `<div class="dash-empty"><b>Users couldn't load</b><span>${esc(TM.error || "")}</span></div>`;
    return;
  }
  clFillSelect("tm-role", d.options.roles.map((r) => [r, roleLabel(r)]), TM.role);
  clFillSelect("tm-dept", d.options.departments.map((x) => [x, x]), TM.dept);
  $("tm-dept-wrap").classList.toggle("hidden", !d.options.departments.length);
  clFillSelect("tm-agent", d.options.agentStatuses.map((x) => [x, x]), TM.agent);
  const st = $("tm-status");
  st.value = TM.status; st.closest(".cl-chip").classList.toggle("on", TM.status !== "active");

  const onPhone = d.rows.filter((r) => r.onRc).length;
  $("tm-sub").textContent = `${dashN(onPhone)} on the phone system · ${dashN(d.rows.length - onPhone)} with Karma Connect only`;
  $("tm-total").innerHTML = `Total users: <b>${dashN(d.total)}</b>`;

  const warn = (d.warnings || []).map((w) => `<div class="dash-warn">${esc(w)}</div>`).join("");
  if (!d.rows.length) {
    body.innerHTML = `${warn}<div class="dash-empty"><b>No users match</b><span>Try another filter or search.</span></div>`;
    return;
  }

  const roleCell = (r) => [r.rcRole && `<span class="tm-role">${esc(r.rcRole)}</span>`,
    r.app && `<span class="dash-chip tm-app ${esc(r.app.role)}">${esc(roleLabel(r.app.role))}</span>`].filter(Boolean).join("")
    || `<span class="dash-mute">—</span>`;
  const status = (r) => `<span class="tm-agent ${TM_AGENT[r.agentStatus] || "none"}"><i></i>${esc(r.agentStatus)}</span>`;
  const field = (label, value) => `<div class="tm-f"><span>${esc(label)}</span><b>${value || `<em class="dash-mute">—</em>`}</b></div>`;

  const detail = (r) => {
    const flags = [];
    if (r.borrowedBy?.length)
      flags.push(`Karma Connect's dialler is signed in to this extension as <b>${r.borrowedBy.map(esc).join(", ")}</b> — not ${esc(r.name)}. `
        + `Calls they place go out as ${esc(r.name)}, and their browser takes one of this line's phone slots.`);
    if (r.app?.dialsAs && !r.onRc)
      flags.push(`Dials from <b>x${esc(r.app.dialsAs)}${r.app.dialsAsName ? ` (${esc(r.app.dialsAsName)})` : ""}</b>, someone else's extension. `
        + `They need their own RingCentral login: Calls → Disconnect, then Connect as themselves.`);
    if (r.app?.lastError) flags.push(`Last RingCentral error: ${esc(r.app.lastError)}`);
    const nums = r.numbers.map((n) => `<div>${esc(dashPhone(n.number))} <em>${esc((n.usage || "").replace(/([a-z])([A-Z])/g, "$1 $2"))}</em></div>`).join("");
    const devs = r.devices.map((x) => `${esc(x.type)}${x.status ? ` <em>${esc(x.status.toLowerCase())}</em>` : ""}`).join(" · ");
    return `<tr class="tm-detail"><td colspan="8"><div class="tm-card">
      ${flags.map((f) => `<div class="dash-warn tm-flag">${f}</div>`).join("")}
      <div class="tm-cols">
        <section><h4>Phone system</h4><div class="tm-grid">
          ${field("Role", esc(r.rcRole))}${field("Extension", r.ext ? "x" + esc(r.ext) : "")}
          ${field("Department", esc(r.department))}${field("Language", esc(r.language))}
          ${field("Time zone", esc(r.timezone))}${field("Status", esc(r.status))}
          ${field("Online status", status(r))}${field("International calling", r.onRc ? (r.international ? "Enabled" : "Disabled") : "")}
          ${field("Devices", devs)}${field("Phone admin", r.onRc ? (r.admin ? "Yes" : "No") : "")}
        </div></section>
        <section><h4>Numbers</h4><div class="tm-nums">${nums || `<em class="dash-mute">No numbers assigned</em>`}</div>
          <h4>Today</h4><div class="tm-grid tm-grid2">
            ${field("Calls", dashN(r.today.calls))}${field("Talk time", dashDur(r.today.talk))}
            ${field("Missed", dashN(r.today.missed))}
          </div></section>
        <section><h4>Karma Connect</h4><div class="tm-grid tm-grid2">
          ${field("Access", r.app ? (r.app.disabled ? "Disabled" : esc(roleLabel(r.app.role))) : "No account")}
          ${field("Dialler", r.app ? (r.app.connected ? (r.app.dialsAs && r.app.dialsAs !== r.ext ? `Connected as x${esc(r.app.dialsAs)}` : "Connected") : "Not connected") : "")}
          ${field("Last active", r.app ? esc(tmSince(r.app.lastActive)) : "")}
          ${field("Email", esc(r.email))}
        </div></section>
      </div></div></td></tr>`;
  };

  body.innerHTML = `${warn}<div class="cl-tablewrap"><table class="cl-table tm-table">
    <thead><tr><th></th><th>Name</th><th>Role</th><th>Extension</th><th>Number(s)</th><th>Agent status</th>
      <th class="n">Today</th><th></th></tr></thead>
    <tbody>${d.rows.map((r) => {
      const open = TM.open.has(r.key);
      const flagged = r.borrowedBy?.length || (r.app?.dialsAs && !r.onRc);
      return `<tr class="tm-row${open ? " open" : ""}${r.onRc ? "" : " tm-apponly"}" data-tm-key="${esc(r.key)}" tabindex="0" aria-expanded="${open}">
        <td class="tm-avc"><span class="live-av tm-av">${esc(initials(r.name))}</span></td>
        <td><div class="cl-party"><b>${esc(r.name)}${flagged ? ` <span class="tm-warndot" title="Needs attention">!</span>` : ""}</b><span>${esc(r.email || "—")}</span></div></td>
        <td><div class="tm-roles">${roleCell(r)}</div></td>
        <td>${r.ext ? `<b class="tm-ext">x${esc(r.ext)}</b>` : `<span class="dash-mute">—</span>`}</td>
        <td>${r.numbers.length ? r.numbers.map((n) => `<div class="tm-num">${esc(dashPhone(n.number))}</div>`).join("") : `<span class="dash-mute">—</span>`}</td>
        <td>${status(r)}</td>
        <td class="n">${r.today.calls ? `<b>${dashN(r.today.calls)}</b> <span class="dash-mute">· ${esc(dashDur(r.today.talk))}</span>` : `<span class="dash-mute">0</span>`}</td>
        <td class="tm-chev"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></td>
      </tr>${open ? detail(r) : ""}`;
    }).join("")}</tbody></table></div>`;
}

/* ================= Live calls — the floor this second =================

   Polls /api/calls/live every 5s while the tab is open (and only then), and
   ticks every call's timer once a second in between, so a 40-second call
   reads 0:40 and not "about a minute". Server time anchors the timers: the
   offset between the server's clock and this machine's is measured on each
   poll, so a laptop running two minutes slow still shows the right length. */

const LIVEB = { data: null, error: null, poll: null, tick: null, skew: 0, wired: false };

async function loadLive() {
  liveWire();
  if (!LIVEB.data) $("live-body").innerHTML = `<div class="dash-empty"><div class="dash-spin"></div>Looking at the floor…</div>`;
  await liveFetch();
  liveStop();
  LIVEB.poll = setInterval(() => { if (!document.hidden) liveFetch(); }, 5000);
  LIVEB.tick = setInterval(liveTick, 1000);
}
function liveStop() {
  clearInterval(LIVEB.poll); clearInterval(LIVEB.tick);
  LIVEB.poll = LIVEB.tick = null;
}
async function liveFetch() {
  try {
    const d = await api("/api/calls/live");
    LIVEB.skew = d.now - Date.now();
    LIVEB.data = d; LIVEB.error = null;
  } catch (e) { LIVEB.error = e.message || String(e); }
  if (S.tab === "live") renderLive();
}

function liveWire() {
  if (LIVEB.wired) return;
  LIVEB.wired = true;
  $("live-body").addEventListener("click", (e) => {
    const a = e.target.closest("[data-live-lead]");
    if (!a) return;
    const tab = KIND_TAB[a.dataset.kind] || "companies";
    setTab(tab);
    select({ Id: +a.dataset.liveLead, _t: tab });
  });
}

const liveClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
};
function liveTick() {
  const now = Date.now() + LIVEB.skew;
  document.querySelectorAll("#live-body [data-since]").forEach((el) => {
    el.textContent = liveClock(now - +el.dataset.since);
  });
}

const LIVE_STATE = {
  live: ["Connected", "live"], hold: ["On hold", "hold"], ringing: ["Ringing", "ring"],
  available: ["Available", "avail"], busy: ["Busy", "busy"], offline: ["Offline", "off"],
};

function renderLive() {
  const body = $("live-body"), d = LIVEB.data;
  const sub = $("live-sub"), pills = $("live-pills");
  const navCount = $("count-live");
  if (!d) {
    body.innerHTML = `<div class="dash-empty"><b>The live board couldn't load</b><span>${esc(LIVEB.error || "")}</span></div>`;
    return;
  }
  const c = d.counts, active = c.live + c.hold + c.ringing;
  if (navCount) { navCount.textContent = active || ""; navCount.classList.toggle("hidden", !active); }
  if (sub) sub.innerHTML = `<span class="dash-livetag"><i></i>Live</span> refreshes every 5 seconds`
    + (LIVEB.error ? ` · <span class="dash-errtag" title="${esc(LIVEB.error)}">last refresh failed</span>` : "");
  if (pills) pills.innerHTML = [
    ["live", c.live, "on a call"], ["ring", c.ringing, "ringing"], ["hold", c.hold, "on hold"],
    ["avail", c.available, "available"], ["off", c.offline, "offline"],
  ].map(([k, n, l]) => `<span class="live-pill ${k}${n ? "" : " zero"}"><i></i><b>${n}</b>${l}</span>`).join("");

  const calling = d.agents.filter((a) => ["live", "hold", "ringing"].includes(a.status));
  const floor = d.agents.filter((a) => !["live", "hold", "ringing"].includes(a.status));

  const card = (a) => {
    const [label, cls] = LIVE_STATE[a.status];
    const L = a.lead;
    /* A rep you are the designated manager for (migration 020). When their
       phone is ringing an inbound call, it is yours to pick up — the thing
       the RingCentral call queue actually rings you for; the flag here is so
       you can see at a glance which ringing call on the floor is that one. */
    const mine = !!(a.manager && d.you && a.manager === d.you);
    const pickup = mine && a.status === "ringing" && a.direction === "Inbound";
    const where = L ? [L.company && L.company !== L.name ? L.company : "", [L.city, L.state].filter(Boolean).join(", ")]
      .filter(Boolean).join(" · ") : "";
    const who = L
      ? `<button class="live-lead" data-live-lead="${L.id}" data-kind="${esc(L.kind || "")}" title="Open this lead">${esc(L.name || "Unnamed lead")}</button>`
      : `<span class="live-lead none">${a.number ? "Not a lead in Karma Connect" : "Number not shown"}</span>`;
    return `<article class="live-card ${cls}${mine ? " yours" : ""}${pickup ? " pickup" : ""}">
      <header>
        <span class="live-av">${esc(initials(a.name))}</span>
        <div class="live-agent"><b>${esc(a.name)}</b>${a.ext ? `<span>x${esc(a.ext)}</span>` : ""}${mine ? `<span class="live-cover">your rep</span>` : ""}</div>
        <span class="live-badge ${cls}"><i></i>${label}</span>
      </header>
      ${pickup ? `<div class="live-pickup">📞 Your rep's phone is ringing — pick up</div>` : ""}
      <div class="live-timer" ${a.since ? `data-since="${a.since}"` : ""}>${a.since ? liveClock(Date.now() + LIVEB.skew - a.since) : "—"}</div>
      <div class="live-to">
        <span class="live-dir">${a.direction === "Inbound" ? "← Inbound from" : "→ Calling"}</span>
        ${who}
        ${where ? `<span class="live-where">${esc(where)}</span>` : ""}
        ${a.number ? `<span class="live-num">${esc(dashPhone(a.number))}</span>` : ""}
      </div>
      <footer>
        ${L?.status ? `<span class="dash-chip">${esc(L.status)}</span>` : "<span></span>"}
        <span class="live-src">${a.source === "dialler" ? "via Karma Connect" + (a.by ? ` · dialled by ${esc(a.by)}` : "") : "RingCentral app / desk phone"}</span>
      </footer>
    </article>`;
  };

  const chip = (a) => {
    const [label, cls] = LIVE_STATE[a.status] || ["", "off"];
    return `<div class="live-chip ${cls}" title="${esc(label)}"><i></i><b>${esc(a.name)}</b>${a.ext ? `<span>x${esc(a.ext)}</span>` : ""}<em>${esc(label)}</em></div>`;
  };

  body.innerHTML = `
    ${d.presenceError ? `<div class="dash-warn">${esc(d.presenceError)}</div>` : ""}
    <section class="live-section">
      <h3>On the phone <span>${active}</span></h3>
      ${calling.length ? `<div class="live-grid">${calling.map(card).join("")}</div>`
        : `<div class="live-quiet"><div class="live-quiet-ic">${dashIc(DASH_IC.all)}</div>
             <b>Nobody is on a call right now</b>
             <span>${c.available} available · ${c.offline} offline. Calls appear here the moment they start ringing.</span></div>`}
    </section>
    <section class="live-section">
      <h3>The floor <span>${floor.length}</span></h3>
      ${floor.length ? `<div class="live-floor">${floor.map(chip).join("")}</div>`
        : `<p class="dash-mute">Everyone is on a call.</p>`}
    </section>`;
}

async function boot() {
  await discover();          // must succeed before we take the login screen away,
  $("login-screen").classList.add("hidden");   // or a no-access account gets an
  $("app").classList.remove("hidden");         // empty shell with no explanation
  $("user-avatar").textContent = initials(S.me.display_name || S.me.email);
  $("menu-name").textContent = S.me.display_name || S.me.email.split("@")[0];
  $("menu-email").textContent = S.me.email;
  renderStateOptions();
  /* Admin surfaces ship hidden in the markup and are revealed here, once the
     role is known — a member never sees them flash. This is presentation only:
     job-search, import, apify-usage, users and activity all check the role
     server-side and 403. */
  if (isAdmin()) {
    document.querySelectorAll(".admin-only").forEach((el) =>
      el.classList.remove("hidden"));
    // the mirror of admin-only: surfaces a rep needs but an admin does not —
    // today, the rep's own Call session (an admin runs campaigns from Power).
    document.querySelectorAll(".member-only").forEach((el) =>
      el.classList.add("hidden"));
    // Select stays where it was left, like density and sort. renderBulkTools()
    // paints the toggle when the first list renders.
    S.selectMode = !!localStorage.getItem("kl_select_mode");
    loadApifyUsage();       // admin surface — a member asking would just 403
  }
  await loadRecents();       // the Recent tab is served from this, so fetch it first
  const saved = localStorage.getItem("kl_sort");
  if (saved && SORTS.some((s) => s.key === saved)) S.sort = saved;
  const dl = S.deepLink || {};
  /* A member lands on their own queue: the first question a rep has is "what
     do I call next", and Companies would open a list scoped to them anyway.
     An admin lands on Companies, because their first question is about the
     whole base. A deep link beats both. */
  setTab(TABS[dl.tab] ? dl.tab : (isAdmin() ? "companies" : "tasks"));
  // only the three real lead tabs can open a record by id
  if (dl.open && TABS[dl.tab]?.kind && !TABS[dl.tab].segment) {
    select({ Id: +dl.open, _t: dl.tab });
  }
  refreshCounts();
  // first visit on this browser: walk the newcomer around, once the list has
  // had a beat to paint — any exit sets kl_tour_done, so it never nags
  if (!localStorage.getItem("kl_tour_done")) setTimeout(startTour, 800);
  S.booted = true;             // from here on, a 401 means the session died
  if (document.body.classList.contains("kc-embed")) rcPanelToggle(true);
  else openDesktopDialer();
  kdStartReminders();
  pdRepStart();
  crmStart();
  crmMeLoad();
  vmLoad();
}

/* Open the Karma Connect Dialer desktop app (desktop/) next to the web app: it
   registers karmaconnect:// with Windows, so following the link starts it or
   brings it back from its bubble. Not installed → the browser has no handler
   and does nothing. Once per session, Windows only, never inside the desktop
   app's own window. Same as src/lib/desktopDialer.js on the Connect side. */
function openDesktopDialer() {
  try {
    if (!/Windows/i.test(navigator.userAgent) || /Electron/i.test(navigator.userAgent)) return;
    if (sessionStorage.getItem("kc_desktop_dialer_opened")) return;
    sessionStorage.setItem("kc_desktop_dialer_opened", "1");
    location.href = "karmaconnect://open";
  } catch (e) { /* storage blocked — skip it */ }
}

async function init() {
  const usp = new URLSearchParams(location.search);
  /* Embed mode: this app, loaded in the browser-extension's floating panel as
     an <iframe> at ?embed=dialer, runs as a bare softphone over every website.
     The CSS hides the dashboard and docks the dialler to fill the frame; the
     extension carries it around any page. Flagged here, before paint, so the
     dashboard never flashes. */
  if (usp.get("embed") === "dialer") {
    document.body.classList.add("kc-embed");
    kcWireEmbed(usp.get("k") || "");
    /* The desktop app (desktop/main.js, Electron) is a frameless window: the
       panel's header is its title bar and shows minimise / close (.kd-win).
       Only a build that has those controls (its preload exposes minimize):
       an older installer still has the Windows title bar, and must not get a
       second, dead pair of buttons from the new site. */
    if (/Electron/i.test(navigator.userAgent) && typeof window.kcDesktop?.minimize === "function")
      document.body.classList.add("kc-desktop");
  }
  // a failed hosted-login bounce lands back here with the reason in the URL
  const authError = usp.get("authError");
  if (authError) {
    usp.delete("authError");
    history.replaceState(null, "",
      location.pathname + (usp.toString() ? "?" + usp.toString() : ""));
  }
  /* back from Zoho's sign-in page: say how it went, then tidy the URL */
  if (usp.get("crm")) {
    const ok = usp.get("crm") === "ok", msg = usp.get("msg") || "";
    setTimeout(() => toast(ok ? "Zoho CRM connected — your calls and leads will be filed under you"
      : "Zoho CRM didn't connect: " + (msg || "unknown error"), ok ? 5000 : 9000), 600);
    usp.delete("crm"); usp.delete("msg");
    history.replaceState(null, "", location.pathname + (usp.toString() ? "?" + usp.toString() : ""));
  }
  if (usp.get("rc")) {
    const ok = usp.get("rc") === "ok", msg = usp.get("msg") || "";
    setTimeout(() => toast(ok ? "RingCentral connected — you dial from your own extension"
      : "RingCentral didn't connect: " + (msg || "unknown error"), ok ? 5000 : 9000), 600);
    usp.delete("rc"); usp.delete("msg");
    history.replaceState(null, "", location.pathname + (usp.toString() ? "?" + usp.toString() : ""));
  }
  if (usp.get("theme") !== null) localStorage.setItem("kl_theme", usp.get("theme"));
  // compact is the default now; browsers that saved the old "cozy" default flip once
  if (!localStorage.getItem("kl_density_default2")) {
    localStorage.setItem("kl_density", "compact");
    localStorage.setItem("kl_density_default2", "1");
  }
  if (usp.get("density")) localStorage.setItem("kl_density", usp.get("density"));
  S.deepLink = { tab: usp.get("tab"), open: usp.get("open") };
  const savedTheme = localStorage.getItem("kl_theme");
  document.documentElement.dataset.theme =
    savedTheme === "" ? "light" : (savedTheme || "dark");
  const savedSize = +localStorage.getItem("kl_page_size");
  if (PAGE_SIZES.includes(savedSize)) S.pageSize = savedSize;
  setDensity(localStorage.getItem("kl_density") || "compact");
  setDetailWidth(+localStorage.getItem("kl_detail_w") || 460);
  try { wire(); } catch (e) { console.error("[karma] wiring failed", e); }
  let stored = authError;
  // always attempt boot: the WorkOS session lives in a cookie
  try { await boot(); return; } catch (ex) { stored = stored || ex.message; }

  /* No session. There is one sign-in on this site and it belongs to Karma
     Connect, so go straight to it and return here afterwards — a second
     sign-in card here would only duplicate it. */
  if (!stored || /unauthorized|invalid|Not signed in/i.test(stored)) {
    /* Karma Connect's sign-in page, at the site root — not /api/auth/login,
       which is WorkOS's route and now only a fallback for sessions minted
       before the cutover. ?next= brings you back here once you are in. */
    location.replace("/?next=" + encodeURIComponent(location.pathname));
    return;
  }

  /* Signed in, but this account cannot use Leads (the API said so). Sending
     them to the sign-in would bounce them back here forever, so say what
     happened and offer the way back to Connect. */
  $("login-screen").classList.remove("hidden");
  $("app").classList.add("hidden");
  const err = $("login-error");                   // say why, don't just bounce
  err.textContent = stored;
  err.classList.remove("hidden");
}

init();
