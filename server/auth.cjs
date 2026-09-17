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

// A real bcrypt hash to compare against when an email doesn't exist, so a missing-user
// sign-in takes the same time as a real one (no timing-based account enumeration).
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password-placeholder", 12);

function tokenFor(user) {
  return signJWT({ sub: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name }, JWT_SECRET);
}
function publicUser(u) {
  return { id: u.id, email: u.email, firstName: u.first_name || "", lastName: u.last_name || "", isAdmin: u.is_admin === true || isAdminEmail(u.email) };
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

// Middleware: require a signed-in user; attaches req.userId / req.email / req.user.
async function requireUser(req, res, next) {
  try {
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

// Middleware (after requireUser): admin via the ADMIN_EMAILS list OR the is_admin DB flag.
async function requireAdmin(req, res, next) {
  if (isAdminEmail(req.email)) return next();
  try {
    const { rows } = await q("select is_admin from users where id = $1", [req.userId]);
    if (rows[0] && rows[0].is_admin) return next();
  } catch (e) { /* fall through to 403 */ }
  return res.status(403).json({ error: { message: "Admins only." } });
}

module.exports = { JWT_SECRET, ALLOWED_DOMAIN, DUMMY_HASH, emailAllowed, isAdminEmail, tokenFor, publicUser, baseUrl, requireUser, requireAdmin };
