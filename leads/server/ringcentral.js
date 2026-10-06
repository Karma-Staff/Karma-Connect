"use strict";
/* RingCentral: each rep's own softphone.
 *
 * HOW IT DIFFERS FROM ZOHO, which is the whole reason for this file:
 * Zoho was one set of credentials in the environment that everybody shared, so
 * every rep dialled from the same identity. RingCentral is per seat. Each rep
 * signs in once with their own RingCentral account, we keep their refresh
 * token in voice_identities (migration 012), and calls go out as them.
 *
 * THE SHAPE OF IT
 *   GET  /api/voice/rc/connect   → send the rep to RingCentral to sign in
 *   GET  /api/voice/rc/callback  → they come back with a code; swap it for a
 *                                  refresh token and store it
 *   GET  /api/voice/rc/status    → is this rep connected, and as which extension
 *   POST /api/voice/rc/session   → a short-lived access token plus SIP details,
 *                                  which is what the browser's web phone needs
 *   DELETE /api/voice/rc/connect → disconnect this rep
 *   GET  /api/voice/rc/team      → who on the team has connected (admin)
 *
 * THE SECRET NEVER REACHES THE BROWSER. The client secret stays here; the
 * browser is handed only a SIP registration that expires. That is why the app
 * is registered as a server-side web app rather than a browser one.
 */

const express = require("express");
const crypto = require("crypto");
const { query } = require("./db");
const { requireUser, requireAdmin } = require("./auth");

const router = express.Router();

const clean = (v) => String(v === undefined || v === null ? "" : v).trim();

const SERVER = (clean(process.env.RINGCENTRAL_SERVER_URL)
  || "https://platform.ringcentral.com").replace(/\/+$/, "");
const CLIENT_ID = clean(process.env.RINGCENTRAL_CLIENT_ID);
const CLIENT_SECRET = clean(process.env.RINGCENTRAL_CLIENT_SECRET);
const APP_URL = clean(process.env.APP_URL).replace(/\/+$/, "");

const ENABLED = !!(CLIENT_ID && CLIENT_SECRET);
const SANDBOX = /devtest/.test(SERVER);

if (process.env.RINGCENTRAL_CLIENT_ID && !ENABLED) {
  console.warn("[karma] RINGCENTRAL_CLIENT_ID is set but RINGCENTRAL_CLIENT_SECRET "
    + "is missing — the RingCentral softphone stays off.");
}
if (ENABLED && SANDBOX) {
  console.warn("[karma] RingCentral is pointed at the SANDBOX "
    + "(RINGCENTRAL_SERVER_URL). Calls can only reach RingCentral's test "
    + "numbers, never a real lead.");
}

/* The redirect must match what is registered on the app, character for
   character, or RingCentral refuses the login with a message that does not say
   so. Derived from APP_URL rather than from the request, because a proxy can
   make the request host something the app has never heard of. */
const redirectUri = () => (APP_URL ? APP_URL : "http://localhost:8787")
  + "/api/voice/rc/callback";

const basicAuth = () =>
  "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

async function rcForm(path, params, headers = {}) {
  const r = await fetch(SERVER + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });
  const text = await r.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!r.ok) {
    /* RingCentral puts the useful part in error_description; `error` alone is
       a code that means nothing to the person reading the screen. */
    const e = new Error(body.error_description || body.message || body.error
      || `RingCentral ${r.status}`);
    e.status = r.status;
    e.rc = body;
    throw e;
  }
  return body;
}

/* ---------------- sign-in ---------------- */

/* The state parameter carries the user id, signed, so the callback knows who
   came back without trusting a cookie that may have been replaced mid-flow,
   and so a stranger cannot bind their RingCentral account to someone else's
   row by replaying a callback URL. */
const stateSecret = () => clean(process.env.AUTH_JWT_SECRET) || "dev-only";
function signState(userId) {
  const nonce = crypto.randomBytes(8).toString("hex");
  const payload = `${userId}.${Date.now()}.${nonce}`;
  const mac = crypto.createHmac("sha256", stateSecret()).update(payload)
    .digest("base64url").slice(0, 32);
  return `${payload}.${mac}`;
}
function readState(state) {
  const parts = String(state || "").split(".");
  if (parts.length !== 4) return null;
  const [id, ts, nonce, mac] = parts;
  const payload = `${id}.${ts}.${nonce}`;
  const want = crypto.createHmac("sha256", stateSecret()).update(payload)
    .digest("base64url").slice(0, 32);
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() - Number(ts) > 15 * 60 * 1000) return null;   // a stale login
  return Number(id);
}

/* Why readState refused, in words — for a sign-in that bounced. "Expired" was
   the only thing it could say, and it was said for a signature from a
   different server just as for a slow login, which sent people retrying the
   wrong thing. */
function stateProblem(state) {
  const parts = String(state || "").split(".");
  if (!state) return "no sign-in state came back";
  if (parts.length !== 4) return `the sign-in state came back altered (${parts.length} parts)`;
  const [id, ts, nonce, mac] = parts;
  const want = crypto.createHmac("sha256", stateSecret()).update(`${id}.${ts}.${nonce}`)
    .digest("base64url").slice(0, 32);
  if (mac !== want) return "the sign-in was started on a different server (or before a restart with new settings)";
  const age = Math.round((Date.now() - Number(ts)) / 60000);
  if (age > 15) return `the sign-in took ${age} minutes — it must finish within 15`;
  return "";
}

router.get("/api/voice/rc/connect", requireUser, (req, res) => {
  if (!ENABLED) return res.status(503).json({
    error: "RingCentral is not configured — set RINGCENTRAL_CLIENT_ID and RINGCENTRAL_CLIENT_SECRET" });
  const url = new URL(SERVER + "/restapi/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("state", signState(req.user.id));
  res.redirect(url.toString());
});

router.get("/api/voice/rc/callback", async (req, res, next) => {
  const back = (msg, ok) => res.redirect(
    "/leads/?tab=me&rc=" + (ok ? "ok" : "error")
    + (msg ? "&msg=" + encodeURIComponent(String(msg).slice(0, 160)) : ""));
  try {
    if (req.query.error) return back(req.query.error_description || req.query.error);
    const userId = readState(req.query.state);
    if (!userId) return back("that sign-in link has expired — try again");
    const code = clean(req.query.code);
    if (!code) return back("RingCentral sent no code back");

    const tok = await rcForm("/restapi/oauth/token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
    }, { Authorization: basicAuth() });

    /* Who did we just connect? Stored so the UI can show the rep which
       extension they are about to dial from — the single most useful thing to
       confirm before anyone rings a customer. */
    let who = {};
    try {
      const r = await fetch(SERVER + "/restapi/v1.0/account/~/extension/~", {
        headers: { Authorization: "Bearer " + tok.access_token } });
      if (r.ok) who = await r.json();
    } catch { /* identity is a nicety; the token is the point */ }

    await query(
      `INSERT INTO voice_identities
         (user_id, provider, refresh_token, rc_owner_id, extension, ext_number,
          main_number, refresh_expires_at, connected_at, last_error, last_error_at)
       VALUES ($1,'ringcentral',$2,$3,$4,$5,$6,$7, now(), NULL, NULL)
       ON CONFLICT (user_id) DO UPDATE SET
         provider = 'ringcentral', refresh_token = EXCLUDED.refresh_token,
         rc_owner_id = EXCLUDED.rc_owner_id, extension = EXCLUDED.extension,
         ext_number = EXCLUDED.ext_number, main_number = EXCLUDED.main_number,
         refresh_expires_at = EXCLUDED.refresh_expires_at,
         connected_at = now(), last_error = NULL, last_error_at = NULL`,
      [userId, tok.refresh_token, String(tok.owner_id || who.id || ""),
       String(who.extensionNumber || ""),
       String((who.contact && who.contact.email) || ""),
       String((who.contact && who.contact.businessPhone) || ""),
       tok.refresh_token_expires_in
         ? new Date(Date.now() + tok.refresh_token_expires_in * 1000) : null]);
    forgetAccess(userId);       // a new seat: drop any cached token for the old one

    back(null, true);
  } catch (e) {
    console.error("[karma] ringcentral callback:", e.message);
    next ? back(e.message) : next(e);
  }
});

/* ---------------- using it ---------------- */

async function identity(userId) {
  return (await query(
    "SELECT * FROM voice_identities WHERE user_id = $1 AND provider = 'ringcentral'",
    [userId])).rows[0] || null;
}

/* Swap the stored refresh token for a short-lived access token.

   RingCentral ROTATES the refresh token on every use, so the new one must be
   written back or the next call fails with an error that reads like a
   configuration problem and is not one.

   Which is also why two refreshes must never race. Both would present the same
   refresh token; RingCentral honours the first, the second gets invalid_grant,
   and that error is read as "signed out" — one dashboard firing call log,
   presence and extensions in parallel would disconnect its own viewer. So the
   access token is kept in memory until a minute before it expires, and while
   a refresh is in flight every other caller waits on that same promise. */
const TOKENS = new Map();     // userId -> { tok, until } | { pending: Promise }

async function accessFor(userId) {
  const hit = TOKENS.get(userId);
  if (hit?.pending) return hit.pending;
  if (hit && hit.until > Date.now()) return hit.tok;
  const pending = refreshAccess(userId).then(
    (tok) => {
      TOKENS.set(userId, { tok, until: Date.now() + Math.max(0, (tok.expires_in || 3600) - 60) * 1000 });
      return tok;
    },
    (e) => { TOKENS.delete(userId); throw e; });
  TOKENS.set(userId, { pending });
  return pending;
}

/* A disconnect or a fresh sign-in must not keep serving the old seat's token. */
const forgetAccess = (userId) => TOKENS.delete(userId);

async function refreshAccess(userId) {
  const id = await identity(userId);
  if (!id) { const e = new Error("not connected"); e.status = 428; throw e; }
  try {
    const tok = await rcForm("/restapi/oauth/token", {
      grant_type: "refresh_token", refresh_token: id.refresh_token,
    }, { Authorization: basicAuth() });
    await query(
      `UPDATE voice_identities SET refresh_token = $2, last_used_at = now(),
              refresh_expires_at = $3, last_error = NULL, last_error_at = NULL
        WHERE user_id = $1`,
      [userId, tok.refresh_token,
       tok.refresh_token_expires_in
         ? new Date(Date.now() + tok.refresh_token_expires_in * 1000) : null]);
    return tok;
  } catch (e) {
    await query(
      "UPDATE voice_identities SET last_error = $2, last_error_at = now() WHERE user_id = $1",
      [userId, String(e.message).slice(0, 300)]).catch(() => {});
    /* An expired or revoked grant is not a server fault — it means sign in
       again, and the UI can only say so if the status is distinguishable. */
    if (e.status === 400 || e.status === 401) e.status = 428;
    throw e;
  }
}

router.get("/api/voice/rc/status", requireUser, async (req, res, next) => {
  try {
    const id = await identity(req.user.id);
    res.json({
      enabled: ENABLED, sandbox: SANDBOX,
      connected: !!id,
      extension: id ? id.extension || null : null,
      connectedAt: id ? id.connected_at : null,
      refreshExpiresAt: id ? id.refresh_expires_at : null,
      lastError: id ? id.last_error : null,
      connectUrl: "/api/voice/rc/connect",
    });
  } catch (e) { next(e); }
});

/* POST /api/voice/rc/session — everything the browser needs to register a
   softphone, and nothing more. The access token is short-lived by design: if
   it leaks it expires, whereas the refresh token never leaves this process. */
router.post("/api/voice/rc/session", requireUser, async (req, res, next) => {
  try {
    if (!ENABLED) return res.status(503).json({ error: "RingCentral is not configured" });
    const tok = await accessFor(req.user.id);

    const r = await fetch(SERVER + "/restapi/v1.0/client-info/sip-provision", {
      method: "POST",
      headers: { Authorization: "Bearer " + tok.access_token,
                 "Content-Type": "application/json" },
      body: JSON.stringify({ sipInfo: [{ transport: "WSS" }] }),
    });
    const sip = await r.json().catch(() => ({}));
    if (!r.ok) {
      /* The usual cause is the app lacking VoIP Calling permission, which the
         message does not say. Say it here so nobody goes looking in the code. */
      const msg = sip.message || sip.error_description || `sip-provision ${r.status}`;
      return res.status(r.status === 403 ? 403 : 502).json({
        error: msg,
        hint: r.status === 403
          ? "The RingCentral app needs the VoIP Calling permission, and the extension needs a seat."
          : undefined,
      });
    }

    res.json({
      sipInfo: sip.sipInfo, sipFlags: sip.sipFlags,
      device: sip.device ? { id: sip.device.id, name: sip.device.name } : null,
      expiresIn: tok.expires_in,
      sandbox: SANDBOX,
    });
  } catch (e) {
    if (e.status === 428)
      return res.status(428).json({ error: "Connect your RingCentral account first",
        connectUrl: "/api/voice/rc/connect" });
    next(e);
  }
});

router.delete("/api/voice/rc/connect", requireUser, async (req, res, next) => {
  try {
    await query("DELETE FROM voice_identities WHERE user_id = $1", [req.user.id]);
    forgetAccess(req.user.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* Who on the team has a working phone. The manager's version of "why is that
   rep logging no calls". */
router.get("/api/voice/rc/team", requireAdmin, async (req, res, next) => {
  try {
    const rows = (await query(
      `SELECT u.email, u.display_name, v.extension, v.connected_at,
              v.last_used_at, v.last_error, v.refresh_expires_at
         FROM app_users u
         LEFT JOIN voice_identities v
           ON v.user_id = u.id AND v.provider = 'ringcentral'
        WHERE NOT u.disabled
        ORDER BY (v.user_id IS NULL), coalesce(u.display_name, u.email)`)).rows;
    res.json({ enabled: ENABLED, sandbox: SANDBOX, people: rows });
  } catch (e) { next(e); }
});

/* GET /api/voice/rc/me — what this rep's own seat is, for the dialler header.

   The status route above answers "are you connected"; this answers "and what
   do people see when you ring them". They are separate calls because status is
   read on every page load and this one costs a round trip to RingCentral.

   Caller ID matters more than it looks on a sales floor: a rep who cannot see
   which number is going out cannot tell a flagged number from a clean one,
   which is the exact problem that moved us off the single shared Zoho line. */
router.get("/api/voice/rc/me", requireUser, async (req, res, next) => {
  try {
    if (!ENABLED) return res.status(503).json({ error: "RingCentral is not configured" });
    const tok = await accessFor(req.user.id);
    const r = await fetch(SERVER + "/restapi/v1.0/account/~/extension/~/phone-number?perPage=100",
      { headers: { Authorization: "Bearer " + tok.access_token } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: d.message || `phone-number ${r.status}` });

    const nums = (d.records || [])
      .filter((n) => n.phoneNumber)
      .map((n) => ({ number: n.phoneNumber, type: n.type || null,
        usage: n.usageType || null }));
    /* Direct number first: that is what an outbound call presents by default.
       Falling back to the first number at all is better than showing nothing,
       but it is a guess, so the browser labels it as the seat's number rather
       than promising it is the caller ID. */
    const direct = nums.find((n) => n.usage === "DirectNumber") || nums[0] || null;
    res.json({ callerId: direct ? direct.number : null, exact: !!nums.find((n) => n.usage === "DirectNumber"), numbers: nums });
  } catch (e) {
    if (e.status === 428) return res.status(428).json({ error: "Connect your RingCentral account first" });
    next(e);
  }
});

/* GET /api/voice/rc/extensions — who a rep can transfer a live call to.

   Deliberately NOT the /team route above: that one is the manager's screen and
   carries each person's last error and token expiry, which is nobody else's
   business. This is the two fields a transfer needs and nothing else, so it
   can be open to members — a rep who cannot transfer a call has to tell the
   customer to hang up and ring a different number. */
router.get("/api/voice/rc/extensions", requireUser, async (req, res, next) => {
  try {
    const rows = (await query(
      `SELECT coalesce(nullif(btrim(u.display_name), ''), u.email) AS name,
              v.extension
         FROM voice_identities v
         JOIN app_users u ON u.id = v.user_id
        WHERE v.provider = 'ringcentral'
          AND NOT u.disabled
          AND v.user_id <> $1
          AND nullif(btrim(v.extension), '') IS NOT NULL
        ORDER BY 1`, [req.user.id])).rows;
    res.json({ people: rows });
  } catch (e) { next(e); }
});

module.exports = { router, ENABLED, SANDBOX, SERVER, accessFor, identity, signState, readState, stateProblem };
