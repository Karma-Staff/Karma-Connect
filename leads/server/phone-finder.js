"use strict";
/* Automatic phone lookup for leads without a phone — Companies, People, Job board.

   Job boards hand over a company's name, town and often its website — never a
   phone, so most Job board leads couldn't be called. This sweeper looks for
   one by itself, a few leads at a time, cheapest and surest first:

     1. company — a job posting whose company (company_lead_id) has a phone
     2. donor   — a company we already hold with the same website, or the same
                  name and city, all agreeing on one number (enrich.js — the
                  franchise-safe match the scrape already uses)
     3. website — the company's own site: its homepage and contact page, a
                  tel: link first, else the number printed most often (a fax
                  number is skipped)
     4. maps    — Google Maps (Apify), one run per round, capped per day; a place
                  is used only when its name and town plainly match the lead
     5. web     — a web search, capped per day because each costs money. The
                  answer is only kept when the number is in the text of the
                  page the search cites: a number the model merely "knows"
                  is never written to a lead.

   It never writes a number on the Do Not Contact list, never touches a lead
   that is in Zoho, removed or binned, and only ever fills a blank phone. A
   lead with nothing to find is tried again after RETRY_DAYS, not every round.
   Each phone found is logged on the lead with where it came from.

   ENRICH_PHONES=0 turns it off; ENRICH_WEB_PER_DAY caps the web searches
   (0 = never search). */

const express = require("express");
const dns = require("dns").promises;
const net = require("net");
const { query } = require("./db");
const { requireUser, requireAdmin } = require("./auth");
const activity = require("./activity");
const settings = require("./settings");
const { pk } = require("./dedupe");
const { findPhoneDonor, domainOf } = require("./enrich");
// leads under Contacted (in Zoho, or worked through it) are not looked up
const { listedContactedSql } = require("./zoho-scan");

const router = express.Router();

const ON = process.env.ENRICH_PHONES !== "0";
const EVERY_MIN = Math.max(2, +process.env.ENRICH_EVERY_MIN || 10);
const PER_ROUND = Math.max(1, Math.min(50, +process.env.ENRICH_PER_ROUND || 15));
const WEB_PER_DAY = Math.max(0, +(process.env.ENRICH_WEB_PER_DAY ?? 100));
const RETRY_DAYS = Math.max(1, +process.env.ENRICH_RETRY_DAYS || 14);
const MODEL = process.env.ENRICH_MODEL || "claude-haiku-4-5";
const STATE = "phone.finder";

const fmt = (k) => `(${k.slice(0, 3)}) ${k.slice(3, 6)}-${k.slice(6)}`;
const str = (v) => String(v == null ? "" : v).trim();

/* ---------------- fetching a company's page, safely ----------------
   The website comes from a scraped job board, so it is untrusted: only
   http(s) on the normal ports, never an address inside a private network
   (the server must not be talked into reading its own infrastructure),
   a few redirects at most, each re-checked, a short timeout and a size cap. */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const s = ip.toLowerCase();
  if (s === "::1" || s === "::") return true;
  if (s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80")) return true;
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return m ? isPrivateIp(m[1]) : false;
}

async function publicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  if (u.port && !["80", "443"].includes(u.port)) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return null;
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) return null;
  return u;
}

async function fetchPage(raw, { timeoutMs = 8000, maxBytes = 800_000 } = {}) {
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await publicUrl(url);
    if (!u) return null;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(u, { redirect: "manual", signal: ctl.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; KarmaConnect/1.0; +https://karmastaff.com)", Accept: "text/html" } });
    } catch { clearTimeout(t); return null; }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      clearTimeout(t);
      url = new URL(res.headers.get("location"), u).toString();
      continue;
    }
    if (!res.ok || !/text\/html|text\/plain/i.test(res.headers.get("content-type") || "")) { clearTimeout(t); return null; }
    try {
      const reader = res.body.getReader();
      const chunks = []; let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length; chunks.push(value);
        if (n > maxBytes) { ctl.abort(); break; }
      }
      clearTimeout(t);
      return { url: u.toString(), html: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8") };
    } catch { clearTimeout(t); return null; }
  }
  return null;
}

/* ---------------- reading phone numbers off a page ---------------- */
const PHONE_RE = /(?:\+?1[\s.\-]?)?\(?\b([2-9]\d{2})\)?[\s.\-]?([2-9]\d{2})[\s.\-]?(\d{4})\b/g;

// [{ key, n, tel }] — every bannable-valid number on the page, tel: links marked
function phonesFromHtml(html) {
  const found = new Map();
  const add = (key, tel) => {
    if (!key) return;
    const e = found.get(key) || { key, n: 0, tel: false };
    e.n++; if (tel) e.tel = true;
    found.set(key, e);
  };
  for (const m of String(html).matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) add(pk(m[1]), true);
  const text = String(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  for (const m of text.matchAll(PHONE_RE)) {
    const before = text.slice(Math.max(0, m.index - 18), m.index).toLowerCase();
    if (/fax|f:\s*$|facsimile/.test(before)) continue;   // a fax line isn't the number to ring
    add(pk(m[1] + m[2] + m[3]), false);
  }
  return [...found.values()];
}

// the company's number: a tel: link beats printed text; then the one printed most
function bestPhone(list) {
  if (!list.length) return null;
  return [...list].sort((a, b) => (b.tel - a.tel) || (b.n - a.n))[0].key;
}

async function fromWebsite(website) {
  const dom = domainOf(website);
  if (!dom) return null;
  const base = /^https?:\/\//i.test(str(website)) ? str(website) : "https://" + dom;
  const pages = [base, "https://" + dom + "/contact", "https://" + dom + "/contact-us"];
  const all = [];
  let src = null;
  for (const p of pages) {
    const page = await fetchPage(p);
    if (!page) continue;
    const got = phonesFromHtml(page.html);
    if (got.length && !src) src = page.url;
    all.push(...got);
    if (got.some((g) => g.tel)) break;                    // a tel: link is as sure as it gets
  }
  const merged = new Map();
  for (const g of all) {
    const e = merged.get(g.key) || { key: g.key, n: 0, tel: false };
    e.n += g.n; e.tel = e.tel || g.tel; merged.set(g.key, e);
  }
  const key = bestPhone([...merged.values()]);
  return key ? { key, source: src } : null;
}

/* ---------------- the web search, verified ---------------- */
const SEARCH_SYSTEM = `You find a business's main phone number on the public web.
Search for the company described, find its official website or a reliable business listing, and read the phone number from that page.
Reply with ONLY a JSON object: {"phone": "(555) 555-5555", "source_url": "https://..."} — or {"phone": null} if you did not see one on a page.
Never guess, never reconstruct a number, never give a number for a different branch or company. A fax number is not the phone.`;

const digitsIn = (s) => String(s || "").replace(/\D/g, "");
// the number must appear, as digits, in text the search actually returned
function verifiedByCitations(key, content) {
  for (const block of content || []) {
    for (const c of block.citations || []) if (digitsIn(c.cited_text).includes(key)) return c.url || true;
  }
  return null;
}

async function fromWebSearch(lead) {
  const { handleClaude } = require("../../api/_proxy.cjs");
  const who = [str(lead.company) || str(lead.name), [str(lead.city), str(lead.state)].filter(Boolean).join(", "), str(lead.website)]
    .filter(Boolean).join(" — ");
  const body = JSON.stringify({
    model: MODEL, max_tokens: 600,
    system: [{ type: "text", text: SEARCH_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "Company: " + who + "\nIndustry: " + (str(lead.industry) || "restoration / construction") }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
  });
  const out = await handleClaude({ method: "POST", bodyString: body, authHeader: "", identity: null }, { requireAuth: false, recordUsage: false });
  if (out.status !== 200) return null;
  const data = JSON.parse(out.body);
  const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  let ans = null;
  try { ans = JSON.parse((text.match(/\{[\s\S]*\}/) || ["null"])[0]); } catch { ans = null; }
  const key = ans && ans.phone ? pk(ans.phone) : null;
  if (!key) return null;
  // kept only if it's in what the search returned, or on the page it names
  const cited = verifiedByCitations(key, data.content);
  if (cited) return { key, source: typeof cited === "string" ? cited : ans.source_url || null };
  if (ans.source_url) {
    const page = await fetchPage(ans.source_url);
    if (page && phonesFromHtml(page.html).some((p) => p.key === key)) return { key, source: page.url };
  }
  return null;
}

/* ---------------- Google Maps ----------------
   One Apify run for a batch of leads: each search is "<company>, <city>, <state>"
   with one place back. A place is only used when it is plainly this business —
   every distinctive word of one name is in the other (so "SERVPRO of North
   Tampa" never gives its number to "SERVPRO of South Tampa") and its town
   agrees with the lead's. Capped per day (MAPS_PER_DAY) and per run
   (maxTotalChargeUsd), because each place is billed. */
const MAPS_ACTOR = "compass~crawler-google-places";
const MAPS_PER_DAY = Math.max(0, +(process.env.ENRICH_MAPS_PER_DAY ?? 500));
const MAPS_PLACE_USD = 0.005;      // the actor's price per place, rounded up, for the run's charge cap

const NOISE = new Set(["inc", "llc", "ltd", "co", "corp", "corporation", "company", "the", "and", "of", "pllc", "lp", "llp", "group"]);
const words = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/&/g, " and ")
  .replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w && !NOISE.has(w));
function sameBusiness(a, b) {
  const A = words(a), B = words(b);
  if (!A.length || !B.length) return false;
  const inB = A.every((w) => B.includes(w)), inA = B.every((w) => A.includes(w));
  // the shorter name entirely inside the longer, and a real word in common
  return (inB || inA) && A.some((w) => w.length >= 3 && B.includes(w));
}
const place = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
const ST = { alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca", colorado: "co", connecticut: "ct", delaware: "de",
  florida: "fl", georgia: "ga", hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia", kansas: "ks", kentucky: "ky",
  louisiana: "la", maine: "me", maryland: "md", massachusetts: "ma", michigan: "mi", minnesota: "mn", mississippi: "ms", missouri: "mo",
  montana: "mt", nebraska: "ne", nevada: "nv", newhampshire: "nh", newjersey: "nj", newmexico: "nm", newyork: "ny", northcarolina: "nc",
  northdakota: "nd", ohio: "oh", oklahoma: "ok", oregon: "or", pennsylvania: "pa", rhodeisland: "ri", southcarolina: "sc", southdakota: "sd",
  tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt", virginia: "va", washington: "wa", westvirginia: "wv", wisconsin: "wi", wyoming: "wy",
  districtofcolumbia: "dc", ontario: "on", quebec: "qc", britishcolumbia: "bc", alberta: "ab", manitoba: "mb", saskatchewan: "sk",
  novascotia: "ns", newbrunswick: "nb", newfoundlandandlabrador: "nl", princeedwardisland: "pe" };
const stOf = (s) => { const p = place(s); return p.length === 2 ? p : ST[p] || p; };
function sameTown(lead, item) {
  if (str(lead.city) && str(item.city)) return place(lead.city) === place(item.city);
  if (str(lead.state) && str(item.state)) return stOf(lead.state) === stOf(item.state);
  return false;    // nothing to compare: not sure enough to ring it
}
const mapsName = (lead) => str(lead.kind === "person" ? lead.company : lead.company || lead.name);
const mapsQuery = (lead) => [mapsName(lead), str(lead.city), str(lead.state)].filter(Boolean).join(", ");

// leads → Map(lead.id → { key, source }) for the ones Google Maps plainly matched
async function fromMaps(leads) {
  const out = new Map();
  const ask = leads.filter((l) => mapsName(l) && (str(l.city) || str(l.state)));
  if (!ask.length) return out;
  const byQuery = new Map(ask.map((l) => [mapsQuery(l), l]));
  const { apify } = require("./apify");
  const items = await apify(
    `/acts/${MAPS_ACTOR}/run-sync-get-dataset-items?timeout=280&format=json&clean=true`
    + `&maxTotalChargeUsd=${(byQuery.size * MAPS_PLACE_USD + 0.01).toFixed(2)}`,
    { method: "POST", body: JSON.stringify({ searchStringsArray: [...byQuery.keys()], maxCrawledPlacesPerSearch: 1, language: "en" }) });
  for (const it of Array.isArray(items) ? items : []) {
    const lead = byQuery.get(str(it.searchString));
    if (!lead || out.has(lead.id) || it.permanentlyClosed) continue;
    const key = pk(it.phoneUnformatted || it.phone);
    if (!key || !sameBusiness(mapsName(lead), it.title) || !sameTown(lead, it)) continue;
    out.set(lead.id, { key, source: it.url || "Google Maps: " + it.title });
  }
  return out;
}

/* ---------------- one lead ---------------- */
const banned = async (key) => (await query("SELECT 1 FROM blocklist WHERE phone_key = $1", [key])).rowCount > 0;

// today's paid lookups (web searches, Google Maps places), kept in app_settings
async function budget() {
  const today = new Date().toISOString().slice(0, 10);
  const st = await settings.get(STATE, {});
  const same = st.day === today;
  const webUsed = same ? st.webUsed || 0 : 0, mapsUsed = same ? st.mapsUsed || 0 : 0;
  return { today, st: same ? st : { day: today }, webUsed, mapsUsed,
    webLeft: Math.max(0, WEB_PER_DAY - webUsed), mapsLeft: Math.max(0, MAPS_PER_DAY - mapsUsed) };
}
async function spend(field, n = 1) {
  const b = await budget();
  await settings.set(STATE, { ...b.st, day: b.today, [field]: (b[field] || 0) + n }, "phone-finder").catch(() => {});
}
const webBudget = async () => { const b = await budget(); return { used: b.webUsed, left: b.webLeft }; };
const spendWeb = () => spend("webUsed");

// the free steps: its company, a company we hold, its own website
async function findFree(lead) {
  if (lead.kind === "job" && lead.company_phone_key) return { key: lead.company_phone_key, how: "company", source: "company #" + lead.company_lead_id };
  // a person's company line is only looked up by company — never matched to a company by a person's name
  const coName = lead.kind === "person" ? str(lead.company) : str(lead.company) || str(lead.name);
  if (!coName && !(lead.website || lead.company_website)) return null;
  const co = { id: lead.id, name: coName, website: lead.website || lead.company_website, city: lead.city, state: lead.state };
  if (coName) {
    const donor = await findPhoneDonor(query, co).catch(() => null);
    if (donor && donor.donor && donor.donor.phone_key) return { key: donor.donor.phone_key, how: "donor", source: "lead #" + donor.donor.id };
  }
  if (co.website) {
    const w = await fromWebsite(co.website).catch(() => null);
    if (w) return { key: w.key, how: "website", source: w.source };
  }
  return null;
}

// one lead through every step — the free ones, then a web search when allowed (kept for tests)
async function findFor(lead, { allowWeb }) {
  const free = await findFree(lead);
  if (free) return free;
  if (allowWeb) {
    await spendWeb();
    const s = await fromWebSearch(lead).catch(() => null);
    if (s) return { key: s.key, how: "web", source: s.source };
  }
  return null;
}

const WORDS = { company: "from its company", donor: "from a matching company already in Karma Connect",
  website: "from the company's website", maps: "from Google Maps", web: "from a web search" };

async function save(lead, hit) {
  if (await banned(hit.key)) return false;     // a DNC number never comes back through here
  const phone = fmt(hit.key);
  const r = await query(
    `UPDATE leads SET phone = $2, phone_key = $3, phone_enrich_at = now(), phone_enrich_source = $4, updated_at = now()
      WHERE id = $1 AND nullif(btrim(phone), '') IS NULL RETURNING id, lead_code, name`,
    [lead.id, phone, hit.key, hit.how]);
  if (!r.rowCount) return false;
  // a company's postings get it too
  if (lead.kind === "company")
    await query(`UPDATE leads SET phone = $2, phone_key = $3, phone_enrich_at = now(), phone_enrich_source = 'company', updated_at = now()
                  WHERE kind = 'job' AND company_lead_id = $1 AND deleted_at IS NULL AND NOT removed AND nullif(btrim(phone), '') IS NULL`,
      [lead.id, phone, hit.key]);
  const what = lead.kind === "person" ? " (their company's line)" : "";
  await activity.log({ actor: "phone-finder", action: "enrich", lead_id: lead.id, lead_code: r.rows[0].lead_code, lead_name: r.rows[0].name,
    to_value: `Phone found ${WORDS[hit.how] || ""}: ${phone}${what}`.replace(/\s+/g, " ").trim(), meta: { auto_phone: hit.how, source: hit.source || null } }).catch(() => {});
  return true;
}

/* ---------------- the sweep ----------------
   Every lead without a phone in Companies, People and the Job board — not in
   Zoho or already contacted through it (those are under Contacted), not
   removed or binned. Companies first, so a posting gets its company's phone. */
const where = `
   WHERE l.deleted_at IS NULL AND NOT l.removed AND nullif(btrim(l.phone), '') IS NULL
     AND l.kind IN ('company', 'person', 'job')
     AND (nullif(btrim(l.company), '') IS NOT NULL OR nullif(btrim(l.name), '') IS NOT NULL)
     AND NOT ${listedContactedSql("l")}`;
const queueSql = (n) => `
  SELECT l.id, l.kind, l.name, l.company, l.website, l.city, l.state, l.industry, l.company_lead_id,
         c.phone_key AS company_phone_key, c.website AS company_website
    FROM leads l LEFT JOIN leads c ON c.id = l.company_lead_id AND c.deleted_at IS NULL AND NOT c.removed
  ${where}
     AND (l.phone_enrich_at IS NULL OR l.phone_enrich_at < now() - make_interval(days => ${RETRY_DAYS}))
   ORDER BY l.phone_enrich_at NULLS FIRST,
            CASE l.kind WHEN 'company' THEN 0 WHEN 'job' THEN 1 ELSE 2 END, l.date_added DESC NULLS LAST, l.id DESC
   LIMIT ${Math.max(1, Math.min(100, n))}`;

let running = null;
async function round(size = PER_ROUND) {
  if (running) return running;
  running = (async () => {
    const leads = (await query(queueSql(size))).rows;
    const by = { company: 0, donor: 0, website: 0, maps: 0, web: 0, none: 0 };
    const left = [];
    // 1. the free steps, lead by lead
    for (const lead of leads) {
      // tried now, whatever happens: the next round moves on to others. A posting
      // whose company was filled a moment ago in this round already has its phone.
      const cur = (await query(
        "UPDATE leads SET phone_enrich_at = now() WHERE id = $1 RETURNING nullif(btrim(phone), '') IS NULL AS blank", [lead.id])).rows[0];
      if (!cur || !cur.blank) continue;
      const hit = await findFree(lead);
      if (hit && (await save(lead, hit))) by[hit.how]++;
      else left.push(lead);
    }
    // 2. Google Maps, one run for the rest (within today's cap)
    let rest = left;
    const b = await budget();
    if (rest.length && b.mapsLeft > 0) {
      const ask = rest.filter((l) => mapsName(l) && (str(l.city) || str(l.state))).slice(0, b.mapsLeft);
      if (ask.length) {
        await spend("mapsUsed", ask.length);
        const found = await fromMaps(ask).catch((e) => { console.warn("[karma] phone finder: Google Maps:", e.message); return new Map(); });
        rest = [];
        for (const lead of left) {
          const m = found.get(lead.id);
          if (m && (await save(lead, { ...m, how: "maps" }))) by.maps++;
          else rest.push(lead);
        }
      }
    }
    // 3. a web search for what's still missing (within today's cap)
    for (const lead of rest) {
      const { left: webLeft } = await webBudget();
      if (webLeft <= 0) { by.none++; continue; }
      await spendWeb();
      const s = await fromWebSearch(lead).catch(() => null);
      if (s && (await save(lead, { key: s.key, how: "web", source: s.source }))) by.web++;
      else by.none++;
    }
    const found = by.company + by.donor + by.website + by.maps + by.web;
    if (found) console.log(`[karma] phone finder: ${found} of ${leads.length} found`, by);
    return { tried: leads.length, found, ...by };
  })().finally(() => { running = null; });
  return running;
}

async function status() {
  const r = (await query(`
    SELECT count(*)::int AS missing,
           count(*) FILTER (WHERE l.kind = 'company')::int AS missing_companies,
           count(*) FILTER (WHERE l.kind = 'person')::int AS missing_people,
           count(*) FILTER (WHERE l.kind = 'job')::int AS missing_jobs
      FROM leads l ${where}`)).rows[0];
  const f = (await query(`
    SELECT count(*) FILTER (WHERE phone_enrich_at > now() - interval '24 hours')::int AS today, count(*)::int AS total
      FROM leads WHERE phone_enrich_source IS NOT NULL AND deleted_at IS NULL`)).rows[0];
  const b = await budget();
  return { on: ON, missing: r.missing, missingCompanies: r.missing_companies, missingPeople: r.missing_people, missingJobs: r.missing_jobs,
    foundToday: f.today, foundTotal: f.total, webUsedToday: b.webUsed, webPerDay: WEB_PER_DAY,
    mapsUsedToday: b.mapsUsed, mapsPerDay: MAPS_PER_DAY, everyMin: EVERY_MIN, busy: !!running };
}

router.get("/api/phone-finder/status", requireUser, async (req, res, next) => {
  try { res.json(await status()); } catch (e) { next(e); }
});
// run a round now (admin) — the timer's round, or a bigger one (up to 100 leads) for a backlog
router.post("/api/phone-finder/run", requireAdmin, express.json({ limit: "1kb" }), async (req, res, next) => {
  try {
    if (!ON) return res.status(400).json({ error: "The phone finder is turned off (ENRICH_PHONES=0)." });
    const size = Math.max(1, Math.min(100, parseInt(req.body && req.body.size, 10) || PER_ROUND));
    const r = await round(size);
    res.json({ ...r, status: await status() });
  } catch (e) { next(e); }
});

let timer = null;
function startSweeper() {
  if (timer || !ON) return;
  if (process.env.KARMA_NO_SWEEP === "1") return;
  timer = setInterval(() => { round().catch((e) => console.error("[karma] phone finder:", e.message)); }, EVERY_MIN * 60000);
  timer.unref();
  console.log(`Phone finder on: leads without a phone, ${PER_ROUND} every ${EVERY_MIN} min (Google Maps ${MAPS_PER_DAY}/day, web searches ${WEB_PER_DAY}/day).`);
}

module.exports = { router, startSweeper, round, status,
  _test: { phonesFromHtml, bestPhone, isPrivateIp, publicUrl, verifiedByCitations, fmt, findFor, sameBusiness, sameTown, mapsQuery } };
