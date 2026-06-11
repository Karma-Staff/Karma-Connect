import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the Supabase module that history.js imports ──
const state = { user: { id: "u1" }, rows: [], upserted: null, deleted: null };
const queryChain = {
  select: () => queryChain,
  eq: () => queryChain,
  order: () => queryChain,
  range: () => Promise.resolve({ data: state.rows, error: null }),
};
const mockSupabase = {
  auth: { getUser: async () => ({ data: { user: state.user } }) },
  from: () => ({
    select: queryChain.select,
    eq: queryChain.eq,
    order: queryChain.order,
    range: queryChain.range,
    upsert: (rows) => { state.upserted = rows; return Promise.resolve({ error: null }); },
    delete: () => ({ eq: () => ({ eq: (col, id) => { state.deleted = id; return Promise.resolve({ error: null }); } }) }),
  }),
};
vi.mock("./supabase.js", () => ({ supabase: mockSupabase, supabaseConfigured: true, getAccessToken: () => null }));

// minimal localStorage for the fallback path
const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

const { listHistory, writeHistory, deleteHistory } = await import("./history.js");

beforeEach(() => { state.user = { id: "u1" }; state.rows = []; state.upserted = null; state.deleted = null; for (const k of Object.keys(store)) delete store[k]; store["kc_reconciled_u1"] = "1"; });

describe("history Supabase adapter (authenticated)", () => {
  it("maps DB rows to entries on listHistory", async () => {
    state.rows = [{ id: "a", label: "Jane", sub: "Owner", data: { x: 1 }, updated_at: "2026-01-01T00:00:00Z" }];
    const out = await listHistory("jane@x.com", 0);
    expect(out).toEqual([{ id: "a", label: "Jane", sub: "Owner", savedAt: "2026-01-01T00:00:00Z", snapshot: { x: 1 } }]);
  });

  it("upserts mapped rows on writeHistory (with user_id)", async () => {
    await writeHistory("jane@x.com", [{ id: "a", label: "Jane", sub: "Owner", snapshot: { x: 1 } }]);
    expect(state.upserted).toEqual([{ id: "a", user_id: "u1", label: "Jane", sub: "Owner", data: { x: 1 } }]);
  });

  it("deletes by id on deleteHistory", async () => {
    await deleteHistory("jane@x.com", "a");
    expect(state.deleted).toBe("a");
  });
});

describe("history fallback (unauthenticated)", () => {
  beforeEach(() => { state.user = null; });
  it("reads/writes localStorage when there's no user", async () => {
    await writeHistory("anon@x.com", [{ id: "z", label: "Local", snapshot: {} }]);
    const out = await listHistory("anon@x.com", 0);
    expect(out.map((e) => e.id)).toContain("z");
    expect(state.upserted).toBe(null); // never hit the DB
  });
});
