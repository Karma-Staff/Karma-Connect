// Vercel serverless proxy for the Anthropic Messages API.
// Thin wrapper: all logic (JWT verify, rate limit, quota, usage, cache, forward) lives in
// the shared core so this and the Vite dev middleware can never drift.
const { handleClaude } = require("./_proxy.cjs");

module.exports = async (req, res) => {
  const bodyString = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
  const out = await handleClaude(
    { method: req.method, authHeader: req.headers.authorization || "", bodyString },
    { requireAuth: true },
  );
  res.status(out.status);
  for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
  res.send(out.body);
};
