// The agent's reading side: the LinkedIn inbox (who has replied) and the new-connections list
// (whose invitation was accepted). Nothing here types or clicks Send.
//
// Privacy, by construction: the server hands over a watch list — the people this user messaged
// or invited — and only conversations with THOSE people are opened or reported. Everything else
// in the inbox (friends, recruiters, colleagues) is skipped right here on the machine and never
// reaches Karma Connect. Same for connections: only handles with an invitation pending go back.
//
// LinkedIn's messaging page still uses readable msg-* class names; the selectors below lean on
// those first and on link shapes (/messaging/thread/, /in/) second. If LinkedIn changes them,
// readInbox() finds nothing and says so — it never guesses who said what.
const { haltReason } = require("./session.cjs");
const { jitter } = require("./send.cjs");

const nameKey = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
const handleOf = (url) => {
  const m = String(url || "").match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  if (!m) return "";
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch (e) { return m[1].toLowerCase(); }
};
const threadKeyOf = (url) => (String(url || "").match(/\/messaging\/thread\/([^/?#]+)/i) || [])[1] || "";

// The conversation list, newest first: [{ key, url, name, snippet }].
async function listConversations(page) {
  return page.evaluate(() => {
    const out = [], seen = new Set();
    for (const a of document.querySelectorAll("a[href*='/messaging/thread/']")) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/messaging\/thread\/([^/?#]+)/i);
      if (!m || seen.has(m[1])) continue;
      const card = a.closest("li") || a;
      const nameEl = card.querySelector(".msg-conversation-listitem__participant-names, .msg-conversation-card__participant-names, h3");
      const lines = (card.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
      const name = (nameEl ? nameEl.innerText : lines[0] || "").trim();
      if (!name) continue;
      seen.add(m[1]);
      out.push({ key: m[1], url: "https://www.linkedin.com/messaging/thread/" + m[1] + "/", name, snippet: lines.slice(0, 4).join(" | ").slice(0, 300) });
      if (out.length >= 30) break;
    }
    return out;
  });
}

// The open thread's transcript: [{ from: 'them'|'me', text }], plus their profile link.
// `theirName` decides who is who when LinkedIn doesn't mark the other side's messages.
async function readThread(page, theirName) {
  return page.evaluate((theirName) => {
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
    const them = norm(theirName);
    const marked = !!document.querySelector(".msg-s-event-listitem--other");
    const msgs = [];
    let sender = "";
    for (const ev of document.querySelectorAll(".msg-s-message-list__event")) {
      const n = ev.querySelector(".msg-s-message-group__name, .msg-s-message-group__profile-link");
      if (n && n.innerText.trim()) sender = n.innerText.trim();
      for (const b of ev.querySelectorAll(".msg-s-event-listitem__body")) {
        const text = (b.innerText || "").trim();
        if (!text) continue;
        const other = marked ? !!b.closest(".msg-s-event-listitem--other") : (!!them && norm(sender) === them);
        msgs.push({ from: other ? "them" : "me", text });
      }
    }
    // Their profile: the thread header link, else the link on one of THEIR message groups.
    let profile = "";
    const head = document.querySelector(".msg-thread__link-to-profile, .msg-title-bar a[href*='/in/'], .msg-entity-lockup a[href*='/in/']");
    if (head) profile = head.href;
    if (!profile) {
      for (const a of document.querySelectorAll(".msg-s-message-group__profile-link[href*='/in/'], .msg-s-event-listitem__link[href*='/in/']")) {
        const ev = a.closest(".msg-s-message-list__event");
        if (marked ? ev && ev.querySelector(".msg-s-event-listitem--other") : norm(a.innerText) === them || !a.innerText.trim()) { profile = a.href; break; }
      }
    }
    return { messages: msgs.slice(-30), profile };
  }, theirName);
}

// Read the inbox. `people` is the server's watch list ([{ handle, name }]); `memo` (a Map kept
// for the life of the process) skips threads whose preview hasn't changed since last time.
// Returns { threads, halt, note }.
async function readInbox(page, people, memo, { maxOpen = 8 } = {}) {
  // Full name, and first + last word too: LinkedIn shows "Jane Doe, CR" where we saved "Jane Doe".
  const short = (k) => { const w = k.split(" "); return w.length > 2 ? w[0] + " " + w[w.length - 1] : k; };
  const byName = new Map();
  for (const p of people || []) {
    const k = nameKey(p.name);
    if (!k || k.indexOf(" ") < 0) continue; // a lone first name would match strangers
    if (!byName.has(k)) byName.set(k, p);
  }
  const find = (name) => {
    const k = nameKey(name);
    if (byName.get(k)) return byName.get(k);
    const w = k.split(" ");
    return w.length > 2 ? byName.get(w[0] + " " + w[1]) || byName.get(short(k)) : null;
  };
  if (!byName.size) return { threads: [], halt: "", note: "nobody to watch for yet" };

  await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded" });
  await jitter(2500, 4500);
  let halt = await haltReason(page);
  if (halt) return { threads: [], halt };

  const convs = await listConversations(page).catch(() => []);
  if (!convs.length) return { threads: [], halt: "", note: "CONVERSATION LIST NOT FOUND — LinkedIn's messaging page may have changed" };

  const threads = [];
  let opened = 0;
  for (const c of convs) {
    const who = find(c.name);
    if (!who) continue;                          // not someone we reached out to: never opened
    if (memo.get(c.key) === c.snippet) continue; // unchanged since we last read it
    if (opened >= maxOpen) break;
    opened++;
    await page.goto(c.url, { waitUntil: "domcontentloaded" });
    await jitter(2000, 4000);
    halt = await haltReason(page);
    if (halt) return { threads, halt };
    const t = await readThread(page, c.name).catch(() => null);
    if (!t || !t.messages.length) continue;
    const handle = handleOf(t.profile);
    if (handle && who.handle && handle !== who.handle) { memo.set(c.key, c.snippet); continue; } // same name, someone else
    threads.push({ threadKey: c.key, threadUrl: c.url, name: c.name, profileUrl: t.profile || null, messages: t.messages });
    memo.set(c.key, c.snippet);
  }
  return { threads, halt: "", note: `${convs.length} conversations, ${threads.length} with prospects read` };
}

// Whose invitation was accepted: the newest connections, intersected with `pending` (handles of
// invitations still out). Only that intersection is returned. Returns { accepted, halt }.
async function readAccepted(page, pending) {
  const want = new Set((pending || []).filter(Boolean));
  if (!want.size) return { accepted: [], halt: "" };
  await page.goto("https://www.linkedin.com/mynetwork/invite-connect/connections/", { waitUntil: "domcontentloaded" });
  await jitter(2500, 4500);
  const halt = await haltReason(page);
  if (halt) return { accepted: [], halt };
  try { await page.evaluate(async () => { for (let i = 0; i < 4; i++) { window.scrollBy(0, 900); await new Promise((r) => setTimeout(r, 600)); } }); } catch (e) { /* first screen only */ }
  const hrefs = await page.evaluate(() => [...document.querySelectorAll("main a[href*='/in/']")].map((a) => a.href).slice(0, 200)).catch(() => []);
  const accepted = [...new Set(hrefs.map(handleOf).filter((h) => want.has(h)))];
  return { accepted, halt: "", seen: hrefs.length };
}

module.exports = { readInbox, readAccepted, listConversations, readThread, nameKey, handleOf, threadKeyOf };
