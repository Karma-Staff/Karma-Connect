import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { skipReason, splitHeadline, searchUrl, noteFor, SPECS } = require("./li-prospecting.cjs");

const c = (headline, more = {}) => ({ handle: "jane-doe", name: "Jane Doe", headline, degree: "2nd", ...more });

describe("who the agent invites", () => {
  it("takes owners and operations leaders at restoration companies", () => {
    for (const h of [
      "Owner at Acme Restoration",
      "President | SERVPRO of North Tampa",
      "CEO & Founder, Rapid Water Damage Restoration",
      "General Manager at PuroClean of Ottawa",
      "Director of Operations – Belfor Property Restoration",
      "Operations Manager at Paul Davis Restoration",
      "Branch Manager, Mitigation Services Inc",
      "Co-Owner | Fire & Flood Reconstruction",
    ]) expect(skipReason(c(h)), h).toBeNull();
  });

  it("skips people who aren't decision-makers", () => {
    for (const h of [
      "Water Damage Technician at Acme Restoration",
      "Estimator | SERVPRO",
      "Marketing Coordinator at Belfor",
      "Office Assistant to the Owner, Acme Restoration",
      "Former Owner at Acme Restoration",
      "Seeking new opportunities in restoration management",
      "Sales Rep at PuroClean",
    ]) expect(skipReason(c(h)), h).toBe("not a decision-maker");
  });

  it("skips decision-makers outside restoration", () => {
    expect(skipReason(c("Owner at Smith Plumbing"))).toBe("not a restoration company");
    expect(skipReason(c("CEO, Bright Software"))).toBe("not a restoration company");
  });

  it("skips hidden names, existing connections and missing links", () => {
    expect(skipReason(c("Owner at Acme Restoration", { name: "LinkedIn Member" }))).toBe("name hidden");
    expect(skipReason(c("Owner at Acme Restoration", { degree: "1st" }))).toBe("already a connection");
    expect(skipReason(c("Owner at Acme Restoration", { handle: "" }))).toBe("no profile link");
  });
});

describe("the lead saved for them", () => {
  it("splits a headline into title and company", () => {
    expect(splitHeadline("Owner at Acme Restoration")).toEqual({ title: "Owner", company: "Acme Restoration" });
    expect(splitHeadline("President | SERVPRO of North Tampa | Storm team")).toEqual({ title: "President", company: "SERVPRO of North Tampa" });
    expect(splitHeadline("Restoration professional")).toEqual({ title: "Restoration professional", company: "" });
  });
});

describe("the search and the note", () => {
  it("searches the US and Canada, never existing connections", () => {
    const u = new URL(searchUrl({ title: "owner", trade: "restoration", page: 2 }));
    expect(u.pathname).toBe("/search/results/people/");
    expect(u.searchParams.get("keywords")).toBe("restoration");
    expect(u.searchParams.get("titleFreeText")).toMatch(/^\(owner\) NOT /);
    expect(JSON.parse(u.searchParams.get("geoUrn"))).toEqual(["103644278", "101174742"]);
    expect(JSON.parse(u.searchParams.get("network"))).toEqual(["S", "O"]);
    expect(u.searchParams.get("page")).toBe("2");
  });

  it("works through every title and trade before repeating", () => {
    const keys = new Set(SPECS.map((s) => s.title + "|" + s.trade + "|" + s.page));
    expect(keys.size).toBe(SPECS.length);
    expect(SPECS[0].page).toBe(1);
  });

  it("keeps the note under LinkedIn's 300 characters", () => {
    const n = noteFor("Jane", "Scott");
    expect(n.startsWith("Hi Jane, ")).toBe(true);
    expect(n.endsWith("– Scott")).toBe(true);
    expect(n.length).toBeLessThanOrEqual(300);
    expect(noteFor("", "")).toMatch(/^Hi, /);
  });
});
