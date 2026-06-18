// In-memory rate limiter for the auth endpoints (extracted from server.js).
// Single-instance friendly; for multi-instance, front it with Upstash Redis.
const store = new Map(); // key -> { count, resetAt }

// Periodic cleanup of expired buckets so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of store) if (now > e.resetAt) store.delete(k);
}, 60000).unref();

// Express middleware factory. opts: { windowMs, max, keyFn(req), message }.
function rateLimit({ windowMs, max, keyFn, message }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = keyFn(req);
    let e = store.get(key);
    if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + windowMs }; store.set(key, e); }
    e.count++;
    if (e.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((e.resetAt - now) / 1000)));
      return res.status(429).json({ error: { message: message || "Too many requests. Please slow down and try again shortly." } });
    }
    next();
  };
}

// Pure decision helper (no req/res) — what rateLimit() does, exposed for unit tests.
function hit(key, windowMs, max, now) {
  let e = store.get(key);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + windowMs }; store.set(key, e); }
  e.count++;
  return e.count <= max; // true = allowed
}

module.exports = { rateLimit, hit, _store: store };
