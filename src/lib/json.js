// Defensive JSON parsing for LLM output: handles fences, trailing commas, unescaped control
// characters, and salvages objects from noisy text. safeJSON is the public entry point.

export function extractObjects(text) {
  const objs = []; let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") { depth--; if (depth === 0 && start !== -1) { try { objs.push(JSON.parse(text.slice(start, i + 1))); } catch (e) {} start = -1; } }
  }
  return objs;
}

// Attempt to fix common JSON issues: unescaped newlines/tabs inside strings, trailing commas.
export function repairJSON(t) {
  // Remove trailing commas before } or ]
  t = t.replace(/,\s*([\]}])/g, "$1");
  // Replace literal newlines inside strings with \n
  let inStr = false, esc = false, out = "";
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) { esc = false; out += ch; continue; }
      if (ch === "\\") { esc = true; out += ch; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

export function safeJSON(text) {
  if (!text) throw new Error("Empty response from AI. Please try again.");
  let t = text.trim();
  // Strip markdown code fences
  t = t.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  // Try direct parse
  try { return JSON.parse(t); } catch (e) {}
  // Try repairing then parsing
  try { return JSON.parse(repairJSON(t)); } catch (e) {}
  // Try extracting JSON array
  const a = t.indexOf("["), b = t.lastIndexOf("]");
  if (a !== -1 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {}
    try { return JSON.parse(repairJSON(t.slice(a, b + 1))); } catch (e) {}
  }
  // Try extracting JSON object
  const c = t.indexOf("{"), d = t.lastIndexOf("}");
  if (c !== -1 && d > c) {
    try { return JSON.parse(t.slice(c, d + 1)); } catch (e) {}
    try { return JSON.parse(repairJSON(t.slice(c, d + 1))); } catch (e) {}
  }
  // Last resort: extract all objects via brace matching
  const salv = extractObjects(t);
  if (salv.length) return salv.length === 1 ? salv[0] : salv;
  throw new Error("Could not read the AI response — the output was malformed. Try again.");
}
