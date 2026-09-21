"use strict";
/* The briefing: its prompt, and the parsing of what comes back.

   Split from research.js (the route) because this half is pure — no
   database, no network, no API key — and it is the half that breaks
   quietly. A model that returns prose around its JSON, or an array where a
   string was asked for, must not reach the reading pane as "[object
   Object]" in front of a rep on a call. brief.test.js exercises exactly
   that. */

const MAX_SEARCHES = 3;

const SYSTEM = `You are a precise B2B prospect researcher preparing a salesperson for a first call.

Two rules matter more than completeness:
1. State only what you can verify from web search. Never guess a person's education, employer history, interests or achievements. A wrong detail used as an opener destroys the call.
2. Any field you cannot verify must be an empty string "" or an empty array []. An empty field is a correct answer. Do not fill space.

Do not infer a person's details from their employer, their name, or their job title. Do not repeat the input back as if you had found it.

Return ONLY a single valid JSON object. No markdown, no code fences, no commentary. Start with { and end with }.`;

const L = (k, v) => (v && String(v).trim() ? k + ": " + String(v).trim() + "\n" : "");

/* The briefing shape. Named fields rather than free prose because the
   reading pane renders each section differently and can drop the empty
   ones — prose would have to be shown whole or not at all. */
function buildPrompt(lead) {
  const person = lead.kind === "person";
  const who = person ? lead.name : lead.contact;

  let s = person
    ? "Research THIS PERSON and their employer for a first sales call.\n"
    : "Research THIS COMPANY for a first sales call.\n";
  s += L(person ? "Name" : "Company", lead.company || lead.name);
  if (!person) s += L("Named contact at the company", lead.contact);
  s += L("Job title", lead.title || lead.contact_title);
  s += L("Website", lead.website);
  s += L("Location", [lead.city, lead.state].filter(Boolean).join(", "));
  s += L("Industry", lead.industry || lead.category);
  if (lead.kind === "job") s += L("They are currently hiring for", lead.name);

  s += `
The caller sells staffing to restoration, construction and trades businesses.

Use up to ${MAX_SEARCHES} web searches. Prefer the company's own site, then recent news, then reputable directories.

Return ONLY this JSON:
{
  "headline": "",
  "whatTheyDo": "",
  "size": "",
  "recentSignals": [],
  "congratulations": [],
  "person": { "role": "", "background": "", "education": "", "interests": [] },
  "talkingPoints": [],
  "avoid": [],
  "sources": [],
  "confidence": ""
}

Field rules:
- "headline": one sentence a rep could read aloud before dialling. Always fill this if you found anything at all.
- "whatTheyDo": 1-2 sentences, plain language, no marketing copy.
- "size": employees, branches or service area, only if stated somewhere.
- "recentSignals": up to 3 dated, verifiable items — new office, award, hiring push, storm response, acquisition. Each under 20 words, each with its date or "recent" only if the source itself is undated.
- "congratulations": up to 2 genuine, specific openers drawn ONLY from recentSignals or a verified personal milestone. Phrase each as the rep would say it. If nothing real was found, return [] — a generic compliment is worse than none.
- "person": fill ONLY for a named individual you actually found. "education" must be a school they are documented as attending. "interests" only from their own public writing or profile. Leave the whole object's fields "" / [] otherwise.
- "talkingPoints": up to 4 angles connecting THEIR situation to staffing needs. These may be reasoned, not just quoted — but ground each in something above.
- "avoid": up to 2 things not to raise (recent layoffs, a lawsuit, a sensitive closure). [] if nothing.
- "sources": up to 4 URLs you actually used.
- "confidence": "high", "medium" or "low" — how much of this is verified rather than thin.`;
  return { prompt: s, person, who };
}

/* Models wrap JSON in prose or fences often enough that the naive parse is a
   bug waiting to happen; take the outermost braces. */
function parseBrief(text) {
  const raw = String(text || "");
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(raw.slice(a, b + 1)); } catch { return null; }
}

const str = (v) => (typeof v === "string" ? v.trim() : "");
const list = (v, n) => (Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, n) : []);

/* Trust nothing about the shape. A missing field renders as absent; a field
   of the wrong type would render as "[object Object]" in front of a rep. */
function normalise(b) {
  const p = b && typeof b.person === "object" && b.person ? b.person : {};
  return {
    headline: str(b?.headline),
    whatTheyDo: str(b?.whatTheyDo),
    size: str(b?.size),
    recentSignals: list(b?.recentSignals, 3),
    congratulations: list(b?.congratulations, 2),
    person: {
      role: str(p.role), background: str(p.background),
      education: str(p.education), interests: list(p.interests, 5),
    },
    talkingPoints: list(b?.talkingPoints, 4),
    avoid: list(b?.avoid, 2),
    sources: list(b?.sources, 4).filter((u) => /^https?:\/\//i.test(u)),
    confidence: ["high", "medium", "low"].includes(str(b?.confidence)) ? str(b.confidence) : "",
  };
}

const isEmpty = (b) => !b.headline && !b.whatTheyDo && !b.recentSignals.length
  && !b.talkingPoints.length && !b.person.role && !b.person.education;

module.exports = { SYSTEM, buildPrompt, parseBrief, normalise, isEmpty, MAX_SEARCHES, str };
