"use strict";
/* The KPI row and sidebar badges. The old client issued ~26 count requests per
   refresh (and every login); this is one SQL pass over leads, cached for 30
   seconds because at ten users the numbers cannot meaningfully drift faster,
   and a burst of logins should not become a burst of scans. */

const express = require("express");
const { query } = require("./db");
const { requireUser, rankOf, RANK } = require("./auth");
// where a lead is listed: the one rule the lists use (leads.js), so tile and list agree
const { listedContactedSql } = require("./zoho-scan");

const router = express.Router();
const TTL = 30_000;
/* Keyed by audience, not global. Members see only their own leads, so their
   KPI row has to count only those — and a single shared entry would serve one
   member's numbers to the next. Admins all share the "" key because they all
   see the whole base. */
const cache = new Map();   // key -> { data, at }

router.get("/api/counts", requireUser, async (req, res, next) => {
  try {
    const isAdmin = rankOf(req.user.role) >= RANK.admin;
    const mine = isAdmin ? "" : String(req.user.email || "").trim();
    const hit = cache.get(mine);
    if (hit && Date.now() - hit.at < TTL) return res.json(hit.data);
    /* The tiles must agree with the list underneath them. The list restricts
       members to their own leads, so these counts do too, with the same
       equality on the free-text owner column. */
    const scope = isAdmin ? "" : " AND btrim(owner) = $1";
    const args = isAdmin ? [] : [mine];
    const r = (await query(`
      SELECT
        /* in Zoho or worked through it (zoho-scan.js listedContactedSql — the
           lists' rule): counted under Contacted, not in the four tabs below */
        count(*) FILTER (WHERE kind = 'company' AND NOT removed AND recent_at IS NULL AND NOT in_z)::int AS companies,
        count(*) FILTER (WHERE kind = 'person'  AND NOT removed AND recent_at IS NULL AND NOT in_z)::int AS people,
        count(*) FILTER (WHERE NOT removed AND in_z)::int AS contacted,
        count(*) FILTER (WHERE NOT removed)::int AS all_leads,
        count(*) FILTER (WHERE kind = 'job'     AND NOT removed AND recent_at IS NULL AND NOT in_z)::int AS jobs,
        /* what an import just brought in, held under Recently added (025) */
        count(*) FILTER (WHERE NOT removed AND recent_at IS NOT NULL AND NOT in_z)::int AS recent,
        count(*) FILTER (WHERE favorite AND NOT removed)::int          AS favorites,
        count(*) FILTER (WHERE removed)::int                           AS removed,
        count(*) FILTER (WHERE status = 'New' AND NOT removed)::int    AS status_new,
        count(*) FILTER (WHERE status = 'Qualified' AND NOT removed)::int AS qualified,
        count(*) FILTER (WHERE phone IS NOT NULL AND NOT removed)::int AS with_phone,
        count(*) FILTER (WHERE email IS NOT NULL AND NOT removed)::int AS with_email,
        /* the three work-queue tiles. They are deliberately the same
           predicates as FOCUS in leads.js — the KPI number and the list you
           get by clicking it must never disagree. Blank strings count as
           missing: the importers write '' as readily as NULL. */
        count(*) FILTER (WHERE NOT removed AND status = 'New'
                         AND nullif(btrim(phone), '') IS NOT NULL)::int AS ready,
        count(*) FILTER (WHERE NOT removed
                         AND nullif(btrim(phone), '') IS NULL
                         AND nullif(btrim(email), '') IS NULL)::int     AS needs_enrichment,
        count(*) FILTER (WHERE NOT removed
                         AND nullif(btrim(owner), '') IS NULL)::int     AS unassigned,
        count(*) FILTER (WHERE date_added >= current_date - 6
                         AND NOT removed)::int                         AS week,
        count(*) FILTER (WHERE date_added >= current_date - 13
                         AND date_added < current_date - 6
                         AND NOT removed)::int                         AS prev_week
      FROM (SELECT leads.*, ${listedContactedSql("leads")} AS in_z FROM leads
             WHERE deleted_at IS NULL${scope}) leads`, args)).rows[0];   // the trash bin counts as gone
    if (!isAdmin) delete r.contacted;                   // the Contacted tab is admins' only
    const { all_leads, ...rest } = r;
    const data = { ...rest, total: all_leads, at: new Date().toISOString() };
    cache.set(mine, { data, at: Date.now() });
    res.json(data);
  } catch (e) { next(e); }
});

/* mutations call this so a status change is visible in the KPI row promptly.
   Clears every audience: one reassignment changes both the old owner's numbers
   and the new owner's, and the admin total can change too. */
const invalidate = () => { cache.clear(); };

module.exports = { router, invalidate };
