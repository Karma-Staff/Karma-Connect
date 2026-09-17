// Anthropic client. Calls go through our own /api/claude proxy (Vercel function in prod,
// Vite dev-middleware locally) so the API key stays server-side, never in the browser bundle.
import { withRetry } from "./backoff.js";

// Models (hybrid for cost control):
//  - CLAUDE_MODEL (Sonnet 4.6): quality-critical work — the intelligence profile and all
//    outreach message generation, where voice and nuance matter.
//  - CLAUDE_FAST_MODEL (Haiku 4.5): mechanical extraction — LinkedIn paste parsing and
//    company web research. ~1/3 the price; quality is fine for pulling out facts.
// For maximum depth on hard prospects, change CLAUDE_MODEL to claude-opus-4-8.
export const CLAUDE_MODEL = "claude-sonnet-4-6";
export const CLAUDE_FAST_MODEL = "claude-haiku-4-5";

// ── Serialized queue (concurrency 1) ──
// A single prospect run makes several AI calls; serialize them so we never fan out in
// parallel against the upstream (and so the proxy's rate limit degrades gracefully).
let tail = Promise.resolve();
function enqueue(task) {
  const result = tail.then(() => task());
  tail = result.then(() => {}, () => {});
  return result;
}

// Core call. Returns the joined text of all text blocks in the response.
export async function anthropicMsg(system, user, { maxTokens = 1000, useSearch = false, model = CLAUDE_MODEL } = {}) {
  const body = {
    model,
    max_tokens: maxTokens,
    // Cache the (large, identical-every-call) system prompt. Cached input tokens cost
    // ~10% of fresh ones, so repeated calls in a prospect run get much cheaper.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  };
  // Web-search budget: "light" = 1 search (cheap), default = 2, "deep" = 4. Fewer searches
  // means far fewer input tokens, since each search pulls fetched page content into context.
  if (useSearch) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: useSearch === "deep" ? 4 : useSearch === "light" ? 1 : 2 }];

  const doFetch = () => fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const res = await enqueue(() => withRetry(doFetch, { retries: 4 }));
  if (!res.ok) {
    let errMsg = "AI request failed (" + res.status + ").";
    if (res.status === 429) errMsg = "The service is busy. Please wait a moment and try again.";
    try { const errData = await res.json(); errMsg = (errData?.error?.message) || errMsg; } catch (e) {}
    throw new Error(errMsg);
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// Back-compat wrapper so call sites can use the (system, prompt, useSearch, maxTokens) shape.
export async function callClaude(system, prompt, useSearch = false, maxTokens = 1000, model = CLAUDE_MODEL) {
  return anthropicMsg(system, prompt, { maxTokens, useSearch, model });
}
