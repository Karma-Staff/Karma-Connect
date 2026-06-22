// Deterministic hallucination guard — NO AI tokens. Given a generated message and the
// source text the user actually provided (prospect fields + sender + analysis + context),
// flag "specific-looking" claims that don't trace back to that source: invented numbers/
// stats and invented brand/proper names. Heuristic and intentionally conservative — it
// would rather miss a borderline case than cry wolf on every message.

// Words that are commonly capitalized but carry no factual claim — never flagged as a
// fabricated name (greetings, sign-offs, days/months, generic connectors, the platform itself).
const ALLOW = new Set([
  "linkedin", "inmail", "ai", "ceo", "coo", "cfo", "cto", "vp", "hr", "it", "ok",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "hi", "hey", "hello", "dear", "thanks", "thank", "you", "best", "regards", "kind",
  "warm", "warmly", "cheers", "sincerely", "looking", "forward", "hope", "helps", "help",
  "talk", "soon", "take", "care", "happy", "glad", "great", "good", "morning",
  "afternoon", "evening", "the", "to", "and", "your", "our", "we", "let", "me", "know",
  "this", "that", "next", "week", "day", "team", "i", "i'm", "i've", "im",
]);

// Pull out numeric claims worth checking: percentages, money, multipliers (3x), and
// integers >= 10. Skips clock/duration numbers (15 minutes) and plain years (1900–2099).
function numericClaims(text) {
  const out = [];
  const re = /\d[\d,]*(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const digits = raw.replace(/[^\d]/g, "");
    if (!digits) continue;
    const n = parseInt(digits, 10);
    const start = m.index, end = re.lastIndex;
    const after = text.slice(end, end + 14).toLowerCase();
    const before = text.slice(Math.max(0, start - 14), start).toLowerCase();
    const isPct = text[end] === "%" || /^\s*(?:%|percent)/.test(after);
    const isMoney = text[start - 1] === "$" || /[$£€]\s*$/.test(before) || /^\s*(?:dollars|usd|k\b|m\b|million|billion)/.test(after);
    const isMult = /^\s*x\b/.test(after);
    // Clock/duration numbers are recognised by their trailing unit only (e.g. "15 minutes",
    // "3pm") — never by a preceding "by/at", which also precedes stats like "by 30%".
    const isTime = /^\s*(?:\s*min|minute|hour|hr|am|pm|second|sec|o'clock|:\d)/.test(after);
    const isYear = digits.length === 4 && n >= 1900 && n <= 2099;
    if (isTime || isYear) continue;
    if (isPct || isMoney || isMult || n >= 10) {
      out.push(raw + (text[end] === "%" ? "%" : isMult ? "x" : ""));
    }
  }
  return out;
}

// Candidate proper names: CamelCase brands (ServiceMaster) and 2+ consecutive Capitalized
// words (Acme Restoration). Title-cased sign-offs are dropped via the allow-list below.
function entityClaims(text) {
  const camel = text.match(/\b[A-Z][a-z]+[A-Z][A-Za-z]+\b/g) || [];
  const multi = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
  return [...camel, ...multi];
}

function digitInSource(digits, source) {
  return new RegExp("(?:^|[^\\d])" + digits + "(?:[^\\d]|$)").test(source);
}

// Returns an array of { claim, why } for anything in `text` not supported by `source`.
export function flagUnsupported(text, source) {
  if (!text) return [];
  const srcRaw = String(source || "");
  const src = " " + srcRaw.toLowerCase() + " ";
  const flags = [];
  const seen = new Set();
  const add = (claim, why) => {
    const k = claim.toLowerCase();
    if (!seen.has(k)) { seen.add(k); flags.push({ claim, why }); }
  };

  for (const claim of numericClaims(text)) {
    const digits = claim.replace(/[^\d]/g, "");
    if (digits && !digitInSource(digits, srcRaw)) add(claim, "number not in your data");
  }

  for (const ent of entityClaims(text)) {
    if (src.includes(ent.toLowerCase())) continue; // full phrase is supported
    // Words that actually carry a name (drop greetings/sign-offs like "Hi", "Best", "Regards").
    const significant = ent.split(/\s+/).filter((w) => !ALLOW.has(w.toLowerCase()));
    if (significant.length === 0) continue;
    // Supported if every meaningful word appears somewhere in the source (e.g. "Hi Jeremy").
    if (significant.every((w) => src.includes(w.toLowerCase()))) continue;
    add(ent, "name not in your data");
  }

  return flags;
}
