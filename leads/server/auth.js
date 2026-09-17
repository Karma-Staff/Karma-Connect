"use strict";
/* Who is calling the domain API.

   One way in: WORKOS — a sealed AuthKit session in the `kl_session` cookie.
   Sign-in happens on WorkOS's hosted page — we store no passwords, run no
   reset flows, and validate the sealed session locally (it's an encrypted
   cookie; no network call except a refresh when it expires). Being able to
   sign in is NOT being invited: the email must exist in app_users, which the
   domain API owns. WorkOS's stable user id lands on app_users.oidc_sub at
   first login. (The NocoDB xc-auth adapter that bridged the migration was
   retired 2026-08-11.)

   Authorization comes from app_users + organization_memberships —
   'admin' | 'member' — never from the identity provider. */

const { query, tx } = require("./db");

/* Where a completed sign-in lands. "/" when Leads runs on its own (and is
   mirrored at /app); "/leads/" on the merged Karma site, where "/" is Karma
   Connect and redirecting there would drop the user in the wrong product.
   server/index.js mount() sets it to match where it served the app. */
let APP_URL = process.env.LEADS_APP_PATH || "/";
const setAppPath = (p) => { APP_URL = p; };

/* Anyone signing in through WorkOS with this email domain is enrolled as a
   MEMBER on first sign-in — no manual invite. Admin stays a deliberate act
   (the Users tab, or cli.js user:add ... admin). Explicitly disabled accounts
   stay locked out. Set AUTO_INVITE_DOMAIN="" to turn auto-enrolment off. */
const AUTO_INVITE_DOMAIN =
  (process.env.AUTO_INVITE_DOMAIN ?? "karmastaff.com").trim().toLowerCase();
const COOKIE = "kl_session";

/* ---------------- WorkOS ---------------- */
const WORKOS_ON = !!(process.env.WORKOS_API_KEY && process.env.WORKOS_CLIENT_ID
  && process.env.SESSION_SECRET && process.env.WORKOS_REDIRECT_URI);
let workos = null;
if (WORKOS_ON) {
  const { WorkOS } = require("@workos-inc/node");
  workos = new WorkOS(process.env.WORKOS_API_KEY,
    { clientId: process.env.WORKOS_CLIENT_ID });
} else {
  console.warn("[karma] WorkOS env incomplete — nobody can sign in (set "
    + "WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_REDIRECT_URI, SESSION_SECRET)");
}
const PASSWORD = process.env.SESSION_SECRET;

/* ---------------- DEV ONLY: sign-in bypass ----------------
   Set DEV_AUTH_EMAIL=you@karmastaff.com to treat every request as that person,
   so both products can be clicked through locally without a WorkOS round trip.

   Three things keep this out of production, and all three must hold:
     1. NODE_ENV must not be "production" — Render's blueprint sets exactly that,
        so the bypass cannot even be switched on there.
     2. DEV_AUTH_EMAIL must be set deliberately. There is no default.
     3. The request must come from loopback. A bound-to-0.0.0.0 dev server on a
        café network does not hand the app to the next table.

   The email is resolved through the normal userByEmail path, so ids, roles and
   ownership stay real — this skips the sign-in, not the authorization. */
const DEV_AUTH_EMAIL = (process.env.DEV_AUTH_EMAIL || "").trim().toLowerCase();
const DEV_BYPASS = !!DEV_AUTH_EMAIL && process.env.NODE_ENV !== "production";
/* DEV_AUTH_ROLE=member forces the bypassed session to a member, so the
   salesperson's view can be checked without a second account. Admin-only
   surfaces are presentation; the real control is the API's 403s, and this
   exercises both. Only meaningful while the bypass is active. */
const DEV_AUTH_ROLE = ["admin", "member"].includes(process.env.DEV_AUTH_ROLE)
  ? process.env.DEV_AUTH_ROLE : null;
if (DEV_AUTH_EMAIL && !DEV_BYPASS) {
  console.error("[karma] DEV_AUTH_EMAIL IGNORED — NODE_ENV=production. Sign-in stays required.");
} else if (DEV_BYPASS) {
  console.warn("┌─────────────────────────────────────────────────────────────┐");
  console.warn("│ SIGN-IN BYPASSED — every local request is treated as        │");
  console.warn(`│ ${DEV_AUTH_EMAIL.padEnd(59)}│`);
  console.warn("│ Development only. Never set DEV_AUTH_EMAIL on a deploy.     │");
  console.warn("└─────────────────────────────────────────────────────────────┘");
}
const isLoopback = (req) => {
  const ip = String((req && (req.ip || (req.socket && req.socket.remoteAddress))) || "");
  return ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1";
};

function getCookie(req, name) {
  for (const part of (req.get("cookie") || "").split(/; */)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name)
      return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

/* Secure on hosted HTTPS (Render sets RENDER; compose-prod sets NODE_ENV),
   omitted in dev so the cookie still works on plain http://localhost */
const SECURE = (process.env.RENDER || process.env.NODE_ENV === "production")
  ? "; Secure" : "";

function setSession(res, sealed) {
  res.append("Set-Cookie",
    `${COOKIE}=${encodeURIComponent(sealed)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=34560000${SECURE}`);
}
const clearSession = (res) => res.append("Set-Cookie",
  `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE}`);

/* the sealed cookie -> a WorkOS user, refreshing (and re-setting the cookie)
   when the access token inside has expired. null = not signed in this way. */
async function workosUser(req, res) {
  const sealed = getCookie(req, COOKIE);
  if (!workos || !sealed) return null;
  try {
    let session = workos.userManagement.loadSealedSession(
      { sessionData: sealed, cookiePassword: PASSWORD });
    let auth = await session.authenticate();
    if (!auth.authenticated) {
      const r = await session.refresh({ cookiePassword: PASSWORD });
      if (!r.authenticated || !r.sealedSession) return null;
      if (res) setSession(res, r.sealedSession);
      session = workos.userManagement.loadSealedSession(
        { sessionData: r.sealedSession, cookiePassword: PASSWORD });
      auth = await session.authenticate();
      if (!auth.authenticated) return null;
    }
    return auth.user || null;
  } catch { return null; }
}

/* ---------------- shared ---------------- */
async function userByEmail(email) {
  const r = await query(
    `SELECT u.id, u.email, u.display_name, m.role
     FROM app_users u
     LEFT JOIN organization_memberships m ON m.user_id = u.id
     WHERE u.email = $1 AND NOT u.disabled`, [email]);
  return r.rows[0] || null;
}

/* First sign-in from the company domain: enrol as member. Returns the new
   user row, or null when the email doesn't qualify — including when an
   app_users row already exists (then it's either enabled, and userByEmail
   found it, or deliberately disabled, and it must stay locked out). */
async function autoInvite(email, name) {
  if (!AUTO_INVITE_DOMAIN || !email.endsWith("@" + AUTO_INVITE_DOMAIN))
    return null;
  return tx(async (client) => {
    const existing = (await client.query(
      "SELECT id FROM app_users WHERE email = $1", [email])).rows[0];
    if (existing) return null;                    // disabled — not our call
    const u = (await client.query(
      `INSERT INTO app_users (email, display_name) VALUES ($1, $2)
       RETURNING id, email, display_name`, [email, name || null])).rows[0];
    const org = (await client.query(
      "SELECT id FROM organizations ORDER BY id LIMIT 1")).rows[0];
    await client.query(
      `INSERT INTO organization_memberships (org_id, user_id, role)
       VALUES ($1, $2, 'member')`, [org.id, u.id]);
    return { ...u, role: "member" };
  });
}

/* resolve the caller, or null. {id: null} = authenticated but not invited. */
async function resolve(req, res) {
  let email = null;
  let wu = null;
  if (DEV_BYPASS && isLoopback(req)) {
    // stand in for the WorkOS session; everything below is unchanged
    email = DEV_AUTH_EMAIL;
  } else {
    wu = await workosUser(req, res);
    if (wu) email = String(wu.email || "").trim().toLowerCase();
  }
  if (!email) return null;
  let u;
  try {
    u = await userByEmail(email);
  } catch (e) {
    /* No reachable database. In production that is a real fault and must
       surface. Under the dev bypass it usually just means LEADS_DATABASE_URL
       is not set yet, so hand back a synthetic admin: the UI renders and can
       be clicked through, and the individual data panels fail on their own
       terms rather than the whole app collapsing into a 503. */
    if (!DEV_BYPASS) throw e;
    console.warn("[karma] dev bypass: no database (" + e.message
      + ") — using a synthetic admin so the UI still renders");
    // -1, not 0: requireUser rejects a falsy id, and 0 would fail the very
    // check this synthetic user exists to pass.
    return { id: -1, email, name: email.split("@")[0],
      role: DEV_AUTH_ROLE || "admin" };
  }
  /* Auto-enrol here as well as in the callback. One sign-in now covers both
     Karma products, so somebody can arrive holding a perfectly valid session
     that was minted before they had a Leads row — signed in through Connect,
     or invited after their session began. Without this they would land on a
     403 dead end with no way to fix it but signing out. Same rule as the
     callback: AUTO_INVITE_DOMAIN walks in as a member, nobody else. */
  if (!u) {
    const name = wu ? ([wu.firstName, wu.lastName].filter(Boolean).join(" ") || null) : null;
    u = await autoInvite(email, name);
  }
  if (!u) return { email, id: null, role: null };
  return { id: u.id, email: u.email, name: u.display_name,
    role: (DEV_BYPASS && DEV_AUTH_ROLE) || u.role || "member" };
}

function requireUser(req, res, next) {
  resolve(req, res).then((user) => {
    if (!user) return res.status(401).json({ error: "Not signed in" });
    if (!user.id) return res.status(403).json({
      error: `${user.email} is not invited to Karma Leads — ask your manager.` });
    req.user = user;
    next();
  }).catch(next);
}

function requireAdmin(req, res, next) {
  requireUser(req, res, () => {
    if (req.user.role !== "admin")
      return res.status(403).json({ error: "Admins only — ask your manager." });
    next();
  });
}

/* Where sign-in returns to. Karma Connect and Karma Leads share this one
   sign-in, so the caller says which product it started from and the callback
   sends them back there.

   Only a same-site absolute path is accepted — never "//evil.com" and never a
   full URL — so `next` cannot be turned into an open redirect. */
function safeNext(v) {
  const s = String(v || "");
  if (!s.startsWith("/") || s.startsWith("//")) return APP_URL;
  return s;
}

/* ---------------- routes (mounted by index.js) ---------------- */
function mountAuthRoutes(app) {
  if (WORKOS_ON) {
    app.get("/api/auth/login", (req, res) => {
      res.redirect(workos.userManagement.getAuthorizationUrl({
        provider: "authkit",
        clientId: process.env.WORKOS_CLIENT_ID,
        redirectUri: process.env.WORKOS_REDIRECT_URI,
        // carried through WorkOS untouched and handed back to the callback
        state: safeNext(req.query.next),
      }));
    });

    app.get("/api/auth/callback", async (req, res) => {
      const dest = safeNext(req.query.state);
      const back = (msg) =>
        res.redirect(`${dest}${dest.includes("?") ? "&" : "?"}authError=${encodeURIComponent(msg)}`);
      try {
        const code = String(req.query.code || "");
        if (!code) return back(String(req.query.error_description ||
          req.query.error || "sign-in was cancelled"));
        const out = await workos.userManagement.authenticateWithCode({
          clientId: process.env.WORKOS_CLIENT_ID,
          code,
          session: { sealSession: true, cookiePassword: PASSWORD },
        });
        const email = String(out.user?.email || "").trim().toLowerCase();
        const name = [out.user.firstName, out.user.lastName]
          .filter(Boolean).join(" ") || null;
        let u = await userByEmail(email);
        if (!u) u = await autoInvite(email, name);  // @karmastaff.com walks in as member
        /* Authenticated but not invited to Leads is NO LONGER a refusal. This
           sign-in is shared with Karma Connect, and clearing the session here
           would lock someone out of Connect for the unrelated reason that they
           have no Leads row. Authentication is shared; AUTHORIZATION stays with
           each product — Leads' requireUser still 403s this person, Connect
           still applies its own allowlist. */
        if (u) {
          // remember the provider's stable id and a display name, once known
          await query(
            `UPDATE app_users SET oidc_sub = $1,
               display_name = COALESCE(display_name, $2) WHERE id = $3`,
            [out.user.id, name, u.id]);
        }
        setSession(res, out.sealedSession);
        res.redirect(dest);
      } catch (e) {
        console.error("[karma] auth callback failed:", e.message);
        back("sign-in failed — try again");
      }
    });

    app.post("/api/auth/logout", async (req, res) => {
      // ?next= so signing out of Connect doesn't drop you on Leads, and vice versa
      let url = safeNext(req.query.next);
      try {
        const sealed = getCookie(req, COOKIE);
        if (sealed) {
          const session = workos.userManagement.loadSealedSession(
            { sessionData: sealed, cookiePassword: PASSWORD });
          url = await session.getLogoutUrl();   // revokes the WorkOS session too
        }
      } catch { /* fall back to a plain local sign-out */ }
      clearSession(res);
      res.json({ url });
    });
  } else {
    /* WorkOS is not configured, so none of the routes above exist. Without
       these stand-ins the Sign in button leads to a bare "Cannot GET
       /api/auth/login", which says nothing about the actual problem — a
       missing environment variable. Answer every sign-in route with what is
       wrong instead; this is the shared sign-in for both products, so a
       missed env var on a deploy would otherwise present as a broken page. */
    const missing = () => ["WORKOS_API_KEY", "WORKOS_CLIENT_ID",
      "WORKOS_REDIRECT_URI", "SESSION_SECRET"].filter((k) => !process.env[k]);
    const explain = (req, res) => {
      const detail = `Sign-in is not configured on this server — missing ${missing().join(", ")}.`;
      console.error("[karma]", req.method, req.originalUrl, "->", detail);
      if (req.method === "GET" && !req.xhr) {
        // a browser followed a link here: say it in the page, not as JSON
        res.status(503).type("html").send(
          `<!doctype html><meta charset="utf-8"><title>Sign-in unavailable</title>` +
          `<body style="font:14px/1.6 system-ui;background:#081224;color:#eef2fb;padding:48px">` +
          `<h1 style="font-size:19px;margin:0 0 10px">Sign-in is not configured</h1>` +
          `<p style="color:#9aa7c4;margin:0 0 6px">This server is missing: <b>${missing().join(", ")}</b></p>` +
          `<p style="color:#9aa7c4;margin:0">Set them and restart, then try again.</p></body>`);
      } else {
        res.status(503).json({ error: detail });
      }
    };
    app.get("/api/auth/login", explain);
    app.get("/api/auth/callback", explain);
    app.post("/api/auth/logout", (req, res) => { clearSession(res); res.json({ url: "/" }); });
  }
}

module.exports = { requireUser, requireAdmin, resolve, mountAuthRoutes,
  autoInvite, WORKOS_ON, setAppPath };
