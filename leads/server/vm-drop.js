"use strict";
/* Voicemail drop: each rep's recorded voicemail message (migration 017).
 *
 * The browser does the work — it records the message, and on a call it plays
 * the recording into the line in place of the microphone (app.js, kdVmDrop).
 * This only keeps the recording, one per person, so it follows the rep to
 * whichever computer they dial from.
 *
 *   GET    /api/voice/vmdrop        → do I have one, how long, when recorded
 *   GET    /api/voice/vmdrop/audio  → the recording itself
 *   PUT    /api/voice/vmdrop        → save (raw audio body), replacing any old one
 *   DELETE /api/voice/vmdrop        → remove it
 *
 * Always the caller's own: there is no way to read or play somebody else's.
 */

const express = require("express");
const { query } = require("./db");
const { requireUser } = require("./auth");

const router = express.Router();

/* A minute and a half of Opus is well under a megabyte; the cap is there so
   a mistaken upload of something else cannot fill the table. */
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_SECONDS = 120;
const AUDIO = /^audio\/(webm|ogg|mp4|mpeg|wav|x-wav|aac)(;.*)?$/i;

router.get("/api/voice/vmdrop", requireUser, async (req, res, next) => {
  try {
    const r = (await query(
      `SELECT mime, seconds, updated_at, octet_length(audio) AS bytes
         FROM voicemail_drops WHERE user_id = $1`, [req.user.id])).rows[0];
    res.json(r ? { has: true, seconds: r.seconds === null ? null : Number(r.seconds),
      updatedAt: r.updated_at, bytes: r.bytes, mime: r.mime } : { has: false });
  } catch (e) { next(e); }
});

router.get("/api/voice/vmdrop/audio", requireUser, async (req, res, next) => {
  try {
    const r = (await query("SELECT audio, mime FROM voicemail_drops WHERE user_id = $1",
      [req.user.id])).rows[0];
    if (!r) return res.status(404).json({ error: "No voicemail recorded yet" });
    res.set("Content-Type", r.mime);
    res.set("Cache-Control", "private, no-store");
    res.send(r.audio);
  } catch (e) { next(e); }
});

router.put("/api/voice/vmdrop", requireUser,
  express.raw({ type: (req) => AUDIO.test(req.get("content-type") || ""), limit: MAX_BYTES }),
  async (req, res, next) => {
    try {
      const mime = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!AUDIO.test(mime) || !Buffer.isBuffer(req.body) || !req.body.length)
        return res.status(400).json({ error: "Send the recording as audio (webm, ogg, mp4, mpeg or wav)." });
      const seconds = Number(req.get("x-seconds"));
      if (Number.isFinite(seconds) && seconds > MAX_SECONDS)
        return res.status(400).json({ error: `Keep the message under ${MAX_SECONDS / 60} minutes.` });
      await query(
        `INSERT INTO voicemail_drops (user_id, audio, mime, seconds, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id) DO UPDATE SET audio = EXCLUDED.audio, mime = EXCLUDED.mime,
           seconds = EXCLUDED.seconds, updated_at = now()`,
        [req.user.id, req.body, mime, Number.isFinite(seconds) ? Math.round(seconds * 100) / 100 : null]);
      res.json({ ok: true, has: true, seconds: Number.isFinite(seconds) ? seconds : null, bytes: req.body.length });
    } catch (e) {
      if (e.type === "entity.too.large") return res.status(413).json({ error: "That recording is too large — keep it short." });
      next(e);
    }
  });

router.delete("/api/voice/vmdrop", requireUser, async (req, res, next) => {
  try {
    await query("DELETE FROM voicemail_drops WHERE user_id = $1", [req.user.id]);
    res.json({ ok: true, has: false });
  } catch (e) { next(e); }
});

module.exports = { router };
