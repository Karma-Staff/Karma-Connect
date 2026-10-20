// Finding prospects by itself. Authorised by the owner on 2026-10-20: the agent searches LinkedIn
// for decision-makers at restoration companies in the US and Canada, and invites them on its own
// (no approval for the invitation; every message after they accept is still approved by a person).
//
//   1. watch() asks nextSearch() whether this account should search now. It does when the
//      account is on, its "find prospects" switch is on, and fewer invitations are waiting to go
//      than it can send today. Searches are capped per day and spaced out: LinkedIn watches
//      search more closely than anything else, and a free account has a monthly search limit.
//   2. The worker opens that search page (agent/prospect.cjs) and posts back what it saw.
//   3. recordProspects() keeps only real decision-makers at restoration companies whom nobody on
//      the team has contacted, saves each as a lead (History), and queues an invitation from this
//      account — sent by the ordinary invite path, inside the same daily and weekly limits.
//   4. Once they accept, the existing flow takes over: the agent copies their profile, and the
//      server researches them and drafts the first message (li-prep.cjs) for a person to approve.
//
// LI_PROSPECTING=0 turns the whole thing off.
const crypto = require("crypto");
const { dbOn, q, logActivity } = require("./db.cjs");

const ON = process.env.LI_PROSPECTING !== "0";
const SEARCHES_PER_DAY = Math.max(1, Math.min(20, parseInt(process.env.LI_SEARCHES_PER_DAY || "6", 10) || 6));
const SEARCH_GAP_MIN = Math.max(10, parseInt(process.env.LI_SEARCH_GAP_MIN || "40", 10) || 40);
const PER_SEARCH = 10;     // invitations queued from one search page at most

const GEO = { us: "103644278", ca: "101174742" };   // LinkedIn's geo ids: United States, Canada
// The owner's choice: owners and top leaders, plus operations leaders.
const TITLES = ["owner", "president", "CEO", "founder", "general manager", "operations manager",
  "director of operations", "VP operations", "branch manager", "partner"];
const TRADES = ["restoration", "water damage restoration", "mitigation"];
const PAGES = 3;           // pages of each search, before moving to the next title

// Every search, in the order they're worked through: title × trade × page.
const SPECS = [];
for (let p = 1; p <= PAGES; p++) for (const t of TITLES) for (const k of TRADES) SPECS.push({ title: t, trade: k, page: p });

function searchUrl(spec) {
  const u = new URL("https://www.linkedin.com/search/results/people/");
  u.searchParams.set("keywords", spec.title + " " + spec.trade);
  u.searchParams.set("geoUrn", JSON.stringify([GEO.us, GEO.ca]));
  u.searchParams.set("network", JSON.stringify(["S", "O"]));   // 2nd and 3rd+: never people already connected
  u.searchParams.set("origin", "FACETED_SEARCH");
  if (spec.page > 1) u.searchParams.set("page", String(spec.page));
  return u.toString();
}

// ── Who counts ──────────────────────────────────────────────────────
// A decision-maker by their headline: the owner's list, and the operations leaders.
const LEADER = /\b(owner|co-?owner|founder|co-?founder|president|ceo|chief executive|chief operating|coo|partner|principal|general manager|gm|managing director|vp|vice president|director of operations|operations director|director,? operations|head of operations|operations manager|ops manager|branch manager|regional manager|area manager)\b/i;
// …but not someone who only works for one, wants a job, or has left.
const NOT_LEADER = /\b(assistant|intern|student|seeking|looking for|open to work|former|retired|ex-|aspiring|technician|tech\b|estimator|adjuster|recruit|sales rep|account executive|business development rep|bdr|sdr|marketing (?:specialist|coordinator)|coordinator)\b/i;
// A restoration company by the headline. The search keyword alone isn't enough: LinkedIn matches
// it anywhere on the profile, including someone's job ten years ago.
const RESTORATION = /\b(restor\w*|mitigat\w*|water damage|fire damage|flood|mold|mould|remediat\w*|disaster|reconstruct\w*|catastroph\w*|servpro|belfor|paul davis|puroclean|rainbow international|911 restoration|first ?onsite|blusky|dki|steamatic|chem-?dry|rytech|ati restoration|bms cat|cotton (?:global|commercial))\b/i;

const handleOf = (url) => {
  const m = String(url || "").match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  if (!m) return "";
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch (e) { return m[1].toLowerCase(); }
};

// "Owner at Acme Restoration" / "President | Acme Restoration" → { title, company }
function splitHeadline(h) {
  const s = String(h || "").trim();
  const at = s.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
  if (at) return { title: at[1].trim(), company: at[2].split(/\s[|·•,]\s|\s[-–]\s/)[0].trim() };
  const bar = s.split(/\s[|·•]\s|\s[-–]\s/);
  if (bar.length > 1) return { title: bar[0].trim(), company: bar[1].trim() };
  return { title: s, company: "" };
}

/* One search result → why it's skipped, or null when it's a prospect.
   c: { handle, name, headline, location, degree } as agent/prospect.cjs reads them. */
function skipReason(c) {
  if (!c || !c.handle) return "no profile link";
  const name = String(c.name || "").trim();
  if (!name || /linkedin member/i.test(name)) return "name hidden";
  if (c.degree === "1st") return "already a connection";
  const h = String(c.headline || "");
  if (!LEADER.test(h)) return "not a decision-maker";
  if (NOT_LEADER.test(h)) return "not a decision-maker";
  if (!RESTORATION.test(h)) return "not a restoration company";
  return null;
}

// The short note, while the account still has notes this month. Under LinkedIn's 300 characters.
function noteFor(first, senderName) {
  const hi = first ? "Hi " + first + ", " : "Hi, ";
  return (hi + "I work with restoration companies across the US and Canada on staffing support. "
    + "Would be glad to connect." + (senderName ? " – " + senderName : "")).slice(0, 300);
}

// ── Schema ──────────────────────────────────────────────────────────
async function ensureProspectingSchema() {
  if (!dbOn) return;
  await q("alter table linkedin_account add column if not exists prospect_on boolean not null default true");
  await q("alter table linkedin_account add column if not exists prospect_cursor int not null default 0");
  await q("alter table linkedin_account add column if not exists prospect_day date");
  await q("alter table linkedin_account add column if not exists prospect_runs int not null default 0");
  await q("alter table linkedin_account add column if not exists prospect_found int not null default 0");
  await q("alter table linkedin_account add column if not exists prospect_last timestamptz");
  await q("alter table linkedin_account add column if not exists note_out_month text");
  await q("alter table linkedin_account add column if not exists sender_id text");
  await q("alter table linkedin_account add column if not exists search_out_month text");
  await q("alter table outreach_queue add column if not exists auto_found boolean not null default false");
  await q("alter table outreach_queue add column if not exists note_optional boolean not null default false");
}

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);
const sameDay = (d) => !!d && new Date(d).toISOString().slice(0, 10) === today();

// ── 1. Should this account search now? ──────────────────────────────
async function nextSearch(userId, acct, limits) {
  if (!ON || !dbOn || !acct || !acct.prospect_on || acct.dry_run) return null;
  if (acct.search_out_month === thisMonth()) return null;   // LinkedIn's monthly search limit was hit
  const runs = sameDay(acct.prospect_day) ? acct.prospect_runs || 0 : 0;
  if (runs >= SEARCHES_PER_DAY) return null;
  if (acct.prospect_last && Date.now() - new Date(acct.prospect_last).getTime() < SEARCH_GAP_MIN * 60000) return null;
  // Enough invitations already waiting to go from this account: no need to look for more yet.
  const { rows } = await q(
    `select count(*)::int as n from outreach_queue
      where user_id = $1 and li_account_id = $2 and channel = 'linkedin' and action = 'invite'
        and status in ('approved', 'sending')`, [userId, acct.id]);
  if ((rows[0] && rows[0].n) >= (limits && limits.invitesPerDay ? limits.invitesPerDay : 15)) return null;
  const cursor = Math.max(0, acct.prospect_cursor || 0) % SPECS.length;
  const spec = SPECS[cursor];
  return { url: searchUrl(spec), cursor, label: spec.title + " · " + spec.trade + (spec.page > 1 ? " · page " + spec.page : "") };
}

// ── 3. What the worker saw on the search page ───────────────────────
async function recordProspects(userId, acct, { cursor, candidates, halt, limit } = {}) {
  if (!dbOn) return { seen: 0, queued: 0 };
  if (limit) {
    await q("update linkedin_account set search_out_month = $2, prospect_last = now(), updated_at = now() where id = $1", [acct.id, thisMonth()]);
    return { seen: 0, queued: 0, limit: true };
  }
  const list = (Array.isArray(candidates) ? candidates : []).slice(0, 25).map((c) => ({
    handle: handleOf("linkedin.com/in/" + String(c && c.handle || "")),
    name: String(c && c.name || "").trim().slice(0, 120),
    headline: String(c && c.headline || "").trim().slice(0, 300),
    location: String(c && c.location || "").trim().slice(0, 120),
    degree: String(c && c.degree || "").slice(0, 4),
  }));
  // The search counts against today's searches whatever it found; the next one moves on.
  const runsToday = sameDay(acct.prospect_day) ? acct.prospect_runs || 0 : 0;
  await q(
    `update linkedin_account set prospect_cursor = $2, prospect_day = $3, prospect_runs = $4, prospect_last = now(),
            prospect_found = case when prospect_day = $3::date then prospect_found else 0 end, updated_at = now()
      where id = $1`,
    [acct.id, ((Number.isInteger(cursor) ? cursor : acct.prospect_cursor || 0) + 1) % SPECS.length, today(), runsToday + 1]);
  if (halt) return { seen: list.length, queued: 0 };

  const keep = [];
  const skipped = {};
  for (const c of list) {
    const why = skipReason(c);
    if (why) skipped[why] = (skipped[why] || 0) + 1;
    else if (!keep.some((k) => k.handle === c.handle)) keep.push(c);
  }
  if (!keep.length) return { seen: list.length, queued: 0, skipped };

  // Nobody on the team has contacted them, or saved them as a lead.
  const handles = keep.map((c) => c.handle);
  const { rows: seen } = await q(
    `select lower(substring(linkedin_url from '/in/([^/?#]+)')) as h from outreach_queue
      where channel = 'linkedin' and lower(substring(linkedin_url from '/in/([^/?#]+)')) = any($1)
     union
     select lower(substring(data->'prospect'->>'linkedinUrl' from '/in/([^/?#]+)')) from prospects
      where lower(substring(data->'prospect'->>'linkedinUrl' from '/in/([^/?#]+)')) = any($1)`, [handles]);
  const known = new Set(seen.map((r) => r.h));
  const fresh = keep.filter((c) => !known.has(c.handle)).slice(0, PER_SEARCH);
  if (fresh.length < keep.length) skipped["already contacted or saved"] = keep.length - fresh.length;

  const senderName = await senderNameFor(acct);
  const withNote = acct.note_out_month !== thisMonth();
  let queued = 0;
  for (const c of fresh) {
    const [first, ...rest] = c.name.split(/\s+/);
    const hl = splitHeadline(c.headline);
    const url = "https://www.linkedin.com/in/" + encodeURIComponent(c.handle) + "/";
    const id = crypto.randomUUID();
    const prospect = { firstName: first || "", lastName: rest.join(" "), title: hl.title, company: hl.company,
      headline: c.headline, location: c.location, linkedinUrl: url, industry: "Property Restoration",
      context: "Found by the LinkedIn agent: a decision-maker at a restoration company." };
    const label = c.name;
    const sub = [hl.title, hl.company].filter(Boolean).join(" · ");
    await q(
      `insert into prospects (id, user_id, label, sub, status, data) values ($1,$2,$3,$4,'new',$5)`,
      [id, userId, label, sub, { prospect, sender: acct.sender_id || null, source: "li-agent" }]);
    logActivity(userId, "lead_added", { prospectId: id, label, detail: "li_agent_found" });
    const note = withNote ? noteFor(first, senderName) : "";
    await q(
      `insert into outreach_queue (user_id, prospect_id, lead_label, channel, step, body, linkedin_url, status,
          scheduled_at, approved_by, approved_at, action, li_account_id, prospect_title, prospect_company, auto_found, note_optional)
       values ($1,$2,$3,'linkedin','connection',$4,$5,'approved', now(), 'LinkedIn agent (automatic)', now(), 'invite', $6, $7, $8, true, true)`,
      [userId, id, label, note, url, acct.id, hl.title || null, hl.company || null]);
    queued++;
  }
  if (queued) {
    await q(`update linkedin_account set prospect_found = prospect_found + $2, updated_at = now() where id = $1`, [acct.id, queued]);
    logActivity(userId, "outreach_queued", { label: queued + " found by the LinkedIn agent", detail: "linkedin_invite_auto" });
  }
  return { seen: list.length, queued, skipped };
}

// Who the AI writes as for this account: its own pick, else a sender whose name matches the
// LinkedIn it's signed in to. The note's sign-off uses their first name.
async function senderNameFor(acct) {
  const { SENDERS } = loadSenders();
  const byId = SENDERS.find((s) => s.id === acct.sender_id);
  if (byId) return byId.name.split(" ")[0];
  const li = acct.worker && acct.worker.linkedin && acct.worker.linkedin.name;
  return li ? String(li).split(" ")[0] : "";
}
let senders = null;
function loadSenders() {
  if (senders) return senders;
  // The sender list lives in src/lib/senders.js (an ES module); the server's bundle carries it.
  try { senders = { SENDERS: require("./gen/prep.cjs").SENDERS || [] }; } catch (e) { senders = { SENDERS: [] }; }
  return senders;
}

// The invitation couldn't carry a note (LinkedIn's free monthly allowance is used up): no more
// notes from this account until next month.
async function notesUsedUp(acctId) {
  if (!dbOn || !acctId) return;
  await q("update linkedin_account set note_out_month = $2, updated_at = now() where id = $1", [acctId, thisMonth()]);
  await q(`update outreach_queue set body = '', updated_at = now()
            where li_account_id = $1 and auto_found and note_optional and action = 'invite' and status = 'approved'`, [acctId]);
}

// For the status card.
function statusFields(a) {
  const day = sameDay(a.prospect_day);
  return {
    prospectOn: ON && !!a.prospect_on,
    prospecting: ON,
    foundToday: day ? a.prospect_found || 0 : 0,
    searchesToday: day ? a.prospect_runs || 0 : 0,
    searchesPerDay: SEARCHES_PER_DAY,
    notesLeft: a.note_out_month !== thisMonth(),
    searchLimitHit: a.search_out_month === thisMonth(),
    senderId: a.sender_id || null,
  };
}

module.exports = {
  ensureProspectingSchema, nextSearch, recordProspects, notesUsedUp, statusFields,
  skipReason, splitHeadline, searchUrl, noteFor, SPECS, ON,
};
