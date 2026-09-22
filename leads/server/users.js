"use strict";
/* Admin user management — the domain API is the source of truth for who may
   sign in and what they may do. NocoDB has no say in this, and a service
   token cannot reach these routes at all (requireAdmin only accepts users).

   'Inviting' here means creating the app_users row; in the adapter phase the
   person also needs a NocoDB account to sign in with, and after the WorkOS
   cutover the hosted login handles the rest. */

const express = require("express");
const { query, tx } = require("./db");
const { requireAdmin, rankOf, RANK, isOwnerEmail } = require("./auth");

/* Adding somebody creates their row; the email is what makes it an invite.
   Optional — the module is absent in some setups and a missing mailer must
   not stop a manager building their team. */
let mailer = null;
try { mailer = require("../../server/email.cjs"); }
catch (e) { console.warn("[karma] users: no mail module —", e.message); }

const router = express.Router();
router.use("/api/users", requireAdmin);    // path-scoped: routers share "/"

/* Who may hand out what.

   A manager can build their own team — invite members, disable someone who
   has left. What a manager cannot do is change the shape of the hierarchy:
   appointing another admin, or touching anyone who already outranks a
   member. That belongs to the owner, because an admin who can mint admins
   is an owner in everything but name, and one compromised manager account
   would then be able to lock the real owner out.

   Expressed as a rule rather than a list of cases: you may only grant a
   rank below your own, and you may only act on somebody already below you.
   An owner passes both tests for everything; a manager passes neither for
   an admin. */
function mayGrant(actor, role) {
  return rankOf(role) < rankOf(actor.role);
}

async function targetOf(id) {
  return (await query(
    `SELECT u.id, u.email, u.disabled, m.role
       FROM app_users u
       LEFT JOIN organization_memberships m ON m.user_id = u.id
      WHERE u.id = $1`, [id])).rows[0] || null;
}

router.get("/api/users", async (req, res, next) => {
  try {
    const rows = (await query(
      `SELECT u.id, u.email, u.display_name, u.disabled, u.created_at, m.role,
              (SELECT max(at) FROM activity_log a WHERE a.user_id = u.id) AS last_active
       FROM app_users u
       LEFT JOIN organization_memberships m ON m.user_id = u.id
       ORDER BY u.email`)).rows;
    /* Report the rank the person will actually get, not just the row: an
       email in OWNER_EMAILS is an owner whatever the table says, and a team
       list that disagreed with the session would send a manager hunting for
       a bug that isn't there. */
    const list = rows.map((u) => isOwnerEmail(u.email)
      ? { ...u, role: "owner", ownerByConfig: true } : u);
    res.json({ list, you: { role: req.user.role } });
  } catch (e) { next(e); }
});

router.post("/api/users", express.json({ limit: "4kb" }), async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const role = ["owner", "admin", "member"].includes(req.body?.role)
      ? req.body.role : "member";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return res.status(400).json({ error: "bad email" });
    if (!mayGrant(req.user, role))
      return res.status(403).json({
        error: `Only the owner can appoint ${role === "owner" ? "an owner" : "an admin"}.` });
    const row = await tx(async (client) => {
      const u = (await client.query(
        `INSERT INTO app_users (email, display_name) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET disabled = false
         RETURNING *`, [email, req.body?.display_name || null])).rows[0];
      const org = (await client.query(
        "SELECT id FROM organizations ORDER BY id LIMIT 1")).rows[0];
      await client.query(
        `INSERT INTO organization_memberships (org_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (org_id, user_id) DO UPDATE SET role = $3`,
        [org.id, u.id, role]);
      return { ...u, role };
    });

    /* Tell them. Without this the invite is a row nobody knows about: the
       person is never notified, and their access does nothing until they
       make a sign-in of their own. Failing to send is reported rather than
       swallowed, so the manager knows to pass the word on by hand instead
       of assuming it went. */
    let invited = false, why = "";
    if (!mailer || !mailer.emailVerifyOn) {
      why = "email is not configured on this server";
    } else {
      const base = (process.env.APP_URL || "").replace(/\/$/, "");
      try {
        await mailer.sendTeamInviteEmail(email, {
          inviterName: req.user.name || req.user.email,
          role,
          link: base ? `${base}/?next=${encodeURIComponent("/leads/")}` : "",
        });
        invited = true;
      } catch (e) {
        why = e.message.slice(0, 160);
        console.error("[karma] invite to", email, "failed:", e.message);
      }
    }
    res.json({ ...row, invited, inviteError: invited ? "" : why });
  } catch (e) { next(e); }
});

router.patch("/api/users/:id", express.json({ limit: "4kb" }), async (req, res, next) => {
  try {
    const id = +req.params.id;
    const b = req.body || {};
    const target = await targetOf(id);
    if (!target) return res.status(404).json({ error: "no such user" });
    const targetRole = target.role || "member";

    /* You may only act on somebody below you. Without this a manager could
       disable the owner — a demotion by another name, and the one move that
       would leave nobody able to undo it. Acting on yourself is allowed:
       the last-owner and last-admin guards below are what stop a lockout,
       not a rule against touching your own row. */
    if (id !== req.user.id && rankOf(targetRole) >= rankOf(req.user.role))
      return res.status(403).json({
        error: `Only the owner can change ${target.email}'s access.` });

    if ("role" in b) {
      if (!["owner", "admin", "member"].includes(b.role))
        return res.status(400).json({ error: "unknown role" });
      if (!mayGrant(req.user, b.role))
        return res.status(403).json({
          error: `Only the owner can appoint ${b.role === "owner" ? "an owner" : "an admin"}.` });
    }

    /* Nobody may empty the top of the ladder. Counted per rank rather than
       once for 'admin', because demoting the last owner to admin would pass
       an admin-only check while leaving the owner-only actions — purging the
       bin, appointing anyone — permanently unreachable.

       OWNER_EMAILS is the real backstop here (it grants the tier whatever
       the table says), but this is what keeps the table itself sensible, and
       not every deployment will have set it. */
    const losing = (rank) =>
      rankOf(targetRole) === rank
      && (b.disabled === true || ("role" in b && rankOf(b.role) < rank));
    for (const [name, rank] of [["owner", RANK.owner], ["admin", RANK.admin]]) {
      if (!losing(rank)) continue;
      const left = (await query(
        `SELECT count(*)::int n FROM organization_memberships m
         JOIN app_users u ON u.id = m.user_id
         WHERE m.role = $1 AND NOT u.disabled`, [name])).rows[0].n;
      if (left <= 1)
        return res.status(400).json({ error: `cannot remove the last ${name}` });
    }

    await tx(async (client) => {
      if ("disabled" in b)
        await client.query("UPDATE app_users SET disabled = $1 WHERE id = $2",
          [!!b.disabled, id]);
      if ("role" in b)
        await client.query(
          "UPDATE organization_memberships SET role = $1 WHERE user_id = $2",
          [b.role, id]);
    });

    /* Said plainly rather than left for them to discover: OWNER_EMAILS wins
       over this table, so demoting a listed owner in the UI changes the row
       and nothing else. */
    const stillOwner = isOwnerEmail(target.email)
      && "role" in b && b.role !== "owner";
    res.json({ ok: true, ...(stillOwner ? { warning:
      `${target.email} is listed in OWNER_EMAILS and keeps owner access. `
      + "Change that setting to hand ownership over." } : {}) });
  } catch (e) { next(e); }
});

module.exports = { router };
