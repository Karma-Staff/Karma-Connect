// Researching new LinkedIn connections by itself. When an invitation is accepted the agent copies
// the person's profile (linkedin-agent.cjs, followup_state 'needs_draft'). Until now the research
// only started when someone opened the Send Queue. This does it on the server, unattended: parse
// the profile, analyse them, draft the first message, and save the analysed lead — so opening
// Karma Connect shows them ready, and the only thing left is to approve (or edit) the message.
//
// The steps are src/lib/prep.js, bundled for Node as server/gen/prep.cjs by `npm run build`.
// The AI calls go through the same /api/claude handler as the browser's, as the user whose
// connection it is, so their usage limits and the usage report apply exactly as before.
// Nothing here sends anything: the draft waits for a person's approval.
const { dbOn, q, logActivity } = require("./db.cjs");

const EVERY_MS = Math.max(30000, parseInt(process.env.LI_PREP_MS || "120000", 10)); // default 2 min
const PER_ROUND = 3;   // connections researched per round (each is three AI calls)
const MAX_TRIES = 3;   // then it's left for the Send Queue's Draft button

let pipeline = null;
function loadPipeline() {
  if (pipeline !== null) return pipeline;
  try { pipeline = require("./gen/prep.cjs"); }
  catch (e) {
    console.warn("[li-prep] server/gen/prep.cjs missing (run npm run build) — new connections are drafted in the Send Queue instead");
    pipeline = false;
  }
  return pipeline;
}

// The proxy handler answers { status, headers, body }; prep.js expects a fetch Response.
function installClaude(handleClaude, recordUsage, who) {
  globalThis.__kcClaude = async (body) => {
    const out = await handleClaude(
      { method: "POST", bodyString: JSON.stringify(body), identity: { userId: who.userId, email: who.email } },
      { requireAuth: true, recordUsage },
    );
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => JSON.parse(out.body || "{}") };
  };
}

async function ensurePrepSchema() {
  if (!dbOn) return;
  await q("alter table outreach_queue add column if not exists prep_tries int not null default 0");
  await q("alter table outreach_queue add column if not exists prep_error text");
  await q("alter table outreach_queue add column if not exists prep_at timestamptz");   // when the server researched them
}

async function prepareOne(row, { handleClaude, recordUsage }) {
  const p = loadPipeline();
  if (!p) return false;
  const { rows: pb } = await q("select playbook from coach_playbook where user_id = $1 and kind = 'relationship'", [row.user_id]).catch(() => ({ rows: [] }));
  installClaude(handleClaude, recordUsage, { userId: row.user_id, email: row.email });
  try {
    // who the AI writes as: the lead's own sender, else the one picked for this LinkedIn account
    const fallbackSender = (p.SENDERS || []).find((x) => x.id === row.acct_sender) || null;
    const r = await p.runFollowupPipeline(row, { fallbackSender, playbook: (pb[0] && pb[0].playbook) || "" });
    // the analysed lead, as the browser's writeHistory would save it
    if (r.entry && r.entry.id) {
      await q(
        `update prospects set label = $3, sub = $4, data = $5 where id = $1 and user_id = $2`,
        [String(r.entry.id), row.user_id, r.entry.label || "", r.entry.sub || "", r.entry.snapshot || {}]);
    }
    const { rowCount } = await q(
      `update outreach_queue set followup_draft = $3, followup_state = 'drafted', prep_error = null, prep_at = now(), updated_at = now()
        where id = $1 and user_id = $2 and followup_state = 'needs_draft' and followup_draft is null`,
      [row.id, row.user_id, String(r.message || "").slice(0, 4000)]);
    if (rowCount) logActivity(row.user_id, "li_connection_researched", { prospectId: row.prospect_id, label: row.lead_label });
    return true;
  } finally {
    delete globalThis.__kcClaude;
  }
}

async function round(deps) {
  if (!dbOn || !loadPipeline()) return;
  const { rows } = await q(
    `select o.id, o.user_id, u.email, o.prospect_id, o.lead_label, o.linkedin_url, o.profile_text,
            (select x.sender_id from linkedin_account x where x.id = o.li_account_id) as acct_sender,
            p.label as p_label, p.sub as p_sub, p.status as p_status, p.data as p_data
       from outreach_queue o
       join users u on u.id = o.user_id
       left join prospects p on p.id = o.prospect_id and p.user_id = o.user_id
      where o.action = 'invite' and o.followup_state = 'needs_draft' and o.followup_draft is null
        and o.profile_text is not null and o.prep_tries < ${MAX_TRIES}
      order by o.accepted_at nulls last limit ${PER_ROUND}`);
  for (const row of rows) {
    await q("update outreach_queue set prep_tries = prep_tries + 1 where id = $1", [row.id]);
    try { await prepareOne(row, deps); }
    catch (e) {
      await q("update outreach_queue set prep_error = $2 where id = $1", [row.id, String((e && e.message) || e).slice(0, 300)]).catch(() => {});
      console.warn("[li-prep]", row.lead_label || row.id, "→", (e && e.message) || e);
    }
  }
}

let timer = null, busy = false;
function startPrep(deps) {
  if (timer || !dbOn || process.env.LI_PREP === "0") return;
  ensurePrepSchema().catch((e) => console.error("ensurePrepSchema:", e.message));
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await round(deps); } catch (e) { console.warn("[li-prep] round:", e.message); }
    busy = false;
  }, EVERY_MS);
  if (timer.unref) timer.unref();
}

module.exports = { startPrep, round, prepareOne, ensurePrepSchema };
