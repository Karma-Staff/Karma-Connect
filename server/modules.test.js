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
