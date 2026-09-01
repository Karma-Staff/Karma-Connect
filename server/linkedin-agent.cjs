// LinkedIn agent: the server half. Hands approved LinkedIn queue items out to the local
// worker (agent/), enforces the sending caps, and records what came back.
//
// Why the server owns the limits: the worker is a local process the user can restart, close
// or run twice. Counters kept in the worker would reset with it, so every cap is checked and
// counted here, against the DB, per user. The worker's pacing is cosmetic on top of this.
//
// Flow:
//   1. Worker calls lease(): we pick approved LinkedIn items that are due and under every cap,
//      flip them to 'sending', and stamp a lease that expires. Claim is atomic (SKIP LOCKED)
//      so two workers can never take the same row.
//   2. Worker sends on LinkedIn, then calls report() with 'sent' | 'failed' | 'halted'.
//   3. Anything whose lease expires without a report is swept back to 'approved' by
//      reclaimStale() so a crashed worker never strands a message.
//
// Nothing here talks to LinkedIn — it only decides what the worker is allowed to do next.
// Requires db.cjs, which reads env at load: require this AFTER the .env loader has run.
const { dbOn, q, logActivity } = require("./db.cjs");

// ── Caps ────────────────────────────────────────────────────────────
// Conservative on purpose. These protect the user's account, not our throughput; raising them
// raises their ban risk, so they're env-tunable but default low.
const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
const LIMITS = {
  perDay:      num(process.env.LI_AGENT_PER_DAY, 25),      // sends per user per rolling 24h
  perHour:     num(process.env.LI_AGENT_PER_HOUR, 8),      // sends per user per rolling hour
  minGapSec:   num(process.env.LI_AGENT_MIN_GAP_SEC, 45),  // floor between two sends
  maxGapSec:   num(process.env.LI_AGENT_MAX_GAP_SEC, 180), // worker jitters up to here
  leaseMin:    num(process.env.LI_AGENT_LEASE_MIN, 10),    // a claimed item must report back within this
  batch:       num(process.env.LI_AGENT_BATCH, 3),         // max items handed out per lease call
  windowStart: num(process.env.LI_AGENT_WINDOW_START, 9),  // local hour, inclusive
  windowEnd:   num(process.env.LI_AGENT_WINDOW_END, 17),   // local hour, exclusive
  weekdaysOnly: String(process.env.LI_AGENT_WEEKDAYS_ONLY || "true") !== "false",
};

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
// source of truth — no separate counter to drift).
async function sentCounts(userId) {
  const { rows } = await q(
    `select
       count(*) filter (where sent_at > now() - interval '24 hours') as day,
       count(*) filter (where sent_at > now() - interval '1 hour')   as hour,
       max(sent_at) as last_sent
     from outreach_queue
     where user_id = $1 and channel = 'linkedin' and status = 'sent'`,
    [userId],
  );
  const r = rows[0] || {};
  return { day: Number(r.day || 0), hour: Number(r.hour || 0), lastSent: r.last_sent || null };
}

// Is `now` inside the allowed sending window? The worker passes its own local hour/day, because
// the server may well be in a different timezone than the recruiter.
function inWindow(localHour, localDay) {
  if (LIMITS.weekdaysOnly && (localDay === 0 || localDay === 6)) return false;
  return localHour >= LIMITS.windowStart && localHour < LIMITS.windowEnd;
}

// The single "may I send right now, and how many" decision. Pure apart from the counts it's
// handed, so it unit-tests without a database.
function decide({ state, counts, localHour, localDay, now = Date.now() }) {
  if (!state || !state.enabled) return { ok: false, reason: state && state.halt_reason ? state.halt_reason : "The agent is off.", allowed: 0 };
  if (!inWindow(localHour, localDay)) {
    return { ok: false, reason: `Outside the sending window (${LIMITS.windowStart}:00–${LIMITS.windowEnd}:00${LIMITS.weekdaysOnly ? ", weekdays" : ""}).`, allowed: 0 };
  }
  if (counts.day >= LIMITS.perDay) return { ok: false, reason: `Daily cap reached (${LIMITS.perDay}).`, allowed: 0 };
  if (counts.hour >= LIMITS.perHour) return { ok: false, reason: `Hourly cap reached (${LIMITS.perHour}).`, allowed: 0 };
  if (counts.lastSent) {
    const gap = (now - new Date(counts.lastSent).getTime()) / 1000;
    if (gap < LIMITS.minGapSec) return { ok: false, reason: `Too soon — ${Math.ceil(LIMITS.minGapSec - gap)}s to go.`, allowed: 0, retryInSec: Math.ceil(LIMITS.minGapSec - gap) };
  }
  const allowed = Math.max(0, Math.min(LIMITS.batch, LIMITS.perDay - counts.day, LIMITS.perHour - counts.hour));
  return { ok: allowed > 0, reason: allowed > 0 ? "" : "No headroom left under the caps.", allowed };
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
  const { rows } = await q(
    `update outreach_queue set status = 'sending', lease_id = $2, leased_at = now(), lease_expires_at = $3,
       attempts = attempts + 1, updated_at = now()
       where id in (
         select id from outreach_queue
           where user_id = $1 and channel = 'linkedin' and status = 'approved'
             and (scheduled_at is null or scheduled_at <= now())
           order by scheduled_at nulls first
           limit ${Number(verdict.allowed)} for update skip locked)
       returning id, prospect_id, lead_label, body, linkedin_url, step`,
    [userId, String(leaseId || "").slice(0, 64) || null, expires],
  );
  await q("update linkedin_agent set last_seen_at = now(), updated_at = now() where user_id = $1", [userId]);
  return {
    items: rows,
    wait: rows.length ? LIMITS.minGapSec : 300,
    reason: rows.length ? "" : "Nothing approved and due in the queue.",
    limits: LIMITS,
    counts,
  };
}

// The worker reports back on one leased item.
//   result 'sent'    → the message went out; record it and stamp the scrape.
//   result 'failed'  → this one didn't work (missing Message button, thread wouldn't open…).
//                      It goes back to 'approved' to retry, or 'failed' after 3 attempts.
//   result 'halted'  → LinkedIn pushed back (checkpoint, captcha, limit notice). Release the
//                      item AND stop the whole agent for this user — a human looks at it next.
async function report(userId, id, { result, error, leaseId, scrape } = {}) {
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

  if (result === "sent") {
    const { rows } = await q(
      `update outreach_queue set status = 'sent', sent_at = now(), lease_id = null, leased_at = null,
         lease_expires_at = null, error = null, ${keepScrapeFrom(3)}, updated_at = now()
       where id = $1 and user_id = $2 returning *`,
      [id, userId, ...scrapeArgs],
    );
    await q("update linkedin_agent set last_sent_at = now(), last_seen_at = now(), updated_at = now() where user_id = $1", [userId]);
    logActivity(userId, "outreach_sent", { prospectId: row.prospect_id, label: row.lead_label, detail: "linkedin_agent" });
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
  const dead = (row.attempts || 0) >= 3;
  const { rows } = await q(
    `update outreach_queue set status = $3, error = $4, lease_id = null, leased_at = null,
       lease_expires_at = null, ${keepScrapeFrom(5)}, updated_at = now()
     where id = $1 and user_id = $2 returning *`,
    [id, userId, dead ? "failed" : "approved", String(error || "Send failed.").slice(0, 300), ...scrapeArgs],
  );
  return rows[0];
}

// What the Send Queue UI shows in its agent strip.
async function status(userId) {
  if (!dbOn) return { enabled: false, limits: LIMITS, counts: { day: 0, hour: 0 }, queued: 0 };
  const state = await getState(userId);
  const counts = await sentCounts(userId);
  const { rows } = await q(
    `select count(*) filter (where status = 'approved') as ready,
            count(*) filter (where status = 'sending')  as inflight
       from outreach_queue where user_id = $1 and channel = 'linkedin'`,
    [userId],
  );
  return {
    enabled: !!state.enabled,
    haltedAt: state.halted_at,
    haltReason: state.halt_reason,
    lastSeenAt: state.last_seen_at,
    lastSentAt: state.last_sent_at,
    limits: LIMITS,
    counts: { day: counts.day, hour: counts.hour },
    ready: Number((rows[0] || {}).ready || 0),
    inflight: Number((rows[0] || {}).inflight || 0),
  };
}

module.exports = {
  ensureAgentSchema, getState, setEnabled, halt, status,
  lease, report, reclaimStale, sentCounts, decide, inWindow, LIMITS,
};
