"use strict";
/* One pg pool for the whole domain API.

   Configuration comes from the environment; in dev the .env.server file in the
   repo root supplies it (process.loadEnvFile is built into Node ≥20.12 — no
   dotenv dependency). A missing file is fine: production sets real env vars.

   Why .env.SERVER and not .env: NocoDB auto-loads `.env` from its working
   directory, and while the legacy `node index.js` server still runs from this
   folder, a DATABASE_URL in `.env` sends NocoDB's metadata schema into the
   app database (it happened — see scripts/cleanup-nocodb-pollution.sql).
   `.env` holds only the compose passwords; everything the API needs is here. */

const path = require("path");

try { process.loadEnvFile(path.join(__dirname, "..", ".env.server")); }
catch { /* no .env.server — env vars must be set for real */ }

/* On the merged Karma site this process also runs Karma Connect, which talks to
   a DIFFERENT database. Leads therefore reads LEADS_DATABASE_URL first so the
   two can never end up sharing a connection string; standing alone (local dev,
   the old single-app deploy) DATABASE_URL still works exactly as before. */
const CONNECTION = process.env.LEADS_DATABASE_URL || process.env.DATABASE_URL;

if (!CONNECTION)
  throw new Error("LEADS_DATABASE_URL (or DATABASE_URL) is not set — copy .env.example to .env/.env.server");

const { Pool, types } = require("pg");

/* bigint columns (every id here) come back as strings by default; nothing in
   this app will ever exceed 2^53, and the front end does arithmetic on ids.

   Scoped to THIS pool rather than pg's process-wide registry: Karma Connect
   shares the process, has bigint columns of its own, and reads uncast count()
   and sum() results that must keep arriving as strings. types.setTypeParser()
   here would silently retype Connect's rows too. */
const leadsTypes = {
  getTypeParser: (oid, format) =>
    (oid === 20 ? (v) => parseInt(v, 10) : types.getTypeParser(oid, format)),
};

/* Render REQUIRES SSL on external connections and merely permits it on internal
   ones, so SSL is on by default and works for both. Without it an external
   connection dies as ECONNRESET, which reads like a network fault rather than a
   missing option. rejectUnauthorized stays false because Render terminates TLS
   with its own certificate chain, the same trade Karma Connect's pool makes
   against the same platform. PGSSL=off for a local Postgres that has no TLS. */
const pool = new Pool({
  connectionString: CONNECTION,
  types: leadsTypes,
  ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: false },
  max: 10,                       // single instance, ~12 concurrent users — plenty
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
});

pool.on("error", (e) => console.error("[karma] idle pg client error:", e.message));

/* the two shapes every route uses */
const query = (text, params) => pool.query(text, params);
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
