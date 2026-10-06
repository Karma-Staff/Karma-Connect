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

   AS WHOM
     A rep who has signed in to Zoho themselves (crm-identity.js) has their
     Calls and Leads created as themselves, so Zoho files them as that rep's.
     Anyone else's go through the service account. Which one it was is kept
     on the row (meta.crm_as: "rep" | "shared").

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

   WHEN IT GOES. The moment the rep saves the call's disposition (calls.js
   calls sendNow) — that click is the rep saying "done", so the Call reaches
   Zoho seconds later with its Call Result and notes. A call nobody
   dispositions is swept up three minutes after it ends instead, so none is
   missed. RingCentral needs a minute or two after a call to publish its
   recording, so a call sent before that is updated in Zoho once it exists
   (meta.crm_rec_pending), for up to half an hour: the recording is ATTACHED
   to the Call as an audio file anyone in the CRM can play (attachRecording),
   and its Karma Connect link goes in Voice Recording as well.

   PROSPECT. Saving the "Prospect" disposition with a name creates that
   person as a Lead (createLead) BEFORE the call is sent, so the call lands
   on the new Lead rather than unattached. */

const express = require("express");
const { query } = require("./db");
const { requireUser, requireAdmin, requireOwner } = require("./auth");
const settings = require("./settings");
const zoho = require("./zoho-crm");
const rc = require("./ringcentral");
const people = require("./crm-identity");
const activity = require("./activity");
const dash = require("./rc-dashboard");
const voicemail = require("./voicemail");

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
  // what the dialler offers now — the CRM's own values
  "VM": "VM", "GK": "GK", "No Answer": "No Answer", "Busy": "Busy", "Wrong number": "Wrong Number",
  "Email captured": "Email captured", "DNC": "DNC",
  // the names calls were logged with before
  "Voicemail": "VM", "Gatekeeper": "GK",
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
  /* A missed call has no recording; what it can have is the voicemail the
     caller left (missed.js), which goes on the Zoho call the same way. */
  if (row.meta?.missed) return row.meta.vm_msg ? `vm:${row.meta.vm_ext || "~"}:${row.meta.vm_msg}` : null;
  try {
    if (!row.user_id) return null;
    const w = dash.wall(new Date(row.at).getTime(), TZ);
    const ymd = `${w.year}-${w.month}-${w.day}`;
    let recs;
    try { recs = await dash.fetchDay(row.user_id, ymd, TZ, "account"); }
    catch (e) { recs = await dash.fetchDay(row.user_id, ymd, TZ, "extension"); }
    const want = zoho.digits10(row.meta?.number);
    const end = new Date(row.at).getTime();
    /* row.meta.number is the OTHER party: the To of a call we placed, but
       the From of one we answered. Matching To alone meant no answered
       call ever found its recording. */
    const inbound = row.meta?.direction === "inbound";
    const hit = recs.find((c) => c.recId && zoho.digits10(inbound ? c.fromNum : c.toNum) === want
      && Math.abs(c.t + c.dur * 1000 - end) < 3 * 60e3);
    return hit ? hit.recId : null;
  } catch (e) { return null; }
}
/* The link Zoho's Voice Recording player can actually play — signed, no
   login needed (calllogs.js). The admin-only proxy would answer it with an
   error instead of audio. */
const recUrl = (recId) => require("./calllogs").recordingLink(recId);
const LINK_V = "v2";                         // bump to re-send links already on Zoho calls

/* Zoho's attachment limit is about 20 MB; a recording past it (an hour-plus
   call) keeps its link and is not uploaded. */
const MAX_ATTACH = 20 * 1024 * 1024;

/* The recording itself, kept IN Zoho CRM so it outlives RingCentral, which
   deletes recordings after 90 days. Zoho refuses file uploads on Call
   records ("The http request method type is not a valid one" — tried on
   every API version), but takes them on Notes: so the Call gets a note,
   "Call recording", and the MP3 is attached to that note. It shows in the
   call's Notes, playable and downloadable by anyone with access to the call.

   Downloaded from RingCentral through the rep's own connection. Written as
   the rep where their Zoho sign-in allows it, else the service account. The
   note's id is kept on the row first, so a retry adds the file to the same
   note instead of making a second one. Throws on failure; the caller keeps
   it pending and tries again. */
async function attachRecording(row, zohoCallId, recId) {
  /* a missed call's "recording" is the voicemail the caller left (voicemail.js) */
  const vm = String(recId).startsWith("vm:");
  let r;
  if (vm) r = await voicemail.audio(row);
  else {
    const tok = await rc.accessFor(row.user_id);
    r = await fetch(`${rc.SERVER.replace("platform.", "media.")}/restapi/v1.0/account/~/recording/${recId}/content`,
      { headers: { Authorization: "Bearer " + tok.access_token } });
    if (!r.ok) throw new Error(r.status === 404 ? "RingCentral has no such recording"
      : r.status === 403 ? "RingCentral refused the recording download (call-recording access)" : `RingCentral recording ${r.status}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_ATTACH) throw Object.assign(new Error("Recording is larger than Zoho's attachment limit"), { final: true });
  const type = (r.headers.get("content-type") || "audio/mpeg").split(";")[0];
  const ext = /wav/.test(type) ? "wav" : "mp3";
  const when = new Date(row.at).toISOString().slice(0, 16).replace("T", "_").replace(":", "");
  const name = `${vm ? "voicemail" : "call-recording"}_${when}_${zoho.digits10(row.meta?.number) || "unknown"}.${ext}`;

  let noteId = row.meta?.crm_rec_note || null;
  if (!noteId) {
    const secs = +row.meta?.seconds || 0;
    const n = await people.writeAs(row.user_id, "/Notes", { method: "POST", body: JSON.stringify({ data: [{
      Note_Title: vm ? "Voicemail" : "Call recording",
      Note_Content: vm
        ? `The voicemail the caller left on this missed call. The audio is attached to this note (saved by Karma Connect).`
        : `Recording of this call — ${row.rep_name || row.actor}, ${Math.floor(secs / 60)}m ${secs % 60}s. `
        + `The MP3 is attached to this note (saved by Karma Connect; kept in Zoho after RingCentral deletes its copy at 90 days).`,
      Parent_Id: { module: { api_name: "Calls" }, id: String(zohoCallId) } }] }) });
    const nd = n.d?.data?.[0];
    if (!nd || nd.code !== "SUCCESS") throw new Error("Zoho refused the recording note: " + (nd?.message || nd?.code || "unknown"));
    noteId = String(nd.details.id);
    await query(`UPDATE activity_log SET meta = meta || jsonb_build_object('crm_rec_note', $2::text) WHERE id = $1`, [row.id, noteId]);
  }
  const form = new FormData();
  form.append("file", new Blob([buf], { type }), name);
  const w = await people.writeAs(row.user_id, `/Notes/${noteId}/Attachments`, { method: "POST", body: form });
  const d = w.d?.data?.[0];
  if (!d || d.code !== "SUCCESS") throw new Error("Zoho refused the recording file: " + (d?.message || w.d?.message || d?.code || "unknown"));
  return { id: String(d.details?.id || ""), noteId, name, bytes: buf.length, as: w.as };
}

/* When the search for a call's recording started: the call itself, or the
   moment someone pressed Retry (POST /api/crm/sync/recordings/retry). */
const recClock = (row) => new Date(row.meta?.crm_rec_retry_at || row.at).getTime();

/* Attach, and record what happened on the call's row. */
async function attachAndMark(row, zohoCallId, recId) {
  try {
    const a = await attachRecording(row, zohoCallId, recId);
    await query(`UPDATE activity_log SET meta = meta || jsonb_build_object('crm_rec_pending', false,
        'crm_rec_attached', $2::text, 'crm_rec_bytes', $3::int) - 'crm_rec_error' WHERE id = $1`,
      [row.id, a.id || a.name, a.bytes]);
    return true;
  } catch (e) {
    const old = Date.now() - recClock(row) > REC_WINDOW_MIN * 60e3;
    await query(`UPDATE activity_log SET meta = meta || jsonb_build_object('crm_rec_error', $2::text,
        'crm_rec_tries', coalesce((meta->>'crm_rec_tries')::int, 0) + 1,
        'crm_rec_pending', $3::boolean) WHERE id = $1`,
      [row.id, String(e.message).slice(0, 300), !e.final && !old]);
    return false;
  }
}

async function buildCall(row, known = {}) {
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
  const recId = known.recId || await recordingFor(row);
  const recording = recId && !String(recId).startsWith("vm:") ? recUrl(recId) : null;
  const missed = !!m.missed;
  const vmSaid = missed && m.voicemail ? await voicemail.text(row) : null;
  const rep = row.rep_name || row.actor;
  const who = row.lead_name || row.company || m.number || "a lead";

  const lines = missed ? [
    `Missed call — ${m.voicemail ? "the caller left a voicemail" : "nobody answered and no voicemail was left"}`,
    m.agent ? `Rang: ${m.agent}` : null,
    vmSaid ? `Voicemail (RingCentral's transcript): ${vmSaid}` : null,
    m.voicemail && recId ? `Voicemail audio: saved in this call's Notes ("Voicemail")` : null,
    `Logged by Karma Connect (RingCentral).`,
  ].filter(Boolean) : [
    `Called by: ${rep} (${row.actor})`,
    `Outcome: ${OUTCOME[m.outcome] || m.outcome || "—"}`,
    m.disposition ? `Disposition: ${m.disposition}` : null,
    notes.length ? `Notes:\n${notes.map((n) => "• " + n).join("\n")}` : null,
    recId ? `Recording: saved in this call's Notes as an MP3 ("Call recording")${recording ? `; also playable at ${recording} until RingCentral removes it after 90 days` : ""}` : null,
    `Logged by Karma Connect (RingCentral).`,
  ].filter(Boolean);

  /* The number goes in To/From Number (Zoho phone fields, which its search
     indexes) and, formatted, in the subject — so typing the number into
     Zoho's search finds the call even when it is attached to nothing.
     Dialled_Number looks right but is read-only: Zoho drops it silently. */
  const inbound = m.direction === "inbound";
  const raw = String(m.number || row.phone || "").trim();
  const digits = raw.replace(/\D/g, "");
  const us = digits.length === 10 ? digits : digits.length === 11 && digits[0] === "1" ? digits.slice(1) : "";
  const pretty = us ? `(${us.slice(0, 3)}) ${us.slice(3, 6)}-${us.slice(6)}` : raw;
  const e164 = us ? "+1" + us : raw;
  const call = {
    Subject: missed
      ? `Missed call from ${who}${pretty && who !== raw ? " " + pretty : ""}${m.voicemail ? " — voicemail" : ""}`
      : `${inbound ? "Incoming call from" : "Outgoing call to"} ${who}${pretty && who !== raw ? " " + pretty : ""} — ${rep}`,
    Call_Type: missed ? "Missed" : inbound ? "Inbound" : "Outbound",
    ...(raw ? (inbound ? { From_Number__s: e164 } : { To_Number__s: e164 }) : {}),
    Call_Start_Time: zIso(start),
    Call_Duration: mmss(seconds),
    Description: lines.join("\n"),
    ...(RESULT[m.disposition] ? { Call_Result: RESULT[m.disposition] } : {}),
    ...(recording ? { Voice_Recording__s: recording } : {}),
  };
  if (link && link.module && link.id) {
    if (link.module === "Contacts") call.Who_Id = { id: link.id };
    else { call.What_Id = { id: link.id }; call.$se_module = link.module; }
  }
  return { call, recording, recId, link: link && link.module ? { module: link.module, id: link.id, name: link.name || null } : null };
}

/* Calls eligible to send: ours, RingCentral, after `since`, settled, not yet
   sent, not given up on. ELIGIBLE_NOW is the same without the settle, for a
   call whose rep has just saved the disposition. */
const ELIGIBLE_NOW = `
  a.action = 'call'
  AND a.meta->>'provider' = 'ringcentral'
  AND a.at >= $1::timestamptz
  AND NOT (coalesce(a.meta, '{}'::jsonb) ? 'crm_call_id')
  AND coalesce((a.meta->>'crm_attempts')::int, 0) < ${MAX_ATTEMPTS}`;
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
         coalesce(nullif(btrim(u.display_name), ''), a.actor) AS rep_name,
         ci.zoho_name AS rep_crm
    FROM activity_log a
    LEFT JOIN crm_identities ci ON ci.user_id = a.user_id
    LEFT JOIN leads l ON l.id = a.lead_id
    LEFT JOIN app_users u ON lower(u.email) = lower(a.actor)`;

/* ---------------- sending one call ---------------- */

const REC_WINDOW_MIN = 30;     // how long to keep looking for a late recording

/* Send one row that has already been claimed (crm_state = 'sending'). */
async function sendClaimed(id) {
  const row = (await query(`${ROW} WHERE a.id = $1`, [id])).rows[0];
  if (!row) return { error: "gone" };
  try {
    const { call, link, recording, recId } = await buildCall(row);
    /* As the rep, if they have signed in to Zoho themselves — then the
       Call is theirs in the CRM. Otherwise as the service account. */
    const w = await people.writeAs(row.user_id, "/Calls", { method: "POST", body: JSON.stringify({ data: [call] }) });
    const d = w.d?.data?.[0];
    if (!d || d.status !== "success") throw new Error(d?.message || d?.code || "Zoho refused the call");
    const young = Date.now() - new Date(row.at).getTime() < REC_WINDOW_MIN * 60e3;
    await query(
      `UPDATE activity_log SET meta = meta || jsonb_build_object(
         'crm_state', 'done', 'crm_call_id', $2::text, 'crm_synced_at', now(),
         'crm_related', $3::jsonb, 'crm_as', $4::text, 'crm_rec_pending', $5::boolean) - 'crm_error'
        WHERE id = $1`, [id, String(d.details.id), JSON.stringify(link), w.as, !recId && young]);
    /* The recording is already published: put the file on the Call now. A
       failure here never undoes the Call — it stays pending and is retried. */
    if (recId) {
      await query(`UPDATE activity_log SET meta = meta || jsonb_build_object('crm_rec_linked', $2::text) WHERE id = $1`, [id, LINK_V]);
      await attachAndMark(row, String(d.details.id), recId);
    }
    return { sent: true, as: w.as, zohoId: String(d.details.id), link };
  } catch (e) {
    await query(
      `UPDATE activity_log SET meta = meta || jsonb_build_object(
         'crm_state', 'error', 'crm_error', $2::text,
         'crm_attempts', coalesce((meta->>'crm_attempts')::int, 0) + 1)
        WHERE id = $1`, [id, String(e.message).slice(0, 300)]);
    return { error: e.message };
  }
}

/* Send this call now — the disposition was just saved. Claims the row the
   same way the sweeper does, so a sweep running at the same instant cannot
   send it twice; the three-minute settle is skipped, since the rep has
   finished. Returns null when there is nothing to do (sync off, not a
   RingCentral call, already sent). */
async function sendNow(id) {
  if (!zoho.ENABLED) return null;
  const cfg = await config();
  if (!cfg.on || !cfg.since) return null;
  const claimed = (await query(
    `UPDATE activity_log a SET meta = coalesce(a.meta, '{}'::jsonb)
            || jsonb_build_object('crm_state', 'sending', 'crm_claimed_at', now())
      WHERE a.id = $2
        AND ${ELIGIBLE_NOW}
        AND (a.meta->>'crm_state' IS DISTINCT FROM 'sending'
             OR (a.meta->>'crm_claimed_at')::timestamptz < now() - interval '10 minutes')
      RETURNING a.id`, [cfg.since, id])).rows[0];
  if (!claimed) return null;
  return sendClaimed(id);
}

/* A call sent before RingCentral published its recording: add the link to
   the same Zoho record once it exists. Gives up after REC_WINDOW_MIN. */
async function backfillRecordings() {
  const rows = (await query(`${ROW}
     WHERE a.action = 'call' AND a.meta->>'crm_rec_pending' = 'true'
       AND a.meta ? 'crm_call_id'
     ORDER BY a.at LIMIT ${BATCH}`)).rows;
  for (const row of rows) {
    const old = Date.now() - recClock(row) > REC_WINDOW_MIN * 60e3;
    if (old || +(row.meta.crm_rec_tries || 0) >= 6) {
      /* Say why it stopped, so the Zoho CRM panel can show it: usually the
         call was simply not recorded in RingCentral. */
      await query(`UPDATE activity_log SET meta = meta || jsonb_build_object('crm_rec_pending', false,
          'crm_rec_error', coalesce(meta->>'crm_rec_error', $2::text)) WHERE id = $1`,
        [row.id, `RingCentral had no recording of this call ${REC_WINDOW_MIN} minutes after it ended — was it recorded?`]);
      continue;
    }
    try {
      const recId = await recordingFor(row);
      if (!recId) continue;                  // not published yet; next minute
      if (row.meta.crm_rec_linked !== LINK_V) {
        const { call, recording } = await buildCall(row, { recId });
        await people.writeAs(row.user_id, "/Calls", { method: "PUT", body: JSON.stringify({ data: [{
          id: row.meta.crm_call_id, ...(recording ? { Voice_Recording__s: recording } : {}), Description: call.Description }] }) });
        await query(`UPDATE activity_log SET meta = meta || jsonb_build_object('crm_rec_linked', $2::text) WHERE id = $1`, [row.id, LINK_V]);
      }
      await attachAndMark(row, row.meta.crm_call_id, recId);
    } catch (e) { console.warn("[karma] crm recording update:", e.message); }
  }
}

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
      const r = await sendClaimed(id);
      if (r.sent) sent++; else failed++;
    }
    await backfillRecordings();
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
               count(*) FILTER (WHERE meta ? 'crm_rec_attached')::int AS rec_attached,
               count(*) FILTER (WHERE meta->>'crm_rec_pending' = 'true')::int AS rec_pending,
               count(*) FILTER (WHERE meta ? 'crm_call_id' AND NOT (meta ? 'crm_rec_attached')
                                  AND meta->>'crm_rec_pending' IS DISTINCT FROM 'true'
                                  AND at > now() - interval '30 days')::int AS rec_missing,
               max((meta->>'crm_synced_at')::timestamptz) AS last_synced_at
          FROM activity_log
         WHERE action = 'call' AND meta->>'provider' = 'ringcentral' AND at >= $1`, [since])).rows[0];
      const le = (await query(`
        SELECT meta->>'crm_error' AS e FROM activity_log
         WHERE action = 'call' AND meta->>'crm_state' = 'error' AND at >= $1
         ORDER BY at DESC LIMIT 1`, [since])).rows[0];
      /* Recordings travel separately (attachRecording), and their failures
         were kept on the row with nowhere to see them. */
      const re = (await query(`
        SELECT meta->>'crm_rec_error' AS e, at FROM activity_log
         WHERE action = 'call' AND meta ? 'crm_rec_error' AND NOT (meta ? 'crm_rec_attached') AND at >= $1
         ORDER BY at DESC LIMIT 1`, [since])).rows[0];
      stats = { synced: s.synced, today: s.today, pending: s.pending, errors: s.errors,
        lastError: le?.e || null, lastSyncedAt: s.last_synced_at,
        recAttached: s.rec_attached, recPending: s.rec_pending, recMissing: s.rec_missing,
        lastRecError: re ? { error: re.e, at: re.at } : null };
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
/* POST /api/crm/sync/recordings/retry — look again for the recordings of
   calls already in Zoho without one (last 30 days): the search had given
   up, or an older upload method had failed. Each goes back to "waiting"
   for another 30 minutes from now; the sweeper attaches what RingCentral
   has, and a call that was never recorded ends up with the same "no
   recording" note as before. */
router.post("/api/crm/sync/recordings/retry", requireAdmin, async (req, res, next) => {
  try {
    const cfg = await config();
    if (!cfg.since) return res.json({ queued: 0 });
    const { rows } = await query(
      `UPDATE activity_log
          SET meta = (meta - 'crm_rec_error') || jsonb_build_object(
                'crm_rec_pending', true, 'crm_rec_tries', 0, 'crm_rec_retry_at', now())
        WHERE action = 'call' AND meta->>'provider' = 'ringcentral' AND at >= $1::timestamptz
          AND at > now() - interval '30 days'
          AND meta ? 'crm_call_id' AND NOT (meta ? 'crm_rec_attached')
          AND meta->>'crm_rec_pending' IS DISTINCT FROM 'true'
        RETURNING id`, [cfg.since]);
    res.json({ queued: rows.length });
  } catch (e) { next(e); }
});

router.get("/api/crm/sync/preview", requireAdmin, async (req, res, next) => {
  try {
    if (!zoho.ENABLED) return res.status(503).json({ error: "Zoho CRM is not configured on this server" });
    const cfg = await config();
    const since = cfg.since || new Date(Date.now() - 7 * 86400e3).toISOString();
    const rows = (await query(`${ROW} WHERE ${ELIGIBLE} ORDER BY a.at DESC LIMIT 5`, [since])).rows;
    const items = [];
    for (const row of rows) {
      const as = row.rep_crm ? { as: "rep", asName: row.rep_crm } : { as: "shared" };
      try { items.push({ at: row.at, rep: row.rep_name, lead: row.lead_name, ...as, ...(await buildCall(row)) }); }
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

/* Create (or link) the Zoho Lead for one of our leads. Shared by the route
   below and the Prospect disposition. Throws an Error with .status. */
async function createLead(user, id, { first_name, last_name, email } = {}) {
  const fail = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
  if (!zoho.ENABLED) throw fail(503, "Zoho CRM is not configured on this server");
  const cfg = await config();
  if (!cfg.on) throw fail(409, "Zoho CRM sync is off — an owner can turn it on in Call logs.");
  const first = String(first_name || "").trim().slice(0, 40);
  const last = String(last_name || "").trim().slice(0, 80);
  const mail = String(email || "").trim().slice(0, 100);
  if (!last) throw fail(400, "Last name is required to create a CRM lead.");
  if (mail && !EMAIL_RE.test(mail)) throw fail(400, "That email doesn't look right.");

  const lead = (await query(
    `SELECT id, lead_code, name, company, phone, city, state, website
       FROM leads WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0];
  if (!lead) throw fail(404, "No such lead.");

  /* The CRM may already hold this number — link to it, never duplicate. */
  let link = await zoho.findInCrm(lead.phone);
  if (link.error) throw fail(502, "Couldn't check Zoho CRM for duplicates: " + link.error);
  let created = false, as = null;
  if (!link.module) {
    const rec = {
      First_Name: first || undefined, Last_Name: last, Email: mail || undefined,
      Company: lead.company || lead.name || `${first} ${last}`.trim(),
      Phone: lead.phone || undefined, City: lead.city || undefined, State: lead.state || undefined,
      Website: lead.website || undefined,
      Lead_Source: "Cold Call", Lead_Status: "Contacted",
      Description: `Created from Karma Connect by ${user.name || user.email} after a connected call on ${new Date().toISOString().slice(0, 10)}.`,
    };
    /* Created as the rep when they have signed in to Zoho, so the Lead is
       theirs; the duplicate check above stays on the service account. */
    const w = await people.writeAs(user.id, "/Leads", { method: "POST", body: JSON.stringify({ data: [rec] }) });
    const d = w.d?.data?.[0];
    as = w.as;
    if (d?.code === "DUPLICATE_DATA" && d.details?.id) {
      link = { module: "Leads", id: String(d.details.id), name: rec.Company };
    } else if (!d || d.status !== "success") {
      throw fail(502, "Zoho CRM refused the lead: " + (d?.message || d?.code || "unknown"));
    } else {
      link = { module: "Leads", id: String(d.details.id), name: `${first} ${last}`.trim() };
      created = true;
    }
  }

  /* Point this rep's latest call to the lead at the record, so the call
     lands in the CRM attached to it (buildCall reads meta.crm_link). */
  await query(
    `UPDATE activity_log SET meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('crm_link', $3::jsonb)
      WHERE id = (SELECT id FROM activity_log WHERE action = 'call' AND lead_id = $1 AND actor = $2
                   AND at > now() - interval '2 hours' ORDER BY at DESC LIMIT 1)`,
    [id, user.email, JSON.stringify({ module: link.module, id: link.id, name: link.name || null })]);
  await activity.log({
    actor: user.email, user_id: user.id, action: "note",
    lead_id: lead.id, lead_code: lead.lead_code, lead_name: lead.name,
    to_value: created ? "Zoho CRM lead created" : "Linked to existing Zoho CRM record",
    meta: { note: created ? `Created Zoho CRM lead: ${`${first} ${last}`.trim()}${mail ? " <" + mail + ">" : ""}`
      : `Already in Zoho CRM (${link.module}: ${link.name || link.id}) — linked, not duplicated`,
      crm_link: { module: link.module, id: link.id } },
  });
  return { ok: true, created, module: link.module, id: link.id, name: link.name || null,
    ...(created ? { as } : {}) };
}

router.post("/api/leads/:id/crm-lead", requireUser, express.json({ limit: "4kb" }), async (req, res, next) => {
  try {
    res.json(await createLead(req.user, +req.params.id, req.body || {}));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

module.exports = { router, startSweeper, tick, sendNow, createLead, _test: { buildCall, RESULT, mmss, zIso } };
