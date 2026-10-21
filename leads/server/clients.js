"use strict";
/* Clients — the companies Karma Staff already works for. An admin uploads them
   (a spreadsheet) or adds one by hand, and from then on nobody calls them:

     - /api/calltime refuses to dial a client's number (every dial path asks it)
     - Companies, People, Job board and Recently added leave clients out
     - campaigns and call sessions skip them; the phone finder doesn't look them up
     - the LinkedIn agent doesn't invite people at a client company

   A lead is a client when it has the same phone number, the same email, or the
   same company name in the same state (or one of them has no state). Name
   alone would be risky — franchises share names — so the state has to agree. */

const express = require("express");
const { query } = require("./db");
const { requireUser, requireAdmin } = require("./auth");
const { pk } = require("./dedupe");
const activity = require("./activity");

const router = express.Router();
const MAX_ROWS = 20000;

const clean = (v) => String(v == null ? "" : v).trim();
/* A company name reduced to letters and digits, legal endings dropped:
   "Acme Restoration, Inc." and "ACME RESTORATION" are the same. nameKeySql
   below is the same rule in SQL — keep the two in step. */
const ENDINGS = "inc|llc|ltd|co|corp|corporation|company|the|pllc|lp|llp";
const nameKey = (s) => clean(s).toLowerCase().replace(new RegExp(`\\b(${ENDINGS})\\b`, "g"), "").replace(/[^a-z0-9]/g, "");
const nameKeySql = (expr) =>
  `regexp_replace(regexp_replace(lower(coalesce(${expr}, '')), '\\m(${ENDINGS})\\M', '', 'g'), '[^a-z0-9]', '', 'g')`;

// lazily: leads.js requires this file, so its STATE_NAME isn't there yet at load time
let STATES = null;
function states() {
  if (!STATES) {
    const name = require("./leads").STATE_NAME || {};
    STATES = { name, toAb: Object.fromEntries(Object.entries(name).map(([ab, full]) => [String(full).toLowerCase(), ab])) };
  }
  return STATES;
}
function stateOf(v) {
  const { name: STATE_NAME, toAb: FULL_TO_AB } = states();
  const s = clean(v);
  if (!s) return { ab: null, name: null };
  if (/^[A-Za-z]{2}$/.test(s)) { const ab = s.toUpperCase(); return { ab, name: (STATE_NAME[ab] || "").toLowerCase() || null }; }
  const ab = FULL_TO_AB[s.toLowerCase()] || null;
  return { ab, name: s.toLowerCase() };
}

/* SQL: is this lead a client? alias = the leads row. Everything that must not
   call or list clients uses this one expression. */
/* Three separate EXISTS, each an index probe (phone, email, name), so a list
   over tens of thousands of leads reduces each lead's name once rather than
   once per client. */
const isClientSql = (alias = "leads") => `(
     (${alias}.phone_key IS NOT NULL AND EXISTS (SELECT 1 FROM clients cl WHERE cl.phone_key = ${alias}.phone_key))
  OR (nullif(btrim(${alias}.email), '') IS NOT NULL AND EXISTS (SELECT 1 FROM clients cl WHERE cl.email = lower(btrim(${alias}.email))))
  OR EXISTS (SELECT 1 FROM clients cl WHERE cl.name_key <> ''
       AND cl.name_key = ${nameKeySql(`coalesce(nullif(btrim(${alias}.company), ''), ${alias}.name)`)}
       AND (cl.state_ab IS NULL OR nullif(btrim(${alias}.state), '') IS NULL
            OR upper(btrim(${alias}.state)) = cl.state_ab OR lower(btrim(${alias}.state)) = cl.state_name)))`;

// one number: the client it belongs to, or null (for /api/calltime)
async function clientForPhone(key) {
  if (!key) return null;
  return (await query("SELECT id, company, contact FROM clients WHERE phone_key = $1", [key])).rows[0] || null;
}
async function clientForLead(id) {
  if (!(id > 0)) return null;
  return (await query(`SELECT cl.id, cl.company, cl.contact FROM leads l JOIN clients cl ON
        (l.phone_key IS NOT NULL AND cl.phone_key = l.phone_key)
     OR (nullif(btrim(l.email), '') IS NOT NULL AND cl.email = lower(btrim(l.email)))
     OR (cl.name_key <> '' AND cl.name_key = ${nameKeySql("coalesce(nullif(btrim(l.company), ''), l.name)")}
         AND (cl.state_ab IS NULL OR nullif(btrim(l.state), '') IS NULL
              OR upper(btrim(l.state)) = cl.state_ab OR lower(btrim(l.state)) = cl.state_name))
    WHERE l.id = $1 LIMIT 1`, [id])).rows[0] || null;
}
// company names (LinkedIn prospecting): the subset that are clients
async function clientNames(names) {
  const keys = [...new Set((names || []).map(nameKey).filter(Boolean))];
  if (!keys.length) return new Set();
  const { rows } = await query("SELECT DISTINCT name_key FROM clients WHERE name_key = ANY($1)", [keys]);
  return new Set(rows.map((r) => r.name_key));
}

// a client row from loose input (a form, or a spreadsheet row already mapped)
function toClient(o) {
  const company = clean(o.company).slice(0, 160), contact = clean(o.contact).slice(0, 120);
  const phone = clean(o.phone).slice(0, 40), raw = clean(o.email).toLowerCase().slice(0, 160);
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : "";
  const key = pk(phone);
  const st = stateOf(o.state);
  if (!company && !key && !email) return null;     // nothing to recognise them by
  return { company: company || null, contact: contact || null, phone: phone || null, phone_key: key,
    email: email || null, city: clean(o.city).slice(0, 80) || null, state: clean(o.state).slice(0, 40) || null,
    state_ab: st.ab, state_name: st.name, name_key: nameKey(company) || null, note: clean(o.note).slice(0, 1000) || null };
}

async function insertClients(list, who, batch) {
  let added = 0, already = 0;
  for (const c of list) {
    // the same company + phone (or the same phone) is one client; without a phone, the same name + state + email
    const dup = c.phone_key
      ? (await query("SELECT id FROM clients WHERE phone_key = $1", [c.phone_key])).rows[0]
      : (await query(`SELECT id FROM clients WHERE phone_key IS NULL AND coalesce(name_key, '') = coalesce($1, '')
                        AND coalesce(state_ab, '') = coalesce($2, '') AND coalesce(email, '') = coalesce($3, '')`,
        [c.name_key, c.state_ab, c.email])).rows[0];
    if (dup) { already++; continue; }
    await query(
      `INSERT INTO clients (company, contact, phone, phone_key, email, city, state, state_ab, state_name, name_key, note, batch, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [c.company, c.contact, c.phone, c.phone_key, c.email, c.city, c.state, c.state_ab, c.state_name, c.name_key, c.note, batch, who]);
    added++;
  }
  return { added, already };
}

// how many leads the client list now keeps out of the lists and the dialler
async function matchedLeads() {
  return (await query(`SELECT count(*)::int AS n FROM leads l WHERE l.deleted_at IS NULL AND ${isClientSql("l")}`)).rows[0].n;
}

/* ---------------- routes ---------------- */
router.get("/api/clients", requireAdmin, async (req, res, next) => {
  try {
    const q = clean(req.query.q).slice(0, 100);
    const digits = q.replace(/\D/g, "");
    const args = [];
    let where = "TRUE";
    if (q) {
      args.push("%" + q.toLowerCase() + "%");
      where = "(lower(coalesce(company, '')) LIKE $1 OR lower(coalesce(contact, '')) LIKE $1 OR coalesce(email, '') LIKE $1";
      if (digits.length >= 3) { args.push("%" + digits + "%"); where += " OR coalesce(phone_key, '') LIKE $2"; }
      where += ")";
    }
    const rows = (await query(`SELECT id, company, contact, phone, email, city, state, note, added_by, added_at, batch
                                 FROM clients WHERE ${where} ORDER BY added_at DESC, id DESC LIMIT 1000`, args)).rows;
    const total = (await query("SELECT count(*)::int n FROM clients")).rows[0].n;
    res.json({ clients: rows, total, matchedLeads: await matchedLeads() });
  } catch (e) { next(e); }
});

// how many clients there are (the sidebar badge) — any signed-in user may know the count
router.get("/api/clients/count", requireUser, async (req, res, next) => {
  try { res.json({ total: (await query("SELECT count(*)::int n FROM clients")).rows[0].n }); } catch (e) { next(e); }
});

router.post("/api/clients", requireAdmin, express.json({ limit: "8kb" }), async (req, res, next) => {
  try {
    const c = toClient(req.body || {});
    if (!c) return res.status(400).json({ error: "Give the client a company name, a phone number or an email." });
    const r = await insertClients([c], req.user.email, "added by hand");
    activity.log({ actor: req.user.email, user_id: req.user.id, action: "note",
      to_value: r.added ? `Client added: ${c.company || c.phone || c.email}` : "Client already listed", meta: { clients: r } }).catch(() => {});
    res.json({ ...r, matchedLeads: await matchedLeads() });
  } catch (e) { next(e); }
});

/* A spreadsheet of clients: the same reader the uploaded campaigns use
   (campaign-upload.js parseSheet — the columns found by name, with AI help). */
router.post("/api/clients/upload", requireAdmin, express.raw({ limit: "40mb", type: "*/*" }), async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No file was uploaded." });
    const { parseSheet } = require("./campaign-upload");
    const { rows, map } = await parseSheet(req.body);
    if (!rows.length) return res.status(400).json({ error: "That sheet had no rows." });
    if (!map.company && !map.phone && !map.email && !map.name)
      return res.status(400).json({ error: "Couldn't find a company, phone or email column in that sheet." });
    const g = (row, hdr) => (hdr ? clean(row[hdr]) : "");
    const list = [];
    let skipped = 0;
    for (const row of rows.slice(0, MAX_ROWS)) {
      const person = g(row, map.name) || [g(row, map.first), g(row, map.last)].filter(Boolean).join(" ");
      const c = toClient({ company: g(row, map.company) || (map.company ? "" : person), contact: map.company ? person : "",
        phone: g(row, map.phone), email: g(row, map.email), city: g(row, map.city), state: g(row, map.state),
        note: (map.notes || []).map((h) => g(row, h)).filter(Boolean).join(" · ") });
      if (c) list.push(c); else skipped++;
    }
    const dec = (v) => { try { return decodeURIComponent(v || ""); } catch (e) { return clean(v); } };
    const batch = clean(dec(req.get("x-filename"))).slice(0, 120) || "upload";
    const r = await insertClients(list, req.user.email, batch);
    activity.log({ actor: req.user.email, user_id: req.user.id, action: "note",
      to_value: `Clients uploaded: ${r.added} added${r.already ? `, ${r.already} already listed` : ""} (${batch})`, meta: { clients: { ...r, skipped, batch } } }).catch(() => {});
    res.json({ ...r, skipped, total: rows.length, matchedLeads: await matchedLeads() });
  } catch (e) { next(e); }
});

router.delete("/api/clients/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await query("DELETE FROM clients WHERE id = $1 RETURNING company, phone", [id]);
    if (!r.rowCount) return res.status(404).json({ error: "No such client." });
    activity.log({ actor: req.user.email, user_id: req.user.id, action: "note",
      to_value: `Client removed: ${r.rows[0].company || r.rows[0].phone || id}` }).catch(() => {});
    res.json({ ok: true, matchedLeads: await matchedLeads() });
  } catch (e) { next(e); }
});

module.exports = { router, isClientSql, clientForPhone, clientForLead, clientNames, nameKey, toClient, _test: { stateOf, nameKeySql } };
