// Auth layer: JWT helpers, the allowlist + admin checks, and the Express auth middleware.
// Reads auth env at load, so require this AFTER the .env loader.
const bcrypt = require("bcryptjs");
const { signJWT, verifyJWT, JWT_ISS } = require("../api/_proxy.cjs");
const { q } = require("./db.cjs");

const JWT_SECRET = process.env.AUTH_JWT_SECRET || "";

// Registration/sign-in is locked to a single email domain (defaults to karmastaff.com so the
// app is never open to the public). Override with ALLOWED_EMAIL_DOMAIN / ALLOWED_EMAILS.
const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || "karmastaff.com").toLowerCase();
function emailAllowed(email) {
  const e = (email || "").toLowerCase();
  const allowEmails = (process.env.ALLOWED_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  if (allowEmails.length) return allowEmails.includes(e);
  return !ALLOWED_DOMAIN || e.endsWith("@" + ALLOWED_DOMAIN);
}

// Admins (config list). Recomputed per request so the list can change without re-login.
function isAdminEmail(email) {
  const e = (email || "").toLowerCase();
  const admins = (process.env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  return admins.includes(e);
}

/* The owner tier, above admin. Mirrors leads/server/auth.js — see the long
   note there for why it is ranked and why it lives in the environment rather
   than the users table.

   Short version: an admin runs the day (approvals, engines, the team screen),
   an owner holds the things that change who has access or cannot be undone
   (appointing admins, deleting accounts). Keeping the top tier out of the
   database means it survives a row being wrong and cannot be granted from
   inside the app — which is exactly what went wrong with the admin code this
   replaced, where anyone who learned one string could promote themselves. */
function isOwnerEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  const owners = (process.env.OWNER_EMAILS ?? "tenzinwoesel@karmastaff.com")
    .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  return owners.includes(e);
}

// A real bcrypt hash to compare against when an email doesn't exist, so a missing-user
// sign-in takes the same time as a real one (no timing-based account enumeration).
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password-placeholder", 12);

function tokenFor(user) {
  return signJWT({ sub: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name }, JWT_SECRET);
}
function publicUser(u) {
  // an owner outranks an admin, so they are one too — nothing downstream has
  // to know about the tier to keep working
  const owner = isOwnerEmail(u.email);
  return { id: u.id, email: u.email, firstName: u.first_name || "", lastName: u.last_name || "", isAdmin: u.is_admin === true || isAdminEmail(u.email) || owner, isOwner: owner };
}

// Public base URL for links in emails. Prefer APP_URL; otherwise derive from the request.
function baseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http")).split(",")[0];
  return proto + "://" + req.headers.host;
}

// ── The session both Karma products read ───────────────────────────────────
// Identity comes from our OWN sign-in (server/session.cjs): a signed JWT in an
// httpOnly cookie, set when someone signs in with their email and password.
// Karma Leads reads the same cookie, so one sign-in covers both — without
// depending on an outside identity provider nobody here can administer.
const session = require("./session.cjs");

/* DEV ONLY: the same bypass Karma Leads has, so one setting covers the whole
   site. Before the sign-in moved here it lived only in Leads, which meant
   local development suddenly demanded a password from Karma Connect that it
   never used to. Guarded identically — not production, set deliberately, and
   loopback only — so it cannot be reached on a deploy. */
const DEV_AUTH_EMAIL = (process.env.DEV_AUTH_EMAIL || "").trim().toLowerCase();
const DEV_BYPASS = !!DEV_AUTH_EMAIL && process.env.NODE_ENV !== "production";
const isLoopback = (req) => {
  const ip = String((req && (req.ip || (req.socket && req.socket.remoteAddress))) || "");
  return ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1";
};

// Middleware: require a signed-in user; attaches req.userId / req.email / req.user.
async function requireUser(req, res, next) {
  try {
    if (DEV_BYPASS && isLoopback(req)) {
      /* Use the real row when there is a database to read it from, so ids and
         history stay real; fall back to a synthetic one when Karma Connect has
         no database configured, so the app still runs. */
      let user = null;
      try {
        const { rows } = await q("select * from users where email = $1", [DEV_AUTH_EMAIL]);
        user = rows[0] || null;
      } catch (e) { /* no database — synthesise below */ }
      req.userId = user ? user.id : "00000000-0000-0000-0000-00000000dev0";
      req.email = DEV_AUTH_EMAIL;
      req.user = user || { id: req.userId, email: DEV_AUTH_EMAIL, first_name: "Dev", last_name: "", is_admin: true };
      return next();
    }
    const claims = session.readSession(req);
    if (!claims) return res.status(401).json({ error: { message: "Please sign in." } });
    const { rows } = await q("select * from users where id = $1", [claims.id]);
    const user = rows[0];
    /* A valid cookie for an account that no longer exists: clear it, so the
       browser stops presenting a credential nothing can honour. */
    if (!user) {
      session.clearSession(res);
      return res.status(401).json({ error: { message: "Please sign in again." } });
    }
    if (!emailAllowed(user.email)) {
      return res.status(403).json({ error: { message: "This account is not allowed to use Karma Connect." } });
    }
    req.userId = user.id;
    req.email = user.email;
    req.user = user;
    next();
  } catch (e) {
    console.error("auth: could not read the session —", e.message);
    return res.status(503).json({ error: { message: "Sign-in is temporarily unavailable." } });
  }
}

// Middleware (after requireUser): the owner-only gate. Appointing admins and
// deleting accounts sit here — the two actions that change who has access.
function requireOwner(req, res, next) {
  if (isOwnerEmail(req.email)) return next();
  return res.status(403).json({ error: { message: "Owner only — this changes who has access, or cannot be undone." } });
}

// Middleware (after requireUser): admin via the ADMIN_EMAILS list OR the is_admin DB flag.
async function requireAdmin(req, res, next) {
  if (isOwnerEmail(req.email) || isAdminEmail(req.email)) return next();
  try {
    const { rows } = await q("select is_admin from users where id = $1", [req.userId]);
    if (rows[0] && rows[0].is_admin) return next();
  } catch (e) { /* fall through to 403 */ }
  return res.status(403).json({ error: { message: "Admins only." } });
}

module.exports = { JWT_SECRET, ALLOWED_DOMAIN, DUMMY_HASH, emailAllowed, isAdminEmail, isOwnerEmail, tokenFor, publicUser, baseUrl, requireUser, requireAdmin, requireOwner };
