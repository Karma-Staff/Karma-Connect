import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { fix } = require("./phonefix.js");

describe("phone fix", () => {
  it("leaves valid North American numbers exactly as typed", () => {
    for (const p of ["(941) 234-5678", "941.234.5678", "19412345678", "+1 941 234 5678", "941-234-5678 ext 12"])
      expect(fix(p)).toEqual({ status: "ok", phone: p });
  });

  it("splits extension digits glued onto a 10-digit number", () => {
    expect(fix("941-234-5678 1234")).toEqual({ status: "fixed", phone: "(941) 234-5678", ext: "1234" });
    expect(fix("94123456781234")).toEqual({ status: "fixed", phone: "(941) 234-5678", ext: "1234" });
  });

  it("splits them off an 11-digit number with the leading 1", () => {
    expect(fix("1 702 834 3440 22")).toEqual({ status: "fixed", phone: "(702) 834-3440", ext: "22" });
  });

  it("never touches a number written as international", () => {
    expect(fix("+94 71 234 5678")).toEqual({ status: "ok", phone: "+94 71 234 5678" });
  });

  it("reports what it cannot read instead of guessing", () => {
    expect(fix("234-5678").status).toBe("bad");                 // 7 digits, no area code
    expect(fix("0001112223334").status).toBe("bad");           // no real area code to anchor on
  });

  it("treats blank as fine", () => {
    expect(fix("").status).toBe("ok");
    expect(fix(null).status).toBe("ok");
  });
});
