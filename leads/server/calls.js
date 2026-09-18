"use strict";
/* Calls: recording them, and the manager's view of them.

   A call is an activity_log row with action 'call' (migration 005). It is not
   a table of its own because everything a manager asks about a call — who,
   which lead, when — the log already models, and the Team activity feed then
   shows calls beside status changes and notes for free.

   Recording is CLIENT-REPORTED, and that is a real limitation worth naming:
   the browser holding the softphone is the only thing that knows a call ended
   and whether it connected, so a rep dialling any other way produces no rows.
   Nothing here can detect that, which is why the report below counts callers
   rather than implying the silent ones made no calls.

   The outcome vocabulary is closed. An unknown value becomes 'failed' rather
   than being stored, so the report cannot be skewed by whatever string a
   future SDK version decides to emit. */

const express = require("express");
const { query } = require("./db");
const { requireUser, requireAdmin } = require("./auth");
const activity = require("./activity");

const router = express.Router();

/* 'placed' is the honest answer for the hand-off diallers: we opened Zoho's
   own dialler and the conversation happened somewhere we cannot observe, so
   the attempt is recorded and the connection is not claimed. */
const OUTCOMES = ["connected", "no-answer", "busy", "failed", "cancelled", "placed"];
// a call longer than this is a forgotten tab, not a conversation
const MAX_SECONDS = 4 * 60 * 60;

/* POST /api/leads/:id/call — the softphone reporting how a call went.
   Mounted under /api/leads/:id, so leads.js's requireOwnLead has already
   refused members a lead they do not own: a rep cannot log calls against
   somebody else's account. */
router.post("/api/leads/:id/call", requireUser, express.json({ limit: "4kb" }),
  async (req, res, next) => {
    try {
      const id = +req.params.id;
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad lead id" });
      const lead = (await query(
        "SELECT id, lead_code, name, owner FROM leads WHERE id = $1 AND deleted_at IS NULL",
        [id])).rows[0];
      if (!lead) return res.status(404).json({ error: "no such lead" });

      const b = req.body || {};
      const outcome = OUTCOMES.includes(b.outcome) ? b.outcome : "failed";
      const seconds = Math.max(0, Math.min(MAX_SECONDS, Math.floor(Number(b.seconds) || 0)));

      await activity.log({
        actor: req.user.email,
        user_id: req.user.id,
        action: "call",
        lead_id: lead.id,
        lead_code: lead.lead_code,
        lead_name: lead.name,
        to_value: outcome,           // shown directly in the activity feed
        meta: {
          outcome,
          seconds,
          provider: String(b.provider || "zoho").slice(0, 24),
          call_id: b.call_id ? String(b.call_id).slice(0, 120) : null,
          number: b.number ? String(b.number).slice(0, 32) : null,
        },
      });
      res.json({ ok: true, outcome, seconds });
    } catch (e) { next(e); }
  });

/* GET /api/calls/report — the manager's screen. Admin only: it is the whole
   team's activity, which is precisely what a member may not see.

   Three questions, three queries over the same log:
     today   — who called, how many, how many connected, total talk time
     live    — who has been active in the last N minutes, and on which lead
     roster  — who exists, so someone who called nobody is visible as a zero
               rather than missing from the list entirely
*/
router.get("/api/calls/report", requireAdmin, async (req, res, next) => {
  try {
    const liveMinutes = Math.max(1, Math.min(240, +req.query.minutes || 15));

    /* "Today" in the server's timezone. Render runs UTC, which can put an
       evening call into tomorrow for a team further east — worth knowing
       before anyone reconciles these against a phone bill. */
    const today = (await query(
      `SELECT actor,
              count(*)::int                                            AS calls,
              count(*) FILTER (WHERE meta->>'outcome' = 'connected')::int AS connected,
              count(*) FILTER (WHERE meta->>'outcome' = 'placed')::int     AS placed,
              coalesce(sum((meta->>'seconds')::int), 0)::int           AS seconds
         FROM activity_log
        WHERE action = 'call' AND at >= date_trunc('day', now())
        GROUP BY actor`)).rows;

    /* Recent activity of ANY kind, not just calls: a rep reading a lead or
       changing a status is working, and a live view that only lit up during a
       call would show an empty floor most of the time. */
    const live = (await query(
      `SELECT DISTINCT ON (actor)
              actor, action, lead_id, lead_code, lead_name, at,
              meta->>'outcome' AS outcome
         FROM activity_log
        WHERE at >= now() - ($1 || ' minutes')::interval
        ORDER BY actor, at DESC`, [String(liveMinutes)])).rows;

    /* The roster, with how much work each person is holding — the same
       ownership equality the rest of the app uses on the free-text column. */
    const roster = (await query(
      `SELECT u.email, u.display_name, m.role,
              (SELECT count(*) FROM leads l
                WHERE btrim(l.owner) = u.email AND l.deleted_at IS NULL
                  AND NOT l.removed)::int AS assigned
         FROM app_users u
         LEFT JOIN organization_memberships m ON m.user_id = u.id
        WHERE NOT u.disabled
        ORDER BY coalesce(u.display_name, u.email)`)).rows;

    const byActor = new Map(today.map((r) => [r.actor, r]));
    const liveBy = new Map(live.map((r) => [r.actor, r]));
    const people = roster.map((u) => {
      const t = byActor.get(u.email) || { calls: 0, connected: 0, placed: 0, seconds: 0 };
      const l = liveBy.get(u.email) || null;
      return {
        email: u.email,
        label: u.display_name || u.email,
        role: u.role || "member",
        assigned: u.assigned,
        calls: t.calls, connected: t.connected, placed: t.placed, seconds: t.seconds,
        active: l ? { action: l.action, leadId: l.lead_id, leadCode: l.lead_code,
          leadName: l.lead_name, at: l.at, outcome: l.outcome } : null,
      };
    });

    /* Callers who are not accounts — an owner string from the old system, or
       somebody removed since. They made calls, so hiding them would make the
       totals disagree with the rows. */
    const known = new Set(roster.map((u) => u.email));
    for (const t of today) {
      if (known.has(t.actor)) continue;
      people.push({ email: t.actor, label: t.actor, role: "—", assigned: 0,
        calls: t.calls, connected: t.connected, placed: t.placed, seconds: t.seconds,
        active: null, ghost: true });
    }

    res.json({
      liveMinutes,
      totals: {
        calls: today.reduce((a, r) => a + r.calls, 0),
        connected: today.reduce((a, r) => a + r.connected, 0),
        /* Dials we handed to Zoho's own dialler. While this is non-zero the
           connected figure is a floor, not a rate — see ZOHO_DIAL_MODE. */
        placed: today.reduce((a, r) => a + r.placed, 0),
        seconds: today.reduce((a, r) => a + r.seconds, 0),
        callers: today.length,
        members: roster.length,
        activeNow: live.length,
      },
      people,
    });
  } catch (e) { next(e); }
});

module.exports = { router, OUTCOMES };
