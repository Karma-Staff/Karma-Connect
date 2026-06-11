// Vercel serverless proxy for the Anthropic Messages API.
// The API key lives here (server-side env), never in the browser bundle. Every call must
// carry a valid Supabase login token whose email is on the allowed domain.
const crypto = require("crypto");

function b64url(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// Verify a Supabase access token (HS256 JWT signed with the project's JWT secret).
function verifySupabaseJWT(token, secret) {
  const parts = (token || "").split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = crypto.createHmac("sha256", secret).update(h + "." + p).digest();
  const got = b64url(sig);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  let payload;
  try { payload = JSON.parse(b64url(p).toString("utf8")); } catch (e) { return null; }
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: { message: "Method not allowed." } });
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const secret = process.env.SUPABASE_JWT_SECRET;
  const domain = (process.env.ALLOWED_EMAIL_DOMAIN || "").toLowerCase();
  if (!apiKey || !secret) {
    res.status(500).json({ error: { message: "Server not configured (missing ANTHROPIC_API_KEY or SUPABASE_JWT_SECRET)." } });
    return;
  }

  // Auth: require a valid Supabase login token.
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const claims = token ? verifySupabaseJWT(token, secret) : null;
  if (!claims) {
    res.status(401).json({ error: { message: "Please sign in again." } });
    return;
  }
  const email = (claims.email || "").toLowerCase();
  if (domain && !email.endsWith("@" + domain)) {
    res.status(403).json({ error: { message: "This account is not allowed to use Karma Connect." } });
    return;
  }

  // Forward the request body verbatim to Anthropic.
  const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body,
    });
    const text = await r.text();
    res.status(r.status).setHeader("Content-Type", "application/json");
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: { message: "Upstream request failed: " + String(e) } });
  }
};
