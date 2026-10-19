// The browser session the agent works in.
//
// The agent never handles your LinkedIn password. It drives a PERSISTENT browser profile stored
// on this machine (agent/.profile by default): you sign in there by hand once, and the session
// cookie survives restarts, so every run after that is unattended. When the cookie eventually
// expires the agent stops and asks you to sign in again — it does not try to log in for you.
//
// Why: a scripted password login is the strongest automation signal LinkedIn has, and it stalls
// on MFA/device checkpoints anyway. Logging in by hand once costs a minute a month and avoids
// both problems.
const path = require("node:path");
const fs = require("node:fs");

const PROFILE_DIR = process.env.LI_AGENT_PROFILE_DIR || path.join(__dirname, ".profile");
const HEADLESS = String(process.env.LI_AGENT_HEADLESS || "false") === "true";
const NAV_TIMEOUT = 45000;

// Playwright is an optional peer — the server doesn't need it, only this worker does. Fail with
// an instruction rather than a stack trace.
function loadPlaywright() {
  try { return require("playwright"); }
  catch (e) {
    throw new Error("Playwright isn't installed. Run:  npm install playwright && npx playwright install chromium");
  }
}

// Signed-in check that doesn't depend on scraping the feed: /feed redirects to a login or
// checkpoint URL when the session is gone.
const LOGGED_OUT_RE = /\/(login|uas\/login|checkpoint|authwall)/i;

// Open the persistent profile. Headed by default — you want to see what it is doing, and a
// visible window is also how you complete the one-time sign-in.
async function open() {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  // Which browser to drive: LI_AGENT_BROWSER = msedge | chrome | chromium (default msedge).
  // Edge is the default because it's what LinkedIn accepted a signed-in session in during
  // testing — Google's OAuth screen refuses automated browsers outright, and the saved session
  // lives in whichever browser you signed into. Changing this means signing in again.
  // Set it to try a different one — note this changes the browser, NOT whether the browser
  // announces itself as automated. Every Playwright-driven browser sets navigator.webdriver and
  // runs a CDP connection, and that is what LinkedIn checks at login. Switching brands is a
  // reasonable thing to try; it is not a way round the check.
  //
  // Deliberately no anti-detection flags or fingerprint patching. If LinkedIn decides this looks
  // automated, the right answer is to stop and let a human take over — see haltReason() — not to
  // hide from it. Pacing and low caps are the whole safety story.
  // chromiumSandbox: true keeps Chrome's sandbox ON. Playwright disables it by default for
  // persistent contexts, which triggers the "unsupported command-line flag: --no-sandbox"
  // banner and, more to the point, removes the browser's main defence against a hostile page —
  // in a window the user signs into LinkedIn with.
  const opts = { headless: HEADLESS, viewport: { width: 1280, height: 900 }, chromiumSandbox: true };
  const want = String(process.env.LI_AGENT_BROWSER || "msedge").toLowerCase();
  const order = want === "chromium" ? [null] : [want, "msedge", "chrome", null];

  let ctx = null;
  let used = "";
  for (const channel of order) {
    try {
      ctx = await chromium.launchPersistentContext(PROFILE_DIR, channel ? { ...opts, channel } : opts);
      used = channel || "chromium";
      console.log("Browser: " + (channel || "bundled Chromium"));
      break;
    } catch (e) {
      if (channel) console.log("Could not launch " + channel + " — trying the next option.");
    }
  }
  if (!ctx) throw new Error("No usable browser found. Try LI_AGENT_BROWSER=chromium.");
  ctx.setDefaultTimeout(NAV_TIMEOUT);
  ctx.setDefaultNavigationTimeout(NAV_TIMEOUT);
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page, browser: used };
}

// Which LinkedIn account this profile is signed in to: /in/me/ redirects to your own profile.
// Shown in Karma Connect so nobody sends from the wrong account by accident.
async function whoAmI(page) {
  await page.goto("https://www.linkedin.com/in/me/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  if (LOGGED_OUT_RE.test(page.url())) return null;
  const m = page.url().match(/linkedin\.com\/in\/([^/?#]+)/i);
  let handle = "";
  try { handle = m ? decodeURIComponent(m[1]) : ""; } catch (e) { handle = m ? m[1] : ""; }
  // The tab title is "(3) Jane Doe | LinkedIn" — steadier than any heading selector.
  const title = await page.title().catch(() => "");
  let name = title.replace(/^\(\d+\+?\)\s*/, "").split(" | ")[0].trim();
  if (!name || /^linkedin$/i.test(name)) name = await page.locator("h1").first().innerText({ timeout: 4000 }).then((t) => t.trim()).catch(() => "");
  return { handle: handle === "me" ? "" : handle, name: name.slice(0, 120) };
}

// Is this profile signed in? Navigates to the feed and looks at where it landed.
async function isSignedIn(page) {
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  return !LOGGED_OUT_RE.test(page.url());
}

// One-time setup: open the profile and wait for the human to sign in. Called by `npm run
// agent:login`. Polls until the feed loads, then closes — the cookie is now in the profile.
async function login({ waitMinutes = 10 } = {}) {
  const { ctx, page } = await open();
  await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded" });
  console.log("\nA browser window is open. Sign in to LinkedIn there with your email and");
  console.log("password — do NOT use \"Continue with Google\", which refuses automated browsers.");
  console.log("Waiting for you… this window closes by itself once you're in.\n");
  const deadline = Date.now() + waitMinutes * 60000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    if (!LOGGED_OUT_RE.test(page.url())) {
      await page.waitForTimeout(2000);
      if (!LOGGED_OUT_RE.test(page.url())) {
        console.log("Signed in. The session is saved in " + PROFILE_DIR);
        await ctx.close();
        return true;
      }
    }
  }
  console.error("Timed out waiting for sign-in.");
  await ctx.close();
  return false;
}

// LinkedIn interstitials the agent must never try to get past. Seeing any of these is a full
// stop: the run ends, the agent switches itself off, and a human picks it up.
const HALT_SELECTORS = [
  "input[name='captcha']",
  "iframe[title*='captcha' i]",
  "iframe[src*='challenge']",
  ".challenge-dialog",
  "#captcha-internal",
];
const HALT_TEXT = [
  /you.{0,3}ve reached the (weekly|monthly) invitation limit/i,
  /you.{0,3}ve reached the limit/i,
  /unusual activity/i,
  /let.{0,3}s do a quick security check/i,
  /verify (your identity|it.{0,3}s you)/i,
  /restricted/i,
];

// Look for a reason to stop. Returns a string reason, or "" when the page looks normal.
async function haltReason(page) {
  if (LOGGED_OUT_RE.test(page.url())) return "LinkedIn signed the agent out — run `npm run agent:login` to sign in again.";
  for (const sel of HALT_SELECTORS) {
    try { if (await page.locator(sel).first().isVisible({ timeout: 500 })) return "LinkedIn showed a security challenge."; }
    catch (e) { /* not present */ }
  }
  let text = "";
  try { text = (await page.locator("body").innerText({ timeout: 2000 })).slice(0, 6000); } catch (e) { return ""; }
  for (const re of HALT_TEXT) if (re.test(text)) return "LinkedIn showed: " + (text.match(re) || [""])[0].slice(0, 120);
  return "";
}

module.exports = { open, isSignedIn, login, haltReason, whoAmI, PROFILE_DIR, HEADLESS };
