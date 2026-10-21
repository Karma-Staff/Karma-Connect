"use strict";
/* Automatic phone lookup for the Job board.

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
     4. web     — a web search, capped per day because each costs money. The
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
const { inZohoSql } = require("./zoho-scan");

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

/* ---------------- one lead ---------------- */
const banned = async (key) => (await query("SELECT 1 FROM blocklist WHERE phone_key = $1", [key])).rowCount > 0;

async function webBudget() {
  const today = new Date().toISOString().slice(0, 10);
  const st = await settings.get(STATE, {});
  const used = st.day === today ? st.webUsed || 0 : 0;
  return { today, used, left: Math.max(0, WEB_PER_DAY - used), st };
}
async function spendWeb() {
  const b = await webBudget();
  await settings.set(STATE, { ...b.st, day: b.today, webUsed: b.used + 1 }, "phone-finder").catch(() => {});
}

async function findFor(lead, { allowWeb }) {
  // 1. its company has one
  if (lead.kind === "job" && lead.company_phone_key) return { key: lead.company_phone_key, how: "company", source: "company #" + lead.company_lead_id };
  // 2. a company we already hold
  const co = { id: lead.id, name: str(lead.company) || str(lead.name), website: lead.website || lead.company_website, city: lead.city, state: lead.state };
  const donor = await findPhoneDonor(query, co).catch(() => null);
  if (donor && donor.donor && donor.donor.phone_key) return { key: donor.donor.phone_key, how: "donor", source: "lead #" + donor.donor.id };
  // 3. its own website
  if (co.website) {
    const w = await fromWebsite(co.website).catch(() => null);
    if (w) return { key: w.key, how: "website", source: w.source };
  }
  // 4. a web search (capped)
  if (allowWeb) {
    await spendWeb();
    const s = await fromWebSearch(lead).catch(() => null);
    if (s) return { key: s.key, how: "web", source: s.source };
  }
  return null;
}

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
  const WORDS = { company: "from its company", donor: "from a matching company already in Karma Connect", website: "from the company's website", web: "from a web search" };
  await activity.log({ actor: "phone-finder", action: "enrich", lead_id: lead.id, lead_code: r.rows[0].lead_code, lead_name: r.rows[0].name,
    to_value: `Phone found ${WORDS[hit.how] || ""}: ${phone}`.trim(), meta: { auto_phone: hit.how, source: hit.source || null } }).catch(() => {});
  return true;
}

/* ---------------- the sweep ---------------- */
// Job board leads with no phone: job postings, and the companies the job search added
const QUEUE = `
  SELECT l.id, l.kind, l.name, l.company, l.website, l.city, l.state, l.industry, l.company_lead_id,
         c.phone_key AS company_phone_key, c.website AS company_website
    FROM leads l LEFT JOIN leads c ON c.id = l.company_lead_id AND c.deleted_at IS NULL AND NOT c.removed
   WHERE l.deleted_at IS NULL AND NOT l.removed AND nullif(btrim(l.phone), '') IS NULL
     AND (l.kind = 'job' OR (l.kind = 'company' AND l.source = 'Job board'))
     AND (nullif(btrim(l.company), '') IS NOT NULL OR nullif(btrim(l.name), '') IS NOT NULL)
     AND (l.phone_enrich_at IS NULL OR l.phone_enrich_at < now() - make_interval(days => ${RETRY_DAYS}))
     AND NOT ${inZohoSql("l")}
   -- companies first: a posting then gets its company's phone without a second look
   ORDER BY l.phone_enrich_at NULLS FIRST, (l.kind = 'company') DESC, l.date_added DESC NULLS LAST, l.id DESC
   LIMIT ${PER_ROUND}`;

let running = null;
async function round() {
  if (running) return running;
  running = (async () => {
    const leads = (await query(QUEUE)).rows;
    const by = { company: 0, donor: 0, website: 0, web: 0, none: 0 };
    for (const lead of leads) {
      // tried now, whatever happens: the next round moves on to others. A posting
      // whose company was filled a moment ago in this round already has its phone.
      const cur = (await query(
        "UPDATE leads SET phone_enrich_at = coalesce(phone_enrich_at, now()) WHERE id = $1 RETURNING nullif(btrim(phone), '') IS NULL AS blank",
        [lead.id])).rows[0];
      if (!cur || !cur.blank) continue;
      await query("UPDATE leads SET phone_enrich_at = now() WHERE id = $1", [lead.id]);
      const { left } = await webBudget();
      const hit = await findFor(lead, { allowWeb: left > 0 });
      if (hit && (await save(lead, hit))) by[hit.how]++;
      else by.none++;
    }
    const found = by.company + by.donor + by.website + by.web;
    if (found) console.log(`[karma] phone finder: ${found} of ${leads.length} found`, by);
    return { tried: leads.length, found, ...by };
  })().finally(() => { running = null; });
  return running;
}

async function status() {
  const r = (await query(`
    SELECT count(*) FILTER (WHERE nullif(btrim(phone), '') IS NULL)::int AS missing,
           count(*) FILTER (WHERE phone_enrich_source IS NOT NULL AND phone_enrich_at > now() - interval '24 hours')::int AS found_today,
           count(*) FILTER (WHERE phone_enrich_source IS NOT NULL)::int AS found_total
      FROM leads l
     WHERE l.deleted_at IS NULL AND NOT l.removed
       AND (l.kind = 'job' OR (l.kind = 'company' AND l.source = 'Job board'))
       AND NOT ${inZohoSql("l")}`)).rows[0];
  const b = await webBudget();
  return { on: ON, missing: r.missing, foundToday: r.found_today, foundTotal: r.found_total,
    webUsedToday: b.used, webPerDay: WEB_PER_DAY, everyMin: EVERY_MIN, busy: !!running };
}

router.get("/api/phone-finder/status", requireUser, async (req, res, next) => {
  try { res.json(await status()); } catch (e) { next(e); }
});
// run a round now (admin) — the same round the timer runs
router.post("/api/phone-finder/run", requireAdmin, async (req, res, next) => {
  try {
    if (!ON) return res.status(400).json({ error: "The phone finder is turned off (ENRICH_PHONES=0)." });
    const r = await round();
    res.json({ ...r, status: await status() });
  } catch (e) { next(e); }
});

let timer = null;
function startSweeper() {
  if (timer || !ON) return;
  if (process.env.KARMA_NO_SWEEP === "1") return;
  timer = setInterval(() => { round().catch((e) => console.error("[karma] phone finder:", e.message)); }, EVERY_MIN * 60000);
  timer.unref();
  console.log(`Phone finder on: Job board leads without a phone, ${PER_ROUND} every ${EVERY_MIN} min (web searches: ${WEB_PER_DAY}/day).`);
}

module.exports = { router, startSweeper, round, status,
  _test: { phonesFromHtml, bestPhone, isPrivateIp, publicUrl, verifiedByCitations, fmt, findFor } };
