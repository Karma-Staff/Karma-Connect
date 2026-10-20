// Send one approved connection request: open the profile, press Connect, add the approved note,
// press Send — then confirm the profile now shows "Pending".
//
// The note comes verbatim from the Karma Connect queue. This module never writes or edits it;
// a note over LinkedIn's 300 characters fails rather than being cut.
//
// The one mistake this must never make is inviting the WRONG person. A profile page carries
// other people's Connect buttons too ("More profiles for you", "People you may know"), so a
// control is only used when it is plainly this person's: its label names them, its link carries
// their handle, or it sits in the top card at the head of the page. Anything else, no click.
//
// Outcomes, as send.cjs:
//   { result: 'sent' }                    invitation sent (or already pending)
//   { result: 'sent', connected: true }   they're already a connection — nothing to send
//   { result: 'failed', final? }          didn't work; `final` when retrying can't help
//   { result: 'halted' }                  LinkedIn asked for a human — stop everything
//   { result: 'unverified' }              pressed Send, couldn't confirm it
const { haltReason } = require("./session.cjs");
const { scrapeProfile } = require("./scrape.cjs");
const { jitter, firstVisible } = require("./send.cjs");
const { pageText } = require("./capture.cjs");

const NOTE_MAX = 300;
const TOP_CARD_MAX_Y = 650; // px from the top of the page: below this is no longer the top card

// Connect, straight on the profile. Newer pages render it as a link to /preload/custom-invite/.
const CONNECT = [
  "main a[href*='/preload/custom-invite/']",
  "main button[aria-label^='Invite'][aria-label*='connect' i]",
  "main a[aria-label^='Invite'][aria-label*='connect' i]",
  "main button:text-is('Connect')",
  "main button:has(span:text-is('Connect'))",
];
// …or tucked under "More" when the primary button is Follow.
const MORE = [
  "main button[aria-label='More actions']",
  "main button[aria-label*='More actions' i]",
  "main button:text-is('More')",
  "main button:has(span:text-is('More'))",
];
const MENU_CONNECT = [
  "[role='menu'] [aria-label^='Invite'][aria-label*='connect' i]",
  ".artdeco-dropdown__content [aria-label^='Invite'][aria-label*='connect' i]",
  "[role='menu'] a[href*='/preload/custom-invite/']",
  "[role='menuitem']:has-text('Connect')",
  ".artdeco-dropdown__content [role='button']:has-text('Connect')",
];
const PENDING = [
  "main button[aria-label^='Pending' i]",
  "main button:text-is('Pending')",
  "main button:has(span:text-is('Pending'))",
];
const DIALOG = ["div[role='dialog']", ".artdeco-modal", ".send-invite"];
const ADD_NOTE = [
  "[role='dialog'] button[aria-label='Add a note']",
  "[role='dialog'] button:has-text('Add a note')",
];
const NOTE_BOX = [
  "[role='dialog'] textarea[name='message']",
  "#custom-message",
  "[role='dialog'] textarea",
];
const SEND = [
  "[role='dialog'] button[aria-label='Send invitation']",
  "[role='dialog'] button[aria-label='Send now']",
  "[role='dialog'] button[aria-label^='Send' i]:not([disabled])",
  "[role='dialog'] button:has-text('Send'):not([disabled])",
];
const SEND_NO_NOTE = [
  "[role='dialog'] button[aria-label='Send without a note']",
  "[role='dialog'] button:has-text('Send without a note')",
  ...SEND,
];
const DISMISS = [
  "[role='dialog'] button[aria-label='Dismiss']",
  "[role='dialog'] button[aria-label*='close' i]",
];

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
const firstName = (s) => norm(s).split(" ")[0] || "";
const handleOf = (url) => {
  const m = String(url || "").match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  if (!m) return "";
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch (e) { return m[1].toLowerCase(); }
};

// The first control matching `selectors` that is this person's. See the header for why.
async function ownControl(page, selectors, { name, handle }) {
  try { await page.evaluate(() => window.scrollTo(0, 0)); } catch (e) { /* ignore */ }
  const first = firstName(name);
  for (const sel of selectors) {
    let els = [];
    try { els = await page.locator(sel).all(); } catch (e) { continue; }
    for (const el of els.slice(0, 12)) {
      try {
        if (!(await el.isVisible())) continue;
        const label = norm((await el.getAttribute("aria-label")) || "");
        const href = (await el.getAttribute("href")) || "";
        if (href && handle && /custom-invite/i.test(href)) {
          const v = (href.match(/vanityName=([^&]+)/i) || [])[1];
          if (v && decodeURIComponent(v).toLowerCase() === handle) return el;
          if (v) continue; // someone else's invite link
        }
        // "Invite Jane Doe to connect" — a label that names somebody must name THIS person.
        if (/^invite /.test(label)) { if (first && label.includes(first)) return el; continue; }
        // Unlabelled: only if it sits in the top card — near the top, and in the main column
        // rather than the right-hand rail of other people's profiles.
        const box = await el.boundingBox();
        const vw = (page.viewportSize() || { width: 1280 }).width;
        if (box && box.y >= 0 && box.y < TOP_CARD_MAX_Y && box.x < vw * 0.62) return el;
      } catch (e) { /* detached — next */ }
    }
  }
  return null;
}

// The degree badge in the top card ("· 1st"), read as text — LinkedIn's class names are hashed.
async function topDegree(page) {
  try {
    const lines = await page.evaluate(() => {
      const el = document.querySelector("main");
      return el ? (el.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 8) : [];
    });
    for (const l of lines) { const m = l.match(/^[^a-z0-9]*(1st|2nd|3rd\+?)\s*$/i); if (m) return m[1].toLowerCase(); }
  } catch (e) { /* unknown */ }
  return "";
}

async function closeDialog(page) {
  const x = await firstVisible(page, DISMISS, 1500);
  if (x) { await x.click().catch(() => {}); } else { await page.keyboard.press("Escape").catch(() => {}); }
  await jitter(400, 900);
}

async function dialogText(page) {
  for (const sel of DIALOG) {
    try {
      const d = page.locator(sel).first();
      if (await d.isVisible({ timeout: 500 })) return norm(await d.innerText({ timeout: 1500 }));
    } catch (e) { /* next */ }
  }
  return "";
}

// Type the note like a person would, a character at a time.
async function typeNote(el, note) {
  await el.click();
  await el.fill("");
  await jitter(200, 500);
  await el.type(note, { delay: 18 + Math.random() * 40 });
}

async function inviteOne(page, item, { dryRun = false } = {}) {
  const url = String(item.linkedin_url || "").trim();
  if (!/linkedin\.com\/in\//i.test(url)) {
    return { result: "failed", error: "No LinkedIn profile URL on this invitation.", scrape: null, final: true };
  }
  let note = String(item.body || "").trim();
  let noteDropped = false;   // the note couldn't go (free monthly allowance used up) and it went without
  if (note.length > NOTE_MAX) {
    return { result: "failed", error: `The note is ${note.length} characters — LinkedIn allows ${NOTE_MAX}. Shorten it and approve it again.`, scrape: null, final: true };
  }

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await jitter(1800, 4000);

  let halt = await haltReason(page);
  if (halt) return { result: "halted", error: halt, scrape: null };

  const scrape = await scrapeProfile(page, { raw: false }).catch(() => null);
  const who = { name: (scrape && scrape.name) || item.lead_label || "", handle: handleOf(page.url()) || handleOf(url) };

  // Already connected, or already invited: nothing to send, and the row records which. Already
  // connected also means a first message is due — copy the profile now, while we're on it.
  if ((await topDegree(page)) === "1st") {
    return dryRun
      ? { result: "failed", error: "Dry run — already a connection; a real run would mark this accepted.", scrape }
      : { result: "sent", connected: true, error: null, scrape, profileText: await pageText(page) };
  }
  if (await ownControl(page, PENDING, who)) {
    return dryRun
      ? { result: "failed", error: "Dry run — an invitation is already pending.", scrape }
      : { result: "sent", error: null, scrape };
  }

  // Press this person's Connect and wait for the invitation window. null when it opened,
  // otherwise the outcome to return.
  const openInvite = async () => {
    let connect = await ownControl(page, CONNECT, who);
    if (!connect) {
      const more = await ownControl(page, MORE, who);
      if (more) {
        await more.click({ timeout: 10000 }).catch(() => more.click({ force: true }));
        await jitter(700, 1500);
        // The menu's own entry still has to be this person's ("Invite Jane Doe to connect").
        if (await firstVisible(page, MENU_CONNECT, 3000)) connect = await ownControl(page, MENU_CONNECT, who);
        if (!connect) await page.keyboard.press("Escape").catch(() => {});
      }
    }
    if (!connect) return { result: "failed", error: "No Connect option on this profile (they may only allow Follow).", scrape };
    await connect.click({ timeout: 15000 }).catch(() => connect.click({ force: true }));
    await jitter(1200, 2500);
    const h = await haltReason(page);
    if (h) return { result: "halted", error: h, scrape };
    if (!(await firstVisible(page, DIALOG, 8000))) return { result: "failed", error: "The invitation window didn't open.", scrape };
    return null;
  };
  const opened = await openInvite();
  if (opened) return opened;

  let text = await dialogText(page);
  if (/email address/.test(text) || /how do you know/.test(text)) {
    await closeDialog(page);
    return { result: "failed", error: "LinkedIn wants their email address (or how you know them) to connect. Invite them by hand.", scrape, final: true };
  }

  let box = null;
  if (note) {
    box = await firstVisible(page, NOTE_BOX, 1500);
    if (!box) {
      const add = await firstVisible(page, ADD_NOTE, 5000);
      if (add) { await add.click().catch(() => add.click({ force: true })); await jitter(700, 1500); }
      box = await firstVisible(page, NOTE_BOX, 5000);
    }
    if (!box) {
      text = await dialogText(page);
      await closeDialog(page);
      const usedUp = /premium|personali[sz]ed invitation|free plan/.test(text);
      // A note "when possible" (the agent's own finds): the free notes are used up, so it goes
      // without one — the window is opened again and sent plain.
      if (item.note_optional && usedUp) {
        await jitter(800, 1800);
        const again = await openInvite();
        if (again) return again;
        note = ""; noteDropped = true;
      } else if (usedUp) {
        return { result: "failed", error: "LinkedIn's free plan has used up this month's invitations with a note. Send it by hand without one, or wait for next month.", scrape, final: true };
      } else return { result: "failed", error: "Couldn't find the note box in the invitation window.", scrape };
    }
    if (box) {
      await typeNote(box, note);
      await jitter(600, 1500);
    }
  }

  halt = await haltReason(page);
  if (halt) return { result: "halted", error: halt, scrape };

  // A dry run stops here, after checking what the real path relies on next.
  if (dryRun) {
    const btn = await firstVisible(page, note ? SEND : SEND_NO_NOTE, 2000);
    if (box) await box.fill("").catch(() => {});
    await closeDialog(page);
    const notes = [btn ? "Send button ok" : "SEND BUTTON NOT FOUND — a real invitation would fail here", note ? "note typed" : "no note"];
    return { result: "failed", error: "Dry run — Connect ok; " + notes.join("; ") + "; window closed", scrape };
  }

  const send = await firstVisible(page, note ? SEND : SEND_NO_NOTE, 6000);
  if (!send) {
    await closeDialog(page);
    return { result: "failed", error: "The Send button never became active.", scrape };
  }
  await send.click();
  await jitter(1500, 3000);

  // The weekly-limit notice appears exactly here.
  halt = await haltReason(page);
  if (halt) return { result: "halted", error: halt, scrape };

  // Confirm: the window has gone and the top card now says Pending.
  const stillOpen = await firstVisible(page, NOTE_BOX, 800);
  if (stillOpen) {
    await closeDialog(page);
    return { result: "failed", error: "The invitation didn't go — the window was still open afterwards.", scrape };
  }
  if (await ownControl(page, PENDING, who)) return { result: "sent", error: null, scrape, noteDropped };
  try {
    const body = norm(await page.locator("body").innerText({ timeout: 2000 }));
    if (/invitation sent/.test(body)) return { result: "sent", error: null, scrape, noteDropped };
  } catch (e) { /* fall through */ }
  return {
    result: "unverified",
    error: "Pressed Send but couldn't see the invitation pending. Check their profile before sending again.",
    scrape, noteDropped,
  };
}

module.exports = { inviteOne, ownControl, topDegree, NOTE_MAX };
