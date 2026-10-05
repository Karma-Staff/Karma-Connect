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
const { requireUser, requireAdmin, rankOf, RANK } = require("./auth");
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
    id: s.id, owner: s.owner, pos: s.pos, total: s.lead_ids.length,
    called: s.called, connected: s.connected, skipped: s.skipped,
    filters: f, startedAt: s.started_at,
    done: s.pos >= s.lead_ids.length,
    campaign: isCampaign(s) ? { name: f.name, status: f.status, createdBy: f.created_by,
      gap: f.gap || null, callback: f.callback || null } : null,
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
        /* The call itself — ONCE. When the in-page softphone placed it, the
           softphone has already logged it on hang-up (with the real length),
           so the session's verdict is stamped onto that row. Logging a
           second row here, as this used to, counted every session call twice
           in the call report. Only a call the softphone never saw (a tel:
           link, a desk phone) gets a row of its own. */
        const outcome = String(b.outcome || "no-answer");
        const disposition = { voicemail: "Voicemail", "no-answer": "No Answer", busy: "Busy" }[outcome]
          || (b.status === "Not interested" ? "Not Interested" : null);
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
          WHERE id = $1 RETURNING *`,
        [s.id, skip ? 0 : 1, connected ? 1 : 0, skip ? 1 : 0])).rows[0];

      const nid = next.lead_ids[next.pos];
      if (!nid) await query(
        `UPDATE call_sessions SET ended_at = now(),
                filters = CASE WHEN filters->>'kind' = 'campaign'
                               THEN filters || '{"status":"completed"}'::jsonb ELSE filters END
          WHERE id = $1`, [s.id]);
      res.json(shape(next, nid ? await leadCard(nid, me(req)) : null));
    } catch (e) { next(e); }
  });

/* The rep's screen polls this to notice a manager starting or pausing their
   campaign. One indexed row, no lead card — cheap enough to ask every 15s. */
router.get("/api/campaign/state", requireUser, async (req, res, next) => {
  try {
    const s = await openSession(me(req));
    if (!isCampaign(s)) return res.json({ campaign: null });
    res.json({ campaign: { id: s.id, name: s.filters.name, status: s.filters.status,
      createdBy: s.filters.created_by, gap: s.filters.gap || null, callback: s.filters.callback || null,
      pos: s.pos, total: s.lead_ids.length } });
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
      skipped: s.skipped, total: s.lead_ids.length, pos: s.pos });
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

const MAX_CAMPAIGN = 1000;
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
             coalesce(nullif(btrim(o.display_name), ''), s.owner) AS owner_name,
             coalesce(nullif(btrim(c.display_name), ''), s.filters->>'created_by') AS creator_name
        FROM call_sessions s
        LEFT JOIN app_users o ON lower(o.email) = lower(s.owner)
        LEFT JOIN app_users c ON lower(c.email) = lower(s.filters->>'created_by')
       WHERE s.filters->>'kind' = 'campaign'
       ORDER BY s.ended_at IS NULL DESC, s.started_at DESC
       LIMIT 500`);
    const q = String(req.query.q || "").trim().toLowerCase();
    const want = String(req.query.status || "");
    const list = rows.map((s) => ({
      id: s.id, name: s.filters.name, status: campaignStatus(s),
      total: +s.total, completed: s.pos, pending: Math.max(0, s.total - s.pos),
      called: s.called, connected: s.connected, skipped: s.skipped,
      owner: s.owner, ownerName: s.owner_name, createdBy: s.filters.created_by, creatorName: s.creator_name,
      gap: s.filters.gap || null, callback: s.filters.callback || null,
      createdAt: s.started_at, startedAt: s.filters.started || null, endedAt: s.ended_at,
    })).filter((c) => (!want || c.status === want)
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
             (SELECT s.filters->>'name' FROM call_sessions s
               WHERE s.actor = u.email AND s.ended_at IS NULL LIMIT 1) AS busy_with,
             (SELECT s.filters->>'kind' FROM call_sessions s
               WHERE s.actor = u.email AND s.ended_at IS NULL LIMIT 1) AS busy_kind
        FROM app_users u
       WHERE NOT u.disabled
       ORDER BY 2`, [OPEN_STATUSES]);
    res.json({ reps: rows, statuses: OPEN_STATUSES, max: MAX_CAMPAIGN });
  } catch (e) { next(e); }
});

router.post("/api/dialer/campaigns", requireAdmin, express.json({ limit: "4kb" }), async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || "").trim().slice(0, NAME_MAX);
    const owner = String(b.owner || "").trim().toLowerCase();
    const statuses = (Array.isArray(b.statuses) ? b.statuses : OPEN_STATUSES).filter((x) => STATUSES.includes(x));
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

    const ids = (await query(
      `SELECT l.id FROM leads l
         LEFT JOIN recents r ON r.lead_id = l.id AND r.user_id = $3
        WHERE btrim(l.owner) = $1 AND l.deleted_at IS NULL AND NOT l.removed
          AND nullif(btrim(l.phone), '') IS NOT NULL
          AND l.status = ANY($2)
        ORDER BY r.touched_at ASC NULLS FIRST, l.date_added DESC NULLS LAST, l.id
        LIMIT ${limit}`, [rep.email, statuses, rep.id])).rows.map((r) => r.id);
    if (!ids.length) return res.status(400).json({
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
    const s = (await query(
      `INSERT INTO call_sessions (actor, owner, lead_ids, filters)
       VALUES ($1, $1, $2, $3) RETURNING *`,
      [rep.email, ids, JSON.stringify({ kind: "campaign", name, created_by: me(req), status, gap,
        statuses, hasPhone: true, callback, ...(b.start ? { started: new Date().toISOString() } : {}) })])).rows[0];
    res.json({ ok: true, id: s.id, total: ids.length, status });
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
                'started', coalesce(filters->>'started', now()::text))
        WHERE id = $1 AND ended_at IS NULL`, [id, to]);
    res.json({ ok: true, status: to });
  } catch (e) { next(e); }
});

module.exports = { router, MAX_SESSION, OPEN_STATUSES };
