"use strict";
/* Spreadsheet → call campaign.
 *
 * A manager uploads an Excel/CSV of people to call and it becomes a campaign a
 * rep can work in the power dialer. Deliberately separate from the lead base:
 * these rows live in `campaign_leads` (migration 021), not in `leads`, so a
 * quick call-through never has to become CRM records (the owner asked for the
 * separation). A campaign is still a `call_sessions` row; an uploaded one is
 * marked filters.source = 'upload' and draws its list from here.
 *
 * Two things ride from the sheet to the rep's screen:
 *   - the sheet's free-text note, carried verbatim;
 *   - a one-line AI summary of that note, filled in the background after the
 *     upload so the rep can start calling at once (claude-haiku, the same cheap
 *     extraction model research.js uses).
 *
 * The AI also reads the HEADER row and works out which column is the phone and
 * which is the note, so the sheet does not have to be laid out a particular way.
 *
 * campaign.js delegates an uploaded campaign's serve/outcome to serveUpload /
 * outcomeUpload here, so the rep works it through the exact same dialer screen.
 */

const express = require("express");
const { query } = require("./db");
const { requireAdmin } = require("./auth");
const { pk } = require("./dedupe");
const { handleClaude } = require("../../api/_proxy.cjs");
const calltime = require("./calltime");

const router = express.Router();

const MODEL = process.env.RESEARCH_MODEL || "claude-haiku-4-5";
const MAX_ROWS = 20000;                 // a sane ceiling for one upload
const NAME_MAX = 80;
const isUpload = (s) => s && s.filters && s.filters.source === "upload";

/* ---------------- parsing the sheet ---------------- */

const norm = (h) => String(h ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const clean = (v) => String(v ?? "").trim();

/* Header → field, by name. The AI fills whatever this misses (phone/note are
   the two that matter), but most sheets are named plainly and never need it. */
const MATCH = {
  phone: ["phone", "mobile", "cell", "cellphone", "telephone", "tel", "phonenumber", "contactnumber", "number", "primaryphone", "workphone"],
  name: ["name", "fullname", "contactname", "contact", "leadname"],
  first: ["firstname", "first", "givenname", "fname"],
  last: ["lastname", "last", "surname", "lname"],
  company: ["company", "companyname", "business", "businessname", "organization", "organisation", "account", "accountname"],
  email: ["email", "emailaddress", "mail", "workemail"],
  city: ["city", "town"],
  state: ["state", "province", "region"],
  note: ["note", "notes", "comment", "comments", "remark", "remarks", "memo", "details", "description", "info", "message"],
};
function heuristicMap(headers) {
  const normed = headers.map((h) => ({ h, n: norm(h) }));
  const find = (keys) => {
    for (const k of keys) { const hit = normed.find((x) => x.n === k); if (hit) return hit.h; }
    for (const k of keys) { const hit = normed.find((x) => x.n.includes(k)); if (hit) return hit.h; }
    return null;
  };
  const m = {};
  for (const f of Object.keys(MATCH)) m[f] = find(MATCH[f]);
  return m;
}

/* The AI reads the header and a few sample rows and names the columns — the
   phone, the PERSON to ask for (not the company), and which columns carry the
   context a rep wants before dialing. One cheap call; the by-name pass below
   backs it up if the model is unavailable. */
async function aiMap(headers, sampleRows) {
  const sys = "You are labeling the columns of a spreadsheet that a sales rep will call through. "
    + "From the headers and sample rows, reply with ONLY a JSON object with these keys: "
    + "phone, name, company, email, city, state — each set to the EXACT header string that best holds it, or null; "
    + "and notes — an ARRAY of the header strings whose text gives the rep useful context before dialing "
    + "(who to ask for, the pitch or angle, pain points, key facts), most useful first, 1 to 4 of them, or []. "
    + "For name, prefer the PERSON to speak to (a decision-maker or named contact), not the company name.";
  const user = "Headers: " + JSON.stringify(headers) + "\nSample rows:\n"
    + sampleRows.map((r) => JSON.stringify(r)).join("\n");
  const body = JSON.stringify({ model: MODEL, max_tokens: 500,
    system: sys, messages: [{ role: "user", content: user }] });
  const out = await handleClaude({ method: "POST", bodyString: body, authHeader: "", identity: null },
    { requireAuth: false, recordUsage: false });
  if (out.status !== 200) throw new Error("map upstream " + out.status);
  const text = (JSON.parse(out.body).content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

async function parseSheet(buffer) {
  const XLSX = require("xlsx");                 // lazy: only an actual upload needs it
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { rows: [], map: {} };
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
  if (!rows.length) return { rows: [], map: {} };
  const headers = Object.keys(rows[0]);
  const h = heuristicMap(headers);
  // AI reads the sheet; the by-name heuristic fills anything it leaves blank
  let map = {};
  try { map = await aiMap(headers, rows.slice(0, 4)); }
  catch (e) { console.warn("[karma] campaign upload column AI:", e.message); }
  for (const f of ["phone", "name", "company", "email", "city", "state"]) {
    if (!map[f] || !headers.includes(map[f])) map[f] = h[f] || null;
  }
  map.first = h.first; map.last = h.last;
  let notes = Array.isArray(map.notes) ? map.notes.filter((x) => headers.includes(x)) : [];
  if (!notes.length && h.note) notes = [h.note];
  map.notes = notes;
  return { rows, map };
}

function rowToLead(row, map) {
  const g = (hdr) => (hdr ? clean(row[hdr]) : "");
  const gf = (f) => g(map[f]);
  const phone = gf("phone");
  const key = pk(phone);
  if (!key) return null;                       // no usable phone → not a call
  let name = gf("name");
  if (!name) name = [g(map.first), g(map.last)].filter(Boolean).join(" ").trim();
  // the note is every context column the AI chose, each under its own label
  const note = (map.notes || []).map((hdr) => { const v = g(hdr); return v ? `${hdr}: ${v}` : ""; })
    .filter(Boolean).join("\n").slice(0, 4000) || null;
  return {
    name: name.slice(0, NAME_MAX) || null,
    company: gf("company").slice(0, NAME_MAX) || null,
    phone, phone_key: key,
    email: gf("email").slice(0, 160) || null,
    city: gf("city").slice(0, 80) || null,
    state: gf("state").slice(0, 40) || null,
    note, raw: row,
  };
}

/* ---------------- the AI note summaries (background) ---------------- */

const SUM_SYS = "You turn a sales-call note into ONE short line (max ~12 words) a rep reads at a glance "
  + "before dialing — what the person wants or the single key fact. No preamble, no quotes. If a note is "
  + "empty or says nothing useful, return an empty string for it.";

async function summariseBatch(notes) {
  const body = JSON.stringify({ model: MODEL, max_tokens: Math.min(1500, 60 * notes.length + 100),
    system: SUM_SYS,
    messages: [{ role: "user", content:
      "Summarise each note. Reply with ONLY a JSON array of strings, one per note, same order.\n"
      + JSON.stringify(notes) }] });
  const out = await handleClaude({ method: "POST", bodyString: body, authHeader: "", identity: null },
    { requireAuth: false, recordUsage: false });
  if (out.status !== 200) throw new Error("summary upstream " + out.status);
  const text = (JSON.parse(out.body).content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const arr = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
  return Array.isArray(arr) ? arr : [];
}

/* Fire-and-forget after an upload: fill note_summary for a session's rows in
   small batches. Best-effort — a row whose summary fails just keeps the full
   note, which the rep sees anyway. */
async function summariseSession(sessionId) {
  try {
    for (;;) {
      const rows = (await query(
        `SELECT id, note FROM campaign_leads
          WHERE session_id = $1 AND note IS NOT NULL AND note_summary IS NULL
          ORDER BY pos LIMIT 15`, [sessionId])).rows;
      if (!rows.length) break;
      let sums = [];
      try { sums = await summariseBatch(rows.map((r) => r.note)); }
      catch (e) { console.warn("[karma] campaign summaries:", e.message); break; }
      for (let i = 0; i < rows.length; i++) {
        const s = clean(sums[i]).slice(0, 200);
        // mark every row in the batch so the loop can't spin on a failed one
        await query("UPDATE campaign_leads SET note_summary = $2 WHERE id = $1",
          [rows[i].id, s || ""]);
      }
    }
  } catch (e) { console.warn("[karma] summariseSession:", e.message); }
}

/* ---------------- upload ---------------- */

router.post("/api/dialer/campaigns/upload", requireAdmin,
  express.raw({ limit: "40mb", type: "*/*" }), async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length)
        return res.status(400).json({ error: "No file was uploaded." });
      const dec = (v) => { try { return decodeURIComponent(v || ""); } catch (e) { return clean(v); } };
      const name = clean(dec(req.get("x-campaign-name"))).slice(0, NAME_MAX) || "Uploaded campaign";
      const owner = clean(req.get("x-owner"));
      if (!owner) return res.status(400).json({ error: "Pick a rep to assign the campaign to." });
      const gap = Math.max(0, Math.min(120, parseInt(req.get("x-gap"), 10) || 0));
      /* Resolve the callback ext to the full {name, ext, number} target the
         rest of the app expects — a bare string would break the dialer screen.
         Lazy require: campaign.js already requires this module, so pulling it in
         at load time would be a cycle. */
      const callbackExt = clean(req.get("x-callback-ext")).slice(0, 20);
      let callback = null;
      if (callbackExt) {
        try {
          const { callbackTargets } = require("./campaign");
          callback = (await callbackTargets(req.user.id).catch(() => [])).find((x) => x.ext === String(callbackExt)) || null;
        } catch (e) { callback = null; }
      }

      const { rows, map } = await parseSheet(req.body);
      if (!rows.length) return res.status(400).json({ error: "That sheet had no rows." });
      if (!map.phone) return res.status(400).json({ error: "Couldn't find a phone-number column in that sheet." });

      const leads = [];
      for (const r of rows.slice(0, MAX_ROWS)) { const l = rowToLead(r, map); if (l) leads.push(l); }
      if (!leads.length) return res.status(400).json({ error: "No rows had a usable phone number." });

      /* Numbers already in Zoho CRM — a Zoho Lead, or in its call history —
         are being worked there, so they are left out of the call list
         (zoho-scan.js keeps the index this reads; no Zoho call is made). */
      const zk = await require("./zoho-scan").kindsOfPhones(leads.map((l) => l.phone_key));
      const inZoho = leads.filter((l) => l.phone_key && zk.has(l.phone_key)).length;
      if (inZoho) leads.splice(0, leads.length, ...leads.filter((l) => !(l.phone_key && zk.has(l.phone_key))));
      if (!leads.length) return res.status(400).json({
        error: `Every number in that sheet is already in Zoho CRM (${inZoho}) — nothing left to call.`, skippedInZoho: inZoho });

      /* Clients (clients.js) are never called: their numbers, emails or company
         names (in the same state) are left out of the sheet's call list. */
      const { rows: cl } = await query(
        `SELECT phone_key, email, name_key, state_ab FROM clients
          WHERE phone_key = ANY($1) OR email = ANY($2) OR name_key = ANY($3)`,
        [leads.map((l) => l.phone_key).filter(Boolean), leads.map((l) => (l.email || "").toLowerCase()).filter(Boolean),
         leads.map((l) => require("./clients").nameKey(l.company)).filter(Boolean)]).catch(() => ({ rows: [] }));
      const cPhones = new Set(cl.map((c) => c.phone_key).filter(Boolean)), cEmails = new Set(cl.map((c) => c.email).filter(Boolean));
      const isClient = (l) => (l.phone_key && cPhones.has(l.phone_key)) || (l.email && cEmails.has(l.email.toLowerCase()))
        || cl.some((c) => c.name_key && c.name_key === require("./clients").nameKey(l.company)
          && (!c.state_ab || !l.state || require("./clients")._test.stateOf(l.state).ab === c.state_ab));
      const clientsLeft = leads.filter(isClient).length;
      if (clientsLeft) leads.splice(0, leads.length, ...leads.filter((l) => !isClient(l)));
      if (!leads.length) return res.status(400).json({
        error: `Every contact in that sheet is a client (${clientsLeft}) — nothing left to call.`, skippedClients: clientsLeft });

      const filters = { kind: "campaign", source: "upload", name, created_by: req.user.email,
        status: "ongoing", gap, callback, uploaded: new Date().toISOString() };
      const session = await query(
        `INSERT INTO call_sessions (actor, owner, lead_ids, filters)
         VALUES ($1, $1, '{}', $2) RETURNING id`, [owner, filters]).then((r) => r.rows[0]).catch((e) => {
          if (e.code === "23505") return null;      // rep already has an open session
          throw e;
        });
      if (!session) return res.status(409).json({
        error: "That rep already has a live session. End it first, then upload." });

      // insert the rows in one multi-values statement per chunk
      const CH = 500;
      for (let i = 0; i < leads.length; i += CH) {
        const chunk = leads.slice(i, i + CH);
        const vals = [], args = [session.id];
        chunk.forEach((l, j) => {
          const b = 1 + j * 9;
          vals.push(`($1, ${i + j}, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9})`);
          args.push(l.name, l.company, l.phone, l.phone_key, l.email, l.city, l.state, l.note, JSON.stringify(l.raw));
        });
        await query(
          `INSERT INTO campaign_leads (session_id, pos, name, company, phone, phone_key, email, city, state, note, raw)
           VALUES ${vals.join(", ")}`, args);
      }

      summariseSession(session.id);              // background; do not await
      res.json({ ok: true, id: session.id, owner, total: leads.length,
        skipped: rows.length - leads.length - inZoho - clientsLeft, skippedInZoho: inZoho, skippedClients: clientsLeft, columns: map });
    } catch (e) { next(e); }
  });

/* ---------------- export ---------------- */

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
router.get("/api/dialer/campaigns/:id/export", requireAdmin, async (req, res, next) => {
  try {
    const id = +req.params.id;
    if (!Number.isInteger(id)) return res.status(400).json({ error: "bad id" });
    const s = (await query("SELECT filters FROM call_sessions WHERE id = $1", [id])).rows[0];
    if (!s || s.filters?.source !== "upload") return res.status(404).json({ error: "not an uploaded campaign" });
    const rows = (await query(
      `SELECT name, company, phone, email, city, state, note, note_summary, status, outcome, outcome_note, called_at
         FROM campaign_leads WHERE session_id = $1 ORDER BY pos, id`, [id])).rows;
    const head = ["Name", "Company", "Phone", "Email", "City", "State", "Note", "AI summary",
      "Status", "Outcome", "Call note", "Called at"];
    const lines = [head.join(",")];
    for (const r of rows) lines.push([r.name, r.company, r.phone, r.email, r.city, r.state, r.note,
      r.note_summary, r.status, r.outcome, r.outcome_note, r.called_at && new Date(r.called_at).toISOString()]
      .map(csvCell).join(","));
    const body = "﻿" + lines.join("\r\n") + "\r\n";     // BOM so Excel reads UTF-8
    const fname = "campaign-" + id + "-" + new Date().toISOString().slice(0, 10) + ".csv";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    res.send(body);
  } catch (e) { next(e); }
});

/* ---------------- serve / outcome (called by campaign.js) ----------------

   An uploaded campaign is worked through the same rep screen as any other, so
   these return the SAME shape campaign.js's serve/shape produce. The current
   lead is always the first still-pending row, in sheet order; its id is passed
   to the front end as a NEGATIVE number so the softphone can tell an uploaded
   row from a real lead and skip the lead-based call log. */

function shapeUpload(s, total, done, card) {
  const f = s.filters || {};
  return {
    id: s.id, owner: s.owner, pos: done, total,
    called: s.called, connected: s.connected, skipped: s.skipped,
    filters: f, startedAt: s.started_at,
    done: done >= total,
    campaign: { name: f.name, status: f.status, createdBy: f.created_by,
      gap: f.gap || null, callback: f.callback || null, pausedBy: f.paused_by || null,
      source: "upload" },
    current: card,
  };
}

async function counts(sessionId) {
  const r = (await query(
    `SELECT count(*)::int total, count(*) FILTER (WHERE status = 'done')::int done
       FROM campaign_leads WHERE session_id = $1`, [sessionId])).rows[0];
  return { total: r.total, done: r.done };
}

async function currentRow(sessionId) {
  return (await query(
    `SELECT * FROM campaign_leads WHERE session_id = $1 AND status = 'pending'
      ORDER BY pos, id LIMIT 1`, [sessionId])).rows[0] || null;
}

function cardOf(row, callTime) {
  if (!row) return null;
  return {
    // a leads-shaped object (snake_case) so the front end's fromApi() maps it;
    // id is negative — the mark of an uploaded, lead-less row
    lead: { id: -row.id, name: row.name, company: row.company, phone: row.phone,
      city: row.city, state: row.state, status: null },
    sheetNote: row.note || null,
    sheetSummary: row.note_summary || null,
    brief: null, notes: [], lastCall: null,
    callTime: callTime || { open: true },
  };
}

/* Calling hours, exactly as campaign.js's servable() does it for the lead
   base: 8am-9pm in the person's own time (calltime.js — the sheet's state
   column, else the phone's area code). Rows it is too early or too late for
   go to the back of the sheet, in their order, and the first one it is a
   decent hour for comes up; if none of the next LOOK can be called yet, the
   answer says when the soonest opens (callTime.waiting) and auto-dial holds.
   Uploaded sheets were not checked at first, and a rep working one rang
   somebody at 5am. */
const LOOK = 200;
async function servableRow(sessionId) {
  const rows = (await query(
    `SELECT id, state, phone FROM campaign_leads WHERE session_id = $1 AND status = 'pending'
      ORDER BY pos, id LIMIT ${LOOK}`, [sessionId])).rows;
  if (!rows.length) return null;
  const now = new Date();
  const checks = rows.map((r) => calltime.check(r, now));
  // how many in reach are waiting for their calling hours (or lunch) to open — shown on the card
  const later = checks.filter((c) => !c.open).length;
  const j = checks.findIndex((c) => c.open);
  if (j === 0) return { ...checks[0], later };
  if (j < 0) {
    const soonest = checks.map((c) => c.opensAt).filter(Boolean).sort()[0] || null;
    return { ...checks[0], waiting: true, opensAt: soonest, later };
  }
  await query(
    `UPDATE campaign_leads c SET pos = m.top + u.ord
       FROM (SELECT coalesce(max(pos), 0) AS top FROM campaign_leads WHERE session_id = $1) m,
            unnest($2::bigint[]) WITH ORDINALITY u(id, ord)
      WHERE c.id = u.id AND c.session_id = $1`, [sessionId, rows.slice(0, j).map((r) => r.id)]);
  return { ...checks[j], deferred: j, later };
}

async function serveUpload(s) {
  const callTime = await servableRow(s.id);
  const { total, done } = await counts(s.id);
  const row = await currentRow(s.id);
  const card = cardOf(row, callTime);
  /* registered in Zoho since the sheet was uploaded: the rep is warned first */
  if (card && row.phone_key)
    card.zoho = (await require("./zoho-scan").kindsOfPhones([row.phone_key])).get(row.phone_key) || null;
  return shapeUpload(s, total, done, card);
}

async function outcomeUpload(s, b) {
  /* The row the rep was shown (the page sends its id, negative). A poll
     between dialling and the disposition can re-order the sheet when the
     hour turns, so "the first pending row" may no longer be the one called. */
  const shown = +b.leadId < 0 ? (await query(
    `SELECT * FROM campaign_leads WHERE id = $1 AND session_id = $2 AND status = 'pending'`,
    [-b.leadId, s.id])).rows[0] : null;
  const row = shown || await currentRow(s.id);
  /* "Call later" (outside its hours, or lunch): to the back of the sheet,
     still pending — not a skip, nothing counted. */
  if (row && b.later === true) {
    await query(
      `UPDATE campaign_leads SET pos = (SELECT coalesce(max(pos), 0) + 1 FROM campaign_leads WHERE session_id = $2)
        WHERE id = $1 AND status = 'pending'`, [row.id, s.id]);
    return { ...(await serveUpload(s)), later: true };
  }
  if (row) {
    let skip = b.skip === true;
    let called = String(b.outcome || "no-answer");
    /* Skip on a row this rep has just rung (the session never heard the call
       end): that call is the outcome — counted as called, not skipped. The
       row has no lead id, so its call is found by number, as calls.js logs it. */
    const ten = String(row.phone || "").replace(/\D/g, "").slice(-10);
    if (skip && ten.length >= 7) {
      const recent = (await query(
        `SELECT coalesce(meta->>'outcome', to_value) AS outcome FROM activity_log
          WHERE action = 'call' AND lead_id IS NULL AND actor = $2
            AND right(regexp_replace(coalesce(meta->>'number', ''), '\\D', '', 'g'), 10) = $1
            AND at > now() - interval '30 minutes'
            AND (coalesce(meta->>'outcome', to_value) IN ('connected', 'no-answer', 'busy')
                   OR coalesce(meta, '{}'::jsonb) ? 'disposition')
          ORDER BY at DESC LIMIT 1`, [ten, s.actor])).rows[0];
      if (recent) { skip = false; called = recent.outcome; }
    }
    const outcome = skip ? "skip" : called;
    const note = clean(b.note).slice(0, 2000) || null;
    await query(
      `UPDATE campaign_leads SET status = 'done', outcome = $2, outcome_note = $3, called_at = now()
        WHERE id = $1`, [row.id, outcome, note]);
    const connected = !skip && outcome === "connected";
    await query(
      `UPDATE call_sessions SET called = called + $2, connected = connected + $3, skipped = skipped + $4
        WHERE id = $1`, [s.id, skip ? 0 : 1, connected ? 1 : 0, skip ? 1 : 0]);
  }
  // reload the session row (counters moved) and serve the next
  const s2 = (await query(
    `SELECT id, actor, owner, pos, filters, started_at, ended_at, called, connected, skipped
       FROM call_sessions WHERE id = $1`, [s.id])).rows[0] || s;
  const next = await currentRow(s.id);
  if (!next) await query(
    `UPDATE call_sessions SET ended_at = now(), filters = filters || '{"status":"completed"}'::jsonb
      WHERE id = $1 AND ended_at IS NULL`, [s.id]);
  return serveUpload(s2);
}

module.exports = { router, isUpload, serveUpload, outcomeUpload, summariseSession, servableRow, parseSheet };
