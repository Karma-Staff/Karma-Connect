"use strict";
/* "My tasks" — one rep's own working queue.

   Every other list answers "what leads match these filters". This one answers
   "what should I do next", which is a different question and gets a different
   shape: a short starred list, a work queue in neglect order, and what the
   person has already done today so the screen is not purely a demand.

   Scoped to the CALLER, always — including an admin, who gets their own queue
   here rather than the team's. The team's view is /api/calls/report. That is
   why this file never looks at req.user.role: there is no version of "my
   tasks" that is somebody else's.

   Neglect order is the point of the queue: a lead nobody has opened outranks
   one touched this morning. `recents` already holds that per-account trail, so
   a LEFT JOIN gives NULL for never-touched and those sort first. */

const express = require("express");
const { query } = require("./db");
const { requireUser } = require("./auth");

const router = express.Router();

// enough to work a morning; the full list is a click away on Companies
const LIMIT = 50;

/* Statuses that still want an action. 'Qualified' and 'Not interested' are
   both finished states — one won, one closed — and neither belongs in a queue
   of things to do. */
const OPEN_STATUSES = ["New", "Contacted", "Responded"];

router.get("/api/tasks", requireUser, async (req, res, next) => {
  try {
    const email = String(req.user.email || "").trim();
    /* The same ownership test the rest of the app uses, written once per
       alias rather than patched into the SQL afterwards. */
    const owned = (t) =>
      `btrim(${t}owner) = $1 AND NOT ${t}removed AND ${t}deleted_at IS NULL`;
    const mine = owned("");

    /* The queue. NULLS FIRST is doing the real work: a lead this person has
       never opened is the most neglected thing they own. */
    const queue = (await query(
      `SELECT l.*, r.touched_at
         FROM leads l
         LEFT JOIN recents r ON r.lead_id = l.id AND r.user_id = $2
        WHERE ${owned("l.")} AND l.status = ANY($3)
        ORDER BY r.touched_at ASC NULLS FIRST, l.date_added DESC NULLS LAST, l.id
        LIMIT ${LIMIT}`,
      [email, req.user.id, OPEN_STATUSES])).rows;

    /* Favourites: the rep's own pins, whatever their status — a starred lead
       that is already Qualified is still one they want to find again. */
    const starred = (await query(
      `SELECT * FROM leads
        WHERE ${mine} AND favorite
        ORDER BY date_added DESC NULLS LAST, id
        LIMIT ${LIMIT}`, [email])).rows;

    /* The whole book by status, so the numbers on the tiles agree with what
       opening each one shows. */
    const byStatus = (await query(
      `SELECT coalesce(nullif(btrim(status), ''), 'New') AS status, count(*)::int AS n
         FROM leads WHERE ${mine} GROUP BY 1`, [email])).rows;

    /* What they have already done today, from the same log the manager reads
       — so the two screens can never disagree about a person's day. */
    const done = (await query(
      `SELECT count(*) FILTER (WHERE action = 'call')::int                    AS calls,
              count(*) FILTER (WHERE action = 'call'
                               AND meta->>'outcome' = 'connected')::int       AS connected,
              count(*) FILTER (WHERE action = 'status')::int                  AS statuses,
              count(*) FILTER (WHERE action = 'note')::int                    AS notes,
              count(DISTINCT lead_id) FILTER (WHERE action <> 'open')::int    AS leads_worked
         FROM activity_log
        WHERE actor = $1 AND at >= date_trunc('day', now())`, [email])).rows[0];

    const counts = { assigned: 0 };
    for (const r of byStatus) {
      counts[r.status] = r.n;
      counts.assigned += r.n;
    }
    counts.open = OPEN_STATUSES.reduce((a, s) => a + (counts[s] || 0), 0);

    /* Follow-backs due or overdue. Above everything else on the screen,
       because a reminder the rep asked for outranks a queue we ordered for
       them — and because the email that fired this morning has scrolled
       out of their inbox by now. */
    const followups = (await query(
      `SELECT f.id, f.lead_id, f.due_at, f.note, f.sent_at,
              l.kind, l.lead_code, l.name, l.company, l.city, l.state, l.status, l.phone
         FROM lead_followups f
         JOIN leads l ON l.id = f.lead_id
        WHERE f.owner = $1 AND f.done_at IS NULL AND f.cancelled_at IS NULL
          AND l.deleted_at IS NULL AND NOT l.removed
          AND f.due_at <= now() + interval '7 days'
        ORDER BY f.due_at
        LIMIT 25`, [email])).rows;

    res.json({ queue, starred, followups, counts, done, limit: LIMIT });
  } catch (e) { next(e); }
});

module.exports = { router };
