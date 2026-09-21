import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { factsFrom, flatten } = require("./linkedin.js");

/* Apify's LinkedIn actors all return "the company" and none of them agree on
   how. These tests are the contract: whatever shape arrives, what reaches the
   briefing is plain labelled text, or nothing. An "[object Object]" in a
   briefing is a fact a rep cannot check and might repeat out loud. */

describe("flatten", () => {
  it("passes strings and numbers through", () => {
    expect(flatten("  Acme  ")).toBe("Acme");
    expect(flatten(11)).toBe("11");
  });

  it("joins arrays of strings", () => {
    expect(flatten(["Water damage", "Fire", "Mould"])).toBe("Water damage; Fire; Mould");
  });

  it("reads the meaning out of nested entries instead of stringifying them", () => {
    // the shape education/experience actually arrives in
    expect(flatten([{ schoolName: "Oklahoma State University", degreeName: "BSc" }]))
      .toBe("Oklahoma State University — BSc");
    expect(flatten([{ title: "Operations Manager", companyName: "SERVPRO", dateRange: "2019 - now" }]))
      .toBe("Operations Manager — SERVPRO — 2019 - now");
  });

  it("never emits [object Object]", () => {
    for (const v of [{ unknown: 1 }, [{ nope: true }], [[{ deep: 1 }]], { a: { b: 1 } }])
      expect(flatten(v)).not.toMatch(/\[object/);
  });

  it("stops descending rather than walking a deep structure", () => {
    expect(flatten([[["too deep"]]])).toBe("");
  });

  it("handles null and undefined", () => {
    expect(flatten(null)).toBe("");
    expect(flatten(undefined)).toBe("");
  });
});

describe("factsFrom", () => {
  it("returns nothing for an empty or junk dataset", () => {
    for (const bad of [null, undefined, [], [null], "not an array", [42]])
      expect(factsFrom(bad, "company")).toBe("");
  });

  it("labels a company however the actor spelled its fields", () => {
    // three actors, three spellings of the same four facts
    const a = factsFrom([{ companyName: "SERVPRO of Tulsa", description: "Restoration.",
      industryName: "Restoration", employeesCount: 30 }], "company");
    const b = factsFrom([{ name: "SERVPRO of Tulsa", about: "Restoration.",
      industry: "Restoration", companySize: "30" }], "company");
    const c = factsFrom([{ title: "SERVPRO of Tulsa", tagline: "Restoration.",
      industries: ["Restoration"], staffCount: 30 }], "company");
    for (const out of [a, b, c]) {
      expect(out).toContain("Name: SERVPRO of Tulsa");
      expect(out).toContain("Industry: Restoration");
      expect(out).toMatch(/Company size: 30/);
    }
  });

  it("asks for different fields for a person", () => {
    const out = factsFrom([{ fullName: "Dana Reed", headline: "Ops Manager",
      education: [{ schoolName: "Oklahoma State University" }],
      companySize: "30" }], "person");
    expect(out).toContain("Name: Dana Reed");
    expect(out).toContain("Education: Oklahoma State University");
    // a company-only field must not leak into a person briefing
    expect(out).not.toContain("Company size");
  });

  it("skips fields the actor did not return, rather than labelling blanks", () => {
    const out = factsFrom([{ name: "Acme", description: "", industry: null, specialties: [] }], "company");
    expect(out).toBe("Name: Acme");
  });

  it("uses the first row and ignores the rest", () => {
    const out = factsFrom([{ name: "First" }, { name: "Second" }], "company");
    expect(out).toContain("First");
    expect(out).not.toContain("Second");
  });

  it("caps a single field so one huge About cannot swamp the prompt", () => {
    const out = factsFrom([{ name: "Acme", description: "x".repeat(5000) }], "company");
    expect(out.length).toBeLessThan(1200);
  });
});
