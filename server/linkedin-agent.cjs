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
// Accounts: one user can run up to MAX_ACCOUNTS LinkedIn accounts (linkedin_account), each
// with its own browser profile on the PC, its own on/off switch, dry run, limits, inbox and
// log. Every cap is counted per account. A queue row belongs to the account in li_account_id;
// one with none goes from the account that invited that person, else from the first account
// (EFF_SQL). Rows from before accounts existed were moved to the user's first account.
//
// Nothing here talks to LinkedIn — it only decides what the worker is allowed to do next.
// Requires db.cjs, which reads env at load: require this AFTER the .env loader has run.
const crypto = require("node:crypto");
// the agent finding prospects by itself (searching LinkedIn, inviting decision-makers)
const prospecting = require("./li-prospecting.cjs");
const weekly = require("./li-weekly.cjs");
const { dbOn, q, logActivity } = require("./db.cjs");

// ── Caps ────────────────────────────────────────────────────────────
// Conservative on purpose. These protect the user's account, not our throughput; raising them
// raises their ban risk, so they're env-tunable but default low. Each user can change their own
// in Karma Connect (LinkedIn agent → Settings), but never past BOUNDS.
const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
const LIMITS = {
  perDay:      num(process.env.LI_AGENT_PER_DAY, 25),      // messages + replies per user per rolling 24h
  perHour:     num(process.env.LI_AGENT_PER_HOUR, 8),      // messages + replies per user per rolling hour
  // Connection requests: invitesPerWeek a week (Monday–Sunday on the PC's clock, and never more
  // in any rolling 7 days), spread as a different number each working day (li-weekly.cjs), never
  // more than invitesPerDay in one day.
  invitesPerDay:  num(process.env.LI_AGENT_INVITES_PER_DAY, 25),
  invitesPerWeek: num(process.env.LI_AGENT_INVITES_PER_WEEK, 80), // LinkedIn's own limit is ~100
  minGapSec:   num(process.env.LI_AGENT_MIN_GAP_SEC, 45),  // floor between two actions of any kind
  maxGapSec:   num(process.env.LI_AGENT_MAX_GAP_SEC, 180), // worker jitters up to here
  leaseMin:    num(process.env.LI_AGENT_LEASE_MIN, 10),    // a claimed item must report back within this
  batch:       num(process.env.LI_AGENT_BATCH, 3),         // max items handed out per lease call
  windowStart: num(process.env.LI_AGENT_WINDOW_START, 9),  // local hour, inclusive
  windowEnd:   num(process.env.LI_AGENT_WINDOW_END, 17),   // local hour, exclusive
  weekdaysOnly: String(process.env.LI_AGENT_WEEKDAYS_ONLY || "true") !== "false",
  copiesPerDay: num(process.env.LI_AGENT_COPIES_PER_DAY, 60), // profile pages copied on request, per rolling 24h
  inboxEveryMin:  num(process.env.LI_AGENT_INBOX_MIN, 15),   // how often the worker reads the inbox
  acceptEveryMin: num(process.env.LI_AGENT_ACCEPT_MIN, 60),  // ...and the new-connections list
};

// What a user may set for themselves, and the hard range for each. The ceilings sit below
// LinkedIn's own thresholds; nothing a user types can push the agent past them.
const BOUNDS = {
  perDay: [1, 40], perHour: [1, 12], invitesPerDay: [1, 25], invitesPerWeek: [1, 100],
  minGapSec: [30, 600], maxGapSec: [30, 900], windowStart: [0, 23], windowEnd: [1, 24],
  copiesPerDay: [1, 100], inboxEveryMin: [5, 120], acceptEveryMin: [15, 480],
};
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, Math.round(v)));

// Keep only known keys, each inside its bounds. Anything else is dropped, not rejected, so an
// older page posting a field that no longer exists still saves the rest.
function cleanSettings(input) {
  const s = {};
  const src = input && typeof input === "object" ? input : {};
  for (const [k, range] of Object.entries(BOUNDS)) {
    const n = Number(src[k]);
    if (src[k] !== undefined && src[k] !== null && src[k] !== "" && Number.isFinite(n)) s[k] = clamp(n, range);
  }
  if (typeof src.weekdaysOnly === "boolean") s.weekdaysOnly = src.weekdaysOnly;
  return s;
}

// This user's limits: the defaults, their saved settings on top, then made consistent.
function limitsFor(state) {
  const L = { ...LIMITS, ...cleanSettings(state && state.settings) };
  for (const [k, range] of Object.entries(BOUNDS)) L[k] = clamp(L[k], range);
  if (L.maxGapSec < L.minGapSec) L.maxGapSec = L.minGapSec;
  if (L.perHour > L.perDay) L.perHour = L.perDay;
  if (L.invitesPerDay > L.invitesPerWeek) L.invitesPerDay = L.invitesPerWeek;
  if (L.windowEnd <= L.windowStart) L.windowEnd = Math.min(24, L.windowStart + 1);
  return L;
}
const ACTIONS = ["invite", "message", "reply"];
const NOTE_MAX = 300; // LinkedIn's limit on an invitation note
const MAX_ACCOUNTS = Math.min(10, num(process.env.LI_AGENT_MAX_ACCOUNTS, 4)); // LinkedIn accounts per user
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => UUID_RE.test(String(v || ""));

// The account a queue row goes out from: its own, else the account that invited the same
// person (a message after an invitation must come from the one they accepted), else the
// user's first account. Shared by every query, so the queue, the caps and the lease agree.
const EFF_SQL = (a) => `coalesce(${a}.li_account_id,
  (select i.li_account_id from outreach_queue i where i.user_id = ${a}.user_id and i.prospect_id = ${a}.prospect_id
      and i.channel = 'linkedin' and i.action = 'invite' and i.li_account_id is not null order by i.created_at desc limit 1),
  (select x.id from linkedin_account x where x.user_id = ${a}.user_id and x.removed_at is null order by x.slot limit 1))`;

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
    // Run from Karma Connect: the user's own settings, dry run, what the worker last said about
    // itself (heartbeat), and one pending command for it ("check the inbox now", "sign in").
    await q("alter table linkedin_agent add column if not exists settings jsonb not null default '{}'::jsonb");
    await q("alter table linkedin_agent add column if not exists dry_run boolean not null default false");
    await q("alter table linkedin_agent add column if not exists worker jsonb");
    await q("alter table linkedin_agent add column if not exists command text");
    await q("alter table linkedin_agent add column if not exists command_at timestamptz");
    // A PC paired to this user. The worker signs in with the device token, never a password;
    // only hashes are stored, and the token opens the worker's own endpoints and nothing else.
    await q(`create table if not exists linkedin_agent_device (
      id              uuid primary key default gen_random_uuid(),
      user_id         uuid not null references users (id) on delete cascade,
      name            text,
      pair_code_hash  text,
      pair_expires_at timestamptz,
      token_hash      text unique,
      created_at      timestamptz not null default now(),
      paired_at       timestamptz,
      last_used_at    timestamptz,
      revoked_at      timestamptz)`);
    await q("create index if not exists linkedin_agent_device_user_idx on linkedin_agent_device (user_id)");
    // What the agent did, newest first, for the activity log in Karma Connect.
    await q(`create table if not exists linkedin_agent_event (
      id      bigserial primary key,
      user_id uuid not null references users (id) on delete cascade,
      at      timestamptz not null default now(),
      level   text not null default 'info',
      text    text not null)`);
    await q("create index if not exists linkedin_agent_event_user_idx on linkedin_agent_event (user_id, at desc)");
    // Several LinkedIn accounts per user. Each is its own agent: switch, dry run, limits, the
    // worker's last check-in and one pending command. slot is its place on the page (1..4);
    // device_id the PC that runs it. Removing one keeps the row (removed_at) so its sends still
    // count as its own and never land on another account's caps.
    await q(`create table if not exists linkedin_account (
      id           uuid primary key default gen_random_uuid(),
      user_id      uuid not null references users (id) on delete cascade,
      slot         int not null,
      label        text not null,
      device_id    uuid,
      enabled      boolean not null default false,
      dry_run      boolean not null default false,
      settings     jsonb not null default '{}'::jsonb,
      halted_at    timestamptz,
      halt_reason  text,
      last_seen_at timestamptz,
      last_sent_at timestamptz,
      worker       jsonb,
      command      text,
      command_at   timestamptz,
      removed_at   timestamptz,
      created_at   timestamptz not null default now(),
      updated_at   timestamptz not null default now())`);
    await q("create unique index if not exists linkedin_account_slot_idx on linkedin_account (user_id, slot) where removed_at is null");
    await q("alter table outreach_queue add column if not exists li_account_id uuid");
    await q("create index if not exists outreach_li_account_idx on outreach_queue (li_account_id)");
    await q("alter table linkedin_inbox add column if not exists li_account_id uuid");
    await q("alter table linkedin_copy add column if not exists li_account_id uuid");
    await q("alter table linkedin_agent_event add column if not exists li_account_id uuid");
    await q("alter table linkedin_agent_device add column if not exists worker jsonb");
    // Each user's single agent from before becomes their Account 1, with its settings, and
    // everything it sent or read moves with it.
    const { rows: moved } = await q(
      `insert into linkedin_account (user_id, slot, label, enabled, dry_run, settings, halted_at, halt_reason,
           last_seen_at, last_sent_at, worker)
       select a.user_id, 1, coalesce(nullif(a.worker->'linkedin'->>'name', ''), 'Account 1'), a.enabled, a.dry_run,
              a.settings, a.halted_at, a.halt_reason, a.last_seen_at, a.last_sent_at, a.worker
         from linkedin_agent a
        where not exists (select 1 from linkedin_account x where x.user_id = a.user_id)
       returning id, user_id`);
    for (const m of moved) await adoptUnassigned(m.user_id, m.id);
    await prospecting.ensureProspectingSchema();
  } catch (e) { console.error("ensureAgentSchema:", e.message); }
}

// Rows with no account yet (from before accounts existed) become this account's.
async function adoptUnassigned(userId, accountId) {
  await q("update outreach_queue set li_account_id = $2 where user_id = $1 and channel = 'linkedin' and li_account_id is null", [userId, accountId]);
  await q("update linkedin_inbox set li_account_id = $2 where user_id = $1 and li_account_id is null", [userId, accountId]);
}

// ── Accounts ────────────────────────────────────────────────────────
// This user's LinkedIn accounts, in slot order. There's always at least one.
async function listAccounts(userId) {
  const { rows } = await q("select * from linkedin_account where user_id = $1 and removed_at is null order by slot", [userId]);
  if (rows.length) return rows;
  const ins = await q(
    `insert into linkedin_account (user_id, slot, label) values ($1, 1, 'Account 1')
       on conflict (user_id, slot) where removed_at is null do nothing returning id`, [userId]);
  if (ins.rows[0]) await adoptUnassigned(userId, ins.rows[0].id);
  return (await q("select * from linkedin_account where user_id = $1 and removed_at is null order by slot", [userId])).rows;
}

// One account of this user's. No id (an older worker, an older page) means the first one;
// an id that isn't theirs, or was removed, is null.
async function accountFor(userId, accountId) {
  if (accountId == null || accountId === "") return (await listAccounts(userId))[0];
  if (!isUuid(accountId)) return null;
  const { rows } = await q("select * from linkedin_account where id = $1 and user_id = $2 and removed_at is null", [accountId, userId]);
  return rows[0] || null;
}

// Back-compat for code that asked for "the agent": the user's first account.
const getState = (userId) => accountFor(userId);

async function createAccount(userId, { label } = {}) {
  const list = await listAccounts(userId);
  if (list.length >= MAX_ACCOUNTS) throw new Error(`You can run up to ${MAX_ACCOUNTS} LinkedIn accounts.`);
  const used = new Set(list.map((a) => a.slot));
  let slot = 1;
  while (used.has(slot)) slot++;
  const name = String(label || "").trim().slice(0, 60) || "Account " + slot;
  const { rows } = await q("insert into linkedin_account (user_id, slot, label) values ($1,$2,$3) returning *", [userId, slot, name]);
  await addEvents(userId, [{ text: `Added LinkedIn account "${name}".` }], rows[0].id);
  return rows[0];
}

// Rename an account, or choose which PC runs it. Body: { label?, deviceId? (null = any PC) }.
async function updateAccount(userId, id, { label, deviceId, prospectOn, senderId } = {}) {
  const a = await accountFor(userId, id);
  if (!a || !isUuid(id)) return null;
  // "Find prospects for me" on or off, and who the AI writes as for this account
  if (prospectOn !== undefined) {
    await q("update linkedin_account set prospect_on = $2, updated_at = now() where id = $1", [a.id, !!prospectOn]);
    await addEvents(userId, [{ text: prospectOn ? "Finding prospects: on — it searches LinkedIn for restoration decision-makers and invites them." : "Finding prospects: off." }], a.id);
  }
  if (senderId !== undefined) await q("update linkedin_account set sender_id = $2, updated_at = now() where id = $1", [a.id, senderId ? String(senderId).slice(0, 40) : null]);
  if (label !== undefined) {
    const name = String(label || "").trim().slice(0, 60);
    if (!name) throw new Error("Give the account a name.");
    await q("update linkedin_account set label = $2, updated_at = now() where id = $1", [a.id, name]);
  }
  if (deviceId !== undefined) {
    let dev = null;
    if (deviceId) {
      const d = await q("select id, name from linkedin_agent_device where id = $1 and user_id = $2 and paired_at is not null and revoked_at is null", [isUuid(deviceId) ? deviceId : null, userId]);
      if (!d.rows[0]) throw new Error("That PC isn't connected.");
      dev = d.rows[0];
    }
    await q("update linkedin_account set device_id = $2, updated_at = now() where id = $1", [a.id, dev ? dev.id : null]);
    await addEvents(userId, [{ text: dev ? `Now runs on ${dev.name || "PC"}.` : "Runs on whichever connected PC picks it up first." }], a.id);
  }
  return accountFor(userId, a.id);
}

// Take an account off the agent. What it hadn't sent goes back to "any account" (the first),
// except replies, which only make sense in that account's own conversation.
async function removeAccount(userId, id) {
  const a = await accountFor(userId, id);
  if (!a || !isUuid(id)) return null;
  if ((await listAccounts(userId)).length <= 1) throw new Error("Keep at least one account. Sign it in to a different LinkedIn instead.");
  await q("update linkedin_account set removed_at = now(), enabled = false, command = null, updated_at = now() where id = $1", [a.id]);
  await q(`update outreach_queue set status = 'skipped', error = 'Its LinkedIn account was removed from the agent.', lease_id = null,
             leased_at = null, lease_expires_at = null, updated_at = now()
            where li_account_id = $1 and action = 'reply' and status in ('pending','approved','sending','failed')`, [a.id]);
  await q(`update outreach_queue set li_account_id = null, status = case when status = 'sending' then 'approved' else status end,
             lease_id = null, leased_at = null, lease_expires_at = null, updated_at = now()
            where li_account_id = $1 and status in ('pending','approved','sending','failed')`, [a.id]);
  await addEvents(userId, [{ level: "warn", text: `Removed LinkedIn account "${a.label}". Its unsent messages go from the first account now.` }]);
  return { id: a.id };
}

// Turn one account (or every account: accountId "all") on/off. Enabling clears a halt — the
// user has looked at it.
async function setEnabled(userId, enabled, accountId) {
  const all = accountId === "all";
  const target = all ? null : await accountFor(userId, accountId);
  if (!all && !target) return null;
  await listAccounts(userId);
  const { rows } = await q(
    `update linkedin_account set enabled = $2,
       halted_at = case when $2 then null else halted_at end,
       halt_reason = case when $2 then null else halt_reason end,
       updated_at = now()
     where user_id = $1 and removed_at is null and ($3::uuid is null or id = $3) returning *`,
    [userId, !!enabled, target ? target.id : null],
  );
  logActivity(userId, enabled ? "li_agent_started" : "li_agent_stopped", {});
  for (const r of rows) await addEvents(userId, [{ text: enabled ? "Started from Karma Connect." : "Paused from Karma Connect." }], r.id);
  return rows[0] || null;
}

// Stop one account and record why. Called when the worker reports a checkpoint/captcha, or when
// LinkedIn says the sending limit is reached — we never try to work around it, we stop and
// hand it back to the human. The other accounts carry on.
async function halt(userId, accountId, reason) {
  const a = await accountFor(userId, accountId);
  if (!a) return null;
  const { rows } = await q(
    "update linkedin_account set enabled = false, halted_at = now(), halt_reason = $2, updated_at = now() where id = $1 returning *",
    [a.id, String(reason || "Stopped").slice(0, 300)],
  );
  logActivity(userId, "li_agent_halted", { detail: String(reason || "").slice(0, 80) });
  await addEvents(userId, [{ level: "error", text: "Stopped: " + String(reason || "Stopped") }], a.id);
  return rows[0];
}

// ── Caps ────────────────────────────────────────────────────────────
// What each account has sent recently and what's waiting for it, straight from the queue table
// (sent_at is the source of truth — no separate counter to drift). Messages and replies share
// one budget; invitations have their own. One pass, grouped by account.
async function queueCounts(userId) {
  const { rows } = await q(
    `select x.acct,
       count(*) filter (where x.status = 'sent' and x.action <> 'invite' and x.sent_at > now() - interval '24 hours') as day,
       count(*) filter (where x.status = 'sent' and x.action <> 'invite' and x.sent_at > now() - interval '1 hour')   as hour,
       count(*) filter (where x.status = 'sent' and x.action = 'invite' and x.sent_at > now() - interval '24 hours')  as inv_day,
       count(*) filter (where x.status = 'sent' and x.action = 'invite' and x.sent_at > now() - interval '7 days')    as inv_week,
       max(x.sent_at) filter (where x.status = 'sent') as last_sent,
       count(*) filter (where x.status = 'approved' and not x.waiting) as ready,
       count(*) filter (where x.status = 'approved' and x.waiting)     as waiting,
       count(*) filter (where x.status = 'sending')                     as inflight
     from (select ${EFF_SQL("o")} as acct, o.status, o.action, o.sent_at, ${WAITING_SQL("o")} as waiting
             from outreach_queue o
            where o.user_id = $1 and o.channel = 'linkedin' and o.status in ('sent','approved','sending')) x
     group by x.acct`,
    [userId],
  );
  const m = new Map();
  for (const r of rows) {
    m.set(String(r.acct), { day: Number(r.day || 0), hour: Number(r.hour || 0), invDay: Number(r.inv_day || 0),
      invWeek: Number(r.inv_week || 0), lastSent: r.last_sent || null,
      ready: Number(r.ready || 0), waiting: Number(r.waiting || 0), inflight: Number(r.inflight || 0) });
  }
  return m;
}
const NO_COUNTS = { day: 0, hour: 0, invDay: 0, invWeek: 0, lastSent: null, ready: 0, waiting: 0, inflight: 0 };
async function sentCounts(userId, accountId) {
  return (await queueCounts(userId)).get(String(accountId)) || { ...NO_COUNTS };
}

/* Today's invitation target for one account (li-weekly.cjs), from the invitations it has sent
   since the PC's Monday 00:00 and its midnight. `local` is the PC's { localHour, localDay,
   localMinute }. Returns { target, today, week, weekCap }. */
async function inviteTarget(userId, acct, L, local, now = Date.now()) {
  const b = weekly.localBounds({ now, ...local });
  const { rows } = await q(
    `select count(*) as week, count(*) filter (where o.sent_at >= $4) as today
       from outreach_queue o
      where o.user_id = $1 and o.channel = 'linkedin' and o.action = 'invite' and o.status = 'sent'
        and o.sent_at >= $3 and ${EFF_SQL("o")} = $2`,
    [userId, acct.id, new Date(b.weekStart), new Date(b.todayStart)]);
  const week = Number((rows[0] && rows[0].week) || 0), today = Number((rows[0] && rows[0].today) || 0);
  // this week's total differs week to week (never over invitesPerWeek); the days share it
  const weekCap = weekly.weekTarget({ weekCap: L.invitesPerWeek, accountId: acct.id, weekIndex: b.weekIndex });
  const target = weekly.dailyTarget({ weekCap, maxPerDay: L.invitesPerDay, sentBeforeToday: week - today,
    localDay: local.localDay, weekdaysOnly: L.weekdaysOnly, accountId: acct.id, dayIndex: b.dayIndex });
  return { target, today, week, weekCap };
}

// Two accounts signed in to the same LinkedIn would each get the full caps. Name the other one.
async function sameLinkedIn(userId, acct) {
  const h = acct && acct.worker && acct.worker.linkedin && acct.worker.linkedin.handle;
  if (!h) return null;
  const { rows } = await q(
    `select label from linkedin_account where user_id = $1 and id <> $2 and removed_at is null
        and lower(worker->'linkedin'->>'handle') = lower($3) limit 1`, [userId, acct.id, h]);
  return rows[0] ? rows[0].label : null;
}

// Is `now` inside the allowed sending window? The worker passes its own local hour/day, because
// the server may well be in a different timezone than the recruiter.
function inWindow(localHour, localDay, L = LIMITS) {
  if (L.weekdaysOnly && (localDay === 0 || localDay === 6)) return false;
  return localHour >= L.windowStart && localHour < L.windowEnd;
}

// The single "may I act right now, and how much" decision. Pure apart from the counts it's
// handed, so it unit-tests without a database. `msg` is how many messages/replies may go out
// in this batch, `inv` how many invitations; `allowed` is the two together (never over batch).
function decide({ state, counts, localHour, localDay, now = Date.now(), limits: L = LIMITS }) {
  const none = { allowed: 0, msg: 0, inv: 0 };
  if (!state || !state.enabled) return { ok: false, reason: state && state.halt_reason ? state.halt_reason : "The agent is off.", ...none };
  if (!inWindow(localHour, localDay, L)) {
    return { ok: false, reason: `Outside the sending window (${L.windowStart}:00–${L.windowEnd}:00${L.weekdaysOnly ? ", weekdays" : ""}).`, ...none };
  }
  if (counts.lastSent) {
    const gap = (now - new Date(counts.lastSent).getTime()) / 1000;
    if (gap < L.minGapSec) return { ok: false, reason: `Too soon — ${Math.ceil(L.minGapSec - gap)}s to go.`, ...none, retryInSec: Math.ceil(L.minGapSec - gap) };
  }
  const msg = Math.max(0, Math.min(L.batch, L.perDay - (counts.day || 0), L.perHour - (counts.hour || 0)));
  // With today's target (counts.invTarget, from inviteTarget) the day's room is what's left of it;
  // without one, the plain rolling-24h cap.
  const spread = Number.isInteger(counts.invTarget);
  const dayRoom = spread ? counts.invTarget - (counts.invToday || 0) : L.invitesPerDay - (counts.invDay || 0);
  const inv = Math.max(0, Math.min(L.batch, dayRoom, L.invitesPerWeek - (counts.invWeek || 0)));
  const allowed = Math.min(L.batch, msg + inv);
  if (allowed > 0) return { ok: true, reason: "", allowed, msg, inv };
  const why = [];
  if ((counts.day || 0) >= L.perDay) why.push(`Daily message cap reached (${L.perDay}).`);
  else if ((counts.hour || 0) >= L.perHour) why.push(`Hourly message cap reached (${L.perHour}).`);
  if ((counts.invWeek || 0) >= L.invitesPerWeek) why.push(`Weekly invitation cap reached (${L.invitesPerWeek}).`);
  else if (spread && (counts.invThisWeek || 0) >= (counts.invWeekTarget || L.invitesPerWeek)) why.push(`This week's ${counts.invWeekTarget || L.invitesPerWeek} invitations are sent.`);
  else if (spread && dayRoom <= 0) why.push(`Today's invitation target reached (${counts.invTarget} of ${counts.invWeekTarget || L.invitesPerWeek} this week).`);
  else if (!spread && (counts.invDay || 0) >= L.invitesPerDay) why.push(`Daily invitation cap reached (${L.invitesPerDay}).`);
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

// Claim up to `limit` approved, due items of the given actions for this account. Replies
// first — someone is waiting on those — then oldest scheduled. A claimed row is pinned to the
// account, so its report, its caps and any follow-up stay with it.
async function claim(userId, accountId, actions, limit, leaseId, expires) {
  if (limit <= 0) return [];
  const { rows } = await q(
    `update outreach_queue set status = 'sending', lease_id = $2, leased_at = now(), lease_expires_at = $3,
       attempts = attempts + 1, li_account_id = $5, updated_at = now()
       where id in (
         select o.id from outreach_queue o
           where o.user_id = $1 and o.channel = 'linkedin' and o.status = 'approved' and o.action = any($4)
             and (o.scheduled_at is null or o.scheduled_at <= now())
             and not ${WAITING_SQL("o")}
             and ${EFF_SQL("o")} = $5
           order by (o.action = 'reply') desc, o.scheduled_at nulls first
           limit ${Number(limit)} for update skip locked)
       returning id, prospect_id, lead_label, body, linkedin_url, step, action, thread_url, note_optional`,
    [userId, String(leaseId || "").slice(0, 64) || null, expires, actions, accountId],
  );
  return rows;
}

// Hand the worker its next batch for one account. Returns { items, wait, reason } — items may be
// empty with a reason the worker shows the user, and `wait` is how many seconds to sleep before
// asking again.
async function lease(userId, acct, { leaseId, localHour, localDay, localMinute } = {}) {
  if (!dbOn) return { items: [], wait: 60, reason: "No database configured." };
  await reclaimStale();
  const state = acct;
  const L = limitsFor(state);
  const counts = await sentCounts(userId, acct.id);
  const t = await inviteTarget(userId, acct, L, { localHour, localDay, localMinute });
  Object.assign(counts, { invTarget: t.target, invToday: t.today, invThisWeek: t.week, invWeekTarget: t.weekCap });
  const twin = state.enabled ? await sameLinkedIn(userId, acct) : null;
  if (twin) return { items: [], wait: 300, reason: `Signed in to the same LinkedIn as "${twin}". Sign one of them in to a different account.`, limits: L, counts, dryRun: !!state.dry_run };
  const verdict = decide({ state, counts, localHour, localDay, limits: L });
  if (!verdict.ok) {
    return { items: [], wait: verdict.retryInSec || 300, reason: verdict.reason, limits: L, counts, dryRun: !!state.dry_run };
  }
  const expires = new Date(Date.now() + L.leaseMin * 60000);
  const msgs = await claim(userId, acct.id, ["reply", "message"], verdict.msg, leaseId, expires);
  const invs = await claim(userId, acct.id, ["invite"], Math.min(verdict.inv, verdict.allowed - msgs.length), leaseId, expires);
  const rows = [...msgs, ...invs];
  await q("update linkedin_account set last_seen_at = now(), updated_at = now() where id = $1", [acct.id]);
  return {
    items: rows,
    wait: rows.length ? L.minGapSec : 300,
    reason: rows.length ? "" : "Nothing approved and due in the queue.",
    limits: L,
    counts,
    dryRun: !!state.dry_run,
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
async function report(userId, id, { result, error, leaseId, scrape, connected, final, profileText, noteDropped } = {}) {
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
  const acctId = row.li_account_id; // set when it was claimed; null → the first account
  // LinkedIn's free notes for the month are used up: the rest go without one
  if (isInvite && noteDropped) await prospecting.notesUsedUp(acctId).catch(() => {});

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
    const a = await accountFor(userId, acctId);
    if (a) await q("update linkedin_account set last_sent_at = now(), last_seen_at = now(), updated_at = now() where id = $1", [a.id]);
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
    if (unverified) await halt(userId, acctId, "A send couldn't be confirmed — check that " + (isInvite ? "profile" : "thread") + " on LinkedIn before restarting.");
    return rows[0];
  }

  if (result === "halted") {
    await q(
      `update outreach_queue set status = 'approved', lease_id = null, leased_at = null, lease_expires_at = null,
         ${keepScrapeFrom(3)}, updated_at = now() where id = $1 and user_id = $2`,
      [id, userId, ...scrapeArgs],
    );
    await halt(userId, acctId, error || "LinkedIn asked for a human (checkpoint or limit).");
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
/* Every incoming conversation is read and kept, not only replies from people this user reached
   out to — chosen by the owner on 2026-10-20 (the accounts are work LinkedIns, and a message
   from someone new is often new business). LI_INBOX_ALL=0 goes back to outreach replies only. */
const INBOX_ALL = process.env.LI_INBOX_ALL !== "0";

// What the worker should look out for: the people this user has messaged or invited (so it
// can tell their conversations apart in the inbox), and the
// invitations still waiting (so it can spot them in the new-connections list). Reading pages
// is activity too, so this answers only while the agent is on and inside the window.
async function watch(userId, acct, { localHour, localDay, justStarted = false } = {}) {
  if (!dbOn) return { ok: false, reason: "No database configured.", people: [], pendingInvites: [] };
  const state = acct;
  if (!state.enabled) return { ok: false, reason: state.halt_reason || "The agent is off.", people: [], pendingInvites: [], needProfile: [] };
  if (!inWindow(localHour, localDay, limitsFor(state))) return { ok: false, reason: "Outside the window.", people: [], pendingInvites: [], needProfile: [] };
  if (await sameLinkedIn(userId, acct)) return { ok: false, reason: "Signed in to the same LinkedIn as another account.", people: [], pendingInvites: [], needProfile: [] };
  const { rows } = await q(
    `select distinct on (coalesce(o.linkedin_url, o.lead_label)) o.linkedin_url, o.lead_label, o.action, o.invite_state
       from outreach_queue o
      where o.user_id = $1 and o.channel = 'linkedin' and o.status = 'sent' and o.sent_at > now() - interval '120 days'
        and ${EFF_SQL("o")} = $2
      order by coalesce(o.linkedin_url, o.lead_label), o.sent_at desc limit 1000`,
    [userId, acct.id],
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
    `select o.linkedin_url from outreach_queue o
      where o.user_id = $1 and o.channel = 'linkedin' and o.action = 'invite' and o.status = 'sent'
        and coalesce(o.invite_state, 'pending') = 'pending' and o.sent_at > now() - interval '60 days'
        and ${EFF_SQL("o")} = $2`,
    [userId, acct.id],
  );
  const pendingInvites = [...new Set(pend.rows.map((r) => handleOf(r.linkedin_url)).filter(Boolean))];
  await q("update linkedin_account set last_seen_at = now(), updated_at = now() where id = $1", [acct.id]);
  return { ok: true, reason: "", people, readAll: INBOX_ALL, pendingInvites, needProfile: await needProfile(userId, acct.id),
    // an agent that has just started searches at once, without waiting out the gap
    search: await prospecting.nextSearch(userId, acct, limitsFor(acct), { ignoreGap: justStarted }).catch(() => null) };
}

// The worker saw these handles in this account's new-connections list: their invitations were
// accepted. Marking the invitation accepted is what releases any message waiting on it.
async function markAccepted(userId, acct, handles) {
  if (!dbOn) return { accepted: 0 };
  const want = new Set((Array.isArray(handles) ? handles : []).map((h) => handleOf("linkedin.com/in/" + h)).filter(Boolean).slice(0, 500));
  if (!want.size) return { accepted: 0 };
  const { rows } = await q(
    `select o.id, o.prospect_id, o.lead_label, o.linkedin_url from outreach_queue o
      where o.user_id = $1 and o.channel = 'linkedin' and o.action = 'invite' and o.status = 'sent'
        and coalesce(o.invite_state, 'pending') = 'pending' and ${EFF_SQL("o")} = $2`,
    [userId, acct.id],
  );
  const hits = rows.filter((r) => want.has(handleOf(r.linkedin_url)));
  if (!hits.length) return { accepted: 0 };
  await q("update outreach_queue set invite_state = 'accepted', accepted_at = now(), updated_at = now() where id = any($1::uuid[])", [hits.map((r) => r.id)]);
  for (const r of hits) {
    await bumpProspect(userId, r.prospect_id, "connected");
    logActivity(userId, "li_invite_accepted", { prospectId: r.prospect_id, label: r.lead_label });
  }
  await wantFollowup(userId, hits);
  return { accepted: hits.length, needProfile: await needProfile(userId, acct.id) };
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

// Profiles this account should go and copy, a few at a time (each is a page visit).
async function needProfile(userId, accountId, limit = 5) {
  const { rows } = await q(
    `select o.linkedin_url from outreach_queue o
      where o.user_id = $1 and o.action = 'invite' and o.followup_state = 'needs_profile' and o.linkedin_url is not null
        and ${EFF_SQL("o")} = $2
      order by o.accepted_at nulls last limit ${Number(limit)}`, [userId, accountId]);
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
async function recordProfile(userId, acct, { handle, text } = {}) {
  if (!dbOn) return { stored: false };
  const h = handleOf("linkedin.com/in/" + String(handle || ""));
  if (!h) return { stored: false };
  const { rows } = await q(
    `select o.id, o.linkedin_url from outreach_queue o where o.user_id = $1 and o.action = 'invite' and o.followup_state = 'needs_profile'
        and ${EFF_SQL("o")} = $2`, [userId, acct.id]);
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
            o.followup_state, o.followup_draft, o.accepted_at, ${EFF_SQL("o")} as li_account_id,
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
  const { rows: r } = await q(`select o.*, ${EFF_SQL("o")} as eff_account from outreach_queue o where o.id = $1 and o.user_id = $2 and o.action = 'invite'`, [id, userId]);
  const inv = r[0];
  if (!inv) return null;
  if (inv.followup_state === "queued") throw new Error("This first message is already queued.");
  // From the account they accepted: on any other, they aren't a connection yet.
  const { rows } = await q(
    `insert into outreach_queue (user_id, prospect_id, lead_label, channel, step, body, linkedin_url, status,
        scheduled_at, approved_by, approved_at, action, li_account_id)
     values ($1,$2,$3,'linkedin','relationship',$4,$5,'approved', now(), $6, now(), 'message', $7) returning *`,
    [userId, inv.prospect_id, inv.lead_label, text, inv.linkedin_url, approvedBy || null, inv.eff_account || null]);
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
// reached out to — by profile handle, else by exact name. One that matches nobody is kept as
// an incoming message with no prospect (INBOX_ALL), or dropped when that's off. A thread whose
// last message is theirs needs a reply; it's flagged, and a matched prospect moves to 'replied'.
//   threads: [{ threadKey, threadUrl, name, profileUrl, messages: [{ from: 'them'|'me', text }] }]
async function recordInbox(userId, acct, threads) {
  if (!dbOn) return { stored: 0, needReply: 0 };
  const list = (Array.isArray(threads) ? threads : []).slice(0, 40);
  if (!list.length) return { stored: 0, needReply: 0 };
  // Only people THIS account reached out to: the same prospect may be in two accounts' queues,
  // and each account's conversation is its own thread.
  const { rows: sent } = await q(
    `select o.prospect_id, o.lead_label, o.linkedin_url from outreach_queue o
      where o.user_id = $1 and o.channel = 'linkedin' and o.status = 'sent' and ${EFF_SQL("o")} = $2
      order by o.sent_at desc limit 3000`,
    [userId, acct.id],
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
    if (!match && !INBOX_ALL) continue;
    const msgs = (Array.isArray(t.messages) ? t.messages : [])
      .filter((m) => m && (m.from === "them" || m.from === "me") && String(m.text || "").trim())
      .slice(-30)
      .map((m) => ({ from: m.from, text: String(m.text).trim().slice(0, 2000) }));
    if (!msgs.length) continue;
    const last = msgs[msgs.length - 1];
    const threadUrl = /^https:\/\/www\.linkedin\.com\/messaging\/thread\//i.test(String(t.threadUrl || "")) ? String(t.threadUrl).slice(0, 400) : null;
    const { rows } = await q(
      `insert into linkedin_inbox (user_id, thread_key, thread_url, name, profile_url, prospect_id, lead_label,
          messages, last_text, last_from, last_at, needs_reply, li_account_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10, now(), $11, $12)
       on conflict (user_id, thread_key) do update set
         li_account_id = excluded.li_account_id,
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
      [userId, key, threadUrl, String(t.name || (match && match.lead_label) || "").slice(0, 200), handle ? "https://www.linkedin.com/in/" + encodeURIComponent(handle) + "/" : null,
       match ? match.prospect_id : null, match ? match.lead_label : null, JSON.stringify(msgs), last.text, last.from, last.from === "them", acct.id],
    );
    stored++;
    if (rows[0] && rows[0].needs_reply) needReply++;
    if (match && msgs.some((m) => m.from === "them")) await bumpProspect(userId, match.prospect_id, "replied");
  }
  return { stored, needReply };
}

// ── Inbox (the Send Queue's side) ───────────────────────────────────
async function listInbox(userId) {
  if (!dbOn) return [];
  const { rows } = await q(
    `select i.*, a.label as account_label, exists (select 1 from outreach_queue o where o.inbox_id = i.id and o.user_id = i.user_id
              and o.status in ('pending', 'approved', 'sending')) as reply_queued
       from linkedin_inbox i left join linkedin_account a on a.id = i.li_account_id
      where i.user_id = $1 and a.removed_at is null
      order by i.needs_reply desc, i.last_at desc nulls last limit 150`,
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
  // A reply goes from the account whose conversation it is.
  const { rows } = await q(
    `insert into outreach_queue (user_id, prospect_id, lead_label, channel, step, body, linkedin_url, status,
        scheduled_at, approved_by, approved_at, action, thread_url, inbox_id, li_account_id)
     values ($1,$2,$3,'linkedin','reply',$4,$5,'approved', now(), $6, now(), 'reply', $7, $8, $9) returning *`,
    [userId, th.prospect_id || "li-thread:" + th.thread_key, th.lead_label || th.name, text, th.profile_url, approvedBy || null, th.thread_url, th.id, th.li_account_id || null],
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
// worker picks requests up within a few seconds while it's running. A person asked for this
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
       error = 'The agent didn''t pick this up. Is its PC on and connected? Check the LinkedIn agent page.'
     where user_id = $1 and status = 'pending' and created_at < now() - ($2 || ' minutes')::interval`, [userId, String(COPY_WAIT_MIN)]);
  const { rows } = await q("select id, url, status, text, error from linkedin_copy where id = $1 and user_id = $2", [id, userId]);
  const r = rows[0];
  if (!r) return null;
  // Any running account can copy a profile.
  const on = (await listAccounts(userId)).filter((a) => a.enabled);
  const seen = on.map((a) => a.last_seen_at).filter(Boolean).sort().pop() || null;
  return { ...r, agentOn: on.length > 0, agentSeen: seen };
}

// An account asks for copy requests: whichever running account asks first takes one, within its
// own daily cap. Ones it took but never answered go back after 5 minutes.
async function leaseCopies(userId, acct) {
  if (!dbOn) return { items: [] };
  const state = acct;
  if (!state.enabled) return { items: [], reason: state.halt_reason || "The agent is off." };
  await q("update linkedin_copy set status = 'pending', started_at = null where user_id = $1 and status = 'copying' and started_at < now() - interval '5 minutes'", [userId]);
  const L = limitsFor(state);
  const { rows: c } = await q("select count(*) as n from linkedin_copy where user_id = $1 and li_account_id = $2 and status = 'done' and done_at > now() - interval '24 hours'", [userId, acct.id]);
  if (Number(c[0].n) >= L.copiesPerDay) {
    // Fail them only if no other running account could take them.
    const others = (await listAccounts(userId)).filter((a) => a.enabled && a.id !== acct.id);
    if (!others.length) {
      await q(`update linkedin_copy set status = 'failed', done_at = now(), error = $2 where user_id = $1 and status = 'pending'`,
        [userId, `Daily limit of ${L.copiesPerDay} profile copies reached — paste this one by hand, or try tomorrow.`]);
    }
    return { items: [], reason: "Daily copy limit reached." };
  }
  const { rows } = await q(
    `update linkedin_copy set status = 'copying', started_at = now(), li_account_id = $2
       where id in (select id from linkedin_copy where user_id = $1 and status = 'pending' order by created_at limit 2 for update skip locked)
     returning id, url`, [userId, acct.id]);
  await q("update linkedin_account set last_seen_at = now(), updated_at = now() where id = $1", [acct.id]);
  return { items: rows.map((r) => ({ id: r.id, handle: handleOf(r.url) })) };
}

async function finishCopy(userId, acct, id, { text, error, halt: haltMsg } = {}) {
  const t = String(text || "").trim().slice(0, 60000);
  if (haltMsg) await halt(userId, acct.id, String(haltMsg).slice(0, 300));
  const ok = !haltMsg && t.length >= 200;
  const { rows } = await q(
    `update linkedin_copy set status = $3, text = $4, error = $5, done_at = now()
      where id = $1 and user_id = $2 and status in ('pending','copying') returning id, status`,
    [id, userId, ok ? "done" : "failed", ok ? t : null,
     ok ? null : String(haltMsg || error || "Couldn't read their profile page.").slice(0, 300)]);
  return rows[0] || null;
}

// ── Run from Karma Connect: settings, dry run, commands, heartbeat ──
// Settings saved on the LinkedIn agent page, for one account. Only known keys inside BOUNDS are kept.
async function saveSettings(userId, accountId, { settings, dryRun } = {}) {
  const a = await accountFor(userId, accountId);
  if (!a) return null;
  if (settings !== undefined) {
    const clean = cleanSettings(settings);
    await q("update linkedin_account set settings = $2::jsonb, updated_at = now() where id = $1", [a.id, JSON.stringify(clean)]);
    await addEvents(userId, [{ text: "Settings changed in Karma Connect." }], a.id);
  }
  if (typeof dryRun === "boolean") {
    await q("update linkedin_account set dry_run = $2, updated_at = now() where id = $1", [a.id, dryRun]);
    await addEvents(userId, [{ text: dryRun ? "Dry run on: the agent types everything but never presses Send." : "Dry run off: the agent sends for real." }], a.id);
  }
  return status(userId);
}

// One thing for an account to do on the PC's next check-in (every few seconds). A newer
// command replaces an older one that hasn't been picked up; a stale one is ignored.
const COMMANDS = {
  check_inbox: "Check the LinkedIn inbox now.",
  check_accepts: "Check for accepted invitations now.",
  linkedin_login: "Open LinkedIn on the PC to sign in.",
};
const COMMAND_TTL_MIN = 10;
async function setCommand(userId, accountId, command) {
  if (!COMMANDS[command]) throw new Error("Unknown command.");
  const a = await accountFor(userId, accountId);
  if (!a) throw new Error("That LinkedIn account isn't on the agent any more.");
  await q("update linkedin_account set command = $2, command_at = now(), updated_at = now() where id = $1", [a.id, command]);
  await addEvents(userId, [{ text: "Asked from Karma Connect: " + COMMANDS[command] }], a.id);
  return status(userId);
}

// What the PC tells us about itself, and about each account it runs.
const WORKER_STATES = ["idle", "working", "paused", "signing_in", "signed_out", "starting"];
const s_ = (v, n) => (v == null ? null : String(v).slice(0, n));
function cleanPc(w) {
  return { version: s_(w && w.version, 20), host: s_(w && w.host, 80), browser: s_(w && w.browser, 30), startedAt: s_(w && w.startedAt, 40) };
}
function cleanWorker(w) {
  const li = (w && w.linkedin) || {};
  return {
    ...cleanPc(w),
    state: WORKER_STATES.includes(w && w.state) ? w.state : "idle",
    activity: s_(w && w.activity, 200),
    linkedin: li.handle || li.name ? { name: s_(li.name, 120), handle: s_(li.handle, 120) } : null,
    lastInboxAt: s_(w && w.lastInboxAt, 40),
    lastAcceptAt: s_(w && w.lastAcceptAt, 40),
  };
}

// Record one account's check-in and hand over its pending command, once.
async function beatAccount(acct, info) {
  const { rows } = await q(
    `with prev as (select command, command_at from linkedin_account where id = $1 for update)
     update linkedin_account a set worker = coalesce($2::jsonb, a.worker),
         last_seen_at = case when $2::jsonb is null then a.last_seen_at else now() end,
         command = null, command_at = null, updated_at = now()
       from prev where a.id = $1
     returning a.*, prev.command as old_command, prev.command_at as old_command_at`,
    [acct.id, info ? JSON.stringify(info) : null],
  );
  const st = rows[0];
  const fresh = st.old_command && st.old_command_at && Date.now() - new Date(st.old_command_at).getTime() < COMMAND_TTL_MIN * 60000;
  return { st, command: fresh ? st.old_command : null };
}
const controlFor = (st, command) => ({
  id: st.id, slot: st.slot, label: st.label, enabled: !!st.enabled, dryRun: !!st.dry_run,
  haltReason: st.halt_reason || null, limits: limitsFor(st), command,
});

// The PC checks in. Body:
//   { worker: { version, host, browser, startedAt },
//     accounts: [{ id, state, activity, linkedin: { name, handle }, lastInboxAt, lastAcceptAt }],
//     events: [{ accountId?, at, level, text }] }
// → { accounts: [{ id, slot, label, enabled, dryRun, haltReason, limits, command }], removed: [id] }
// `accounts` is what this PC should run: the ones set to it, and any not set to a PC yet (it
// takes those). An agent from before accounts (no `accounts` in the body) runs the first one
// and gets the old single-agent answer.
async function heartbeat(userId, { worker, accounts, events, device } = {}) {
  if (!dbOn) return { enabled: false, dryRun: false, limits: LIMITS, command: null, accounts: [], removed: [] };
  const all = await listAccounts(userId);
  if (device) {
    await q("update linkedin_agent_device set worker = $2::jsonb, last_used_at = now() where id = $1", [device.id, JSON.stringify(cleanPc(worker))]);
  }

  if (!Array.isArray(accounts)) {
    const first = all[0];
    if (device && !first.device_id) await q("update linkedin_account set device_id = $2 where id = $1", [first.id, device.id]);
    const info = { ...cleanWorker(worker), device: device ? { id: device.id, name: device.name } : null };
    const { st, command } = await beatAccount(first, info);
    await addEvents(userId, events, first.id);
    return { enabled: !!st.enabled, dryRun: !!st.dry_run, haltReason: st.halt_reason || null, limits: limitsFor(st), command };
  }

  let mine = all;
  if (device) {
    const free = all.filter((a) => !a.device_id).map((a) => a.id);
    if (free.length) await q("update linkedin_account set device_id = $2 where id = any($1::uuid[]) and device_id is null", [free, device.id]);
    mine = all.filter((a) => !a.device_id || a.device_id === device.id);
  }
  const reported = new Map(accounts.filter((x) => x && isUuid(x.id)).map((x) => [x.id, x]));
  const out = [];
  for (const a of mine) {
    const rep = reported.get(a.id);
    const info = rep ? { ...cleanWorker({ ...worker, ...rep }), device: device ? { id: device.id, name: device.name } : null } : null;
    const { st, command } = await beatAccount(a, info);
    out.push(controlFor(st, command));
  }
  // Log lines: each goes to the account it names, if this PC runs it; otherwise to the user.
  const ids = new Set(mine.map((a) => a.id));
  const list = Array.isArray(events) ? events.slice(0, 100) : [];
  const general = list.filter((e) => !(e && ids.has(e.accountId)));
  if (general.length) await addEvents(userId, general);
  for (const id of ids) {
    const own = list.filter((e) => e && e.accountId === id);
    if (own.length) await addEvents(userId, own, id);
  }
  // Accounts taken off this PC's list in the last 30 days: the PC deletes their saved sign-in.
  const { rows: gone } = await q(
    `select id from linkedin_account where user_id = $1 and removed_at > now() - interval '30 days'
        and ($2::uuid is null or device_id = $2 or device_id is null)`, [userId, device ? device.id : null]);
  return { accounts: out, removed: gone.map((r) => r.id) };
}

// ── Activity log ────────────────────────────────────────────────────
const EVENT_KEEP_DAYS = 14;
async function addEvents(userId, events, accountId = null) {
  const list = (Array.isArray(events) ? events : []).slice(0, 50)
    .map((e) => ({ level: ["info", "warn", "error", "success"].includes(e && e.level) ? e.level : "info",
      text: String((e && e.text) || "").trim().slice(0, 400), at: e && e.at && !isNaN(Date.parse(e.at)) ? new Date(e.at) : new Date() }))
    .filter((e) => e.text)
    // A worker clock that's off can't plant entries far in the future or the past.
    .map((e) => (Math.abs(e.at.getTime() - Date.now()) > 3600000 ? { ...e, at: new Date() } : e));
  if (!list.length || !dbOn) return 0;
  await q(
    `insert into linkedin_agent_event (user_id, li_account_id, at, level, text)
       select $1, $3, x.at, x.level, x.text from jsonb_to_recordset($2::jsonb) as x(at timestamptz, level text, text text)`,
    [userId, JSON.stringify(list), isUuid(accountId) ? accountId : null],
  );
  if (Math.random() < 0.05) {
    await q(`delete from linkedin_agent_event where user_id = $1 and at < now() - interval '${EVENT_KEEP_DAYS} days'`, [userId]).catch(() => {});
  }
  return list.length;
}
// Newest first. With an account: its lines and the general ones (PCs connecting, and so on).
async function listEvents(userId, { limit = 150, accountId } = {}) {
  if (!dbOn) return [];
  const one = isUuid(accountId) ? accountId : null;
  const { rows } = await q(
    `select e.id, e.at, e.level, e.text, e.li_account_id as account_id, a.label as account_label
       from linkedin_agent_event e left join linkedin_account a on a.id = e.li_account_id
      where e.user_id = $1 and ($2::uuid is null or e.li_account_id = $2 or e.li_account_id is null)
      order by e.at desc, e.id desc limit ${Math.min(500, Math.max(1, Number(limit) || 150))}`,
    [userId, one],
  );
  return rows;
}

// ── Queue rows: which account sends them ────────────────────────────
// Pick the account an unsent LinkedIn item goes from (null = automatic). A reply stays with the
// account whose conversation it is.
async function setQueueAccount(userId, id, accountId) {
  let target = null;
  if (accountId) {
    target = await accountFor(userId, accountId);
    if (!target || !isUuid(accountId)) throw new Error("That LinkedIn account isn't on the agent.");
  }
  const { rows } = await q(
    `update outreach_queue set li_account_id = $3, updated_at = now()
      where id = $1 and user_id = $2 and channel = 'linkedin' and action <> 'reply' and status in ('pending','approved','failed')
      returning id`, [id, userId, target ? target.id : null]);
  if (!rows[0]) return null;
  const { rows: r } = await q(`select o.*, ${WAITING_SQL("o")} as waiting, ${EFF_SQL("o")} as li_account_eff from outreach_queue o where o.id = $1`, [id]);
  return r[0];
}

// ── Pairing a PC ────────────────────────────────────────────────────
// Karma Connect shows a short code; the worker on the PC trades it for a long-lived device
// token (`--pair CODE`). The code lasts 15 minutes and works once. Only SHA-256 hashes of the
// code and the token are stored, so a database read can't be used to impersonate a PC.
const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const PAIR_TTL_MIN = 15;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
function newCode() {
  const b = crypto.randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s.slice(0, 4) + "-" + s.slice(4);
}

async function createPairCode(userId) {
  // Unused codes from earlier attempts are cleared, so only the newest one works.
  await q("delete from linkedin_agent_device where user_id = $1 and paired_at is null", [userId]);
  const code = newCode();
  const expires = new Date(Date.now() + PAIR_TTL_MIN * 60000);
  await q("insert into linkedin_agent_device (user_id, pair_code_hash, pair_expires_at) values ($1,$2,$3)", [userId, sha(normCode(code)), expires]);
  return { code, expiresAt: expires.toISOString() };
}

async function claimPairCode({ code, name } = {}) {
  const c = normCode(code);
  if (c.length !== 8) return null;
  const token = "kca_" + crypto.randomBytes(32).toString("base64url");
  const { rows } = await q(
    `update linkedin_agent_device set token_hash = $2, pair_code_hash = null, pair_expires_at = null, paired_at = now(),
         last_used_at = now(), name = $3
       where pair_code_hash = $1 and paired_at is null and revoked_at is null and pair_expires_at > now()
     returning id, user_id, name`,
    [sha(c), sha(token), String(name || "PC").slice(0, 80)],
  );
  const d = rows[0];
  if (!d) return null;
  // The same PC connecting again replaces its old entry: the old key stops working.
  await q(
    `update linkedin_agent_device set revoked_at = now(), token_hash = null
      where user_id = $1 and id <> $2 and name = $3 and revoked_at is null`,
    [d.user_id, d.id, d.name],
  );
  const u = await q("select email from users where id = $1", [d.user_id]);
  await addEvents(d.user_id, [{ level: "success", text: `PC "${d.name}" connected.` }]);
  return { token, deviceId: d.id, name: d.name, email: (u.rows[0] || {}).email || "" };
}

// The device behind a worker's token, with its user — or null. Used by the worker-only routes.
async function deviceForToken(token) {
  const t = String(token || "");
  if (!dbOn || !t.startsWith("kca_") || t.length < 40) return null;
  const { rows } = await q(
    // Device columns are aliased: u.* has an `id` too, and it would win over d.id.
    `select u.*, d.id as device_id, d.name as device_name, d.user_id, d.last_used_at as device_used_at
       from linkedin_agent_device d join users u on u.id = d.user_id
      where d.token_hash = $1 and d.revoked_at is null and d.paired_at is not null`,
    [sha(t)],
  );
  const r = rows[0];
  if (!r) return null;
  if (!r.device_used_at || Date.now() - new Date(r.device_used_at).getTime() > 60000) {
    q("update linkedin_agent_device set last_used_at = now() where id = $1", [r.device_id]).catch(() => {});
  }
  const { device_id: deviceId, device_name: name, device_used_at, ...user } = r; // eslint-disable-line no-unused-vars
  return { device: { id: deviceId, name }, user: { ...user, id: r.user_id } };
}

async function listDevices(userId) {
  if (!dbOn) return [];
  const { rows } = await q(
    `select id, name, paired_at, last_used_at, worker from linkedin_agent_device
      where user_id = $1 and paired_at is not null and revoked_at is null order by paired_at desc`,
    [userId],
  );
  return rows;
}

async function revokeDevice(userId, id) {
  const { rows } = await q(
    "update linkedin_agent_device set revoked_at = now(), token_hash = null where id = $1 and user_id = $2 and revoked_at is null returning id, name",
    [id, userId],
  );
  if (rows[0]) {
    // Its accounts go to whichever PC checks in next.
    await q("update linkedin_account set device_id = null, updated_at = now() where user_id = $1 and device_id = $2", [userId, rows[0].id]);
    await addEvents(userId, [{ level: "warn", text: `PC "${rows[0].name || "PC"}" disconnected from Karma Connect.` }]);
  }
  return rows[0] || null;
}

// What the Send Queue strip and the LinkedIn agent page show: every account with its own state,
// counts and limits, plus the PCs. The top-level fields sum the accounts up.
async function status(userId, { tzOffset } = {}) {
  // the viewer's clock (the page sends its UTC offset in minutes), for today's invitation target
  const off = Number.isFinite(Number(tzOffset)) && tzOffset !== "" && tzOffset != null
    ? Math.max(-840, Math.min(840, Math.round(Number(tzOffset)))) : -new Date().getTimezoneOffset();
  const ln = new Date(Date.now() + off * 60000);
  const local = { localHour: ln.getUTCHours(), localDay: ln.getUTCDay(), localMinute: ln.getUTCMinutes() };
  const defaults = {};
  for (const k of [...Object.keys(BOUNDS), "weekdaysOnly"]) defaults[k] = LIMITS[k];
  if (!dbOn) return { accounts: [], devices: [], maxAccounts: MAX_ACCOUNTS, defaults, bounds: BOUNDS, enabled: false, needReply: 0, firstMessages: 0 };
  const accounts = await listAccounts(userId);
  const counts = await queueCounts(userId);
  const inbox = await q("select li_account_id as a, count(*) filter (where needs_reply) as n from linkedin_inbox where user_id = $1 group by li_account_id", [userId]);
  const fu = await q(
    `select x.a, count(*) as n from (select ${EFF_SQL("o")} as a from outreach_queue o
        where o.user_id = $1 and o.action = 'invite' and o.followup_state in ('needs_draft','drafted')) x group by x.a`, [userId]);
  const cp = await q("select li_account_id as a, count(*) as n from linkedin_copy where user_id = $1 and status = 'done' and done_at > now() - interval '24 hours' group by li_account_id", [userId]);
  const by = (res) => new Map(res.rows.map((r) => [String(r.a), Number(r.n || 0)]));
  const inboxBy = by(inbox), fuBy = by(fu), cpBy = by(cp);
  const handles = new Map();
  for (const a of accounts) {
    const h = a.worker && a.worker.linkedin && a.worker.linkedin.handle;
    if (h) handles.set(h.toLowerCase(), [...(handles.get(h.toLowerCase()) || []), a.label]);
  }
  const targets = new Map();
  for (const a of accounts) targets.set(String(a.id), await inviteTarget(userId, a, limitsFor(a), local).catch(() => null));
  const list = accounts.map((a) => {
    const c = counts.get(String(a.id)) || NO_COUNTS;
    const t = targets.get(String(a.id));
    const h = a.worker && a.worker.linkedin && a.worker.linkedin.handle;
    const twins = h ? (handles.get(h.toLowerCase()) || []).filter((l) => l !== a.label) : [];
    return {
      id: a.id, slot: a.slot, label: a.label, deviceId: a.device_id,
      enabled: !!a.enabled, haltedAt: a.halted_at, haltReason: a.halt_reason,
      lastSeenAt: a.last_seen_at, lastSentAt: a.last_sent_at, dryRun: !!a.dry_run,
      worker: a.worker || null, pendingCommand: a.command || null,
      settings: cleanSettings(a.settings), limits: limitsFor(a),
      counts: { day: c.day, hour: c.hour, invDay: c.invDay, invWeek: c.invWeek, copies: cpBy.get(String(a.id)) || 0 },
      // today's invitation target and this week's (Monday–Sunday) progress
      invites: t ? { target: t.target, today: t.today, week: t.week, weekCap: t.weekCap } : null,
      ready: c.ready, waiting: c.waiting, inflight: c.inflight,
      needReply: inboxBy.get(String(a.id)) || 0, firstMessages: fuBy.get(String(a.id)) || 0,
      sameLinkedInAs: twins[0] || null,
      ...prospecting.statusFields(a),
    };
  });
  const sum = (k) => list.reduce((n, a) => n + (a[k] || 0), 0);
  return {
    accounts: list,
    maxAccounts: MAX_ACCOUNTS,
    devices: await listDevices(userId),
    defaults,
    bounds: BOUNDS,
    enabled: list.some((a) => a.enabled),
    ready: sum("ready"), waiting: sum("waiting"), inflight: sum("inflight"),
    needReply: sum("needReply") + (inboxBy.get("null") || 0), firstMessages: sum("firstMessages"),
  };
}

module.exports = {
  ensureAgentSchema, getState, setEnabled, halt, status,
  listAccounts, accountFor, createAccount, updateAccount, removeAccount, setQueueAccount, MAX_ACCOUNTS, EFF_SQL,
  lease, report, reclaimStale, sentCounts, inviteTarget, decide, inWindow, LIMITS,
  watch, markAccepted, recordInbox, listInbox, setHandled, saveDraft, queueReply, sendWithoutWaiting,
  recordProfile, listFollowups, saveFollowupDraft, queueFollowup, skipFollowup, needProfile,
  requestCopy, getCopy, leaseCopies, finishCopy,
  saveSettings, setCommand, heartbeat, addEvents, listEvents, COMMANDS,
  createPairCode, claimPairCode, deviceForToken, listDevices, revokeDevice,
  cleanSettings, limitsFor, BOUNDS,
  handleOf, nameKey, WAITING_SQL, ACTIONS, NOTE_MAX,
};
