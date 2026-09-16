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

// ── Single sign-on ──────────────────────────────────────────────────────────
// Identity is the WorkOS session both Karma products share (sealed into the
// kl_session cookie by leads/server/auth.js). Karma Connect no longer mints or
// verifies its own tokens; it maps the email on that session to a row in its
// OWN users table, because every query here is keyed by users.id.
//
// Required lazily: leads/server/db.js throws at require time when its database
// is unconfigured, and that must not stop Karma Connect from booting.
function leadsAuth() {
  return require("../leads/server/auth.js");
}

// The Connect-side user for an SSO identity, created on first sign-in so people
// who have only ever used Leads get a Connect account the moment they open it.
// Matching is by EMAIL, which is what keeps existing Connect history attached to
// the right person after the cutover from passwords.
async function connectUserFor(email, name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  const first = parts.shift() || "";
  const last = parts.join(" ");
  // password_hash is NOT NULL and passwords are retired, so store a sentinel
  // that no bcrypt compare can ever match.
  const { rows } = await q(
    `insert into users (email, password_hash, first_name, last_name)
          values ($1, '!sso', $2, $3)
     on conflict (email) do update
        set first_name = case when users.first_name = '' then excluded.first_name else users.first_name end,
            last_name  = case when users.last_name  = '' then excluded.last_name  else users.last_name  end
      returning id, email, first_name, last_name, is_admin`,
    [email, first, last],
  );
  return rows[0];
}

// Middleware: require a signed-in user; attaches req.userId / req.email / req.user.
async function requireUser(req, res, next) {
  try {
    const session = await leadsAuth().resolve(req, res);
    if (!session || !session.email) return res.status(401).json({ error: { message: "Please sign in." } });
    if (!emailAllowed(session.email)) {
      return res.status(403).json({ error: { message: "This account is not allowed to use Karma Connect." } });
    }
    const user = await connectUserFor(session.email, session.name);
    req.userId = user.id;
    req.email = user.email;
    req.user = user;
    next();
  } catch (e) {
    console.error("auth: could not resolve the session —", e.message);
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
