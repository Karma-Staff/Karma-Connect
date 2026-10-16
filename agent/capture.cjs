// Copy a whole LinkedIn profile page as text — what a person gets from Ctrl+A, Ctrl+C on it —
// for Karma Connect's profile parser (the same one behind the Deep LinkedIn paste panel).
//
// Used after an invitation is accepted: the Send Queue parses this text, analyses the person,
// saves both to the lead, and drafts a first message that a person approves.
//
// The text is read from the page (innerText), not the clipboard: the clipboard needs browser
// permissions and is shared with whatever the user is doing on this machine. Collapsed "see
// more" sections are opened and the lazy sections (experience, education, skills) scrolled
// into existence first, so the copy is as complete as a careful manual one.
const { haltReason } = require("./session.cjs");
const { jitter } = require("./send.cjs");

const MAX = 60000;

// Open the collapsed bits and scroll the lazy sections in.
async function prepare(page) {
  try {
    const more = page.locator("main button:has-text('see more'), main button[aria-label*='see more' i], main button:has-text('…more')");
    const n = Math.min(await more.count(), 4);
    for (let i = 0; i < n; i++) {
      const b = more.nth(i);
      if (await b.isVisible({ timeout: 800 }).catch(() => false)) { await b.click({ timeout: 2000 }).catch(() => {}); await jitter(300, 700); }
    }
  } catch (e) { /* nothing to expand */ }
  try {
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 700) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 250));
      }
      window.scrollTo(0, 0);
    });
    await jitter(800, 1500);
  } catch (e) { /* whatever rendered is what we get */ }
}

// The text of the page that's open now. <main> is the profile; the whole body is the fallback.
async function pageText(page) {
  await prepare(page);
  try {
    const t = await page.evaluate(() => {
      const el = document.querySelector("main");
      return ((el && el.innerText) || document.body.innerText || "").trim();
    });
    return String(t || "").slice(0, MAX);
  } catch (e) { return ""; }
}

// Go to a profile and copy it. Returns { text, halt }.
async function captureProfile(page, handle) {
  const url = "https://www.linkedin.com/in/" + encodeURIComponent(handle) + "/";
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await jitter(2500, 5000);
  const halt = await haltReason(page);
  if (halt) return { text: "", halt };
  return { text: await pageText(page), halt: "" };
}

module.exports = { captureProfile, pageText };
