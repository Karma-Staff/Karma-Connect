import { describe, it, expect } from "vitest";
import { scoreFit } from "./scoring.js";

const STRONG = {
  firstName: "Dana",
  lastName: "Cole",
  title: "Owner",
  company: "Cole Restoration Services",
  companyDesc: "Full-service water and fire damage restoration contractor.",
  industry: "Restoration",
  headline: "Owner at Cole Restoration",
  about: "20 years in property damage remediation.",
  experience: "Founder, restoration estimator",
  news: "Just opened a second office and is hiring crews after a busy storm season.",
  growth: "Wants to double revenue in 18 months.",
  staffing: "Struggling to keep estimators staffed.",
  ops: "Back-office admin is a bottleneck.",
  pain: "Spends nights on invoicing instead of jobs.",
};

describe("scoreFit", () => {
  it("is deterministic — same input, same output", () => {
    expect(scoreFit(STRONG)).toEqual(scoreFit(STRONG));
  });

  it("returns three dimensions plus an overall", () => {
    const f = scoreFit(STRONG);
    expect(f).toHaveProperty("icp");
    expect(f).toHaveProperty("qualification");
    expect(f).toHaveProperty("readiness");
    expect(typeof f.overall).toBe("number");
    expect(f.overall).toBe(Math.round((f.icp.score + f.qualification.score + f.readiness.score) / 3));
  });

  it("scores a strong, on-ICP, decision-maker prospect high across the board", () => {
    const f = scoreFit(STRONG);
    expect(f.icp.score).toBeGreaterThanOrEqual(90);
    expect(f.qualification.score).toBeGreaterThanOrEqual(90);
    expect(f.readiness.score).toBeGreaterThanOrEqual(90);
    expect(f.overall).toBeGreaterThanOrEqual(90);
    expect(f.icp.confidence).toBe("high");
  });

  it("gives an empty prospect zero with low confidence", () => {
    const f = scoreFit({});
    expect(f.overall).toBe(0);
    expect(f.icp.confidence).toBe("low");
    expect(f.readiness.score).toBe(0);
  });

  it("awards the full seniority factor only to owners/execs", () => {
    const owner = scoreFit({ title: "Owner" }).qualification.factors[0];
    const mgr = scoreFit({ title: "Operations Manager" }).qualification.factors[0];
    const ic = scoreFit({ title: "Estimator" }).qualification.factors[0];
    expect(owner.points).toBe(50);
    expect(mgr.points).toBe(35);
    expect(ic.points).toBe(15);
  });

  it("rewards a target industry over an off-ICP one", () => {
    const onIcp = scoreFit({ industry: "Restoration", company: "Acme Restoration" }).icp.score;
    const offIcp = scoreFit({ industry: "Cryptocurrency", company: "CoinThing" }).icp.score;
    expect(onIcp).toBeGreaterThan(offIcp);
  });

  it("requires buying signals for full readiness credit", () => {
    const hot = scoreFit({ news: "Hiring 10 crews after expansion." }).readiness.factors[0];
    const flat = scoreFit({ news: "Has a company page." }).readiness.factors[0];
    expect(hot.points).toBe(45);
    expect(flat.points).toBe(30);
  });

  it("every factor stays within its declared max", () => {
    const f = scoreFit(STRONG);
    [f.icp, f.qualification, f.readiness].forEach((d) => {
      d.factors.forEach((x) => {
        expect(x.points).toBeLessThanOrEqual(x.max);
        expect(x.points).toBeGreaterThanOrEqual(0);
      });
    });
  });
});
