import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the auth module that history.js imports (token + current user) ──
const state = { user: { id: "u1" }, token: "tok", rows: [], lastPost: null, lastDelete: null };
vi.mock("./auth.js", () => ({
  getAccessToken: () => state.token,
  currentUser: () => state.user,
}));

// ── Mock fetch to the backend /api/history endpoints ──
globalThis.fetch = vi.fn(async (url, opts = {}) => {
  const method = opts.method || "GET";
  if (url.startsWith("/api/history") && method === "GET") {
    return { ok: true, status: 200, json: async () => ({ rows: state.rows }) };
  }
  if (url === "/api/history" && method === "POST") {
    state.lastPost = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  if (url.startsWith("/api/history/") && method === "DELETE") {
    state.lastDelete = decodeURIComponent(url.split("/api/history/")[1]);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
});

// minimal localStorage for the fallback path
const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

const { listHistory, writeHistory, deleteHistory } = await import("./history.js");

beforeEach(() => {
  state.user = { id: "u1" }; state.token = "tok"; state.rows = []; state.lastPost = null; state.lastDelete = null;
  for (const k of Object.keys(store)) delete store[k];
  store["kc_reconciled_u1"] = "1"; // skip the one-time reconcile in these tests
});

describe("history backend adapter (authenticated)", () => {
  it("maps API rows to entries on listHistory", async () => {
    state.rows = [{ id: "a", label: "Jane", sub: "Owner", data: { x: 1 }, updated_at: "2026-01-01T00:00:00Z" }];
    const out = await listHistory("jane@x.com", 0);
    expect(out).toEqual([{ id: "a", label: "Jane", sub: "Owner", savedAt: "2026-01-01T00:00:00Z", snapshot: { x: 1 } }]);
  });

  it("posts mapped entries on writeHistory", async () => {
    await writeHistory("jane@x.com", [{ id: "a", label: "Jane", sub: "Owner", snapshot: { x: 1 } }]);
    expect(state.lastPost).toEqual({ entries: [{ id: "a", label: "Jane", sub: "Owner", data: { x: 1 } }] });
  });

  it("deletes by id on deleteHistory", async () => {
    await deleteHistory("jane@x.com", "a");
    expect(state.lastDelete).toBe("a");
  });
});

describe("history fallback (unauthenticated)", () => {
  beforeEach(() => { state.user = null; state.token = null; });
  it("reads/writes localStorage when there's no user", async () => {
    await writeHistory("anon@x.com", [{ id: "z", label: "Local", snapshot: {} }]);
    const out = await listHistory("anon@x.com", 0);
    expect(out.map((e) => e.id)).toContain("z");
    expect(state.lastPost).toBe(null); // never hit the API
  });
});
