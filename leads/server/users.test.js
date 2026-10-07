import { describe, it, expect } from "vitest";
import { createRequire } from "module";

/* users.js pulls in db.js, which refuses to load without a connection string.
   The rule under test touches no database — a dummy URL lets the module load;
   the pg Pool is lazy and never connects because nothing here queries. */
process.env.DATABASE_URL ||= "postgres://u:p@localhost:5432/test";

const require = createRequire(import.meta.url);
const { managerAssignmentError } = require("./users.js");

/* The designated-manager rule (migration 020). Pure, so it is tested with
   plain rows rather than a database. */
describe("designated manager assignment", () => {
  const rep = { id: 7, role: "sales_rep" };
  const member = { id: 8, role: "member" };
  const admin = { id: 2, role: "admin", disabled: false };
  const owner = { id: 1, role: "owner", disabled: false };

  it("clears cleanly — null candidate is always allowed", () => {
    expect(managerAssignmentError(rep, null)).toBeNull();
  });

  it("lets an admin cover a rep", () => {
    expect(managerAssignmentError(rep, admin)).toBeNull();
    expect(managerAssignmentError(member, admin)).toBeNull();
  });

  it("lets an owner cover a rep", () => {
    expect(managerAssignmentError(rep, owner)).toBeNull();
  });

  it("refuses a candidate who is not an admin or owner", () => {
    expect(managerAssignmentError(rep, { id: 9, role: "member", disabled: false }))
      .toMatch(/admin or owner/);
    expect(managerAssignmentError(rep, { id: 9, role: "sales_rep", disabled: false }))
      .toMatch(/admin or owner/);
  });

  it("refuses a disabled manager", () => {
    expect(managerAssignmentError(rep, { ...admin, disabled: true }))
      .toMatch(/disabled/);
  });

  it("refuses a manager who no longer exists", () => {
    expect(managerAssignmentError(rep, undefined)).toMatch(/no such manager/);
  });

  it("refuses making someone their own manager", () => {
    expect(managerAssignmentError({ id: 2, role: "admin" }, { id: 2, role: "admin", disabled: false }))
      .toMatch(/own manager/);
  });

  it("only reps get a designated manager — not admins or owners", () => {
    expect(managerAssignmentError({ id: 3, role: "admin" }, owner)).toMatch(/only reps/);
    expect(managerAssignmentError({ id: 1, role: "owner" }, admin)).toMatch(/only reps/);
  });
});
