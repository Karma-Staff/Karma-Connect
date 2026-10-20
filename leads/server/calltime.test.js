import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { check, regionOf } = require("./calltime.js");

// 2026-10-06 is in US daylight time: Eastern = UTC-4, Central -5, Mountain -6, Pacific -7, Arizona -7
const utc = (h, m = 0) => new Date(Date.UTC(2026, 9, 6, h, m));

describe("calling hours", () => {
  it("finds the region from the state, either spelling, else the area code", () => {
    expect(regionOf("TX", "")).toBe("TX");
    expect(regionOf("Texas", "")).toBe("TX");
    expect(regionOf("", "(212) 555-0199")).toBe("NY");
    expect(regionOf("", "+1 415 555 0199")).toBe("CA");
    expect(regionOf("", "+94 71 234 5678")).toBe(null);       // not North American
    expect(regionOf("", "")).toBe(null);
  });

  it("is open 8am to 9pm local, closed outside it", () => {
    expect(check({ state: "NY" }, utc(12)).open).toBe(true);    // 8:00am Eastern
    expect(check({ state: "NY" }, utc(11, 59)).open).toBe(false); // 7:59am
    expect(check({ state: "NY" }, utc(0, 59)).open).toBe(true);   // 8:59pm
    expect(check({ state: "NY" }, utc(1)).open).toBe(false);      // 9:00pm
  });

  it("an hour that is fine in New York can be too early in California", () => {
    const at = utc(13);                                          // 9am Eastern, 6am Pacific
    expect(check({ state: "NY" }, at).open).toBe(true);
    const ca = check({ state: "CA" }, at);
    expect(ca.open).toBe(false);
    expect(ca.local).toBe("6:00 AM");
    expect(ca.zone).toBe("Pacific");
    expect(ca.opensAt).toBe(utc(15).toISOString());             // 8am Pacific
  });

  it("a state spanning two zones opens only when both are open", () => {
    // 8:30am Eastern = 7:30am Central: Florida's panhandle is still early
    expect(check({ state: "FL" }, utc(12, 30)).open).toBe(false);
    expect(check({ state: "FL" }, utc(13)).open).toBe(true);    // 9am ET / 8am CT
  });

  it("holds nobody back whose zone is unknown", () => {
    expect(check({ state: "", phone: "" }, utc(3)).open).toBe(true);
  });
});

describe("lunch break", () => {
  it("is closed 12:00-1:30pm local, with the reason", () => {
    expect(check({ state: "NY" }, utc(15, 59)).open).toBe(true);    // 11:59am Eastern
    const noon = check({ state: "NY" }, utc(16));                   // 12:00pm
    expect(noon.open).toBe(false);
    expect(noon.lunch).toBe(true);
    expect(noon.opensAt).toBe(utc(17, 30).toISOString());           // 1:30pm Eastern
    expect(check({ state: "NY" }, utc(17, 29)).open).toBe(false);   // 1:29pm
    expect(check({ state: "NY" }, utc(17, 30)).open).toBe(true);    // 1:30pm
  });

  it("is the lead's own lunch, not the caller's", () => {
    expect(check({ state: "NY" }, utc(16, 30)).open).toBe(false);   // 12:30pm Eastern
    expect(check({ state: "CA" }, utc(16, 30)).open).toBe(true);    // 9:30am Pacific
  });

  it("a state spanning two zones is closed while either zone is at lunch", () => {
    expect(check({ state: "FL" }, utc(17)).open).toBe(false);       // 1pm ET / 12pm CT
    expect(check({ state: "FL" }, utc(17, 30)).lunch).toBe(true);   // 1:30pm ET / 12:30pm CT
    expect(check({ state: "FL" }, utc(18, 30)).open).toBe(true);    // 2:30pm ET / 1:30pm CT
  });

  it("an early or late hour is not called lunch", () => {
    const late = check({ state: "NY" }, utc(2));                     // 10pm Eastern
    expect(late.open).toBe(false);
    expect(late.lunch).toBe(false);
  });
});
