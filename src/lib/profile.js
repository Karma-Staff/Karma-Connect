// Turn a copied LinkedIn profile page (Ctrl+A, Ctrl+C — by hand in the Deep LinkedIn paste
// panel, or by the LinkedIn agent after someone accepts) into prospect fields. One parser for
// both, so an agent-copied profile is read exactly like a pasted one.
import { anthropicMsg, CLAUDE_FAST_MODEL } from "./claude.js";
import { safeJSON } from "./json.js";
import { stripLinkedInNoise } from "./text.js";

const SYSTEM = `You are an expert LinkedIn profile parser. You receive raw copy-pasted LinkedIn page text (Ctrl+A, Ctrl+C from a browser). The text contains the real profile mixed with LinkedIn UI noise: nav menus, ads, sidebars, "People also viewed", suggested connections, footer links, button labels, notification counts. Extract ONLY the actual profile data for the main person the page is about.

CRITICAL RULES:
- Return ONLY a single valid JSON object. No markdown. No code fences. No preamble. No commentary. Start your response with { and end with }.
- Every string value must be properly JSON-escaped. Escape all double quotes inside values as \\". Escape all newlines as \\n. Never use unescaped control characters inside string values.
- If a field has no data, use an empty string "". Never omit a field.
- For long fields like "about" and "experience": include ALL content, do not truncate. Use \\n to separate paragraphs and entries.
- "experience" should list every role as: TITLE at COMPANY (DATE_RANGE)\\nDescription if any. One entry per line.`;

const userPrompt = (raw) => `Extract every profile field from this raw LinkedIn page paste. Return a single JSON object with exactly these keys:
firstName, lastName, title, company, industry, location, headline, about, experience, education, skills, certifications, recommendations, recentPosts, mutualConnections, companyDesc, news, website, volunteering, languages, extraNotes, fieldsFound (array of field names you found data for), quality (high/medium/low string), qualityNote (one sentence string).

RAW PASTE:
${stripLinkedInNoise(raw).slice(0, 24000)}`;

const KEYS = ["firstName", "lastName", "title", "company", "industry", "location", "headline", "about", "experience",
  "education", "skills", "certifications", "recommendations", "recentPosts", "mutualConnections", "companyDesc",
  "news", "website", "volunteering", "languages", "extraNotes"];

// Parse the page text. Returns the extracted object (every key present), or throws when
// nothing at all could be read from it.
export async function parseProfileText(raw) {
  const txt = await anthropicMsg(SYSTEM, userPrompt(raw), { maxTokens: 6000, model: CLAUDE_FAST_MODEL });
  let d;
  try {
    d = safeJSON(txt);
  } catch (parseErr) {
    // Salvage field by field when the JSON as a whole won't parse.
    const grab = (key) => { const m = txt.match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"')); return m ? m[1].replace(/\\n/g, "\n") : ""; };
    d = Object.fromEntries(KEYS.map((k) => [k, grab(k)]));
    Object.assign(d, { fieldsFound: [], quality: "low", qualityNote: "Partial extraction due to response format issue." });
    const anyFound = Object.values(d).some((v) => typeof v === "string" && v.trim().length > 0);
    if (!anyFound) throw new Error("Could not extract any profile data. Make sure you selected all text on the LinkedIn page (Ctrl+A then Ctrl+C) and try again.");
  }
  if (!d || typeof d !== "object") throw new Error("Unexpected response format. Try again.");
  return d;
}

const safeStr = (v) => (typeof v === "string" ? v.replace(/\\n/g, "\n").trim() : "");

// Fold parsed fields into a prospect: profile fields overwrite, the rest is appended to
// research / notes / mutual. Returns a new prospect object.
export function mergeParsed(p, d) {
  const next = { ...p };
  ["firstName","lastName","title","company","industry","location","headline","about","experience","website","companyDesc","news"]
    .forEach((k) => { if (safeStr(d[k])) next[k] = safeStr(d[k]); });
  const extras = [];
  if (safeStr(d.education)) extras.push("Education: " + safeStr(d.education));
  if (safeStr(d.skills)) extras.push("Skills: " + safeStr(d.skills));
  if (safeStr(d.certifications)) extras.push("Certifications: " + safeStr(d.certifications));
  if (safeStr(d.volunteering)) extras.push("Volunteering: " + safeStr(d.volunteering));
  if (safeStr(d.languages)) extras.push("Languages: " + safeStr(d.languages));
  if (safeStr(d.extraNotes)) extras.push("Other: " + safeStr(d.extraNotes));
  if (extras.length) next.research = (next.research ? next.research + "\n\n" : "") + "From LinkedIn paste:\n" + extras.join("\n");
  const noteBlocks = [];
  if (safeStr(d.recommendations)) noteBlocks.push("Recommendations:\n" + safeStr(d.recommendations));
  if (safeStr(d.recentPosts)) noteBlocks.push("Recent posts / activity:\n" + safeStr(d.recentPosts));
  if (noteBlocks.length) next.notes = (next.notes ? next.notes + "\n\n" : "") + noteBlocks.join("\n\n");
  if (safeStr(d.mutualConnections)) next.mutual = (next.mutual ? next.mutual + " | " : "") + safeStr(d.mutualConnections);
  return next;
}

// How many fields the parse found — for the "N fields extracted" line.
export function fieldsFoundCount(d) {
  return Array.isArray(d.fieldsFound) ? d.fieldsFound.length : Object.values(d).filter((v) => typeof v === "string" && v.trim()).length;
}
