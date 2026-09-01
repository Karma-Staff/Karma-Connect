// Pull the prospect's details off their LinkedIn profile — the copy-paste the recruiter would
// otherwise do by hand. Runs while the agent is already on the page to send, so it costs no
// extra page load.
//
// Everything here is best-effort: LinkedIn changes its DOM often, so every field is optional and
// a miss returns null rather than throwing. A failed scrape must never cost us a send.
//
// Note this is personal data. It lands on the outreach_queue row (prospect_title,
// prospect_company, company_url) and inherits that row's retention.

// LinkedIn ships several markups; try each and take the first that yields text.
const NAME = ["h1.text-heading-xlarge", "main h1", "h1"];
const TITLE = [".text-body-medium.break-words", "main .text-body-medium", "[data-generated-suggestion-target] .text-body-medium"];
const COMPANY_LINK = [
  "a[href*='/company/'][data-field='experience_company_logo']",
  "section[id*='experience'] a[href*='/company/']",
  "a[href*='/company/']",
];

const clean = (s) => (s == null ? null : String(s).replace(/\s+/g, " ").trim() || null);

// First selector that produces non-empty text, else null.
async function firstText(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) {
        const t = clean(await el.innerText({ timeout: 1500 }));
        if (t) return t;
      }
    } catch (e) { /* try the next one */ }
  }
  return null;
}

// Normalise a company URL to its canonical /company/<slug>/ form, dropping tracking params.
function normaliseCompanyUrl(href) {
  if (!href) return null;
  const m = String(href).match(/linkedin\.com\/company\/([^/?#]+)/i);
  return m ? "https://www.linkedin.com/company/" + m[1] + "/" : null;
}

// Scrape the profile currently loaded in `page`.
// Returns { name, title, company, companyUrl, profileUrl } — any field may be null.
async function scrapeProfile(page) {
  const out = { name: null, title: null, company: null, companyUrl: null, profileUrl: null };

  try {
    const m = page.url().match(/linkedin\.com\/in\/[^/?#]+/i);
    out.profileUrl = m ? "https://www." + m[0].replace(/^www\./, "") : null;
  } catch (e) { /* leave null */ }

  out.name = await firstText(page, NAME);
  // The headline sits right under the name; it's the closest thing to a job title on the page.
  out.title = await firstText(page, TITLE);

  // Current company: the first /company/ link in the experience area, with its visible text as
  // the company name when we can get it.
  for (const sel of COMPANY_LINK) {
    try {
      const link = page.locator(sel).first();
      if (!(await link.count())) continue;
      const href = await link.getAttribute("href", { timeout: 1500 });
      const url = normaliseCompanyUrl(href);
      if (!url) continue;
      out.companyUrl = url;
      const label = clean(await link.innerText({ timeout: 1500 }).catch(() => ""));
      // Link text is often the logo alt or a multi-line blob; take the first meaningful line.
      out.company = label ? label.split("·")[0].trim().slice(0, 120) || null : null;
      break;
    } catch (e) { /* try the next selector */ }
  }

  // Fall back to the "Company · Full-time" pattern in the headline when there was no link.
  if (!out.company && out.title && out.title.includes(" at ")) {
    out.company = clean(out.title.split(" at ").slice(1).join(" at ")).slice(0, 120);
  }

  return out;
}

module.exports = { scrapeProfile, normaliseCompanyUrl };
