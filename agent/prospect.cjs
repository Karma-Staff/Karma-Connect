// Finding prospects: run one LinkedIn people search the server asked for (li-prospecting.cjs
// nextSearch) and read who is on the page. Nothing here clicks Connect or types anything: the
// server picks the decision-makers out of this list and queues their invitations, which then go
// out through the ordinary invite path (invite.cjs), inside the same limits.
//
// LinkedIn renders search results with hashed class names, so this reads the page by shape: each
// result is a list item holding a link to /in/<handle>; its text lines are the name, the degree,
// the headline and the location, in that order, among labels like "View Jane's profile".
const { haltReason } = require("./session.cjs");
const { jitter } = require("./send.cjs");

const handleOf = (url) => {
  const m = String(url || "").match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  if (!m) return "";
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch (e) { return m[1].toLowerCase(); }
};

// The results on the page: [{ handle, name, headline, location, degree }].
async function readResults(page) {
  return page.evaluate(() => {
    const NOISE = [/^view .*profile$/i, /degree connection$/i, /^(connect|follow|message|pending|following|send inmail)$/i,
      /mutual connection/i, /^status is /i, /^[•·]\s*$/, /^(1st|2nd|3rd\+?)$/i, /provides services/i, /^current:/i, /^past:/i, /^summary:/i];
    const out = [], seen = new Set();
    const items = document.querySelectorAll("main li, main [data-chameleon-result-urn], main div[data-view-name='search-entity-result-universal-template']");
    for (const li of items) {
      const a = li.querySelector("a[href*='/in/']");
      if (!a) continue;
      const m = (a.getAttribute("href") || "").match(/\/in\/([^/?#]+)/i);
      if (!m || seen.has(m[1])) continue;
      const text = li.innerText || "";
      if (text.length > 1500) continue;          // a container around many results, not one
      // "• 2nd" runs straight into the hidden "2nd degree connection" label: no word boundary after it
      const degree = (text.match(/(?:^|[\s•·])(1st|2nd|3rd\+?)/) || [])[1] || "";
      const lines = text.split("\n").map((s) => s.replace(/^[•·]\s*/, "").trim()).filter(Boolean)
        .filter((s) => !NOISE.some((r) => r.test(s)));
      const nameEl = a.querySelector("span[aria-hidden='true']");
      const name = ((nameEl && nameEl.innerText) || lines[0] || "").split("\n")[0].trim();
      if (!name) continue;
      const rest = lines.filter((s) => s !== name);
      seen.add(m[1]);
      out.push({ handle: m[1], name, headline: rest[0] || "", location: rest[1] || "", degree });
      if (out.length >= 25) break;
    }
    return out;
  });
}

// Open the search and read it. Returns { candidates, halt, note }.
async function searchPeople(page, url) {
  if (!/^https:\/\/www\.linkedin\.com\/search\/results\/people\//.test(String(url || ""))) {
    return { candidates: [], halt: "", note: "not a LinkedIn people search" };
  }
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await jitter(3000, 6000);
  const halt = await haltReason(page);
  if (halt) return { candidates: [], halt };
  // Results load as you scroll: go down the page once, the way a person reading it would.
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 700 + Math.random() * 500).catch(() => {});
    await jitter(900, 1800);
  }
  const body = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  if (/reached the monthly limit|commercial use limit/i.test(body)) {
    return { candidates: [], halt: "", note: "LinkedIn's monthly search limit for this account is reached — searching again next month", limit: true };
  }
  const candidates = (await readResults(page).catch(() => [])).map((c) => ({ ...c, handle: handleOf("linkedin.com/in/" + c.handle) })).filter((c) => c.handle);
  if (!candidates.length) return { candidates, halt: "", note: /no results found/i.test(body) ? "no results" : "RESULTS NOT FOUND — LinkedIn's search page may have changed" };
  return { candidates, halt: "", note: candidates.length + " people on the page" };
}

module.exports = { searchPeople, readResults };
