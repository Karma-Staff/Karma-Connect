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
    expect(count).toBe(12);
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
    expect(names).toContain("karma-connect-agent/prospect.cjs");
    expect(names).toContain("karma-connect-agent/Connect-this-PC.bat");
    expect(names).toContain("karma-connect-agent/SETUP.md");
    expect(names).toContain("karma-connect-agent/package.json");
  });

  // agent/.profile holds a live logged-in LinkedIn session. If the allowlist ever becomes a
  // directory walk, this is what catches it before one user's session ships to everyone.
  it("never includes the browser profile", () => {
    expect(zip.toString("latin1")).not.toContain(".profile");
  });
});

// Each user sets their own limits on the LinkedIn agent page. Whatever they type, the agent
// must stay inside BOUNDS — these ceilings are what keep the LinkedIn account safe.
const { cleanSettings, limitsFor, BOUNDS } = require("./linkedin-agent.cjs");

describe("linkedin-agent settings", () => {
  it("no setting goes past its ceiling or below its floor", () => {
    const L = limitsFor({ settings: { perDay: 9999, perHour: -5, invitesPerWeek: 9999, minGapSec: 1, copiesPerDay: 0 } });
    expect(L.perDay).toBe(BOUNDS.perDay[1]);
    expect(L.perHour).toBe(BOUNDS.perHour[0]);
    expect(L.invitesPerWeek).toBe(BOUNDS.invitesPerWeek[1]);
    expect(L.minGapSec).toBe(BOUNDS.minGapSec[0]);
    expect(L.copiesPerDay).toBe(BOUNDS.copiesPerDay[0]);
  });

  it("keeps the limits consistent with each other", () => {
    const L = limitsFor({ settings: { perDay: 5, perHour: 12, invitesPerDay: 25, invitesPerWeek: 10, minGapSec: 300, maxGapSec: 60, windowStart: 18, windowEnd: 9 } });
    expect(L.perHour).toBe(5);
    expect(L.invitesPerDay).toBe(10);
    expect(L.maxGapSec).toBe(300);
    expect(L.windowEnd).toBeGreaterThan(L.windowStart);
  });

  it("drops unknown keys and junk values", () => {
    expect(cleanSettings({ perDay: "abc", batch: 50, leaseMin: 1, weekdaysOnly: "no", windowStart: 0 })).toEqual({ windowStart: 0 });
  });

  it("no settings means the defaults", () => {
    expect(limitsFor({ settings: {} }).perDay).toBe(LIMITS.perDay);
    expect(limitsFor(null).invitesPerDay).toBe(LIMITS.invitesPerDay);
  });

  it("a user's own window decides", () => {
    const L = limitsFor({ settings: { windowStart: 0, windowEnd: 24, weekdaysOnly: false } });
    expect(inWindow(3, 0, L)).toBe(true);
    expect(inWindow(3, 0)).toBe(false);
  });
});

describe("agent download", () => {
  // agent/.kc-agent.json is this PC's key to Karma Connect; it must never ship in the zip.
  it("never includes the device key, lock or log", () => {
    const z = buildAgentZip({ baseUrl: "https://example.test" });
    const names = [];
    for (let i = z.indexOf("PK\x01\x02", 0, "latin1"); i >= 0; i = z.indexOf("PK\x01\x02", i + 4, "latin1")) {
      const n = z.readUInt16LE(i + 28);
      names.push(z.slice(i + 46, i + 46 + n).toString("utf8"));
    }
    expect(names.length).toBeGreaterThan(5);
    expect(names.some((n) => /kc-agent|\.agent\.lock|agent\.log/.test(n))).toBe(false);
  });
});

// Invitations spread over the week: a different number each working day, adding up to the
// weekly target, never over the day's maximum (li-weekly.cjs).
describe("li-weekly.dailyTarget", () => {
  const { dailyTarget, workdaysLeft, localBounds } = require("./li-weekly.cjs");
  const { decide } = require("./linkedin-agent.cjs");
  // a week Monday (1) → Friday (5); each day sends exactly its target
  const runWeek = (accountId, weekNo, { weekCap = 80, maxPerDay = 25, skip = [] } = {}) => {
    let sent = 0; const days = [];
    for (const localDay of [1, 2, 3, 4, 5, 6, 0]) {
      const t = skip.includes(localDay) ? 0 : dailyTarget({ weekCap, maxPerDay, sentBeforeToday: sent, localDay, weekdaysOnly: true, accountId, dayIndex: weekNo * 7 + localDay });
      days.push(t); sent += t;
    }
    return { days, sent };
  };

  it("adds up to 80 over the week, every week, for every account", () => {
    for (let acct = 1; acct <= 20; acct++) for (let w = 0; w < 10; w++) {
      const { days, sent } = runWeek("acct-" + acct, w);
      expect(sent).toBe(80);
      expect(Math.max(...days)).toBeLessThanOrEqual(25);
      expect(days.slice(0, 5).every((n) => n >= 1)).toBe(true);
      expect(days[5] + days[6]).toBe(0);                // weekends off
    }
  });

  it("varies from day to day", () => {
    const seen = new Set();
    for (let w = 0; w < 5; w++) runWeek("acct-x", w).days.slice(0, 4).forEach((n) => seen.add(n));
    expect(seen.size).toBeGreaterThan(3);
  });

  it("the same day gives the same target on every check-in", () => {
    const a = { weekCap: 80, maxPerDay: 25, sentBeforeToday: 12, localDay: 2, weekdaysOnly: true, accountId: "a1", dayIndex: 20000 };
    expect(dailyTarget(a)).toBe(dailyTarget({ ...a }));
  });

  it("a day the PC was off leaves more for the days after, still 80", () => {
    expect(runWeek("acct-off", 3, { skip: [2] }).sent).toBe(80);
  });

  it("stops at the weekly target", () => {
    expect(dailyTarget({ weekCap: 80, maxPerDay: 25, sentBeforeToday: 80, localDay: 3, weekdaysOnly: true, accountId: "a", dayIndex: 1 })).toBe(0);
  });

  it("can only reach maxPerDay × days when the day's maximum is low", () => {
    expect(runWeek("acct-low", 1, { maxPerDay: 15 }).sent).toBe(75);
  });

  it("counts working days left from today", () => {
    expect(workdaysLeft(1, true)).toBe(5);
    expect(workdaysLeft(5, true)).toBe(1);
    expect(workdaysLeft(0, false)).toBe(1);
    expect(workdaysLeft(1, false)).toBe(7);
  });

  it("finds the PC's midnight and Monday", () => {
    const now = Date.UTC(2026, 9, 21, 15, 30, 0);       // Wed 15:30 UTC = 11:30 in New York (UTC-4)
    const b = localBounds({ now, localHour: 11, localDay: 3, localMinute: 30 });
    expect(new Date(b.todayStart).toISOString()).toBe("2026-10-21T04:00:00.000Z");
    expect(new Date(b.weekStart).toISOString()).toBe("2026-10-19T04:00:00.000Z");
  });

  it("decide() uses today's target in place of the daily cap", () => {
    const base = { day: 0, hour: 0, invDay: 30, invWeek: 30, lastSent: null };
    const go = decide({ state: { enabled: true }, counts: { ...base, invTarget: 19, invToday: 17, invThisWeek: 30 }, localHour: 10, localDay: 2 });
    expect(go.inv).toBe(2);
    const done = decide({ state: { enabled: true }, counts: { ...base, day: 99, invTarget: 19, invToday: 19, invThisWeek: 30 }, localHour: 10, localDay: 2 });
    expect(done.inv).toBe(0);
    expect(done.reason).toMatch(/Today's invitation target reached \(19 of 80/);
  });
});

describe("li-weekly.weekTarget", () => {
  const { weekTarget, dailyTarget } = require("./li-weekly.cjs");
  it("is a different total each week, 60–80 for 80, fixed for the week", () => {
    const seen = new Set();
    for (let w = 0; w < 30; w++) {
      const t = weekTarget({ weekCap: 80, accountId: "acct-1", weekIndex: 20000 + w * 7 });
      expect(t).toBeGreaterThanOrEqual(60);
      expect(t).toBeLessThanOrEqual(80);
      expect(weekTarget({ weekCap: 80, accountId: "acct-1", weekIndex: 20000 + w * 7 })).toBe(t);
      seen.add(t);
    }
    expect(seen.size).toBeGreaterThan(8);
  });
  it("the days add up to that week's total", () => {
    for (let w = 0; w < 30; w++) {
      const cap = weekTarget({ weekCap: 80, accountId: "a2", weekIndex: w * 7 });
      let sent = 0;
      for (const d of [1, 2, 3, 4, 5]) sent += dailyTarget({ weekCap: cap, maxPerDay: 25, sentBeforeToday: sent, localDay: d, weekdaysOnly: true, accountId: "a2", dayIndex: w * 7 + d });
      expect(sent).toBe(cap);
    }
  });
});

// The LinkedIn agent's prospecting: who it invites (skipReason) and what it searches (searchUrl).
// A wrong null here is an invitation sent to the wrong person, so the cases are realistic headlines.
describe("li-prospecting.skipReason", () => {
  const { skipReason, searchUrl, splitHeadline, SPECS } = require("./li-prospecting.cjs");
  const card = (headline, more = {}) => ({ handle: "jane-doe", name: "Jane Doe", headline, location: "Dallas, Texas, United States", degree: "2nd", ...more });

  it("keeps owners and leaders at restoration companies, franchises included", () => {
    for (const h of [
      "Owner/Operator at SERVPRO of North Dallas",
      "President, Acme Restoration & Construction",
      "Franchise Owner | PuroClean of Tampa",
      "Owner at Acme Restoration | Water · Fire · Mold · 24/7",
      "CEO & Founder, Rapid Water Damage Restoration",
      "Co-Owner | Fire & Flood Reconstruction",
      "Owner & Estimator at Smith Mitigation Services",          // a small company's owner does a bit of everything
      "President & Sales Manager at Acme Restoration Inc.",
      "Owner at Acme Restoration (former SERVPRO franchisee)",
      "Past President of RIA | Owner, Acme Disaster Services",
      "Managing Partner at Paul Davis Restoration of Ottawa",
      "General Manager at BELFOR Property Restoration",
      "Director of Operations – ServiceMaster Restore of Calgary",
      "Vice President of Operations, First Onsite",
      "Operations Manager at Rainbow Restoration of Phoenix",
      "Branch Manager | BluSky Restoration Contractors",
      "Regional Manager, ATI Restoration",
      "Owner at Acme Carpet Cleaning & Water Damage Restoration",
      "Founder & CEO at DryMedic of Houston",
      "Chairman, Acme Catastrophe Response Group",
      "Owner at Acme Restoration | Now hiring technicians",
      "Owner of Acme Mold Remediation, IICRC certified",
    ]) expect(skipReason(card(h)), h).toBeNull();
  });

  it("skips the people who work for a leader, want a job, or have left", () => {
    for (const h of [
      "Water Damage Technician at Acme Restoration",
      "Project Manager at SERVPRO of Tampa",
      "Restoration Project Manager | BELFOR",
      "Estimator at Paul Davis Restoration",
      "Sales Manager at Acme Restoration",
      "Business Development Manager at PuroClean of Dallas",
      "Account Manager at First Onsite",
      "Director of Business Development at Rytech",
      "Vice President of Sales at Acme Restoration",
      "VP Marketing | ServiceMaster Restore",
      "Executive Assistant to the Owner, Acme Restoration",
      "Assistant General Manager at SERVPRO of Austin",
      "Former Owner at Acme Restoration",
      "Retired owner of Acme Water Damage Restoration",
      "Seeking new opportunities in restoration management",
      "Restoration professional | Open to work",
      "Operations Manager / Project Manager at Acme Mitigation",
      "Marketing Coordinator at Belfor",
      "Director of Operations & Sales, Acme Restoration",
      "Product Owner at Restoration Software Co",
    ]) expect(skipReason(card(h)), h).toBe("not a decision-maker");
  });

  it("skips vendors, competitors and the insurance side", () => {
    for (const h of [
      "Owner at Restoration Marketing Agency | SEO for restoration contractors",
      "Founder & CEO, Restoration Software for contractors",
      "Owner, Restoration Equipment Supply",
      "CEO at Restoration Staffing Solutions",
      "Owner | Public Adjuster | Fire & Water Damage Claims",
      "President, Acme Insurance Agency | Water damage claims",
      "Owner at Restoration Consulting Group",
      "Partner at Smith & Jones Law | Fire damage litigation",
      "Claims Manager at Acme Restoration",                          // insurance-side title, even at a restoration company
    ]) expect(["sells to restoration companies", "not a decision-maker"], h).toContain(skipReason(card(h)));
  });

  it("skips leaders outside restoration, including the other kinds of restoration", () => {
    for (const h of [
      "Owner at Smith Plumbing",
      "CEO, Bright Software",
      "Owner at Elite Hair Restoration Clinic",
      "President of Classic Car Restoration Inc",
      "General Manager at Restoration Hardware",
      "Founder, Restoration Church",
      "Director of Operations at Wetland Restoration Partners",
      "Owner at Acme Furniture Restoration",
      "Owner at Acme Roofing & Siding",
    ]) expect(skipReason(card(h)), h).toBe("not a restoration company");
  });

  it("keeps US and Canadian locations and skips the rest", () => {
    const h = "Owner at Acme Restoration";
    for (const loc of ["Toronto, Ontario, Canada", "Dallas-Fort Worth Metroplex", "Greater Vancouver Metropolitan Area",
      "Albuquerque, New Mexico, United States", "Jamaica, New York, United States", "United States", ""]) {
      expect(skipReason(card(h, { location: loc })), loc).toBeNull();
    }
    for (const loc of ["London, England, United Kingdom", "Sydney, New South Wales, Australia", "Mumbai, Maharashtra, India", "Mexico City, Mexico", "Dubai, United Arab Emirates"]) {
      expect(skipReason(card(h, { location: loc })), loc).toBe("outside the US and Canada");
    }
  });

  it("splits franchise and comma headlines into title and company", () => {
    expect(splitHeadline("Owner/Operator at SERVPRO of North Dallas")).toEqual({ title: "Owner/Operator", company: "SERVPRO of North Dallas" });
    expect(splitHeadline("Franchise Owner | PuroClean of Tampa")).toEqual({ title: "Franchise Owner", company: "PuroClean of Tampa" });
    expect(splitHeadline("President, Acme Restoration & Construction")).toEqual({ title: "President", company: "Acme Restoration & Construction" });
    expect(splitHeadline("Owner at Acme Restoration, Inc. | Water & Fire")).toEqual({ title: "Owner", company: "Acme Restoration, Inc." });
  });

  it("puts the title in the title filter and the trade in the keywords, with LinkedIn's boolean syntax", () => {
    const u = new URL(searchUrl(SPECS[0]));
    expect(u.pathname).toBe("/search/results/people/");
    expect(u.searchParams.get("keywords")).toBe("restoration");
    expect(u.searchParams.get("titleFreeText")).toBe('(owner OR "co-owner" OR proprietor OR franchisee) NOT adjuster NOT recruiter NOT technician NOT estimator NOT sales');
    // "president" would also match every vice president, so that group alone rules them out
    expect(new URL(searchUrl(SPECS[5])).searchParams.get("titleFreeText")).toMatch(/^\(president .*\) NOT "vice president" NOT adjuster/);
    expect(new URL(searchUrl(SPECS[20])).searchParams.get("titleFreeText")).not.toMatch(/NOT "vice president"/);
    expect(JSON.parse(u.searchParams.get("geoUrn"))).toEqual(["103644278", "101174742"]);
    expect(JSON.parse(u.searchParams.get("network"))).toEqual(["S", "O"]);
    expect(u.searchParams.get("origin")).toBe("FACETED_SEARCH");
    expect(u.searchParams.has("page")).toBe(false);
    expect(new URL(searchUrl(SPECS[SPECS.length - 1])).searchParams.get("page")).toBe("3");
    for (const s of SPECS) expect(searchUrl(s)).not.toMatch(/\b(?:and|or|not)\b/);   // LinkedIn needs them in uppercase
  });

  it("works the highest-yield searches first and every first page before any second page", () => {
    expect(SPECS.length).toBe(75);
    expect(SPECS[0]).toMatchObject({ title: "owners", trade: "restoration", page: 1 });
    expect(SPECS.slice(0, 5).every((s) => s.title === "owners" && s.page === 1)).toBe(true);
    expect(SPECS[5]).toMatchObject({ title: "presidents", page: 1 });
    const firstPage2 = SPECS.findIndex((s) => s.page === 2);
    expect(SPECS.slice(0, firstPage2).every((s) => s.page === 1)).toBe(true);
    expect(new Set(SPECS.map((s) => s.title + "|" + s.trade + "|" + s.page)).size).toBe(SPECS.length);
    // an account's stored cursor from the old, longer list still lands on a search
    expect(SPECS[89 % SPECS.length]).toBeTruthy();
  });
});
