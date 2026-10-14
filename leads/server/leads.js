"use strict";
/* Leads: the list every tab reads, the detail pane, and every mutation.

   One table, one endpoint. The old client fetched three NocoDB tables and
   merged them in the browser (capped at 1,000 rows per table — Favorites
   could not page past it); here a union tab is just the same query without a
   kind filter. Sorting is keyset ("cursor"), not offset: page 400 costs the
   same as page 1, and rows shifting underneath a reader can't duplicate or
   swallow entries mid-pagination.

   Every mutation writes activity_log inside the same transaction — the
   manager's Team activity tab is fed by the API, not by the browser's
   honesty. Mutations also touch the caller's recents trail, so the Recent
   tab no longer depends on a separate fire-and-forget client call. */

const express = require("express");
const { query, tx } = require("./db");
const { requireUser, rankOf, RANK } = require("./auth");
const activity = require("./activity");
const counts = require("./counts");
// statuses are open-ended now: they come from Zoho call results (zoho-scan.js applyStatus)
/* 'lead' (a Zoho Lead/Contact) | 'registered' (only in Zoho's call history) | null */
const { zohoKindSql, inZohoSql } = require("./zoho-scan");

const router = express.Router();
/* path-scoped, not bare router.use(requireUser): every feature router is
   mounted at "/", so an unscoped guard here would intercept OTHER routers'
   requests too — it 401'd the service-token import routes before they were
   ever reached */
router.use(["/api/leads", "/api/comments"], requireUser);

/* Members may only act on leads assigned to them.

   Reading is restricted in buildFilters and in the detail route, but WRITING
   was not: patch, remove, restore and comment are all addressed by id, and an
   id is guessable. Hiding a lead from the list while still accepting an edit
   to it is not a permission boundary.

   One guard on the shared path prefix rather than four copies inside the
   handlers — the next id-addressed route someone adds is covered without them
   having to remember. Admins pass straight through. A non-numeric :id is the
   detail route's lead_code form, which guards itself; 404 rather than 403,
   because a member should not learn that a lead they cannot see exists. */
async function requireOwnLead(req, res, next) {
  try {
    if (rankOf(req.user.role) >= RANK.admin) return next();
    const id = +req.params.id;
    if (!Number.isInteger(id) || id <= 0) return next();
    const row = (await query(
      "SELECT owner FROM leads WHERE id = $1 AND deleted_at IS NULL", [id])).rows[0];
    if (!row) return res.status(404).json({ error: "no such lead" });
    if (String(row.owner || "").trim() !== String(req.user.email || "").trim())
      return res.status(404).json({ error: "no such lead" });
    next();
  } catch (e) { next(e); }
}
router.use("/api/leads/:id", requireOwnLead);

/* the state filter accepts the two-letter code but the data holds both
   spellings ("FL" and "Florida") — a known data issue the query absorbs */
const STATE_NAME = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin",
  WY: "Wyoming", DC: "District of Columbia",
};

/* sort key -> [column, direction]; always NULLS LAST with id as tiebreaker */
const SORTS = {
  recent: ["date_added", "DESC"], oldest: ["date_added", "ASC"],
  name: ["name", "ASC"], name_z: ["name", "DESC"],
  size: ["employees", "DESC"], size_asc: ["employees", "ASC"],
  certs: ["certs", "DESC"], revenue: ["revenue", "DESC"],
  state: ["state", "ASC"], city: ["city", "ASC"], status: ["status", "ASC"],
};

/* The KPI tiles are work queues, not decoration: each one is clickable and
   lands here as ?focus=. Keep these predicates identical to the FILTER clauses
   in counts.js — a tile that says 412 and opens 380 rows is worse than no tile.
   Blank strings count as missing (importers write '' as readily as NULL). */
const FOCUS = {
  ready:      "status = 'New' AND nullif(btrim(phone), '') IS NOT NULL",
  enrich:     "nullif(btrim(phone), '') IS NULL AND nullif(btrim(email), '') IS NULL",
  unassigned: "nullif(btrim(owner), '') IS NULL",
  week:       "date_added >= current_date - 6",
};

/* the Job board's source filter (?board=): scraper rows carry source_file
   "LinkedIn search" / "Indeed search" / "Google Jobs search" (jobsearch.js
   SCRAPERS), and older spreadsheet imports carry the workbook's filename,
   which names the board too — so match by pattern, not exact value */
const BOARDS = { linkedin: "%linkedin%", indeed: "%indeed%", google: "%google%" };

const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const dec = (s) => { try { return JSON.parse(Buffer.from(s, "base64url").toString()); } catch { return null; } };

/* Members see only the leads assigned to them; admins see everything.

   The restriction is applied HERE rather than in each route, because this is
   the one place every list, count and search passes through — a check added
   per-route is a check somebody forgets to add to the next route. `user` is
   the resolved caller; omitting it (an internal caller with no request) means
   no restriction, which is why every route passes req.user explicitly.

   Ownership is matched on email because leads.owner is free text holding email
   addresses — the same equality the owner filter and /api/owners already use.
   A member with no leads assigned therefore sees an empty list, which is the
   correct answer rather than an error. */
function buildFilters(p, user) {
  const where = [], params = [];
  const add = (sql, ...vals) => {
    where.push(sql.replace(/\?/g, () => `$${params.push(vals.shift())}`));
  };
  if (user && rankOf(user.role) < RANK.admin)
    add("btrim(owner) = ?", String(user.email || "").trim());
  if (["company", "person", "job"].includes(p.kind)) add("kind = ?", p.kind);
  /* A company or person already in Zoho has moved on: it is listed under
     Contacted (admins), not in Companies or People, so nobody works it twice.
     Favorites, the DNC tab and Contacted itself still show it. */
  if (["company", "person"].includes(p.kind) && p.inzoho !== "true" && p.favorite !== "true" && p.removed !== "true")
    add("NOT " + inZohoSql("leads"));
  // removed=true is the DNC tab; everything else excludes banned leads
  add(p.removed === "true" ? "removed" : "NOT removed");
  // a deleted lead is in the admin's trash bin: no tab, DNC included, shows it
  add("deleted_at IS NULL");
  if (p.favorite === "true") add("favorite");
  /* any status a lead actually has — they now come from Zoho's Call Result,
     so the list is open-ended (GET /api/lead-statuses) */
  if (p.status && String(p.status).length <= 60) add("status = ?", String(p.status));
  if (p.owner) add("owner = ?", p.owner);
  /* The Contacted tab: leads that have a Zoho CRM record linked — a Zoho Lead
     is only created once a lead has been worked, so this is the "already in the
     Zoho call list" set, there to stop anyone calling or being assigned a
     person who is already being worked. jsonb_exists (not the ? operator) so the
     add() placeholder substitution above leaves it alone. */
  if (p.inzoho === "true") add(inZohoSql("leads"));
  /* A KPI tile was clicked. Comma-separated so tiles can be combined —
     "unassigned,ready" is the assignments board asking for work that is both
     unclaimed and actually callable. Unknown keys are ignored, and a single
     key behaves exactly as it always did. */
  for (const key of String(p.focus || "").split(",")) {
    if (FOCUS[key]) add(FOCUS[key]);
  }
  if (p.state && STATE_NAME[p.state.toUpperCase()]) {
    const ab = p.state.toUpperCase();
    add("(upper(state) = ? OR state ILIKE ?)", ab, STATE_NAME[ab]);
  }
  if (BOARDS[p.board]) add("source_file ILIKE ?", BOARDS[p.board]);
  if (p.category) add("category = ?", p.category);   // with state = a segment
  if (p.q) {
    const q = `%${String(p.q).slice(0, 100)}%`;
    add(`(name ILIKE ? OR company ILIKE ? OR email ILIKE ?
          OR city ILIKE ? OR contact ILIKE ?)`, q, q, q, q, q);
  }
  return { where: where.join(" AND "), params };
}

/* keyset predicate for (col dir NULLS LAST, id dir): three cases because the
   cursor value may itself be in the NULL tail */
function keyset(col, dir, cursor, params) {
  const cmp = dir === "DESC" ? "<" : ">";
  if (cursor.v === null)
    return `(${col} IS NULL AND id ${cmp} $${params.push(cursor.id)})`;
  const pv = `$${params.push(cursor.v)}`;
  return `(${col} ${cmp} ${pv}
           OR (${col} = ${pv} AND id ${cmp} $${params.push(cursor.id)})
           OR ${col} IS NULL)`;
}

router.get("/api/leads", async (req, res, next) => {
  try {
    const p = req.query;
    // the Removed tab is a Manage surface: members never list banned leads
    // (their remove slip-ups are covered by the 5-second undo instead)
    if (p.removed === "true" && rankOf(req.user.role) < RANK.admin)
      return res.status(403).json({ error: "admins only" });
    const [col, dir] = SORTS[p.sort] || SORTS.recent;
    const limit = Math.min(Math.max(+p.limit || 50, 1), 200);
    const { where, params } = buildFilters(p, req.user);
    let cursorSql = "";
    if (p.cursor) {
      const c = dec(p.cursor);
      if (!c || !("v" in c) || !Number.isInteger(c.id))
        return res.status(400).json({ error: "bad cursor" });
      cursorSql = " AND " + keyset(col, dir, c, params);
    }
    const rows = (await query(
      /* in_zoho: is this lead in the Zoho call list (a Zoho CRM record linked)?
         — drives the "Zoho" badge. Uses the activity_log partial index (022). */
      `SELECT *, EXISTS (SELECT 1 FROM activity_log a
          WHERE a.lead_id = leads.id AND jsonb_exists(a.meta, 'crm_link')) AS in_zoho,
          ${zohoKindSql("leads")} AS zoho_kind
         FROM leads WHERE ${where}${cursorSql}
       ORDER BY ${col} ${dir} NULLS LAST, id ${dir} LIMIT $${params.push(limit + 1)}`,
      params)).rows;
    const more = rows.length > limit;
    if (more) rows.pop();
    const last = rows[rows.length - 1];
    // total only on the first page — it's identical on every later one
    let total = null;
    if (!p.cursor) {
      const f = buildFilters(p, req.user);
      total = +(await query(
        `SELECT count(*)::int n FROM leads WHERE ${f.where}`, f.params)).rows[0].n;
    }
    res.json({
      list: rows, total,
      nextCursor: more ? enc({ v: last[col] ?? null, id: last.id }) : null,
    });
  } catch (e) { next(e); }
});

/* GET /api/lead-statuses — every status leads currently have (New first,
   then by how many), for the status filters and the power dialler. Scoped
   like the list: a member counts only their own leads. */
router.get("/api/lead-statuses", requireUser, async (req, res, next) => {
  try {
    const seesAll = rankOf(req.user.role) >= RANK.admin;
    const rows = (await query(
      `SELECT status, count(*)::int AS n FROM leads
        WHERE deleted_at IS NULL AND NOT removed AND nullif(btrim(status), '') IS NOT NULL
          ${seesAll ? "" : "AND btrim(owner) = $1"}
        GROUP BY status ORDER BY (status = 'New') DESC, count(*) DESC, status`,
      seesAll ? [] : [String(req.user.email || "").trim()])).rows;
    if (!rows.some((r) => r.status === "New")) rows.unshift({ status: "New", n: 0 });
    res.json({ statuses: rows });
  } catch (e) { next(e); }
});

/* one lead plus everything the reading pane shows beside it */
router.get("/api/leads/:key", async (req, res, next) => {
  try {
    const row = await findLead(req.params.key);
    if (!row) return res.status(404).json({ error: "no such lead" });
    /* The list already hides other people's leads, but an id in a URL must not
       be a way around that. 404 rather than 403: a member has no business
       learning that a lead they cannot see exists at all. */
    const mine = (l) => rankOf(req.user.role) >= RANK.admin
      || String(l.owner || "").trim() === String(req.user.email || "").trim();
    if (!mine(row)) return res.status(404).json({ error: "no such lead" });

    const related = { company: null, people: [], jobs: [], similar: null };
    const coId = row.kind === "company" ? row.id : row.company_lead_id;
    /* Related records go through the same test as the lead itself. A member
       must not receive a company's other people and postings just because they
       own one record at that company — that would hand back through the side
       door exactly what the list withholds at the front. For an admin the
       clause is empty and the queries are unchanged. */
    const seesAll = rankOf(req.user.role) >= RANK.admin;
    const ownClause = seesAll ? "" : " AND btrim(owner) = $3";
    const ownArg = seesAll ? [] : [String(req.user.email || "").trim()];
    if (coId) {
      if (row.kind !== "company")
        related.company = (await query(
          `SELECT id, lead_code, name, city, state, logo_url FROM leads
           WHERE id = $1 AND deleted_at IS NULL`
          + (seesAll ? "" : " AND btrim(owner) = $2"),
          seesAll ? [coId] : [coId, String(req.user.email || "").trim()],
        )).rows[0] || null;
      related.people = (await query(
        `SELECT id, lead_code, name, title, email, phone FROM leads
         WHERE kind = 'person' AND company_lead_id = $1 AND NOT removed
           AND deleted_at IS NULL AND id <> $2${ownClause} ORDER BY id LIMIT 6`,
        [coId, row.id, ...ownArg])).rows;
      related.jobs = (await query(
        `SELECT id, lead_code, name, city, state, job_url FROM leads
         WHERE kind = 'job' AND company_lead_id = $1 AND NOT removed
           AND deleted_at IS NULL AND id <> $2${ownClause}
         ORDER BY date_added DESC NULLS LAST LIMIT 4`, [coId, row.id, ...ownArg])).rows;
    }
    if (row.kind === "company" && row.category && row.state) {
      const seg = (await query(
        `SELECT count(*)::int n FROM leads
         WHERE kind = 'company' AND NOT removed AND deleted_at IS NULL
           AND category = $1 AND state = $2 AND id <> $3`,
        [row.category, row.state, row.id])).rows[0];
      related.similar = { category: row.category, state: row.state, count: seg.n };
    }
    res.json({ ...row, related });
  } catch (e) { next(e); }
});

/* a lead in the trash bin is not findable — a stale link 404s rather than
   opening a record the app is meant to have stopped showing */
async function findLead(key) {
  const inZoho = `, EXISTS (SELECT 1 FROM activity_log a
      WHERE a.lead_id = leads.id AND jsonb_exists(a.meta, 'crm_link')) AS in_zoho,
      ${zohoKindSql("leads")} AS zoho_kind`;
  if (/^\d+$/.test(key))
    return (await query(
      `SELECT *${inZoho} FROM leads WHERE id = $1 AND deleted_at IS NULL`, [+key])).rows[0];
  const code = String(key).toUpperCase();
  const direct = (await query(
    `SELECT *${inZoho} FROM leads WHERE lead_code = $1 AND deleted_at IS NULL`, [code])).rows[0];
  if (direct) return direct;
  // a tombstoned code from an old bookmark still resolves
  return (await query(
    `SELECT l.* FROM lead_code_aliases a JOIN leads l ON l.id = a.lead_id
     WHERE a.code = $1 AND l.deleted_at IS NULL`, [code])).rows[0];
}

const touchRecent = (client, userId, leadId, kind) => client.query(
  `INSERT INTO recents (user_id, lead_id, kind) VALUES ($1, $2, $3)
   ON CONFLICT (user_id, lead_id) DO UPDATE SET touched_at = now(), kind = $3`,
  [userId, leadId, kind]);

/* status / owner / favorite — the three judgement fields the UI edits */
router.patch("/api/leads/:id", express.json({ limit: "8kb" }), async (req, res, next) => {
  try {
    const id = +req.params.id;
    const b = req.body || {};
    /* A lead's status follows the Call Result of its latest call in Zoho CRM
       (zoho-scan.js applyStatus) — it is changed in Zoho, not here. */
    if ("status" in b)
      return res.status(409).json({ error: "Status follows the call result in Zoho CRM — change it there and the next Zoho scan brings it here." });
    const row = await tx(async (client) => {
      const cur = (await client.query(
        `SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [id])).rows[0];
      if (!cur) return null;
      const sets = [], params = [];
      const logs = [];
      const change = (col, val, action, from, to) => {
        sets.push(`${col} = $${params.push(val)}`);
        logs.push({ action, from_value: from, to_value: to });
      };
      if ("status" in b && b.status !== cur.status)
        change("status", b.status, "status", cur.status, b.status);
      if ("owner" in b) {
        const owner = b.owner ? String(b.owner).slice(0, 120) : null;
        if (owner !== cur.owner)
          change("owner", owner, "owner",
            cur.owner || "unassigned", owner || "unassigned");
      }
      if ("favorite" in b && !!b.favorite !== cur.favorite)
        change("favorite", !!b.favorite, b.favorite ? "favorite" : "unfavorite");
      if (!sets.length) return cur;
      sets.push("updated_at = now()");
      const updated = (await client.query(
        `UPDATE leads SET ${sets.join(", ")} WHERE id = $${params.push(id)}
         RETURNING *`, params)).rows[0];
      for (const l of logs)
        await activity.log({ actor: req.user.email, user_id: req.user.id,
          lead_id: id, lead_code: cur.lead_code, lead_name: cur.name, ...l }, client);
      await touchRecent(client, req.user.id, id, logs[0]?.action || "open");
      return updated;
    });
    if (!row) return res.status(404).json({ error: "no such lead" });
    // the KPI tiles are work queues now: taking a lead off New, or giving it an
    // owner, empties one of them. A 30s stale read would look like a lost click.
    counts.invalidate();
    res.json(row);
  } catch (e) { next(e); }
});

/* how many leads a ban would take down — the modal's blast radius line */
router.get("/api/leads/:id/remove-preview", async (req, res, next) => {
  try {
    const row = (await query(
      `SELECT phone_key FROM leads WHERE id = $1 AND deleted_at IS NULL`,
      [+req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: "no such lead" });
    if (!row.phone_key) return res.json({ affected: 1 });
    const n = (await query(
      `SELECT count(*)::int n FROM leads
       WHERE phone_key = $1 AND NOT removed AND deleted_at IS NULL`,
      [row.phone_key])).rows[0].n;
    res.json({ affected: Math.max(n, 1) });
  } catch (e) { next(e); }
});

/* removal is a phone ban: blocklist the number, sweep every lead sharing it */
router.post("/api/leads/:id/remove", express.json({ limit: "8kb" }), async (req, res, next) => {
  try {
    const id = +req.params.id;
    const reason = String(req.body?.reason || "").slice(0, 300);
    const out = await tx(async (client) => {
      const cur = (await client.query(
        `SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [id])).rows[0];
      if (!cur) return null;
      let ids = [];
      if (cur.phone_key) {
        await client.query(
          `INSERT INTO blocklist (phone, phone_key, company, reason, added_by)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (phone_key) DO NOTHING`,
          [cur.phone, cur.phone_key, cur.company || cur.name, reason, req.user.email]);
        ids = (await client.query(
          `UPDATE leads SET removed = true, updated_at = now()
           WHERE phone_key = $1 AND NOT removed AND deleted_at IS NULL
           RETURNING id`,
          [cur.phone_key])).rows.map((r) => r.id);
      }
      if (!ids.length) {
        await client.query(
          "UPDATE leads SET removed = true, updated_at = now() WHERE id = $1", [id]);
        ids = [id];
      }
      await activity.log({ actor: req.user.email, user_id: req.user.id,
        action: "remove", lead_id: id, lead_code: cur.lead_code,
        lead_name: cur.name, to_value: reason || "no reason given",
        meta: { affected: ids.length } }, client);
      await touchRecent(client, req.user.id, id, "remove");
      // ids let the client's undo toast hand back exactly this sweep
      return { affected: ids.length, ids };
    });
    if (!out) return res.status(404).json({ error: "no such lead" });
    counts.invalidate();                 // a sweep moves every tile at once
    res.json(out);
  } catch (e) { next(e); }
});

/* Lifting a DNC ban is an owner's call, with one exception that matters more
   than the rule: the rep who just removed something by accident.

   Both go through this route — the 5-second undo toast and the manager
   reviewing the ban list months later — and they are not the same act. The
   first is a slip being corrected by the person who made it; the second puts
   a number the company decided not to call back into circulation, which is a
   compliance decision and should sit with one person.

   So: an owner may restore anything, and anybody may restore what they
   themselves removed while the undo is still plausible. The window is
   generous on purpose — the toast lasts five seconds, but a rep who notices
   a minute later should not need to file a request. */
const UNDO_WINDOW_MINUTES = 15;

async function requireRestoreRight(req, res, next) {
  try {
    if (rankOf(req.user.role) >= RANK.owner) return next();
    const id = +req.params.id;
    const own = await query(
      `SELECT 1 FROM activity_log
        WHERE action = 'remove' AND lead_id = $1 AND actor = $2
          AND at >= now() - ($3 || ' minutes')::interval
        LIMIT 1`,
      [id, req.user.email, String(UNDO_WINDOW_MINUTES)]);
    if (own.rowCount) return next();
    res.status(403).json({ error: "Only the owner can lift a do-not-call ban. "
      + "You can undo a removal you just made yourself." });
  } catch (e) { next(e); }
}

router.post("/api/leads/:id/restore", requireRestoreRight, express.json({ limit: "8kb" }), async (req, res, next) => {
  try {
    const id = +req.params.id;
    // the undo toast hands back the exact id set its remove swept — a plain
    // restore (no body) still un-removes just the one lead
    const extra = Array.isArray(req.body?.ids)
      ? req.body.ids.filter(Number.isInteger).slice(0, 500) : [];
    const ids = [...new Set([id, ...extra])];
    const out = await tx(async (client) => {
      const cur = (await client.query(
        `SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [id])).rows[0];
      if (!cur) return null;
      const affected = (await client.query(
        `UPDATE leads SET removed = false, updated_at = now()
         WHERE id = ANY($1) AND deleted_at IS NULL`, [ids])).rowCount;
      if (cur.phone_key)
        await client.query("DELETE FROM blocklist WHERE phone_key = $1",
          [cur.phone_key]);
      await activity.log({ actor: req.user.email, user_id: req.user.id,
        action: "restore", lead_id: id, lead_code: cur.lead_code,
        lead_name: cur.name, meta: { affected } }, client);
      await touchRecent(client, req.user.id, id, "restore");
      return { ok: true, affected };
    });
    if (!out) return res.status(404).json({ error: "no such lead" });
    counts.invalidate();
    res.json(out);
  } catch (e) { next(e); }
});

/* ---------------- notes (first-class, with edit/delete metadata) */
router.get("/api/leads/:id/comments", async (req, res, next) => {
  try {
    const rows = (await query(
      `SELECT id, author_email, author_user_id, body, created_at, updated_at
       FROM lead_comments
       WHERE lead_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
      [+req.params.id])).rows;
    res.json({ list: rows });
  } catch (e) { next(e); }
});

router.post("/api/leads/:id/comments", express.json({ limit: "16kb" }), async (req, res, next) => {
  try {
    const id = +req.params.id;
    const body = String(req.body?.body || "").trim().slice(0, 4000);
    if (!body) return res.status(400).json({ error: "empty note" });
    const out = await tx(async (client) => {
      const cur = (await client.query(
        "SELECT lead_code, name FROM leads WHERE id = $1", [id])).rows[0];
      if (!cur) return null;
      const row = (await client.query(
        `INSERT INTO lead_comments (lead_id, author_user_id, author_email, body)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [id, req.user.id, req.user.email, body])).rows[0];
      await activity.log({ actor: req.user.email, user_id: req.user.id,
        action: "note", lead_id: id, lead_code: cur.lead_code,
        lead_name: cur.name, to_value: body.slice(0, 200) }, client);
      await touchRecent(client, req.user.id, id, "note");
      return row;
    });
    if (!out) return res.status(404).json({ error: "no such lead" });
    res.json(out);
  } catch (e) { next(e); }
});

/* author edits their own note; an admin can edit or delete anyone's */
const canTouch = (req, c) =>
  c.author_user_id === req.user.id || rankOf(req.user.role) >= RANK.admin;

router.patch("/api/comments/:id", express.json({ limit: "16kb" }), async (req, res, next) => {
  try {
    const body = String(req.body?.body || "").trim().slice(0, 4000);
    if (!body) return res.status(400).json({ error: "empty note" });
    const c = (await query(
      "SELECT * FROM lead_comments WHERE id = $1 AND deleted_at IS NULL",
      [+req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: "no such note" });
    if (!canTouch(req, c)) return res.status(403).json({ error: "not your note" });
    const row = (await query(
      `UPDATE lead_comments SET body = $1, updated_at = now()
       WHERE id = $2 RETURNING *`, [body, c.id])).rows[0];
    res.json(row);
  } catch (e) { next(e); }
});

router.delete("/api/comments/:id", async (req, res, next) => {
  try {
    const c = (await query(
      "SELECT * FROM lead_comments WHERE id = $1 AND deleted_at IS NULL",
      [+req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: "no such note" });
    if (!canTouch(req, c)) return res.status(403).json({ error: "not your note" });
    await query("UPDATE lead_comments SET deleted_at = now() WHERE id = $1", [c.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* FOCUS is exported so the assignments board can reuse these exact predicates.
   CLAUDE.md warns that the KPI predicates are already written three times and
   must be changed together — a fourth copy would make that worse, so reuse it
   rather than restating it. */
module.exports = { router, STATE_NAME, findLead, FOCUS };
