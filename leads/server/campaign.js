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
const { query, tx } = require("./db");
const { requireUser, requireAdmin, rankOf, RANK } = require("./auth");
const { STATUSES } = require("./dedupe");
const activity = require("./activity");
const calltime = require("./calltime");
/* Uploaded campaigns (a spreadsheet, not the lead base) are a call_sessions row
   too, marked filters.source = 'upload'. They serve and record from their own
   table; current/outcome below hand off to this when they see one. */
const upload = require("./campaign-upload");

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

/* A session row WITHOUT its lead list: the count and the one lead it is on.
   A campaign holds up to 50,000 ids, and the rep's screen asks about its
   session every 15 seconds — reading the whole array each time to use its
   length and one element would move megabytes for nothing. */
const COLS = `id, actor, owner, pos, filters, started_at, ended_at, called, connected, skipped,
  cardinality(lead_ids) AS total, lead_ids[pos + 1] AS cur_id`;

async function openSession(actor) {
  return (await query(
    `SELECT ${COLS} FROM call_sessions WHERE actor = $1 AND ended_at IS NULL`, [actor])).rows[0] || null;
}

/* Calling hours. Before a lead is served, the next ones are checked against
   8am-9pm in THEIR local time (calltime.js). Leads it is too early or too
   late for are moved to the end of the list, untouched, and the first lead
   it is a decent hour for comes up instead — so nobody is skipped, they are
   called later in the day. Only the next LOOK leads are read per request.
   If none of them can be called yet, the lead stays put and the answer says
   when the soonest opens (callTime.waiting), so auto-dial holds instead of
   ringing someone at 7am. */
const LOOK = 200;
async function servable(s) {
  if (!s || s.cur_id == null) return { s, callTime: null };
  const rows = (await query(
    `SELECT u.ord::int AS ord, l.state, l.phone
       FROM call_sessions cs
            CROSS JOIN LATERAL unnest(cs.lead_ids[cs.pos + 1 : cs.pos + ${LOOK}]) WITH ORDINALITY u(id, ord)
            LEFT JOIN leads l ON l.id = u.id
      WHERE cs.id = $1 ORDER BY u.ord`, [s.id])).rows;
  const now = new Date();
  const checks = rows.map((r) => calltime.check(r, now));
  const j = checks.findIndex((c) => c.open);
  if (j === 0) return { s, callTime: checks[0] };
  if (j < 0) {
    const soonest = checks.map((c) => c.opensAt).filter(Boolean).sort()[0] || null;
    return { s, callTime: { ...checks[0], waiting: true, opensAt: soonest } };
  }
  const moved = (await query(
    `UPDATE call_sessions
        SET lead_ids = lead_ids[1:pos] || lead_ids[pos + $2 + 1:] || lead_ids[pos + 1:pos + $2]
      WHERE id = $1 AND ended_at IS NULL RETURNING ${COLS}`, [s.id, j])).rows[0];
  return moved ? { s: moved, callTime: { ...checks[j], deferred: j } } : { s, callTime: checks[0] };
}

/* The served session: the next callable lead's card, with its local time. */
async function serve(s, actor) {
  const v = await servable(s);
  const card = v.s.cur_id != null ? await leadCard(v.s.cur_id, actor) : null;
  return shape(v.s, card && { ...card, callTime: v.callTime });
}

/* A manager's power-dialer campaign is a call session too — same snapshot of
   lead ids, same position, same outcome path — that a manager built for a
   rep and controls. It is marked in `filters` (no schema change):
     { kind: "campaign", name, created_by, status: draft|ongoing|paused|ended,
       gap, started }
   The rep is the actor, so the one-open-session-per-caller index means one
   campaign at a time per rep, which is how a power dialer is worked anyway. */
const isCampaign = (s) => s?.filters?.kind === "campaign";

function shape(s, card) {
  const f = s.filters || {};
  return {
    id: s.id, owner: s.owner, pos: s.pos, total: s.total,
    called: s.called, connected: s.connected, skipped: s.skipped,
    filters: f, startedAt: s.started_at,
    done: s.pos >= s.total,
    campaign: isCampaign(s) ? { name: f.name, status: f.status, createdBy: f.created_by,
      gap: f.gap || null, callback: f.callback || null, pausedBy: f.paused_by || null } : null,
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

      /* A campaign a manager assigned is not this caller's to replace: ending
         it from here would silently throw away the manager's list. */
      const open = await openSession(me(req));
      if (isCampaign(open))
        return res.status(409).json({ error:
          `You have the campaign "${open.filters.name}" assigned — work it from here, or ask your manager to end it.` });

      // one live session per caller; starting a new one closes the old
      await query(
        "UPDATE call_sessions SET ended_at = now() WHERE actor = $1 AND ended_at IS NULL",
        [me(req)]);
      const s = (await query(
        `INSERT INTO call_sessions (actor, owner, lead_ids, filters)
         VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
        [me(req), owner, rows.map((r) => r.id),
          JSON.stringify({ statuses: OPEN_STATUSES, hasPhone: true })])).rows[0];

      res.json(await serve(s, me(req)));
    } catch (e) { next(e); }
  });

/* ---------------- working it ---------------- */

router.get("/api/campaign/current", requireUser, async (req, res, next) => {
  try {
    const s = await openSession(me(req));
    if (!s) return res.json({ session: null });
    res.json(upload.isUpload(s) ? await upload.serveUpload(s) : await serve(s, me(req)));
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
      const b = req.body || {};
      // an uploaded campaign records against its own table, not `leads`
      if (upload.isUpload(s)) return res.json(await upload.outcomeUpload(s, b));
      const id = s.cur_id;
      if (!id) return res.json(shape(s, null));

      const lead = (await query(
        "SELECT id, lead_code, name, company, status FROM leads WHERE id = $1", [id])).rows[0];
      const skip = b.skip === true;

      if (lead && !skip) {
        /* The call itself — ONCE. When the in-page softphone placed it, the
           softphone has already logged it on hang-up (with the real length),
           so the session's verdict is stamped onto that row. Logging a
           second row here, as this used to, counted every session call twice
           in the call report. Only a call the softphone never saw (a tel:
           link, a desk phone) gets a row of its own. */
        const outcome = String(b.outcome || "no-answer");
        const disposition = { voicemail: "VM", "no-answer": "No Answer", busy: "Busy" }[outcome] || null;
        const stamp = { session: s.id, session_outcome: outcome,
          ...(disposition ? { disposition, dispo_at: new Date().toISOString() } : {}) };
        const hit = (await query(
          `UPDATE activity_log SET meta = coalesce(meta, '{}'::jsonb) || $3::jsonb
            WHERE id = (SELECT id FROM activity_log
                         WHERE action = 'call' AND lead_id = $1 AND actor = $2
                           AND at > now() - interval '15 minutes'
                           AND NOT (coalesce(meta, '{}'::jsonb) ? 'session')
                         ORDER BY at DESC LIMIT 1)
            RETURNING id`, [lead.id, me(req), JSON.stringify(stamp)])).rows[0];
        if (!hit) await activity.log({
          actor: me(req), user_id: req.user.id, action: "call",
          lead_id: lead.id, lead_code: lead.lead_code, lead_name: lead.name,
          to_value: outcome,
          meta: { outcome, seconds: 0, provider: "manual", ...stamp },
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
          WHERE id = $1 RETURNING ${COLS}`,
        [s.id, skip ? 0 : 1, connected ? 1 : 0, skip ? 1 : 0])).rows[0];

      const nid = next.cur_id;
      if (!nid) await query(
        `UPDATE call_sessions SET ended_at = now(),
                filters = CASE WHEN filters->>'kind' = 'campaign'
                               THEN filters || '{"status":"completed"}'::jsonb ELSE filters END
          WHERE id = $1`, [s.id]);
      res.json(nid ? await serve(next, me(req)) : shape(next, null));
    } catch (e) { next(e); }
  });

/* The rep's screen polls this to notice a manager starting or pausing their
   campaign. One indexed row, no lead card — cheap enough to ask every 15s. */
/* GET /api/campaign/mine — the power-dialer campaigns given to this
   person, the open one first: for My calls, so a rep can see what they have
   been handed and how far each got without the manager's page. */
router.get("/api/campaign/mine", requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT s.id, s.pos, cardinality(s.lead_ids) AS total, s.called, s.connected, s.skipped,
             s.filters, s.started_at, s.ended_at,
             coalesce(nullif(btrim(c.display_name), ''), s.filters->>'created_by') AS creator_name
        FROM call_sessions s
        LEFT JOIN app_users c ON lower(c.email) = lower(s.filters->>'created_by')
       WHERE lower(s.actor) = lower($1) AND s.filters->>'kind' = 'campaign'
       ORDER BY s.ended_at IS NULL DESC, s.started_at DESC
       LIMIT 100`, [me(req)]);
    res.json({ list: rows.map((s) => ({
      id: +s.id, name: s.filters.name, status: campaignStatus(s),
      total: +s.total, completed: s.pos, pending: Math.max(0, s.total - s.pos),
      called: s.called, connected: s.connected, skipped: s.skipped,
      createdBy: s.creator_name || null, pausedBy: s.filters.paused_by || null,
      callback: s.filters.callback || null,
      createdAt: s.started_at, startedAt: s.filters.started || null, endedAt: s.ended_at,
    })) });
  } catch (e) { next(e); }
});

router.get("/api/campaign/state", requireUser, async (req, res, next) => {
  try {
    const s = await openSession(me(req));
    if (!isCampaign(s)) return res.json({ campaign: null });
    res.json({ campaign: { id: s.id, name: s.filters.name, status: s.filters.status,
      createdBy: s.filters.created_by, gap: s.filters.gap || null, callback: s.filters.callback || null,
      pos: s.pos, total: s.total, pausedBy: s.filters.paused_by || null } });
  } catch (e) { next(e); }
});

router.post("/api/campaign/end", requireUser, async (req, res, next) => {
  try {
    const s = await openSession(me(req));
    if (!s) return res.json({ ended: false });
    if (isCampaign(s) && !seesAll(req))
      return res.status(403).json({ error: "This campaign was assigned by a manager — only they can end it. You can simply leave this screen." });
    await query("UPDATE call_sessions SET ended_at = now() WHERE id = $1", [s.id]);
    res.json({ ended: true, called: s.called, connected: s.connected,
      skipped: s.skipped, total: s.total, pos: s.pos });
  } catch (e) { next(e); }
});

/* A break: whoever is dialling a campaign — the rep it was given to, or a
   manager working one themselves — can pause it and pick it back up. Ending
   it stays the manager's (dialer/campaigns/:id/state). The pause is the same
   one a manager's Pause sets, so the manager's list shows it, and who took
   it (paused_by) so a paused campaign is never a mystery. */
router.post("/api/campaign/pause", requireUser, express.json({ limit: "1kb" }), async (req, res, next) => {
  try {
    const s = await openSession(me(req));
    if (!isCampaign(s)) return res.status(400).json({ error: "You have no campaign running." });
    const resume = (req.body || {}).resume === true;
    if (!resume && s.filters.status !== "ongoing")
      return res.status(400).json({ error: "The campaign isn't running, so there is nothing to pause." });
    if (resume && s.filters.status !== "paused")
      return res.status(400).json({ error: "The campaign isn't paused." });
    const f = resume ? { status: "ongoing", paused_by: null } : { status: "paused", paused_by: me(req) };
    await query(`UPDATE call_sessions SET filters = filters || $2::jsonb WHERE id = $1 AND ended_at IS NULL`,
      [s.id, JSON.stringify(f)]);
    res.json({ ok: true, status: f.status });
  } catch (e) { next(e); }
});

/* ================= Power dialer: the manager's side =================

   Under /api/dialer/ — NOT /api/campaigns, which the main Karma Connect
   server already uses for Outreach email campaigns and answers first.

   A manager builds a campaign from the leads ASSIGNED to one rep — the same
   list Assignments shows, those with a phone and an open status, oldest-
   neglected first — and starts, pauses, resumes or ends it. The rep's
   Call session screen does the dialling (see app.js): while a campaign is
   ongoing, auto-dial is on and the next lead rings a few seconds after each
   wrap-up; paused, it stops after the current call. Admin only. */

/* 50,000 is a ceiling, not a target: a campaign is worked a lead at a time,
   so its size only decides when it runs out. The rep's screen never reads
   the list whole (see COLS). */
const MAX_CAMPAIGN = 50000;
const NAME_MAX = 80;
const dash = require("./rc-dashboard");

/* Who a campaign's callbacks can go to: everyone on the phone system with a
   direct number. A campaign's calls go out showing that person's number, so
   a lead who rings back reaches them — RingCentral's own routing does the
   rest, no queue or rule to set up. */
async function callbackTargets(uid) {
  const [exts, nums] = await Promise.all([dash.extensions(uid), dash.companyNumbers(uid)]);
  const byExt = new Map(exts.map((e) => [e.id, e]));
  return nums.filter((n) => n.usage === "DirectNumber" && n.extId && byExt.has(n.extId))
    .map((n) => ({ ext: byExt.get(n.extId).ext, name: byExt.get(n.extId).name, number: n.number }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

router.get("/api/dialer/callback-targets", requireAdmin, async (req, res, next) => {
  try { res.json({ targets: await callbackTargets(req.user.id) }); }
  catch (e) {
    if (e.status === 428) return res.json({ targets: [], error: "Connect your RingCentral account to choose who callbacks go to." });
    next(e);
  }
});

function campaignStatus(s) {
  if (!s.ended_at) return s.filters?.status || "draft";
  return s.pos >= +s.total || s.filters?.status === "completed" ? "completed" : "ended";
}

router.get("/api/dialer/campaigns", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT s.id, s.owner, s.pos, cardinality(s.lead_ids) AS total, s.called, s.connected, s.skipped,
             s.filters, s.started_at, s.ended_at,
             cl.cl_total, cl.cl_done,
             coalesce(nullif(btrim(o.display_name), ''), s.owner) AS owner_name,
             coalesce(nullif(btrim(c.display_name), ''), s.filters->>'created_by') AS creator_name
        FROM call_sessions s
        LEFT JOIN app_users o ON lower(o.email) = lower(s.owner)
        LEFT JOIN app_users c ON lower(c.email) = lower(s.filters->>'created_by')
        LEFT JOIN (SELECT session_id, count(*)::int cl_total,
                          count(*) FILTER (WHERE status = 'done')::int cl_done
                     FROM campaign_leads GROUP BY session_id) cl ON cl.session_id = s.id
       WHERE s.filters->>'kind' = 'campaign'
       ORDER BY s.ended_at IS NULL DESC, s.started_at DESC
       LIMIT 500`);
    const q = String(req.query.q || "").trim().toLowerCase();
    const want = String(req.query.status || "");
    const list = rows.map((s) => {
      // an uploaded campaign's leads live in campaign_leads, not lead_ids
      const isUp = s.filters.source === "upload";
      const total = isUp ? (s.cl_total || 0) : +s.total;
      const completed = isUp ? (s.cl_done || 0) : s.pos;
      return {
      id: s.id, name: s.filters.name, status: campaignStatus(s),
      total, completed, pending: Math.max(0, total - completed),
      called: s.called, connected: s.connected, skipped: s.skipped,
      owner: s.owner, ownerName: s.owner_name, createdBy: s.filters.created_by, creatorName: s.creator_name,
      gap: s.filters.gap || null, callback: s.filters.callback || null,
      pausedBy: s.filters.paused_by || null, source: s.filters.source || "assigned",
      createdAt: s.started_at, startedAt: s.filters.started || null, endedAt: s.ended_at,
    }; }).filter((c) => (!want || c.status === want)
      && (!q || [c.name, c.ownerName, c.owner, c.creatorName].some((x) => String(x || "").toLowerCase().includes(q))));
    res.json({ list, total: list.length });
  } catch (e) { next(e); }
});

/* Who can be given a campaign, and how many callable leads each one has —
   the New campaign form shows this so nobody builds an empty campaign. */
router.get("/api/dialer/campaigns/reps", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT lower(u.email) AS email, coalesce(nullif(btrim(u.display_name), ''), u.email) AS name,
             (SELECT count(*)::int FROM leads l
               WHERE btrim(l.owner) = u.email AND l.deleted_at IS NULL AND NOT l.removed
                 AND nullif(btrim(l.phone), '') IS NOT NULL AND l.status = ANY($1)) AS callable,
             (SELECT jsonb_object_agg(status, n) FROM (
                SELECT l.status, count(*)::int AS n FROM leads l
                 WHERE btrim(l.owner) = u.email AND l.deleted_at IS NULL AND NOT l.removed
                   AND nullif(btrim(l.phone), '') IS NOT NULL AND l.status = ANY($1)
                 GROUP BY l.status) x) AS callable_by,
             (SELECT s.filters->>'name' FROM call_sessions s
               WHERE s.actor = u.email AND s.ended_at IS NULL LIMIT 1) AS busy_with,
             (SELECT s.filters->>'kind' FROM call_sessions s
               WHERE s.actor = u.email AND s.ended_at IS NULL LIMIT 1) AS busy_kind
        FROM app_users u
       WHERE NOT u.disabled
       ORDER BY 2`, [OPEN_STATUSES]);
    /* The pool a campaign can also be filled from: callable leads nobody owns,
       counted per status so the form's number follows its tick-boxes. */
    const pool = (await query(`
      SELECT status, count(*)::int AS n FROM leads
       WHERE nullif(btrim(owner), '') IS NULL AND deleted_at IS NULL AND NOT removed
         AND nullif(btrim(phone), '') IS NOT NULL AND status = ANY($1)
       GROUP BY status`, [OPEN_STATUSES])).rows;
    const unassigned = Object.fromEntries(pool.map((r) => [r.status, r.n]));
    res.json({ reps: rows, statuses: OPEN_STATUSES, max: MAX_CAMPAIGN, unassigned });
  } catch (e) { next(e); }
});

router.post("/api/dialer/campaigns", requireAdmin, express.json({ limit: "4kb" }), async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || "").trim().slice(0, NAME_MAX);
    const owner = String(b.owner || "").trim().toLowerCase();
    const statuses = (Array.isArray(b.statuses) ? b.statuses : OPEN_STATUSES).filter((x) => STATUSES.includes(x));
    /* Which kinds of lead go in: companies, people, job postings — or any.
       Lets a manager build a campaign of just the people, or just the
       companies, rather than everything the rep has. */
    const KINDS = ["company", "person", "job"];
    let kinds = (Array.isArray(b.kinds) ? b.kinds : KINDS).filter((x) => KINDS.includes(x));
    if (!kinds.length) kinds = KINDS;
    const gap = Math.max(2, Math.min(60, Math.round(+b.gap || 6)));
    const limit = Math.max(1, Math.min(MAX_CAMPAIGN, Math.round(+b.limit || MAX_CAMPAIGN)));
    if (!name) return res.status(400).json({ error: "Give the campaign a name." });
    if (!statuses.length) return res.status(400).json({ error: "Pick at least one lead status." });
    const rep = (await query("SELECT id, email FROM app_users WHERE lower(email) = $1 AND NOT disabled", [owner])).rows[0];
    if (!rep) return res.status(400).json({ error: "Pick a person to assign the campaign to." });

    const open = await openSession(rep.email);
    if (open) return res.status(409).json({ error: isCampaign(open)
      ? `${rep.email} already has the campaign "${open.filters.name}" open. End it before giving them another.`
      : `${rep.email} is in the middle of their own call session. Ask them to stop it first.` });

    /* Where the leads come from: the rep's own assigned leads, or callable
       leads nobody owns — which become the rep's as the campaign is made. */
    const source = b.source === "unassigned" ? "unassigned" : "assigned";
    const ids = source === "assigned" ? (await query(
      `SELECT l.id FROM leads l
         LEFT JOIN recents r ON r.lead_id = l.id AND r.user_id = $3
        WHERE btrim(l.owner) = $1 AND l.deleted_at IS NULL AND NOT l.removed
          AND nullif(btrim(l.phone), '') IS NOT NULL
          AND l.status = ANY($2) AND l.kind = ANY($4)
        ORDER BY r.touched_at ASC NULLS FIRST, l.date_added DESC NULLS LAST, l.id
        LIMIT ${limit}`, [rep.email, statuses, rep.id, kinds])).rows.map((r) => r.id) : null;
    if (ids && !ids.length) return res.status(400).json({
      error: `${rep.email} has no assigned leads with a phone number and those statuses. Assign them some first.` });

    /* Who callbacks go to — checked against the phone system, never taken
       on trust from the browser, since it decides what number strangers see. */
    let callback = null;
    if (b.callback_ext) {
      const t = (await callbackTargets(req.user.id).catch(() => [])).find((x) => x.ext === String(b.callback_ext));
      if (!t) return res.status(400).json({ error: "That person has no direct number on the phone system." });
      callback = t;
    }

    const status = b.start ? "ongoing" : "draft";
    const filters = JSON.stringify({ kind: "campaign", name, created_by: me(req), status, gap, source,
      statuses, kinds, hasPhone: true, callback, ...(b.start ? { started: new Date().toISOString() } : {}) });
    const out = await tx(async (client) => {
      let leadIds = ids;
      if (source === "unassigned") {
        /* Claim and assign in one statement, so two managers building at
           once cannot hand the same lead to two reps. Newest first. */
        leadIds = (await client.query(
          `UPDATE leads SET owner = $1, updated_at = now()
            WHERE id IN (SELECT id FROM leads
                          WHERE nullif(btrim(owner), '') IS NULL AND deleted_at IS NULL AND NOT removed
                            AND nullif(btrim(phone), '') IS NOT NULL AND status = ANY($2)
                            AND kind = ANY($3)
                          ORDER BY date_added DESC NULLS LAST, id
                          LIMIT ${limit}
                          FOR UPDATE SKIP LOCKED)
            RETURNING id`, [rep.email, statuses, kinds])).rows.map((r) => r.id);
        if (!leadIds.length) return null;
        await activity.log({
          actor: me(req), user_id: req.user.id, action: "owner",
          lead_name: `${leadIds.length} lead${leadIds.length === 1 ? "" : "s"}`, to_value: rep.email,
          meta: { bulk: true, count: leadIds.length, owner: rep.email, campaign: name,
            ...(leadIds.length <= 500 ? { ids: leadIds } : {}) },
        }, client);
      }
      const row = (await client.query(
        `INSERT INTO call_sessions (actor, owner, lead_ids, filters)
         VALUES ($1, $1, $2, $3) RETURNING id`, [rep.email, leadIds, filters])).rows[0];
      return { id: row.id, total: leadIds.length };
    });
    if (!out) return res.status(400).json({
      error: "There are no unassigned leads with a phone number and those statuses." });
    if (source === "unassigned") require("./counts").invalidate();   // the Unassigned tile moved
    res.json({ ok: true, id: out.id, total: out.total, status, source });
  } catch (e) {
    /* the unique open-session index, if two managers raced */
    if (e.code === "23505") return res.status(409).json({ error: "That person was just given another session. Refresh and try again." });
    next(e);
  }
});

/* start / pause / resume / end */
router.post("/api/dialer/campaigns/:id/state", requireAdmin, express.json({ limit: "1kb" }), async (req, res, next) => {
  try {
    const id = +req.params.id;
    const action = String((req.body || {}).action || "");
    const s = (await query("SELECT * FROM call_sessions WHERE id = $1 AND filters->>'kind' = 'campaign'", [id])).rows[0];
    if (!s) return res.status(404).json({ error: "No such campaign." });
    if (s.ended_at) return res.status(400).json({ error: "That campaign has already finished." });
    if (action === "end") {
      await query(`UPDATE call_sessions SET ended_at = now(), filters = filters || '{"status":"ended"}'::jsonb WHERE id = $1`, [id]);
      return res.json({ ok: true, status: "ended" });
    }
    const to = { start: "ongoing", resume: "ongoing", pause: "paused" }[action];
    if (!to) return res.status(400).json({ error: "action must be start, pause, resume or end" });
    await query(
      `UPDATE call_sessions
          SET filters = filters || jsonb_build_object('status', $2::text,
                'started', coalesce(filters->>'started', now()::text),
                'paused_by', CASE WHEN $2 = 'paused' THEN $3::text END)
        WHERE id = $1 AND ended_at IS NULL`, [id, to, me(req)]);
    res.json({ ok: true, status: to });
  } catch (e) { next(e); }
});

/* Unassign a campaign's leads: they go back to the unassigned pool, off the
   rep's book and out of any later campaign. Only leads still owned by the
   campaign's rep are touched — one reassigned since belongs to someone else
   now. "pending" is the leads not yet called; "all" adds the ones called.
   A campaign still open loses its uncalled leads either way, so it ends:
   a list that rings leads nobody owns any more would be wrong. */
router.post("/api/dialer/campaigns/:id/unassign", requireAdmin, express.json({ limit: "1kb" }), async (req, res, next) => {
  try {
    const id = +req.params.id;
    const which = (req.body || {}).which === "all" ? "all" : "pending";
    const s = (await query(
      `SELECT id, owner, pos, ended_at, filters, cardinality(lead_ids) AS total
         FROM call_sessions WHERE id = $1 AND filters->>'kind' = 'campaign'`, [id])).rows[0];
    if (!s) return res.status(404).json({ error: "No such campaign." });
    if (!s.ended_at && s.filters.status === "ongoing")
      return res.status(409).json({ error: "Pause the campaign first — it is ringing these leads right now." });
    const out = await tx(async (client) => {
      const changed = (await client.query(
        `UPDATE leads SET owner = NULL, updated_at = now()
          WHERE id IN (SELECT unnest(CASE WHEN $3 = 'all' THEN lead_ids ELSE lead_ids[pos + 1:] END)
                         FROM call_sessions WHERE id = $1)
            AND lower(btrim(owner)) = lower($2) AND deleted_at IS NULL
          RETURNING id`, [id, s.owner, which])).rows.map((r) => r.id);
      if (changed.length)
        await activity.log({
          actor: me(req), user_id: req.user.id, action: "owner",
          lead_name: `${changed.length} lead${changed.length === 1 ? "" : "s"}`, to_value: "unassigned",
          meta: { bulk: true, count: changed.length, owner: null, from: s.owner, campaign: s.filters.name,
            ...(changed.length <= 500 ? { ids: changed } : {}) },
        }, client);
      if (!s.ended_at)
        await client.query(`UPDATE call_sessions SET ended_at = now(),
            filters = filters || '{"status":"ended"}'::jsonb WHERE id = $1`, [id]);
      return changed.length;
    });
    require("./counts").invalidate();
    res.json({ ok: true, unassigned: out, ended: !s.ended_at });
  } catch (e) { next(e); }
});

module.exports = { router, MAX_SESSION, OPEN_STATUSES };
