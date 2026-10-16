import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { hit } = require("./ratelimit.cjs");
const { escapeHtml } = require("./email.cjs");
const { buildAgentZip } = require("./agent-bundle.cjs");

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
const { decide, inWindow, LIMITS, handleOf, nameKey } = require("./linkedin-agent.cjs");

const on = { enabled: true };
const fresh = { day: 0, hour: 0, invDay: 0, invWeek: 0, lastSent: null };
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

  it("stops messages at the daily cap and at the hourly cap", () => {
    expect(decide({ state: on, counts: { ...fresh, day: LIMITS.perDay }, ...WEEKDAY_10AM }).msg).toBe(0);
    expect(decide({ state: on, counts: { ...fresh, hour: LIMITS.perHour }, ...WEEKDAY_10AM }).msg).toBe(0);
  });

  it("never hands out more messages than the headroom left under either cap", () => {
    const d = decide({ state: on, counts: { ...fresh, hour: LIMITS.perHour - 1 }, ...WEEKDAY_10AM });
    expect(d.msg).toBe(1);
  });

  it("keeps invitations on their own budget", () => {
    const msgsDone = decide({ state: on, counts: { ...fresh, day: LIMITS.perDay }, ...WEEKDAY_10AM });
    expect(msgsDone.ok).toBe(true);
    expect(msgsDone.inv).toBeGreaterThan(0);
    const invDone = decide({ state: on, counts: { ...fresh, invDay: LIMITS.invitesPerDay }, ...WEEKDAY_10AM });
    expect(invDone.inv).toBe(0);
    expect(invDone.msg).toBeGreaterThan(0);
    expect(decide({ state: on, counts: { ...fresh, invWeek: LIMITS.invitesPerWeek }, ...WEEKDAY_10AM }).inv).toBe(0);
  });

  it("refuses, saying why, when both budgets are spent", () => {
    const d = decide({ state: on, counts: { ...fresh, day: LIMITS.perDay, invDay: LIMITS.invitesPerDay }, ...WEEKDAY_10AM });
    expect(d.ok).toBe(false);
    expect(d.allowed).toBe(0);
    expect(d.reason).toMatch(/message cap/);
    expect(d.reason).toMatch(/invitation cap/);
  });

  it("never hands out more than one batch in total", () => {
    const d = decide({ state: on, counts: fresh, ...WEEKDAY_10AM });
    expect(d.allowed).toBeLessThanOrEqual(LIMITS.batch);
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

describe("linkedin-agent matching", () => {
  it("reads the same profile from any spelling of its URL", () => {
    expect(handleOf("https://www.linkedin.com/in/Jane-Doe-12/?miniProfileUrn=x")).toBe("jane-doe-12");
    expect(handleOf("linkedin.com/in/jos%C3%A9-r")).toBe("josé-r");
    expect(handleOf("https://www.linkedin.com/company/acme/")).toBe("");
  });
  it("reduces names to letters", () => {
    expect(nameKey("  Jane O'Neil, CR ")).toBe("jane oneil cr");
  });
});

describe("agent-bundle.buildAgentZip", () => {
  const zip = buildAgentZip({ baseUrl: "https://example.test", email: "someone@example.test" });

  // The EOCD is the only way a reader finds the central directory. Getting these two offsets
  // wrong still produces a plausible-looking buffer that every unzip tool rejects, so pin them.
  it("writes a locatable end-of-central-directory record", () => {
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    const count = zip.readUInt16LE(eocd + 10);
    const size = zip.readUInt32LE(eocd + 12);
    const offset = zip.readUInt32LE(eocd + 16);
    expect(count).toBe(10);
    expect(offset + size).toBe(eocd);                    // directory ends where the EOCD starts
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);   // and starts on a central-dir header
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);        // file begins with a local header
  });

  it("ships the agent sources plus a generated setup", () => {
    const names = [];
    let p = 0;
    while (zip.readUInt32LE(p) === 0x04034b50) {
      const nameLen = zip.readUInt16LE(p + 26);
      names.push(zip.subarray(p + 30, p + 30 + nameLen).toString("utf8"));
      p += 30 + nameLen + zip.readUInt16LE(p + 28) + zip.readUInt32LE(p + 18);
    }
    expect(names).toContain("karma-connect-agent/send.cjs");
    expect(names).toContain("karma-connect-agent/invite.cjs");
    expect(names).toContain("karma-connect-agent/inbox.cjs");
    expect(names).toContain("karma-connect-agent/capture.cjs");
    expect(names).toContain("karma-connect-agent/SETUP.md");
    expect(names).toContain("karma-connect-agent/package.json");
  });

  // agent/.profile holds a live logged-in LinkedIn session. If the allowlist ever becomes a
  // directory walk, this is what catches it before one user's session ships to everyone.
  it("never includes the browser profile", () => {
    expect(zip.toString("latin1")).not.toContain(".profile");
  });
});
