import { describe, it, expect } from "vitest";
import { buildContext, pConnection, pMeeting, companyResearchPrompt } from "./prompts.js";

const PROSPECT = {
  firstName: "Jane", lastName: "Doe", title: "Owner", company: "Acme Restoration",
  industry: "Property Restoration", location: "Dallas, TX", headline: "", about: "",
  experience: "", website: "", companyDesc: "", news: "", notes: "", mutual: "",
  research: "", pain: "", growth: "", staffing: "", ops: "",
};

describe("buildContext", () => {
  it("includes only non-empty prospect fields", () => {
    const ctx = buildContext(PROSPECT, "SENDER OFFER", null, "");
    expect(ctx).toContain("Name: Jane Doe");
    expect(ctx).toContain("Job title: Owner");
    expect(ctx).toContain("SENDER OFFER");
    expect(ctx).not.toContain("LinkedIn about:"); // empty field omitted
  });

  it("appends the analysis profile when provided", () => {
    const ctx = buildContext(PROSPECT, "OFFER", { persona: "busy owner" }, "");
    expect(ctx).toContain("YOUR INTELLIGENCE PROFILE");
    expect(ctx).toContain("busy owner");
  });
});

describe("pConnection", () => {
  it("requests the given count and bakes in the 300-char rule", () => {
    const p = pConnection("BASE", 10, []);
    expect(p).toContain("Write 10 DISTINCT");
    expect(p).toMatch(/300 characters or fewer/);
  });

  it("injects an avoid list when provided", () => {
    expect(pConnection("BASE", 5, ["warm intro", "shared city"])).toContain("warm intro; shared city");
  });
});

describe("pMeeting", () => {
  it("includes the mandatory format and the trust-marker instruction", () => {
    const p = pMeeting("BASE", 10, "standard", []);
    expect(p).toContain("MANDATORY FORMAT");
    expect(p).toMatch(/IICRC certified|vendor member of RIA/);
    expect(p).toContain("www.karmastaff.com");
  });
});

describe("companyResearchPrompt", () => {
  it("asks for company-only JSON and seeds the company name/url", () => {
    const p = companyResearchPrompt(PROSPECT, "https://acme.com");
    expect(p).toContain("https://acme.com");
    expect(p).toContain("Acme Restoration");
    expect(p).toContain('"companyDesc"');
  });
});
