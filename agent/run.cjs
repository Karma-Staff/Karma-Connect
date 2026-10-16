// The agent loop. Leases approved LinkedIn work from Karma Connect — connection requests,
// messages and replies — does it, and reports back. Between sends it reads the inbox for
// replies and the new-connections list for accepted invitations (inbox.cjs).
//
//   npm run agent:login   sign in to LinkedIn by hand, once (saves the session)
//   npm run agent         start the loop
//   npm run agent -- --dry-run    compose everything but never press Send
//
// Run this on the recruiter's own machine, not on Render — it needs the persistent Chrome
// profile, and it should reach LinkedIn from where that person normally works.
//
// It cannot exceed the sending caps: every batch is granted by the server, which counts sends
// in the database. Restarting the worker, or running two of them, does not reset anything.
const { open, isSignedIn, login, PROFILE_DIR } = require("./session.cjs");
const { sendOne, replyOne, jitter } = require("./send.cjs");
const { inviteOne } = require("./invite.cjs");
const { readInbox, readAccepted } = require("./inbox.cjs");
const { captureProfile } = require("./capture.cjs");

// How often to read the inbox and the connections list. Reading is activity too, so it's
// paced like everything else and only happens inside the sending window.
const INBOX_EVERY_MIN = Math.max(5, parseInt(process.env.LI_AGENT_INBOX_MIN || "15", 10));
const ACCEPT_EVERY_MIN = Math.max(15, parseInt(process.env.LI_AGENT_ACCEPT_MIN || "60", 10));

const BASE = (process.env.KC_BASE_URL || "http://localhost:8787").replace(/\/$/, "");
const EMAIL = process.env.KC_EMAIL || "";
const PASSWORD = process.env.KC_PASSWORD || "";
const DRY_RUN = process.argv.includes("--dry-run");

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

// ── Karma Connect API (same signin + Bearer token as the web app) ────
let token = "";
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) throw new Error(data?.error?.message || `${path} failed (${res.status})`);
  return data;
}

async function signIn() {
  if (!EMAIL || !PASSWORD) throw new Error("Set KC_EMAIL and KC_PASSWORD (your Karma Connect login) in the environment.");
  const d = await api("/api/auth/signin", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
  token = d.token || ""; // server responds { token, user }
  if (!token) throw new Error("Signed in but got no access token back.");
  log("Karma Connect: signed in as", EMAIL);
}

// ── The loop ────────────────────────────────────────────────────────
const leaseId = "w-" + Math.random().toString(36).slice(2, 10);

async function tick(page) {
  const now = new Date();
  const batch = await api("/api/outreach/agent/lease", {
    method: "POST",
    body: { leaseId, localHour: now.getHours(), localDay: now.getDay() },
  });

  if (!batch.items || !batch.items.length) {
    log("nothing to do —", batch.reason || "queue empty");
    return Math.max(30, batch.wait || 300);
  }

  const { minGapSec = 45, maxGapSec = 180 } = batch.limits || {};
  log(`leased ${batch.items.length} — today: ${batch.counts?.day ?? "?"}/${batch.limits?.perDay ?? "?"} messages, ${batch.counts?.invDay ?? "?"}/${batch.limits?.invitesPerDay ?? "?"} invitations`);

  for (const item of batch.items) {
    const who = item.lead_label || item.prospect_id;
    const doIt = item.action === "invite" ? inviteOne : item.action === "reply" ? replyOne : sendOne;
    const what = item.action === "invite" ? "invitation" : item.action === "reply" ? "reply" : "message";
    let outcome;
    try {
      outcome = await doIt(page, item, { dryRun: DRY_RUN });
    } catch (e) {
      outcome = { result: "failed", error: String(e.message || e).slice(0, 300), scrape: null };
    }

    try {
      await api("/api/outreach/agent/report/" + encodeURIComponent(item.id), {
        method: "POST",
        body: { result: outcome.result, error: outcome.error, leaseId, scrape: outcome.scrape,
          connected: !!outcome.connected, final: !!outcome.final, profileText: outcome.profileText || undefined },
      });
    } catch (e) { log("could not report", who + ":", e.message); }

    if (outcome.result === "halted") {
      log("HALTED on", who + ":", outcome.error);
      log("The agent has switched itself off. Sort it out on LinkedIn, then turn it back on in the Send Queue.");
      return null; // stop the loop entirely
    }
    log(outcome.result === "sent" ? what + " sent → " + who + (outcome.connected ? " (already connected)" : "")
      : outcome.result + " → " + who + " (" + what + "): " + outcome.error);

    // Pace between sends, even inside a batch.
    if (item !== batch.items[batch.items.length - 1]) await jitter(minGapSec * 1000, maxGapSec * 1000);
  }
  return minGapSec;
}

// ── Reading: replies and accepted invitations ───────────────────────
let lastInbox = 0, lastAccept = 0;
const memo = new Map(); // thread → preview last read, so unchanged threads aren't reopened

async function chores(page) {
  const now = new Date();
  const dueInbox = Date.now() - lastInbox >= INBOX_EVERY_MIN * 60000;
  const dueAccept = Date.now() - lastAccept >= ACCEPT_EVERY_MIN * 60000;
  if (!dueInbox && !dueAccept) return true;
  const w = await api("/api/outreach/agent/watch", { method: "POST", body: { localHour: now.getHours(), localDay: now.getDay() } });
  if (!w.ok) return true; // off or outside the window — try again later, quietly

  const stop = async (reason) => {
    await api("/api/outreach/agent/halt", { method: "POST", body: { reason } }).catch(() => {});
    log("HALTED while reading LinkedIn:", reason);
    log("The agent has switched itself off. Sort it out on LinkedIn, then turn it back on in the Send Queue.");
    return false;
  };

  if (dueAccept) {
    lastAccept = Date.now();
    const a = await readAccepted(page, w.pendingInvites);
    if (a.halt) return stop(a.halt);
    let toCopy = w.needProfile || [];
    if (a.accepted.length) {
      const r = await api("/api/outreach/agent/accepted", { method: "POST", body: { handles: a.accepted } });
      log(`${r.accepted} invitation${r.accepted === 1 ? "" : "s"} accepted`);
      toCopy = r.needProfile || toCopy;
    } else if (w.pendingInvites.length) log(`invitations: none of ${w.pendingInvites.length} pending accepted yet`);
    // Accepted, with no message queued to follow: copy their profile for Karma Connect to
    // analyse and draft a first message from. A few per round — each is a page visit.
    for (const handle of toCopy.slice(0, 5)) {
      const c = await captureProfile(page, handle);
      if (c.halt) return stop(c.halt);
      const r = await api("/api/outreach/agent/profile", { method: "POST", body: { handle, text: c.text } }).catch(() => ({}));
      log(r.stored ? `copied ${handle}'s profile — a first message will be drafted in the Send Queue` : `couldn't copy ${handle}'s profile (will try again)`);
      await jitter(20000, 60000);
    }
  }
  if (dueInbox) {
    lastInbox = Date.now();
    const r = await readInbox(page, w.people, memo);
    if (r.halt) return stop(r.halt);
    if (r.threads.length) {
      const saved = await api("/api/outreach/agent/inbox", { method: "POST", body: { threads: r.threads } });
      log(`inbox: ${saved.stored} conversation${saved.stored === 1 ? "" : "s"} updated, ${saved.needReply} waiting for a reply in Karma Connect`);
    } else log("inbox:", r.note || "nothing new");
  }
  return true;
}

async function main() {
  if (process.argv.includes("--login")) { await login(); return; }

  await signIn();
  const { ctx, page } = await open();
  log("Chrome profile:", PROFILE_DIR);

  if (!(await isSignedIn(page))) {
    log("This profile isn't signed in to LinkedIn. Run:  npm run agent:login");
    await ctx.close();
    process.exit(1);
  }
  log("LinkedIn session is live." + (DRY_RUN ? "  [DRY RUN — nothing will be sent; inbox and connections are still read]" : ""));

  let stop = false;
  const shutdown = async () => { if (stop) return; stop = true; log("stopping…"); await ctx.close().catch(() => {}); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (!stop) {
    let wait;
    try {
      wait = await tick(page);
    } catch (e) {
      log("tick error:", e.message);
      wait = 120;
    }
    if (wait === null) break; // halted
    try {
      if (!(await chores(page))) break; // halted while reading
    } catch (e) { log("inbox/connections check failed:", e.message); }
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  await ctx.close().catch(() => {});
}

main().catch((e) => { console.error("agent:", e.message); process.exit(1); });
