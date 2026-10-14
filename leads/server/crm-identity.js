"use strict";
/* Each person's own Zoho CRM sign-in, so what they create in the CRM is theirs.
 *
 * WHY: Zoho files a record under the account that creates it. With only the
 * shared service account (zoho-crm.js), every Call and Lead Karma Connect
 * wrote was owned by whoever set that account up — so "calls by rep", a rep's
 * "My Calls", and any permission that keys off the owner all pointed at one
 * person. A rep who connects here has their Calls and Leads created as
 * themselves, and Zoho owns them accordingly.
 *
 * OPTIONAL, AND EACH REP DOES IT THEMSELVES. Nobody has to: a rep who has not
 * connected is written through the service account exactly as before. And if a
 * rep's own sign-in is refused — revoked, or their Zoho profile may not create
 * Calls — the write falls back to the service account rather than losing the
 * call, and the refusal is kept so the screen can say "reconnect".
 *
 * WHAT STAYS ON THE SERVICE ACCOUNT: the duplicate check (findInCrm). It has to
 * see every record in the CRM, and a rep's own view may be limited to theirs —
 * searching as the rep would miss a colleague's Lead and create a second copy.
 *
 * THE SHAPE OF IT
 *   GET    /api/crm/me/connect   → off to Zoho to sign in
 *   GET    /api/crm/oauth/callback → back with a code; keep the refresh token
 *   GET    /api/crm/me           → am I connected, and as whom
 *   DELETE /api/crm/me/connect   → disconnect
 *   GET    /api/crm/people       → who on the team has connected (admin)
 *
 * NEEDS ITS OWN ZOHO CLIENT. The service account's client is a Zoho "Self
 * Client", which cannot send anybody through a sign-in page. This needs a
 * "Server-based Application" in the Zoho API console with the redirect URI
 * <APP_URL>/api/crm/oauth/callback, in ZOHO_CRM_OAUTH_CLIENT_ID and
 * ZOHO_CRM_OAUTH_CLIENT_SECRET. Until those are set, the option says so and
 * everything carries on through the service account.
 */

const express = require("express");
const { query } = require("./db");
const { requireUser, requireAdmin, rankOf, RANK } = require("./auth");
const zoho = require("./zoho-crm");
const { signState, readState, stateProblem } = require("./ringcentral");

const router = express.Router();

const clean = (v) => String(v === undefined || v === null ? "" : v).trim();
const CLIENT_ID = clean(process.env.ZOHO_CRM_OAUTH_CLIENT_ID);
const CLIENT_SECRET = clean(process.env.ZOHO_CRM_OAUTH_CLIENT_SECRET);
const APP_URL = clean(process.env.APP_URL).replace(/\/+$/, "");
const ENABLED = !!(CLIENT_ID && CLIENT_SECRET);
const VERSION = clean(process.env.ZOHO_CRM_VERSION) || "v8";

/* Only what the writes need. Leads and Calls to create; Accounts and Contacts
   are read so a Call can be attached to one; notes and attachments to keep
   the call recording on the Call (a note carrying the MP3); users.READ to learn who signed in. No delete, no
   settings, no other module. A rep who connected before a scope was added
   is told to reconnect (see asPerson) rather than silently losing the write. */
const SCOPES = [
  "ZohoCRM.modules.calls.ALL",
  "ZohoCRM.modules.attachments.CREATE",
  "ZohoCRM.modules.notes.CREATE",
  "ZohoCRM.modules.leads.ALL",
  "ZohoCRM.modules.accounts.READ",
  "ZohoCRM.modules.contacts.READ",
  "ZohoCRM.users.READ",
].join(",");

const redirectUri = () => (APP_URL || "http://localhost:3000") + "/api/crm/oauth/callback";

/* Zoho sends the person back with the accounts server of THEIR region. It is
   where the code must be redeemed — and it arrives in the URL, so it is
   checked to be a Zoho accounts host before our client secret is posted to it. */
const ZOHO_ACCOUNTS = /^https:\/\/accounts\.zoho\.(com|eu|in|com\.au|com\.cn|jp|ca|sa|uk)$/;
const ZOHO_API = /^https:\/\/(www\.)?zohoapis\.(com|eu|in|com\.au|com\.cn|jp|ca|sa|uk)$/;

async function tokenPost(accounts, params) {
  const r = await fetch(`${accounts}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }).toString(),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error || !d.access_token) {
    const e = new Error(d.error || `Zoho sign-in ${r.status}`);
    e.status = 401; e.zoho = d;
    throw e;
  }
  return d;
}

/* ---------------- sign-in ---------------- */

router.get("/api/crm/me/connect", requireUser, (req, res) => {
  if (!ENABLED) return res.status(503).json({ error:
    "Personal Zoho CRM sign-in is not set up on this server (ZOHO_CRM_OAUTH_CLIENT_ID / _SECRET)." });
  const url = new URL(`${zoho.ACCOUNTS}/oauth/v2/auth`);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");   // a refresh token, not just an hour
  url.searchParams.set("prompt", "consent");        // …every time, or a re-connect returns none
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("state", signState(req.user.id));
  res.redirect(url.toString());
});

router.get("/api/crm/oauth/callback", async (req, res) => {
  const back = (msg, ok) => res.redirect("/leads/?tab=me&crm=" + (ok ? "ok" : "error")
    + (msg ? "&msg=" + encodeURIComponent(String(msg).slice(0, 160)) : ""));
  try {
    if (req.query.error) return back(req.query.error === "access_denied"
      ? "Zoho sign-in was cancelled" : String(req.query.error));
    const userId = readState(req.query.state);
    if (!userId) {
      const why = stateProblem(req.query.state) || "the sign-in could not be verified";
      console.warn("[karma] zoho crm sign-in refused:", why);
      return back(why + " — open Karma Connect again and click Connect Zoho CRM");
    }
    const code = clean(req.query.code);
    if (!code) return back("Zoho sent no code back");
    const accounts = clean(req.query["accounts-server"]) || zoho.ACCOUNTS;
    if (!ZOHO_ACCOUNTS.test(accounts)) return back("Zoho sent back an unexpected sign-in server");

    const tok = await tokenPost(accounts, {
      grant_type: "authorization_code", code, redirect_uri: redirectUri() });
    if (!tok.refresh_token) return back("Zoho gave no long-lived sign-in — try connecting again");
    const api = clean(tok.api_domain) || zoho.API;
    if (!ZOHO_API.test(api)) return back("Zoho sent back an unexpected API server");

    /* Who is this? Kept so the screen can say "connected as …" — the quickest
       way to notice somebody signed in to the wrong Zoho account. */
    let who = {};
    try {
      const r = await fetch(`${api}/crm/${VERSION}/users?type=CurrentUser`,
        { headers: { Authorization: "Zoho-oauthtoken " + tok.access_token } });
      if (r.ok) who = ((await r.json()).users || [])[0] || {};
    } catch { /* a nicety; the token is the point */ }

    await query(
      `INSERT INTO crm_identities (user_id, provider, refresh_token, api_domain, accounts_url,
                                   zoho_user_id, zoho_name, zoho_email, connected_at)
       VALUES ($1, 'zoho', $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (user_id) DO UPDATE SET
         refresh_token = EXCLUDED.refresh_token, api_domain = EXCLUDED.api_domain,
         accounts_url = EXCLUDED.accounts_url, zoho_user_id = EXCLUDED.zoho_user_id,
         zoho_name = EXCLUDED.zoho_name, zoho_email = EXCLUDED.zoho_email,
         connected_at = now(), last_error = NULL, last_error_at = NULL`,
      [userId, tok.refresh_token, api, accounts, who.id ? String(who.id) : null,
       who.full_name || null, who.email || null]);
    TOKENS.set(userId, { tok: tok.access_token, until: Date.now() + ((tok.expires_in || 3600) - 60) * 1000 });
    back(null, true);
  } catch (e) {
    console.error("[karma] zoho crm sign-in:", e.message);
    back(e.message);
  }
});

/* ---------------- using it ---------------- */

const identity = async (userId) => userId ? (await query(
  "SELECT * FROM crm_identities WHERE user_id = $1", [userId])).rows[0] || null : null;

/* Zoho access tokens last an hour and the refresh token does not rotate, so
   two refreshes racing is harmless — but one dashboard of calls would still
   refresh once per call. Cached per person until a minute before expiry. */
const TOKENS = new Map();
const MINTING = new Map();     // one refresh per person at a time (see zoho-crm.js)

async function accessFor(id, fresh) {
  const hit = TOKENS.get(id.user_id);
  if (!fresh && hit && hit.until > Date.now()) return hit.tok;
  if (!MINTING.has(id.user_id)) MINTING.set(id.user_id, (async () => {
    const tok = await tokenPost(id.accounts_url, {
      grant_type: "refresh_token", refresh_token: id.refresh_token });
    TOKENS.set(id.user_id, { tok: tok.access_token,
      until: Date.now() + ((tok.expires_in || 3600) - 60) * 1000 });
    return tok.access_token;
  })().finally(() => MINTING.delete(id.user_id)));
  return MINTING.get(id.user_id);
}

/* Refresh errors that mean the sign-in itself is gone — revoked in Zoho, or
   replaced by a newer connect — so only reconnecting brings it back. Anything
   else from the token endpoint (Zoho's "too many requests", a network blip)
   passes on its own and must not tell the rep they are disconnected. */
const DEAD = new Set(["invalid_code", "invalid_grant", "invalid_client", "unauthorized_client"]);

/* Refusals that mean "this person's own sign-in cannot do it" — retrying the
   same write through the service account is the right answer to these, and to
   nothing else (a bad field would fail the same way through either). */
const REFUSED = new Set(["INVALID_TOKEN", "AUTHENTICATION_FAILURE", "OAUTH_SCOPE_MISMATCH",
  "NO_PERMISSION", "INVALID_OAUTHSCOPE", "LICENSE_LIMIT_EXCEEDED", "FEATURE_NOT_SUPPORTED"]);

async function asPerson(id, path, opts) {
  const send = async (token) => {
    const r = await fetch(`${id.api_domain}/crm/${VERSION}${path}`, {
      ...opts,
      headers: { Authorization: "Zoho-oauthtoken " + token,
        ...(opts.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(opts.headers || {}) },
    });
    const d = r.status === 204 ? null : await r.json().catch(() => ({}));
    return { r, d, code: d?.code || d?.data?.[0]?.code };
  };
  /* An access token Zoho has retired early is not a lost sign-in: mint a
     fresh one and try once more before calling it refused. This was the
     "Zoho CRM keeps disconnecting" — one stale token marked the rep refused. */
  const tokenOf = (fresh) => accessFor(id, fresh).catch((e) => { e.tokenRefresh = true; throw e; });
  let { r, d, code } = await send(await tokenOf());
  if (r.status === 401 || code === "INVALID_TOKEN" || code === "AUTHENTICATION_FAILURE") {
    TOKENS.delete(id.user_id);
    ({ r, d, code } = await send(await tokenOf(true)));
  }
  if (r.status === 401 || r.status === 403 || REFUSED.has(code)) {
    /* A permission added after this person connected (attachments, for the
       call recording) reads as a scope error: say what to do about it. */
    const scope = /OAUTH_?SCOPE/i.test(code || "") || /oauth ?scope/i.test(d?.message || "");
    const e = new Error(scope
      ? "Reconnect Zoho CRM to allow this (a permission was added since you connected) — your own Zoho sign-in"
      : (d?.data?.[0]?.message || d?.message || code || `Zoho ${r.status}`) + " (your own Zoho sign-in)");
    e.refused = true; e.status = r.status; e.zoho = d;
    /* Only a refusal of the sign-in itself is the rep's to fix by reconnecting.
       NO_PERMISSION and the like are about this one record or their Zoho
       profile — reconnecting changes nothing, so the screen must not say so. */
    e.signIn = scope || r.status === 401 || code === "INVALID_TOKEN" || code === "AUTHENTICATION_FAILURE";
    throw e;
  }
  if (!r.ok && !(d && d.data)) {
    const e = new Error(d?.message || d?.code || `Zoho CRM ${r.status}`);
    e.status = r.status; e.zoho = d;
    throw e;
  }
  return d;
}

/* Write to the CRM as this person if they have connected, else as the service
   account. Returns the response and who it went as — "rep" or "shared" — which
   the caller stores, so a manager can see whose name a record went in under.
   A refusal of the person's own sign-in is recorded and falls back. */
async function writeAs(userId, path, opts = {}) {
  const id = ENABLED ? await identity(userId) : null;
  if (id) {
    try {
      const d = await asPerson(id, path, opts);
      query("UPDATE crm_identities SET last_used_at = now(), last_error = NULL, last_error_at = NULL WHERE user_id = $1",
        [id.user_id]).catch(() => {});
      return { d, as: "rep", who: id.zoho_name || id.zoho_email || null };
    } catch (e) {
      /* A failed token refresh used to throw straight out of here, so the
         write was lost rather than going in under the shared account. */
      if (!e.refused && !e.tokenRefresh) throw e;
      const dead = e.refused ? e.signIn : DEAD.has(String(e.zoho?.error));
      if (dead) {
        TOKENS.delete(id.user_id);
        const msg = e.refused ? e.message
          : "Your Zoho sign-in has expired or was revoked — reconnect Zoho CRM";
        await query("UPDATE crm_identities SET last_error = $2, last_error_at = now() WHERE user_id = $1",
          [id.user_id, String(msg).slice(0, 300)]).catch(() => {});
      }
      console.warn("[karma] zoho crm: user", id.user_id, dead ? "refused" : "could not write as themselves (passing)",
        "— using the service account:", e.message);
    }
  }
  return { d: await zoho.crm(path, opts), as: "shared", who: null };
}

/* ---------------- status ---------------- */

/* The settings both halves need, by name — so "isn't set up" can say which
   is missing instead of leaving someone to compare variable lists by eye. */
const missing = () => [
  ["ZOHO_CRM_OAUTH_CLIENT_ID", CLIENT_ID], ["ZOHO_CRM_OAUTH_CLIENT_SECRET", CLIENT_SECRET],
  ["ZOHO_CRM_CLIENT_ID", process.env.ZOHO_CRM_CLIENT_ID],
  ["ZOHO_CRM_CLIENT_SECRET", process.env.ZOHO_CRM_CLIENT_SECRET],
  ["ZOHO_CRM_REFRESH_TOKEN", process.env.ZOHO_CRM_REFRESH_TOKEN],
].filter(([, v]) => !clean(v)).map(([k]) => k);

router.get("/api/crm/me", requireUser, async (req, res, next) => {
  try {
    const id = ENABLED ? await identity(req.user.id) : null;
    const isAdmin = rankOf(req.user.role) >= RANK.admin;
    res.json({
      ...(isAdmin ? { missing: missing() } : {}),
      enabled: ENABLED && zoho.ENABLED,
      connected: !!id,
      name: id?.zoho_name || null, email: id?.zoho_email || null,
      connectedAt: id?.connected_at || null, lastUsedAt: id?.last_used_at || null,
      lastError: id?.last_error || null,
      connectUrl: "/api/crm/me/connect",
    });
  } catch (e) { next(e); }
});

/* Disconnecting is a deliberate act by an admin, never a rep's slip of the
   mouse: reps have no Disconnect button (app.js), and this route refuses them
   too. Nothing disconnects anyone automatically — a refused sign-in keeps its
   row and shows "Reconnect"; only this route ever deletes it. */
router.delete("/api/crm/me/connect", requireUser, async (req, res, next) => {
  try {
    if (rankOf(req.user.role) < RANK.admin)
      return res.status(403).json({ error: "Only an admin can disconnect a Zoho CRM sign-in." });
    await query("DELETE FROM crm_identities WHERE user_id = $1", [req.user.id]);
    TOKENS.delete(req.user.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* Who has connected — the manager's answer to "why are this rep's calls
   still under the shared account in Zoho". Tokens never leave the server. */
router.get("/api/crm/people", requireAdmin, async (req, res, next) => {
  try {
    const rows = (await query(
      `SELECT u.email, coalesce(nullif(btrim(u.display_name), ''), u.email) AS name, m.role,
              c.zoho_name, c.zoho_email, c.connected_at, c.last_used_at, c.last_error
         FROM app_users u
         LEFT JOIN organization_memberships m ON m.user_id = u.id
         LEFT JOIN crm_identities c ON c.user_id = u.id
        WHERE NOT u.disabled AND u.email LIKE '%@%'
        ORDER BY (c.user_id IS NULL), (m.role IS DISTINCT FROM 'sales_rep'), 2`)).rows;
    res.json({ enabled: ENABLED, people: rows });
  } catch (e) { next(e); }
});

/* DELETE /api/crm/people/:email/connect — an admin disconnects someone's
   Zoho CRM sign-in (a rep who left, or one connected to the wrong Zoho
   account). Reps cannot disconnect at all; connecting stays with each person,
   because it is a sign-in to THEIR Zoho account. Logged to Team activity. */
router.delete("/api/crm/people/:email/connect", requireAdmin, async (req, res, next) => {
  try {
    const email = String(req.params.email || "").trim().toLowerCase();
    const u = (await query("SELECT id, email FROM app_users WHERE lower(email) = $1", [email])).rows[0];
    if (!u) return res.status(404).json({ error: "No such person." });
    const gone = (await query("DELETE FROM crm_identities WHERE user_id = $1 RETURNING zoho_email", [u.id])).rows[0];
    TOKENS.delete(u.id);
    if (gone) require("./activity").log({ actor: req.user.email, user_id: req.user.id, action: "note",
      to_value: "Disconnected Zoho CRM for " + u.email,
      meta: { note: `Zoho CRM sign-in disconnected for ${u.email}${gone.zoho_email ? " (was " + gone.zoho_email + ")" : ""}`,
        crm_disconnect: u.email } }).catch(() => {});
    res.json({ ok: true, disconnected: !!gone });
  } catch (e) { next(e); }
});

module.exports = { router, ENABLED, writeAs, SCOPES, _test: { REFUSED, DEAD, ZOHO_ACCOUNTS, ZOHO_API } };
