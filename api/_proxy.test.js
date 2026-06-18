import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { computeCost, COST, signJWT, verifyJWT, JWT_ISS, sanitizeBody } = require("./_proxy.cjs");

describe("computeCost", () => {
  it("computes cost from per-1k constants (sonnet)", () => {
    const r = computeCost({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000 }, "claude-sonnet-4-6");
    // 1000/1k*0.003 + 500/1k*0.015 + 2000/1k*0.0003 = 0.003 + 0.0075 + 0.0006
    expect(r.cost_usd).toBeCloseTo(0.0111, 5);
    expect(r.total).toBe(1500); // input + output (cache not counted toward quota total)
    expect(r.inT).toBe(1000);
    expect(r.outT).toBe(500);
    expect(r.cacheT).toBe(2000);
  });

  it("uses the opus rates for opus", () => {
    const r = computeCost({ input_tokens: 1000, output_tokens: 1000 }, "claude-opus-4-8");
    expect(r.cost_usd).toBeCloseTo(0.005 + 0.025, 5);
  });

  it("falls back to the default rate for an unknown model", () => {
    const r = computeCost({ input_tokens: 1000, output_tokens: 0 }, "some-unknown-model");
    expect(r.cost_usd).toBeCloseTo(COST._default.in, 5);
  });

  it("handles missing usage fields as zero", () => {
    const r = computeCost({}, "claude-sonnet-4-6");
    expect(r.cost_usd).toBe(0);
    expect(r.total).toBe(0);
  });
});

describe("signJWT / verifyJWT", () => {
  const secret = "test-secret-xyz";

  it("round-trips claims and stamps aud/iss/exp", () => {
    const token = signJWT({ sub: "u1", email: "a@b.com" }, secret, 60);
    const claims = verifyJWT(token, secret, JWT_ISS);
    expect(claims).toBeTruthy();
    expect(claims.sub).toBe("u1");
    expect(claims.email).toBe("a@b.com");
    expect(claims.aud).toBe("authenticated");
    expect(claims.iss).toBe(JWT_ISS);
    expect(claims.exp).toBeGreaterThan(claims.iat);
  });

  it("rejects a token signed with the wrong secret", () => {
    const token = signJWT({ sub: "u1" }, secret, 60);
    expect(verifyJWT(token, "other-secret", JWT_ISS)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signJWT({ sub: "u1" }, secret, -1); // already expired
    expect(verifyJWT(token, secret, JWT_ISS)).toBeNull();
  });

  it("rejects a token from a different issuer", () => {
    const token = signJWT({ sub: "u1" }, secret, 60);
    expect(verifyJWT(token, secret, "some-other-issuer")).toBeNull();
  });
});

describe("sanitizeBody (proxy input caps — M4)", () => {
  it("rejects a model that isn't on the allowlist", () => {
    const r = sanitizeBody({ model: "claude-opus-4-8", max_tokens: 100 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it("allows the permitted models", () => {
    expect(sanitizeBody({ model: "claude-sonnet-4-6", max_tokens: 100 }).ok).toBe(true);
    expect(sanitizeBody({ model: "claude-haiku-4-5", max_tokens: 100 }).ok).toBe(true);
  });

  it("clamps max_tokens to the ceiling", () => {
    const r = sanitizeBody({ model: "claude-sonnet-4-6", max_tokens: 999999 });
    expect(r.ok).toBe(true);
    expect(r.body.max_tokens).toBe(8000);
  });

  it("defaults max_tokens when missing or invalid", () => {
    expect(sanitizeBody({ model: "claude-sonnet-4-6" }).body.max_tokens).toBe(1024);
  });

  it("caps web-search uses and the number of tools", () => {
    const r = sanitizeBody({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      tools: [
        { type: "web_search_20250305", name: "web_search", max_uses: 50 },
        { type: "web_search_20250305", name: "b", max_uses: 1 },
        { type: "web_search_20250305", name: "c", max_uses: 1 },
      ],
    });
    expect(r.body.tools.length).toBe(2); // MAX_TOOLS
    expect(r.body.tools[0].max_uses).toBe(4); // MAX_SEARCH_USES
  });

  it("rejects a non-object body", () => {
    expect(sanitizeBody(null).ok).toBe(false);
  });
});
