"use strict";
/* Karma Connect → Zoho CRM: every call into the CRM's call log, and a Lead
   created when a connected call yields a name.

   WHAT GOES WHERE
     Calls module   every RingCentral call placed from Karma Connect, once:
                    type, start, duration, outcome, the rep's disposition as
                    the CRM's own Call Result (VM, GK, No Answer…), the rep's
                    notes, who called, and a link to the recording. Attached
                    to the matching Lead / Account / Contact by phone, and
                    left unattached when the CRM has no such number.
     Leads module   only when a call CONNECTED and the rep typed the person's
                    name (POST /api/leads/:id/crm-lead). An existing CRM record
                    with that number is linked instead — never a second copy.

   WHAT IS NOT SENT
     Calls dialled through Zoho Voice: Zoho Voice already writes those into
     the CRM itself (230k of them), so sending them too would double every
     one. Only meta.provider = "ringcentral" is synced.
     Anything before the switch was turned on (`since`): no backfill.

   OFF UNTIL AN OWNER TURNS IT ON. The CRM is the business's system of
   record; the switch (app_settings "crm.sync") is the line between building
   this and it writing there. A preview shows the exact payloads first.

   ONCE, AND ONLY ONCE. The sweeper claims rows by stamping them inside the
   same UPDATE that selects them (FOR UPDATE SKIP LOCKED), so two server
   instances, or a restart mid-send, cannot log one call twice. The result —
   the CRM's call id, or the error — is written back onto the call's own row
   in activity_log (meta.crm_*). No new table.

   Calls are left alone for three minutes after they end, so the rep's
   wrap-up (disposition, note) is on the row before it is sent. */

const express = require("express");
const { query } = require("./db");
const { requireUser, requireAdmin, requireOwner } = require("./auth");
const settings = require("./settings");
const zoho = require("./zoho-crm");
const activity = require("./activity");
const dash = require("./rc-dashboard");

const router = express.Router();

const KEY = "crm.sync";
const TICK_MS = 60e3;
const SETTLE = "3 minutes";
const BATCH = 15;
const MAX_ATTEMPTS = 5;
const APP_URL = String(process.env.APP_URL || "").replace(/\/+$/, "");
const TZ = process.env.CALL_TZ || "America/New_York";

/* Our dispositions → the CRM's Call Result picklist (Email captured, GK,
   CDM, Wrong Number, No Answer, DNC, VM, Busy). Ones the CRM has no value
   for go into the description instead. */
const RESULT = {
  "Voicemail": "VM", "Gatekeeper": "GK", "No Answer": "No Answer", "Busy": "Busy",
  "Wrong Number": "Wrong Number", "Email Captured": "Email captured", "Do Not Contact": "DNC",
  "CDM": "CDM",
};
const OUTCOME = { connected: "Connected", "no-answer": "No answer", busy: "Busy",
  failed: "Failed", cancelled: "Cancelled", placed: "Placed" };

const config = () => settings.get(KEY, { on: false });
const zIso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "+00:00");
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

/* ---------------- building one CRM call ---------------- */

async function recordingFor(row) {
  /* The recording lives in RingCentral's call log, not ours: find the
     RingCentral record for this call (same number, start within 3 minutes)
     through the rep's own connection. Optional — a call without one is
     still logged. */
  try {
    if (!row.user_id) return null;
    const w = dash.wall(new Date(row.at).getTime(), TZ);
    const ymd = `${w.year}-${w.month}-${w.day}`;
    let recs;
    try { recs = await dash.fetchDay(row.user_id, ymd, TZ, "account"); }
    catch (e) { recs = await dash.fetchDay(row.user_id, ymd, TZ, "extension"); }
    const want = zoho.digits10(row.meta?.number);
    const end = new Date(row.at).getTime();
    const hit = recs.find((c) => c.recId && zoho.digits10(c.toNum) === want
      && Math.abs(c.t + c.dur * 1000 - end) < 3 * 60e3);
    return hit && APP_URL ? `${APP_URL}/api/voice/rc/recording/${hit.recId}` : null;
  } catch (e) { return null; }
}

async function buildCall(row) {
  const m = row.meta || {};
  const seconds = Math.max(0, +m.seconds || 0);
  const start = new Date(new Date(row.at).getTime() - seconds * 1000);

  /* the rep's notes on this lead from around the call */
  const notes = (await query(
    `SELECT body FROM lead_comments
      WHERE lead_id = $1 AND lower(author_email) = lower($2) AND deleted_at IS NULL
        AND created_at BETWEEN $3::timestamptz - interval '2 minutes' AND $3::timestamptz + interval '20 minutes'
      ORDER BY created_at`, [row.lead_id, row.actor, row.at])).rows.map((r) => r.body.trim()).filter(Boolean);
  if (m.dispo_note && !notes.includes(String(m.dispo_note).trim())) notes.push(String(m.dispo_note).trim());

  const link = m.crm_link || (await zoho.findInCrm(m.number || row.phone));
  const recording = await recordingFor(row);
  const rep = row.rep_name || row.actor;
  const who = row.lead_name || row.company || m.number || "a lead";

  const lines = [
    `Called by: ${rep} (${row.actor})`,
    `Outcome: ${OUTCOME[m.outcome] || m.outcome || "—"}`,
    m.disposition ? `Disposition: ${m.disposition}` : null,
    notes.length ? `Notes:\n${notes.map((n) => "• " + n).join("\n")}` : null,
    recording ? `Recording: ${recording}` : null,
    `Logged by Karma Connect (RingCentral).`,
  ].filter(Boolean);

  const call = {
    Subject: `Outgoing call to ${who} — ${rep}`,
    Call_Type: "Outbound",
    Call_Start_Time: zIso(start),
    Call_Duration: mmss(seconds),
    Description: lines.join("\n"),
    ...(RESULT[m.disposition] ? { Call_Result: RESULT[m.disposition] } : {}),
    ...(m.number ? { Dialled_Number: String(m.number) } : {}),
    ...(recording ? { Voice_Recording__s: recording } : {}),
  };
  if (link && link.module && link.id) {
    if (link.module === "Contacts") call.Who_Id = { id: link.id };
    else { call.What_Id = { id: link.id }; call.$se_module = link.module; }
  }
  return { call, link: link && link.module ? { module: link.module, id: link.id, name: link.name || null } : null };
}

/* Calls eligible to send: ours, RingCentral, after `since`, settled, not yet
   sent, not given up on. */
const ELIGIBLE = `
  a.action = 'call'
  AND a.meta->>'provider' = 'ringcentral'
  AND a.at >= $1::timestamptz
  AND a.at < now() - interval '${SETTLE}'
  AND NOT (coalesce(a.meta, '{}'::jsonb) ? 'crm_call_id')
  AND coalesce((a.meta->>'crm_attempts')::int, 0) < ${MAX_ATTEMPTS}`;

const ROW = `
  SELECT a.id, a.at, a.actor, a.user_id, a.lead_id, a.lead_name, a.meta,
         l.company, l.phone,
         coalesce(nullif(btrim(u.display_name), ''), a.actor) AS rep_name
    FROM activity_log a
    LEFT JOIN leads l ON l.id = a.lead_id
    LEFT JOIN app_users u ON lower(u.email) = lower(a.actor)`;

/* ---------------- the sweeper ---------------- */

let running = false;
async function tick() {
  if (running || !zoho.ENABLED) return { skipped: true };
  const cfg = await config();
  if (!cfg.on || !cfg.since) return { skipped: "off" };
  running = true;
  let sent = 0, failed = 0;
  try {
    const claimed = (await query(
      `UPDATE activity_log a SET meta = coalesce(a.meta, '{}'::jsonb)
                || jsonb_build_object('crm_state', 'sending', 'crm_claimed_at', now())
        WHERE a.id IN (
          SELECT a.id FROM activity_log a
           WHERE ${ELIGIBLE}
             AND (a.meta->>'crm_state' IS DISTINCT FROM 'sending'
                  OR (a.meta->>'crm_claimed_at')::timestamptz < now() - interval '10 minutes')
           ORDER BY a.at
           LIMIT ${BATCH}
           FOR UPDATE SKIP LOCKED)
        RETURNING a.id`, [cfg.since])).rows.map((r) => r.id);
    for (const id of claimed) {
      const row = (await query(`${ROW} WHERE a.id = $1`, [id])).rows[0];
      try {
        const { call, link } = await buildCall(row);
        const r = await zoho.crm("/Calls", { method: "POST", body: JSON.stringify({ data: [call] }) });
        const d = r?.data?.[0];
        if (!d || d.status !== "success") throw new Error(d?.message || d?.code || "Zoho refused the call");
        await query(
          `UPDATE activity_log SET meta = meta || jsonb_build_object(
             'crm_state', 'done', 'crm_call_id', $2::text, 'crm_synced_at', now(),
             'crm_related', $3::jsonb) - 'crm_error'
            WHERE id = $1`, [id, String(d.details.id), JSON.stringify(link)]);
        sent++;
      } catch (e) {
        failed++;
        await query(
          `UPDATE activity_log SET meta = meta || jsonb_build_object(
             'crm_state', 'error', 'crm_error', $2::text,
             'crm_attempts', coalesce((meta->>'crm_attempts')::int, 0) + 1)
            WHERE id = $1`, [id, String(e.message).slice(0, 300)]);
      }
    }
  } catch (e) {
    console.warn("[karma] crm sync:", e.message);
  } finally { running = false; }
  return { sent, failed };
}

function startSweeper() {
  if (process.env.KARMA_NO_SWEEP === "1") {
    console.warn("[karma] KARMA_NO_SWEEP=1 — calls will NOT be sent to Zoho CRM from this server");
    return;
  }
  setInterval(() => { tick().catch(() => {}); }, TICK_MS).unref();
}

/* ---------------- the switch, the status and the preview ---------------- */

router.get("/api/crm/sync", requireAdmin, async (req, res, next) => {
  try {
    const cfg = await config();
    const meta = await settings.describe(KEY);
    const since = cfg.since || null;
    let stats = { synced: 0, today: 0, pending: 0, errors: 0, lastError: null, lastSyncedAt: null };
    if (since) {
      const s = (await query(`
        SELECT count(*) FILTER (WHERE meta ? 'crm_call_id')::int AS synced,
               count(*) FILTER (WHERE meta ? 'crm_call_id' AND (meta->>'crm_synced_at')::timestamptz > now() - interval '24 hours')::int AS today,
               count(*) FILTER (WHERE NOT (meta ? 'crm_call_id') AND coalesce((meta->>'crm_attempts')::int, 0) < ${MAX_ATTEMPTS})::int AS pending,
               count(*) FILTER (WHERE meta->>'crm_state' = 'error')::int AS errors,
               max((meta->>'crm_synced_at')::timestamptz) AS last_synced_at
          FROM activity_log
         WHERE action = 'call' AND meta->>'provider' = 'ringcentral' AND at >= $1`, [since])).rows[0];
      const le = (await query(`
        SELECT meta->>'crm_error' AS e FROM activity_log
         WHERE action = 'call' AND meta->>'crm_state' = 'error' AND at >= $1
         ORDER BY at DESC LIMIT 1`, [since])).rows[0];
      stats = { synced: s.synced, today: s.today, pending: s.pending, errors: s.errors,
        lastError: le?.e || null, lastSyncedAt: s.last_synced_at };
    }
    res.json({ configured: zoho.ENABLED, on: !!cfg.on, since,
      changedBy: meta?.updated_by || null, changedAt: meta?.updated_at || null, stats });
  } catch (e) { next(e); }
});

/* Just "is it on" — for a rep's wrap-up, which offers "Create CRM lead" only
   when there is somewhere for it to go. */
router.get("/api/crm/sync/on", requireUser, async (req, res, next) => {
  try { res.json({ on: zoho.ENABLED && !!(await config()).on }); } catch (e) { next(e); }
});

router.put("/api/crm/sync", requireOwner, express.json({ limit: "1kb" }), async (req, res, next) => {
  try {
    if (!zoho.ENABLED) return res.status(503).json({ error: "Zoho CRM is not configured on this server" });
    const on = !!(req.body || {}).on;
    const cur = await config();
    /* `since` is set the first time it goes on and kept through off/on, so
       turning it off for an afternoon does not lose that afternoon's calls —
       they are sent when it comes back. */
    const next = { on, since: cur.since || (on ? new Date().toISOString() : null) };
    await settings.set(KEY, next, req.user.email);
    res.json(next);
  } catch (e) { next(e); }
});

/* The exact payloads the next calls would produce. Read-only — nothing is
   sent, nothing is stamped. Works with the switch off, which is the point. */
router.get("/api/crm/sync/preview", requireAdmin, async (req, res, next) => {
  try {
    if (!zoho.ENABLED) return res.status(503).json({ error: "Zoho CRM is not configured on this server" });
    const cfg = await config();
    const since = cfg.since || new Date(Date.now() - 7 * 86400e3).toISOString();
    const rows = (await query(`${ROW} WHERE ${ELIGIBLE} ORDER BY a.at DESC LIMIT 5`, [since])).rows;
    const items = [];
    for (const row of rows) {
      try { items.push({ at: row.at, rep: row.rep_name, lead: row.lead_name, ...(await buildCall(row)) }); }
      catch (e) { items.push({ at: row.at, rep: row.rep_name, lead: row.lead_name, error: e.message }); }
    }
    res.json({ on: !!cfg.on, since, items,
      note: "Preview only — nothing was sent to Zoho CRM and nothing was changed." });
  } catch (e) { next(e); }
});

/* ---------------- creating a Lead after a connected call ----------------
   Mounted under /api/leads/:id, so requireOwnLead has already run: a rep can
   only create CRM leads from their own leads. */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post("/api/leads/:id/crm-lead", requireUser, express.json({ limit: "4kb" }), async (req, res, next) => {
  try {
    if (!zoho.ENABLED) return res.status(503).json({ error: "Zoho CRM is not configured on this server" });
    const cfg = await config();
    if (!cfg.on) return res.status(409).json({ error: "Zoho CRM sync is off — an owner can turn it on in Call logs." });
    const id = +req.params.id;
    const b = req.body || {};
    const first = String(b.first_name || "").trim().slice(0, 40);
    const last = String(b.last_name || "").trim().slice(0, 80);
    const email = String(b.email || "").trim().slice(0, 100);
    if (!last) return res.status(400).json({ error: "Last name is required to create a CRM lead." });
    if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: "That email doesn't look right." });

    const lead = (await query(
      `SELECT id, lead_code, name, company, phone, city, state, website
         FROM leads WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!lead) return res.status(404).json({ error: "No such lead." });

    /* The CRM may already hold this number — link to it, never duplicate. */
    let link = await zoho.findInCrm(lead.phone);
    if (link.error) return res.status(502).json({ error: "Couldn't check Zoho CRM for duplicates: " + link.error });
    let created = false;
    if (!link.module) {
      const rec = {
        First_Name: first || undefined, Last_Name: last, Email: email || undefined,
        Company: lead.company || lead.name || `${first} ${last}`.trim(),
        Phone: lead.phone || undefined, City: lead.city || undefined, State: lead.state || undefined,
        Website: lead.website || undefined,
        Lead_Source: "Cold Call", Lead_Status: "Contacted",
        Description: `Created from Karma Connect by ${req.user.name || req.user.email} after a connected call on ${new Date().toISOString().slice(0, 10)}.`,
      };
      const r = await zoho.crm("/Leads", { method: "POST", body: JSON.stringify({ data: [rec] }) });
      const d = r?.data?.[0];
      if (d?.code === "DUPLICATE_DATA" && d.details?.id) {
        link = { module: "Leads", id: String(d.details.id), name: rec.Company };
      } else if (!d || d.status !== "success") {
        return res.status(502).json({ error: "Zoho CRM refused the lead: " + (d?.message || d?.code || "unknown") });
      } else {
        link = { module: "Leads", id: String(d.details.id), name: `${first} ${last}`.trim() };
        created = true;
      }
    }

    /* Point this rep's latest call to the lead at the record, so the call
       lands in the CRM attached to it (the sweeper reads meta.crm_link). */
    await query(
      `UPDATE activity_log SET meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('crm_link', $3::jsonb)
        WHERE id = (SELECT id FROM activity_log WHERE action = 'call' AND lead_id = $1 AND actor = $2
                     AND at > now() - interval '2 hours' ORDER BY at DESC LIMIT 1)`,
      [id, req.user.email, JSON.stringify({ module: link.module, id: link.id, name: link.name || null })]);
    await activity.log({
      actor: req.user.email, user_id: req.user.id, action: "note",
      lead_id: lead.id, lead_code: lead.lead_code, lead_name: lead.name,
      to_value: created ? "Zoho CRM lead created" : "Linked to existing Zoho CRM record",
      meta: { note: created ? `Created Zoho CRM lead: ${`${first} ${last}`.trim()}${email ? " <" + email + ">" : ""}`
        : `Already in Zoho CRM (${link.module}: ${link.name || link.id}) — linked, not duplicated`,
        crm_link: { module: link.module, id: link.id } },
    });
    res.json({ ok: true, created, module: link.module, id: link.id, name: link.name || null });
  } catch (e) { next(e); }
});

module.exports = { router, startSweeper, tick, _test: { buildCall, RESULT, mmss, zIso } };
