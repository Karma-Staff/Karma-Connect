"use strict";
/* Zoho CRM — the connection, and a look at what is actually in there.
 *
 * SEPARATE CREDENTIALS FROM VOICE, on purpose. voice.js holds a token scoped
 * to ZohoVoice.sdk.ALL; this holds one scoped to the CRM modules. Sharing a
 * variable between them is how a token ends up with the wrong scope and fails
 * with a message that blames the wrong thing — which has already happened once
 * on this project.
 *
 * ONE IDENTITY, NOT PER REP. The opposite of RingCentral, and deliberately:
 * telephony has to be per person because the caller ID and the call log are
 * theirs, but a CRM write is the system recording what the company did. One
 * service identity keeps the audit trail legible and avoids six people each
 * holding a token that can rewrite the CRM.
 *
 * NOTHING IS WRITTEN YET. This file is the connection and a read-only survey.
 * The survey exists because the shape of the sync depends on how the CRM is
 * actually used — whether companies live as Accounts or as Leads — and that is
 * a question the CRM can answer better than anyone's memory of it.
 */

const express = require("express");
const { query } = require("./db");
const { requireAdmin } = require("./auth");

const router = express.Router();

const clean = (v) => String(v === undefined || v === null ? "" : v).trim();

const CLIENT_ID = clean(process.env.ZOHO_CRM_CLIENT_ID);
const CLIENT_SECRET = clean(process.env.ZOHO_CRM_CLIENT_SECRET);
const REFRESH_TOKEN = clean(process.env.ZOHO_CRM_REFRESH_TOKEN);
const ENABLED = !!(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);

/* Zoho is regional and the two hosts move together: an account on .eu refreshes
   at accounts.zoho.eu and calls api at zohoapis.eu. Getting one right and the
   other wrong gives "invalid_client", which reads like a bad secret. */
const DC = clean(process.env.ZOHO_CRM_DC) || "com";
const ACCOUNTS = clean(process.env.ZOHO_ACCOUNTS_DOMAIN)
  || `https://accounts.zoho.${DC}`;
const API = clean(process.env.ZOHO_CRM_API_DOMAIN) || `https://www.zohoapis.${DC}`;
const VERSION = clean(process.env.ZOHO_CRM_VERSION) || "v8";

if ((CLIENT_ID || REFRESH_TOKEN) && !ENABLED) {
  console.warn("[karma] Zoho CRM is half-configured — needs ZOHO_CRM_CLIENT_ID, "
    + "ZOHO_CRM_CLIENT_SECRET and ZOHO_CRM_REFRESH_TOKEN. Staying off.");
}

/* Zoho access tokens last an hour and the refresh token does NOT rotate, which
   is the opposite of RingCentral — so this caches rather than writing back. */
let cached = { token: "", until: 0 };

async function accessToken() {
  if (!ENABLED) { const e = new Error("Zoho CRM is not configured"); e.status = 503; throw e; }
  if (cached.token && Date.now() < cached.until - 60000) return cached.token;

  const r = await fetch(`${ACCOUNTS}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: REFRESH_TOKEN, client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET, grant_type: "refresh_token",
    }).toString(),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) {
    const hint = {
      invalid_code: "that looks like a GRANT CODE rather than a refresh token — "
        + "run scripts/zoho-token.mjs --for crm to exchange it",
      invalid_client: "check the id and secret, and that this account is on ." + DC,
    }[d.error];
    const e = new Error((d.error || `HTTP ${r.status}`) + (hint ? " — " + hint : ""));
    e.status = 502; e.zoho = d;
    throw e;
  }
  cached = { token: d.access_token, until: Date.now() + (d.expires_in || 3600) * 1000 };
  return cached.token;
}

async function crm(path, opts = {}) {
  const token = await accessToken();
  const r = await fetch(`${API}/crm/${VERSION}${path}`, {
    ...opts,
    headers: { Authorization: "Zoho-oauthtoken " + token,
      "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (r.status === 204) return null;            // Zoho's "no records"
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(d.message || d.code || `Zoho CRM ${r.status}`);
    e.status = r.status; e.zoho = d;
    throw e;
  }
  return d;
}

/* GET /api/crm/status — is it connected, and what is actually in there.

   Read-only. The point is to decide the shape of the sync from evidence: if
   the team works Accounts and barely touches Leads, syncing into Leads would
   put our records where nobody looks. */
router.get("/api/crm/status", requireAdmin, async (req, res, next) => {
  const out = { enabled: ENABLED, dc: DC, api: API, version: VERSION };
  if (!ENABLED) return res.json({ ...out, connected: false,
    error: "set ZOHO_CRM_CLIENT_ID, ZOHO_CRM_CLIENT_SECRET and ZOHO_CRM_REFRESH_TOKEN" });
  try {
    const org = await crm("/org");
    out.connected = true;
    const o = (org && org.org && org.org[0]) || {};
    out.org = { name: o.company_name, id: o.id, edition: o.edition,
      country: o.country, users: o.license_details && o.license_details.users_license_purchased };

    /* How many records live in each module we might write to. count() is one
       cheap call per module and answers the Accounts-versus-Leads question
       without anyone having to remember. */
    out.modules = {};
    for (const m of ["Accounts", "Leads", "Contacts", "Deals", "Calls"]) {
      try {
        const c = await crm(`/${m}/actions/count`);
        out.modules[m] = (c && c.count !== undefined) ? Number(c.count) : null;
      } catch (e) { out.modules[m] = { error: e.message }; }
    }

    /* What our leads would have to map onto. Only the required fields, because
       those are the ones that make a create fail. */
    try {
      const f = await crm("/settings/fields?module=Accounts");
      out.accountRequiredFields = (f.fields || [])
        .filter((x) => x.system_mandatory || x.required)
        .map((x) => x.api_name);
    } catch (e) { out.accountRequiredFields = { error: e.message }; }

    res.json(out);
  } catch (e) {
    res.status(e.status === 503 ? 503 : 502).json({ ...out, connected: false,
      error: e.message, zoho: e.zoho });
  }
});

/* How much of our own base would ever reach the CRM. Paired with the module
   counts above so the two numbers can be read side by side. */
router.get("/api/crm/preview", requireAdmin, async (req, res, next) => {
  try {
    const r = (await query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE touched)::int AS worked
        FROM (
          SELECT l.id,
                 (EXISTS (SELECT 1 FROM activity_log a
                           WHERE a.lead_id = l.id
                             AND a.action IN ('call','note','status','owner','enrich'))
                  OR EXISTS (SELECT 1 FROM lead_comments c
                              WHERE c.lead_id = l.id AND c.deleted_at IS NULL)
                  OR l.status <> 'New') AS touched
            FROM leads l
           WHERE l.deleted_at IS NULL AND NOT l.removed
        ) x`)).rows[0];
    res.json({ ...r, note: "worked = called, noted, re-owned, enriched or moved off New" });
  } catch (e) { next(e); }
});

module.exports = { router, ENABLED, crm, accessToken };
