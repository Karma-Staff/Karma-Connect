"use strict";
/* The morning call report, emailed to the people who run the floor.
 *
 * It does two jobs in one pass, and the order matters:
 *
 *   1. ROLL YESTERDAY UP. The day is over, so its numbers are final and get
 *      written to call_daily. This is what stops the history disappearing at
 *      midnight — before this existed the report only ever knew about today.
 *   2. EMAIL WHAT WAS JUST STORED. Not a fresh query: the same rows. If the
 *      email counted separately it could disagree with the screen an hour
 *      later, and then nobody trusts either.
 *
 * WHO GETS IT: admins and the owner. The storm digest goes to everyone because
 * a storm is news; this is every person's numbers side by side, which is a
 * management view. A member seeing a league table of their colleagues is a
 * different product decision and not one to make by accident.
 *
 * WHO IT IS ABOUT: the sales reps (role sales_rep, migration 015). A member
 * who researches or imports is not meant to call, and listing them every day
 * as "no calls" buried the people the report is for. Anyone else who did call
 * still appears, so the total never disagrees with the rows. Until somebody
 * has been marked a sales rep it falls back to everyone, as before — an empty
 * report the morning after deploy would read as a broken one.
 *
 * WHY YESTERDAY AND NOT TODAY: at 7am today has barely started. The useful
 * question in the morning is how yesterday went.
 *
 * Claimed once a day through job_runs, the same guard the storm digest uses,
 * because the same knock can arrive twice.
 */

const { query } = require("./db");
const { rollupDay, TZ } = require("./calls");

const JOB = "call-digest";

let email = null;
try { email = require("../../server/email.cjs"); }
catch (e) { console.warn("[karma] call digest: no mail module —", e.message); }

const localDate = (tz) => new Intl.DateTimeFormat("en-CA",
  { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/* Claim the day. Identical shape to digest.js's — one INSERT that either takes
   it or does nothing, which cannot race. */
async function claim(job, day, detail) {
  const r = await query(
    `INSERT INTO job_runs (job, ran_on, detail) VALUES ($1, $2, $3)
     ON CONFLICT (job, ran_on) DO NOTHING`,
    [job, day, detail ? JSON.stringify(detail) : null]);
  return r.rowCount === 1;
}

/* Admins and owners with a live account. OWNER_EMAILS can confer the owner
   tier without a row saying so, so it is unioned in rather than trusted to
   the membership table alone. */
async function recipients() {
  const rows = (await query(
    `SELECT u.email, u.display_name, m.role
       FROM app_users u
       LEFT JOIN organization_memberships m ON m.user_id = u.id
      WHERE NOT u.disabled AND u.email LIKE '%@%'
      ORDER BY u.email`)).rows;
  const owners = new Set(String(process.env.OWNER_EMAILS
    ?? "tenzinwoesel@karmastaff.com").toLowerCase().split(/[,\s]+/).filter(Boolean));
  return rows.filter((r) =>
    r.role === "admin" || r.role === "owner" || owners.has(r.email.toLowerCase()));
}

/* The roster, so somebody who called nothing appears as a zero. Leaving them
   out makes an idle day look like a quiet one, and the gap is the point.
   Sales reps only, once anybody holds the role (see WHO IT IS ABOUT). */
async function roster() {
  const all = (await query(
    `SELECT u.email, u.display_name, m.role
       FROM app_users u
       LEFT JOIN organization_memberships m ON m.user_id = u.id
      WHERE NOT u.disabled AND u.email LIKE '%@%'
      ORDER BY coalesce(u.display_name, u.email)`)).rows;
  const reps = all.filter((u) => u.role === "sales_rep");
  return { all, reps: reps.length ? reps : all, repsOnly: reps.length > 0 };
}

/* The rest of each rep's day: how their calls were dispositioned, the
   follow-ups they booked, and the ones they let go past due. One query each,
   grouped by person, for the same local day the rollup used. */
async function detailFor(day) {
  const [dispo, booked, overdue] = await Promise.all([
    query(`SELECT lower(actor) AS who, meta->>'disposition' AS d, count(*)::int AS n
             FROM activity_log
            WHERE meta ? 'disposition' AND call_day(at, $2) = $1::date
            GROUP BY 1, 2 ORDER BY 3 DESC`, [day, TZ]),
    query(`SELECT lower(created_by) AS who, count(*)::int AS n
             FROM lead_followups
            WHERE call_day(created_at, $2) = $1::date AND cancelled_at IS NULL
            GROUP BY 1`, [day, TZ]),
    query(`SELECT lower(owner) AS who, count(*)::int AS n
             FROM lead_followups
            WHERE due_at < now() AND done_at IS NULL AND cancelled_at IS NULL
            GROUP BY 1`),
  ]);
  const out = new Map();
  const of = (who) => out.get(who) || (out.set(who, { dispositions: [], booked: 0, overdue: 0 }), out.get(who));
  for (const r of dispo.rows) of(r.who).dispositions.push({ name: r.d, n: r.n });
  for (const r of booked.rows) of(r.who).booked = r.n;
  for (const r of overdue.rows) of(r.who).overdue = r.n;
  return out;
}

const clock = (ts) => ts ? new Intl.DateTimeFormat("en-US",
  { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(new Date(ts)) : "";

/* force — ignore the once-a-day claim (a forced run also never claims, so it
           cannot consume the real one)
   only  — send to this address instead of the managers
   day   — report on this date instead of yesterday */
async function runCallDigest({ force = false, only = "", day = "" } = {}) {
  const today = localDate(TZ);
  const target = /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? day
    : (await query("SELECT (call_day(now(), $1) - 1)::text AS d", [TZ])).rows[0].d;

  if (!email || !email.emailVerifyOn)
    return { skipped: "mail is not configured (GATEWAY_URL / GATEWAY_TOKEN)" };

  /* Roll up first, and do it even on a forced run: storing a finished day is
     correct regardless of whether an email goes out, and it is idempotent. */
  const rows = await rollupDay(target);

  if (!force && !(await claim(JOB, today, { for: target })))
    return { skipped: "already sent today", day: target };

  const { all, reps, repsOnly } = await roster();
  const team = reps;
  const by = new Map(rows.map((r) => [String(r.actor).toLowerCase(), r]));
  /* The day is already claimed, so the extra detail must never cost the
     email: without it each rep still gets their numbers. */
  const detail = await detailFor(target).catch((e) => {
    console.error("[karma] call digest detail:", e.message);
    return new Map();
  });

  const person = (label, role, r, who) => {
    const d = detail.get(who) || { dispositions: [], booked: 0, overdue: 0 };
    return {
      label, role, calls: r ? r.calls : 0, connected: r ? r.connected : 0,
      placed: r ? r.placed : 0, seconds: r ? r.seconds : 0, leads: r ? r.leads : 0,
      noAnswer: r ? r.no_answer : 0, from: clock(r?.first_at), to: clock(r?.last_at),
      dispositions: d.dispositions.slice(0, 4), booked: d.booked, overdue: d.overdue,
    };
  };
  const people = team.map((u) => ({ ...person(u.display_name || u.email, u.role || "member",
    by.get(u.email.toLowerCase()), u.email.toLowerCase()), rep: true }));
  /* Anyone else who called: a manager taking a few, or an owner string from
     the old system with no account. They made the calls, so hiding them would
     make the total disagree with the rows — they are listed, just not as reps. */
  const known = new Set(team.map((u) => u.email.toLowerCase()));
  const roleOf = new Map(all.map((u) => [u.email.toLowerCase(), u]));
  for (const r of rows) {
    const who = String(r.actor).toLowerCase();
    if (known.has(who)) continue;
    const u = roleOf.get(who);
    people.push(person(u ? (u.display_name || u.email) : r.actor,
      u ? (u.role || "member") : "no account", r, who));
  }
  people.sort((a, b) => b.calls - a.calls || a.label.localeCompare(b.label));

  const calls = rows.reduce((a, r) => a + r.calls, 0);
  const connected = rows.reduce((a, r) => a + r.connected, 0);
  const placed = rows.reduce((a, r) => a + r.placed, 0);

  /* A number on its own is not information. The comparison is against the same
     weekday last week rather than simply the day before, because Monday and
     Saturday are not alike and "down 60%" every Monday teaches people to
     ignore it. */
  const prev = (await query(
    `SELECT coalesce(sum(calls), 0)::int AS calls
       FROM call_daily WHERE day = $1::date - 7`, [target])).rows[0];
  const vsPrev = prev.calls
    ? `Same day last week: ${prev.calls} calls (${calls >= prev.calls ? "+" : ""}${
        calls - prev.calls}).`
    : "";

  /* A day nobody called still sends, unlike the storm digest. A silent floor
     is exactly the thing a manager must be told about; that email IS the
     signal, not noise. */
  const dayLabel = new Intl.DateTimeFormat("en-GB",
    { timeZone: "UTC", weekday: "long", day: "numeric", month: "short" })
    .format(new Date(target + "T12:00:00Z"));

  const to = only
    ? [{ email: String(only).trim(), display_name: null }]
    : await recipients();
  if (!to.length) return { skipped: "no admin or owner accounts to send to", day: target };

  const base = (process.env.APP_URL || "").replace(/\/$/, "");
  const link = base ? base + "/leads/?tab=calls&date=" + target : "";

  let sent = 0;
  for (const p of to) {
    try {
      await email.sendCallDigestEmail(p.email, {
        name: (p.display_name || "").split(" ")[0],
        dayLabel, day: target, tz: TZ,
        calls, connected, placed, people, vsPrev, link,
        callers: people.filter((p) => p.rep && p.calls > 0).length,
        members: team.length, repsOnly,
      }, `${JOB}-${target}-${p.email}`);
      sent++;
    } catch (e) {
      console.error("[karma] call digest to", p.email, "failed:", e.message);
    }
  }

  if (!force)
    await query("UPDATE job_runs SET detail = $3 WHERE job = $1 AND ran_on = $2",
      [JOB, today, JSON.stringify({ for: target, sent, calls, connected, people: people.length })]);

  return { day: target, sent, recipients: to.length, calls, connected, placed,
    callers: rows.length, ...(force ? { forced: true } : {}) };
}

module.exports = { runCallDigest, JOB, recipients };
