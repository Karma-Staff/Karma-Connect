"use strict";
/* Inbound Zoho CRM → Karma Connect.
 *
 * When a Lead is created in Zoho CRM — by anyone, including straight inside Zoho
 * and not through us — Zoho calls this webhook. If we already hold that person
 * (matched by phone, then email), we flag them as being in the Zoho call list:
 * they then turn up in the Contacted tab and wear a "Zoho" badge, so nobody
 * calls or is assigned someone who is already being worked.
 *
 * Zoho does not HMAC-sign its notifications, so the webhook is authenticated by
 * a shared secret (ZOHO_WEBHOOK_TOKEN) — the same approach as the daily-cron
 * knock. Set it, then in Zoho add a Workflow rule "on Lead create → Webhook"
 * pointing at  <APP_URL>/api/crm/zoho/lead-created  and sending the token plus
 * the lead's phone, email, name and id (see the field list below).
 *
 * We only FLAG leads we already hold; a Zoho lead with no match here is
 * acknowledged and ignored (we do not create a new Karma Connect lead from it). */

const express = require("express");
const { query } = require("./db");
const { requireAdmin } = require("./auth");
const { pk } = require("./dedupe");
const activity = require("./activity");
const zoho = require("./zoho-crm");

const router = express.Router();

const clean = (v) => String(v == null ? "" : v).trim();

/* Read a value from the JSON body, a form body, or the query string — Zoho's
   webhook can send any of these depending on how it is set up — trying each of
   the likely field names Zoho merges in. */
const field = (req, ...names) => {
  for (const n of names) {
    const v = (req.body && req.body[n] != null) ? req.body[n]
      : (req.query && req.query[n] != null) ? req.query[n] : null;
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
};

router.post("/api/crm/zoho/lead-created",
  express.json({ limit: "64kb" }),
  express.urlencoded({ extended: false, limit: "64kb" }),
  async (req, res, next) => {
    try {
      const want = (process.env.ZOHO_WEBHOOK_TOKEN || "").trim();
      if (!want) return res.status(503).json({ error: "inbound Zoho webhook is not configured (set ZOHO_WEBHOOK_TOKEN)" });
      const got = String(req.get("x-zoho-token") || req.query.token || (req.body && req.body.token) || "").trim();
      if (got !== want) return res.status(403).json({ error: "bad token" });

      const phone = field(req, "phone", "Phone", "Mobile", "mobile", "phone_number");
      const email = field(req, "email", "Email");
      const name = field(req, "name", "Full_Name", "full_name", "Last_Name", "last_name").slice(0, 160);
      const zohoId = field(req, "zoho_id", "id", "Id", "entity_id", "record_id");
      const moduleName = field(req, "module") || "Leads";

      /* Match the KC lead. Phone is the strong key (one email can span many
         franchises); email is the fallback. Never a removed or binned lead. */
      let lead = null;
      const key = pk(phone);
      if (key) lead = (await query(
        `SELECT id, lead_code, name FROM leads
          WHERE phone_key = $1 AND deleted_at IS NULL AND NOT removed
          ORDER BY id LIMIT 1`, [key])).rows[0] || null;
      if (!lead && email) lead = (await query(
        `SELECT id, lead_code, name FROM leads
          WHERE lower(email) = lower($1) AND deleted_at IS NULL AND NOT removed
          ORDER BY id LIMIT 1`, [email])).rows[0] || null;

      if (!lead) return res.json({ ok: true, matched: false });

      // already flagged from a previous call/sync — do not pile up duplicate notes
      const already = (await query(
        `SELECT 1 FROM activity_log WHERE lead_id = $1 AND jsonb_exists(meta, 'crm_link') LIMIT 1`,
        [lead.id])).rows[0];
      if (already) return res.json({ ok: true, matched: true, id: lead.id, already: true });

      await activity.log({
        actor: "zoho", user_id: null, action: "note",
        lead_id: lead.id, lead_code: lead.lead_code, lead_name: lead.name,
        to_value: "Registered in Zoho CRM",
        meta: {
          note: "A matching Lead was created in Zoho CRM" + (zohoId ? " (id " + zohoId + ")" : ""),
          crm_link: { module: moduleName, id: zohoId || null },
          crm_source: "zoho-inbound",
        },
      });
      res.json({ ok: true, matched: true, id: lead.id });
    } catch (e) { next(e); }
  });

/* ---------------- backfill: flag everyone already in Zoho ----------------

   The webhook only catches NEW Zoho records. This scans what is ALREADY in
   Zoho — every Lead AND every Contact, not just the Leads module — and flags
   every Karma Connect lead that matches one, so the Contacted tab reflects the
   whole Zoho call list in one pass. Admin-only, run from the "Scan Zoho" button
   on that tab. Uses the org-level service account, so no rep need be signed in. */

async function sweep(moduleName, fields) {
  const rows = [];
  let token = null, pages = 0;
  for (;;) {
    const qs = new URLSearchParams({ fields, per_page: "200" });
    if (token) qs.set("page_token", token);
    let d;
    try { d = await zoho.crm(`/${moduleName}?${qs.toString()}`); }
    catch (e) { if (e.status === 204 || e.status === 404) break; throw e; }
    if (!d || !d.data || !d.data.length) break;
    rows.push(...d.data);
    pages++;
    token = d.info && d.info.next_page_token;
    if (!token || !(d.info && d.info.more_records) || pages >= 80) break;   // ~16k/module cap
  }
  return rows;
}

router.post("/api/crm/zoho/backfill", requireAdmin, async (req, res, next) => {
  try {
    if (!zoho.ENABLED) return res.status(503).json({ error: "The Zoho CRM service account isn't configured." });
    const FIELDS = "Phone,Mobile,Email,Last_Name,Full_Name";
    const byPhone = new Map(), byEmail = new Map();
    let scanned = 0;
    for (const moduleName of ["Leads", "Contacts"]) {
      let records = [];
      try { records = await sweep(moduleName, FIELDS); }
      catch (e) { console.warn("[karma] zoho backfill " + moduleName + ":", e.message); continue; }
      for (const rec of records) {
        scanned++;
        const link = { module: moduleName, id: rec.id || null };
        const key = pk(rec.Phone || rec.Mobile);
        if (key && !byPhone.has(key)) byPhone.set(key, link);
        const email = clean(rec.Email).toLowerCase();
        if (email && !byEmail.has(email)) byEmail.set(email, link);
      }
    }
    const phones = [...byPhone.keys()], emails = [...byEmail.keys()];
    if (!phones.length && !emails.length) return res.json({ ok: true, scanned, matched: 0, flagged: 0 });

    // every lead here that matches a Zoho record by phone or email, not yet flagged
    const leads = (await query(
      `SELECT l.id, l.lead_code, l.name, l.phone_key, lower(l.email) AS email FROM leads l
        WHERE l.deleted_at IS NULL AND NOT l.removed
          AND (l.phone_key = ANY($1) OR lower(l.email) = ANY($2))
          AND NOT EXISTS (SELECT 1 FROM activity_log a WHERE a.lead_id = l.id AND jsonb_exists(a.meta, 'crm_link'))`,
      [phones, emails])).rows;

    let flagged = 0;
    for (const l of leads) {
      const link = (l.phone_key && byPhone.get(l.phone_key)) || (l.email && byEmail.get(l.email)) || { module: "Leads", id: null };
      await activity.log({
        actor: "zoho", user_id: null, action: "note",
        lead_id: l.id, lead_code: l.lead_code, lead_name: l.name,
        to_value: "Registered in Zoho CRM",
        meta: { note: "Matched a " + link.module + " record in Zoho CRM",
          crm_link: { module: link.module, id: link.id }, crm_source: "zoho-backfill" },
      });
      flagged++;
    }
    res.json({ ok: true, scanned, matched: leads.length, flagged });
  } catch (e) { next(e); }
});

module.exports = { router };
