// Send one approved message on LinkedIn: open the profile, scrape it, open the message
// composer, type the body, press Send.
//
// The body is passed in verbatim from the Karma Connect queue — this module never writes or
// edits message text. It only puts an already-approved message into the box.
//
// Every outcome is one of three, and the caller reports it back to the server:
//   { result: 'sent'   }  it went out
//   { result: 'failed' }  this profile didn't work (no Message button, composer wouldn't open)
//   { result: 'halted' }  LinkedIn asked for a human — stop everything, don't retry
const { haltReason } = require("./session.cjs");
const { scrapeProfile } = require("./scrape.cjs");

// The Message control is an <a> pointing at /messaging/compose (wrapped in a div carrying a
// data-view-name) — NOT a <button>, which is why a button-only selector found nothing on a
// profile plainly showing "Message". LinkedIn's class names are hashed and regenerated every
// deploy (a13b6c0c, _8751a942…), so only the href pattern and data-view-name are safe to target.
// Ordered most stable first.
const MESSAGE_BUTTON = [
  "a[href*='/messaging/compose']",
  "[data-view-name='profile-secondary-message']",
  "[data-view-name='profile-top-card'] button:has-text('Message')",
  "main button:has-text('Message')",
  "button[aria-label^='Message']",
  "main a[href*='/messaging/thread']",
];
const COMPOSER_BOX = [
  "div.msg-form__contenteditable[contenteditable='true']",
  "div[contenteditable='true'][role='textbox']",
  "div[aria-label*='message' i][contenteditable='true']",
];
const SEND_BUTTON = [
  "button.msg-form__send-button:not([disabled])",
  "button[type='submit']:has-text('Send'):not([disabled])",
  "button:has-text('Send'):not([disabled])",
];
// The thread transcript, for confirming the message actually landed.
const THREAD_LIST = [
  ".msg-s-message-list-content",
  ".msg-s-message-list",
  "div[role='log']",
];

// Sleep a random time in [min,max] ms — the agent never acts at a metronome-steady rate.
const jitter = (min, max) => new Promise((r) => setTimeout(r, Math.floor(min + Math.random() * (max - min))));

// First selector that is actually visible, else null.
async function firstVisible(page, selectors, timeout = 6000) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      await el.waitFor({ state: "visible", timeout });
      return el;
    } catch (e) { /* try the next */ }
  }
  return null;
}

// Type like a person: character bursts with small gaps, not one instant paste.
async function typeBody(el, body) {
  await el.click();
  await jitter(200, 600);
  const lines = String(body).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await el.type(lines[i], { delay: 18 + Math.random() * 42 });
    // Shift+Enter keeps the newline inside the message instead of sending it. Not after the last
    // line though — that would leave a trailing blank line in the sent message.
    if (i < lines.length - 1) await el.press("Shift+Enter");
    await jitter(120, 400);
  }
}

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

// Did the message actually go out? Clicking Send only means the click dispatched — the composer
// can silently reject it, and a row wrongly marked 'sent' is invisible precisely because nobody
// looks at sent items again. Returns:
//   'sent'        the text is in the thread. Certain.
//   'not-sent'    it's still sitting in the composer. Certain, and safe to retry.
//   'unverified'  the composer cleared but we couldn't find it in the thread. Ambiguous —
//                 never retried automatically, because double-messaging a prospect is worse
//                 than a missed send.
// Empty the composer. LinkedIn autosaves whatever is left in it as a DRAFT on that thread, so
// any path that types and then doesn't send has to clean up — otherwise a dry run (or a bailed
// send) quietly leaves half-finished outreach sitting in real prospects' conversations.
async function clearComposer(box) {
  try {
    await box.click();
    await box.press("ControlOrMeta+a");
    await box.press("Delete");
    return !norm(await box.innerText({ timeout: 1500 }));
  } catch (e) { return false; }
}

// Which of `selectors` is present, by name — used to report what the page actually offered.
async function whichPresent(page, selectors) {
  for (const sel of selectors) {
    try { if (await page.locator(sel).first().count()) return sel; } catch (e) { /* next */ }
  }
  return null;
}

async function confirmSent(page, box, body) {
  const want = norm(body).slice(0, 60);
  if (!want) return "unverified";

  // 1. The composer should have emptied. Our text still there means it never sent.
  try {
    const left = norm(await box.innerText({ timeout: 2000 }));
    if (left && left.includes(want.slice(0, 30))) return "not-sent";
  } catch (e) { /* composer detached after sending — that's the normal case */ }

  // 2. The text should now appear in the thread transcript.
  for (const sel of THREAD_LIST) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.count())) continue;
      if (norm(await el.innerText({ timeout: 2500 })).includes(want)) return "sent";
    } catch (e) { /* try the next */ }
  }
  return "unverified";
}

// Send `item.body` to the person at `item.linkedin_url`.
// Returns { result, error, scrape }.
async function sendOne(page, item, { dryRun = false } = {}) {
  const url = String(item.linkedin_url || "").trim();
  if (!/linkedin\.com\/in\//i.test(url)) {
    return { result: "failed", error: "No LinkedIn profile URL on this queue item.", scrape: null };
  }

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await jitter(1800, 4000); // let the profile settle, and don't hammer

  let halt = await haltReason(page);
  if (halt) return { result: "halted", error: halt, scrape: null };

  // Grab the details while we're here — this is the copy-paste we're replacing.
  const scrape = await scrapeProfile(page).catch(() => null);

  const msgBtn = await firstVisible(page, MESSAGE_BUTTON);
  if (!msgBtn) {
    return { result: "failed", error: "No Message button on this profile (not connected, or messaging is closed).", scrape };
  }
  await msgBtn.click();
  await jitter(1200, 2600);

  const box = await firstVisible(page, COMPOSER_BOX, 9000);
  if (!box) return { result: "failed", error: "The message composer didn't open.", scrape };

  // Start from empty. LinkedIn restores drafts, so a previous crashed or retried attempt can
  // leave the message already sitting there — typing on top of it would send it twice over.
  await clearComposer(box);
  await typeBody(box, item.body);
  await jitter(700, 1800);

  // Re-check right before sending: a challenge can appear while we were typing. The draft is
  // left in place on purpose here — a human is taking over, and the approved message sitting
  // ready in the box is exactly what they need to press Send on.
  halt = await haltReason(page);
  if (halt) return { result: "halted", error: halt, scrape };

  // A dry run stops here, but it still checks everything the real path would depend on AFTER
  // this point — the Send button and the thread transcript confirmSent() reads. Otherwise the
  // confirmation machinery is only ever exercised by a live send to a real prospect.
  if (dryRun) {
    const btn = await whichPresent(page, SEND_BUTTON);
    const thread = await whichPresent(page, THREAD_LIST);
    const cleared = await clearComposer(box);
    const notes = [
      btn ? "Send button ok" : "SEND BUTTON NOT FOUND — a real send would fail here",
      thread ? "thread transcript ok" : "THREAD TRANSCRIPT NOT FOUND — every send would come back 'unverified'",
      cleared ? "composer cleared" : "COMPOSER NOT CLEARED — a draft may be left on this thread",
    ];
    return { result: "failed", error: "Dry run — " + notes.join("; "), scrape };
  }

  const sendBtn = await firstVisible(page, SEND_BUTTON, 6000);
  if (!sendBtn) {
    await clearComposer(box); // don't leave the typed message as a draft
    return { result: "failed", error: "The Send button never became active.", scrape };
  }
  await sendBtn.click();
  await jitter(1500, 3000);

  // If a challenge appeared on send, treat it as halted — we can't be sure it went out, and
  // the safe move is to stop and let a human check the thread.
  halt = await haltReason(page);
  if (halt) return { result: "halted", error: halt, scrape };

  // Never report 'sent' on the strength of a click alone.
  const confirmed = await confirmSent(page, box, item.body);
  if (confirmed === "sent") return { result: "sent", error: null, scrape };
  if (confirmed === "not-sent") {
    await clearComposer(box); // it goes back for a retry, which types it fresh
    return { result: "failed", error: "Send didn't go through — the message was still in the composer afterwards.", scrape };
  }
  return {
    result: "unverified",
    error: "Clicked Send but couldn't confirm the message in the thread. Check LinkedIn before re-sending — it may already have gone out.",
    scrape,
  };
}

module.exports = { sendOne, jitter };
