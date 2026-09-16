// Runs Karma Leads' migrations before the merged server starts, preserving the
// behaviour its Dockerfile had ("migrations first, then serve — a failed
// migration stops the deploy loudly").
//
// Skipped, with exit 0, when Leads is switched off or has no database
// configured — otherwise every Karma Connect developer without the Leads
// database would be unable to run `npm start` at all.
//
// Node rather than `&&` in the npm script so it behaves the same on Windows
// (cmd) and on Render (sh).
import { spawnSync } from "node:child_process";

const enabled = process.env.LEADS_ENABLED !== "0";
const hasDb = Boolean(process.env.LEADS_DATABASE_URL || process.env.DATABASE_URL);

if (!enabled) {
  console.log("[leads] LEADS_ENABLED=0 — skipping migrations");
  process.exit(0);
}
if (!hasDb) {
  console.log("[leads] no LEADS_DATABASE_URL/DATABASE_URL — skipping migrations");
  process.exit(0);
}

const r = spawnSync(process.execPath, ["leads/server/migrate.js"], { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
