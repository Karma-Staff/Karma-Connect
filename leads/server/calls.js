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
const { requireUser, requireAdmin, rankOf, RANK } = require("./auth");
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
const digits10 = (s) => String(s || "").replace(/\D/g, "").slice(-10);

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
      res.json(await logCall(req, lead));
    } catch (e) { next(e); }
  });

/* POST /api/calls/log — the same, for a number that is no lead's: one typed
   on the keypad, or an unknown caller answered. Without a row the call was
   invisible — not in the report and never sent to Zoho CRM, whose sweeper
   works from these rows and finds the CRM record by number on its own. */
router.post("/api/calls/log", requireUser, express.json({ limit: "4kb" }),
  async (req, res, next) => {
    try {
      if (digits10(req.body?.number).length < 7) return res.status(400).json({ error: "no number" });
      res.json(await logCall(req, null));
    } catch (e) { next(e); }
  });

async function logCall(req, lead) {
  const b = req.body || {};
  const outcome = OUTCOMES.includes(b.outcome) ? b.outcome : "failed";
  const seconds = Math.max(0, Math.min(MAX_SECONDS, Math.floor(Number(b.seconds) || 0)));

  await activity.log({
    actor: req.user.email,
    user_id: req.user.id,
    action: "call",
    lead_id: lead?.id ?? null,
    lead_code: lead?.lead_code ?? null,
    lead_name: lead?.name ?? null,
    to_value: outcome,           // shown directly in the activity feed
    meta: {
      outcome,
      seconds,
      provider: String(b.provider || "zoho").slice(0, 24),
      /* a callback answered in the dialler is logged too, marked inbound;
         a power-dialer call carries whose number it showed */
      ...(b.direction === "inbound" ? { direction: "inbound" } : {}),
      ...(b.callback_ext ? { callback_ext: String(b.callback_ext).slice(0, 12) } : {}),
      ...(b.campaign ? { campaign: String(b.campaign).slice(0, 80) } : {}),
      call_id: b.call_id ? String(b.call_id).slice(0, 120) : null,
      number: b.number ? String(b.number).slice(0, 32) : null,
    },
  });
  return { ok: true, outcome, seconds };
}

/* POST /api/leads/:id/disposition — what the rep says happened on a call.

   The softphone already logs what the LINE saw (connected, no answer, how
   long); this is the human half — "voicemail", "gatekeeper", "wrong
   number" — which no phone system can know. Before this it was not stored
   at all: picking "No Answer" in the wrap-up wrote nothing anywhere.

   It is stamped onto that call's own row in activity_log (meta.disposition)
   rather than written as a row of its own, so one call is one row carrying
   both halves, and the call report's counts are untouched. "That call" is
   this rep's most recent call to this lead in the last three hours. With no
   such call — a disposition logged by hand, or long after — it is recorded
   as a note carrying the disposition, so it is never dropped.

   No new action type, so no migration: the CHECK on activity_log.action
   already allows 'call' and 'note'. Member-safe by position, like timeline
   below: requireOwnLead has run on every /api/leads/:id path. */
const DISPOSITIONS = new Set([
  "Interested", "Follow-up Required", "Not Interested", "No Answer", "Busy",
  "Voicemail", "Gatekeeper", "Hung Up", "Wrong Number", "Not in Service",
  "Email Captured", "Call Back Later", "Converted", "Do Not Contact", "Prospect",
]);

router.post("/api/leads/:id/disposition", requireUser, express.json({ limit: "4kb" }),
  async (req, res, next) => {
    try {
      const id = +req.params.id;
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad lead id" });
      const b = req.body || {};
      const disposition = String(b.disposition || "").trim();
      if (!DISPOSITIONS.has(disposition)) return res.status(400).json({ error: "unknown disposition" });
      const note = String(b.note || "").trim().slice(0, 500) || null;

      const lead = (await query(
        "SELECT id, lead_code, name FROM leads WHERE id = $1 AND deleted_at IS NULL", [id])).rows[0];
      if (!lead) return res.status(404).json({ error: "no such lead" });

      const stamp = { disposition, dispo_note: note, dispo_at: new Date().toISOString() };
      const hit = (await query(
        `UPDATE activity_log SET meta = coalesce(meta, '{}'::jsonb) || $3::jsonb
          WHERE id = (SELECT id FROM activity_log
                       WHERE action = 'call' AND lead_id = $1 AND actor = $2
                         AND at > now() - interval '3 hours'
                       ORDER BY at DESC LIMIT 1)
          RETURNING id`, [lead.id, req.user.email, JSON.stringify(stamp)])).rows[0];
      if (hit) {
        /* Into Zoho CRM now that the rep has finished (crm-sync.js). A
           Prospect with a name becomes a Lead first, so the call lands on it.
           Neither may cost the disposition, which is already saved: a CRM
           problem is reported back, and the sweeper retries the call. */
        const crm = {};
        try {
          const sync = require("./crm-sync");
          const p = b.prospect || null;
          if (disposition === "Prospect" && p && String(p.last_name || "").trim()) {
            try { crm.lead = await sync.createLead(req.user, lead.id, p); }
            catch (e) { crm.leadError = e.message; }
          }
          const sent = await sync.sendNow(hit.id);
          if (sent) Object.assign(crm, sent.sent ? { sent: true, as: sent.as } : { sendError: sent.error });
        } catch (e) { crm.sendError = e.message; }
        return res.json({ ok: true, on: "call", id: hit.id, crm });
      }

      await activity.log({
        actor: req.user.email, user_id: req.user.id, action: "note",
        lead_id: lead.id, lead_code: lead.lead_code, lead_name: lead.name,
        to_value: disposition,
        meta: { ...stamp, note: note ? `${disposition} — ${note}` : disposition },
      });
      res.json({ ok: true, on: "note" });
    } catch (e) { next(e); }
  });

/* POST /api/calls/disposition — the same for a call to a number that is no
   lead's (POST /api/calls/log). Stamped onto this rep's latest such call to
   that number in the last three hours, then sent to Zoho CRM right away.
   There is no lead to hang a note on, so with no call to stamp it is refused
   rather than kept somewhere nobody would look. */
router.post("/api/calls/disposition", requireUser, express.json({ limit: "4kb" }),
  async (req, res, next) => {
    try {
      const b = req.body || {};
      const disposition = String(b.disposition || "").trim();
      if (!DISPOSITIONS.has(disposition)) return res.status(400).json({ error: "unknown disposition" });
      const number = digits10(b.number);
      if (number.length < 7) return res.status(400).json({ error: "no number" });
      const note = String(b.note || "").trim().slice(0, 500) || null;

      const stamp = { disposition, dispo_note: note, dispo_at: new Date().toISOString() };
      const hit = (await query(
        `UPDATE activity_log SET meta = coalesce(meta, '{}'::jsonb) || $3::jsonb
          WHERE id = (SELECT id FROM activity_log
                       WHERE action = 'call' AND lead_id IS NULL AND actor = $2
                         AND right(regexp_replace(coalesce(meta->>'number', ''), '\\D', '', 'g'), 10) = $1
                         AND at > now() - interval '3 hours'
                       ORDER BY at DESC LIMIT 1)
          RETURNING id`, [number, req.user.email, JSON.stringify(stamp)])).rows[0];
      if (!hit) return res.status(404).json({ error: "no recent call to that number" });

      const crm = {};
      try {
        const sent = await require("./crm-sync").sendNow(hit.id);
        if (sent) Object.assign(crm, sent.sent ? { sent: true, as: sent.as } : { sendError: sent.error });
      } catch (e) { crm.sendError = e.message; }
      res.json({ ok: true, on: "call", id: hit.id, crm });
    } catch (e) { next(e); }
  });

/* GET /api/calls/whois?number= — who is ringing in. The incoming-call pop-up
   asks this the moment a call arrives, so whoever picks up knows the company
   and why they are calling back before they say hello.

   Answers with the lead (matched on the last ten digits) and the last time
   anyone here called that number: who, when, what was logged, and in which
   power-dialer campaign. A member only sees a lead they own, or one they are
   the callback person for (the campaign showed THEIR number) — the same
   privacy line the rest of the app holds. */
router.get("/api/calls/whois", requireUser, async (req, res, next) => {
  try {
    const d = String(req.query.number || "").replace(/\D/g, "").slice(-10);
    if (d.length !== 10) return res.json({ lead: null, last: null });
    const isAdmin = rankOf(req.user.role) >= RANK.admin;

    const lead = (await query(
      `SELECT id, kind, name, company, city, state, status, owner, industry
         FROM leads
        WHERE deleted_at IS NULL AND NOT removed
          AND right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = $1
        ORDER BY id LIMIT 1`, [d])).rows[0] || null;
    const last = (await query(
      `SELECT a.at, a.actor, a.meta->>'disposition' AS disposition, a.meta->>'outcome' AS outcome,
              a.meta->>'campaign' AS campaign, a.meta->>'callback_ext' AS callback_ext,
              coalesce(nullif(btrim(u.display_name), ''), a.actor) AS name
         FROM activity_log a
         LEFT JOIN app_users u ON lower(u.email) = lower(a.actor)
        WHERE a.action = 'call' AND coalesce(a.meta->>'direction', 'outbound') <> 'inbound'
          AND right(regexp_replace(coalesce(a.meta->>'number', ''), '\\D', '', 'g'), 10) = $1
        ORDER BY a.at DESC LIMIT 1`, [d])).rows[0] || null;

    let mayView = isAdmin || (lead && String(lead.owner || "").trim() === String(req.user.email || "").trim());
    if (!mayView && last?.callback_ext) {
      const mine = (await query(
        `SELECT extension FROM voice_identities WHERE user_id = $1 AND provider = 'ringcentral'`,
        [req.user.id])).rows[0];
      mayView = !!mine && String(mine.extension) === String(last.callback_ext);
    }
    res.json({
      lead: lead && mayView ? lead : null,
      known: !!lead,
      last: last && (mayView || !lead) ? { at: last.at, by: last.name, disposition: last.disposition,
        outcome: last.outcome, campaign: last.campaign } : null,
    });
  } catch (e) { next(e); }
});

/* GET /api/calls/dispositions — the Dashboard's disposition log. Admin only:
   the whole floor's calls.

   `from`/`to` are instants (the browser turns its own day boundaries into
   them, the same days the RingCentral cards use). `ext` narrows to the rep
   on that RingCentral extension — the Dashboard's agent filter speaks
   extensions, and voice_identities is where an extension meets a person. */
router.get("/api/calls/dispositions", requireAdmin, async (req, res, next) => {
  try {
    const from = new Date(String(req.query.from || ""));
    const to = new Date(String(req.query.to || ""));
    if (isNaN(from) || isNaN(to) || to <= from) return res.status(400).json({ error: "from/to must be ISO instants" });
    if (to - from > 32 * 86400e3) return res.status(400).json({ error: "at most 31 days" });
    const ext = String(req.query.ext || "").trim();

    const args = [from.toISOString(), to.toISOString()];
    let extSql = "";
    if (ext) { args.push(ext); extSql = ` AND v.extension = $${args.length}`; }
    const { rows } = await query(`
      SELECT a.at, a.actor, a.action, a.lead_id, a.lead_name,
             coalesce(nullif(btrim(u.display_name), ''), a.actor) AS name,
             a.meta->>'disposition' AS disposition,
             a.meta->>'outcome'     AS outcome,
             a.meta->>'seconds'     AS seconds,
             a.meta->>'dispo_note'  AS note
        FROM activity_log a
        LEFT JOIN app_users u ON lower(u.email) = lower(a.actor)
        LEFT JOIN voice_identities v ON v.user_id = u.id AND v.provider = 'ringcentral'
       WHERE a.at >= $1 AND a.at < $2
         AND a.action IN ('call', 'note')
         AND a.meta ? 'disposition'${extSql}
       ORDER BY a.at DESC
       LIMIT 2000`, args);

    const counts = new Map(), people = new Map();
    for (const r of rows) {
      counts.set(r.disposition, (counts.get(r.disposition) || 0) + 1);
      if (!people.has(r.name)) people.set(r.name, { name: r.name, total: 0, by: {} });
      const p = people.get(r.name);
      p.total++;
      p.by[r.disposition] = (p.by[r.disposition] || 0) + 1;
    }
    res.json({
      total: rows.length,
      counts: [...counts].map(([disposition, count]) => ({ disposition, count }))
        .sort((a, b) => b.count - a.count),
      byAgent: [...people.values()].sort((a, b) => b.total - a.total),
      log: rows.slice(0, 200).map((r) => ({
        at: r.at, name: r.name, lead_id: r.lead_id, lead_name: r.lead_name,
        disposition: r.disposition, outcome: r.outcome, note: r.note,
        seconds: r.seconds == null ? null : +r.seconds, onCall: r.action === "call",
      })),
    });
  } catch (e) { next(e); }
});

/* GET /api/leads/:id/timeline — everything that ever happened to ONE lead.

   The manager's report reads the log by time and by person; the dialler reads
   it by lead, because the panel beside the phone answers "what do I already
   know about the company I am about to ring". Same table, opposite axis —
   hence the index in migration 014.

   Member-safe by position: mounted under /api/leads/:id, so leads.js's
   requireOwnLead has already refused a lead this rep does not own. It is NOT
   requireAdmin like the rest of this file, and that is the point — a rep must
   see their own lead's history or the panel is empty for everyone but admins.

   `kind` is the History tab's filter, derived here rather than in the browser
   so the two cannot drift: the tab offers All / Calls / Notes / Follow-ups and
   each row already says which it is. */
router.get("/api/leads/:id/timeline", requireUser, async (req, res, next) => {
  try {
    const id = +req.params.id;
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad lead id" });
    const limit = Math.max(1, Math.min(100, +req.query.limit || 40));

    const { rows } = await query(`
      SELECT at, actor, action, from_value, to_value, meta
        FROM activity_log
       WHERE lead_id = $1
       ORDER BY at DESC
       LIMIT $2`, [id, limit]);

    /* 'open' is every time anyone looked at the lead. It is the noisiest
       action in the log by a wide margin and says nothing a rep on a call
       needs, so it never reaches the panel. */
    const KINDS = { call: "call", note: "note", status: "status", owner: "status",
      remove: "status", restore: "status", enrich: "note" };

    res.json({
      items: rows
        .filter((r) => KINDS[r.action])
        .map((r) => ({
          at: r.at,
          actor: r.actor,
          action: r.action,
          kind: KINDS[r.action],
          from: r.from_value,
          to: r.to_value,
          outcome: r.meta?.outcome || null,
          seconds: Number.isFinite(r.meta?.seconds) ? r.meta.seconds : null,
          note: r.meta?.note || r.meta?.dispo_note || null,
          disposition: r.meta?.disposition || null,
        })),
    });
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

/* ---------------- downloadable reports ----------------

   CSV, not PDF or XLSX. A manager who downloads a call report opens it in
   Excel and starts sorting and filtering; a PDF is a picture of numbers and
   cannot be worked. CSV also needs no dependency, which keeps the runtime at
   twelve packages.

   Three shapes, because "the report" means three different things depending
   on who is asking:
     summary — one row per person for the whole period. The management view.
     daily   — one row per person per day. The trend, for a chart.
     calls   — one row per call, with the company named. For reviewing a rep.

   `who` narrows any of them to one person. So the overall report and the
   individual report are the same endpoint, which is why they can never
   disagree about what a call is. */

const CSV_LIMIT = 20000;             // rows; a bigger answer is a query, not a file

/* Excel decides a CSV's encoding by sniffing, and without a BOM it renders
   UTF-8 names as mojibake. One invisible character; endless confusion saved. */
const BOM = "﻿";

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  /* A leading =, +, - or @ makes Excel treat the cell as a formula. Company
     names from scraped data do start with those. Prefix with an apostrophe so
     the text is shown rather than evaluated. */
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}
const csvRows = (header, rows) =>
  BOM + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

/* A dialled number as something Excel will leave alone.

   "+16124782422" starts with +, so the formula guard above prefixes it with an
   apostrophe — and Excel's CSV parser shows that apostrophe rather than
   honouring it, which puts 'ters in front of every number in the column. Drop
   the + and group the digits instead: it starts with a digit so no guard
   fires, the spaces stop Excel reading it as a number and mangling it into
   scientific notation, and a human can still read it out loud. */
function phoneForCsv(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (!d) return "";
  const n = d.length === 11 && d[0] === "1" ? d.slice(1) : d;
  return n.length === 10 ? `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}` : d;
}

const hhmm = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const rate = (n, d) => (d ? Math.round((n / d) * 100) + "%" : "");

/* Gather the rows once, in a shape both renderers can use. Objects rather
   than arrays, because the PDF addresses columns by name and the CSV can map
   them in order — the other way round means two queries drifting apart. */
async function gatherExport({ from, to, who, shape }) {
  if (shape === "calls") {
    const r = await query(
      `SELECT to_char(a.at AT TIME ZONE $4, 'YYYY-MM-DD') AS day,
              to_char(a.at AT TIME ZONE $4, 'HH24:MI') AS time,
              a.actor, a.lead_code, a.lead_name, l.company, l.city, l.state,
              a.meta->>'outcome' AS outcome,
              (a.meta->>'seconds')::int AS seconds,
              a.meta->>'number' AS number
         FROM activity_log a
         LEFT JOIN leads l ON l.id = a.lead_id
        WHERE a.action = 'call'
          AND call_day(a.at, $4) BETWEEN $1::date AND $2::date
          AND ($3::text IS NULL OR lower(a.actor) = $3)
        ORDER BY a.at DESC LIMIT ${CSV_LIMIT}`, [from, to, who, TZ]);
    const recs = r.rows.map((x) => ({ ...x, seconds: x.seconds || 0,
      number: phoneForCsv(x.number) }));
    return {
      recs,
      csvHeader: ["Date", "Time", "Caller", "Lead code", "Company", "Trading name",
        "City", "State", "Outcome", "Seconds", "Number dialled"],
      csvKeys: ["day", "time", "actor", "lead_code", "lead_name", "company",
        "city", "state", "outcome", "seconds", "number"],
      totals: {
        calls: recs.length,
        connected: recs.filter((x) => x.outcome === "connected").length,
        placed: recs.filter((x) => x.outcome === "placed").length,
        leads: new Set(recs.map((x) => x.lead_code)).size,
        talk: hhmm(recs.reduce((a, x) => a + x.seconds, 0)),
      },
    };
  }

  if (shape === "daily") {
    const r = await query(
      `SELECT to_char(c.day, 'YYYY-MM-DD') AS day, c.actor,
              coalesce(u.display_name, c.actor) AS label,
              c.calls, c.connected, c.placed, c.no_answer, c.busy, c.failed,
              c.cancelled, c.seconds, c.leads
         FROM call_daily c
         LEFT JOIN app_users u ON lower(u.email) = lower(c.actor)
        WHERE c.day BETWEEN $1::date AND $2::date
          AND ($3::text IS NULL OR lower(c.actor) = $3)
        ORDER BY c.day, lower(c.actor) LIMIT ${CSV_LIMIT}`, [from, to, who]);
    const recs = r.rows.map((x) => ({ ...x,
      rate: rate(x.connected, x.calls), talk: hhmm(x.seconds) }));
    return {
      recs,
      csvHeader: ["Date", "Person", "Email", "Calls", "Connected", "Connect rate",
        "Handed to dialler", "No answer", "Busy", "Failed", "Cancelled",
        "Talk time", "Leads reached"],
      csvKeys: ["day", "label", "actor", "calls", "connected", "rate", "placed",
        "no_answer", "busy", "failed", "cancelled", "talk", "leads"],
      totals: sumTotals(recs),
    };
  }

  /* Summary. The roster is the outer side of the join so somebody who called
     nothing in the period is a zero row rather than an absence — the same rule
     the morning email follows, and for the same reason. */
  const r = await query(
    `SELECT coalesce(u.email, c.actor) AS actor,
            coalesce(u.display_name, c.actor, u.email) AS label,
            coalesce(m.role, '') AS role,
            coalesce(sum(c.calls), 0)::int      AS calls,
            coalesce(sum(c.connected), 0)::int  AS connected,
            coalesce(sum(c.placed), 0)::int     AS placed,
            coalesce(sum(c.no_answer), 0)::int  AS no_answer,
            coalesce(sum(c.seconds), 0)::int    AS seconds,
            coalesce(sum(c.leads), 0)::int      AS leads,
            count(c.day) FILTER (WHERE c.calls > 0)::int AS days
       FROM app_users u
       LEFT JOIN organization_memberships m ON m.user_id = u.id
       FULL JOIN call_daily c
         ON lower(c.actor) = lower(u.email)
        AND c.day BETWEEN $1::date AND $2::date
      WHERE (u.id IS NULL OR NOT u.disabled)
        AND (c.day IS NULL OR c.day BETWEEN $1::date AND $2::date)
        AND ($3::text IS NULL OR lower(coalesce(u.email, c.actor)) = $3)
      GROUP BY 1, 2, 3
      ORDER BY calls DESC, lower(coalesce(u.display_name, c.actor, u.email))`,
    [from, to, who]);
  const recs = r.rows.map((x) => ({ ...x,
    role: x.role || "member",
    rate: rate(x.connected, x.calls), talk: hhmm(x.seconds),
    perDay: x.days ? Math.round((x.calls / x.days) * 10) / 10 : 0 }));
  return {
    recs,
    csvHeader: ["Person", "Email", "Role", "Calls", "Connected", "Connect rate",
      "Handed to dialler", "No answer", "Talk time", "Leads reached",
      "Days with calls", "Calls per active day"],
    csvKeys: ["label", "actor", "role", "calls", "connected", "rate", "placed",
      "no_answer", "talk", "leads", "days", "perDay"],
    totals: sumTotals(recs),
  };
}

/* Everything the PDF shows beyond the table. The CSV does not ask for any of
   it — a spreadsheet is for sorting, a report is for reading, and the report
   is generated rarely enough that five more queries cost nothing. */
async function gatherExtras({ from, to, who }) {
  const span = (await query(
    "SELECT ($2::date - $1::date) + 1 AS n", [from, to])).rows[0].n;

  /* The daily series, zeros included. A missing day must read as "nobody
     called", never as a gap in the chart. */
  const series = (await query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day,
            coalesce(sum(c.calls), 0)::int     AS calls,
            coalesce(sum(c.connected), 0)::int AS connected
       FROM generate_series($1::date, $2::date, '1 day') d
       LEFT JOIN call_daily c ON c.day = d
        AND ($3::text IS NULL OR lower(c.actor) = $3)
      GROUP BY d ORDER BY d`, [from, to, who])).rows;

  /* Per person, their own run of days — for the small chart on each card. */
  const perPerson = (await query(
    `SELECT lower(c.actor) AS actor, to_char(c.day, 'YYYY-MM-DD') AS day,
            c.calls, c.connected
       FROM call_daily c
      WHERE c.day BETWEEN $1::date AND $2::date
        AND ($3::text IS NULL OR lower(c.actor) = $3)
      ORDER BY c.day`, [from, to, who])).rows;

  const outcomes = (await query(
    `SELECT coalesce(meta->>'outcome', 'unknown') AS outcome, count(*)::int AS n
       FROM activity_log
      WHERE action = 'call'
        AND call_day(at, $4) BETWEEN $1::date AND $2::date
        AND ($3::text IS NULL OR lower(actor) = $3)
      GROUP BY 1 ORDER BY n DESC`, [from, to, who, TZ])).rows;

  /* Where the calling went. Both spellings of a state, as everywhere else. */
  const states = (await query(
    `SELECT upper(btrim(l.state)) AS state, count(*)::int AS n
       FROM activity_log a JOIN leads l ON l.id = a.lead_id
      WHERE a.action = 'call'
        AND call_day(a.at, $4) BETWEEN $1::date AND $2::date
        AND ($3::text IS NULL OR lower(a.actor) = $3)
        AND nullif(btrim(l.state), '') IS NOT NULL
      GROUP BY 1 ORDER BY n DESC LIMIT 8`, [from, to, who, TZ])).rows;

  /* The same length of time immediately before, so the headline number has
     something to mean. */
  const prev = (await query(
    `SELECT coalesce(sum(calls), 0)::int AS calls,
            coalesce(sum(connected), 0)::int AS connected
       FROM call_daily
      WHERE day BETWEEN ($1::date - $3::int) AND ($1::date - 1)
        AND ($2::text IS NULL OR lower(actor) = $2)`,
    [from, who, span])).rows[0];

  const busiest = series.reduce((a, d) => (d.calls > (a ? a.calls : -1) ? d : a), null);

  return { span, series, perPerson, outcomes, states, prev, busiest };
}

function sumTotals(recs) {
  const t = recs.reduce((a, x) => ({
    calls: a.calls + (+x.calls || 0), connected: a.connected + (+x.connected || 0),
    placed: a.placed + (+x.placed || 0), leads: a.leads + (+x.leads || 0),
    seconds: a.seconds + (+x.seconds || 0),
  }), { calls: 0, connected: 0, placed: 0, leads: 0, seconds: 0 });
  return { ...t, talk: hhmm(t.seconds) };
}

router.get("/api/calls/export", requireAdmin, async (req, res, next) => {
  try {
    const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
    const today = (await query("SELECT call_day(now(), $1)::text AS d", [TZ])).rows[0].d;
    let from = iso(req.query.from) || today;
    let to = iso(req.query.to) || today;
    if (from > to) [from, to] = [to, from];

    const who = String(req.query.who || "").trim().toLowerCase() || null;
    const shape = ["summary", "daily", "calls"].includes(req.query.shape)
      ? req.query.shape : (who ? "daily" : "summary");
    /* PDF is the default: this is a report somebody sends to somebody. CSV
       stays reachable with ?format=csv for anyone who wants to pivot it. */
    const format = req.query.format === "csv" ? "csv" : "pdf";

    /* Today is not in the rollup, so a range that includes it would under-count
       by a whole day — the one day a manager is most likely to be looking at.
       Roll it up first. It is idempotent and costs one statement. */
    if (to >= today) await rollupDay(today);

    const { recs, csvHeader, csvKeys, totals } = await gatherExport({ from, to, who, shape });

    const label = from === to ? from : `${from}_to_${to}`;
    const stem = `karma-calls_${who ? who.split("@")[0] + "_" : ""}${shape}_${label}`;

    /* Who the report is about, said in words, because a file that has been
       forwarded twice has lost the screen it came from. */
    let scope = "The whole team";
    if (who) {
      const n = (await query(
        "SELECT display_name FROM app_users WHERE lower(email) = $1", [who])).rows[0];
      scope = (n && n.display_name) ? `${n.display_name} · ${who}` : who;
    }

    if (format === "pdf") {
      const extras = await gatherExtras({ from, to, who });
      return require("./report-pdf").streamCallReportPdf(res, {
        from, to, who, scope, shape, tz: TZ, totals,
        rows: recs, filename: stem + ".pdf", ...extras,
      });
    }

    const rows = recs.map((x) => csvKeys.map((k) => x[k]));
    if (shape !== "calls") {
      rows.push([]);
      rows.push(["TOTAL", "", "", totals.calls, totals.connected,
        rate(totals.connected, totals.calls), totals.placed, "", totals.talk,
        totals.leads, "", ""]);
    }
    rows.push([]);
    rows.push([`Karma Leads call report · ${from} to ${to} · times in ${TZ} · ${scope}`]);
    rows.push(["Counts only calls placed through the dashboard. A call dialled from a handset or the Zoho app is not recorded."]);
    if (shape !== "calls")
      rows.push(["“Handed to dialler” are calls Zoho's own dialler took, which never reports the result — they are never counted as connected, so the connect rate is a floor."]);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${stem}.csv"`);
    res.send(csvRows(csvHeader, rows));
  } catch (e) { next(e); }
});

module.exports = { router, OUTCOMES, rollupDay, TZ };
