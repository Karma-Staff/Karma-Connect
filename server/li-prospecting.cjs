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

// ── The searches ────────────────────────────────────────────────────
// Each search is one title group (the "Title" filter: it matches the person's current job title)
// crossed with one trade group (the keywords: matched anywhere on the profile). Boolean syntax is
// LinkedIn's own — uppercase OR / NOT, quoted phrases, parentheses — and works on a regular account.
// The owner's choice: owners and top leaders first, then operations leaders. Highest yield first.
const TITLES = [
  { name: "owners", q: 'owner OR "co-owner" OR proprietor OR franchisee' },
  { name: "presidents", q: 'president OR CEO OR "chief executive" OR chairman', not: 'NOT "vice president"' },
  { name: "founders", q: 'founder OR "co-founder" OR "managing partner" OR "managing member" OR principal' },
  { name: "general managers", q: '"general manager" OR "managing director" OR COO OR "chief operating officer"' },
  { name: "operations leaders", q: '"director of operations" OR "operations director" OR "vp operations" OR "vp of operations" OR "vice president of operations" OR "head of operations" OR "operations manager" OR "branch manager" OR "regional manager"' },
];
// Titles nobody wants, taken out at the search so they don't use up the page. Only words that are
// never in an owner's title: the headline filters below do the finer sorting.
const NOT_TITLES = "NOT adjuster NOT recruiter NOT technician NOT estimator NOT sales";
// The words restoration companies really use, and the big franchise names. A keyword is matched
// anywhere on the profile, so each group is kept short and specific.
const TRADES = [
  { name: "restoration", q: "restoration" },
  { name: "water, fire & mold", q: '"water damage" OR "fire damage" OR "mold remediation"' },
  { name: "mitigation", q: "mitigation OR remediation OR reconstruction" },
  { name: "franchises", q: 'SERVPRO OR PuroClean OR "Paul Davis" OR BELFOR OR ServiceMaster OR "Rainbow Restoration"' },
  { name: "franchises 2", q: '"911 Restoration" OR DKI OR "First Onsite" OR "Restoration 1" OR Rytech OR BluSky OR "ATI Restoration" OR Steamatic' },
];
const PAGES = 3;           // pages of each search; all first pages before any second page

// Every search, in the order they're worked through: page × title × trade (75 in all).
// The cursor an account already has is taken modulo this length, so the length can change.
const SPECS = [];
for (let p = 1; p <= PAGES; p++) for (const t of TITLES) for (const k of TRADES) {
  SPECS.push({ title: t.name, trade: k.name, page: p, titleQ: "(" + t.q + ") " + [t.not, NOT_TITLES].filter(Boolean).join(" "), tradeQ: k.q });
}

function searchUrl(spec) {
  const u = new URL("https://www.linkedin.com/search/results/people/");
  u.searchParams.set("keywords", spec.tradeQ || spec.trade);
  u.searchParams.set("titleFreeText", spec.titleQ || "(" + spec.title + ") " + NOT_TITLES);
  u.searchParams.set("geoUrn", JSON.stringify([GEO.us, GEO.ca]));
  u.searchParams.set("network", JSON.stringify(["S", "O"]));   // 2nd and 3rd+: never people already connected
  u.searchParams.set("origin", "FACETED_SEARCH");
  if (spec.page > 1) u.searchParams.set("page", String(spec.page));
  return u.toString();
}

// ── Who counts ──────────────────────────────────────────────────────
// Owner-level: the people who decide. A second role beside it ("Owner & Estimator") doesn't
// matter — a small company's owner does a bit of everything. "Vice President" is not a president,
// "Product Owner" is not an owner, "HR Business Partner" is not a partner.
const TOP = /\b(?:(?<!product |process |service )owner|co-?owner|proprietor|founder|co-?founder|founding partner|(?<!vice[\s-])president|ceo|chief executive|chairman|chairwoman|chairperson|coo|chief operating|managing (?:partner|member|director|owner|principal)|franchisee)\b/i;
// Operations-level: counts only when it is their job, not a second word in a sales or office title.
const MID = /\b(?:(?<!business )partner|principal|general manager|gm|vp|svp|evp|vice[\s-]president|director of (?:field )?operations|operations director|director,? operations|director of ops|head of operations|operations (?:manager|lead|leader)|ops manager|branch manager|regional manager|area manager|district manager|division manager|market manager|location manager|regional director)\b/i;
// Roles that turn an operations-level headline into somebody else's job.
const ROLE = /\b(?:sales|marketing|business development|biz dev|bd|bdm|bdr|sdr|account (?:manager|executive|rep|representative|director)|project (?:manager|coordinator|director|management)|pm|estimator|estimating|technician|tech|crew (?:chief|lead|leader)|lead tech|supervisor|foreman|superintendent|dispatcher|admin|administrator|administrative|office manager|customer (?:service|success|care)|coordinator|recruiter|recruiting|human resources|hr|finance|accounting|controller|bookkeeper|safety|fleet|warehouse|quality|training|it manager|franchise (?:development|sales)|claims)\b/i;
// Nobody, whatever their title says: works for the leader, is still studying, or wants a job.
const HARD = /\b(?:assistant|intern|internship|student|trainee|apprentice|to the (?:owner|president|ceo|founder|gm|general manager)|seeking (?:a |new |my )?(?:employment|work|job|position|role|opportunit\w*|new)|looking for (?:work|a job|a new|my next|employment|opportunit\w*|position|role)|open to (?:work|new opportunit\w*|opportunit\w*)|opentowork|actively (?:looking|seeking|pursuing)|job search|unemployed|in transition|aspiring)\b|#opentowork/i;
// A part of the headline about a job they no longer have ("Former Owner…", "Retired").
const GONE = /\b(?:former|formerly|ex|fmr|past|retired|previous|previously|emeritus)\b/i;
// Sells to restoration companies, competes with Karma Staff, or sits on the insurance side.
const VENDOR = /\b(?:software|saas|crm|erp|tech (?:company|startup)|technology company|marketing (?:agency|firm|company|services|solutions)|digital marketing|lead ?gen(?:eration)?|seo|ppc|web ?(?:design|development)|advertising agency|ad agency|branding agency|consultant|consulting|coach|coaching|recruiter|recruitment|recruiting (?:agency|firm|company)|staffing|headhunt\w*|talent (?:acquisition|solutions|partner|agency)|outsourc\w*|virtual assistant|call center|answering service|equipment (?:rental|supplier|supply|sales|dealer|manufacturer|company|co)|supplier|supplies|distributor|manufactur\w*|dealer|third[- ]party administrator|tpa|insurance (?:agent|agency|broker|carrier|company|sales|producer)|agency owner|underwriter|adjuster|adjusting|public adjust\w*|claims (?:manager|specialist|examiner|rep|representative|professional|consultant|handler|director|supervisor|analyst|team)|appraiser|attorney|lawyer|law|legal|litigation|paralegal|realtor|real estate (?:agent|broker|brokerage)|franchise (?:consultant|broker)|business broker|broker|lender|lending|payroll|bookkeep\w*|accounting firm|cpa|training (?:company|provider|center|institute)|academy|nonprofit|non-profit)\b/i;
// The wrong kind of restoration: hair, cars, furniture, churches, wetlands, Restoration Hardware…
// Taken out of the headline before looking for a restoration company in what's left.
const WRONG_RESTORATION = /\b(?:(?:hair|auto|automotive|car|classic car|vehicle|motorcycle|boat|marine|furniture|antique|art|fine art|photo|film|data|dental|smile|tooth|teeth|ecolog\w*|ecosystem|habitat|wetland|stream|river|coral|reef|forest|prairie|land|masonry|stone|concrete|brick|facade|façade|window|wood|floor|hardwood|tile|bathtub|tub|leather|monument|historic\w*|heritage|headstone|cemetery|church|yoga|vision|hearing|jewelry|watch|piano|guitar|document|book|paper|sculpture|roof)\s+(?:(?:&|and)\s+)?(?:restor\w*|remediat\w*|reconstruct\w*)|restoration (?:hardware|church|ministr\w*|fellowship|community|yoga|wellness|health|medical|clinic|counseling|therapy|chiropractic|spa|salon|fitness|hair|dental|dentistry)|restorative|rh)\b/i;
// A restoration company by the headline. The search keyword alone isn't enough: LinkedIn matches
// it anywhere on the profile, including someone's job ten years ago.
const RESTORATION = /\b(?:restor\w*|mitigat\w*|remediat\w*|water (?:damage|removal|extraction|cleanup|clean-up|intrusion|loss)|fire (?:damage|& smoke|and smoke)|smoke damage|flood\w*|mold|mould|mildew|sewage|biohazard|large loss|disaster|catastroph\w*|reconstruct\w*|drying|dry ?out|dehumidif\w*|servpro|belfor|paul davis|puroclean|rainbow (?:international|restoration)|first ?onsite|blusky|dki|steamatic|chem-?dry|rytech|bms cat|cotton (?:global|commercial|gds)|service ?master|dry ?medic|insurcomm|duraclean|bio-?one)\b/i;

// ── Where they are ──────────────────────────────────────────────────
// The search is already limited to the US and Canada; this is the backstop for a card whose
// location names somewhere else. Metro names ("Dallas-Fort Worth Metroplex") name no country and pass.
const NORTH_AMERICA = /\b(?:united states|usa|u\.s\.a?\.?|canada|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|puerto rico|alberta|british columbia|manitoba|new brunswick|newfoundland|nova scotia|ontario|prince edward island|quebec|québec|saskatchewan|yukon|northwest territories|nunavut)\b/i;
const ELSEWHERE = /\b(?:united kingdom|uk|england|scotland|wales|ireland|australia|new zealand|india|pakistan|bangladesh|sri lanka|nepal|philippines|indonesia|malaysia|singapore|thailand|vietnam|japan|china|hong kong|taiwan|korea|nigeria|ghana|kenya|south africa|egypt|morocco|uganda|(?<!new )mexico|brazil|argentina|colombia|chile|peru|venezuela|ecuador|dominican republic|jamaica|trinidad|germany|france|spain|italy|portugal|netherlands|belgium|poland|sweden|norway|denmark|finland|switzerland|austria|greece|turkey|türkiye|israel|united arab emirates|uae|dubai|saudi arabia|qatar|kuwait|europe|asia|africa|middle east|latin america|south america|caribbean)\b/i;
const outsideNorthAmerica = (loc) => {
  const s = String(loc || "").trim();
  return !!s && !NORTH_AMERICA.test(s) && ELSEWHERE.test(s);
};

const handleOf = (url) => {
  const m = String(url || "").match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  if (!m) return "";
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch (e) { return m[1].toLowerCase(); }
};

// The parts of a headline: "Owner at Acme | Former Marine" → ["Owner at Acme", "Former Marine"]
const segments = (h) => String(h || "").split(/\s*[|·•;()]\s*|\s+[-–—]\s+|,\s+|\s+\/\s+/).map((s) => s.trim()).filter(Boolean);

// "Owner at Acme Restoration" / "President | Acme Restoration" / "President, Acme Restoration"
// → { title, company }
function splitHeadline(h) {
  const s = String(h || "").trim().replace(/\s+/g, " ");
  const at = s.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
  if (at) return { title: at[1].trim(), company: at[2].split(/\s[|·•,]\s|\s[-–—]\s/)[0].trim() };
  const bar = s.split(/\s[|·•]\s|\s[-–—]\s/);
  if (bar.length > 1) return { title: bar[0].trim(), company: bar[1].trim() };
  // "President, Acme Restoration & Construction": a comma, when what's before it is a title
  const comma = s.split(/,\s+/);
  if (comma.length > 1 && (TOP.test(comma[0]) || MID.test(comma[0]))) return { title: comma[0].trim(), company: comma[1].trim() };
  return { title: s, company: "" };
}

/* One search result → why it's skipped, or null when it's a prospect.
   c: { handle, name, headline, location, degree } as agent/prospect.cjs reads them. */
function skipReason(c) {
  if (!c || !c.handle) return "no profile link";
  const name = String(c.name || "").trim();
  if (!name || /linkedin member/i.test(name)) return "name hidden";
  if (c.degree === "1st") return "already a connection";
  if (outsideNorthAmerica(c.location)) return "outside the US and Canada";
  const h = String(c.headline || "").replace(/\s+/g, " ").trim();
  // Only the jobs they still have: "Former Owner at Acme | now consulting" has no live leader in it.
  const live = segments(h).filter((s) => !GONE.test(s)).join(" | ");
  if (HARD.test(live)) return "not a decision-maker";
  const top = TOP.test(live);
  if (!top && !MID.test(live)) return "not a decision-maker";
  if (!top && ROLE.test(live)) return "not a decision-maker";
  if (!RESTORATION.test(live.replace(WRONG_RESTORATION, " "))) return "not a restoration company";
  if (VENDOR.test(live)) return "sells to restoration companies";
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
async function nextSearch(userId, acct, limits, { ignoreGap = false } = {}) {
  if (!ON || !dbOn || !acct || !acct.prospect_on || acct.dry_run) return null;
  if (acct.search_out_month === thisMonth()) return null;   // LinkedIn's monthly search limit was hit
  const runs = sameDay(acct.prospect_day) ? acct.prospect_runs || 0 : 0;
  if (runs >= SEARCHES_PER_DAY) return null;
  if (!ignoreGap && acct.prospect_last && Date.now() - new Date(acct.prospect_last).getTime() < SEARCH_GAP_MIN * 60000) return null;
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
  let fresh = keep.filter((c) => !known.has(c.handle));
  if (fresh.length < keep.length) skipped["already contacted or saved"] = keep.length - fresh.length;
  /* Clients (the leads app's Clients list): nobody at a client company is
     invited. Best effort — if the list can't be read, nobody is invited this
     round rather than risk inviting a client. */
  let clientSet = null;
  try { clientSet = await require("../leads/server/clients").clientNames(fresh.map((c) => splitHeadline(c.headline).company)); }
  catch (e) { console.warn("[li-prospecting] clients list:", e.message); }
  if (!clientSet) return { seen: list.length, queued: 0, skipped: { ...skipped, "clients list unavailable": fresh.length } };
  const nk = require("../leads/server/clients").nameKey;
  const notClients = fresh.filter((c) => !clientSet.has(nk(splitHeadline(c.headline).company)));
  if (notClients.length < fresh.length) skipped["works at a client"] = fresh.length - notClients.length;
  fresh = notClients.slice(0, PER_SEARCH);

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
