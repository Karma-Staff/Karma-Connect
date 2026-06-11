// Anthropic client. Calls go through our own /api/claude proxy (Vercel function in prod,
// Vite dev-middleware locally) so the API key stays server-side, never in the browser bundle.
import { getAccessToken } from "./supabase.js";

// Claude model. claude-sonnet-4-6 is the speed/intelligence sweet spot (fast + cheaper).
// For maximum depth on hard prospects, change to claude-opus-4-8 — same API, just the string.
export const CLAUDE_MODEL = "claude-sonnet-4-6";

// Core call. Returns the joined text of all text blocks in the response.
export async function anthropicMsg(system, user, { maxTokens = 1000, useSearch = false } = {}) {
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    // Cache the (large, identical-every-call) system prompt. Cached input tokens cost
    // ~10% of fresh ones, so repeated calls in a prospect run get much cheaper.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  };
  // Anthropic server-side web search tool. max_uses caps searches (the main token cost).
  if (useSearch) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: useSearch === "deep" ? 5 : 3 }];

  const token = getAccessToken();
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let errMsg = "AI request failed (" + res.status + ").";
    try { const errData = await res.json(); errMsg += " " + (errData?.error?.message || ""); } catch (e) {}
    throw new Error(errMsg + " Please try again.");
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// Back-compat wrapper so call sites can use the (system, prompt, useSearch, maxTokens) shape.
export async function callClaude(system, prompt, useSearch = false, maxTokens = 1000) {
  return anthropicMsg(system, prompt, { maxTokens, useSearch });
}
