import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { assess, bandOf, readProviderStatus, isVoiceNumber } = require("./reputation-engine.js");

/* The failure these guard against is the one that matters most here: telling
   a manager a number is fine when we simply do not know. */

const NOW = Date.parse("2026-10-06T16:00:00Z");
const ME = "+17038901856";
const num = { number: ME, usage: "MainCompanyNumber", status: "Normal", callerIdName: "KARMA STAFF" };
let seq = 0;
const call = (daysAgo, o = {}) => ({
  t: NOW - daysAgo * 864e5 - (seq++ % 1000) * 1000, dur: 60, dir: "Outbound", res: "Call connected",
  fromNum: ME, toNum: "+1555" + String(1000000 + seq).slice(-7), ...o,
});
const sig = (r, key) => r.signals.find((s) => s.key === key);

describe("assess — the Karma Connect Risk Score", () => {
  it("scores a steady, well-answered number low", () => {
    const calls = [...Array.from({ length: 60 }, (_, i) => call(1 + (i % 6))),
      ...Array.from({ length: 50 }, (_, i) => call(8 + (i % 6)))];
    const r = assess({ number: num, calls, now: NOW });
    expect(r.band).toBe("low");
    expect(r.score).toBeLessThan(30);
    expect(sig(r, "answer_rate").state).toBe("not_detected");
  });

  it("scores a number that looks burned high, and says why", () => {
    const calls = [
      // 200 calls this week, 30 last week: a spike, and a 150+ day
      ...Array.from({ length: 170 }, () => call(1, { res: "No Answer", dur: 3 })),
      ...Array.from({ length: 20 }, () => call(2, { res: "Call connected", dur: 4 })),
      ...Array.from({ length: 10 }, () => call(3, { res: "No Answer", dur: 25 })),
      ...Array.from({ length: 30 }, () => call(9)),
    ];
    const r = assess({ number: num, calls, now: NOW });
    expect(r.score).toBeGreaterThanOrEqual(60);
    expect(["high", "critical"]).toContain(r.band);
    for (const k of ["volume_anomaly", "answer_rate", "short_call_ratio", "abandonment"])
      expect(sig(r, k).state).toBe("detected");
    // every point is attached to a reason
    expect(r.signals.reduce((s, x) => s + x.points, 0)).toBeGreaterThanOrEqual(r.score);
    for (const s of r.signals.filter((x) => x.points)) expect(s.detail).toBeTruthy();
  });

  it("calls a quiet number unknown, not healthy", () => {
    const r = assess({ number: num, calls: [call(1), call(2)], now: NOW });
    expect(sig(r, "answer_rate").state).toBe("unknown");
    expect(sig(r, "short_call_ratio").state).toBe("unknown");
    expect(r.confidence).toBeLessThan(0.5);
  });

  it("never claims provider-only signals without a provider", () => {
    const r = assess({ number: num, calls: [], now: NOW });
    for (const k of ["spam_complaints", "scam_reports", "carrier_reputation", "number_age", "registration"])
      expect(sig(r, k).state).toBe("unknown");
  });

  it("marks provider signals verified only when a provider supplied them", () => {
    const r = assess({ number: num, calls: [], now: NOW,
      verified: { carrier_reputation: { value: "Flagged", source: "hiya" } } });
    expect(sig(r, "carrier_reputation").state).toBe("verified");
    expect(sig(r, "spam_complaints").state).toBe("unknown");
  });

  it("counts repeat dialling and opt-outs", () => {
    const to = "+15550001111";
    const calls = [
      ...Array.from({ length: 3 }, (_, i) => call(1, { toNum: to, t: NOW - 864e5 - i * 3600e3 })),
      ...Array.from({ length: 40 }, () => call(2)),
    ];
    const ours = calls.slice(3, 23).map((c, i) => ({ at: c.t + c.dur * 1000, number: c.toNum,
      disposition: i < 3 ? "Do Not Contact" : "Interested" }));
    const r = assess({ number: num, calls, ours, now: NOW });
    expect(sig(r, "repeated_calls").state).toBe("detected");
    expect(sig(r, "opt_outs").state).toBe("detected");
  });

  it("flags caller-ID set-up problems", () => {
    const r = assess({ number: { ...num, callerIdName: "", status: "Suspended" }, calls: [], now: NOW });
    expect(sig(r, "callerid_config").state).toBe("detected");
    expect(r.score).toBe(15);
  });
});

describe("bands and statuses", () => {
  it("bands the score at the documented edges", () => {
    expect(bandOf(0).key).toBe("low");
    expect(bandOf(29).key).toBe("low");
    expect(bandOf(30).key).toBe("moderate");
    expect(bandOf(60).key).toBe("high");
    expect(bandOf(80).key).toBe("critical");
  });

  it("reads Hiya's states, and anything unreadable as unknown", () => {
    expect(readProviderStatus("flagged")).toBe("flagged");
    expect(readProviderStatus("mixed_high")).toBe("potentially_flagged");
    expect(readProviderStatus("mixed_low")).toBe("at_risk");
    expect(readProviderStatus("unflagged")).toBe("good");
    expect(readProviderStatus("")).toBe("unknown");
    expect(readProviderStatus("something-new")).toBe("unknown");
  });

  it("leaves fax lines out", () => {
    expect(isVoiceNumber({ usage: "CompanyFaxNumber" })).toBe(false);
    expect(isVoiceNumber({ usage: "DirectNumber" })).toBe(true);
  });
});
