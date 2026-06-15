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
const express = require("express");
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
  ? new Pool({ connectionString: DATABASE_URL, ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: false } })
  : null;
const dbOn = !!pool;

async function q(text, params) {
  if (!dbOn) throw new Error("Database not configured (DATABASE_URL missing).");
  return pool.query(text, params);
}

// ── Allowlist (mirrors the proxy) — optional lock-down to a domain / exact emails ──
function emailAllowed(email) {
  const e = (email || "").toLowerCase();
  const allowEmails = (process.env.ALLOWED_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const domain = (process.env.ALLOWED_EMAIL_DOMAIN || "").toLowerCase();
  if (allowEmails.length) return allowEmails.includes(e);
  return !domain || e.endsWith("@" + domain);
}

const app = express();
app.disable("x-powered-by");

// /api/claude needs the RAW body string (the proxy parses + forwards it verbatim).
app.use("/api/claude", express.text({ type: () => true, limit: "4mb" }));
// Everything else is JSON.
app.use(express.json({ limit: "2mb" }));

// ── Auth helpers ──
function tokenFor(user) {
  return signJWT({ sub: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name }, JWT_SECRET);
}
function publicUser(u) {
  return { id: u.id, email: u.email, firstName: u.first_name || "", lastName: u.last_name || "" };
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

// ─────────────────────────────── Auth ───────────────────────────────
app.post("/api/auth/signup", async (req, res) => {
  try {
    if (!JWT_SECRET) return res.status(500).json({ error: { message: "Server not configured (missing AUTH_JWT_SECRET)." } });
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const firstName = String(req.body?.firstName || "").trim();
    const lastName = String(req.body?.lastName || "").trim();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: { message: "Enter a valid email address." } });
    if (password.length < 8) return res.status(400).json({ error: { message: "Use a password of at least 8 characters." } });
    if (!emailAllowed(email)) return res.status(403).json({ error: { message: "This email is not allowed to use Karma Connect." } });

    const exists = await q("select 1 from users where email = $1", [email]);
    if (exists.rowCount) return res.status(409).json({ error: { message: "An account with that email already exists. Sign in instead." } });

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await q(
      "insert into users (email, password_hash, first_name, last_name) values ($1,$2,$3,$4) returning *",
      [email, hash, firstName, lastName],
    );
    const user = rows[0];
    res.json({ token: tokenFor(user), user: publicUser(user) });
  } catch (e) { res.status(500).json({ error: { message: "Could not create the account. Try again." } }); }
});

app.post("/api/auth/signin", async (req, res) => {
  try {
    if (!JWT_SECRET) return res.status(500).json({ error: { message: "Server not configured (missing AUTH_JWT_SECRET)." } });
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!EMAIL_RE.test(email) || !password) return res.status(400).json({ error: { message: "Enter your email and password." } });
    if (!emailAllowed(email)) return res.status(403).json({ error: { message: "This email is not allowed to use Karma Connect." } });

    const { rows } = await q("select * from users where email = $1", [email]);
    const user = rows[0];
    // Compare even when the user is missing (timing-safe-ish: avoid leaking which emails exist).
    const ok = user ? await bcrypt.compare(password, user.password_hash) : await bcrypt.compare(password, "$2a$12$0000000000000000000000000000000000000000000000000000");
    if (!user || !ok) return res.status(401).json({ error: { message: "Wrong email or password." } });
    res.json({ token: tokenFor(user), user: publicUser(user) });
  } catch (e) { res.status(500).json({ error: { message: "Could not sign in. Try again." } }); }
});

app.get("/api/auth/me", requireUser, async (req, res) => {
  try {
    const { rows } = await q("select * from users where id = $1", [req.userId]);
    if (!rows[0]) return res.status(401).json({ error: { message: "Please sign in again." } });
    res.json({ user: publicUser(rows[0]) });
  } catch (e) { res.status(500).json({ error: { message: "Could not load your account." } }); }
});

// ───────────────────────────── History ──────────────────────────────
const PAGE_SIZE = 25;

app.get("/api/history", requireUser, async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.query.page || "0", 10) || 0);
    const { rows } = await q(
      "select id, label, sub, data, updated_at from prospects where user_id = $1 order by updated_at desc limit $2 offset $3",
      [req.userId, PAGE_SIZE, page * PAGE_SIZE],
    );
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: { message: "Could not load history." } }); }
});

// Upsert one or more entries. Body: { entries: [{ id, label, sub, data }] }. Merge, never delete.
app.post("/api/history", requireUser, async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    for (const e of entries) {
      if (!e || !e.id) continue;
      await q(
        `insert into prospects (id, user_id, label, sub, data)
         values ($1,$2,$3,$4,$5)
         on conflict (id) do update set label = excluded.label, sub = excluded.sub, data = excluded.data
         where prospects.user_id = $2`,
        [String(e.id), req.userId, e.label || "", e.sub || "", e.data || {}],
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
  app.use(express.static(dist));
  // SPA fallback: any non-/api GET returns index.html.
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.listen(PORT, () => {
  console.log(`Karma Connect server on :${PORT} (${DEV ? "dev" : "prod"}, db=${dbOn ? "on" : "OFF"})`);
});
