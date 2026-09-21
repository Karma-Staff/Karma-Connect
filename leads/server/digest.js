"use strict";
/* The 7am storm digest, and the endpoint that triggers it.

   Why an endpoint and not a timer: Render's free plan stops the process
   after about fifteen minutes without a request. At seven in the morning
   nobody has touched the site since the night before, so setInterval is not
   running and never fires. Something outside has to knock — see
   .github/workflows/daily-digest.yml, which is free and also has the useful
   side effect of waking the service so the follow-back sweeper catches up
   on anything that came due overnight.

   Knocks can repeat: a retry, an overlapping run, or the two we fire either
   side of the daylight-saving shift so exactly one lands at 7am local. The
   job_runs table (migration 009) makes the day a thing you claim once. */

const express = require("express");
const { query } = require("./db");
const alerts = require("./alerts");

const router = express.Router();

const JOB = "storm-digest";
/* The hour, in the team's own timezone. The schedule fires twice in UTC and
   this decides which of the two is actually morning — so the digest stays
   at 7am through the March and November clock changes without anyone
   editing a cron line. */
const TZ = process.env.DIGEST_TZ || "America/New_York";
const HOUR = Math.max(0, Math.min(23, +process.env.DIGEST_HOUR || 7));

let email = null;
try { email = require("../../server/email.cjs"); }
catch (e) { console.warn("[karma] digest: no mail module —", e.message); }

const localHour = (tz) => +new Intl.DateTimeFormat("en-GB",
  { timeZone: tz, hour: "numeric", hour12: false }).format(new Date());
const localDate = (tz) => new Intl.DateTimeFormat("en-CA",
  { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/* Everyone with a live account. The team asked for everyone rather than
   just managers: a storm is news before it is an assignment. */
async function recipients() {
  return (await query(
    `SELECT u.email, u.display_name FROM app_users u
      WHERE NOT u.disabled AND u.email LIKE '%@%'
      ORDER BY u.email`)).rows;
}

/* Claim today. Returns false if somebody already has it. */
async function claim(job, day, detail) {
  const r = await query(
    `INSERT INTO job_runs (job, ran_on, detail) VALUES ($1, $2, $3)
     ON CONFLICT (job, ran_on) DO NOTHING`,
    [job, day, detail ? JSON.stringify(detail) : null]);
  return r.rowCount === 1;
}

/* force  — ignore the hour check and the once-a-day claim
   only   — send to this one address instead of the team

   Both exist for the same reason: there is no way to see what the 7am email
   looks like at 7am without waiting for 7am, and nobody should have to mail
   the whole team to find a typo. */
async function runDigest({ force = false, only = "" } = {}) {
  const day = localDate(TZ);
  const hour = localHour(TZ);
  if (!force && hour !== HOUR)
    return { skipped: `it is ${hour}:00 in ${TZ}, the digest goes at ${HOUR}:00` };
  if (!email || !email.emailVerifyOn)
    return { skipped: "mail is not configured (GATEWAY_URL / GATEWAY_TOKEN)" };

  /* Claim before sending, never after. If the send then fails we lose a
     day's digest, which is a missed email; claiming afterwards would risk
     sending the same digest to the whole team twice, which is worse. */
  // a forced run is a test: it neither claims the day nor lets a claim stop it
  if (!force && !(await claim(JOB, day))) return { skipped: "already sent today" };

  let data;
  try { data = await alerts.load(); }
  catch (e) { return { skipped: "weather feed unavailable: " + e.message }; }

  const hit = (data.states || []).filter((s) => s.tier > 0);
  /* A quiet morning gets no email. A daily message that says "nothing
     happened" is a daily message people learn to delete, and then they
     delete the one that mattered. */
  if (!hit.length) return { sent: 0, skipped: "nothing active — no email on a quiet day" };

  const to = only
    ? [{ email: String(only).trim(), display_name: null }]
    : await recipients();
  const base = (process.env.APP_URL || "").replace(/\/$/, "");
  const link = base ? base + "/leads/?tab=storm" : "";
  let sent = 0;
  for (const p of to) {
    try {
      await email.sendStormDigestEmail(p.email, {
        name: (p.display_name || "").split(" ")[0],
        states: hit.slice(0, 8),
        alerts: (data.alerts || []).slice(0, 6),
        totalStates: hit.length,
        leads: hit.reduce((a, s) => a + s.leads, 0),
        unassigned: hit.reduce((a, s) => a + s.unassigned, 0),
        link,
      }, `${JOB}-${day}-${p.email}`);
      sent++;
    } catch (e) {
      console.error("[karma] digest to", p.email, "failed:", e.message);
    }
  }
  if (!force)
    await query("UPDATE job_runs SET detail = $3 WHERE job = $1 AND ran_on = $2",
      [JOB, day, JSON.stringify({ sent, recipients: to.length, states: hit.length })]);
  return { sent, recipients: to.length, states: hit.length, ...(force ? { forced: true } : {}) };
}

/* The knock. Not behind requireUser — the caller is a scheduler, not a
   person — so it carries a shared secret instead, compared in full and
   refused outright when unset rather than defaulting to open. */
router.post("/api/cron/daily", express.json({ limit: "2kb" }), async (req, res) => {
  const want = (process.env.CRON_TOKEN || "").trim();
  if (!want) return res.status(503).json({ error: "CRON_TOKEN is not set on this service" });
  const got = String(req.get("x-cron-token") || "").trim();
  if (got !== want) return res.status(403).json({ error: "bad token" });

  const out = { at: new Date().toISOString(), tz: TZ, localHour: localHour(TZ) };
  try {
    const b = req.body || {};
    out.digest = await runDigest({ force: b.force === true, only: b.only || "" });
  } catch (e) {
    console.error("[karma] digest:", e.message);
    out.digest = { error: e.message };
  }
  /* Whatever the digest did, the knock has woken the process — so flush any
     follow-back reminders that fell due while it was asleep. This is the
     other half of the free-plan problem and costs one call. */
  try {
    out.followups = await require("./followups").tick();
  } catch (e) { out.followups = { error: e.message }; }

  res.json(out);
});

module.exports = { router, runDigest, JOB };
