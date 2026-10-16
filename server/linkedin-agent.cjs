// LinkedIn agent: the server half. Hands approved LinkedIn queue items out to the local
// worker (agent/), enforces the sending caps, and records what came back.
//
// Why the server owns the limits: the worker is a local process the user can restart, close
// or run twice. Counters kept in the worker would reset with it, so every cap is checked and
// counted here, against the DB, per user. The worker's pacing is cosmetic on top of this.
//
// Three kinds of work, all rows of outreach_queue (the `action` column):
//   invite   a connection request, with the approved note. Its own, lower caps — LinkedIn
//            watches invitations far more closely than messages.
//   message  a message to a connection. One queued for someone with an invitation still
//            out waits (wait_accept) until the worker sees that invitation accepted.
//   reply    an answer to a LinkedIn conversation, sent into that thread. Drafted by AI in
//            the Send Queue and approved by a person — the worker never writes text.
//
// Flow:
//   1. Worker calls lease(): we pick approved LinkedIn items that are due and under every cap,
//      flip them to 'sending', and stamp a lease that expires. Claim is atomic (SKIP LOCKED)
//      so two workers can never take the same row.
//   2. Worker acts on LinkedIn, then calls report() with 'sent' | 'failed' | 'halted' | 'unverified'.
//   3. Anything whose lease expires without a report is swept back to 'approved' by
//      reclaimStale() so a crashed worker never strands a message.
//   4. Between sends the worker reads the inbox and the new-connections list. It only ever
//      reports conversations with people this user reached out to (watch()), so someone's
//      personal LinkedIn messages never reach this server.
//   5. When an invitation is accepted and nothing is queued to follow it, the worker copies
//      the person's whole profile page (recordProfile). The Send Queue parses and analyses it,
//      saves that to the lead, and drafts a first message; a person approves it, and it goes
//      out as an ordinary message (queueFollowup). followup_state on the invitation row:
//        needs_profile → needs_draft → drafted → queued | skipped
//
// Nothing here talks to LinkedIn — it only decides what the worker is allowed to do next.
// Requires db.cjs, which reads env at load: require this AFTER the .env loader has run.
const { dbOn, q, logActivity } = require("./db.cjs");

// ── Caps ────────────────────────────────────────────────────────────
// Conservative on purpose. These protect the user's account, not our throughput; raising them
// raises their ban risk, so they're env-tunable but default low.
const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
const LIMITS = {
  perDay:      num(process.env.LI_AGENT_PER_DAY, 25),      // messages + replies per user per rolling 24h
  perHour:     num(process.env.LI_AGENT_PER_HOUR, 8),      // messages + replies per user per rolling hour
  invitesPerDay:  num(process.env.LI_AGENT_INVITES_PER_DAY, 15),  // connection requests per rolling 24h
  invitesPerWeek: num(process.env.LI_AGENT_INVITES_PER_WEEK, 80), // ...and per rolling 7 days (LinkedIn's own limit is ~100)
  minGapSec:   num(process.env.LI_AGENT_MIN_GAP_SEC, 45),  // floor between two actions of any kind
  maxGapSec:   num(process.env.LI_AGENT_MAX_GAP_SEC, 180), // worker jitters up to here
  leaseMin:    num(process.env.LI_AGENT_LEASE_MIN, 10),    // a claimed item must report back within this
  batch:       num(process.env.LI_AGENT_BATCH, 3),         // max items handed out per lease call
  windowStart: num(process.env.LI_AGENT_WINDOW_START, 9),  // local hour, inclusive
  windowEnd:   num(process.env.LI_AGENT_WINDOW_END, 17),   // local hour, exclusive
  weekdaysOnly: String(process.env.LI_AGENT_WEEKDAYS_ONLY || "true") !== "false",
  copiesPerDay: num(process.env.LI_AGENT_COPIES_PER_DAY, 60), // profile pages copied on request, per rolling 24h
};
const ACTIONS = ["invite", "message", "reply"];
const NOTE_MAX = 300; // LinkedIn's limit on an invitation note

// The /in/<handle> part of a profile URL, lower-cased and decoded — how two spellings of the
// same profile URL (tracking params, trailing slash, %-encoding) are matched.
function handleOf(url) {
  const m = String(url || "").match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  if (!m) return "";
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch (e) { return m[1].toLowerCase(); }
}
// A name reduced to letters, for matching a conversation to a prospect when no profile link
// is visible. "Jane  O'Neil, CR" and "jane oneil cr" are the same.
const nameKey = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();

async function ensureAgentSchema() {
  if (!dbOn) return;
  try {
    // Per-user agent state: the kill switch, and why the agent last stopped.
    await q(`create table if not exists linkedin_agent (
      user_id      uuid primary key references users (id) on delete cascade,
      enabled      boolean not null default false,
      halted_at    timestamptz,
      halt_reason  text,
      last_seen_at timestamptz,
      last_sent_at timestamptz,
      created_at   timestamptz not null default now(),
      updated_at   timestamptz not null default now())`);
    // Lease bookkeeping on the queue rows the worker claims.
    await q("alter table outreach_queue add column if not exists lease_id text");
    await q("alter table outreach_queue add column if not exists leased_at timestamptz");
    await q("alter table outreach_queue add column if not exists lease_expires_at timestamptz");
    await q("alter table outreach_queue add column if not exists attempts int not null default 0");
    // Scrape results the worker pulls off the profile page while it's there.
    await q("alter table outreach_queue add column if not exists prospect_title text");
    await q("alter table outreach_queue add column if not exists prospect_company text");
    await q("alter table outreach_queue add column if not exists company_url text");
    await q("create index if not exists outreach_lease_idx on outreach_queue (status, lease_expires_at)");
    // Invitations, waiting for acceptance, and replies.
    await q("alter table outreach_queue add column if not exists action text not null default 'message'");
    await q("alter table outreach_queue add column if not exists wait_accept boolean not null default false");
    await q("alter table outreach_queue add column if not exists invite_state text");
    await q("alter table outreach_queue add column if not exists accepted_at timestamptz");
    await q("alter table outreach_queue add column if not exists thread_url text");
    await q("alter table outreach_queue add column if not exists inbox_id uuid");
    await q("create index if not exists outreach_prospect_idx on outreach_queue (user_id, prospect_id)");
    // The accepted person's profile, copied by the worker, and the first message drafted from it.
    await q("alter table outreach_queue add column if not exists profile_text text");
    await q("alter table outreach_queue add column if not exists profile_at timestamptz");
    await q("alter table outreach_queue add column if not exists followup_state text");
    await q("alter table outreach_queue add column if not exists followup_draft text");
    // Connection notes queued before invitations existed were going to be sent as messages,
    // which only works for people already connected. Anything of theirs not yet sent becomes
    // the invitation it always was.
    await q(`update outreach_queue set action = 'invite'
              where channel = 'linkedin' and step = 'connection' and action = 'message'
                and status in ('pending', 'approved', 'failed')`);
    // LinkedIn conversations with people this user reached out to. One row per thread.
    await q(`create table if not exists linkedin_inbox (
      id           uuid primary key default gen_random_uuid(),
      user_id      uuid not null references users (id) on delete cascade,
      thread_key   text not null,
      thread_url   text,
      name         text,
      profile_url  text,
      prospect_id  text,
      lead_label   text,
      messages     jsonb not null default '[]'::jsonb,
      last_text    text,
      last_from    text,
      last_at      timestamptz,
      needs_reply  boolean not null default false,
      handled_at   timestamptz,
      draft        text,
      draft_for    text,
      created_at   timestamptz not null default now(),
      updated_at   timestamptz not null default now(),
      unique (user_id, thread_key))`);
    await q("create index if not exists linkedin_inbox_user_idx on linkedin_inbox (user_id, needs_reply, last_at desc)");
    // "Copy it with the agent": someone in Karma Connect asked for a profile page, the worker
    // fetches it. status: pending → copying → done | failed.
    await q(`create table if not exists linkedin_copy (
      id          uuid primary key default gen_random_uuid(),
      user_id     uuid not null references users (id) on delete cascade,
      url         text not null,
      prospect_id text,
      status      text not null default 'pending',
      text        text,
      error       text,
      created_at  timestamptz not null default now(),
      started_at  timestamptz,
      done_at     timestamptz)`);
    await q("create index if not exists linkedin_copy_user_idx on linkedin_copy (user_id, status, created_at)");
  } catch (e) { console.error("ensureAgentSchema:", e.message); }
}

// ── Agent state (kill switch) ───────────────────────────────────────
async function getState(userId) {
  const { rows } = await q("select * from linkedin_agent where user_id = $1", [userId]);
  if (rows[0]) return rows[0];
  const ins = await q("insert into linkedin_agent (user_id) values ($1) on conflict (user_id) do nothing returning *", [userId]);
  return ins.rows[0] || (await q("select * from linkedin_agent where user_id = $1", [userId])).rows[0];
}

// Turn the agent on/off. Enabling always clears a previous halt — the user has looked at it.
async function setEnabled(userId, enabled) {
  await getState(userId);
  const { rows } = await q(
    `update linkedin_agent set enabled = $2,
       halted_at = case when $2 then null else halted_at end,
       halt_reason = case when $2 then null else halt_reason end,
       updated_at = now()
     where user_id = $1 returning *`,
    [userId, !!enabled],
  );
  logActivity(userId, enabled ? "li_agent_started" : "li_agent_stopped", {});
  return rows[0];
}

// Stop the agent and record why. Called when the worker reports a checkpoint/captcha, or when
// LinkedIn says the sending limit is reached — we never try to work around it, we stop and
// hand it back to the human.
async function halt(userId, reason) {
  await getState(userId);
  const { rows } = await q(
    "update linkedin_agent set enabled = false, halted_at = now(), halt_reason = $2, updated_at = now() where user_id = $1 returning *",
    [userId, String(reason || "Stopped").slice(0, 300)],
  );
  logActivity(userId, "li_agent_halted", { detail: String(reason || "").slice(0, 80) });
  return rows[0];
}

// ── Caps ────────────────────────────────────────────────────────────
// How many this user has actually sent recently, straight from the queue table (sent_at is the
// source of truth — no separate counter to drift). Messages and replies share one budget;
// invitations have their own.
async function sentCounts(userId) {
  const { rows } = await q(
    `select
       count(*) filter (where action <> 'invite' and sent_at > now() - interval '24 hours') as day,
       count(*) filter (where action <> 'invite' and sent_at > now() - interval '1 hour')   as hour,
       count(*) filter (where action = 'invite' and sent_at > now() - interval '24 hours')  as inv_day,
       count(*) filter (where action = 'invite' and sent_at > now() - interval '7 days')    as inv_week,
       max(sent_at) as last_sent
     from outreach_queue
     where user_id = $1 and channel = 'linkedin' and status = 'sent'`,
    [userId],
  );
  const r = rows[0] || {};
  return { day: Number(r.day || 0), hour: Number(r.hour || 0), invDay: Number(r.inv_day || 0),
    invWeek: Number(r.inv_week || 0), lastSent: r.last_sent || null };
}

// Is `now` inside the allowed sending window? The worker passes its own local hour/day, because
// the server may well be in a different timezone than the recruiter.
function inWindow(localHour, localDay) {
  if (LIMITS.weekdaysOnly && (localDay === 0 || localDay === 6)) return false;
  return localHour >= LIMITS.windowStart && localHour < LIMITS.windowEnd;
}

// The single "may I act right now, and how much" decision. Pure apart from the counts it's
// handed, so it unit-tests without a database. `msg` is how many messages/replies may go out
// in this batch, `inv` how many invitations; `allowed` is the two together (never over batch).
function decide({ state, counts, localHour, localDay, now = Date.now() }) {
  const none = { allowed: 0, msg: 0, inv: 0 };
  if (!state || !state.enabled) return { ok: false, reason: state && state.halt_reason ? state.halt_reason : "The agent is off.", ...none };
  if (!inWindow(localHour, localDay)) {
    return { ok: false, reason: `Outside the sending window (${LIMITS.windowStart}:00–${LIMITS.windowEnd}:00${LIMITS.weekdaysOnly ? ", weekdays" : ""}).`, ...none };
  }
  if (counts.lastSent) {
    const gap = (now - new Date(counts.lastSent).getTime()) / 1000;
    if (gap < LIMITS.minGapSec) return { ok: false, reason: `Too soon — ${Math.ceil(LIMITS.minGapSec - gap)}s to go.`, ...none, retryInSec: Math.ceil(LIMITS.minGapSec - gap) };
  }
  const msg = Math.max(0, Math.min(LIMITS.batch, LIMITS.perDay - (counts.day || 0), LIMITS.perHour - (counts.hour || 0)));
  const inv = Math.max(0, Math.min(LIMITS.batch, LIMITS.invitesPerDay - (counts.invDay || 0), LIMITS.invitesPerWeek - (counts.invWeek || 0)));
  const allowed = Math.min(LIMITS.batch, msg + inv);
  if (allowed > 0) return { ok: true, reason: "", allowed, msg, inv };
  const why = [];
  if ((counts.day || 0) >= LIMITS.perDay) why.push(`Daily message cap reached (${LIMITS.perDay}).`);
  else if ((counts.hour || 0) >= LIMITS.perHour) why.push(`Hourly message cap reached (${LIMITS.perHour}).`);
  if ((counts.invWeek || 0) >= LIMITS.invitesPerWeek) why.push(`Weekly invitation cap reached (${LIMITS.invitesPerWeek}).`);
  else if ((counts.invDay || 0) >= LIMITS.invitesPerDay) why.push(`Daily invitation cap reached (${LIMITS.invitesPerDay}).`);
  return { ok: false, reason: why.join(" ") || "No headroom left under the caps.", ...none };
}

// ── Lease / report ──────────────────────────────────────────────────
// Sweep leases that expired without a report (worker crashed, machine slept, tab closed) back
// to 'approved' so the message isn't stranded in 'sending' forever.
async function reclaimStale() {
  if (!dbOn) return { reclaimed: 0 };
  try {
    const { rows } = await q(
      `update outreach_queue set status = 'approved', lease_id = null, leased_at = null, lease_expires_at = null, updated_at = now()
         where channel = 'linkedin' and status = 'sending' and lease_expires_at is not null and lease_expires_at < now()
         returning id`,
    );
    return { reclaimed: rows.length };
  } catch (e) { console.error("reclaimStale:", e.message); return { reclaimed: 0 }; }
}

// A message that waits for an invitation is due only once that invitation is accepted. Shared
// by lease() and the queue listing, so the two can never disagree about what is waiting.
const WAITING_SQL = (a) => `(${a}.wait_accept and not exists (
  select 1 from outreach_queue i where i.user_id = ${a}.user_id and i.prospect_id = ${a}.prospect_id
     and i.action = 'invite' and i.accepted_at is not null))`;

// Claim up to `limit` approved, due items of the given actions. Replies first — someone is
// waiting on those — then oldest scheduled.
async function claim(userId, actions, limit, leaseId, expires) {
  if (limit <= 0) return [];
  const { rows } = await q(
    `update outreach_queue set status = 'sending', lease_id = $2, leased_at = now(), lease_expires_at = $3,
       attempts = attempts + 1, updated_at = now()
       where id in (
         select o.id from outreach_queue o
           where o.user_id = $1 and o.channel = 'linkedin' and o.status = 'approved' and o.action = any($4)
             and (o.scheduled_at is null or o.scheduled_at <= now())
             and not ${WAITING_SQL("o")}
           order by (o.action = 'reply') desc, o.scheduled_at nulls first
           limit ${Number(limit)} for update skip locked)
       returning id, prospect_id, lead_label, body, linkedin_url, step, action, thread_url`,
    [userId, String(leaseId || "").slice(0, 64) || null, expires, actions],
  );
  return rows;
}

// Hand the worker its next batch. Returns { items, wait, reason } — items may be empty with a
// reason the worker shows the user, and `wait` is how many seconds to sleep before asking again.
async function lease(userId, { leaseId, localHour, localDay } = {}) {
  if (!dbOn) return { items: [], wait: 60, reason: "No database configured." };
  await reclaimStale();
  const state = await getState(userId);
  const counts = await sentCounts(userId);
  const verdict = decide({ state, counts, localHour, localDay });
  if (!verdict.ok) {
    return { items: [], wait: verdict.retryInSec || 300, reason: verdict.reason, limits: LIMITS, counts };
  }
  const expires = new Date(Date.now() + LIMITS.leaseMin * 60000);
  const msgs = await claim(userId, ["reply", "message"], verdict.msg, leaseId, expires);
  const invs = await claim(userId, ["invite"], Math.min(verdict.inv, verdict.allowed - msgs.length), leaseId, expires);
  const rows = [...msgs, ...invs];
  await q("update linkedin_agent set last_seen_at = now(), updated_at = now() where user_id = $1", [userId]);
  return {
    items: rows,
    wait: rows.length ? LIMITS.minGapSec : 300,
    reason: rows.length ? "" : "Nothing approved and due in the queue.",
    limits: LIMITS,
    counts,
  };
}

// Move a prospect forward in the pipeline, never backward: an accepted invitation makes a
// 'new' prospect 'connected'; a reply makes a new/connected one 'replied'.
async function bumpProspect(userId, prospectId, to) {
  if (!prospectId) return;
  const from = to === "replied" ? ["new", "connected"] : ["new"];
  try {
    await q("update prospects set status = $3 where user_id = $1 and id = $2 and status = any($4)", [userId, String(prospectId), to, from]);
  } catch (e) { /* a reply thread may carry no saved prospect — nothing to move */ }
}

// The worker reports back on one leased item.
//   result 'sent'    → it went out; record it and stamp the scrape. For an invitation,
//                      `connected: true` means they were already a connection.
//   result 'failed'  → this one didn't work. Back to 'approved' to retry, or 'failed' after 3
//                      attempts — or at once when `final` says retrying can't help.
//   result 'halted'  → LinkedIn pushed back (checkpoint, captcha, limit notice). Release the
//                      item AND stop the whole agent for this user — a human looks at it next.
async function report(userId, id, { result, error, leaseId, scrape, connected, final, profileText } = {}) {
  if (!dbOn) return null;
  const cur = await q("select * from outreach_queue where id = $1 and user_id = $2", [id, userId]);
  const row = cur.rows[0];
  if (!row) return null;
  if (row.lease_id && leaseId && row.lease_id !== leaseId) return null; // someone else's lease

  // Whatever the outcome, keep anything the worker scraped off the profile. The SET fragment is
  // built for a given first placeholder number so each branch can put its own params first.
  const s = scrape || {};
  const trim = (v, n) => (v == null ? null : String(v).slice(0, n));
  const keepScrapeFrom = (n) => `prospect_title = coalesce($${n}, prospect_title),
                      prospect_company = coalesce($${n + 1}, prospect_company),
                      company_url = coalesce($${n + 2}, company_url),
                      linkedin_url = coalesce($${n + 3}, linkedin_url)`;
  const scrapeArgs = [trim(s.title, 200), trim(s.company, 200), trim(s.companyUrl, 400), trim(s.profileUrl, 400)];
  const isInvite = row.action === "invite";

  if (result === "sent" || result === "unverified") {
    // An 'unverified' send — the click happened but the worker couldn't see it land — is marked
    // sent on purpose: a duplicate to a prospect is worse than a missed one, and re-sending is
    // the only thing a retry could do. The warning stays on the row so a human checks it, and
    // the agent stops so somebody actually looks rather than it happening 25 times in a day.
    const unverified = result === "unverified";
    const inviteState = isInvite ? (connected ? "accepted" : "pending") : null;
    const { rows } = await q(
      `update outreach_queue set status = 'sent', sent_at = now(), lease_id = null, leased_at = null,
         lease_expires_at = null, error = $3, invite_state = $4,
         accepted_at = case when $4 = 'accepted' then now() else accepted_at end,
         ${keepScrapeFrom(5)}, updated_at = now()
       where id = $1 and user_id = $2 returning *`,
      [id, userId, unverified ? String(error || "Send could not be confirmed.").slice(0, 300) : null, inviteState, ...scrapeArgs],
    );
    await q("update linkedin_agent set last_sent_at = now(), last_seen_at = now(), updated_at = now() where user_id = $1", [userId]);
    const detail = (isInvite ? "linkedin_invite" : row.action === "reply" ? "linkedin_reply" : "linkedin_agent") + (unverified ? "_unconfirmed" : "");
    logActivity(userId, "outreach_sent", { prospectId: row.prospect_id, label: row.lead_label, detail });
    if (inviteState === "accepted") {
      await bumpProspect(userId, row.prospect_id, "connected");
      await wantFollowup(userId, [row]);
      if (profileText) await storeProfile(userId, row.id, profileText);
    }
    if (row.action === "reply" && row.inbox_id) {
      await q("update linkedin_inbox set needs_reply = false, handled_at = coalesce(handled_at, now()), updated_at = now() where id = $1 and user_id = $2", [row.inbox_id, userId]);
    }
    if (unverified) await halt(userId, "A send couldn't be confirmed — check that " + (isInvite ? "profile" : "thread") + " on LinkedIn before restarting.");
    return rows[0];
  }

  if (result === "halted") {
    await q(
      `update outreach_queue set status = 'approved', lease_id = null, leased_at = null, lease_expires_at = null,
         ${keepScrapeFrom(3)}, updated_at = now() where id = $1 and user_id = $2`,
      [id, userId, ...scrapeArgs],
    );
    await halt(userId, error || "LinkedIn asked for a human (checkpoint or limit).");
    return { id, status: "approved", halted: true };
  }

  // failed — retry a couple of times, then park it for the human.
  const dead = !!final || (row.attempts || 0) >= 3;
  const { rows } = await q(
    `update outreach_queue set status = $3, error = $4, lease_id = null, leased_at = null,
       lease_expires_at = null, ${keepScrapeFrom(5)}, updated_at = now()
     where id = $1 and user_id = $2 returning *`,
    [id, userId, dead ? "failed" : "approved", String(error || "Send failed.").slice(0, 300), ...scrapeArgs],
  );
  return rows[0];
}

// ── Inbox and acceptances (the worker's reading side) ───────────────
// What the worker should look out for: the people this user has messaged or invited (so it
// can pick their conversations out of the inbox and ignore everyone else's), and the
// invitations still waiting (so it can spot them in the new-connections list). Reading pages
// is activity too, so this answers only while the agent is on and inside the window.
async function watch(userId, { localHour, localDay } = {}) {
  if (!dbOn) return { ok: false, reason: "No database configured.", people: [], pendingInvites: [] };
  const state = await getState(userId);
  if (!state.enabled) return { ok: false, reason: state.halt_reason || "The agent is off.", people: [], pendingInvites: [], needProfile: [] };
  if (!inWindow(localHour, localDay)) return { ok: false, reason: "Outside the window.", people: [], pendingInvites: [], needProfile: [] };
  const { rows } = await q(
    `select distinct on (coalesce(linkedin_url, lead_label)) linkedin_url, lead_label, action, invite_state
       from outreach_queue
      where user_id = $1 and channel = 'linkedin' and status = 'sent' and sent_at > now() - interval '120 days'
      order by coalesce(linkedin_url, lead_label), sent_at desc limit 1000`,
    [userId],
  );
  const people = [];
  const seen = new Set();
  for (const r of rows) {
    const handle = handleOf(r.linkedin_url);
    const k = handle || nameKey(r.lead_label);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    people.push({ handle, name: r.lead_label || "" });
  }
  const pend = await q(
    `select linkedin_url from outreach_queue
      where user_id = $1 and channel = 'linkedin' and action = 'invite' and status = 'sent'
        and coalesce(invite_state, 'pending') = 'pending' and sent_at > now() - interval '60 days'`,
    [userId],
  );
  const pendingInvites = [...new Set(pend.rows.map((r) => handleOf(r.linkedin_url)).filter(Boolean))];
  await q("update linkedin_agent set last_seen_at = now(), updated_at = now() where user_id = $1", [userId]);
  return { ok: true, reason: "", people, pendingInvites, needProfile: await needProfile(userId) };
}

// The worker saw these handles in the new-connections list: their invitations were accepted.
// Marking the invitation accepted is what releases any message waiting on it.
async function markAccepted(userId, handles) {
  if (!dbOn) return { accepted: 0 };
  const want = new Set((Array.isArray(handles) ? handles : []).map((h) => handleOf("linkedin.com/in/" + h)).filter(Boolean).slice(0, 500));
  if (!want.size) return { accepted: 0 };
  const { rows } = await q(
    `select id, prospect_id, lead_label, linkedin_url from outreach_queue
      where user_id = $1 and channel = 'linkedin' and action = 'invite' and status = 'sent'
        and coalesce(invite_state, 'pending') = 'pending'`,
    [userId],
  );
  const hits = rows.filter((r) => want.has(handleOf(r.linkedin_url)));
  if (!hits.length) return { accepted: 0 };
  await q("update outreach_queue set invite_state = 'accepted', accepted_at = now(), updated_at = now() where id = any($1::uuid[])", [hits.map((r) => r.id)]);
  for (const r of hits) {
    await bumpProspect(userId, r.prospect_id, "connected");
    logActivity(userId, "li_invite_accepted", { prospectId: r.prospect_id, label: r.lead_label });
  }
  await wantFollowup(userId, hits);
  return { accepted: hits.length, needProfile: await needProfile(userId) };
}

// ── First message after an accept ───────────────────────────────────
// An accepted invitation with nothing queued to follow it needs a first message: mark it so
// the worker copies their profile. One with a message already queued (it was waiting for this
// accept) is left alone — that message goes out by itself.
async function wantFollowup(userId, rows) {
  for (const r of rows) {
    const { rows: m } = await q(
      `select 1 from outreach_queue where user_id = $1 and prospect_id = $2 and channel = 'linkedin'
          and action = 'message' and status in ('pending','approved','sending','sent') limit 1`, [userId, r.prospect_id]);
    if (!m.length) await q("update outreach_queue set followup_state = 'needs_profile', updated_at = now() where id = $1 and followup_state is null", [r.id]);
  }
}

// Profiles the worker should go and copy, a few at a time (each is a page visit).
async function needProfile(userId, limit = 5) {
  const { rows } = await q(
    `select linkedin_url from outreach_queue
      where user_id = $1 and action = 'invite' and followup_state = 'needs_profile' and linkedin_url is not null
      order by accepted_at nulls last limit ${Number(limit)}`, [userId]);
  return [...new Set(rows.map((r) => handleOf(r.linkedin_url)).filter(Boolean))];
}

async function storeProfile(userId, inviteId, text) {
  const t = String(text || "").trim().slice(0, 60000);
  if (t.length < 200) return false; // a sign-in wall or an error page, not a profile
  const { rowCount } = await q(
    `update outreach_queue set profile_text = $3, profile_at = now(), followup_state = 'needs_draft', updated_at = now()
      where id = $1 and user_id = $2 and followup_state = 'needs_profile'`, [inviteId, userId, t]);
  return rowCount > 0;
}

// The worker copied this person's profile page. Matched to their accepted invitation by handle.
async function recordProfile(userId, { handle, text } = {}) {
  if (!dbOn) return { stored: false };
  const h = handleOf("linkedin.com/in/" + String(handle || ""));
  if (!h) return { stored: false };
  const { rows } = await q(
    "select id, linkedin_url from outreach_queue where user_id = $1 and action = 'invite' and followup_state = 'needs_profile'", [userId]);
  const row = rows.find((r) => handleOf(r.linkedin_url) === h);
  if (!row) return { stored: false };
  return { stored: await storeProfile(userId, row.id, text) };
}

// For the Send Queue: accepted people waiting for a first message, with their copied profile
// and the saved lead (so the analysis can be written back to it).
async function listFollowups(userId) {
  if (!dbOn) return [];
  const { rows } = await q(
    `select o.id, o.prospect_id, o.lead_label, o.linkedin_url, o.body as note, o.profile_text, o.profile_at,
            o.followup_state, o.followup_draft, o.accepted_at,
            p.label as p_label, p.sub as p_sub, p.status as p_status, p.data as p_data
       from outreach_queue o left join prospects p on p.id = o.prospect_id and p.user_id = o.user_id
      where o.user_id = $1 and o.action = 'invite' and o.followup_state in ('needs_profile','needs_draft','drafted')
      order by o.accepted_at desc nulls last limit 40`, [userId]);
  return rows;
}

async function saveFollowupDraft(userId, id, { body } = {}) {
  const { rows } = await q(
    `update outreach_queue set followup_draft = $3, followup_state = 'drafted', updated_at = now()
      where id = $1 and user_id = $2 and action = 'invite' and followup_state in ('needs_draft','drafted') returning id`,
    [id, userId, String(body || "").slice(0, 4000)]);
  return rows[0] || null;
}

// A person approved the first message: it joins the queue as an ordinary, approved message.
async function queueFollowup(userId, id, { body, approvedBy } = {}) {
  const text = String(body || "").trim().slice(0, 4000);
  if (!text) throw new Error("Write the message first.");
  const { rows: r } = await q("select * from outreach_queue where id = $1 and user_id = $2 and action = 'invite'", [id, userId]);
  const inv = r[0];
  if (!inv) return null;
  if (inv.followup_state === "queued") throw new Error("This first message is already queued.");
  const { rows } = await q(
    `insert into outreach_queue (user_id, prospect_id, lead_label, channel, step, body, linkedin_url, status,
        scheduled_at, approved_by, approved_at, action)
     values ($1,$2,$3,'linkedin','relationship',$4,$5,'approved', now(), $6, now(), 'message') returning *`,
    [userId, inv.prospect_id, inv.lead_label, text, inv.linkedin_url, approvedBy || null]);
  await q("update outreach_queue set followup_state = 'queued', followup_draft = $3, updated_at = now() where id = $1 and user_id = $2", [id, userId, text]);
  logActivity(userId, "outreach_queued", { prospectId: inv.prospect_id, label: inv.lead_label, detail: "linkedin_first_message" });
  return rows[0];
}

async function skipFollowup(userId, id) {
  const { rows } = await q(
    "update outreach_queue set followup_state = 'skipped', updated_at = now() where id = $1 and user_id = $2 and action = 'invite' returning id", [id, userId]);
  return rows[0] || null;
}

// Store the conversations the worker read. Each thread is matched to a prospect this user
// reached out to — by profile handle, else by exact name — and one that matches nobody is
// dropped, never stored. A thread whose last message is theirs needs a reply; it's flagged,
// and the prospect moves to 'replied'.
//   threads: [{ threadKey, threadUrl, name, profileUrl, messages: [{ from: 'them'|'me', text }] }]
async function recordInbox(userId, threads) {
  if (!dbOn) return { stored: 0, needReply: 0 };
  const list = (Array.isArray(threads) ? threads : []).slice(0, 40);
  if (!list.length) return { stored: 0, needReply: 0 };
  const { rows: sent } = await q(
    `select prospect_id, lead_label, linkedin_url from outreach_queue
      where user_id = $1 and channel = 'linkedin' and status = 'sent' order by sent_at desc limit 3000`,
    [userId],
  );
  const byHandle = new Map(), byName = new Map();
  for (const r of sent) {
    const h = handleOf(r.linkedin_url);
    if (h && !byHandle.has(h)) byHandle.set(h, r);
    const n = nameKey(r.lead_label);
    if (n && n.includes(" ") && !byName.has(n)) byName.set(n, r); // a lone first name would match strangers
  }
  let stored = 0, needReply = 0;
  for (const t of list) {
    const key = String(t.threadKey || "").slice(0, 200);
    if (!key) continue;
    const handle = handleOf(t.profileUrl);
    // With a profile link, the handle decides: same name, different profile is someone else.
    // By name, "Jane Doe, CR" on LinkedIn is the "Jane Doe" we saved — and a name match whose
    // row has a profile link of its own must agree with the thread's.
    const nk = nameKey(t.name), w = nk.split(" ");
    const named = byName.get(nk) || (w.length > 2 ? byName.get(w[0] + " " + w[1]) || byName.get(w[0] + " " + w[w.length - 1]) : null);
    const match = (handle && byHandle.get(handle))
      || (named && (!handle || !handleOf(named.linkedin_url)) ? named : null);
    if (!match) continue;
    const msgs = (Array.isArray(t.messages) ? t.messages : [])
      .filter((m) => m && (m.from === "them" || m.from === "me") && String(m.text || "").trim())
      .slice(-30)
      .map((m) => ({ from: m.from, text: String(m.text).trim().slice(0, 2000) }));
    if (!msgs.length) continue;
    const last = msgs[msgs.length - 1];
    const threadUrl = /^https:\/\/www\.linkedin\.com\/messaging\/thread\//i.test(String(t.threadUrl || "")) ? String(t.threadUrl).slice(0, 400) : null;
    const { rows } = await q(
      `insert into linkedin_inbox (user_id, thread_key, thread_url, name, profile_url, prospect_id, lead_label,
          messages, last_text, last_from, last_at, needs_reply)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10, now(), $11)
       on conflict (user_id, thread_key) do update set
         thread_url = coalesce(excluded.thread_url, linkedin_inbox.thread_url),
         name = excluded.name,
         profile_url = coalesce(excluded.profile_url, linkedin_inbox.profile_url),
         prospect_id = excluded.prospect_id, lead_label = excluded.lead_label,
         messages = excluded.messages,
         last_at = case when linkedin_inbox.last_text is distinct from excluded.last_text then now() else linkedin_inbox.last_at end,
         needs_reply = case when linkedin_inbox.last_text is distinct from excluded.last_text then excluded.needs_reply else linkedin_inbox.needs_reply end,
         handled_at = case when linkedin_inbox.last_text is distinct from excluded.last_text then null else linkedin_inbox.handled_at end,
         last_text = excluded.last_text, last_from = excluded.last_from, updated_at = now()
       returning needs_reply`,
      [userId, key, threadUrl, String(t.name || match.lead_label || "").slice(0, 200), handle ? "https://www.linkedin.com/in/" + encodeURIComponent(handle) + "/" : null,
       match.prospect_id, match.lead_label, JSON.stringify(msgs), last.text, last.from, last.from === "them"],
    );
    stored++;
    if (rows[0] && rows[0].needs_reply) needReply++;
    if (msgs.some((m) => m.from === "them")) await bumpProspect(userId, match.prospect_id, "replied");
  }
  return { stored, needReply };
}

// ── Inbox (the Send Queue's side) ───────────────────────────────────
async function listInbox(userId) {
  if (!dbOn) return [];
  const { rows } = await q(
    `select i.*, exists (select 1 from outreach_queue o where o.inbox_id = i.id and o.user_id = i.user_id
              and o.status in ('pending', 'approved', 'sending')) as reply_queued
       from linkedin_inbox i where i.user_id = $1
      order by i.needs_reply desc, i.last_at desc nulls last limit 60`,
    [userId],
  );
  return rows;
}

async function setHandled(userId, id, handled = true) {
  const { rows } = await q(
    `update linkedin_inbox set needs_reply = $3, handled_at = case when $3 then null else now() end, updated_at = now()
      where id = $1 and user_id = $2 returning *`,
    [id, userId, !handled],
  );
  return rows[0] || null;
}

// Keep the AI draft with the thread, so it isn't paid for again on every visit. `forText` is
// the message it answers: a newer message from them makes the draft stale.
async function saveDraft(userId, id, { body, forText } = {}) {
  const { rows } = await q(
    "update linkedin_inbox set draft = $3, draft_for = $4, updated_at = now() where id = $1 and user_id = $2 returning *",
    [id, userId, String(body || "").slice(0, 4000), String(forText || "").slice(0, 2000)],
  );
  return rows[0] || null;
}

// A person approved this reply: queue it for the worker, to be sent into the thread.
async function queueReply(userId, id, { body, approvedBy } = {}) {
  const text = String(body || "").trim().slice(0, 4000);
  if (!text) throw new Error("Write the reply first.");
  const { rows: t } = await q("select * from linkedin_inbox where id = $1 and user_id = $2", [id, userId]);
  const th = t[0];
  if (!th) return null;
  if (!th.thread_url) throw new Error("This conversation has no LinkedIn link yet — wait for the agent's next inbox check.");
  const { rows } = await q(
    `insert into outreach_queue (user_id, prospect_id, lead_label, channel, step, body, linkedin_url, status,
        scheduled_at, approved_by, approved_at, action, thread_url, inbox_id)
     values ($1,$2,$3,'linkedin','reply',$4,$5,'approved', now(), $6, now(), 'reply', $7, $8) returning *`,
    [userId, th.prospect_id || "li-thread:" + th.thread_key, th.lead_label || th.name, text, th.profile_url, approvedBy || null, th.thread_url, th.id],
  );
  await q("update linkedin_inbox set needs_reply = false, handled_at = now(), draft = $3, updated_at = now() where id = $1 and user_id = $2", [id, userId, text]);
  logActivity(userId, "outreach_queued", { prospectId: th.prospect_id, label: th.lead_label || th.name, detail: "linkedin_reply" });
  return rows[0];
}

// Send a waiting message without waiting for the invitation — the person asked for it.
async function sendWithoutWaiting(userId, id) {
  const { rows } = await q(
    "update outreach_queue set wait_accept = false, updated_at = now() where id = $1 and user_id = $2 and status in ('pending','approved','failed') returning *",
    [id, userId],
  );
  return rows[0] || null;
}

// ── Copy a profile on request ───────────────────────────────────────
// The Deep LinkedIn paste panel's "Copy it with the agent": instead of a person opening the
// profile and pressing Ctrl+A, Ctrl+C, the worker opens it and sends the page text back. The
// worker picks requests up within about 15 seconds while it's running. A person asked for this
// one profile right now, so it isn't held to the sending window — but it is capped per day,
// and it needs the agent switched on.
const COPY_WAIT_MIN = 10; // a request nobody picks up in this long fails, saying why

async function requestCopy(userId, { url, prospectId } = {}) {
  const h = handleOf(url);
  if (!h) throw new Error("Add their LinkedIn profile link first (linkedin.com/in/…).");
  const clean = "https://www.linkedin.com/in/" + encodeURIComponent(h) + "/";
  const { rows: open } = await q(
    "select id from linkedin_copy where user_id = $1 and url = $2 and status in ('pending','copying') limit 1", [userId, clean]);
  if (open[0]) return { id: open[0].id };
  const { rows } = await q(
    "insert into linkedin_copy (user_id, url, prospect_id) values ($1,$2,$3) returning id",
    [userId, clean, prospectId ? String(prospectId).slice(0, 200) : null]);
  return { id: rows[0].id };
}

async function getCopy(userId, id) {
  await q(
    `update linkedin_copy set status = 'failed', done_at = now(),
       error = 'The agent didn''t pick this up. Is it running on your computer? (Send Queue → Start agent, then npm run agent.)'
     where user_id = $1 and status = 'pending' and created_at < now() - ($2 || ' minutes')::interval`, [userId, String(COPY_WAIT_MIN)]);
  const { rows } = await q("select id, url, status, text, error from linkedin_copy where id = $1 and user_id = $2", [id, userId]);
  const r = rows[0];
  if (!r) return null;
  const state = await getState(userId);
  return { ...r, agentOn: !!state.enabled, agentSeen: state.last_seen_at };
}

// The worker asks for copy requests. Ones it took but never answered go back after 5 minutes.
async function leaseCopies(userId) {
  if (!dbOn) return { items: [] };
  const state = await getState(userId);
  if (!state.enabled) return { items: [], reason: state.halt_reason || "The agent is off." };
  await q("update linkedin_copy set status = 'pending', started_at = null where user_id = $1 and status = 'copying' and started_at < now() - interval '5 minutes'", [userId]);
  const { rows: c } = await q("select count(*) as n from linkedin_copy where user_id = $1 and status = 'done' and done_at > now() - interval '24 hours'", [userId]);
  if (Number(c[0].n) >= LIMITS.copiesPerDay) {
    await q(`update linkedin_copy set status = 'failed', done_at = now(), error = $2 where user_id = $1 and status = 'pending'`,
      [userId, `Daily limit of ${LIMITS.copiesPerDay} profile copies reached — paste this one by hand, or try tomorrow.`]);
    return { items: [], reason: "Daily copy limit reached." };
  }
  const { rows } = await q(
    `update linkedin_copy set status = 'copying', started_at = now()
       where id in (select id from linkedin_copy where user_id = $1 and status = 'pending' order by created_at limit 2 for update skip locked)
     returning id, url`, [userId]);
  await q("update linkedin_agent set last_seen_at = now(), updated_at = now() where user_id = $1", [userId]);
  return { items: rows.map((r) => ({ id: r.id, handle: handleOf(r.url) })) };
}

async function finishCopy(userId, id, { text, error, halt: haltMsg } = {}) {
  const t = String(text || "").trim().slice(0, 60000);
  if (haltMsg) await halt(userId, String(haltMsg).slice(0, 300));
  const ok = !haltMsg && t.length >= 200;
  const { rows } = await q(
    `update linkedin_copy set status = $3, text = $4, error = $5, done_at = now()
      where id = $1 and user_id = $2 and status in ('pending','copying') returning id, status`,
    [id, userId, ok ? "done" : "failed", ok ? t : null,
     ok ? null : String(haltMsg || error || "Couldn't read their profile page.").slice(0, 300)]);
  return rows[0] || null;
}

// What the Send Queue UI shows in its agent strip.
async function status(userId) {
  if (!dbOn) return { enabled: false, limits: LIMITS, counts: { day: 0, hour: 0, invDay: 0, invWeek: 0 }, queued: 0 };
  const state = await getState(userId);
  const counts = await sentCounts(userId);
  const { rows } = await q(
    `select count(*) filter (where status = 'approved' and not ${WAITING_SQL("o")}) as ready,
            count(*) filter (where status = 'approved' and ${WAITING_SQL("o")})     as waiting,
            count(*) filter (where status = 'sending')  as inflight
       from outreach_queue o where user_id = $1 and channel = 'linkedin'`,
    [userId],
  );
  const inbox = await q("select count(*) filter (where needs_reply) as n from linkedin_inbox where user_id = $1", [userId]);
  const fu = await q("select count(*) as n from outreach_queue where user_id = $1 and action = 'invite' and followup_state in ('needs_draft','drafted')", [userId]);
  return {
    enabled: !!state.enabled,
    haltedAt: state.halted_at,
    haltReason: state.halt_reason,
    lastSeenAt: state.last_seen_at,
    lastSentAt: state.last_sent_at,
    limits: LIMITS,
    counts: { day: counts.day, hour: counts.hour, invDay: counts.invDay, invWeek: counts.invWeek },
    ready: Number((rows[0] || {}).ready || 0),
    waiting: Number((rows[0] || {}).waiting || 0),
    inflight: Number((rows[0] || {}).inflight || 0),
    needReply: Number((inbox.rows[0] || {}).n || 0),
    firstMessages: Number((fu.rows[0] || {}).n || 0),
  };
}

module.exports = {
  ensureAgentSchema, getState, setEnabled, halt, status,
  lease, report, reclaimStale, sentCounts, decide, inWindow, LIMITS,
  watch, markAccepted, recordInbox, listInbox, setHandled, saveDraft, queueReply, sendWithoutWaiting,
  recordProfile, listFollowups, saveFollowupDraft, queueFollowup, skipFollowup, needProfile,
  requestCopy, getCopy, leaseCopies, finishCopy,
  handleOf, nameKey, WAITING_SQL, ACTIONS, NOTE_MAX,
};
