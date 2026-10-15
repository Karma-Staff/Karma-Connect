"use strict";
/* Zoho CRM scan: on a timer (every 5, 10, 30 or 60 minutes, or off — an admin
   sets it beside the Scan Zoho button; 10 by default), what is in Zoho is
   matched back to the lead base, so the "Zoho" labels stay current and nobody
   is given, or rings, a person Zoho is already working.

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
  /* Where a call's number lives, in the order it is trusted:
       To_Number__s / From_Number__s  — what Karma Connect writes (crm-sync.js
                                        buildCall); the lead is To on an
                                        outgoing call, From on an incoming or
                                        missed one
       Dialled_Number / Caller_ID     — filled by Zoho's own telephony
       Subject                        — "Outgoing call to Acme (702) 555-0101 — Rep"
       the linked record              — Who_Id / What_Id, resolved afterwards
     The first version read only Dialled_Number/Caller_ID — read-only fields
     Zoho drops on calls we write — so a call to someone who is NOT a Zoho Lead
     (exactly the "In Zoho" case) never matched anything. An org that lacks
     a field refuses the whole request, so each list falls back to a smaller one. */
  /* Call_Result (the disposition) and Call_Start_Time set the lead's status
     (applyStatus). They are standard Calls fields, but each list still has a
     fallback without them rather than lose the whole module. */
  { name: "Calls", fields: [
    "Who_Id,What_Id,Call_Type,Subject,Call_Result,Call_Start_Time,To_Number__s,From_Number__s,Dialled_Number,Caller_ID,Modified_Time",
    "Who_Id,What_Id,Call_Type,Subject,Call_Result,Call_Start_Time,To_Number__s,From_Number__s,Modified_Time",
    "Who_Id,What_Id,Call_Type,Subject,Call_Result,Call_Start_Time,Modified_Time",
    "Who_Id,What_Id,Call_Type,Subject,To_Number__s,From_Number__s,Modified_Time",
    "Who_Id,What_Id,Call_Type,Subject,Modified_Time",
  ] },
];
const STATE_KEY = "zoho.scan";
/* Bumped when what is read from a module changes, so that module is read
   again from the start: v2 = Calls now carry their own numbers; v3 = Calls
   carry their Call Result, which now sets every lead's status. */
const STATE_VERSION = 3;
const RESCAN_ON_UPGRADE = ["Calls"];

/* "In Zoho" means a real Zoho record — a Lead, Contact or Account. A number
   that is only in Zoho's call history is NOT: every call Karma Connect makes
   is logged in Zoho's Calls (crm-sync.js), matched or not, so counting those
   put every lead anyone had ever rung into Contacted. The Calls link is still
   recorded (it is history), it just doesn't make a lead "in Zoho". */
const RECORD_MODULES = ["Leads", "Contacts", "Accounts"];
const REAL_LINK = (a) => `${a}.meta->'crm_link'->>'module' IN ('Leads', 'Contacts', 'Accounts')`;

/* SQL for a lead's Zoho label, for list queries:
   'lead' (a Zoho Lead or Contact) | 'registered' (a Zoho Account) | null */
const zohoKindSql = (alias = "leads") => `(SELECT CASE
    WHEN bool_or(a.meta->'crm_link'->>'module' IN ('Leads', 'Contacts')) THEN 'lead'
    WHEN bool_or(a.meta->'crm_link'->>'module' = 'Accounts') THEN 'registered' END
  FROM activity_log a WHERE a.lead_id = ${alias}.id AND jsonb_exists(a.meta, 'crm_link'))`;

/* SQL: is this lead in Zoho (a real Zoho record linked)? — the Contacted tab,
   the campaign builder, the bulk-assign guard. */
const inZohoSql = (alias = "leads") =>
  `EXISTS (SELECT 1 FROM activity_log a WHERE a.lead_id = ${alias}.id AND jsonb_exists(a.meta, 'crm_link') AND ${REAL_LINK("a")})`;

/* SQL: is this lead listed under Contacted instead of Companies / People?
   In Zoho AND worked there — its status is a Zoho Call Result, not still
   'New'. A Zoho record nobody has called yet stays in Companies / People.
   Campaigns and bulk assign still guard on inZohoSql (any Zoho record). */
const contactedSql = (alias = "leads") => `(${inZohoSql(alias)} AND ${alias}.status <> 'New')`;

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

/* A US number written anywhere in a call's subject: "(702) 555-0101",
   "702-555-0101", "+1 702 555 0101". */
const SUBJECT_NUMBER = /(?:\+?1[\s.-]?)?\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/;
function callNumber(r) {
  /* only the OTHER party's side: the far side of an incoming call (To) and the
     near side of an outgoing one (From) are our own lines, and must never
     label a lead */
  const theirs = /inbound|missed/i.test(r.Call_Type || "")
    ? [r.From_Number__s, r.Caller_ID]
    : [r.To_Number__s, r.Dialled_Number];
  for (const n of theirs) { const k = pk(n); if (k) return k; }
  const m = SUBJECT_NUMBER.exec(String(r.Subject || ""));
  return m ? pk(m[1] + m[2] + m[3]) : null;
}

function recordOf(module, r) {
  if (module === "Calls") {
    const linked = (r.What_Id && r.What_Id.id) || (r.Who_Id && r.Who_Id.id) || null;
    const result = clean(r.Call_Result).slice(0, 60);
    const at = Date.parse(r.Call_Start_Time || "");
    return { module, zoho_id: String(r.id), phone_key: callNumber(r) || null,
      phone2_key: null, email: null, linked_id: linked ? String(linked) : null, modified_at: r.Modified_Time || null,
      call_result: result && result !== "-None-" ? result : null,
      call_at: Number.isFinite(at) ? new Date(at).toISOString() : (r.Modified_Time || null) };
  }
  return { module, zoho_id: String(r.id), phone_key: pk(r.Phone) || null, phone2_key: pk(r.Mobile) || null,
    email: clean(r.Email).toLowerCase() || null, linked_id: null, modified_at: r.Modified_Time || null,
    call_result: null, call_at: null };
}

async function upsert(recs) {
  for (let i = 0; i < recs.length; i += 500) {
    const chunk = recs.slice(i, i + 500);
    const vals = [], args = [];
    chunk.forEach((r) => {
      const b = args.length;
      vals.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}::timestamptz, $${b + 8}, $${b + 9}::timestamptz, now())`);
      args.push(r.module, r.zoho_id, r.phone_key, r.phone2_key, r.email, r.linked_id, r.modified_at, r.call_result ?? null, r.call_at ?? null);
    });
    await query(
      `INSERT INTO zoho_records (module, zoho_id, phone_key, phone2_key, email, linked_id, modified_at, call_result, call_at, seen_at)
       VALUES ${vals.join(", ")}
       ON CONFLICT (module, zoho_id) DO UPDATE SET
         phone_key = EXCLUDED.phone_key, phone2_key = EXCLUDED.phone2_key, email = EXCLUDED.email,
         linked_id = EXCLUDED.linked_id, modified_at = EXCLUDED.modified_at,
         call_result = EXCLUDED.call_result, call_at = EXCLUDED.call_at, seen_at = now()`, args);
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
       SELECT l.id, l.lead_code, l.name, z.module, z.zoho_id
         FROM leads l JOIN zoho_records z ON z.phone_key = l.phone_key
        WHERE l.deleted_at IS NULL AND NOT l.removed
       UNION ALL
       SELECT l.id, l.lead_code, l.name, z.module, z.zoho_id
         FROM leads l JOIN zoho_records z ON z.phone2_key = l.phone_key
        WHERE l.deleted_at IS NULL AND NOT l.removed
       UNION ALL
       SELECT l.id, l.lead_code, l.name, z.module, z.zoho_id
         FROM leads l
         JOIN zoho_records z ON z.email IS NOT NULL AND z.email = lower(l.email) AND z.module = ANY($1)
        WHERE l.deleted_at IS NULL AND NOT l.removed AND nullif(btrim(l.email), '') IS NOT NULL
     ), ranked AS (
       /* 2 a Lead/Contact, 1 an Account, 0 only a Call: a better match
          is added on top of a weaker one, never the other way round */
       SELECT *, CASE WHEN module = ANY($1) THEN 2 WHEN module = 'Accounts' THEN 1 ELSE 0 END AS rnk FROM hit
     ), best AS (
       SELECT DISTINCT ON (id) * FROM ranked ORDER BY id, rnk DESC, zoho_id
     ), todo AS (
       SELECT b.* FROM best b
        WHERE NOT EXISTS (
          SELECT 1 FROM activity_log a
           WHERE a.lead_id = b.id AND jsonb_exists(a.meta, 'crm_link')
             AND CASE WHEN a.meta->'crm_link'->>'module' = ANY($1) THEN 2
                      WHEN a.meta->'crm_link'->>'module' = 'Accounts' THEN 1 ELSE 0 END >= b.rnk)
     )
     INSERT INTO activity_log (actor, user_id, action, lead_id, lead_code, lead_name, to_value, meta)
     SELECT 'zoho', NULL, 'note', id, lead_code, name,
            CASE rnk WHEN 2 THEN 'Registered in Zoho as a Lead' WHEN 1 THEN 'Registered in Zoho as an Account'
                     ELSE 'Called — in Zoho''s call history' END,
            jsonb_build_object(
              'note', CASE WHEN rnk > 0 THEN 'Matched a ' || module || ' record in Zoho CRM'
                           ELSE 'This number is in Zoho CRM''s call history (not a Zoho record)' END,
              'crm_link', jsonb_build_object('module', module, 'id', zoho_id),
              'crm_source', 'zoho-scan')
       FROM todo
     RETURNING (meta->'crm_link'->>'module') AS module`, [LEAD_MODULES])).rows;
  return { lead: r.filter((x) => LEAD_MODULES.includes(x.module)).length,
    registered: r.filter((x) => x.module === "Accounts").length,
    called: r.filter((x) => x.module === "Calls").length };
}

/* A lead's status is the Call Result of the most recent Zoho Call to its
   number — the disposition the rep logged (Karma Connect writes it there,
   crm-sync.js), or whatever someone set in Zoho afterwards. Statuses are no
   longer set by hand in Karma Connect; Zoho is the one place they change.
   A lead with no Zoho call that has a result keeps the status it had.
   Every run checks every lead, so a result edited in Zoho comes back on the
   next scan. Each change is logged on the lead (actor "zoho"); a big batch —
   the first scan after this shipped — is logged as one summary row instead,
   so the activity feed is not buried. */
const STATUS_LOG_EACH = 300;
async function applyStatus() {
  const rows = (await query(
    `WITH latest AS (
       SELECT DISTINCT ON (phone_key) phone_key, call_result
         FROM zoho_records
        WHERE module = 'Calls' AND call_result IS NOT NULL AND phone_key IS NOT NULL
        ORDER BY phone_key, call_at DESC NULLS LAST, modified_at DESC NULLS LAST, zoho_id DESC
     ), todo AS (
       SELECT l.id, l.status AS old, z.call_result AS new
         FROM leads l JOIN latest z ON z.phone_key = l.phone_key
        WHERE l.deleted_at IS NULL AND l.status IS DISTINCT FROM z.call_result
     )
     UPDATE leads l SET status = todo.new, updated_at = now()
       FROM todo WHERE l.id = todo.id
     RETURNING l.id, l.lead_code, l.name, todo.old, todo.new`)).rows;
  if (!rows.length) return 0;
  if (rows.length <= STATUS_LOG_EACH) {
    const vals = [], args = [];
    for (const r of rows) {
      const b = args.length;
      vals.push(`('zoho', 'status', $${b + 1}::bigint, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, '{"source":"zoho-call-result"}'::jsonb)`);
      args.push(r.id, r.lead_code, r.name, r.old, r.new);
    }
    await query(`INSERT INTO activity_log (actor, action, lead_id, lead_code, lead_name, from_value, to_value, meta)
                 VALUES ${vals.join(", ")}`, args);
  } else {
    const by = {};
    for (const r of rows) by[r.new] = (by[r.new] || 0) + 1;
    await query(`INSERT INTO activity_log (actor, action, to_value, meta) VALUES ('zoho', 'status', $1, $2)`,
      [`${rows.length} lead statuses set from Zoho call results`,
       { bulk: true, source: "zoho-call-result", count: rows.length, by }]);
  }
  return rows.length;
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
      // what is read changed since this state was saved: read those modules again
      if ((state.v || 1) < STATE_VERSION) for (const m of RESCAN_ON_UPGRADE) delete since[m];
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
      const statuses = await applyStatus();
      const out = { ok: true, at: started.toISOString(), ms: Date.now() - started, read, labelled, statuses,
        ...(Object.keys(errors).length ? { errors } : {}) };
      await settings.set(STATE_KEY, { v: STATE_VERSION, since, last: out }, "zoho-scan");
      if (labelled.lead || labelled.registered || labelled.called || statuses) {
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
       SELECT phone_key AS k, module FROM zoho_records WHERE phone_key = ANY($1) AND module = ANY($3)
       UNION ALL SELECT phone2_key, module FROM zoho_records WHERE phone2_key = ANY($1) AND module = ANY($3)
       UNION ALL SELECT l.phone_key, a.meta->'crm_link'->>'module'
         FROM leads l JOIN activity_log a ON a.lead_id = l.id AND jsonb_exists(a.meta, 'crm_link') AND ${REAL_LINK("a")}
        WHERE l.phone_key = ANY($1) AND l.deleted_at IS NULL) x
     GROUP BY k`, [ks, LEAD_MODULES, RECORD_MODULES])).rows;
  for (const r of rows) out.set(r.k, r.is_lead ? "lead" : "registered");
  return out;
}

/* The automatic scan, set by an admin beside the Scan Zoho button: on or off,
   and how often — every 10, 30 or 60 minutes. Kept in app_settings so it
   survives a deploy and needs none. */
const CONFIG_KEY = "zoho.scan.config";
const EVERY_CHOICES = [5, 10, 30, 60];
async function config() {
  const c = await settings.get(CONFIG_KEY, {});
  return { auto: c.auto !== false, every: EVERY_CHOICES.includes(+c.every) ? +c.every : EVERY_MS / 60000 };
}

/* Checked once a minute: runs when the scan is on and the last run is older
   than the chosen gap. So a change of setting takes effect within a minute,
   and a restart does not reset the clock (the last run's time is stored). */
let timer = null;
async function dueTick() {
  try {
    const c = await config();
    if (!c.auto || running) return;
    const last = (await settings.get(STATE_KEY, {})).last;
    const lastAt = last && last.at ? Date.parse(last.at) : 0;
    if (Date.now() - lastAt < c.every * 60 * 1000 - 15 * 1000) return;   // 15s slack for the minute tick
    await run();
  } catch (e) { console.warn("[karma] zoho scan:", e.message); }
}
function startSweeper() {
  if (timer) return;
  if (process.env.KARMA_NO_SWEEP === "1") {
    console.log("[karma] KARMA_NO_SWEEP=1 — the automatic Zoho CRM scan will NOT run");
    return;
  }
  if (!zoho.ENABLED) return;
  setTimeout(dueTick, 60 * 1000);                  // a minute after boot, then every minute
  timer = setInterval(dueTick, 60 * 1000);
}

/* PUT /api/crm/zoho/scan/config — {auto?: boolean, every?: 5 | 10 | 30 | 60} */
router.put("/api/crm/zoho/scan/config", requireAdmin, express.json({ limit: "1kb" }), async (req, res, next) => {
  try {
    const b = req.body || {};
    const cur = await config();
    const next_ = { ...cur };
    if (b.auto !== undefined) next_.auto = !!b.auto;
    if (b.every !== undefined) {
      if (!EVERY_CHOICES.includes(+b.every)) return res.status(400).json({ error: "Choose every 5, 10, 30 or 60 minutes." });
      next_.every = +b.every;
    }
    await settings.set(CONFIG_KEY, next_, req.user.email);
    res.json({ ok: true, config: next_ });
  } catch (e) { next(e); }
});

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
    const c = await config();
    const cfgRow = await settings.describe(CONFIG_KEY).catch(() => null);
    res.json({ enabled: zoho.ENABLED, auto: c.auto, every: c.every, choices: EVERY_CHOICES,
      changedBy: cfgRow?.updated_by || null, changedAt: cfgRow?.updated_at || null,
      last: s.last || null, indexed: Object.fromEntries(n.map((r) => [r.module, r.n])), running: !!running });
  } catch (e) { next(e); }
});

module.exports = { router, startSweeper, run, kindsOfPhones, zohoKindSql, inZohoSql, contactedSql, _test: { recordOf, flag, resolveCalls, changed, dueTick, config, applyStatus } };
