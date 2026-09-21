"use strict";
/* "Follow back" — set a date and time on a lead, get an email when it falls due.

   The loop is: a rep presses Follow back on a lead and picks when. At that
   moment a sweeper here claims the reminder, emails them through the same
   gateway the rest of the site uses, and the lead is waiting at the top of
   My tasks when they open it.

   Three things this gets right because getting them wrong is what makes a
   reminder system worse than none:

   Never twice. The sweeper claims rows by stamping sent_at inside the same
   UPDATE that selects them, so two instances, a restart mid-send, or a slow
   gateway cannot produce two emails. The gateway also gets an Idempotency-Key
   built from the reminder id.

   Never silently. If the mail gateway is not configured or refuses, the
   reminder is put back (sent_at cleared) and tried again next tick rather
   than being marked done and forgotten. A reminder nobody received, recorded
   as delivered, is the failure that loses a deal.

   Never in the wrong hour. The browser sends an absolute ISO instant, not a
   wall-clock time, so "3pm" means 3pm where the rep is and not 3pm UTC on a
   Render box in Virginia. */

const express = require("express");
const { query } = require("./db");
const { requireUser, rankOf, RANK } = require("./auth");
const activity = require("./activity");

const router = express.Router();

/* Once a minute. A reminder is not worth a tighter loop, and the query it
   runs is a partial-index lookup on an empty set almost every time. */
const TICK_MS = 60 * 1000;
/* Don't let a long outage produce a burst. Anything older than this is still
   sent, but the batch size keeps the gateway from being hit with hundreds. */
const BATCH = 20;
const MAX_NOTE = 500;

let email = null;
try { email = require("../../server/email.cjs"); }
catch (e) { console.warn("[karma] follow-ups: no mail module —", e.message); }

const mine = (user) => String(user.email || "").trim();

/* ---------------- the rep's side ---------------- */

/* Set (or replace) the reminder on a lead. requireOwnLead has already run on
   this path, so a member can only do this to their own leads. */
router.post("/api/leads/:id/followup", requireUser, express.json({ limit: "4kb" }),
  async (req, res, next) => {
    try {
      const id = +req.params.id;
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad lead id" });

      const due = new Date(req.body?.due_at);
      if (Number.isNaN(due.getTime()))
        return res.status(400).json({ error: "Pick a date and time." });
      /* A reminder in the past would fire on the next tick, which is never
         what someone meant — it means they mistyped the date. */
      if (due.getTime() < Date.now() - 60_000)
        return res.status(400).json({ error: "That time has already passed." });

      const lead = (await query(
        "SELECT id, lead_code, name, company, owner FROM leads WHERE id = $1 AND deleted_at IS NULL",
        [id])).rows[0];
      if (!lead) return res.status(404).json({ error: "no such lead" });

      const note = String(req.body?.note || "").slice(0, MAX_NOTE);
      /* The reminder goes to whoever owns the lead, falling back to the
         person setting it — a manager scheduling a follow-up on an
         unassigned lead should hear about it themselves, not nobody. */
      const owner = String(lead.owner || "").trim() || mine(req.user);

      // replace rather than stack; see the partial unique index in 008
      await query(
        `UPDATE lead_followups SET cancelled_at = now()
          WHERE lead_id = $1 AND sent_at IS NULL AND done_at IS NULL AND cancelled_at IS NULL`,
        [id]);
      const row = (await query(
        `INSERT INTO lead_followups (lead_id, owner, due_at, note, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, due_at, note, owner`,
        [id, owner, due.toISOString(), note, mine(req.user)])).rows[0];

      activity.log({ actor: mine(req.user), user_id: req.user.id, action: "note",
        lead_id: lead.id, lead_code: lead.lead_code, lead_name: lead.name,
        to_value: "follow back " + due.toISOString().slice(0, 16).replace("T", " "),
        meta: { followup: true, due_at: due.toISOString() } });

      res.json({ followup: row });
    } catch (e) { next(e); }
  });

/* What is set on this lead right now — the reading pane asks on every open. */
router.get("/api/leads/:id/followup", requireUser, async (req, res, next) => {
  try {
    const id = +req.params.id;
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad lead id" });
    const row = (await query(
      `SELECT id, due_at, note, owner, sent_at FROM lead_followups
        WHERE lead_id = $1 AND done_at IS NULL AND cancelled_at IS NULL
        ORDER BY due_at LIMIT 1`, [id])).rows[0] || null;
    res.json({ followup: row });
  } catch (e) { next(e); }
});

router.delete("/api/leads/:id/followup", requireUser, async (req, res, next) => {
  try {
    const id = +req.params.id;
    const out = await query(
      `UPDATE lead_followups SET cancelled_at = now()
        WHERE lead_id = $1 AND done_at IS NULL AND cancelled_at IS NULL`, [id]);
    res.json({ ok: true, cancelled: out.rowCount });
  } catch (e) { next(e); }
});

/* Everything outstanding for the caller — the My tasks card. Admins see the
   whole floor's, which is the same rule every other list here follows. */
router.get("/api/followups", requireUser, async (req, res, next) => {
  try {
    const seesAll = rankOf(req.user.role) >= RANK.admin;
    const args = seesAll ? [] : [mine(req.user)];
    const scope = seesAll ? "" : " AND f.owner = $1";
    const rows = (await query(
      `SELECT f.id, f.lead_id, f.due_at, f.note, f.owner, f.sent_at,
              l.kind, l.lead_code, l.name, l.company, l.city, l.state, l.status, l.phone
         FROM lead_followups f
         JOIN leads l ON l.id = f.lead_id
        WHERE f.done_at IS NULL AND f.cancelled_at IS NULL
          AND l.deleted_at IS NULL AND NOT l.removed${scope}
        ORDER BY f.due_at
        LIMIT 100`, args)).rows;
    res.json({ list: rows });
  } catch (e) { next(e); }
});

router.post("/api/followups/:id/done", requireUser, async (req, res, next) => {
  try {
    const id = +req.params.id;
    const seesAll = rankOf(req.user.role) >= RANK.admin;
    const out = await query(
      `UPDATE lead_followups SET done_at = now()
        WHERE id = $1 AND done_at IS NULL${seesAll ? "" : " AND owner = $2"}`,
      seesAll ? [id] : [id, mine(req.user)]);
    if (!out.rowCount) return res.status(404).json({ error: "no such follow-up" });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------------- the sweeper ---------------- */

async function tick() {
  if (!email || !email.emailVerifyOn) return { sent: 0, skipped: "mail not configured" };
  /* Claim and read in one statement. Anything that gets a row here owns it —
     no other worker, and no second pass of this one, can pick it up. */
  let claimed;
  try {
    claimed = (await query(
      `UPDATE lead_followups f SET sent_at = now()
        WHERE f.id IN (
          SELECT id FROM lead_followups
           WHERE due_at <= now() AND sent_at IS NULL
             AND done_at IS NULL AND cancelled_at IS NULL
           ORDER BY due_at
           LIMIT ${BATCH}
           FOR UPDATE SKIP LOCKED)
        RETURNING f.id, f.lead_id, f.owner, f.note`)).rows;
  } catch (e) {
    console.error("[karma] follow-up claim:", e.message);
    return { sent: 0 };
  }
  if (!claimed.length) return { sent: 0 };

  let sent = 0;
  for (const c of claimed) {
    const lead = (await query(
      `SELECT lead_code, name, company, city, state, phone FROM leads
        WHERE id = $1 AND deleted_at IS NULL`, [c.lead_id])).rows[0];
    // the lead was binned between setting the reminder and it falling due
    if (!lead) continue;
    const base = (process.env.APP_URL || "").replace(/\/$/, "");
    const link = base ? `${base}/leads/?open=${c.lead_id}&tab=companies` : "";
    try {
      /* The key is the reminder id, so a retry after a timeout the gateway
         actually received cannot deliver a second copy. */
      await email.sendFollowupEmail(c.owner, lead, c.note, link, "followup-" + c.id);
      sent++;
      await query(
        `INSERT INTO activity_log (actor, action, lead_id, lead_code, lead_name, to_value, meta)
         VALUES ($1, 'note', $2, $3, $4, 'follow-back reminder sent', $5)`,
        [c.owner, c.lead_id, lead.lead_code, lead.name, JSON.stringify({ followup_sent: true })]);
    } catch (e) {
      /* Put it back. Marked sent but never delivered is the one outcome
         worth more than a retry storm. */
      console.error("[karma] follow-up email to", c.owner, "failed:", e.message);
      await query("UPDATE lead_followups SET sent_at = NULL WHERE id = $1", [c.id]);
    }
  }
  return { sent, claimed: claimed.length };
}

let timer = null;
function startSweeper() {
  if (timer) return;
  if (process.env.KARMA_NO_SWEEP === "1") {
    console.warn("[karma] KARMA_NO_SWEEP=1 — follow-back reminders will NOT be emailed");
    return;
  }
  timer = setInterval(() => { tick().catch((e) => console.error("[karma] follow-up tick:", e.message)); }, TICK_MS);
  timer.unref();                       // never hold the process open for this
  console.log("Follow-back reminders on (checked every minute).");
}

module.exports = { router, startSweeper, tick };
