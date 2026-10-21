import { describe, it, expect } from "vitest";
import { createRequire } from "module";

// clients.js requires db.js, which refuses to load without a connection string; nothing here queries.
process.env.DATABASE_URL ||= "postgres://u:p@localhost:5432/test";
const require = createRequire(import.meta.url);
const { nameKey, toClient, _test } = require("./clients.js");

describe("recognising a client", () => {
  it("reduces a company name to the same key however it's written", () => {
    expect(nameKey("Acme Restoration, Inc.")).toBe(nameKey("ACME RESTORATION"));
    expect(nameKey("The Acme Restoration Co.")).toBe("acmerestoration");
    expect(nameKey("A&B Water Damage LLC")).toBe("abwaterdamage");
    expect(nameKey("")).toBe("");
  });

  it("reads a state written either way", () => {
    expect(_test.stateOf("FL")).toEqual({ ab: "FL", name: "florida" });
    expect(_test.stateOf("Florida")).toEqual({ ab: "FL", name: "florida" });
    expect(_test.stateOf("")).toEqual({ ab: null, name: null });
  });

  it("keeps what identifies a client, and refuses a row with nothing to go on", () => {
    const c = toClient({ company: "Acme Restoration", phone: "(512) 555-0100", email: "Ops@Acme.com", state: "Texas" });
    expect(c).toMatchObject({ phone_key: "5125550100", email: "ops@acme.com", state_ab: "TX", name_key: "acmerestoration" });
    expect(toClient({ contact: "Jane", city: "Austin" })).toBeNull();
    expect(toClient({ email: "not-an-email" })).toBeNull();
    expect(toClient({ phone: "512 555 0100" }).company).toBeNull();
  });

  it("uses the same name rule in SQL", () => {
    const sql = _test.nameKeySql("x");
    expect(sql).toContain("regexp_replace");
    expect(sql).toContain("inc|llc|ltd|co|corp|corporation|company|the|pllc|lp|llp");
  });
});
