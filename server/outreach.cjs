// Outreach queue + the "agent tick" that auto-sends approved EMAIL messages.
//
// Flow (matches the product decision — approve each send):
//   1. The app generates a message and the user approves it → enqueue() stores a row
//      (status 'pending' until approved, or straight to 'approved' when the user approves it).
//   2. EMAIL items with status 'approved' whose scheduled_at is due are claimed and sent by
//      the tick (runTick) — fully automatic, the agentic part. They become 'sent' or 'failed'.
//   3. LINKEDIN items are never auto-sent (no legitimate API; auto-driving an account violates
//      LinkedIn's ToS and risks bans). They wait in the queue for the human one-click hand-off,
//      which calls markSent() after the person sends it themselves.
//
// Data logic lives here so server.js stays a thin routing layer. Requires db.cjs/email.cjs,
// which read env at load — this module must be required AFTER the .env loader has run.
const { dbOn, q, logActivity } = require("./db.cjs");
const { sendOutreachEmail } = require("./email.cjs");
const { WAITING_SQL } = require("./linkedin-agent.cjs");

const CHANNELS = ["email", "linkedin"];
const TICK_MS = Math.max(10000, parseInt(process.env.OUTREACH_TICK_MS || "30000", 10)); // default 30s
const BATCH = 10; // max email sends claimed per tick

async function ensureOutreachSchema() {
  if (!dbOn) return;
  try {
    await q(`create table if not exists outreach_queue (
      id           uuid primary key default gen_random_uuid(),
      user_id      uuid not null references users (id) on delete cascade,
      prospect_id  text not null,
      lead_label   text,
      channel      text not null default 'email',
      step         text,
      subject      text,
      body         text not null,
      to_email     text,
      from_email   text,
      from_name    text,
      status       text not null default 'pending',
      scheduled_at timestamptz,
      approved_by  text,
      approved_at  timestamptz,
      sent_at      timestamptz,
      provider_id  text,
      error        text,
      created_at   timestamptz not null default now(),
      updated_at   timestamptz not null default now())`);
    await q("alter table outreach_queue add column if not exists linkedin_url text"); // prospect profile URL for the LinkedIn one-click hand-off
    await q("create index if not exists outreach_user_idx on outreach_queue (user_id, created_at desc)");
    await q("create index if not exists outreach_due_idx on outreach_queue (channel, status, scheduled_at)");
  } catch (e) { console.error("ensureOutreachSchema:", e.message); }
}

const clean = (s, n = 4000) => (s == null ? null : String(s).slice(0, n));

// Insert a queue item. `approved` true → goes straight to approved/scheduled (the common case:
// the user reviewed and approved the message). Otherwise it parks as 'pending'.
async function enqueue(userId, item = {}) {
  const channel = CHANNELS.includes(item.channel) ? item.channel : "email";
  const body = clean(item.body);
  if (!body) throw new Error("A message body is required.");
  if (!item.prospectId) throw new Error("A prospectId is required.");
  // Email items can be queued without a recipient yet — they park as 'pending' until the
  // recipient is filled in and the item is approved in the queue. LinkedIn items never need one.
  const needsEmail = channel === "email" && !item.toEmail;
  const approved = item.approved !== false && !needsEmail; // default: enqueue already-approved
  const status = approved ? "approved" : "pending";
  const scheduledAt = approved ? (item.scheduledAt ? new Date(item.scheduledAt) : new Date()) : null;
  // LinkedIn: a connection note is an INVITATION (the agent sends it through Connect, not the
  // message box). Anything else is a message — and a message to someone whose invitation is
  // still out waits until they accept, because LinkedIn won't let you message them before.
  const action = channel === "linkedin" && (item.action === "invite" || item.step === "connection") ? "invite" : "message";
  if (action === "invite" && body.length > 300) throw new Error("A connection note must be 300 characters or fewer.");
  const prospectId = String(item.prospectId);
  let waitAccept = false;
  if (channel === "linkedin" && action === "message") {
    const { rows: inv } = await q(
      `select 1 from outreach_queue where user_id = $1 and prospect_id = $2 and channel = 'linkedin' and action = 'invite'
         and accepted_at is null and status in ('pending','approved','sending','sent') limit 1`, [userId, prospectId]);
    waitAccept = inv.length > 0;
  }
  const { rows } = await q(
    `insert into outreach_queue
       (user_id, prospect_id, lead_label, channel, step, subject, body, to_email, from_email, from_name,
        linkedin_url, status, scheduled_at, approved_by, approved_at, action, wait_accept)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     returning *`,
    [userId, prospectId, clean(item.leadLabel, 200), channel, clean(item.step, 60),
     clean(item.subject, 300), body, clean(item.toEmail, 200), clean(item.fromEmail, 200), clean(item.fromName, 120),
     clean(item.linkedinUrl, 400), status, scheduledAt, approved ? (item.approvedBy || null) : null, approved ? new Date() : null,
     action, waitAccept],
  );
  // An invitation queued AFTER messages to the same person: those messages now wait for it.
  if (action === "invite") {
    await q(`update outreach_queue set wait_accept = true, updated_at = now()
              where user_id = $1 and prospect_id = $2 and channel = 'linkedin' and action = 'message'
                and status in ('pending','approved','failed')`, [userId, prospectId]);
  }
  logActivity(userId, "outreach_queued", { prospectId, label: item.leadLabel, detail: action === "invite" ? "linkedin_invite" : channel });
  return rows[0];
}

async function listQueue(userId, { status = "", channel = "" } = {}) {
  const params = [userId];
  let where = "o.user_id = $1";
  if (status) { params.push(status); where += ` and o.status = ${params.length}`; }
  if (channel) { params.push(channel); where += ` and o.channel = ${params.length}`; }
  // waiting: a LinkedIn message held until the invitation to the same person is accepted.
  const { rows } = await q(
    `select o.*, ${WAITING_SQL("o")} as waiting from outreach_queue o where ${where} order by
       case status when 'approved' then 0 when 'pending' then 1 when 'sent' then 2 else 3 end,
       coalesce(scheduled_at, created_at) desc limit 300`,
    params,
  );
  return rows;
}

// Approve a pending item (schedule it for sending). Email items get auto-sent by the tick.
// Accepts an updated recipient/subject for email items (filled in the queue UI before approving).
async function approveItem(userId, id, { scheduledAt, approvedBy, toEmail, subject } = {}) {
  const cur = await q("select * from outreach_queue where id=$1 and user_id=$2", [id, userId]);
  const row = cur.rows[0];
  if (!row) return null;
  const finalTo = clean((toEmail != null ? toEmail : row.to_email) || "", 200) || "";
  if (row.channel === "email") {
    if (!finalTo.trim()) { const e = new Error("Add a recipient email before approving."); e.code = "NO_RECIPIENT"; throw e; }
    if (!row.from_email) { const e = new Error("This email has no sender — re-queue it from a generated message so it carries the sender identity."); e.code = "NO_SENDER"; throw e; }
  }
  const finalSubject = subject != null ? clean(subject, 300) : row.subject;
  const when = scheduledAt ? new Date(scheduledAt) : new Date();
  const { rows } = await q(
    `update outreach_queue set status='approved', to_email=$3, subject=$4, scheduled_at=$5, approved_by=$6, approved_at=now(), updated_at=now(), error=null
       where id=$1 and user_id=$2 and status in ('pending','failed') returning *`,
    [id, userId, finalTo || null, finalSubject, when, approvedBy || null],
  );
  return rows[0] || null;
}

async function skipItem(userId, id) {
  const { rows } = await q(
    "update outreach_queue set status='skipped', updated_at=now() where id=$1 and user_id=$2 and status in ('pending','approved','failed') returning id",
    [id, userId],
  );
  return rows[0] || null;
}

// Mark a LINKEDIN item sent after the human one-click hand-off (they sent it themselves).
async function markSent(userId, id) {
  const { rows } = await q(
    "update outreach_queue set status='sent', sent_at=now(), updated_at=now() where id=$1 and user_id=$2 returning *",
    [id, userId],
  );
  if (rows[0]) logActivity(userId, "outreach_sent", { prospectId: rows[0].prospect_id, label: rows[0].lead_label, detail: rows[0].channel });
  return rows[0] || null;
}

// Send one already-loaded EMAIL row now (used by the tick and by send-now). Atomic-claim the row
// first (status→sending) so two ticks can't double-send. Returns the updated row.
async function sendEmailRow(row) {
  try {
    const id = await sendOutreachEmail({
      fromName: row.from_name, fromEmail: row.from_email, to: row.to_email,
      subject: row.subject || "Quick note", text: row.body,
    });
    const { rows } = await q(
      "update outreach_queue set status='sent', sent_at=now(), provider_id=$2, updated_at=now() where id=$1 returning *",
      [row.id, id],
    );
    logActivity(row.user_id, "outreach_sent", { prospectId: row.prospect_id, label: row.lead_label, detail: "email" });
    return rows[0];
  } catch (e) {
    const { rows } = await q(
      "update outreach_queue set status='failed', error=$2, updated_at=now() where id=$1 returning *",
      [row.id, String(e.message || e).slice(0, 300)],
    );
    return rows[0];
  }
}

// Send-now for a single email item the user owns (claims it, then sends).
async function sendNow(userId, id) {
  const { rows } = await q(
    `update outreach_queue set status='sending', updated_at=now()
       where id=$1 and user_id=$2 and channel='email' and status in ('approved','failed') returning *`,
    [id, userId],
  );
  if (!rows[0]) return null;
  return sendEmailRow(rows[0]);
}

// The agent tick: claim due approved EMAIL items and send them. Claim is atomic
// (status→sending with FOR UPDATE SKIP LOCKED) so overlapping ticks never double-send.
async function runTick() {
  if (!dbOn) return { sent: 0 };
  let claimed;
  try {
    const res = await q(
      `update outreach_queue set status='sending', updated_at=now()
         where id in (
           select id from outreach_queue
             where channel='email' and status='approved'
               and (scheduled_at is null or scheduled_at <= now())
             order by scheduled_at nulls first
             limit ${BATCH} for update skip locked)
         returning *`,
    );
    claimed = res.rows;
  } catch (e) { console.error("outreach runTick claim:", e.message); return { sent: 0 }; }
  let sent = 0;
  for (const row of claimed) {
    const out = await sendEmailRow(row);
    if (out && out.status === "sent") sent++;
  }
  return { sent, claimed: claimed.length };
}

let timer = null;
function startTick() {
  if (timer || !dbOn) return;
  timer = setInterval(() => { runTick().catch((e) => console.error("outreach tick:", e.message)); }, TICK_MS);
  timer.unref(); // never keep the process alive just for the tick
  console.log(`Outreach tick on (every ${Math.round(TICK_MS / 1000)}s).`);
}
function stopTick() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { ensureOutreachSchema, enqueue, listQueue, approveItem, skipItem, markSent, sendNow, runTick, startTick, stopTick, CHANNELS };
