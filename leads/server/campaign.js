"use strict";
/* Call sessions — working a list of leads straight through, the way a
   campaign actually gets run.

   Before this, calling a hundred assigned leads meant a hundred rounds of:
   find the next one in the list, open it, read it, dial, write the outcome
   somewhere, go back, remember where you were. The finding and the
   remembering are the whole cost, and neither is the job.

   A session removes both. One lead on screen at a time, its number ready,
   and an outcome that logs the call, sets the status, optionally books a
   follow-back, and moves on — in one press.

   It does NOT auto-dial the next number. That is deliberate. A dialler that
   rings the next stranger the instant you hang up is a compliance question
   in every US state, the browser will not give a microphone to a call the
   user did not ask for, and a rep who steps away comes back to a call in
   progress. Everything around the call is automatic; starting it is a
   person's decision. */

const express = require("express");
const { query } = require("./db");
const { requireUser, rankOf, RANK } = require("./auth");
const { STATUSES } = require("./dedupe");
const activity = require("./activity");

const router = express.Router();

/* A session is a sitting, not a backlog. The biggest list here is nearly
   2,000 leads — that is a month of calling, and offering it as one session
   would make the progress bar a lie. */
const MAX_SESSION = 250;
const OPEN_STATUSES = ["New", "Contacted", "Responded"];

const me = (req) => String(req.user.email || "").trim();
const seesAll = (req) => rankOf(req.user.role) >= RANK.admin;

/* Everything a session needs about one lead, in a single read. */
async function leadCard(id, actor) {
  const lead = (await query(
    "SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL", [id])).rows[0];
  if (!lead) return null;
  const [brief, notes, last] = await Promise.all([
    query(`SELECT brief FROM lead_research
            WHERE lead_id = $1 AND superseded_at IS NULL`, [id]),
    query(`SELECT body, author_email, created_at FROM lead_comments
            WHERE lead_id = $1 AND deleted_at IS NULL
            ORDER BY created_at DESC LIMIT 3`, [id]),
    /* what happened last time anyone rang them — a rep should not open with
       "is this a good time" to somebody who said no on Tuesday */
    query(`SELECT at, actor, to_value FROM activity_log
            WHERE lead_id = $1 AND action = 'call'
            ORDER BY at DESC LIMIT 1`, [id]),
  ]);
  return {
    lead,
    brief: brief.rows[0] ? brief.rows[0].brief : null,
    notes: notes.rows,
    lastCall: last.rows[0] || null,
  };
}

async function openSession(actor) {
  return (await query(
    "SELECT * FROM call_sessions WHERE actor = $1 AND ended_at IS NULL", [actor])).rows[0] || null;
}

function shape(s, card) {
  return {
    id: s.id, owner: s.owner, pos: s.pos, total: s.lead_ids.length,
    called: s.called, connected: s.connected, skipped: s.skipped,
    filters: s.filters || {}, startedAt: s.started_at,
    done: s.pos >= s.lead_ids.length,
    current: card,
  };
}

/* ---------------- starting ---------------- */

/* How many are callable, before committing to a session. The Start screen
   asks this so nobody presses go on an empty list. */
router.get("/api/campaign/preview", requireUser, async (req, res, next) => {
  try {
    const owner = seesAll(req) ? String(req.query.owner || me(req)).trim() : me(req);
    const n = (await query(
      `SELECT count(*)::int n FROM leads
        WHERE btrim(owner) = $1 AND deleted_at IS NULL AND NOT removed
          AND nullif(btrim(phone), '') IS NOT NULL
          AND status = ANY($2)`, [owner, OPEN_STATUSES])).rows[0].n;
    res.json({ owner, callable: n, max: MAX_SESSION });
  } catch (e) { next(e); }
});

router.post("/api/campaign/start", requireUser, express.json({ limit: "4kb" }),
  async (req, res, next) => {
    try {
      const b = req.body || {};
      /* A member can only work their own list. An admin may work anyone's —
         a manager covering for someone off sick is the case — and the calls
         are logged against the manager, because they made them. */
      const owner = seesAll(req) ? String(b.owner || me(req)).trim() : me(req);
      if (!owner) return res.status(400).json({ error: "no list to call" });

      /* Neglect order, the same as My tasks: the lead nobody has opened is
         the one most worth ringing. recents holds that per account. */
      const rows = (await query(
        `SELECT l.id FROM leads l
           LEFT JOIN recents r ON r.lead_id = l.id AND r.user_id = $3
          WHERE btrim(l.owner) = $1 AND l.deleted_at IS NULL AND NOT l.removed
            AND nullif(btrim(l.phone), '') IS NOT NULL
            AND l.status = ANY($2)
          ORDER BY r.touched_at ASC NULLS FIRST, l.date_added DESC NULLS LAST, l.id
          LIMIT ${MAX_SESSION}`,
        [owner, OPEN_STATUSES, req.user.id])).rows;
      if (!rows.length)
        return res.status(400).json({
          error: `Nothing callable for ${owner} — they need leads with a phone number and an open status.` });

      // one live session per caller; starting a new one closes the old
      await query(
        "UPDATE call_sessions SET ended_at = now() WHERE actor = $1 AND ended_at IS NULL",
        [me(req)]);
      const s = (await query(
        `INSERT INTO call_sessions (actor, owner, lead_ids, filters)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [me(req), owner, rows.map((r) => r.id),
          JSON.stringify({ statuses: OPEN_STATUSES, hasPhone: true })])).rows[0];

      res.json(shape(s, await leadCard(s.lead_ids[0], me(req))));
    } catch (e) { next(e); }
  });

/* ---------------- working it ---------------- */

router.get("/api/campaign/current", requireUser, async (req, res, next) => {
  try {
    const s = await openSession(me(req));
    if (!s) return res.json({ session: null });
    const id = s.lead_ids[s.pos];
    res.json(shape(s, id ? await leadCard(id, me(req)) : null));
  } catch (e) { next(e); }
});

/* One press: log the call, set the status, optionally book a follow-back and
   leave a note, then advance. Doing these as four requests would mean four
   ways to end up half-recorded. */
router.post("/api/campaign/outcome", requireUser, express.json({ limit: "8kb" }),
  async (req, res, next) => {
    try {
      const s = await openSession(me(req));
      if (!s) return res.status(400).json({ error: "no session running" });
      const id = s.lead_ids[s.pos];
      if (!id) return res.json(shape(s, null));

      const b = req.body || {};
      const lead = (await query(
        "SELECT id, lead_code, name, company, status FROM leads WHERE id = $1", [id])).rows[0];
      const skip = b.skip === true;

      if (lead && !skip) {
        // the call itself, in the same shape the softphone reports
        await activity.log({
          actor: me(req), user_id: req.user.id, action: "call",
          lead_id: lead.id, lead_code: lead.lead_code, lead_name: lead.name,
          to_value: String(b.outcome || "no-answer"),
          meta: { outcome: String(b.outcome || "no-answer"), seconds: 0,
            provider: "manual", session: s.id },
        });

        if (STATUSES.includes(b.status) && b.status !== lead.status) {
          await query("UPDATE leads SET status = $1, updated_at = now() WHERE id = $2",
            [b.status, id]);
          await activity.log({
            actor: me(req), user_id: req.user.id, action: "status",
            lead_id: lead.id, lead_code: lead.lead_code, lead_name: lead.name,
            from_value: lead.status, to_value: b.status });
        }

        const note = String(b.note || "").trim().slice(0, 2000);
        if (note) {
          await query(
            `INSERT INTO lead_comments (lead_id, author_email, author_user_id, body)
             VALUES ($1, $2, $3, $4)`, [id, me(req), req.user.id, note]);
        }

        /* "Call me Thursday" is the most valuable thing a call produces, and
           the moment to capture it is now, not after four more calls. */
        if (b.followUpAt) {
          const due = new Date(b.followUpAt);
          if (!Number.isNaN(due.getTime()) && due.getTime() > Date.now() - 60_000) {
            await query(
              `UPDATE lead_followups SET cancelled_at = now()
                WHERE lead_id = $1 AND sent_at IS NULL AND done_at IS NULL AND cancelled_at IS NULL`,
              [id]);
            await query(
              `INSERT INTO lead_followups (lead_id, owner, due_at, note, created_by)
               VALUES ($1, $2, $3, $4, $5)`,
              [id, me(req), due.toISOString(), note.slice(0, 500), me(req)]);
          }
        }
      }

      const connected = !skip && b.outcome === "connected";
      const next = (await query(
        `UPDATE call_sessions
            SET pos = pos + 1,
                called = called + $2, connected = connected + $3, skipped = skipped + $4
          WHERE id = $1 RETURNING *`,
        [s.id, skip ? 0 : 1, connected ? 1 : 0, skip ? 1 : 0])).rows[0];

      const nid = next.lead_ids[next.pos];
      if (!nid) await query("UPDATE call_sessions SET ended_at = now() WHERE id = $1", [s.id]);
      res.json(shape(next, nid ? await leadCard(nid, me(req)) : null));
    } catch (e) { next(e); }
  });

router.post("/api/campaign/end", requireUser, async (req, res, next) => {
  try {
    const s = await openSession(me(req));
    if (!s) return res.json({ ended: false });
    await query("UPDATE call_sessions SET ended_at = now() WHERE id = $1", [s.id]);
    res.json({ ended: true, called: s.called, connected: s.connected,
      skipped: s.skipped, total: s.lead_ids.length, pos: s.pos });
  } catch (e) { next(e); }
});

module.exports = { router, MAX_SESSION, OPEN_STATUSES };
