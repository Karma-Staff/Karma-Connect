"use strict";
/* Zoho CRM scan: every 10 minutes, what is in Zoho is matched back to the
   lead base, so the "Zoho" labels are always current and nobody is given, or
   rings, a person Zoho is already working.

   Two kinds of "in Zoho", labelled differently:
     lead        the number (or email) is a Zoho Lead or Contact   → "Zoho Lead"
     registered  the number is only in Zoho's call history — a Call, or the
                 Account a call was logged against                → "In Zoho"

   Incremental, because Zoho CRM API calls are metered per day: each module is
   read with If-Modified-Since, oldest change first, at most PAGES pages a run,
   and the newest Modified_Time read becomes the next run's starting point. A
   first run (or "Scan Zoho" with full) starts from nothing and works through
   a big CRM a few thousand records per module per run. What was read is kept
   in zoho_records (migration 023), so matching new leads — an import, an
   uploaded campaign sheet — never needs Zoho at all.

   A match is recorded the way every other Zoho link is: an activity_log row
   carrying meta.crm_link {module, id} (actor "zoho"). That is what the
   Contacted tab, the bulk-assign guard and the campaign builder already read.
   A lead first seen only in call history and later found as a Zoho Lead gets
   a second row, and the label moves up to "Zoho Lead". Labels are never taken
   away: a record deleted in Zoho was still worked. */

const express = require("express");
const { query } = require("./db");
const { requireAdmin } = require("./auth");
const { pk } = require("./dedupe");
const zoho = require("./zoho-crm");
const settings = require("./settings");

const router = express.Router();

const EVERY_MS = 10 * 60 * 1000;
const PAGES = 10;                                   // x 200 = 2,000 records per module per run
const LEAD_MODULES = ["Leads", "Contacts"];
const MODULES = [
  { name: "Leads", fields: ["Phone,Mobile,Email,Modified_Time"] },
  { name: "Contacts", fields: ["Phone,Mobile,Email,Modified_Time"] },
  { name: "Accounts", fields: ["Phone,Modified_Time"] },
  /* Dialled_Number / Caller_ID are filled by Zoho's telephony (Zoho Voice and
     the like); calls Karma Connect wrote carry only the record they are on.
     An org without the telephony fields refuses them, so try without. */
  { name: "Calls", fields: ["Who_Id,What_Id,Dialled_Number,Caller_ID,Modified_Time", "Who_Id,What_Id,Modified_Time"] },
];
const STATE_KEY = "zoho.scan";

/* SQL for a lead's Zoho label, for list queries: 'lead' | 'registered' | null */
const zohoKindSql = (alias = "leads") => `(SELECT CASE
    WHEN bool_or(a.meta->'crm_link'->>'module' IN ('Leads', 'Contacts')) THEN 'lead'
    WHEN count(*) > 0 THEN 'registered' END
  FROM activity_log a WHERE a.lead_id = ${alias}.id AND jsonb_exists(a.meta, 'crm_link'))`;

const zIso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "+00:00");
const clean = (v) => String(v == null ? "" : v).trim();

/* One module's records changed since `since`, oldest first, up to PAGES pages. */
async function changed(mod, since) {
  let fieldsIdx = 0;
  const rows = [];
  for (let page = 1; page <= PAGES; page++) {
    const qs = new URLSearchParams({ fields: mod.fields[fieldsIdx], per_page: "200", page: String(page),
      sort_by: "Modified_Time", sort_order: "asc" });
    let d;
    try {
      d = await zoho.crm(`/${mod.name}?${qs}`, since ? { headers: { "If-Modified-Since": zIso(since) } } : {});
    } catch (e) {
      if (e.status === 204 || e.status === 304 || e.status === 404) break;
      /* a field this org does not have: drop to the next field list and retry the page */
      if (fieldsIdx + 1 < mod.fields.length && /field|INVALID_DATA|invalid/i.test(e.message + (e.zoho?.code || ""))) {
        fieldsIdx++; page--; continue;
      }
      throw e;
    }
    if (!d || !d.data || !d.data.length) break;
    rows.push(...d.data);
    if (!(d.info && d.info.more_records)) break;
  }
  return rows;
}

function recordOf(module, r) {
  if (module === "Calls") {
    const linked = (r.What_Id && r.What_Id.id) || (r.Who_Id && r.Who_Id.id) || null;
    return { module, zoho_id: String(r.id), phone_key: pk(r.Dialled_Number || r.Caller_ID) || null,
      phone2_key: null, email: null, linked_id: linked ? String(linked) : null, modified_at: r.Modified_Time || null };
  }
  return { module, zoho_id: String(r.id), phone_key: pk(r.Phone) || null, phone2_key: pk(r.Mobile) || null,
    email: clean(r.Email).toLowerCase() || null, linked_id: null, modified_at: r.Modified_Time || null };
}

async function upsert(recs) {
  for (let i = 0; i < recs.length; i += 500) {
    const chunk = recs.slice(i, i + 500);
    const vals = [], args = [];
    chunk.forEach((r) => {
      const b = args.length;
      vals.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}::timestamptz, now())`);
      args.push(r.module, r.zoho_id, r.phone_key, r.phone2_key, r.email, r.linked_id, r.modified_at);
    });
    await query(
      `INSERT INTO zoho_records (module, zoho_id, phone_key, phone2_key, email, linked_id, modified_at, seen_at)
       VALUES ${vals.join(", ")}
       ON CONFLICT (module, zoho_id) DO UPDATE SET
         phone_key = EXCLUDED.phone_key, phone2_key = EXCLUDED.phone2_key, email = EXCLUDED.email,
         linked_id = EXCLUDED.linked_id, modified_at = EXCLUDED.modified_at, seen_at = now()`, args);
  }
}

/* A Call with no number of its own takes the number of the record it is on. */
async function resolveCalls() {
  await query(
    `UPDATE zoho_records c SET phone_key = coalesce(t.phone_key, t.phone2_key)
       FROM zoho_records t
      WHERE c.module = 'Calls' AND c.phone_key IS NULL AND c.linked_id IS NOT NULL
        AND t.zoho_id = c.linked_id AND t.module <> 'Calls'
        AND coalesce(t.phone_key, t.phone2_key) IS NOT NULL`);
}

/* Label every lead that matches. Phone for every module; email only for Leads
   and Contacts (one email can belong to many franchises — the same rule the
   old one-off backfill used). Never a removed (DNC) or binned lead. Returns
   how many leads got a NEW label of each kind. */
async function flag() {
  const r = (await query(
    `WITH hit AS (
       SELECT l.id, l.lead_code, l.name, z.module, z.zoho_id,
              (z.module = ANY($1)) AS is_lead
         FROM leads l JOIN zoho_records z ON z.phone_key = l.phone_key
        WHERE l.deleted_at IS NULL AND NOT l.removed
       UNION ALL
       SELECT l.id, l.lead_code, l.name, z.module, z.zoho_id, (z.module = ANY($1))
         FROM leads l JOIN zoho_records z ON z.phone2_key = l.phone_key
        WHERE l.deleted_at IS NULL AND NOT l.removed
       UNION ALL
       SELECT l.id, l.lead_code, l.name, z.module, z.zoho_id, true
         FROM leads l
         JOIN zoho_records z ON z.email IS NOT NULL AND z.email = lower(l.email) AND z.module = ANY($1)
        WHERE l.deleted_at IS NULL AND NOT l.removed AND nullif(btrim(l.email), '') IS NOT NULL
     ), best AS (
       SELECT DISTINCT ON (id) * FROM hit ORDER BY id, is_lead DESC, zoho_id
     ), todo AS (
       SELECT b.* FROM best b
        WHERE NOT EXISTS (
          SELECT 1 FROM activity_log a
           WHERE a.lead_id = b.id AND jsonb_exists(a.meta, 'crm_link')
             AND (NOT b.is_lead OR a.meta->'crm_link'->>'module' = ANY($1)))
     )
     INSERT INTO activity_log (actor, user_id, action, lead_id, lead_code, lead_name, to_value, meta)
     SELECT 'zoho', NULL, 'note', id, lead_code, name,
            CASE WHEN is_lead THEN 'Registered in Zoho as a Lead' ELSE 'Registered in Zoho (call history)' END,
            jsonb_build_object(
              'note', CASE WHEN is_lead THEN 'Matched a ' || module || ' record in Zoho CRM'
                           ELSE 'This number is in Zoho CRM''s call history (' || module || ')' END,
              'crm_link', jsonb_build_object('module', module, 'id', zoho_id),
              'crm_source', 'zoho-scan')
       FROM todo
     RETURNING (meta->'crm_link'->>'module') AS module`, [LEAD_MODULES])).rows;
  return { lead: r.filter((x) => LEAD_MODULES.includes(x.module)).length,
    registered: r.filter((x) => !LEAD_MODULES.includes(x.module)).length };
}

let running = null;
/* One run. full=true forgets where every module got to and starts again. */
async function run({ full = false } = {}) {
  if (running) return running;
  running = (async () => {
    if (!zoho.ENABLED) return { ok: false, error: "The Zoho CRM service account isn't configured." };
    /* one instance at a time, even if two ever run side by side. A session
       advisory lock belongs to ONE connection, so it is taken and released on
       a client held for the whole run — through the pool, the unlock could
       land on a different connection and the lock would never be let go. */
    const lockClient = await require("./db").pool.connect();
    let locked = false;
    try {
      locked = (await lockClient.query("SELECT pg_try_advisory_lock(hashtext('karma:zoho-scan')) AS ok")).rows[0].ok;
    } catch (e) { lockClient.release(); throw e; }
    if (!locked) { lockClient.release(); return { ok: false, error: "A Zoho scan is already running." }; }
    const started = new Date();
    try {
      const state = full ? {} : { ...(await settings.get(STATE_KEY, {})) };
      const since = { ...(state.since || {}) };
      const read = {}, errors = {};
      for (const mod of MODULES) {
        try {
          const rows = await changed(mod, since[mod.name] || null);
          read[mod.name] = rows.length;
          if (!rows.length) continue;
          await upsert(rows.map((r) => recordOf(mod.name, r)));
          // by instant, not by string: Zoho writes local offsets ("…+05:30")
          const newest = rows.map((r) => Date.parse(r.Modified_Time)).filter(Number.isFinite)
            .reduce((a, b) => Math.max(a, b), 0);
          /* A full window that did not move the clock (a bulk import in Zoho
             stamps thousands of records with one Modified_Time) would re-read
             the same records forever: step one second past it instead. */
          const prev = since[mod.name] ? Date.parse(since[mod.name]) : 0;
          const stuck = rows.length >= PAGES * 200 && newest && newest <= prev;
          if (newest) since[mod.name] = new Date(stuck ? prev + 1000 : newest).toISOString();
          if (stuck) console.warn(`[karma] zoho scan ${mod.name}: over ${PAGES * 200} records share one Modified_Time — stepped past it`);
        } catch (e) {
          errors[mod.name] = e.message;
          console.warn("[karma] zoho scan " + mod.name + ":", e.message);
        }
      }
      await resolveCalls();
      const labelled = await flag();
      const out = { ok: true, at: started.toISOString(), ms: Date.now() - started, read, labelled,
        ...(Object.keys(errors).length ? { errors } : {}) };
      await settings.set(STATE_KEY, { since, last: out }, "zoho-scan");
      if (labelled.lead || labelled.registered) {
        try { require("./counts").invalidate(); } catch (e) { /* counts not mounted */ }
      }
      return out;
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext('karma:zoho-scan'))").catch(() => {});
      lockClient.release();
    }
  })().finally(() => { running = null; });
  return running;
}

/* Is any of these numbers in Zoho? → Map(phone_key → 'lead' | 'registered').
   For uploaded campaign sheets, which are not leads. Reads the local index only. */
async function kindsOfPhones(keys) {
  const ks = [...new Set(keys.filter(Boolean))];
  const out = new Map();
  if (!ks.length) return out;
  const rows = (await query(
    `SELECT k, bool_or(module = ANY($2)) AS is_lead FROM (
       SELECT phone_key AS k, module FROM zoho_records WHERE phone_key = ANY($1)
       UNION ALL SELECT phone2_key, module FROM zoho_records WHERE phone2_key = ANY($1)
       UNION ALL SELECT l.phone_key, a.meta->'crm_link'->>'module'
         FROM leads l JOIN activity_log a ON a.lead_id = l.id AND jsonb_exists(a.meta, 'crm_link')
        WHERE l.phone_key = ANY($1) AND l.deleted_at IS NULL) x
     GROUP BY k`, [ks, LEAD_MODULES])).rows;
  for (const r of rows) out.set(r.k, r.is_lead ? "lead" : "registered");
  return out;
}

let timer = null;
function startSweeper() {
  if (timer) return;
  if (process.env.KARMA_NO_SWEEP === "1") {
    console.log("[karma] KARMA_NO_SWEEP=1 — the 10-minute Zoho CRM scan will NOT run");
    return;
  }
  if (!zoho.ENABLED) return;
  const tick = () => run().catch((e) => console.warn("[karma] zoho scan:", e.message));
  setTimeout(tick, 60 * 1000);                     // a minute after boot, then every 10
  timer = setInterval(tick, EVERY_MS);
}

/* POST /api/crm/zoho/scan — run one now (the "Scan Zoho" button). ?full=1 reads
   everything again from the start instead of only what changed. */
router.post("/api/crm/zoho/scan", requireAdmin, async (req, res, next) => {
  try {
    const out = await run({ full: req.query.full === "1" });
    if (!out.ok) return res.status(out.error && /configured/.test(out.error) ? 503 : 409).json(out);
    res.json(out);
  } catch (e) { next(e); }
});

/* GET /api/crm/zoho/scan — when it last ran and what it found. */
router.get("/api/crm/zoho/scan", requireAdmin, async (req, res, next) => {
  try {
    const s = await settings.get(STATE_KEY, {});
    const n = (await query(`SELECT module, count(*)::int n FROM zoho_records GROUP BY module`)).rows;
    res.json({ enabled: zoho.ENABLED, every: EVERY_MS / 60000, last: s.last || null,
      indexed: Object.fromEntries(n.map((r) => [r.module, r.n])), running: !!running });
  } catch (e) { next(e); }
});

module.exports = { router, startSweeper, run, kindsOfPhones, zohoKindSql, _test: { recordOf, flag, resolveCalls, changed } };
