import { describe, it, expect } from "vitest";
import { parseRetryAfter, backoffDelay, withRetry } from "./backoff.js";

describe("parseRetryAfter", () => {
  it("converts a seconds header to ms", () => {
    expect(parseRetryAfter("30")).toBe(30000);
    expect(parseRetryAfter("0")).toBe(0);
  });
  it("returns null for missing/invalid", () => {
    expect(parseRetryAfter(null)).toBe(null);
    expect(parseRetryAfter("")).toBe(null);
    expect(parseRetryAfter("nope")).toBe(null);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially and stays within [exp/2, exp]", () => {
    expect(backoffDelay(0, 500, 8000, () => 0)).toBe(250); // exp=500 -> 250
    expect(backoffDelay(0, 500, 8000, () => 1)).toBe(500);
    expect(backoffDelay(1, 500, 8000, () => 0)).toBe(500); // exp=1000 -> 500
    expect(backoffDelay(3, 500, 8000, () => 0)).toBe(2000); // exp=4000 -> 2000
  });
  it("respects the cap", () => {
    expect(backoffDelay(10, 500, 8000, () => 1)).toBe(8000); // capped exp=8000
  });
});

describe("withRetry", () => {
  const sleep = () => Promise.resolve(); // no real waiting in tests
  const rand = () => 0;

  it("returns immediately on a non-429 response", async () => {
    let calls = 0;
    const res = await withRetry(() => { calls++; return Promise.resolve({ status: 200 }); }, { sleep, rand });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("retries on 429 then succeeds", async () => {
    let calls = 0;
    const res = await withRetry(() => {
      calls++;
      return Promise.resolve(calls < 3 ? { status: 429, headers: { get: () => null } } : { status: 200 });
    }, { sleep, rand });
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
  });

  it("gives up after the retry cap and returns the 429", async () => {
    let calls = 0;
    const res = await withRetry(() => { calls++; return Promise.resolve({ status: 429, headers: { get: () => null } }); }, { retries: 2, sleep, rand });
    expect(res.status).toBe(429);
    expect(calls).toBe(3); // initial + 2 retries
  });

  it("honors Retry-After when present", async () => {
    const waits = [];
    const sleepSpy = (ms) => { waits.push(ms); return Promise.resolve(); };
    let calls = 0;
    await withRetry(() => {
      calls++;
      return Promise.resolve(calls < 2 ? { status: 429, headers: { get: (h) => (h === "Retry-After" ? "5" : null) } } : { status: 200 });
    }, { sleep: sleepSpy, rand });
    expect(waits).toEqual([5000]);
  });
});
