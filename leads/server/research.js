"use strict";
/* Prospect research — the briefing a rep reads before they dial.

   Karma Connect has had this for its own prospects; this is the same idea
   against the lead base, and it answers the questions a salesperson actually
   opens with: what does this outfit do, who am I speaking to, what have they
   just done that I can congratulate them on, and what should I not say.

   Three things shape everything below.

   It costs money. Every briefing is a live web search plus a few thousand
   tokens. So: never automatic, never on a list — one lead, one button, and
   the result is stored (migration 007) and re-read rather than re-bought.
   There is a per-person daily cap, counted in the database so restarting
   nothing resets it.

   It must not invent. A fabricated alma mater used as an opener is worse
   than no opener — it is the one mistake that ends a call in the first ten
   seconds. Every field is allowed to come back empty, the system prompt says
   so twice, and the renderer simply omits what is missing.

   Most rows are companies, not people (33,043 against 2,305). The prompt
   adapts: a company row gets the firm and whoever is named as contact, a
   person row gets the individual. Asking for someone's education when the
   row is a restoration franchise wastes the search budget. */

const express = require("express");
const { query } = require("./db");
const { requireUser } = require("./auth");
const activity = require("./activity");
const { handleClaude } = require("../../api/_proxy.cjs");
const linkedin = require("./linkedin");
const { SYSTEM, buildPrompt, parseBrief, normalise, isEmpty, MAX_SEARCHES, str } = require("./brief");

const router = express.Router();

/* Haiku, deliberately. This is extraction from search results, not writing —
   the same judgement Karma Connect makes for its company research, at about
   a third of Sonnet's price. */
const MODEL = process.env.RESEARCH_MODEL || "claude-haiku-4-5";
const MAX_TOKENS = 2000;
/* Per person, per rolling 24h. Generous for a working day — a rep briefing
   every lead they call would not reach it — and low enough that a stuck
   loop or a curious afternoon cannot run up a bill unnoticed. */
const DAILY_CAP = Math.max(1, +process.env.RESEARCH_DAILY_CAP || 40);

/* GET — whatever we already hold. Free, and the normal case: a briefing is
   bought once and read many times. */
router.get("/api/leads/:id/research", requireUser, async (req, res, next) => {
  try {
    const id = +req.params.id;
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad lead id" });
    const row = (await query(
      `SELECT brief, model, actor, created_at FROM lead_research
        WHERE lead_id = $1 AND superseded_at IS NULL`, [id])).rows[0];
    res.json({ brief: row ? row.brief : null, meta: row
      ? { model: row.model, actor: row.actor, at: row.created_at } : null,
      cap: DAILY_CAP, used: await usedToday(req.user.email) });
  } catch (e) { next(e); }
});

async function usedToday(email) {
  return +(await query(
    `SELECT count(*)::int n FROM lead_research
      WHERE actor = $1 AND created_at >= now() - interval '24 hours'`, [email])).rows[0].n;
}

/* POST — buy a briefing. requireOwnLead has already run on this path, so a
   member cannot spend the budget researching somebody else's lead. */
router.post("/api/leads/:id/research", requireUser, express.json({ limit: "4kb" }),
  async (req, res, next) => {
    try {
      const id = +req.params.id;
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad lead id" });
      const lead = (await query(
        "SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL", [id])).rows[0];
      if (!lead) return res.status(404).json({ error: "no such lead" });

      const used = await usedToday(req.user.email);
      if (used >= DAILY_CAP)
        return res.status(429).json({
          error: `You have used today's ${DAILY_CAP} research briefings. This resets on a rolling 24 hours.`,
          cap: DAILY_CAP, used });

      /* Refuse rather than spend on nothing. With no name, no site and no
         town there is nothing to search for, and the model will return a
         confident paragraph about a company that does not exist. */
      if (!str(lead.company) && !str(lead.name) && !str(lead.website))
        return res.status(400).json({ error: "Not enough to research — this lead has no name or website." });

      /* Scrape first, then summarise. The model never sees the open web in
         this path — it is handed LinkedIn's own words about the company and
         asked to turn them into a briefing, which is a far shorter leash
         than "go and find out about these people".

         A scrape that finds nothing is not an error. Rather than hand back
         an empty panel we fall through to the search path, which is what
         the feature did before and still beats nothing. */
      const scraped = await linkedin.scrape(lead);
      const { prompt } = buildPrompt(lead, scraped.facts);
      const body = JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: prompt }],
        // no search budget when we already have the material
        ...(scraped.facts ? {} : { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }] }),
      });

      /* Straight to the shared proxy rather than an HTTP hop to ourselves:
         same process since the merge, and this way the circuit breaker and
         rate limits already in there apply to us too. No identity passed —
         requireUser above has authenticated the caller, and Leads' user ids
         are integers where the proxy's usage table keys on Connect's UUIDs. */
      const out = await handleClaude({
        method: "POST", bodyString: body, authHeader: "", identity: null,
      }, { requireAuth: false, recordUsage: false });

      if (out.status !== 200) {
        let msg = "The research service refused the request.";
        try { msg = JSON.parse(out.body)?.error?.message || msg; } catch { /* keep default */ }
        console.error("[karma] research upstream", out.status, msg);
        return res.status(out.status === 429 ? 429 : 502).json({ error: msg });
      }

      const data = JSON.parse(out.body);
      const text = (data.content || []).filter((c) => c.type === "text")
        .map((c) => c.text).join("\n");
      const brief = normalise(parseBrief(text));
      if (isEmpty(brief))
        return res.status(422).json({
          error: "Nothing verifiable turned up for this lead. Rather than guess, the briefing came back empty." });

      /* Supersede then insert, so the partial unique index holds and the
         previous picture is kept rather than overwritten. */
      await query(
        `UPDATE lead_research SET superseded_at = now()
          WHERE lead_id = $1 AND superseded_at IS NULL`, [id]);
      brief.source = scraped.facts ? "linkedin" : "web";
      const saved = (await query(
        `INSERT INTO lead_research (lead_id, brief, model, actor)
         VALUES ($1, $2, $3, $4) RETURNING created_at`,
        [id, brief, MODEL, req.user.email])).rows[0];

      activity.log({ actor: req.user.email, user_id: req.user.id, action: "enrich",
        lead_id: lead.id, lead_code: lead.lead_code, lead_name: lead.name,
        to_value: "researched",
        meta: { research: true, confidence: brief.confidence, source: brief.source } });

      res.json({ brief,
        meta: { model: MODEL, actor: req.user.email, at: saved.created_at,
          source: brief.source, scrapeActor: scraped.actor || null },
        cap: DAILY_CAP, used: used + 1 });
    } catch (e) { next(e); }
  });

module.exports = { router, DAILY_CAP };
