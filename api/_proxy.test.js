import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { computeCost, COST } = require("./_proxy.cjs");

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
