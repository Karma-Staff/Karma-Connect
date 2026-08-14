// Karma Connect — Lead Finder · background service worker.
//
// Every network call to the Karma Connect backend happens HERE, not in the popup. The
// popup is a thin renderer that sends messages and reads chrome.storage. Running the
// search in the worker means a research call (which can take 20-40s with web search)
// survives the popup being closed — results land in storage and show on reopen.
//
// It talks to three endpoints the app already exposes:
//   POST /api/auth/signin  -> { token, user }        (login; needed to SAVE leads)
//   POST /api/claude        -> Anthropic Messages API (the existing "ask Claude" proxy)
//   POST /api/history       -> save a lead as a prospect ({ entries: [...] })

const DEFAULT_BACKEND = "http://localhost:8787";

async function getBackend() {
  const { backendUrl } = await chrome.storage.local.get("backendUrl");
  return (backendUrl || DEFAULT_BACKEND).replace(/\/+$/, "");
}
async function getAuth() {
  const { auth } = await chrome.storage.local.get("auth");
  return auth || null;
}

// ── Sign in (stores the JWT the backend mints) ──
async function signin(email, password) {
  const base = await getBackend();
  const res = await fetch(base + "/api/auth/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: String(email || "").trim(), password: String(password || "") }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || ("Sign in failed (" + res.status + ")."));
  const auth = { token: data.token, email: (data.user && data.user.email) || email };
  await chrome.storage.local.set({ auth });
  return { email: auth.email };
}

// ── Lead research prompt ──
const LEAD_SYSTEM =
  `You are a B2B lead-research assistant for Karma Staff, a company that places full-time ` +
  `remote professionals (office admin, estimating support, bookkeeping, sales & marketing ` +
  `support) into property-restoration and construction businesses.\n\n` +
  `Given a description of the leads the user wants, use web search to find REAL, currently-` +
  `operating companies (and, where genuinely public, a decision-maker) that match.\n` +
  `RULES:\n` +
  `- Only include companies you can verify from the search results. NEVER invent names, ` +
  `websites, employee numbers, or people.\n` +
  `- Default to restoration / construction / roofing / HVAC / plumbing / property-management ` +
  `businesses unless the request says otherwise.\n` +
  `- Give each lead a concrete, recent SIGNAL (hiring, new location, expansion, storm response, ` +
  `funding) when you can find one; leave it "" otherwise.\n` +
  `- "source" MUST be a real URL from your search that backs the lead.\n` +
  `- Leave any field you cannot verify as an empty string "".\n` +
  `Return ONLY a valid JSON array — no markdown, no code fences, no commentary. Start with [ and end with ].`;

function leadUserPrompt(query, count) {
  return (
    `Find up to ${count} leads matching this request:\n"""\n${String(query || "").trim()}\n"""\n\n` +
    `Return ONLY a JSON array of objects with EXACTLY these keys:\n` +
    `[{"company":"","website":"","contactName":"","title":"","location":"","industry":"",` +
    `"employeeCount":"","signal":"","why":"","source":""}]\n` +
    `- "why": one short sentence on why this company fits the request.\n` +
    `- Deduplicate by company. Best-fit first.`
  );
}

function parseLeads(s) {
  if (!s) return [];
  let t = String(s).trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start !== -1 && end > start) t = t.slice(start, end + 1);
  let arr;
  try { arr = JSON.parse(t); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  const KEYS = ["company", "website", "contactName", "title", "location", "industry", "employeeCount", "signal", "why", "source"];
  return arr
    .filter((o) => o && typeof o === "object")
    .map((o) => { const r = {}; for (const k of KEYS) r[k] = o[k] == null ? "" : String(o[k]); return r; })
    .filter((l) => l.company || l.contactName);
}

async function doSearch(query, count) {
  const base = await getBackend();
  const auth = await getAuth();
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 4000,
    system: [{ type: "text", text: LEAD_SYSTEM }],
    messages: [{ role: "user", content: leadUserPrompt(query, count) }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
  };
  const res = await fetch(base + "/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth?.token ? { Authorization: "Bearer " + auth.token } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = "AI request failed (" + res.status + ").";
    try { msg = JSON.parse(text)?.error?.message || msg; } catch (e) {}
    if (res.status === 401) msg += " (In production you must be signed in; also check the backend's ANTHROPIC_API_KEY is a real key.)";
    throw new Error(msg);
  }
  const data = JSON.parse(text);
  const joined = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const leads = parseLeads(joined);
  if (!leads.length) throw new Error("No leads came back. Try rephrasing the request, or the model returned an unexpected format.");
  return leads;
}

// Fire-and-forget: write status to storage as it progresses so the popup can render it
// even if it was closed while the request was in flight.
async function runSearch(query, count) {
  await chrome.storage.local.set({ searchState: { status: "loading", query, results: [], error: "", at: Date.now() } });
  try {
    const results = await doSearch(query, count);
    await chrome.storage.local.set({ searchState: { status: "done", query, results, error: "", at: Date.now() } });
  } catch (e) {
    await chrome.storage.local.set({ searchState: { status: "error", query, results: [], error: String(e?.message || e), at: Date.now() } });
  }
}

// ── Save a lead into Karma Connect (needs login) ──
async function saveLead(lead) {
  const base = await getBackend();
  const auth = await getAuth();
  if (!auth?.token) throw new Error("Sign in first to save leads.");
  const name = String(lead.contactName || "").trim();
  const parts = name ? name.split(/\s+/) : [];
  const firstName = parts.shift() || "";
  const lastName = parts.join(" ");
  const id = (crypto.randomUUID && crypto.randomUUID()) || ("ext-" + Date.now() + "-" + Math.floor(Math.random() * 1e6));
  const label = lead.company || name || "Untitled lead";
  const sub = [lead.title, lead.location].filter(Boolean).join(" · ") || lead.industry || "";
  const data = {
    company: lead.company || "", website: lead.website || "",
    firstName, lastName, title: lead.title || "",
    location: lead.location || "", industry: lead.industry || "",
    employeeCount: lead.employeeCount || "",
    companyDesc: lead.why || "", news: lead.signal || "",
    context: lead.source ? ("Found via Lead Finder. Source: " + lead.source) : "Found via Lead Finder.",
    source: "extension",
  };
  const res = await fetch(base + "/api/history", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + auth.token },
    body: JSON.stringify({ entries: [{ id, label, sub, status: "new", data }] }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || ("Could not save (" + res.status + ")."));
  return { id, label };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "SEARCH":
          runSearch(msg.query, Math.min(Math.max(1, parseInt(msg.count, 10) || 8), 15)); // don't await — keep worker alive via fetch
          sendResponse({ ok: true });
          break;
        case "SIGNIN": {
          const r = await signin(msg.email, msg.password);
          sendResponse({ ok: true, auth: r });
          break;
        }
        case "SIGNOUT":
          await chrome.storage.local.remove("auth");
          sendResponse({ ok: true });
          break;
        case "SAVE": {
          const saved = await saveLead(msg.lead);
          sendResponse({ ok: true, saved });
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown request." });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // async sendResponse
});
