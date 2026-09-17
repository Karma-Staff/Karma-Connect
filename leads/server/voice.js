"use strict";
/* Click-to-call through Zoho Voice.

   The dialling itself happens in the browser: Zoho's WebSDK is a WebRTC
   softphone that runs in the page (see public/app.js). This module exists for
   the two things the browser must not do.

   1. Say whether the feature is on. The front end should not have to guess, and
      a half-configured server should degrade to a plain tel: link rather than
      render a Call button that cannot work.

   2. Hold the credentials. The SDK authenticates with an OAuth access token,
      and access tokens are short-lived, so it asks for one through a callback.
      That callback fetches from here. The client id, client secret and refresh
      token stay on the server — putting a refresh token in browser JavaScript
      would hand anyone who opens devtools a durable key to the phone system.

   Off unless ZOHO_VOICE_ENABLED=1 and the credentials are present. */

const express = require("express");
const { requireUser } = require("./auth");

const router = express.Router();

const ACCOUNTS = (process.env.ZOHO_ACCOUNTS_DOMAIN || "https://accounts.zoho.com")
  .replace(/\/$/, "");
const CLIENT_ID = process.env.ZOHO_CLIENT_ID || "";
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || "";
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || "";
const ENABLED = process.env.ZOHO_VOICE_ENABLED === "1"
  && !!(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);

if (process.env.ZOHO_VOICE_ENABLED === "1" && !ENABLED) {
  console.warn("[karma] ZOHO_VOICE_ENABLED=1 but ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / "
    + "ZOHO_REFRESH_TOKEN are incomplete — click-to-call stays off and phone numbers "
    + "remain plain tel: links.");
}

/* One cached access token for the whole process. Zoho's expire in about an
   hour; refreshed a minute early so a call is never placed with a token that
   dies mid-handshake. */
let cached = { token: null, expires: 0 };

async function accessToken() {
  if (cached.token && Date.now() < cached.expires) return cached.token;
  const body = new URLSearchParams({
    refresh_token: REFRESH_TOKEN,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  const r = await fetch(`${ACCOUNTS}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    // Zoho reports failures with HTTP 200 and an `error` field, so check both
    const why = data.error || `HTTP ${r.status}`;
    const hint = {
      invalid_client: "client id/secret do not match, or are from another data centre",
      invalid_code: "the refresh token was revoked — rotating the client secret does that; mint a new one",
      invalid_grant: "the refresh token is no longer valid; mint a new one",
    }[data.error];
    throw new Error(hint ? `${why} (${hint})` : why);
  }
  cached = {
    token: data.access_token,
    expires: Date.now() + Math.max(0, (Number(data.expires_in) || 3600) - 60) * 1000,
  };
  return cached.token;
}

/* How a click on a phone number should behave. Three ways to reach the same
   Zoho account, in increasing order of what they demand from us:

     tel  (default) — leave it a plain tel: link. Zoho's ZDialer browser
                      extension and its desktop app both answer tel:, so this
                      is click-to-call with no integration at all, and it is
                      what someone should try FIRST.
     web            — copy the number and open Zoho's dialler in a tab. No
                      credentials, no SDK; one paste per call unless
                      ZOHO_DIAL_URL carries a {number} placeholder.
     sdk            — the in-page softphone (server/voice.js + the WebSDK).
                      Best experience, needs OAuth credentials.

   None of these changes what Zoho charges: the subscription and the per-minute
   credits are the same whichever way the call is placed. They differ only in
   how much of the dialling happens inside Karma Leads. */
/* sdk was briefly forced down to web here, on the theory that the Zoho identity
   behind the API credentials lacked a Voice agent seat. That was wrong: the
   softphone authenticates perfectly well on localhost with the same
   credentials. The difference was the Content-Security-Policy, which
   development does not send and the deploy does — the browser was blocking a
   Zoho host, and the SDK reported that as "Unauthorized access". The policy in
   server.js now covers the Zoho domains properly, so the gate is gone.
   If the SDK still cannot authenticate, app.js drops to web by itself rather
   than leaving a dead widget in front of whoever is trying to call. */
const MODE = ["tel", "web", "sdk"].includes(process.env.ZOHO_DIAL_MODE)
  ? process.env.ZOHO_DIAL_MODE : "tel";
const DIAL_URL = (process.env.ZOHO_DIAL_URL || "https://voice.zoho.com").trim();

/* Leads hold numbers the way people typed them, usually without a country
   code. Zoho dials in international form, so a bare local number gets this
   prefix. Defaults to +1 because the lead base is US and Canada, both of which
   are +1; set ZOHO_DIAL_COUNTRY_CODE for anywhere else, or "" to send the
   digits untouched. */
const COUNTRY_CODE = process.env.ZOHO_DIAL_COUNTRY_CODE === undefined
  ? "+1" : String(process.env.ZOHO_DIAL_COUNTRY_CODE).trim();

router.get("/api/voice/config", requireUser, (req, res) => {
  // sdk falls back to tel when the credentials are not there, rather than
  // rendering a Call button that cannot possibly work
  const mode = MODE === "sdk" && !ENABLED ? "tel" : MODE;
  res.json({ provider: "zoho", mode, enabled: ENABLED, dialUrl: DIAL_URL,
    countryCode: COUNTRY_CODE });
});

/* The SDK's oAuthCallBack fetches this. Signed-in users only: an open endpoint
   would let anyone mint a token against the phone account. */
router.post("/api/voice/token", requireUser, async (req, res) => {
  if (!ENABLED) return res.status(503).json({ error: "Click-to-call is not configured." });
  try {
    res.json({ access_token: await accessToken() });
  } catch (e) {
    /* Pass Zoho's own reason through. "Could not get a token" alone sends
       whoever is debugging into the server logs, and the causes here are
       configuration, not secrets: invalid_client means the id/secret do not
       match, invalid_code means the refresh token was revoked — usually by
       rotating the client secret without minting a new one. The endpoint is
       already behind requireUser, so this is visible to signed-in staff only. */
    console.error("[karma] zoho voice token:", e.message);
    res.status(502).json({
      error: "Could not get a calling token from Zoho.",
      reason: e.message,
      accountsDomain: ACCOUNTS,
      clientIdPrefix: CLIENT_ID.slice(0, 12) + "…",   // enough to spot a wrong or placeholder value
    });
  }
});

module.exports = { router, ENABLED };
