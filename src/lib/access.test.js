import { describe, it, expect } from "vitest";
import { ALLOWED_EMAILS, isAllowedEmail } from "./access.js";

describe("isAllowedEmail", () => {
  it("allows the configured address (case/space-insensitive)", () => {
    const e = ALLOWED_EMAILS[0];
    expect(isAllowedEmail(e)).toBe(true);
    expect(isAllowedEmail("  " + e.toUpperCase() + "  ")).toBe(true);
  });

  it("rejects anyone not on the list", () => {
    expect(isAllowedEmail("stranger@karmastaff.com")).toBe(false);
    expect(isAllowedEmail("tenzinwoesel@gmail.com")).toBe(false);
    expect(isAllowedEmail("")).toBe(false);
    expect(isAllowedEmail(null)).toBe(false);
  });
});
