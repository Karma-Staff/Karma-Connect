// Karma Connect backend — a single always-on Node server for Render.
// Serves the built SPA (dist/) and the JSON API:
//   POST /api/auth/signup · POST /api/auth/signin · GET /api/auth/me
//   GET/POST /api/history · DELETE /api/history/:id · GET /api/usage
//   POST /api/claude  (Anthropic proxy — shared core in api/_proxy.cjs)
//
// Storage is Render Postgres (pg). Auth is our own email+password with an HS256 JWT
// (minted by signJWT, verified by verifyJWT — same code the proxy uses). There is NO
// row-level security: every query is scoped to the user_id taken from the verified token.
//
// Run: `node server.js` (prod) or `node server.js --dev` (skip static + open Claude proxy
// to localhost without a login, matching the old Vite dev middleware).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");
const compression = require("compression");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const { handleClaude, signJWT, verifyJWT, JWT_ISS } = require("./api/_proxy.cjs");

// ── Minimal .env loader (only for local dev; Render injects real env vars) ──
(function loadDotenv() {
  try {
    const file = path.join(__dirname, ".env");
    if (!fs.existsSync(file)) return;
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch (e) { /* ignore */ }
})();

const DEV = process.argv.includes("--dev") || process.env.NODE_ENV === "development";
const PORT = parseInt(process.env.PORT || (DEV ? "8787" : "3000"), 10);
const JWT_SECRET = process.env.AUTH_JWT_SECRET || "";
const EMAIL_RE = /\S+@\S+\.\S+/;

// ── Postgres ──
const DATABASE_URL = process.env.DATABASE_URL || "";
// Render Postgres requires SSL; local Postgres usually doesn't (set PGSSL=off).
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: false },
      // Bound the pool so we never exhaust the database's connection limit (per instance).
      max: parseInt(process.env.PG_POOL_MAX || "10", 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      keepAlive: true,
    })
  : null;
// A dropped idle connection emits 'error' on the pool — handle it so it can't crash the process.
if (pool) pool.on("error", (e) => console.error("pg pool error:", e.message));
const dbOn = !!pool;

async function q(text, params) {
  if (!dbOn) throw new Error("Database not configured (DATABASE_URL missing).");
  return pool.query(text, params);
}

// Apply newer idempotent columns at boot so the live DB stays current without a manual
// `npm run db:init` after each deploy. Safe to run every start (add column if not exists).
async function ensureSchema() {
  if (!dbOn) return;
  try {
    await q("alter table users add column if not exists reset_token text");
    await q("alter table users add column if not exists reset_sent_at timestamptz");
    await q("create index if not exists users_reset_token_idx on users (reset_token)");
    await q("alter table prospects add column if not exists status text not null default 'new'");
  } catch (e) { console.error("ensureSchema:", e.message); }
}

// ── Allowlist (mirrors the proxy) — optional lock-down to a domain / exact emails ──
// Registration/sign-in is locked to a single email domain. Defaults to karmastaff.com
// so the app is never open to the public even if the env var is unset; override with
// ALLOWED_EMAIL_DOMAIN (or pin exact addresses with ALLOWED_EMAILS).
const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || "karmastaff.com").toLowerCase();
function emailAllowed(email) {
  const e = (email || "").toLowerCase();
  const allowEmails = (process.env.ALLOWED_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  if (allowEmails.length) return allowEmails.includes(e);
  return !ALLOWED_DOMAIN || e.endsWith("@" + ALLOWED_DOMAIN);
}

// Admins can approve leads for the locked engines. Set ADMIN_EMAILS (comma-separated)
// in the server env. Recomputed from email on every request, so the list can change
// without users needing to log in again.
function isAdminEmail(email) {
  const e = (email || "").toLowerCase();
  const admins = (process.env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  return admins.includes(e);
}

// ── Email verification via Resend (optional, env-gated) ──
// If RESEND_API_KEY is set, new signups must confirm their email before they can sign in.
// If it's not configured (e.g. local dev), users are created already-verified (no friction).
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "Karma Connect <noreply@karmastaff.com>";
const emailVerifyOn = !!RESEND_API_KEY;
const VERIFY_TTL_HOURS = 24;
const RESET_TTL_HOURS = 1; // password-reset links expire fast

// Public base URL for links in emails. Prefer APP_URL; otherwise derive from the request
// (honours Render's x-forwarded-proto so links are https in production).
function baseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http")).split(",")[0];
  return proto + "://" + req.headers.host;
}

async function sendVerificationEmail(email, firstName, link) {
  const hi = firstName ? "Hi " + escapeHtml(firstName) + "," : "Hi,";
  const html = `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0b2545">
    <h2 style="color:#0b2545">Confirm your email</h2>
    <p>${hi}</p>
    <p>Thanks for creating a Karma Connect account. Please confirm this email address to activate your login.</p>
    <p style="margin:28px 0">
      <a href="${link}" style="background:#E7B74B;color:#071226;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;display:inline-block">Confirm my email</a>
    </p>
    <p style="font-size:12px;color:#667">Or paste this link into your browser:<br><a href="${link}">${link}</a></p>
    <p style="font-size:12px;color:#667">This link expires in ${VERIFY_TTL_HOURS} hours. If you didn't create this account, you can ignore this email.</p>
  </div>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: RESEND_FROM, to: [email], subject: "Confirm your email for Karma Connect", html }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("Resend " + r.status + ": " + t); }
}

async function sendResetEmail(email, firstName, link) {
  const hi = firstName ? "Hi " + escapeHtml(firstName) + "," : "Hi,";
  const html = `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0b2545">
    <h2 style="color:#0b2545">Reset your password</h2>
    <p>${hi}</p>
    <p>We received a request to reset your Karma Connect password. Click below to choose a new one.</p>
    <p style="margin:28px 0">
      <a href="${link}" style="background:#E7B74B;color:#071226;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;display:inline-block">Set a new password</a>
    </p>
    <p style="font-size:12px;color:#667">Or paste this link into your browser:<br><a href="${link}">${link}</a></p>
    <p style="font-size:12px;color:#667">This link expires in ${RESET_TTL_HOURS} hour. If you didn't request this, you can safely ignore this email — your password won't change.</p>
  </div>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: RESEND_FROM, to: [email], subject: "Reset your Karma Connect password", html }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("Resend " + r.status + ": " + t); }
}

const app = express();
app.disable("x-powered-by");
// Behind Render's proxy: trust it so req.ip is the real client IP and req.secure is correct.
app.set("trust proxy", 1);
// gzip every response above the threshold (the JS/CSS bundle + JSON API) — big bandwidth win.
app.use(compression());

// ── HTTP security headers (L4) ──
// CSP allows our own assets + Google Fonts (index.html links them) and inline styles (the app
// injects a <style> block and uses style attributes). HSTS/CSP only in prod; in dev Vite serves
// the HTML (this server only handles /api there), so HMR is unaffected.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "connect-src 'self'",
].join("; ");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (!DEV) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader("Content-Security-Policy", CSP);
  }
  next();
});

// /api/claude needs the RAW body string (the proxy parses + forwards it verbatim).
app.use("/api/claude", express.text({ type: () => true, limit: "4mb" }));
// Everything else is JSON.
app.use(express.json({ limit: "2mb" }));

// ── Lightweight in-memory rate limiter for the auth endpoints (M2) ──
// Single-instance friendly (one Render dyno). Throttles online password brute-force and
// signup/resend abuse (which would otherwise spam Resend). Runs after express.json, so
// req.body is available to the key function.
const rlStore = new Map(); // key -> { count, resetAt }
function rateLimit({ windowMs, max, keyFn, message }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = keyFn(req);
    let e = rlStore.get(key);
    if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + windowMs }; rlStore.set(key, e); }
    e.count++;
    if (e.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((e.resetAt - now) / 1000)));
      return res.status(429).json({ error: { message: message || "Too many requests. Please slow down and try again shortly." } });
    }
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, e] of rlStore) if (now > e.resetAt) rlStore.delete(k); }, 60000).unref();

const reqEmail = (req) => String((req.body && req.body.email) || "").toLowerCase();
const signinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 12, message: "Too many sign-in attempts. Please wait a few minutes and try again.", keyFn: (req) => "signin:" + req.ip + ":" + reqEmail(req) });
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 8, message: "Too many sign-up attempts from this network. Please try again later.", keyFn: (req) => "signup:" + req.ip });
const resendLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 6, message: "Too many requests. Please try again later.", keyFn: (req) => "resend:" + req.ip + ":" + reqEmail(req) });
const forgotLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 6, message: "Too many reset requests. Please try again later.", keyFn: (req) => "forgot:" + req.ip + ":" + reqEmail(req) });
const resetLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 15, message: "Too many attempts. Please try again later.", keyFn: (req) => "reset:" + req.ip });
const promoteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, message: "Too many attempts. Please wait a few minutes and try again.", keyFn: (req) => "promote:" + (req.userId || req.ip) });

// A real bcrypt hash to compare against when the email doesn't exist, so a missing-user
// sign-in takes the same time as a real one (no timing-based account enumeration — L3).
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password-placeholder", 12);

// Escape user-supplied text before embedding it in email HTML (L5).
function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── Auth helpers ──
function tokenFor(user) {
  return signJWT({ sub: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name }, JWT_SECRET);
}
function publicUser(u) {
  return { id: u.id, email: u.email, firstName: u.first_name || "", lastName: u.last_name || "", isAdmin: u.is_admin === true || isAdminEmail(u.email) };
}
// Express middleware: require a valid login token; attaches req.userId / req.email.
function requireUser(req, res, next) {
  if (!JWT_SECRET) return res.status(500).json({ error: { message: "Server not configured (missing AUTH_JWT_SECRET)." } });
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const claims = token ? verifyJWT(token, JWT_SECRET, JWT_ISS) : null;
  if (!claims || !claims.sub) return res.status(401).json({ error: { message: "Please sign in again." } });
  req.userId = claims.sub;
  req.email = claims.email || "";
  next();
}
// Require an admin (for approving leads). Runs after requireUser. Admin = on the ADMIN_EMAILS
// config list, OR flagged is_admin in the DB (granted via the admin signup code).
async function requireAdmin(req, res, next) {
  if (isAdminEmail(req.email)) return next();
  try {
    const { rows } = await q("select is_admin from users where id = $1", [req.userId]);
    if (rows[0] && rows[0].is_admin) return next();
  } catch (e) { /* fall through to 403 */ }
  return res.status(403).json({ error: { message: "Admins only." } });
}

// ─────────────────────────────── Auth ───────────────────────────────
app.post("/api/auth/signup", signupLimiter, async (req, res) => {
  try {
    if (!JWT_SECRET) return res.status(500).json({ error: { message: "Server not configured (missing AUTH_JWT_SECRET)." } });
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const firstName = String(req.body?.firstName || "").trim();
    const lastName = String(req.body?.lastName || "").trim();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: { message: "Enter a valid email address." } });
    if (password.length < 8) return res.status(400).json({ error: { message: "Use a password of at least 8 characters." } });
    if (!emailAllowed(email)) return res.status(403).json({ error: { message: "Registration is limited to @" + ALLOWED_DOMAIN + " email addresses." } });

    // Optional admin signup code. Empty = normal member. Non-empty must match ADMIN_SIGNUP_CODE,
    // otherwise reject so the person knows the code was wrong (rather than silently demoting them).
    const adminCode = String(req.body?.adminCode || "");
    let wantsAdmin = false;
    if (adminCode) {
      const expected = process.env.ADMIN_SIGNUP_CODE || "";
      if (!expected || adminCode !== expected) return res.status(403).json({ error: { message: "Invalid admin code." } });
      wantsAdmin = true;
    }

    const exists = await q("select 1 from users where email = $1", [email]);
    if (exists.rowCount) return res.status(409).json({ error: { message: "An account with that email already exists. Sign in instead." } });

    const hash = await bcrypt.hash(password, 12);
    // When email verification is on, create the user unverified with a one-time token.
    // When it's off (no Resend key), create them already-verified and log them straight in.
    const token = emailVerifyOn ? crypto.randomBytes(32).toString("hex") : null;
    const { rows } = await q(
      `insert into users (email, password_hash, first_name, last_name, email_verified, verify_token, verify_sent_at, is_admin)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [email, hash, firstName, lastName, !emailVerifyOn, token, token ? new Date() : null, wantsAdmin],
    );
    const user = rows[0];

    if (emailVerifyOn) {
      try {
        await sendVerificationEmail(email, firstName, baseUrl(req) + "/api/auth/verify?token=" + token);
      } catch (e) {
        // Don't leave a stuck account if the email fails — remove it so they can retry.
        await q("delete from users where id = $1", [user.id]).catch(() => {});
        return res.status(502).json({ error: { message: "Could not send the confirmation email. Please try again in a moment." } });
      }
      return res.json({ needsVerification: true, email, message: "Account created. Check your email for a confirmation link, then sign in." });
    }
    res.json({ token: tokenFor(user), user: publicUser(user) });
  } catch (e) { console.error("signup error:", (e && e.stack) || e); res.status(500).json({ error: { message: "Could not create the account. Try again." } }); }
});

app.post("/api/auth/signin", signinLimiter, async (req, res) => {
  try {
    if (!JWT_SECRET) return res.status(500).json({ error: { message: "Server not configured (missing AUTH_JWT_SECRET)." } });
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!EMAIL_RE.test(email) || !password) return res.status(400).json({ error: { message: "Enter your email and password." } });
    if (!emailAllowed(email)) return res.status(403).json({ error: { message: "This email is not allowed to use Karma Connect." } });

    const { rows } = await q("select * from users where email = $1", [email]);
    const user = rows[0];
    // Compare even when the user is missing (timing-safe-ish: avoid leaking which emails exist).
    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) return res.status(401).json({ error: { message: "Wrong email or password." } });
    if (emailVerifyOn && !user.email_verified) {
      return res.status(403).json({ error: { message: "Please confirm your email first — check your inbox for the link.", needsVerification: true } });
    }
    res.json({ token: tokenFor(user), user: publicUser(user) });
  } catch (e) { res.status(500).json({ error: { message: "Could not sign in. Try again." } }); }
});

// Click target from the confirmation email. Marks the user verified, then redirects to the
// app with ?verified=1 (or ?verified=0 on a bad/expired token) so the UI can show a notice.
app.get("/api/auth/verify", async (req, res) => {
  const home = baseUrl(req);
  try {
    const token = String(req.query.token || "");
    if (!token) return res.redirect(home + "/?verified=0");
    const { rows } = await q(
      `update users set email_verified = true, verify_token = null
       where verify_token = $1 and verify_sent_at > now() - interval '${VERIFY_TTL_HOURS} hours'
       returning id`,
      [token],
    );
    return res.redirect(home + (rows.length ? "/?verified=1" : "/?verified=0"));
  } catch (e) { return res.redirect(home + "/?verified=0"); }
});

// Re-send the confirmation email for an unverified account. Always replies the same way
// (don't reveal whether the email exists).
app.post("/api/auth/resend", resendLimiter, async (req, res) => {
  const done = () => res.json({ ok: true, message: "If that account exists and is unconfirmed, a new confirmation email is on its way." });
  try {
    if (!emailVerifyOn) return done();
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return done();
    const { rows } = await q("select id, first_name, email_verified from users where email = $1", [email]);
    const user = rows[0];
    if (!user || user.email_verified) return done();
    const token = crypto.randomBytes(32).toString("hex");
    await q("update users set verify_token = $1, verify_sent_at = now() where id = $2", [token, user.id]);
    await sendVerificationEmail(email, user.first_name, baseUrl(req) + "/api/auth/verify?token=" + token).catch(() => {});
    return done();
  } catch (e) { return done(); }
});

// Request a password reset. Always replies the same way (don't reveal whether the email
// exists). Sends a one-time reset link via Resend when the account is found.
app.post("/api/auth/forgot", forgotLimiter, async (req, res) => {
  const done = () => res.json({ ok: true, message: "If an account exists for that email, a password reset link is on its way." });
  try {
    if (!emailVerifyOn) return res.status(503).json({ error: { message: "Password reset isn't available — email isn't configured. Contact your administrator." } });
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email) || !emailAllowed(email)) return done();
    const { rows } = await q("select id, first_name from users where email = $1", [email]);
    const user = rows[0];
    if (!user) return done();
    const token = crypto.randomBytes(32).toString("hex");
    await q("update users set reset_token = $1, reset_sent_at = now() where id = $2", [token, user.id]);
    await sendResetEmail(email, user.first_name, baseUrl(req) + "/?reset=" + token).catch(() => {});
    return done();
  } catch (e) { return done(); }
});

// Complete a password reset: set a new password from a valid, unexpired token, then log in.
// Proving control of the emailed link also confirms the email address.
app.post("/api/auth/reset", resetLimiter, async (req, res) => {
  try {
    if (!JWT_SECRET) return res.status(500).json({ error: { message: "Server not configured (missing AUTH_JWT_SECRET)." } });
    const token = String(req.body?.token || "");
    const password = String(req.body?.password || "");
    if (!token) return res.status(400).json({ error: { message: "Missing or invalid reset link." } });
    if (password.length < 8) return res.status(400).json({ error: { message: "Use a password of at least 8 characters." } });
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await q(
      `update users set password_hash = $1, reset_token = null, email_verified = true
        where reset_token = $2 and reset_sent_at > now() - interval '${RESET_TTL_HOURS} hour'
        returning *`,
      [hash, token],
    );
    const user = rows[0];
    if (!user) return res.status(400).json({ error: { message: "This reset link is invalid or has expired. Request a new one." } });
    res.json({ token: tokenFor(user), user: publicUser(user) });
  } catch (e) { res.status(500).json({ error: { message: "Could not reset the password. Try again." } }); }
});

app.get("/api/auth/me", requireUser, async (req, res) => {
  try {
    const { rows } = await q("select * from users where id = $1", [req.userId]);
    if (!rows[0]) return res.status(401).json({ error: { message: "Please sign in again." } });
    res.json({ user: publicUser(rows[0]) });
  } catch (e) { res.status(500).json({ error: { message: "Could not load your account." } }); }
});

// Self-promote to admin with the signup code — for someone who created a normal account.
app.post("/api/auth/promote", requireUser, promoteLimiter, async (req, res) => {
  try {
    const expected = process.env.ADMIN_SIGNUP_CODE || "";
    if (!expected) return res.status(400).json({ error: { message: "Admin promotion isn't configured. Contact your administrator." } });
    if (String(req.body?.adminCode || "") !== expected) return res.status(403).json({ error: { message: "Invalid admin code." } });
    const { rows } = await q("update users set is_admin = true where id = $1 returning *", [req.userId]);
    if (!rows[0]) return res.status(404).json({ error: { message: "Account not found." } });
    res.json({ user: publicUser(rows[0]) });
  } catch (e) { res.status(500).json({ error: { message: "Could not update your role." } }); }
});

// Delete the signed-in user's own account (password-confirmed). Cascades to their
// prospects / usage / approvals via the schema's ON DELETE CASCADE.
app.delete("/api/auth/account", requireUser, async (req, res) => {
  try {
    const password = String(req.body?.password || "");
    const { rows } = await q("select password_hash from users where id = $1", [req.userId]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: { message: "Account not found." } });
    if (!(await bcrypt.compare(password, user.password_hash))) {
      return res.status(403).json({ error: { message: "Password is incorrect." } });
    }
    await q("delete from users where id = $1", [req.userId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: { message: "Could not delete the account." } }); }
});

// ───────────────────────────── History ──────────────────────────────
const PAGE_SIZE = 25;

const LEAD_STATUSES = ["new", "connected", "replied", "meeting", "won", "lost"];

app.get("/api/history", requireUser, async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.query.page || "0", 10) || 0);
    const q1 = String(req.query.q || "").trim();
    const status = LEAD_STATUSES.includes(String(req.query.status || "")) ? String(req.query.status) : "";
    const params = [req.userId];
    let where = "user_id = $1";
    if (q1) { params.push("%" + q1 + "%"); where += ` and (label ilike $${params.length} or sub ilike $${params.length})`; }
    if (status) { params.push(status); where += ` and status = $${params.length}`; }
    params.push(PAGE_SIZE, page * PAGE_SIZE);
    const { rows } = await q(
      `select id, label, sub, status, data, updated_at from prospects where ${where} order by updated_at desc limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: { message: "Could not load history." } }); }
});

// Update just the pipeline status of one lead.
app.post("/api/history/:id/status", requireUser, async (req, res) => {
  try {
    const status = LEAD_STATUSES.includes(String(req.body?.status || "")) ? String(req.body.status) : null;
    if (!status) return res.status(400).json({ error: { message: "Invalid status." } });
    const { rows } = await q(
      "update prospects set status = $1 where user_id = $2 and id = $3 returning id, status",
      [status, req.userId, String(req.params.id)],
    );
    if (!rows[0]) return res.status(404).json({ error: { message: "Lead not found." } });
    res.json({ ok: true, status: rows[0].status });
  } catch (e) { res.status(500).json({ error: { message: "Could not update status." } }); }
});

// Upsert one or more entries. Body: { entries: [{ id, label, sub, data }] }. Merge, never delete.
app.post("/api/history", requireUser, async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    for (const e of entries) {
      if (!e || !e.id) continue;
      const status = LEAD_STATUSES.includes(String(e.status || "")) ? String(e.status) : "new";
      await q(
        `insert into prospects (id, user_id, label, sub, status, data)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (id) do update set label = excluded.label, sub = excluded.sub, data = excluded.data
         where prospects.user_id = $2`,
        [String(e.id), req.userId, e.label || "", e.sub || "", status, e.data || {}],
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: { message: "Could not save history." } }); }
});

app.delete("/api/history/:id", requireUser, async (req, res) => {
  try {
    await q("delete from prospects where user_id = $1 and id = $2", [req.userId, String(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: { message: "Could not delete." } }); }
});

// ─────────────────────────────── Usage ──────────────────────────────
app.get("/api/usage", requireUser, async (req, res) => {
  try {
    const { rows } = await q(
      `select coalesce(sum(input_tokens),0)::bigint as input_tokens,
              coalesce(sum(output_tokens),0)::bigint as output_tokens,
              coalesce(sum(cache_read_tokens),0)::bigint as cache_read_tokens,
              coalesce(sum(cost_usd),0)::numeric as cost_usd,
              count(*)::int as calls
         from usage where user_id = $1`,
      [req.userId],
    );
    res.json({ totals: rows[0] });
  } catch (e) { res.status(500).json({ error: { message: "Could not load usage." } }); }
});

// Persist one usage row (called by the proxy core after a successful Anthropic call).
async function writeUsageRow(row) {
  if (!dbOn) return;
  await q(
    "insert into usage (user_id, kind, input_tokens, output_tokens, cache_read_tokens, cost_usd) values ($1,$2,$3,$4,$5,$6)",
    [row.user_id, row.kind, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cost_usd],
  );
}

// ───────────────────────────── Lead approvals ───────────────────────
// Member requests approval for a lead (to unlock relationship / meeting / follow-up).
app.post("/api/approvals", requireUser, async (req, res) => {
  try {
    const prospectId = String(req.body?.prospectId || "").trim();
    if (!prospectId) return res.status(400).json({ error: { message: "Missing lead id." } });
    const label = String(req.body?.label || "").slice(0, 200);
    const sub = String(req.body?.sub || "").slice(0, 200);
    // Re-requesting resets a denied lead back to pending; an already-approved lead stays approved.
    const { rows } = await q(
      `insert into lead_approvals (user_id, prospect_id, label, sub, status, requested_at)
       values ($1,$2,$3,$4,'pending', now())
       on conflict (user_id, prospect_id) do update
         set label = excluded.label, sub = excluded.sub,
             status = case when lead_approvals.status = 'approved' then 'approved' else 'pending' end,
             requested_at = case when lead_approvals.status = 'approved' then lead_approvals.requested_at else now() end
       returning prospect_id, status`,
      [req.userId, prospectId, label, sub],
    );
    res.json({ approval: rows[0] });
  } catch (e) { res.status(500).json({ error: { message: "Could not request approval." } }); }
});

// Member: their own lead statuses, to gate the UI.
app.get("/api/approvals/mine", requireUser, async (req, res) => {
  try {
    const { rows } = await q("select prospect_id, status from lead_approvals where user_id = $1", [req.userId]);
    res.json({ approvals: rows });
  } catch (e) { res.status(500).json({ error: { message: "Could not load approvals." } }); }
});

// Admin: list approval requests (pending first).
app.get("/api/approvals", requireUser, requireAdmin, async (req, res) => {
  try {
    const { rows } = await q(
      `select a.id, a.prospect_id, a.label, a.sub, a.status, a.requested_at, a.decided_by, a.decided_at,
              u.email as member_email, u.first_name, u.last_name
         from lead_approvals a join users u on u.id = a.user_id
        order by case when a.status = 'pending' then 0 else 1 end, a.requested_at desc
        limit 200`,
    );
    res.json({ approvals: rows });
  } catch (e) { res.status(500).json({ error: { message: "Could not load approvals." } }); }
});

// Admin: approve or deny a request.
app.post("/api/approvals/:id/decide", requireUser, requireAdmin, async (req, res) => {
  try {
    const decision = req.body?.decision === "approved" ? "approved" : req.body?.decision === "denied" ? "denied" : null;
    if (!decision) return res.status(400).json({ error: { message: "decision must be 'approved' or 'denied'." } });
    const { rows } = await q(
      "update lead_approvals set status = $1, decided_by = $2, decided_at = now() where id = $3 returning id, status",
      [decision, req.email, String(req.params.id)],
    );
    if (!rows[0]) return res.status(404).json({ error: { message: "Request not found." } });
    res.json({ approval: rows[0] });
  } catch (e) { res.status(500).json({ error: { message: "Could not save the decision." } }); }
});

// ─────────────────────────── Anthropic proxy ────────────────────────
app.post("/api/claude", async (req, res) => {
  const bodyString = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
  const out = await handleClaude(
    { method: "POST", authHeader: req.headers.authorization || "", bodyString },
    // In dev, skip auth on the AI proxy (localhost convenience). In prod, require login.
    { requireAuth: !DEV, recordUsage: writeUsageRow },
  );
  res.status(out.status);
  for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
  res.send(out.body);
});

// Health check for Render.
app.get("/api/health", (_req, res) => res.json({ ok: true, db: dbOn }));

// ───────────────────── Static SPA (production only) ─────────────────
// In dev, Vite serves the client and proxies /api here, so we don't serve static files.
if (!DEV) {
  const dist = path.join(__dirname, "dist");
  app.use(express.static(dist, {
    setHeaders: (res, filePath) => {
      // Vite fingerprints files in /assets (content hash in the name) — cache them forever.
      // Everything else (incl. index.html) stays no-cache so a new deploy is picked up at once.
      if (filePath.includes(path.sep + "assets" + path.sep)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      else res.setHeader("Cache-Control", "no-cache");
    },
  }));
  // SPA fallback: any non-/api GET returns index.html (never cached, so deploys are instant).
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(dist, "index.html"));
  });
}

ensureSchema(); // apply idempotent column migrations on boot

const server = app.listen(PORT, () => {
  console.log(`Karma Connect server on :${PORT} (${DEV ? "dev" : "prod"}, db=${dbOn ? "on" : "OFF"})`);
});

// Graceful shutdown: Render sends SIGTERM on deploy/restart. Stop accepting connections,
// let in-flight requests finish, close the DB pool, then exit (hard-exit after 10s as a backstop).
function shutdown(sig) {
  console.log(`${sig} received — shutting down gracefully…`);
  server.close(() => { (pool ? pool.end() : Promise.resolve()).finally(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
