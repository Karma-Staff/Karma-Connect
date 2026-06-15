// Applies db/schema.sql to the database in DATABASE_URL. Idempotent (everything is
// `create ... if not exists`), so it's safe to run repeatedly. Usage: `npm run db:init`.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));

// Load .env (local dev) so DATABASE_URL etc. are available without `--env-file`.
(function loadDotenv() {
  try {
    const file = join(here, "..", ".env");
    if (!existsSync(file)) return;
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch (e) { /* ignore */ }
})();

const schema = readFileSync(join(here, "..", "db", "schema.sql"), "utf8");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Put your Render Postgres connection string in .env.");
  process.exit(1);
}

// Render Postgres requires SSL. Local Postgres usually doesn't — toggle via PGSSL=off.
const ssl = process.env.PGSSL === "off" ? false : { rejectUnauthorized: false };
const client = new pg.Client({ connectionString: url, ssl });

try {
  await client.connect();
  await client.query(schema);
  console.log("✓ Schema applied to", url.replace(/:\/\/[^@]*@/, "://***@"));
} catch (e) {
  console.error("Schema apply failed:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
