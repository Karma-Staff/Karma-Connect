import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { hit } = require("./ratelimit.cjs");
const { escapeHtml } = require("./email.cjs");

describe("ratelimit.hit", () => {
  it("allows up to max within the window, then blocks", () => {
    const now = 1_000_000;
    const key = "test:" + now; // unique per run
    const win = 60_000, max = 3;
    expect(hit(key, win, max, now)).toBe(true);   // 1
    expect(hit(key, win, max, now)).toBe(true);   // 2
    expect(hit(key, win, max, now)).toBe(true);   // 3
    expect(hit(key, win, max, now)).toBe(false);  // 4 -> over limit
  });

  it("resets after the window elapses", () => {
    const key = "reset:" + Date.now() + Math.floor(performance.now());
    expect(hit(key, 1000, 1, 5_000)).toBe(true);  // first in window
    expect(hit(key, 1000, 1, 5_500)).toBe(false); // same window, over
    expect(hit(key, 1000, 1, 7_000)).toBe(true);  // window elapsed -> allowed again
  });
});

describe("escapeHtml", () => {
  it("escapes HTML-significant characters", () => {
    expect(escapeHtml('<b>"x"</b> & \'y\'')).toBe("&lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; &#39;y&#39;");
  });
  it("handles empty / nullish input", () => {
    expect(escapeHtml("")).toBe("");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

// The LinkedIn agent's two pure guards. Everything the agent is allowed to do funnels through
// decide(), so these are the tests that matter most — a wrong `true` here is a message the
// agent sends when it shouldn't have.
const { decide, inWindow, LIMITS } = require("./linkedin-agent.cjs");

const on = { enabled: true };
const fresh = { day: 0, hour: 0, lastSent: null };
const WEEKDAY_10AM = { localHour: 10, localDay: 2 };

describe("linkedin-agent.inWindow", () => {
  it("allows a weekday inside business hours", () => {
    expect(inWindow(LIMITS.windowStart, 2)).toBe(true);
    expect(inWindow(LIMITS.windowEnd - 1, 2)).toBe(true);
  });

  it("blocks before the window opens and once it has closed", () => {
    expect(inWindow(LIMITS.windowStart - 1, 2)).toBe(false);
    expect(inWindow(LIMITS.windowEnd, 2)).toBe(false); // end hour is exclusive
  });

  it("blocks weekends while weekdaysOnly is on", () => {
    if (!LIMITS.weekdaysOnly) return;
    expect(inWindow(10, 0)).toBe(false); // Sunday
    expect(inWindow(10, 6)).toBe(false); // Saturday
  });
});

describe("linkedin-agent.decide", () => {
  it("refuses while the agent is off", () => {
    const d = decide({ state: { enabled: false }, counts: fresh, ...WEEKDAY_10AM });
    expect(d.ok).toBe(false);
    expect(d.allowed).toBe(0);
  });

  it("surfaces the halt reason instead of a generic message", () => {
    const d = decide({ state: { enabled: false, halt_reason: "Checkpoint" }, counts: fresh, ...WEEKDAY_10AM });
    expect(d.reason).toBe("Checkpoint");
  });

  it("hands out a batch when everything is clear", () => {
    const d = decide({ state: on, counts: fresh, ...WEEKDAY_10AM });
    expect(d.ok).toBe(true);
    expect(d.allowed).toBe(LIMITS.batch);
  });

  it("refuses outside the sending window", () => {
    expect(decide({ state: on, counts: fresh, localHour: 3, localDay: 2 }).ok).toBe(false);
  });

  it("refuses at the daily cap and at the hourly cap", () => {
    expect(decide({ state: on, counts: { ...fresh, day: LIMITS.perDay }, ...WEEKDAY_10AM }).ok).toBe(false);
    expect(decide({ state: on, counts: { ...fresh, hour: LIMITS.perHour }, ...WEEKDAY_10AM }).ok).toBe(false);
  });

  it("never hands out more than the headroom left under either cap", () => {
    const d = decide({ state: on, counts: { ...fresh, hour: LIMITS.perHour - 1 }, ...WEEKDAY_10AM });
    expect(d.allowed).toBe(1);
  });

  it("holds off until the minimum gap since the last send has passed", () => {
    const now = 2_000_000_000_000;
    const justSent = { day: 1, hour: 1, lastSent: new Date(now - 5_000).toISOString() };
    const d = decide({ state: on, counts: justSent, ...WEEKDAY_10AM, now });
    expect(d.ok).toBe(false);
    expect(d.retryInSec).toBeGreaterThan(0);

    const longAgo = { day: 1, hour: 1, lastSent: new Date(now - (LIMITS.minGapSec + 5) * 1000).toISOString() };
    expect(decide({ state: on, counts: longAgo, ...WEEKDAY_10AM, now }).ok).toBe(true);
  });
});
