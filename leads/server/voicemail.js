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
  const tok = await rc.accessFor(row.user_id || m.reader_uid);
  const r = await fetch(`${rc.SERVER}/restapi/v1.0/account/~/extension/${m.vm_ext || "~"}/message-store/${m.vm_msg}`,
    { headers: { Authorization: "Bearer " + tok.access_token } });
  if (!r.ok) throw new Error(r.status === 403
    ? "RingCentral refused the voicemail — the app needs the Read Messages permission"
    : r.status === 404 ? "RingCentral has no such voicemail" : `RingCentral voicemail ${r.status}`);
  return { msg: await r.json(), tok };
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
