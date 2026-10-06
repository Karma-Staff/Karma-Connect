"use strict";
/* Caller reputation: what is known about each outbound number (migration 018).
 *
 * Two questions, answered separately and never blended:
 *
 *   "Is this number flagged?"  Only a carrier or caller-ID analytics provider
 *     knows. RingCentral's API exposes no spam or reputation data at all, so
 *     without an authorised provider the answer is UNKNOWN — said plainly,
 *     never "not flagged".
 *   "How risky does our calling look?"  The Karma Connect Risk Score
 *     (reputation-engine.js), from the call log. Ours, labelled as ours.
 *
 * PROVIDERS — each writes its own rows (provider column):
 *   ringcentral      the number itself: in service, caller ID name, owner.
 *                    Verified facts, but no spam status (none exists).
 *   carrier          Hiya's Number Reputation API (AT&T's labeller), when
 *                    HIYA_APP_ID / HIYA_APP_SECRET / HIYA_API_BASE are set.
 *                    A paid service; numbers must be registered with Hiya
 *                    first. Unset = "not connected", and nothing is claimed.
 *   caller_identity  no provider is available to us; listed so the screen can
 *                    say so rather than leave a gap.
 *   internal         the Karma Connect Risk Score.
 *
 * WHICH RINGCENTRAL LOGIN. The company call log needs a RingCentral admin.
 * A check runs with the person who pressed "Check now", else with any
 * connected admin; a login that is refused is skipped for the next.
 *
 * RATE LIMITS. The call log is RingCentral's heavy group (ten a minute for
 * the whole app). Fourteen days is one or two requests, cached ten minutes;
 * "Check now" is refused more often than every two minutes.
 */

const express = require("express");
const { query } = require("./db");
const { requireAdmin } = require("./auth");
const rc = require("./ringcentral");
const dash = require("./rc-dashboard");
const settings = require("./settings");
const engine = require("./reputation-engine");

const router = express.Router();

const KEY = "reputation.alerts";
const DEFAULTS = { alertAt: 60, email: true };
const INTERNAL_TTL_H = 6;
const PROVIDER_TTL_H = 24;
const KEEP_DAYS = 180;
const MIN_GAP_MS = 2 * 60e3;
const APP_URL = String(process.env.APP_URL || "").replace(/\/+$/, "");

const HIYA = {
  id: String(process.env.HIYA_APP_ID || "").trim(),
  secret: String(process.env.HIYA_APP_SECRET || "").trim(),
  base: String(process.env.HIYA_API_BASE || "").trim().replace(/\/+$/, ""),
};
const HIYA_ON = !!(HIYA.id && HIYA.secret && /^https:\/\//.test(HIYA.base));

/* Where a wrong label is disputed. None of the providers has an API for it. */
const REVIEW_LINKS = {
  carrier: { name: "Hiya", url: "https://hiyahelp.zendesk.com/hc/en-us/requests/new?ticket_form_id=32894877171859" },
};
const REGISTRY = "https://www.freecallerregistry.com/";

const config = async () => ({ ...DEFAULTS, ...(await settings.get(KEY, {})) });

let mail = null;
try { mail = require("../../server/email.cjs"); } catch (e) { /* alerts stay on screen only */ }

/* ---------------- RingCentral: numbers and the call log ---------------- */

const numbersFor = (uid) => dash.cached("rep:numbers", 10 * 60e3, async () => {
  const d = await dash.rcGet(uid, "/restapi/v1.0/account/~/phone-number", { perPage: 1000 });
  return (d.records || []).filter((n) => n.phoneNumber).map((n) => ({
    number: n.phoneNumber, rcId: n.id ? String(n.id) : null, usage: n.usageType || "",
    status: n.status || "", label: n.label || "", callerIdName: n.callerIdName || "",
    ext: n.extension?.extensionNumber || "", extId: n.extension?.id ? String(n.extension.id) : null,
  }));
});

async function callLog(uid, fresh) {
  const key = "rep:log14";
  const load = async () => {
    const out = [];
    const from = new Date(Date.now() - 14 * 864e5).toISOString();
    for (let page = 1; page <= 10; page++) {
      const d = await dash.rcGet(uid, "/restapi/v1.0/account/~/call-log",
        { dateFrom: from, view: "Simple", type: "Voice", perPage: 1000, page });
      for (const r of d.records || []) out.push({
        t: Date.parse(r.startTime), dur: +r.duration || 0, dir: r.direction, res: r.result || "Unknown",
        fromNum: r.from?.phoneNumber || "", toNum: r.to?.phoneNumber || "" });
      if (!d.navigation?.nextPage || (d.records || []).length < 1000) break;
    }
    return out;
  };
  return fresh ? load() : dash.cached(key, 10 * 60e3, load);
}

/* The logins to try, best first: whoever asked, then admins by recent use. */
async function candidates(preferId) {
  const rows = (await query(
    `SELECT v.user_id FROM voice_identities v
       JOIN app_users u ON u.id = v.user_id
       LEFT JOIN organization_memberships m ON m.user_id = u.id
      WHERE v.provider = 'ringcentral' AND NOT u.disabled
      ORDER BY (v.user_id = $1) DESC, (m.role IN ('owner','admin')) DESC,
               v.last_used_at DESC NULLS LAST`, [preferId || 0])).rows;
  return rows.map((r) => r.user_id);
}

/* ---------------- the carrier provider (Hiya) ----------------
   Hiya documents GET /reputation?phones=<E.164>… (max 100) with HTTP Basic
   auth, answering one of flagged / mixed_high / mixed_low / unflagged per
   number. Its exact response field names are not public, so the answer is
   read defensively: the number must be found next to a recognisable status,
   or the result is "unknown" with the reason kept — never a guess. */
async function hiyaCheck(numbers) {
  if (!HIYA_ON) return null;
  const out = new Map();
  for (let i = 0; i < numbers.length; i += 100) {
    const batch = numbers.slice(i, i + 100);
    const url = HIYA.base + "/reputation?" + batch.map((n) => "phones=" + encodeURIComponent(n)).join("&");
    let body, err = null;
    try {
      const r = await fetch(url, { headers: {
        Authorization: "Basic " + Buffer.from(`${HIYA.id}:${HIYA.secret}`).toString("base64"),
        Accept: "application/json" } });
      body = await r.json().catch(() => null);
      if (!r.ok) err = `Hiya ${r.status}${body?.message ? ": " + body.message : ""}`;
    } catch (e) { err = "Hiya unreachable: " + e.message; }
    for (const n of batch) {
      if (err) { out.set(n, { status: "unknown", error: err }); continue; }
      const hit = findStatus(body, n);
      out.set(n, hit ? { status: engine.readProviderStatus(hit.status), raw: hit.raw }
        : { status: "unknown", error: "Hiya's answer did not include a recognisable status for this number" });
    }
  }
  return out;
}
function findStatus(body, number) {
  const want = engine.digits10(number);
  let found = null;
  const walk = (o) => {
    if (found || !o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    const phone = Object.values(o).find((v) => typeof v === "string" && engine.digits10(v) === want);
    if (phone) {
      const st = ["status", "spamStatus", "spam_status", "labelStatus", "label_status", "reputation", "reputationStatus"]
        .map((k) => o[k]).find((v) => typeof v === "string" && engine.readProviderStatus(v) !== "unknown");
      if (st) { found = { status: st, raw: o }; return; }
    }
    Object.values(o).forEach(walk);
  };
  walk(body);
  return found;
}

/* ---------------- running a check ---------------- */

let running = null, lastRun = 0;

async function runChecks({ userId = null, by = "system", fresh = false } = {}) {
  if (running) return running;
  if (fresh && Date.now() - lastRun < MIN_GAP_MS) fresh = false;   // Check now, pressed twice
  running = (async () => {
    if (!rc.ENABLED) throw Object.assign(new Error("RingCentral is not configured on this server"), { status: 503 });
    let uid = null, numbers = null, calls = null, lastErr = null;
    for (const id of await candidates(userId)) {
      try {
        numbers = await numbersFor(id);
        calls = await callLog(id, fresh);
        uid = id;
        break;
      } catch (e) { lastErr = e; }
    }
    if (!uid) throw Object.assign(new Error(lastErr?.status === 403
      ? "No connected RingCentral login can read the company call log — a RingCentral admin needs to connect in Karma Connect."
      : "No RingCentral login could be used: " + (lastErr?.message || "nobody has connected one")), { status: 409 });

    const voice = numbers.filter(engine.isVoiceNumber);
    const ours = (await query(
      `SELECT extract(epoch FROM at) * 1000 AS at, meta->>'number' AS number, meta->>'disposition' AS disposition
         FROM activity_log
        WHERE action = 'call' AND at > now() - interval '7 days'
          AND meta->>'provider' = 'ringcentral' AND meta ? 'disposition'`)).rows
      .map((r) => ({ at: +r.at, number: r.number, disposition: r.disposition }));
    const outbound = calls.filter((c) => c.dir === "Outbound" && c.t >= Date.now() - 7 * 864e5);
    const carrier = await hiyaCheck(voice.map((n) => n.number));
    const cfg = await config();
    const alerts = [];

    for (const n of voice) {
      const share = outbound.length ? outbound.filter((c) => engine.digits10(c.fromNum) === engine.digits10(n.number)).length / outbound.length : 0;
      const c = carrier?.get(n.number) || null;
      const verified = c && c.status !== "unknown" ? {
        carrier_reputation: { value: engine.VERIFIED[c.status].label, source: "Hiya" } } : null;
      const a = engine.assess({ number: n, calls, ours, share, verified });
      const prev = (await query(
        `SELECT risk_score, provider_status FROM number_reputation
          WHERE phone_number = $1 AND provider = 'internal' ORDER BY checked_at DESC LIMIT 1`, [n.number])).rows[0];
      const prevCarrier = carrier ? (await query(
        `SELECT provider_status FROM number_reputation
          WHERE phone_number = $1 AND provider = 'carrier' ORDER BY checked_at DESC LIMIT 1`, [n.number])).rows[0] : null;

      /* Alerts fire on a change, not on every check: crossing the threshold
         (or a provider newly flagging the number) warns; dropping back below
         it says the number is healthy again. */
      let alert = null;
      const over = a.score >= cfg.alertAt, wasOver = prev && prev.risk_score >= cfg.alertAt;
      if (c && c.status === "flagged" && prevCarrier?.provider_status !== "flagged")
        alert = { kind: "warning", source: "carrier", text: "Hiya reports this number as flagged as spam." };
      else if (over && !wasOver)
        alert = { kind: "warning", source: "internal", text: `Karma Connect Risk Score rose to ${a.score} (${a.bandLabel}).` };
      else if (!over && wasOver)
        alert = { kind: "healthy", source: "internal", text: `Karma Connect Risk Score is back to ${a.score} (${a.bandLabel}).` };
      if (alert) alerts.push({ number: n.number, ...alert, score: a.score, band: a.bandLabel,
        reasons: a.signals.filter((s) => s.points).map((s) => s.detail) });

      const ins = (provider, status, spam, score, conf, evidence, ttlH, error = null) => query(
        `INSERT INTO number_reputation (phone_number, rc_number_id, provider, provider_status, spam_flag,
           risk_score, confidence, evidence, expires_at, error, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(hours => $9), $10, $11)`,
        [n.number, n.rcId, provider, status, spam, score, conf, JSON.stringify(evidence), ttlH, error, by]);

      /* RingCentral: verified facts about the number — and, because its API
         has no such thing, no spam status. */
      await ins("ringcentral", "unknown", null, null, null,
        { usage: n.usage, status: n.status, callerIdName: n.callerIdName, label: n.label, ext: n.ext,
          note: "RingCentral's API does not expose spam or reputation status." }, PROVIDER_TTL_H);
      if (c) await ins("carrier", c.status, engine.VERIFIED[c.status]?.spam ?? null, null, c.status === "unknown" ? null : 0.9,
        { provider: "Hiya", raw: c.raw || null }, PROVIDER_TTL_H, c.error || null);
      await ins("internal", a.band, null, a.score, a.confidence,
        { signals: a.signals, volume: a.volume, share: Math.round(share * 100) / 100, ...(alert ? { alert } : {}) },
        INTERNAL_TTL_H);
    }

    await query(`DELETE FROM number_reputation WHERE checked_at < now() - make_interval(days => $1)`, [KEEP_DAYS]);
    lastRun = Date.now();
    if (alerts.length && cfg.email) await sendAlerts(alerts).catch((e) => console.warn("[karma] reputation alerts:", e.message));
    return { checked: voice.length, alerts: alerts.length };
  })();
  try { return await running; } finally { running = null; }
}

async function sendAlerts(alerts) {
  if (!mail || !mail.emailVerifyOn || !mail.sendReputationAlertEmail) return;
  const to = await require("./call-digest").recipients();
  const link = APP_URL ? APP_URL + "/leads/?tab=reputation" : "";
  for (const p of to)
    await mail.sendReputationAlertEmail(p.email, { name: (p.display_name || "").split(" ")[0], alerts, link },
      `reputation-${alerts.map((a) => a.number + a.kind).join("-")}-${new Date().toISOString().slice(0, 13)}-${p.email}`)
      .catch((e) => console.warn("[karma] reputation alert to", p.email, e.message));
}

/* ---------------- reading it back ---------------- */

async function latest() {
  return (await query(
    `SELECT DISTINCT ON (phone_number, provider) *
       FROM number_reputation ORDER BY phone_number, provider, checked_at DESC`)).rows;
}

function summarise(rows) {
  const by = new Map();
  for (const r of rows) {
    const o = by.get(r.phone_number) || by.set(r.phone_number, { number: r.phone_number }).get(r.phone_number);
    o[r.provider] = r;
  }
  return [...by.values()].map((o) => {
    const i = o.internal, c = o.carrier, g = o.ringcentral;
    const verified = c && c.provider_status !== "unknown";
    return {
      number: o.number,
      label: g?.evidence?.label || "", usage: g?.evidence?.usage || "", ext: g?.evidence?.ext || "",
      callerIdName: g?.evidence?.callerIdName || "",
      reputation: {
        status: verified ? c.provider_status : "unknown",
        verified,
        spamFlag: verified ? c.spam_flag : null,
        source: verified ? "Hiya" : null,
        checkedAt: c?.checked_at || null,
        error: c?.error || null,
      },
      risk: i ? { score: i.risk_score, band: i.provider_status, label: engine.bandOf(i.risk_score).label,
        confidence: Number(i.confidence),
        reasons: (i.evidence.signals || []).filter((s) => s.points).sort((a, b) => b.points - a.points)
          .slice(0, 3).map((s) => s.label),
        volume: i.evidence.volume || null } : null,
      checkedAt: i?.checked_at || g?.checked_at || null,
      stale: !i || new Date(i.expires_at) < new Date(),
    };
  }).sort((a, b) => (b.risk?.score ?? -1) - (a.risk?.score ?? -1) || a.number.localeCompare(b.number));
}

const sources = () => ({
  ringcentral: rc.ENABLED,
  carrier: HIYA_ON,
  callerIdentity: false,
  internal: true,
});

/* ---------------- routes (admins and owners) ---------------- */

router.get("/api/reputation", requireAdmin, async (req, res, next) => {
  try {
    let numbers = summarise(await latest());
    /* First visit, or everything is stale: start a check in the background
       and say so, rather than make the page wait on RingCentral. */
    const stale = !numbers.length || numbers.every((n) => n.stale);
    if (stale && !running) runChecks({ userId: req.user.id, by: req.user.email })
      .catch((e) => console.warn("[karma] reputation check:", e.message));
    const alerts = (await query(
      `SELECT phone_number, evidence->'alert' AS alert, risk_score, checked_at FROM number_reputation
        WHERE provider = 'internal' AND evidence ? 'alert' ORDER BY checked_at DESC LIMIT 12`)).rows
      .map((r) => ({ number: r.phone_number, ...r.alert, score: r.risk_score, at: r.checked_at }));
    res.json({ numbers, sources: sources(), settings: await config(), alerts,
      checking: !!running, registry: REGISTRY });
  } catch (e) { next(e); }
});

router.post("/api/reputation/check", requireAdmin, async (req, res, next) => {
  try {
    const r = await runChecks({ userId: req.user.id, by: req.user.email, fresh: true });
    res.json({ ok: true, ...r, numbers: summarise(await latest()) });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

const e164 = (s) => { const d = String(s || "").replace(/\D/g, ""); return d ? "+" + d : ""; };

router.get("/api/reputation/number/:num", requireAdmin, async (req, res, next) => {
  try {
    const number = e164(req.params.num);
    const rows = (await query(
      `SELECT DISTINCT ON (provider) * FROM number_reputation
        WHERE phone_number = $1 ORDER BY provider, checked_at DESC`, [number])).rows;
    if (!rows.length) return res.status(404).json({ error: "No checks for this number yet." });
    const sum = summarise(rows)[0];
    const internal = rows.find((r) => r.provider === "internal");
    /* One point per day: the last check of each day, internal and carrier. */
    const history = (await query(
      `SELECT DISTINCT ON (provider, (checked_at AT TIME ZONE 'America/New_York')::date)
              provider, (checked_at AT TIME ZONE 'America/New_York')::date::text AS day,
              risk_score, provider_status, spam_flag, checked_at
         FROM number_reputation
        WHERE phone_number = $1 AND provider IN ('internal', 'carrier')
          AND checked_at > now() - interval '60 days'
        ORDER BY provider, (checked_at AT TIME ZONE 'America/New_York')::date, checked_at DESC`, [number])).rows;
    const reviews = (await query(
      "SELECT * FROM reputation_reviews WHERE phone_number = $1 ORDER BY submitted_at DESC", [number])).rows;
    res.json({ ...sum,
      signals: internal?.evidence?.signals || [],
      share: internal?.evidence?.share ?? null,
      providers: rows.map((r) => ({ provider: r.provider, status: r.provider_status, spamFlag: r.spam_flag,
        score: r.risk_score, confidence: r.confidence === null ? null : Number(r.confidence),
        checkedAt: r.checked_at, error: r.error, note: r.evidence?.note || null })),
      history: history.map((h) => ({ provider: h.provider, day: h.day, score: h.risk_score,
        status: h.provider_status, spamFlag: h.spam_flag })).sort((a, b) => a.day.localeCompare(b.day)),
      reviews, reviewLinks: REVIEW_LINKS, registry: REGISTRY, sources: sources() });
  } catch (e) { next(e); }
});

router.get("/api/reputation/settings", requireAdmin, async (req, res, next) => {
  try { res.json(await config()); } catch (e) { next(e); }
});

router.put("/api/reputation/settings", requireAdmin, express.json({ limit: "2kb" }), async (req, res, next) => {
  try {
    const b = req.body || {};
    const alertAt = Math.round(+b.alertAt);
    if (!(alertAt >= 10 && alertAt <= 100)) return res.status(400).json({ error: "The alert threshold must be between 10 and 100." });
    const next_ = { alertAt, email: b.email !== false };
    await settings.set(KEY, next_, req.user.email);
    res.json(next_);
  } catch (e) { next(e); }
});

/* A review request is only offered where a provider actually reported a
   flag — there is nothing to dispute in our own score. */
router.post("/api/reputation/number/:num/reviews", requireAdmin, express.json({ limit: "4kb" }), async (req, res, next) => {
  try {
    const number = e164(req.params.num);
    const provider = String(req.body?.provider || "carrier");
    if (!REVIEW_LINKS[provider]) return res.status(400).json({ error: "Reviews go to a reputation provider; this one has no review process." });
    const flagged = (await query(
      `SELECT provider_status FROM number_reputation WHERE phone_number = $1 AND provider = $2
        ORDER BY checked_at DESC LIMIT 1`, [number, provider])).rows[0];
    if (!flagged || !["flagged", "potentially_flagged"].includes(flagged.provider_status))
      return res.status(409).json({ error: "A review can be requested only when a provider has reported this number as flagged." });
    const open = (await query(
      `SELECT id FROM reputation_reviews WHERE phone_number = $1 AND provider = $2
        AND status IN ('submitted', 'under_review')`, [number, provider])).rows[0];
    if (open) return res.status(409).json({ error: "There is already an open review for this number." });
    const row = (await query(
      `INSERT INTO reputation_reviews (phone_number, provider, reason, submitted_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [number, provider, String(req.body?.reason || "").trim().slice(0, 1000), req.user.email])).rows[0];
    res.json({ review: row, submitTo: REVIEW_LINKS[provider] });
  } catch (e) { next(e); }
});

router.patch("/api/reputation/reviews/:id", requireAdmin, express.json({ limit: "4kb" }), async (req, res, next) => {
  try {
    const status = String(req.body?.status || "");
    if (!["submitted", "under_review", "resolved", "rejected"].includes(status))
      return res.status(400).json({ error: "Unknown status." });
    const row = (await query(
      `UPDATE reputation_reviews SET status = $2, notes = coalesce($3, notes), updated_by = $4, updated_at = now(),
              resolved_at = CASE WHEN $2 IN ('resolved', 'rejected') THEN now() ELSE NULL END
        WHERE id = $1 RETURNING *`,
      [+req.params.id, status, req.body?.notes === undefined ? null : String(req.body.notes).slice(0, 2000), req.user.email])).rows[0];
    if (!row) return res.status(404).json({ error: "No such review." });
    res.json({ review: row });
  } catch (e) { next(e); }
});

/* ---------------- automatic checks ----------------
   Every half hour, a check runs if the last one is older than six hours. The
   service sleeps on Render's free plan, so the daily cron knock also runs
   one (digest.js); between them a number is never more than a day stale. */
async function tickIfDue() {
  const r = (await query(
    `SELECT max(checked_at) AS at FROM number_reputation WHERE provider = 'internal'`)).rows[0];
  if (r.at && Date.now() - new Date(r.at) < INTERNAL_TTL_H * 3600e3) return { skipped: "fresh" };
  return runChecks({ by: "system" });
}

function startSweeper() {
  if (process.env.KARMA_NO_SWEEP === "1") return;
  setInterval(() => { tickIfDue().catch((e) => console.warn("[karma] reputation sweep:", e.message)); }, 30 * 60e3).unref();
}

module.exports = { router, startSweeper, runChecks, tickIfDue, _test: { findStatus, summarise } };
