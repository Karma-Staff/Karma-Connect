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

/* The timezone a "day" is measured in. Render runs UTC, so without this an
   evening call lands in tomorrow's report and the morning email is wrong.
   Migration 011 backfilled on America/New_York; changing this moves only the
   boundary of days rolled up from here on, not the ones already stored. */
const TZ = process.env.REPORT_TZ || process.env.DIGEST_TZ || "America/New_York";

/* Rebuild one day's rollup from the log. Idempotent by design — the nightly
   job, a manual backfill and a retry all do the same thing, and a day can be
   rebuilt safely if the log is ever corrected.

   Returns the rows it wrote, because the morning email wants exactly this and
   should not ask a second time and risk a different answer. */
async function rollupDay(day) {
  const { rows } = await query(
    `INSERT INTO call_daily (day, actor, calls, connected, placed, no_answer,
                             busy, failed, cancelled, seconds, leads,
                             first_at, last_at, built_at)
     SELECT call_day(at, $2) AS d, actor,
            count(*)::int,
            count(*) FILTER (WHERE meta->>'outcome' = 'connected')::int,
            count(*) FILTER (WHERE meta->>'outcome' = 'placed')::int,
            count(*) FILTER (WHERE meta->>'outcome' = 'no-answer')::int,
            count(*) FILTER (WHERE meta->>'outcome' = 'busy')::int,
            count(*) FILTER (WHERE meta->>'outcome' = 'failed')::int,
            count(*) FILTER (WHERE meta->>'outcome' = 'cancelled')::int,
            coalesce(sum((meta->>'seconds')::int), 0)::int,
            count(DISTINCT lead_id)::int,
            min(at), max(at), now()
       FROM activity_log
      WHERE action = 'call' AND call_day(at, $2) = $1::date
      GROUP BY 1, 2
     ON CONFLICT (day, actor) DO UPDATE SET
       calls = EXCLUDED.calls, connected = EXCLUDED.connected,
       placed = EXCLUDED.placed, no_answer = EXCLUDED.no_answer,
       busy = EXCLUDED.busy, failed = EXCLUDED.failed,
       cancelled = EXCLUDED.cancelled, seconds = EXCLUDED.seconds,
       leads = EXCLUDED.leads, first_at = EXCLUDED.first_at,
       last_at = EXCLUDED.last_at, built_at = now()
     RETURNING *`, [day, TZ]);
  return rows;
}

/* Today is not in call_daily — it is still changing — so it is counted live
   from the log, with exactly the same expressions the rollup uses. Keeping the
   two in step matters more than the duplication costs: if they drift, the
   screen and the email disagree and nobody knows which to believe. */
const LIVE_TODAY = `
  SELECT actor,
         count(*)::int                                                   AS calls,
         count(*) FILTER (WHERE meta->>'outcome' = 'connected')::int     AS connected,
         count(*) FILTER (WHERE meta->>'outcome' = 'placed')::int        AS placed,
         count(*) FILTER (WHERE meta->>'outcome' = 'no-answer')::int     AS no_answer,
         count(*) FILTER (WHERE meta->>'outcome' = 'busy')::int          AS busy,
         count(*) FILTER (WHERE meta->>'outcome' = 'failed')::int        AS failed,
         count(*) FILTER (WHERE meta->>'outcome' = 'cancelled')::int     AS cancelled,
         coalesce(sum((meta->>'seconds')::int), 0)::int                  AS seconds,
         count(DISTINCT lead_id)::int                                    AS leads
    FROM activity_log
   WHERE action = 'call' AND call_day(at, $1) = call_day(now(), $1)
   GROUP BY actor`;

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
    const days = Math.max(1, Math.min(180, +req.query.days || 30));

    /* Which day is being asked for. Blank means today, and today is the only
       one read live; every other date comes from the stored rollup, so asking
       for last Tuesday returns what last Tuesday actually was rather than
       whatever the log can still be persuaded to say. */
    const todayStr = (await query(
      "SELECT call_day(now(), $1)::text AS d", [TZ])).rows[0].d;
    const asked = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ""))
      ? String(req.query.date) : todayStr;
    const isToday = asked === todayStr;

    const today = isToday
      ? (await query(LIVE_TODAY, [TZ])).rows
      : (await query(
          `SELECT actor, calls, connected, placed, no_answer, busy, failed,
                  cancelled, seconds, leads
             FROM call_daily WHERE day = $1::date`, [asked])).rows;

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

    /* The history strip: every day in the window, including the empty ones,
       so a gap reads as "nobody called" rather than as a missing bar. Past
       days come from the rollup; today is spliced in from the live count
       above, because it is not in the rollup yet. */
    const history = (await query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS date,
              coalesce(sum(c.calls), 0)::int     AS calls,
              coalesce(sum(c.connected), 0)::int AS connected,
              coalesce(sum(c.placed), 0)::int    AS placed,
              coalesce(sum(c.seconds), 0)::int   AS seconds,
              count(c.actor)::int                AS callers
         FROM generate_series(call_day(now(), $2) - ($1::int - 1),
                              call_day(now(), $2), '1 day') d
         LEFT JOIN call_daily c ON c.day = d
        GROUP BY d ORDER BY d`, [days, TZ])).rows;

    if (history.length) {
      const live = (await query(LIVE_TODAY, [TZ])).rows;
      const last = history[history.length - 1];
      last.calls = live.reduce((a, r) => a + r.calls, 0);
      last.connected = live.reduce((a, r) => a + r.connected, 0);
      last.placed = live.reduce((a, r) => a + r.placed, 0);
      last.seconds = live.reduce((a, r) => a + r.seconds, 0);
      last.callers = live.length;
      last.today = true;
    }

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
      date: asked, today: todayStr, isToday, tz: TZ, days, history,
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

/* GET /api/calls/person/:email — one person, in depth.

   The team table answers "who is calling". This answers the next question a
   manager always asks, which is "what is Surbhi actually doing" — and it is a
   different shape of answer: a run of days rather than one number, the outcome
   mix rather than a total, and the actual calls with the companies named.

   Admin only, and for the same reason the report is: this is somebody's work
   in detail, which is exactly what a member may not see about a colleague. */
router.get("/api/calls/person/:email", requireAdmin, async (req, res, next) => {
  try {
    const who = String(req.params.email || "").trim().toLowerCase();
    if (!who || who.length > 200) return res.status(400).json({ error: "bad email" });
    const days = Math.max(1, Math.min(365, +req.query.days || 30));

    /* Not required to be an account. Calls exist under owner strings from the
       old system, and refusing to show them would hide real work. */
    const person = (await query(
      `SELECT u.email, u.display_name, u.disabled, m.role, u.created_at
         FROM app_users u
         LEFT JOIN organization_memberships m ON m.user_id = u.id
        WHERE lower(u.email) = $1`, [who])).rows[0] || null;

    /* Every day in the window, zeros included — a blank Tuesday is a finding,
       and a chart that silently omits it tells the opposite story. Today is
       appended live because it is not rolled up yet. */
    const daily = (await query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS date,
              coalesce(c.calls, 0)     AS calls,
              coalesce(c.connected, 0) AS connected,
              coalesce(c.placed, 0)    AS placed,
              coalesce(c.seconds, 0)   AS seconds,
              coalesce(c.leads, 0)     AS leads,
              c.first_at, c.last_at
         FROM generate_series(call_day(now(), $3) - ($2::int - 1),
                              call_day(now(), $3), '1 day') d
         LEFT JOIN call_daily c ON c.day = d AND lower(c.actor) = $1
        ORDER BY d`, [who, days, TZ])).rows;

    const liveToday = (await query(
      `SELECT count(*)::int AS calls,
              count(*) FILTER (WHERE meta->>'outcome' = 'connected')::int AS connected,
              count(*) FILTER (WHERE meta->>'outcome' = 'placed')::int    AS placed,
              coalesce(sum((meta->>'seconds')::int), 0)::int              AS seconds,
              count(DISTINCT lead_id)::int                                AS leads,
              min(at) AS first_at, max(at) AS last_at
         FROM activity_log
        WHERE action = 'call' AND lower(actor) = $1
          AND call_day(at, $2) = call_day(now(), $2)`, [who, TZ])).rows[0];
    if (daily.length) Object.assign(daily[daily.length - 1], liveToday, { today: true });

    /* The outcome mix over the window — the honest version of a connect rate.
       Read straight from the log rather than summed from the rollup so that
       today is included without a special case. */
    const outcomes = (await query(
      `SELECT coalesce(meta->>'outcome', 'unknown') AS outcome, count(*)::int AS n
         FROM activity_log
        WHERE action = 'call' AND lower(actor) = $1
          AND call_day(at, $3) > call_day(now(), $3) - $2::int
        GROUP BY 1 ORDER BY n DESC`, [who, days, TZ])).rows;

    /* What else they have been doing. Calls are one action of eleven, and a
       rep who placed no calls but wrote thirty notes was not idle. */
    const actions = (await query(
      `SELECT action, count(*)::int AS n, max(at) AS last
         FROM activity_log
        WHERE lower(actor) = $1
          AND call_day(at, $3) > call_day(now(), $3) - $2::int
        GROUP BY action ORDER BY n DESC`, [who, days, TZ])).rows;

    /* The last 50 calls, with the company named. This is the part a manager
       actually reads — "who did they ring, and how did it go". */
    /* lead_kind comes from the lead so the row can be clicked through to the
       right tab, and is null when the lead has since been purged — the log
       keeps the name either way, which is why it is denormalised there. */
    const recent = (await query(
      `SELECT a.at, a.lead_id, a.lead_code, a.lead_name, l.kind AS lead_kind,
              a.meta->>'outcome' AS outcome,
              (a.meta->>'seconds')::int AS seconds,
              a.meta->>'number' AS number
         FROM activity_log a
         LEFT JOIN leads l ON l.id = a.lead_id AND l.deleted_at IS NULL
        WHERE a.action = 'call' AND lower(a.actor) = $1
        ORDER BY a.at DESC LIMIT 50`, [who])).rows;

    /* Their book of business, and what state it is in. */
    const book = (await query(
      `SELECT count(*)::int AS assigned,
              count(*) FILTER (WHERE status = 'New')::int AS untouched,
              count(*) FILTER (WHERE status <> 'New')::int AS worked,
              count(*) FILTER (WHERE nullif(btrim(phone), '') IS NOT NULL)::int AS callable
         FROM leads
        WHERE btrim(owner) = $1 AND deleted_at IS NULL AND NOT removed`,
      [person ? person.email : who])).rows[0];

    const followups = (await query(
      `SELECT count(*)::int AS open,
              count(*) FILTER (WHERE due_at < now())::int AS overdue
         FROM lead_followups
        WHERE lower(owner) = $1 AND sent_at IS NULL
          AND done_at IS NULL AND cancelled_at IS NULL`, [who])).rows[0];

    const totals = daily.reduce((a, d) => ({
      calls: a.calls + +d.calls, connected: a.connected + +d.connected,
      placed: a.placed + +d.placed, seconds: a.seconds + +d.seconds,
      activeDays: a.activeDays + (+d.calls > 0 ? 1 : 0),
    }), { calls: 0, connected: 0, placed: 0, seconds: 0, activeDays: 0 });

    res.json({
      email: person ? person.email : who,
      label: (person && person.display_name) || who,
      role: (person && person.role) || null,
      account: !!person,
      disabled: !!(person && person.disabled),
      since: person ? person.created_at : null,
      days, tz: TZ, daily, outcomes, actions, recent, book, followups, totals,
      /* Days with no calls are counted, so an average is over the window and
         not only over the days somebody happened to work. */
      perActiveDay: totals.activeDays
        ? Math.round((totals.calls / totals.activeDays) * 10) / 10 : 0,
    });
  } catch (e) { next(e); }
});

/* POST /api/calls/rollup — rebuild stored days. The nightly cron calls
   rollupDay() directly; this is the manual lever for a correction or a
   backfill.

   Admin rather than owner, deliberately: it rewrites stored rows but it cannot
   invent them. Every figure is recomputed from activity_log, which is
   append-only, so the worst a rebuild can do is restore the truth. */
router.post("/api/calls/rollup", requireAdmin, express.json({ limit: "1kb" }),
  async (req, res, next) => {
    try {
      const b = req.body || {};
      const back = Math.max(1, Math.min(120, +b.days || 1));
      const out = [];
      for (let i = 1; i <= back; i++) {
        const day = (await query(
          "SELECT (call_day(now(), $2) - $1::int)::text AS d", [i, TZ])).rows[0].d;
        out.push({ day, rows: (await rollupDay(day)).length });
      }
      res.json({ rebuilt: out });
    } catch (e) { next(e); }
  });

module.exports = { router, OUTCOMES, rollupDay, TZ };
