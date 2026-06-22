import { describe, it, expect } from "vitest";
import { flagUnsupported } from "./verify.js";

// A realistic source: what buildContext would assemble from the user's entered data.
const SOURCE = `PROSPECT
Name: Jeremy Berg
Job title: Operations Director
Company: Armor Restoration
Industry: Property Restoration
Recent news / signals: expanding into the Dallas market after spring storms
SENDER (you are reaching out on behalf of):
Karma Staff helps restoration firms fill field crews fast.`;

const claims = (text) => flagUnsupported(text, SOURCE).map((f) => f.claim);

describe("flagUnsupported", () => {
  it("flags an invented stat not in the source", () => {
    expect(claims("We filled 14 roles for a similar firm last quarter.")).toContain("14");
  });

  it("flags invented money and percentage claims", () => {
    const c = claims("We cut their hiring costs by 30% and saved them $2M.");
    expect(c).toContain("30%");
    expect(c.some((x) => x.includes("2"))).toBe(true);
  });

  it("flags an invented brand name (CamelCase)", () => {
    expect(claims("I saw you used to work with ServiceMaster.")).toContain("ServiceMaster");
  });

  it("flags an invented multi-word company", () => {
    expect(claims("A mutual contact at Blue Sky Contracting suggested I reach out.")).toContain("Blue Sky Contracting");
  });

  it("does NOT flag the prospect's real name, company, or industry", () => {
    const c = claims("Hi Jeremy, I noticed Armor Restoration works in Property Restoration.");
    expect(c).toHaveLength(0);
  });

  it("does NOT flag a number that IS in the source", () => {
    // (no risky numbers here) and the Dallas signal is supported
    expect(claims("Congrats on expanding into the Dallas market.")).toHaveLength(0);
  });

  it("does NOT flag a standard meeting duration", () => {
    expect(claims("Could we grab 15 minutes next week?")).toHaveLength(0);
  });

  it("does NOT flag common Title-Case sign-offs", () => {
    expect(claims("Looking Forward to connecting. Best Regards, Sam")).toHaveLength(0);
  });

  it("does NOT flag small incidental numbers under ten", () => {
    expect(claims("Just 2 quick thoughts for you.")).toHaveLength(0);
  });

  it("returns nothing for empty input", () => {
    expect(flagUnsupported("", SOURCE)).toHaveLength(0);
  });
});
