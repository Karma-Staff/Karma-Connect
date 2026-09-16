// Shared proxy core. Imported by BOTH the Vercel function (api/claude.js) and the Vite dev
// middleware (vite.config.js) so they can never drift. CommonJS so a Node-ESM file can
// `import` it (default import) and a CJS file can `require` it.
//
// All external dependencies are OPTIONAL and env-gated — if Upstash isn't configured,
// those features no-op and the proxy still forwards. Usage accounting (the Postgres
// INSERT) is injected by the caller via opts.recordUsage, so this core never imports `pg`.
//
// SECRETS used here are server-only and must NEVER be VITE_-prefixed:
//   ANTHROPIC_API_KEY, AUTH_JWT_SECRET,
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
const crypto = require("crypto");

// Issuer stamped into our JWTs (server.js signs with this; we verify it here).
const JWT_ISS = process.env.JWT_ISS || "karma-connect";

// ── Cost model (USD per 1,000 tokens). One config object. ──
const COST = {
  "claude-sonnet-4-6": { in: 0.003, out: 0.015, cacheIn: 0.0003 },
  "claude-opus-4-8":   { in: 0.005, out: 0.025, cacheIn: 0.0005 },
  "claude-haiku-4-5":  { in: 0.001, out: 0.005, cacheIn: 0.0001 },
  _default:            { in: 0.003, out: 0.015, cacheIn: 0.0003 },
};

function computeCost(usage, model) {
  const c = COST[model] || COST._default;
  const inT = usage?.input_tokens || 0;
  const outT = usage?.output_tokens || 0;
  const cacheT = usage?.cache_read_input_tokens || 0;
  const cost = (inT / 1000) * c.in + (outT / 1000) * c.out + (cacheT / 1000) * c.cacheIn;
  return { inT, outT, cacheT, total: inT + outT, cost_usd: Math.round(cost * 100000) / 100000 };
}

// ── Limits config (override via env) ──
const LIMITS = {
  rpm: parseInt(process.env.RATE_LIMIT_RPM || "20", 10),                 // requests / user / minute
  dailyTokens: parseInt(process.env.DAILY_TOKEN_BUDGET || "2000000", 10),// tokens / user / day
  breakerFails: parseInt(process.env.BREAKER_FAILS || "12", 10),         // upstream failures / minute -> open
  breakerCooldown: parseInt(process.env.BREAKER_COOLDOWN || "30", 10),   // seconds the breaker stays open
  cacheTtl: parseInt(process.env.RESPONSE_CACHE_TTL || "600", 10),       // seconds
};

// Hard caps on what a client may request through the proxy (cost-abuse protection — M4).
// The client fully controls the request body, so we whitelist the model and clamp the
// expensive knobs (output length, web-search uses) before forwarding to Anthropic.
const ALLOWED_MODELS = (process.env.ALLOWED_MODELS || "claude-sonnet-4-6,claude-haiku-4-5")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MAX_TOKENS_CAP = parseInt(process.env.MAX_TOKENS_CAP || "8000", 10);
const MAX_SEARCH_USES = parseInt(process.env.MAX_SEARCH_USES || "4", 10);
const MAX_TOOLS = parseInt(process.env.MAX_TOOLS || "2", 10);

// Login-token lifetime. Shorter = smaller window if a token leaks. Rotating AUTH_JWT_SECRET
// invalidates everything immediately (the real revocation lever). Default 2 days.
const JWT_TTL = parseInt(process.env.JWT_TTL_SECONDS || String(60 * 60 * 24 * 2), 10);

// ── Upstash Redis (REST) — optional ──
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const redisOn = !!(REDIS_URL && REDIS_TOKEN);

async function rcmd(...args) {
  if (!redisOn) return null;
  try {
    const res = await fetch(REDIS_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j.result;
  } catch (e) { return null; }
}
async function rincr(key, ttl) {
  const n = await rcmd("INCR", key);
  if (n === 1 && ttl) await rcmd("EXPIRE", key, ttl);
  return n;
}

// ── In-memory fallback limiter (M1) ──
// When Upstash isn't configured, keep the same per-user RPM + daily-token caps working
// on a single instance. Resets on restart; for multi-instance, configure Upstash.
const memMinute = new Map(); // userId:minute -> count
const memDaily = new Map();  // userId:day   -> tokens
function memRpm(userId) {
  const minute = Math.floor(Date.now() / 60000);
  const key = userId + ":" + minute;
  const n = (memMinute.get(key) || 0) + 1;
  memMinute.set(key, n);
  if (memMinute.size > 10000) for (const k of memMinute.keys()) if (!k.endsWith(":" + minute)) memMinute.delete(k);
  return n;
}
function memDayUsed(userId) { return memDaily.get(userId + ":" + new Date().toISOString().slice(0, 10)) || 0; }
function memDayAdd(userId, t) {
  const today = new Date().toISOString().slice(0, 10);
  const key = userId + ":" + today;
  memDaily.set(key, (memDaily.get(key) || 0) + t);
  if (memDaily.size > 10000) for (const k of memDaily.keys()) if (!k.endsWith(":" + today)) memDaily.delete(k);
}

// ── Usage accounting ──
// The DB row write is injected by the caller (server.js → Postgres) so this core stays
// storage-agnostic. We still own the Redis daily-quota counter that the quota check reads.
async function recordUsage(userId, usage, model, kind, writeRow) {
  if (!userId) return;
  const c = computeCost(usage, model);
  try {
    if (typeof writeRow === "function") {
      await writeRow({
        user_id: userId, kind: kind || "ai",
        input_tokens: c.inT, output_tokens: c.outT, cache_read_tokens: c.cacheT, cost_usd: c.cost_usd,
      });
    }
    // Roll the per-user daily token counter that the quota check reads.
    if (redisOn) {
      const day = new Date().toISOString().slice(0, 10);
      const key = "q:" + userId + ":" + day;
      const n = await rcmd("INCRBY", key, c.total);
      if (n != null && n <= c.total) await rcmd("EXPIRE", key, 90000); // ~25h
    } else {
      memDayAdd(userId, c.total); // in-memory fallback when Upstash isn't configured
    }
  } catch (e) { /* never fail the request because accounting failed */ }
}

// ── JWT verification (HS256) ──
function b64url(s) { return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"); }
function verifyJWT(token, secret, expectedIss) {
  const parts = (token || "").split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = crypto.createHmac("sha256", secret).update(h + "." + p).digest();
  const got = b64url(sig);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  let payload;
  try { payload = JSON.parse(b64url(p).toString("utf8")); } catch (e) { return null; }
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  if (payload.aud && payload.aud !== "authenticated") return null;
  if (expectedIss && payload.iss && payload.iss !== expectedIss) return null;
  return payload;
}

// Sign an HS256 JWT the same way verifyJWT expects. server.js uses this to mint login tokens.
function b64urlEncode(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function signJWT(claims, secret, ttlSeconds = JWT_TTL) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64urlEncode(JSON.stringify({ aud: "authenticated", iss: JWT_ISS, iat: now, exp: now + ttlSeconds, ...claims }));
  const sig = b64urlEncode(crypto.createHmac("sha256", secret).update(header + "." + payload).digest());
  return header + "." + payload + "." + sig;
}

function jr(status, obj, headers) { return { status, headers: { "Content-Type": "application/json", ...(headers || {}) }, body: JSON.stringify(obj) }; }
function kindOf(body) { return body && Array.isArray(body.tools) && body.tools.length ? "research" : "generate"; }
function cacheKeyOf(body) {
  try {
    const sys = Array.isArray(body.system) ? body.system.map((s) => s.text || "").join("") : (body.system || "");
    const user = (body.messages || []).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("");
    if (Array.isArray(body.tools) && body.tools.length) return null; // never cache live-search calls
    return "cache:" + crypto.createHash("sha256").update((body.model || "") + " " + sys + " " + user).digest("hex");
  } catch (e) { return null; }
}

// Clamp / whitelist the client's request before forwarding (M4). The browser controls the
// body, so enforce an allowed model, a max_tokens ceiling, and a web-search cap server-side.
// Returns { ok:false, status, message } to reject, or { ok:true, body } with a sanitized body.
function sanitizeBody(body) {
  if (!body || typeof body !== "object") return { ok: false, status: 400, message: "Invalid request body." };
  if (!ALLOWED_MODELS.includes(String(body.model || ""))) {
    return { ok: false, status: 400, message: "Requested model is not permitted." };
  }
  const out = { ...body };
  const mt = parseInt(out.max_tokens, 10);
  out.max_tokens = Number.isFinite(mt) ? Math.min(Math.max(1, mt), MAX_TOKENS_CAP) : Math.min(1024, MAX_TOKENS_CAP);
  if (Array.isArray(out.tools)) {
    out.tools = out.tools.slice(0, MAX_TOOLS).map((t) => {
      if (t && typeof t === "object" && t.max_uses !== undefined) {
        const u = parseInt(t.max_uses, 10);
        return { ...t, max_uses: Number.isFinite(u) ? Math.min(Math.max(1, u), MAX_SEARCH_USES) : 1 };
      }
      return t;
    });
  }
  return { ok: true, body: out };
}

// ── The single request handler both entry points call ──
// opts.requireAuth: enforce login + rate limits + usage (prod). Off for localhost dev.
// opts.recordUsage: optional async fn(row) that persists one usage row (server.js → Postgres).
// opts/identity: when the caller has ALREADY authenticated the request (the merged
// Karma site resolves the shared WorkOS session in requireUser before reaching
// here), it passes { userId, email } and no bearer token is looked for. The
// authHeader path is kept for the standalone entry point that still mints JWTs.
async function handleClaude({ method, authHeader, bodyString, identity }, opts = {}) {
  const requireAuth = !!opts.requireAuth;
  if (method !== "POST") return jr(405, { error: { message: "Method not allowed." } });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return jr(500, { error: { message: "Server not configured (missing ANTHROPIC_API_KEY)." } });

  let userId = null;
  if (requireAuth) {
    let email = "";
    if (identity && identity.userId) {
      // Already authenticated upstream against the shared WorkOS session.
      userId = identity.userId;
      email = String(identity.email || "").toLowerCase();
    } else {
      const secret = process.env.AUTH_JWT_SECRET;
      if (!secret) return jr(500, { error: { message: "Server not configured (missing AUTH_JWT_SECRET)." } });
      const token = (authHeader || "").startsWith("Bearer ") ? authHeader.slice(7) : "";
      const claims = token ? verifyJWT(token, secret, JWT_ISS) : null;
      if (!claims) return jr(401, { error: { message: "Please sign in again." } });
      email = (claims.email || "").toLowerCase();
      userId = claims.sub; // trusted: from the verified token, never the client
    }
    // The allowlist applies however the identity arrived.
    const allowEmails = (process.env.ALLOWED_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
    const domain = (process.env.ALLOWED_EMAIL_DOMAIN || "karmastaff.com").toLowerCase();
    const allowed = allowEmails.length ? allowEmails.includes(email) : (!domain || email.endsWith("@" + domain));
    if (!allowed) return jr(403, { error: { message: "This account is not allowed to use Karma Connect." } });
  }

  // Global circuit breaker.
  if (redisOn && (await rcmd("GET", "cb:open"))) {
    return jr(429, { error: { message: "The service is busy right now. Please try again shortly." } }, { "Retry-After": String(LIMITS.breakerCooldown) });
  }

  // Per-user rate limit + daily token quota (only when authenticated).
  if (userId && redisOn) {
    const minute = Math.floor(Date.now() / 60000);
    const n = await rincr("rl:" + userId + ":" + minute, 60);
    if (n != null && n > LIMITS.rpm) {
      return jr(429, { error: { message: "You're going a little fast. Try again in a moment." } }, { "Retry-After": String(60 - (Math.floor(Date.now() / 1000) % 60)) });
    }
    const day = new Date().toISOString().slice(0, 10);
    const used = parseInt((await rcmd("GET", "q:" + userId + ":" + day)) || "0", 10);
    if (used >= LIMITS.dailyTokens) {
      return jr(429, { error: { message: "Daily usage budget reached. It resets tomorrow." } }, { "Retry-After": "3600" });
    }
  } else if (userId) {
    // No Upstash configured — fall back to the in-memory limiter so caps still apply (M1).
    if (memRpm(userId) > LIMITS.rpm) {
      return jr(429, { error: { message: "You're going a little fast. Try again in a moment." } }, { "Retry-After": String(60 - (Math.floor(Date.now() / 1000) % 60)) });
    }
    if (memDayUsed(userId) >= LIMITS.dailyTokens) {
      return jr(429, { error: { message: "Daily usage budget reached. It resets tomorrow." } }, { "Retry-After": "3600" });
    }
  }

  let body = {};
  try { body = JSON.parse(bodyString || "{}"); } catch (e) { return jr(400, { error: { message: "Invalid request body." } }); }

  // Clamp / whitelist the request (model, max_tokens, tools) before spending (M4).
  const clean = sanitizeBody(body);
  if (!clean.ok) return jr(clean.status, { error: { message: clean.message } });
  body = clean.body;
  const forwardBody = JSON.stringify(body);

  // Response cache (identical model+system+user, short TTL) — cuts redundant spend.
  // Key includes the user id so one account's cached answer is never served to another (I1).
  const ckey = redisOn ? cacheKeyOf(body) : null;
  const userKey = ckey ? ckey + ":" + (userId || "") : null;
  if (userKey) {
    const hit = await rcmd("GET", userKey);
    if (hit) return jr(200, JSON.parse(hit), { "X-KC-Cache": "HIT" });
  }

  // Forward to Anthropic.
  let r, text;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: forwardBody,
    });
    text = await r.text();
  } catch (e) {
    if (redisOn) { const f = await rincr("cb:fails", 60); if (f != null && f >= LIMITS.breakerFails) await rcmd("SET", "cb:open", "1", "EX", LIMITS.breakerCooldown); }
    return jr(502, { error: { message: "Upstream request failed. Please try again." } });
  }

  if (r.ok) {
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* leave as text */ }
    if (data) {
      if (userId && data.usage) recordUsage(userId, data.usage, body.model, kindOf(body), opts.recordUsage);
      if (userKey) rcmd("SET", userKey, text, "EX", LIMITS.cacheTtl);
    }
  } else if (redisOn && (r.status >= 500 || r.status === 429)) {
    const f = await rincr("cb:fails", 60);
    if (f != null && f >= LIMITS.breakerFails) await rcmd("SET", "cb:open", "1", "EX", LIMITS.breakerCooldown);
  }

  return { status: r.status, headers: { "Content-Type": "application/json", "X-KC-Cache": "MISS" }, body: text };
}

module.exports = { handleClaude, computeCost, COST, LIMITS, signJWT, verifyJWT, JWT_ISS, sanitizeBody };
