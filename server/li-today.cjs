// "What has the agent done today" for the LinkedIn agent page: one read across everything it
// does — people it found, invitations sent and accepted, connections researched, messages and
// replies sent, messages that came in, searches, and problems — each with the names behind it.
// `since` is the start of the day in the person's own time zone (the page sends it); an
// accountId narrows it to one LinkedIn account. Read-only.
const { dbOn, q } = require("./db.cjs");
const { EFF_SQL } = require("./linkedin-agent.cjs");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST = 60;   // names per kind at most

function sinceOf(v) {
  const d = new Date(v);
  const dayAgo = Date.now() - 36 * 3600e3;          // never further back than a day and a half
  if (Number.isNaN(d.getTime()) || d.getTime() < dayAgo || d.getTime() > Date.now()) {
    const m = new Date(); m.setHours(0, 0, 0, 0); return m;
  }
  return d;
}

async function today(userId, { since, accountId } = {}) {
  const empty = { since: null, found: [], invited: [], accepted: [], researched: [], messages: [], replies: [], incoming: [], problems: [], searches: 0 };
  if (!dbOn) return empty;
  const from = sinceOf(since);
  const acct = UUID_RE.test(String(accountId || "")) ? accountId : null;
  const ACC = `($3::uuid is null or ${EFF_SQL("o")} = $3)`;
  const who = `o.id, o.lead_label as name, o.prospect_title as title, o.prospect_company as company, o.linkedin_url as url,
               ${EFF_SQL("o")} as account_id`;
  const P = [userId, from.toISOString(), acct];

  const [found, invited, accepted, researched, messages, replies, incoming, problems, searches] = await Promise.all([
    q(`select ${who}, o.created_at as at from outreach_queue o
        where o.user_id = $1 and o.auto_found and o.action = 'invite' and o.created_at >= $2 and ${ACC}
        order by o.created_at desc limit ${LIST}`, P),
    q(`select ${who}, o.sent_at as at, o.auto_found from outreach_queue o
        where o.user_id = $1 and o.channel = 'linkedin' and o.action = 'invite' and o.status = 'sent' and o.sent_at >= $2 and ${ACC}
        order by o.sent_at desc limit ${LIST}`, P),
    q(`select ${who}, o.accepted_at as at from outreach_queue o
        where o.user_id = $1 and o.action = 'invite' and o.accepted_at >= $2 and ${ACC}
        order by o.accepted_at desc limit ${LIST}`, P),
    q(`select ${who}, o.prep_at as at, o.followup_state as state from outreach_queue o
        where o.user_id = $1 and o.action = 'invite' and o.prep_at >= $2 and ${ACC}
        order by o.prep_at desc limit ${LIST}`, P),
    q(`select ${who}, o.sent_at as at from outreach_queue o
        where o.user_id = $1 and o.channel = 'linkedin' and o.action = 'message' and o.status = 'sent' and o.sent_at >= $2 and ${ACC}
        order by o.sent_at desc limit ${LIST}`, P),
    q(`select ${who}, o.sent_at as at from outreach_queue o
        where o.user_id = $1 and o.channel = 'linkedin' and o.action = 'reply' and o.status = 'sent' and o.sent_at >= $2 and ${ACC}
        order by o.sent_at desc limit ${LIST}`, P),
    q(`select i.id, i.name, i.last_text as text, i.profile_url as url, i.last_at as at, i.li_account_id as account_id,
              i.needs_reply, (i.prospect_id is not null and i.prospect_id not like 'li-thread:%') as outreach
         from linkedin_inbox i
        where i.user_id = $1 and i.last_at >= $2 and i.last_from = 'them' and ($3::uuid is null or i.li_account_id = $3)
        order by i.last_at desc limit ${LIST}`, P),
    q(`select e.id, e.at, e.level, e.text, e.li_account_id as account_id from linkedin_agent_event e
        where e.user_id = $1 and e.at >= $2 and e.level in ('error', 'warn')
          and ($3::uuid is null or e.li_account_id = $3 or e.li_account_id is null)
        order by e.at desc limit ${LIST}`, P),
    q(`select coalesce(sum(case when prospect_day = ($2::timestamptz)::date or prospect_last >= $2 then prospect_runs else 0 end), 0)::int as n
         from linkedin_account where user_id = $1 and removed_at is null and ($3::uuid is null or id = $3)`, P),
  ]);
  return {
    since: from.toISOString(),
    found: found.rows, invited: invited.rows, accepted: accepted.rows, researched: researched.rows,
    messages: messages.rows, replies: replies.rows, incoming: incoming.rows, problems: problems.rows,
    searches: (searches.rows[0] && searches.rows[0].n) || 0,
  };
}

module.exports = { today, sinceOf };
