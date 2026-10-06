"use strict";
/* Missed calls and voicemails: the callers nobody picked up.

   The dialler logs a call it placed or answered. A lead ringing back while
   nobody is at the screen — or declined to voicemail — left no trace at
   all: not in the lead's history, not in Zoho CRM, no reminder to call
   back. These are the warmest people on the list.

   RingCentral's own call log has every one of them, so this reads it
   (the same cached per-day log the Dashboard and Call logs use — no extra
   requests while a screen has it open) every two minutes and, for each
   inbound call that was not answered:

     - logs it on activity_log as a call: meta.direction "inbound",
       meta.missed, meta.voicemail when the caller left one, meta.rc_id so
       it is logged once. Matched to the lead by the caller's number.
       The actor is "ringcentral", not the rep it rang (meta.agent): a
       missed call is not a call the rep made, and must not count as one
       in their call report.
     - the Zoho CRM sweeper then sends it as a Missed call, with the
       voicemail attached when there is one (crm-sync.js).
     - the lead's owner gets a follow-up due now — "call them back" — in
       their reminders, unless one is already open.

   Nothing before the first run is backfilled (app_settings "missed.since").
   Reading the account's log needs one connected RingCentral user allowed to
   see it (an admin); each connected user is tried until one can. */

const { query } = require("./db");
const settings = require("./settings");
const dash = require("./rc-dashboard");

const TICK_MS = 120e3;
const TZ = process.env.CALL_TZ || "America/New_York";
const KEY = "missed.since";
const ANSWERED = new Set(["Accepted", "Call connected"]);
const digits10 = (v) => String(v || "").replace(/\D/g, "").slice(-10);

let reader = null;                       // the user whose token last read the log

async function readDay(ymd) {
  const ids = (await query(
    `SELECT user_id FROM voice_identities WHERE provider = 'ringcentral'
      ORDER BY last_used_at DESC NULLS LAST`)).rows.map((r) => r.user_id);
  const order = reader && ids.includes(reader) ? [reader, ...ids.filter((x) => x !== reader)] : ids;
  let last = null;
  for (const uid of order) {
    try {
      const recs = await dash.fetchDay(uid, ymd, TZ, "account");
      reader = uid;
      return recs;
    } catch (e) { last = e; }
  }
  if (last) throw last;
  return [];
}

const ymdOf = (ms) => { const w = dash.wall(ms, TZ); return `${w.year}-${w.month}-${w.day}`; };

/* One pass. Returns what it did, for the log and the tests. */
async function tick(now = Date.now()) {
  let since = await settings.get(KEY, null);
  if (!since) {
    since = new Date(now).toISOString();
    await settings.set(KEY, since, "missed-calls");
    return { started: since, logged: 0 };
  }
  const sinceMs = Date.parse(since);
  const days = [...new Set([ymdOf(now - 864e5), ymdOf(now)])];
  const recs = [];
  for (const d of days) recs.push(...await readDay(d));

  // one per RingCentral record, however the days it was read in overlap
  const missed = [...new Map(recs.filter((c) => c.dir === "Inbound" && !ANSWERED.has(c.res) && c.id
    && c.t >= sinceMs && c.t + c.dur * 1000 < now - 60e3).map((c) => [String(c.id), c])).values()];
  if (!missed.length) return { logged: 0 };
  const seen = new Set((await query(
    `SELECT meta->>'rc_id' AS id FROM activity_log
      WHERE action = 'call' AND at > $1::timestamptz - interval '2 days' AND meta->>'rc_id' = ANY($2)`,
    [since, missed.map((c) => String(c.id))])).rows.map((r) => r.id));

  let logged = 0, reminders = 0;
  for (const c of missed) {
    if (seen.has(String(c.id))) continue;
    const d = digits10(c.fromNum);
    const lead = d.length === 10 ? (await query(
      `SELECT id, lead_code, name, owner FROM leads
        WHERE deleted_at IS NULL AND NOT removed
          AND right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = $1
        ORDER BY id LIMIT 1`, [d])).rows[0] || null : null;
    const agent = c.extId ? (await query(
      `SELECT u.email FROM voice_identities v JOIN app_users u ON u.id = v.user_id
        WHERE v.rc_owner_id = $1`, [String(c.extId)])).rows[0] || null : null;
    const voicemail = c.res === "Voicemail" || !!c.vm;
    await query(
      `INSERT INTO activity_log (at, actor, user_id, action, lead_id, lead_code, lead_name, to_value, meta)
       VALUES ($1, 'ringcentral', NULL, 'call', $2, $3, $4, $5, $6)`,
      [new Date(c.t + c.dur * 1000), lead?.id || null, lead?.lead_code || null, lead?.name || c.fromName || null,
        voicemail ? "voicemail" : "missed",
        JSON.stringify({ outcome: "no-answer", seconds: 0, provider: "ringcentral", direction: "inbound",
          missed: true, voicemail, rc_id: String(c.id), number: c.fromNum || null,
          agent: agent?.email || c.toName || null, rang: c.toNum || null,
          ...(c.vm ? { vm_msg: c.vm, vm_ext: c.extId ? String(c.extId) : null } : {}),
          reader_uid: reader })]);
    logged++;

    /* the person whose lead it is gets a reminder to ring back — one open
       reminder per lead is enough, however many times they called */
    const owner = String(lead?.owner || "").trim();
    if (lead && owner) {
      const open = (await query(
        `SELECT 1 FROM lead_followups WHERE lead_id = $1
            AND sent_at IS NULL AND done_at IS NULL AND cancelled_at IS NULL LIMIT 1`, [lead.id])).rows[0];
      if (!open) {
        await query(
          `INSERT INTO lead_followups (lead_id, owner, due_at, note, created_by)
           VALUES ($1, $2, now(), $3, 'missed-calls')`,
          [lead.id, owner, voicemail ? "Left you a voicemail — call them back" : "Missed call — call them back"]);
        reminders++;
      }
    }
  }
  return { logged, reminders };
}

let running = false;
function startSweeper() {
  if (process.env.KARMA_NO_SWEEP === "1") return;
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(); }
    catch (e) { if (e.status !== 428) console.warn("[karma] missed calls:", e.message); }
    finally { running = false; }
  }, TICK_MS).unref();
}

module.exports = { startSweeper, tick };
