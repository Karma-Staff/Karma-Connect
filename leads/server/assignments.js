"use strict";
/* The assignments board — who on the team is carrying what, and how much work
   is sitting unclaimed. Admin only: it is a manager's view of the whole base,
   not a member's view of their own queue.

   READ ONLY, deliberately. Assigning still goes through POST /api/bulk/assign,
   which already blocklists nothing, writes exactly one activity_log row per
   action, skips no-op re-assignments and invalidates the counts cache.
   CLAUDE.md is explicit that bulk actions repeat the single-lead rules rather
   than shortcutting them, so a second write path here would be the wrong move
   — there is only one way to change an owner, and this board calls it.

   The predicates come from leads.js's FOCUS for the same reason: those tile
   definitions are already duplicated three times and restating them here would
   make a fourth place to forget. */

const express = require("express");
const { query } = require("./db");
const auth = require("./auth");
const { FOCUS } = require("./leads");

const router = express.Router();

/* Every lead query filters deleted_at IS NULL (the trash bin) or binned leads
   come back as phantoms — and NOT removed keeps DNC-banned leads out of a
   workload the manager is about to hand to somebody. Same base the list uses. */
const BASE = "NOT removed AND deleted_at IS NULL";

router.get("/api/assignments", auth.requireAdmin, async (req, res, next) => {
  try {
    /* One pass over leads, grouped by owner. `worked` is "not New" rather than
       a FOCUS predicate because there is no tile for it — it is the counterpart
       of ready, telling the manager how much of someone's pile has been
       touched at all. */
    const rows = (await query(
      `SELECT nullif(btrim(owner), '') AS owner,
              count(*)::int                                          AS total,
              count(*) FILTER (WHERE ${FOCUS.ready})::int            AS ready,
              count(*) FILTER (WHERE ${FOCUS.enrich})::int           AS enrich,
              count(*) FILTER (WHERE status <> 'New')::int           AS worked
         FROM leads
        WHERE ${BASE}
        GROUP BY 1`)).rows;

    /* Team accounts are listed even at zero leads — somebody with nothing to do
       is exactly who a manager is looking for on this screen, and they would be
       invisible in a GROUP BY over leads. Disabled accounts stay out. */
    const team = (await query(
      `SELECT email, display_name FROM app_users
        WHERE NOT disabled
        ORDER BY coalesce(display_name, email)`)).rows;

    const byOwner = new Map(rows.filter((r) => r.owner).map((r) => [r.owner, r]));
    const unassignedRow = rows.find((r) => !r.owner)
      || { total: 0, ready: 0, enrich: 0, worked: 0 };

    const zero = { total: 0, ready: 0, enrich: 0, worked: 0 };
    const people = [];
    const seen = new Set();
    for (const t of team) {
      seen.add(t.email);
      const r = byOwner.get(t.email) || zero;
      people.push({
        value: t.email, label: t.display_name || t.email, team: true,
        total: r.total, ready: r.ready, enrich: r.enrich, worked: r.worked,
      });
    }
    /* Owner strings that are nobody's account — names typed into the old
       system, or people who have left. They hold real leads, so a manager has
       to be able to see and redistribute them; they just are not assignable
       targets. Same population /api/owners surfaces, and the same reason. */
    for (const r of rows) {
      if (!r.owner || seen.has(r.owner)) continue;
      people.push({
        value: r.owner, label: r.owner, team: false,
        total: r.total, ready: r.ready, enrich: r.enrich, worked: r.worked,
      });
    }

    const assigned = people.reduce((a, p) => a + p.total, 0);
    res.json({
      people,
      unassigned: {
        total: unassignedRow.total,
        ready: unassignedRow.ready,
        enrich: unassignedRow.enrich,
      },
      totals: {
        leads: assigned + unassignedRow.total,
        assigned,
        members: people.filter((p) => p.team).length,
      },
    });
  } catch (e) { next(e); }
});

module.exports = { router };
