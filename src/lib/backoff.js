// Pure 429-backoff helpers (no app/Supabase deps) so they're trivially unit-testable.

export function parseRetryAfter(headerVal) {
  if (!headerVal) return null;
  const n = parseInt(headerVal, 10);
  return Number.isFinite(n) ? n * 1000 : null;
}

// Exponential backoff with jitter: delay lands in [exp/2, exp], capped.
export function backoffDelay(attempt, base = 500, cap = 8000, rand = Math.random) {
  const exp = Math.min(cap, base * Math.pow(2, attempt));
  return Math.floor(exp / 2 + rand() * (exp / 2));
}

// Retry a request thunk on HTTP 429 (honoring Retry-After), capped, with jittered backoff.
export async function withRetry(doFetch, { retries = 4, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), rand = Math.random } = {}) {
  let attempt = 0;
  for (;;) {
    const res = await doFetch();
    if (res.status !== 429 || attempt >= retries) return res;
    const headerGet = res.headers && res.headers.get ? res.headers.get("Retry-After") : null;
    const delay = parseRetryAfter(headerGet) ?? backoffDelay(attempt, 500, 8000, rand);
    await sleep(delay);
    attempt++;
  }
}
