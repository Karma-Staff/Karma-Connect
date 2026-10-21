// The LinkedIn agent dashboard: what every LinkedIn account has done over a range of days, laid
// out like the calls dashboard the team uses for its sales reps (tiles, one row per account, a
// day-by-day chart, the hours it works). An admin sees every rep's accounts; anyone else sees
// their own. Everything is counted from the queue's own timestamps (outreach_queue), the inbox
// and the accounts — nothing is stored twice.
const { dbOn, q } = require("./db.cjs");

const RANGES = { today: 1, yesterday: 1, week: 7, month: 30 };
const ONLINE_MIN = 3;   // a PC that checked in within this many minutes is "online"

// "YYYY-MM-DD" of a timestamp on the viewer's clock (off = their UTC offset in minutes)
const dayOf = (ms, off) => new Date(ms + off * 60000).toISOString().slice(0, 10);

/* range: today | yesterday | week | month. Returns where the range starts and ends (ms) and its
   days, oldest first, on the viewer's clock. */
function span(range, off, now = Date.now()) {
  const r = RANGES[range] ? range : "today";
  const local = new Date(now + off * 60000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - off * 60000;
  let from = midnight - (RANGES[r] - 1) * 86400e3, to = now;
  if (r === "yesterday") { from = midnight - 86400e3; to = midnight; }
  const days = [];
  for (let t = from; t < to; t += 86400e3) days.push(dayOf(t, off));
  return { range: r, from, to, days };
}

async function dashboard({ userId, isAdmin, range, tzOffset, now = Date.now() }) {
  const off = Number.isFinite(Number(tzOffset)) && tzOffset !== "" && tzOffset != null
    ? Math.max(-840, Math.min(840, Math.round(Number(tzOffset)))) : 0;
  const s = span(range, off, now);
  const empty = { range: { name: s.range, from: new Date(s.from).toISOString(), to: new Date(s.to).toISOString(), days: s.days },
    team: !!isAdmin, accounts: [], kpi: {}, daily: [], hourly: Array(24).fill(0), updatedAt: new Date(now).toISOString() };
  if (!dbOn) return empty;
  const agent = require("./linkedin-agent.cjs");
  const EFF = agent.EFF_SQL;
  const who = isAdmin ? "true" : "a.user_id = $1";

  const accts = (await q(
    `select a.id, a.user_id, a.slot, a.label, a.enabled, a.dry_run, a.halted_at, a.halt_reason, a.last_seen_at, a.last_sent_at,
            a.worker, a.settings, a.prospect_on, u.first_name, u.last_name, u.email
       from linkedin_account a join users u on u.id = a.user_id
      where a.removed_at is null and ${who}
      order by lower(u.first_name), lower(u.email), a.slot`, isAdmin ? [] : [userId])).rows;
  if (!accts.length) return empty;

  const ids = accts.map((a) => a.id);
  const args = [ids, new Date(s.from), new Date(s.to), off];
  // one pass over the queue: every timestamp in range, tagged with what it was and the account
  const ev = (await q(
    `with o as (select ${EFF("o")} as acct, o.* from outreach_queue o
                 where o.channel = 'linkedin' and o.user_id in (select user_id from linkedin_account where id = any($1)))
     select acct, kind, at from (
       select acct, 'found' as kind, created_at as at from o where auto_found and action = 'invite'
       union all select acct, 'invited', sent_at from o where action = 'invite' and status = 'sent'
       union all select acct, 'accepted', accepted_at from o where action = 'invite' and accepted_at is not null
       union all select acct, 'researched', prep_at from o where action = 'invite' and prep_at is not null
       union all select acct, 'messages', sent_at from o where action = 'message' and status = 'sent'
       union all select acct, 'replies', sent_at from o where action = 'reply' and status = 'sent'
     ) x where acct = any($1) and at >= $2 and at < $3`, args.slice(0, 3))).rows;
  // of the invitations sent in the range, how many have been accepted since
  const rate = (await q(
    `select acct, count(*)::int as sent, count(*) filter (where accepted_at is not null)::int as accepted from (
        select ${EFF("o")} as acct, o.accepted_at from outreach_queue o
         where o.channel = 'linkedin' and o.action = 'invite' and o.status = 'sent' and o.sent_at >= $2 and o.sent_at < $3
           and o.user_id in (select user_id from linkedin_account where id = any($1))) x
      where acct = any($1) group by acct`, args.slice(0, 3))).rows;
  const waiting = (await q(
    `select acct, count(*)::int as n from (select ${EFF("o")} as acct from outreach_queue o
        where o.channel = 'linkedin' and o.action = 'invite' and o.status = 'sent' and coalesce(o.invite_state, 'pending') = 'pending'
          and o.sent_at > now() - interval '60 days' and o.user_id in (select user_id from linkedin_account where id = any($1))) x
      where acct = any($1) group by acct`, [ids])).rows;
  const inbox = (await q(
    `select li_account_id as acct, count(*)::int as n, count(*) filter (where needs_reply)::int as need
       from linkedin_inbox where li_account_id = any($1) and last_from = 'them' and last_at >= $2 and last_at < $3
      group by li_account_id`, args.slice(0, 3))).rows;
  const problems = (await q(
    `select li_account_id as acct, count(*)::int as n from linkedin_agent_event
      where li_account_id = any($1) and level = 'error' and at >= $2 and at < $3 group by li_account_id`, args.slice(0, 3))).rows;

  const KINDS = ["found", "invited", "accepted", "researched", "messages", "replies"];
  const zero = () => Object.fromEntries(KINDS.map((k) => [k, 0]));
  const per = new Map(ids.map((id) => [String(id), zero()]));
  const daily = new Map(s.days.map((d) => [d, zero()]));
  const hourly = Array(24).fill(0);
  for (const e of ev) {
    const t = new Date(e.at).getTime();
    const p = per.get(String(e.acct)); if (p) p[e.kind]++;
    const d = daily.get(dayOf(t, off)); if (d) d[e.kind]++;
    if (e.kind === "invited") hourly[new Date(t + off * 60000).getUTCHours()]++;
  }
  const by = (rows, k = "n") => new Map(rows.map((r) => [String(r.acct), r]));
  const rateBy = by(rate), waitBy = by(waiting), inboxBy = by(inbox), probBy = by(problems);

  const ln = new Date(now + off * 60000);
  const local = { localHour: ln.getUTCHours(), localDay: ln.getUTCDay(), localMinute: ln.getUTCMinutes() };
  const list = [];
  for (const a of accts) {
    const c = per.get(String(a.id)), r = rateBy.get(String(a.id)) || { sent: 0, accepted: 0 };
    const t = await agent.inviteTarget(a.user_id, a, agent.limitsFor(a), local, now).catch(() => null);
    const seen = a.last_seen_at ? now - new Date(a.last_seen_at).getTime() : Infinity;
    const li = (a.worker && a.worker.linkedin) || {};
    const state = a.halted_at ? "stopped" : !a.enabled ? "paused" : seen > ONLINE_MIN * 60000 ? "offline"
      : a.dry_run ? "test" : a.worker && a.worker.state === "working" ? "working" : "online";
    list.push({
      id: a.id, label: a.label, slot: a.slot,
      rep: [a.first_name, a.last_name].filter(Boolean).join(" ") || a.email, repEmail: a.email,
      linkedinName: li.name || null, state, activity: (a.worker && a.worker.activity) || null, lastSeenAt: a.last_seen_at, haltReason: a.halt_reason || null,
      findProspects: a.prospect_on !== false, testMode: !!a.dry_run, version: (a.worker && a.worker.version) || null,
      ...c, sentInRange: r.sent, acceptedOfSent: r.accepted, acceptRate: r.sent ? r.accepted / r.sent : null,
      waiting: (waitBy.get(String(a.id)) || {}).n || 0,
      incoming: (inboxBy.get(String(a.id)) || {}).n || 0, needReply: (inboxBy.get(String(a.id)) || {}).need || 0,
      problems: (probBy.get(String(a.id)) || {}).n || 0,
      today: t ? { target: t.target, sent: t.today, week: t.week, weekTarget: t.weekCap } : null,
    });
  }
  const sum = (k) => list.reduce((n, a) => n + (a[k] || 0), 0);
  const sentR = sum("sentInRange"), accR = sum("acceptedOfSent");
  return {
    ...empty,
    accounts: list,
    kpi: {
      found: sum("found"), invited: sum("invited"), accepted: sum("accepted"), acceptRate: sentR ? accR / sentR : null,
      researched: sum("researched"), messages: sum("messages"), replies: sum("replies"),
      incoming: sum("incoming"), needReply: sum("needReply"), waiting: sum("waiting"), problems: sum("problems"),
      accounts: list.length, online: list.filter((a) => a.state === "online" || a.state === "working").length,
      working: list.filter((a) => a.state === "working").length,
      weekSent: list.reduce((n, a) => n + (a.today ? a.today.week : 0), 0),
      weekTarget: list.reduce((n, a) => n + (a.today ? a.today.weekTarget : 0), 0),
    },
    daily: [...daily.entries()].map(([day, v]) => ({ day, ...v })),
    hourly,
  };
}

module.exports = { dashboard, _test: { span, dayOf } };
