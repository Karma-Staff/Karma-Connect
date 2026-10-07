"use strict";
/* A voicemail a caller left on a missed call (missed.js), from RingCentral's
   message store: its audio, and the text when RingCentral transcribed it.

   Used by the Zoho CRM sync (the audio goes on the Zoho call, the text in
   its description) and by the dialler's Missed calls list (play it, read
   it). Needs the RingCentral app's Read Messages permission; without it
   message() throws with a sentence that says so. Read through whoever read
   the call log, since a missed call is nobody's call. The text, once read,
   is kept on the call's row (meta.vm_text) so it is fetched once. */

const { query } = require("./db");
const rc = require("./ringcentral");

async function message(row) {
  const m = row.meta || {};
  if (!m.missed || !m.vm_msg) return null;
  /* A missed call is nobody's call (user_id is NULL), so there is no single
     "right" login to read its voicemail. Try the connected RingCentral
     accounts in turn — the one stored when it was logged first, then the
     extension's own owner, then admins/owners (whose token can read any
     extension's message store), then the rest — like recordings do. One bad
     or under-permissioned login no longer means the voicemail won't play. */
  const ids = (await query(
    `SELECT v.user_id FROM voice_identities v
       JOIN app_users u ON u.id = v.user_id
       LEFT JOIN organization_memberships mm ON mm.user_id = u.id
      WHERE v.provider = 'ringcentral' AND NOT u.disabled
      ORDER BY (v.user_id = $1) DESC, (v.rc_owner_id = $2) DESC,
               (mm.role IN ('owner', 'admin')) DESC, v.last_used_at DESC NULLS LAST`,
    [row.user_id || m.reader_uid || 0, m.vm_ext || ""])).rows.map((r) => r.user_id);
  if (!ids.length) throw new Error("No RingCentral account is connected to read voicemails");
  let last = null;
  for (const uid of ids) {
    try {
      const tok = await rc.accessFor(uid);
      const r = await fetch(`${rc.SERVER}/restapi/v1.0/account/~/extension/${m.vm_ext || "~"}/message-store/${m.vm_msg}`,
        { headers: { Authorization: "Bearer " + tok.access_token } });
      if (r.ok) return { msg: await r.json(), tok };
      const err = Object.assign(new Error(r.status === 403
        ? "RingCentral refused the voicemail — the app/account needs the Read Messages permission"
        : r.status === 404 ? "RingCentral has no such voicemail" : `RingCentral voicemail ${r.status}`), { status: r.status });
      /* Keep a 403 once seen: a permission refusal is the actionable cause, and
         a later login's 404 would hide it. */
      if (!last || last.status !== 403) last = err;
    } catch (e) { if (!last || last.status !== 403) last = e; }
  }
  throw last || new Error("Couldn't read the voicemail from RingCentral");
}

/* The audio, as a fetch Response to pass on (or read). */
async function audio(row) {
  const v = await message(row);
  const a = (v?.msg.attachments || []).find((x) => x.type === "AudioRecording");
  if (!a) throw Object.assign(new Error("RingCentral has no audio for this voicemail"), { final: true });
  const r = await fetch(a.uri, { headers: { Authorization: "Bearer " + v.tok.access_token } });
  if (!r.ok) throw new Error(r.status === 403
    ? "RingCentral refused the voicemail download (Read Messages permission)"
    : `RingCentral voicemail ${r.status}`);
  return r;
}

/* The text, when RingCentral made one — best-effort, and kept once read. */
async function text(row) {
  if (row.meta?.vm_text) return row.meta.vm_text;
  try {
    const v = await message(row);
    const a = (v?.msg.attachments || []).find((x) => x.type === "AudioTranscription");
    if (!a) return null;
    const r = await fetch(a.uri, { headers: { Authorization: "Bearer " + v.tok.access_token } });
    const t = r.ok ? (await r.text()).trim().slice(0, 4000) : "";
    if (t && row.id) await query(
      `UPDATE activity_log SET meta = meta || jsonb_build_object('vm_text', $2::text) WHERE id = $1`, [row.id, t]);
    return t || null;
  } catch (e) { return null; }
}

module.exports = { message, audio, text };
