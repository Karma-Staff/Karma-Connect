"use strict";
/* Small admin CLI — the things that need a terminal, not an endpoint.

     node server/cli.js token:create <name> [scope ...]   mint a service token
     node server/cli.js token:revoke <name>               revoke by name
     node server/cli.js token:list
     node server/cli.js user:add <email> [admin|member]   invite / promote

   The minted token is printed ONCE and stored only as a hash — copy it into
   the pipeline's environment (KARMA_API_TOKEN) right away. */

const { query, pool } = require("./db");
const { mintToken, sha256 } = require("./service-auth");

async function main() {
  const [cmd, a, ...rest] = process.argv.slice(2);
  if (cmd === "token:create") {
    if (!a) throw new Error("usage: token:create <name> [scope ...]");
    const scopes = rest.length ? rest : ["imports:write"];
    const token = mintToken();
    await query(
      `INSERT INTO service_tokens (name, token_hash, scopes) VALUES ($1, $2, $3)`,
      [a, sha256(token), scopes]);
    console.log(`service token for "${a}" (scopes: ${scopes.join(", ")}):\n\n  ${token}\n`);
    console.log("shown once — set it as KARMA_API_TOKEN now.");
  } else if (cmd === "token:revoke") {
    const r = await query(
      `UPDATE service_tokens SET revoked_at = now()
       WHERE name = $1 AND revoked_at IS NULL`, [a]);
    console.log(`revoked ${r.rowCount} token(s) named "${a}"`);
  } else if (cmd === "token:list") {
    for (const t of (await query(
      `SELECT name, scopes, created_at, revoked_at FROM service_tokens
       ORDER BY created_at`)).rows)
      console.log(`${t.revoked_at ? "REVOKED " : "active  "} ${t.name}  ` +
        `[${t.scopes.join(",")}]  since ${t.created_at.toISOString().slice(0, 10)}`);
  } else if (cmd === "user:add") {
    if (!a) throw new Error("usage: user:add <email> [admin|member]");
    const role = rest[0] === "admin" ? "admin" : "member";
    const email = a.trim().toLowerCase();
    const u = (await query(
      `INSERT INTO app_users (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET disabled = false RETURNING id`,
      [email])).rows[0];
    const org = (await query(
      "SELECT id FROM organizations ORDER BY id LIMIT 1")).rows[0];
    await query(
      `INSERT INTO organization_memberships (org_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = $3`,
      [org.id, u.id, role]);
    console.log(`${email} is now a ${role}`);
  } else if (cmd === "user:prune-except") {
    /* Delete every account except the one named. For handing a system to a
       single owner who will then invite people back deliberately.

       The survivor is named rather than defaulted, and --yes is required,
       because the failure mode is deleting everyone including yourself.

       History is kept. activity_log.user_id and lead_comments.author_user_id
       are nullable and both tables carry the email in a NOT NULL column of
       their own (actor, author_email), so the link goes and the record of who
       did what stays. One transaction, so a failure changes nothing. */
    const keep = String(a || "").trim().toLowerCase();
    if (!keep) throw new Error("usage: user:prune-except <email> --yes");
    const rows = (await query(
      `SELECT u.id, u.email, m.role FROM app_users u
       LEFT JOIN organization_memberships m ON m.user_id = u.id ORDER BY u.id`)).rows;
    const keeper = rows.find((r) => r.email === keep);
    if (!keeper) throw new Error(`${keep} is not an account — refusing to delete everyone`);
    const going = rows.filter((r) => r.email !== keep);
    if (!rest.includes("--yes")) {
      console.log(`Would delete ${going.length} account(s), keeping ${keep} as admin:`);
      for (const r of going) console.log(`  ${r.email} (${r.role || "no role"})`);
      console.log("\nHistory is preserved: activity_log and lead_comments keep the email.");
      console.log("Re-run with --yes to do it.");
    } else {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const doomed = "(SELECT id FROM app_users WHERE email <> $1)";
        const log = (await client.query(
          `UPDATE activity_log SET user_id = NULL WHERE user_id IN ${doomed}`, [keep])).rowCount;
        const com = (await client.query(
          `UPDATE lead_comments SET author_user_id = NULL WHERE author_user_id IN ${doomed}`,
          [keep])).rowCount;
        await client.query(`DELETE FROM recents WHERE user_id IN ${doomed}`, [keep]);
        await client.query(
          `DELETE FROM organization_memberships WHERE user_id IN ${doomed}`, [keep]);
        const usr = (await client.query(
          `DELETE FROM app_users WHERE email <> $1`, [keep])).rowCount;
        // the survivor must be an admin or nobody can administer anything
        const org = (await client.query(
          "SELECT id FROM organizations ORDER BY id LIMIT 1")).rows[0];
        await client.query(
          `INSERT INTO organization_memberships (org_id, user_id, role)
           VALUES ($1, $2, 'admin')
           ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'admin'`,
          [org.id, keeper.id]);
        await client.query(
          `UPDATE app_users SET disabled = false WHERE id = $1`, [keeper.id]);
        await client.query("COMMIT");
        console.log(`deleted ${usr} account(s); ${keep} is the only admin`);
        console.log(`kept ${log} activity_log and ${com} comment row(s), now unlinked`);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally { client.release(); }
    }
  } else {
    console.log("commands: token:create, token:revoke, token:list, user:add, "
      + "user:prune-except");
  }
  await pool.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
