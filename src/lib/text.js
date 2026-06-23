// Text post/pre-processing: hyphen stripping (anti-AI-fingerprint net) and LinkedIn paste cleanup.

// Remove all em/en dashes and mid-sentence separator hyphens from generated messages.
// The prompt instruction is the first line of defense; this is the safety net.
export function stripHyphens(text) {
  if (!text) return text;
  // Note: all whitespace handling below preserves "\n" so paragraph breaks survive — only
  // horizontal whitespace (spaces/tabs) is collapsed. [^\S\n] = whitespace that isn't a newline.
  return text
    .replace(/\r\n/g, "\n")
    // em dash with optional spaces -> comma+space or just space depending on context
    .replace(/[^\S\n]*—[^\S\n]*/g, (_, offset, str) => {
      const before = str[offset - 1];
      return (before && /\w/.test(before)) ? ", " : " ";
    })
    // en dash with spaces (used as separator) -> comma or space
    .replace(/[^\S\n]*–[^\S\n]*/g, ", ")
    // hyphen used as mid-sentence pause: " - " -> ", "
    .replace(/ - /g, ", ")
    // double hyphen -- used as dash -> comma
    .replace(/[^\S\n]*--[^\S\n]*/g, ", ")
    // clean up any double commas or comma+space artifacts
    .replace(/,[^\S\n]*,/g, ",")
    // collapse runs of spaces/tabs (but NOT newlines), tidy trailing space before a newline,
    // and cap blank-line runs at one so paragraphs are separated, not doubled-up.
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/[^\S\n]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Apply stripHyphens to every message field in a parsed array or object.
export function cleanMessages(parsed) {
  if (!parsed) return parsed;
  const cleanItem = (item) => {
    if (!item || typeof item !== "object") return item;
    const out = { ...item };
    if (typeof out.message === "string") out.message = stripHyphens(out.message);
    if (typeof out.subject === "string") out.subject = stripHyphens(out.subject);
    if (typeof out.reasoning === "string") out.reasoning = stripHyphens(out.reasoning);
    if (typeof out.fresh === "string") out.fresh = stripHyphens(out.fresh);
    if (typeof out.persona === "string") out.persona = stripHyphens(out.persona);
    return out;
  };
  if (Array.isArray(parsed)) return parsed.map(cleanItem);
  return cleanItem(parsed);
}

// Pre-trim a raw LinkedIn page paste: drop obvious UI/nav chrome and collapse blank runs
// so we ship fewer junk tokens to the model. Conservative — keeps all real profile text.
export function stripLinkedInNoise(raw) {
  if (!raw) return "";
  const noise = /^(Skip to (main|search)|Keyboard shortcuts|Close jump menu|Search\b|Home$|My Network|Jobs$|Messaging|Notifications$|Try Premium|Try for free|Promoted|Ad$|People also viewed|People you may know|Others named|Show (all|more)|See (all|more|profile)|Follow$|Following$|\+ Follow|Connect$|Message$|More$|Pending$|Status is (online|offline|reachable)|new feed update|Activate to view larger image|Loading|Report this|Save$|Saved$|Like$|Comment$|Repost$|Send$|·|•|\d+(st|nd|rd|th)\s*degree connection)/i;
  const out = [];
  let blanks = 0;
  for (const ln of raw.split(/\r?\n/)) {
    const t = ln.trim();
    if (!t) { if (++blanks > 1) continue; out.push(""); continue; }
    blanks = 0;
    if (noise.test(t)) continue;
    if (t.length <= 2) continue; // stray icons / counters
    out.push(t);
  }
  return out.join("\n");
}
