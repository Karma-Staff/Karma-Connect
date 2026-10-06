"use strict";
/* Phone numbers with digits glued on the end.

   The base is North American. A number like "941-234-5678 1234" — an
   extension typed with no "ext" in front of it — is 14 digits, so the
   dialler read it as international: +94… is Sri Lanka, and RingCentral
   refused the call. dedupe.pk() takes the LAST ten digits of anything
   longer, so the same lead's phone_key (duplicates, the DNC blocklist) was
   wrong too.

   fix() repairs exactly that shape and nothing else: more than 11 digits,
   no "+", and a leading part that is a real US/Canadian area code. The
   phone becomes the clean number; the leftover digits go into the lead's
   notes ("Ext. 1234"), so nothing a rep might need is thrown away. They are
   NOT kept in the phone field: dedupe.pk() keys on the last ten digits, so
   "… ext 1234" there would key the wrong number all over again.
   Everything else is left as typed — a valid number is never reformatted,
   and a number that cannot be read is reported, not guessed at. */

const express = require("express");
const requireAdmin = (...a) => require("./auth").requireAdmin(...a);
const { AREA_REGION } = require("./areacodes");

/* The database is reached only inside the routes, so fix() — the rule the
   importer also runs — can be required (and unit-tested) without one. */
const query = (...a) => require("./db").query(...a);
const tx = (...a) => require("./db").tx(...a);
const activity = { log: (...a) => require("./activity").log(...a) };

const router = express.Router();

const isArea = (npa) => !!AREA_REGION[npa];
const fmt = (d10) => `(${d10.slice(0, 3)}) ${d10.slice(3, 6)}-${d10.slice(6)}`;

/* { status: "ok" | "fixed" | "bad", phone, ext } — "fixed" carries the
   rewritten phone; "bad" is unreadable as typed and left for a person. */
function fix(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { status: "ok", phone: s };
  if (s.startsWith("+")) return { status: "ok", phone: s };            // written as international
  // an extension already marked is fine: the dialler strips it
  const base = s.replace(/\s*(?:ext\.?|extension|x|#)\s*\d+\s*$/i, "");
  const d = base.replace(/\D/g, "");
  if (d.length === 10 || (d.length === 11 && d[0] === "1")) return { status: "ok", phone: s };
  if (d.length > 11) {
    if (d[0] === "1" && isArea(d.slice(1, 4)))
      return { status: "fixed", phone: fmt(d.slice(1, 11)), ext: d.slice(11) };
    if (isArea(d.slice(0, 3)))
      return { status: "fixed", phone: fmt(d.slice(0, 10)), ext: d.slice(10) };
  }
  return { status: "bad", phone: s };
}

/* Every lead's phone, checked. Leads in the bin are left alone — they are
   gone until restored, and a restore brings back what was there. */
async function scan() {
  const rows = (await query(
    `SELECT id, name, phone, phone_key, removed FROM leads
      WHERE deleted_at IS NULL AND nullif(btrim(phone), '') IS NOT NULL`)).rows;
  const fixed = [], bad = [];
  for (const r of rows) {
    const f = fix(r.phone);
    if (f.status === "fixed") fixed.push({ ...r, to: f.phone, ext: f.ext });
    else if (f.status === "bad") bad.push(r);
  }
  return { checked: rows.length, fixed, bad };
}

/* GET /api/phones/check — what a fix would change, before anything does. */
router.get("/api/phones/check", requireAdmin, async (req, res, next) => {
  try {
    const { checked, fixed, bad } = await scan();
    const D = require("./dedupe");
    const keys = [...new Set(fixed.map((f) => D.pk(f.to)).filter(Boolean))];
    const banned = keys.length ? new Set((await query(
      "SELECT phone_key FROM blocklist WHERE phone_key = ANY($1)", [keys])).rows.map((r) => r.phone_key)) : new Set();
    const view = (r) => ({ id: +r.id, name: r.name, from: r.phone, ...(r.to ? { to: r.to, ext: r.ext } : {}) });
    res.json({
      checked,
      fixable: fixed.length, unreadable: bad.length,
      dnc: fixed.filter((f) => !f.removed && banned.has(D.pk(f.to))).length,
      fixes: fixed.slice(0, 200).map(view),
      bad: bad.slice(0, 200).map(view),
    });
  } catch (e) { next(e); }
});

/* POST /api/phones/fix — apply every fix the check shows. Recomputed here,
   never taken from the browser. Each fixed lead gets its phone_key
   recomputed too; a corrected number that is on the DNC blocklist is
   removed, exactly as an import of that number would be. One summary row in
   the activity log (meta.bulk), like every other bulk change. */
router.post("/api/phones/fix", requireAdmin, async (req, res, next) => {
  try {
    const D = require("./dedupe");
    const { fixed } = await scan();
    if (!fixed.length) return res.json({ fixed: 0, removed: 0 });
    const out = await tx(async (client) => {
      const banned = new Set((await client.query("SELECT phone_key FROM blocklist")).rows.map((r) => r.phone_key));
      let removed = 0;
      for (const f of fixed) {
        const key = D.pk(f.to);
        const ban = !!key && banned.has(key) && !f.removed;
        if (ban) removed++;
        await client.query(
          `UPDATE leads SET phone = $2, phone_key = $3, removed = removed OR $4, updated_at = now(),
                  notes = concat_ws(E'
', nullif(btrim(notes), ''), $6::text)
            WHERE id = $1 AND phone = $5`, [f.id, f.to, key, ban, f.phone, extNote(f)]);
      }
      await activity.log({
        actor: req.user.email, user_id: req.user.id, action: "enrich",
        lead_name: `${fixed.length} lead${fixed.length === 1 ? "" : "s"}`, to_value: "phone numbers fixed",
        meta: { bulk: true, kind: "phone_fix", count: fixed.length, removed,
          ...(fixed.length <= 500 ? { ids: fixed.map((f) => +f.id) } : {}) },
      }, client);
      return { fixed: fixed.length, removed };
    });
    require("./counts").invalidate();
    res.json(out);
  } catch (e) { next(e); }
});

/* What a fix leaves in the notes, so the digits it took off are not lost. */
function extNote(f) {
  return `Ext. ${f.ext} (moved from the phone number, which was "${String(f.phone).trim()}")`;
}

module.exports = { router, fix, extNote };
