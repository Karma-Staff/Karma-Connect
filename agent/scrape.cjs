// Pull the prospect's details off their LinkedIn profile — the copy-paste the recruiter would
// otherwise do by hand. Runs while the agent is already on the page to send, so it costs no
// extra page load.
//
// Written against LinkedIn's CURRENT markup, which matters: LinkedIn ships hashed, build-
// generated CSS class names (`_1606d8cb`, `fdde4d3f`) that change on every deploy, and the
// profile has no <h1>. Anything targeting a class is broken before it ships. So this uses only
// the three things that stay put:
//
//   1. document.title           — "Justin Curran | LinkedIn"
//   2. [data-view-name="..."]   — LinkedIn's own semantic hooks, not hashed
//   3. href patterns            — /company/<slug>
//
// Every field is optional and a miss returns null rather than throwing: a failed scrape must
// never cost us a send.
//
// Note this is personal data. It lands on the outreach_queue row (prospect_title,
// prospect_company, company_url) and inherits that row's retention.

const TOP_CARD = '[data-view-name="profile-top-card"]';
const DEGREE_RE = /^·?\s*(1st|2nd|3rd|\d+(st|nd|rd|th))\s*$/i; // the "· 2nd" connection-degree line
const clean = (s) => (s == null ? null : String(s).replace(/\s+/g, " ").trim() || null);

// The person's name, from the tab title. By far the most stable source on the page.
function nameFromTitle(title) {
  const t = clean(String(title || "").replace(/\s*\|\s*LinkedIn\s*$/i, ""));
  return t && t.toLowerCase() !== "linkedin" ? t : null;
}

// Canonical /company/<slug>/ form, tracking params dropped.
function normaliseCompanyUrl(href) {
  if (!href) return null;
  const m = String(href).match(/linkedin\.com\/company\/([^/?#]+)/i);
  return m ? "https://www.linkedin.com/company/" + m[1] + "/" : null;
}

// Read the top card's visible lines. They come out in a consistent order:
//   name / "· 2nd" / headline / location / "·" / "Contact info" / company / "202" / connections
// so the headline is the first real line after the name and degree, and the company is the line
// directly after "Contact info".
function parseTopCard(lines) {
  const out = { headline: null, location: null, company: null };
  const rows = (lines || []).map(clean).filter(Boolean);
  if (!rows.length) return out;

  let i = 1; // row 0 is the name
  while (i < rows.length && (DEGREE_RE.test(rows[i]) || rows[i] === "·")) i++;
  if (i < rows.length) { out.headline = rows[i]; i++; }
  while (i < rows.length && rows[i] === "·") i++;
  if (i < rows.length && !/^contact info$/i.test(rows[i])) { out.location = rows[i]; i++; }

  const ci = rows.findIndex((r) => /^contact info$/i.test(r));
  if (ci > -1 && ci + 1 < rows.length) {
    const next = rows[ci + 1];
    // Guard against running into the connection count when there's no employer shown.
    if (!/^\d[\d,]*$/.test(next) && !/^\d+\s*connections?$/i.test(next)) out.company = next.slice(0, 120);
  }
  return out;
}

// Scrape the profile currently loaded in `page`.
// Returns { name, title, company, companyUrl, profileUrl } — any field may be null.
async function scrapeProfile(page) {
  const out = { name: null, title: null, company: null, companyUrl: null, profileUrl: null };

  try {
    const m = page.url().match(/linkedin\.com\/in\/[^/?#]+/i);
    if (m) out.profileUrl = "https://www." + m[0].replace(/^www\./, "");
  } catch (e) { /* leave null */ }

  try { out.name = nameFromTitle(await page.title()); } catch (e) { /* leave null */ }

  // Everything else comes out of the top card, in one page evaluation.
  let card = null;
  try {
    card = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const lines = (el.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 14);
      // Only company links INSIDE the top card. A page-wide search picks up the "people also
      // viewed" sidebar and would report a completely unrelated employer.
      const a = el.querySelector("a[href*='/company/']");
      return { lines, companyHref: a ? a.getAttribute("href") : null };
    }, TOP_CARD);
  } catch (e) { /* leave the card fields null */ }

  if (card) {
    const parsed = parseTopCard(card.lines);
    out.title = parsed.headline;
    out.company = parsed.company;
    out.companyUrl = normaliseCompanyUrl(card.companyHref);
    if (!out.name && card.lines && card.lines.length) out.name = clean(card.lines[0]);
  }

  // Headlines are often "Role at Company" — use that only when the card gave us nothing better.
  if (!out.company && out.title && out.title.includes(" at ")) {
    out.company = clean(out.title.split(" at ").slice(1).join(" at "));
    if (out.company) out.company = out.company.slice(0, 120);
  }

  return out;
}

module.exports = { scrapeProfile, normaliseCompanyUrl, nameFromTitle, parseTopCard };
