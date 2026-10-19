// The agent loop. Runs in the background on the PC that holds the LinkedIn session, and does
// what Karma Connect tells it: everything is controlled from the LinkedIn agent page there —
// start/pause, dry run, limits and hours, "check the inbox now", "sign in to LinkedIn".
//
//   npm run agent -- --pair K7Q4-MZ2P   connect this PC (code from LinkedIn agent → Connect a PC),
//                                       start with Windows, and start now in the background
//   npm run agent                       run in this window instead (you see the log)
//   npm run agent:login                 sign in to LinkedIn by hand (also a button in Karma Connect)
//   npm run agent -- --dry-run          force a dry run whatever Karma Connect says
//   npm run agent -- --uninstall-startup   stop it starting with Windows
//
// Between sends it reads the inbox for replies and the new-connections list for accepted
// invitations (inbox.cjs), and copies profiles on request (capture.cjs).
//
// It cannot exceed the sending caps: every batch is granted by the server, which counts sends
// in the database. Restarting the worker, or running two of them, does not reset anything.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { open, isSignedIn, login, whoAmI, PROFILE_DIR } = require("./session.cjs");
const { sendOne, replyOne, jitter } = require("./send.cjs");
const { inviteOne } = require("./invite.cjs");
const { readInbox, readAccepted } = require("./inbox.cjs");
const { captureProfile } = require("./capture.cjs");

const VERSION = "0.4.0";
const ARGS = process.argv.slice(2);
const flag = (f) => ARGS.includes(f);
const argVal = (f) => { const i = ARGS.indexOf(f); return i >= 0 ? ARGS[i + 1] : undefined; };
const DRY_FLAG = flag("--dry-run");
const BACKGROUND = flag("--background");

// Where this PC keeps its connection to Karma Connect. Holds the device token: never share it,
// never commit it (it's gitignored and not in the download zip).
const CONFIG_FILE = path.join(__dirname, ".kc-agent.json");
const LOCK_FILE = path.join(__dirname, ".agent.lock");
const LOG_FILE = path.join(__dirname, "agent.log");
const DEFAULT_BASE = "https://karma-connect-9s2z.onrender.com";

function readConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch (e) { /* not paired yet */ }
  return {
    baseUrl: (process.env.KC_BASE_URL || c.baseUrl || DEFAULT_BASE).replace(/\/$/, ""),
    token: process.env.KC_AGENT_TOKEN || c.token || "",
    email: c.email || "",
  };
}
let cfg = readConfig();

// ── Log: this window (or agent.log in the background) AND Karma Connect's activity log ──
const pending = []; // lines not yet sent to Karma Connect
function writeLocal(line) {
  if (!BACKGROUND) { console.log(line); return; }
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + ".old");
    fs.appendFileSync(LOG_FILE, line + os.EOL);
  } catch (e) { /* nowhere to log */ }
}
// `level`: info | success | warn | error. Pass local:true for lines that stay on this PC.
function log(text, level = "info", { local = false } = {}) {
  writeLocal(new Date().toLocaleTimeString() + "  " + text);
  if (!local) { pending.push({ at: new Date().toISOString(), level, text: String(text).slice(0, 400) }); if (pending.length > 100) pending.shift(); }
}

// ── Karma Connect API (device token from pairing) ───────────────────
async function api(p, { method = "GET", body, auth = true } = {}) {
  const res = await fetch(cfg.baseUrl + p, {
    method,
    headers: { "Content-Type": "application/json", ...(auth && cfg.token ? { Authorization: "Bearer " + cfg.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `${p} failed (${res.status})`);
    err.status = res.status;
    err.unpaired = !!data?.error?.unpaired || res.status === 401;
    throw err;
  }
  return data;
}

// ── One-time setup: pair, start with Windows ────────────────────────
const STARTUP_DIR = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const STARTUP_FILE = path.join(STARTUP_DIR, "Karma Connect LinkedIn agent.vbs");
const vbsQuote = (s) => '""' + s + '""';

function installStartup() {
  if (process.platform !== "win32") return false;
  // A .vbs runs the agent with no console window. Absolute paths: node may be a portable copy
  // that isn't on PATH when Windows starts.
  const cmd = vbsQuote(process.execPath) + " " + vbsQuote(path.join(__dirname, "run.cjs")) + " --background";
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    'sh.CurrentDirectory = "' + path.join(__dirname, "..") + '"',
    'sh.Run "' + cmd + '", 0, False',
    "",
  ].join("\r\n");
  fs.mkdirSync(STARTUP_DIR, { recursive: true });
  fs.writeFileSync(STARTUP_FILE, vbs);
  return true;
}
function startInBackground() {
  if (process.platform !== "win32" || !fs.existsSync(STARTUP_FILE)) return false;
  spawn("wscript.exe", [STARTUP_FILE], { detached: true, stdio: "ignore" }).unref();
  return true;
}

async function pair(code) {
  const url = argVal("--url");
  if (url) cfg.baseUrl = url.replace(/\/$/, "");
  const r = await api("/api/outreach/agent/pair/claim", { method: "POST", auth: false, body: { code, name: os.hostname() } });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ baseUrl: cfg.baseUrl, token: r.token, email: r.email, pairedAt: new Date().toISOString() }, null, 2));
  console.log(`\nConnected this PC (${r.name}) to Karma Connect as ${r.email}.`);
  if (flag("--no-startup") || !installStartup()) {
    console.log("Start it with:  npm run agent");
    return;
  }
  console.log("It now starts by itself when Windows starts.");
  if (startInBackground()) console.log("It's running in the background now — control it from Karma Connect → LinkedIn agent.");
  console.log("Log file: " + LOG_FILE + "\n");
}

// ── One copy at a time ──────────────────────────────────────────────
// The LinkedIn profile can only be open in one browser, and two workers would double the reads.
function takeLock() {
  try {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf8"), 10);
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); return false; } catch (e) { /* stale lock: that process is gone */ }
    }
  } catch (e) { /* no lock */ }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  return true;
}
function dropLock() {
  try { if (parseInt(fs.readFileSync(LOCK_FILE, "utf8"), 10) === process.pid) fs.unlinkSync(LOCK_FILE); } catch (e) { /* gone */ }
}

// ── What this worker tells Karma Connect about itself ───────────────
const me = {
  version: VERSION, host: os.hostname(), browser: null, state: "starting", activity: "Starting up",
  linkedin: null, lastInboxAt: null, lastAcceptAt: null, startedAt: new Date().toISOString(),
};
const doing = (state, activity) => { me.state = state; me.activity = activity; };

let control = { enabled: false, dryRun: false, limits: {}, command: null };
async function checkIn() {
  const events = pending.splice(0, pending.length);
  try {
    control = await api("/api/outreach/agent/heartbeat", { method: "POST", body: { worker: me, events } });
    return control;
  } catch (e) {
    pending.unshift(...events.slice(-50)); // try those again next time
    throw e;
  }
}

// ── Sending ─────────────────────────────────────────────────────────
const leaseId = "w-" + Math.random().toString(36).slice(2, 10);
const dryRun = () => DRY_FLAG || !!control.dryRun;

async function tick(page) {
  const now = new Date();
  const batch = await api("/api/outreach/agent/lease", {
    method: "POST",
    body: { leaseId, localHour: now.getHours(), localDay: now.getDay() },
  });

  if (!batch.items || !batch.items.length) {
    log("nothing to send — " + (batch.reason || "queue empty"), "info", { local: true });
    return Math.max(30, batch.wait || 300);
  }

  const { minGapSec = 45, maxGapSec = 180 } = batch.limits || {};
  log(`picked up ${batch.items.length} — today: ${batch.counts?.day ?? "?"}/${batch.limits?.perDay ?? "?"} messages, ${batch.counts?.invDay ?? "?"}/${batch.limits?.invitesPerDay ?? "?"} invitations${dryRun() ? " [dry run]" : ""}`);

  for (const item of batch.items) {
    const who = item.lead_label || item.prospect_id;
    const doIt = item.action === "invite" ? inviteOne : item.action === "reply" ? replyOne : sendOne;
    const what = item.action === "invite" ? "invitation" : item.action === "reply" ? "reply" : "message";
    doing("working", (dryRun() ? "Dry run: " : "Sending ") + what + " → " + who);
    let outcome;
    try {
      outcome = await doIt(page, item, { dryRun: dryRun() });
    } catch (e) {
      outcome = { result: "failed", error: String(e.message || e).slice(0, 300), scrape: null };
    }

    try {
      await api("/api/outreach/agent/report/" + encodeURIComponent(item.id), {
        method: "POST",
        body: { result: outcome.result, error: outcome.error, leaseId, scrape: outcome.scrape,
          connected: !!outcome.connected, final: !!outcome.final, profileText: outcome.profileText || undefined },
      });
    } catch (e) { log("could not report " + who + ": " + e.message, "warn"); }

    if (outcome.result === "halted") {
      log("Stopped on " + who + ": " + outcome.error + " — sort it out on LinkedIn, then press Start in Karma Connect.", "error");
      return null;
    }
    if (outcome.result === "sent") log(what + " sent → " + who + (outcome.connected ? " (already connected)" : ""), "success");
    else log(outcome.result + " → " + who + " (" + what + "): " + outcome.error, outcome.result === "failed" && dryRun() ? "info" : "warn");

    // Pace between sends, even inside a batch.
    if (item !== batch.items[batch.items.length - 1]) {
      doing("working", "Waiting between actions");
      await jitter(minGapSec * 1000, maxGapSec * 1000);
    }
  }
  return minGapSec;
}

// ── Reading: replies and accepted invitations ───────────────────────
let lastInbox = 0, lastAccept = 0;
const memo = new Map(); // thread → preview last read, so unchanged threads aren't reopened
const everyMin = (envKey, fromServer, floor, dflt) =>
  Math.max(floor, parseInt(process.env[envKey] || "", 10) || fromServer || dflt);

async function chores(page) {
  const now = new Date();
  const L = control.limits || {};
  const dueInbox = Date.now() - lastInbox >= everyMin("LI_AGENT_INBOX_MIN", L.inboxEveryMin, 5, 15) * 60000;
  const dueAccept = Date.now() - lastAccept >= everyMin("LI_AGENT_ACCEPT_MIN", L.acceptEveryMin, 15, 60) * 60000;
  if (!dueInbox && !dueAccept) return true;
  const w = await api("/api/outreach/agent/watch", { method: "POST", body: { localHour: now.getHours(), localDay: now.getDay() } });
  if (!w.ok) return true; // off or outside the window — try again later, quietly

  const stop = async (reason) => {
    await api("/api/outreach/agent/halt", { method: "POST", body: { reason } }).catch(() => {});
    log("Stopped while reading LinkedIn: " + reason, "error");
    return false;
  };

  if (dueAccept) {
    lastAccept = Date.now();
    me.lastAcceptAt = new Date().toISOString();
    doing("working", "Checking for accepted invitations");
    const a = await readAccepted(page, w.pendingInvites);
    if (a.halt) return stop(a.halt);
    let toCopy = w.needProfile || [];
    if (a.accepted.length) {
      const r = await api("/api/outreach/agent/accepted", { method: "POST", body: { handles: a.accepted } });
      log(`${r.accepted} invitation${r.accepted === 1 ? "" : "s"} accepted`, "success");
      toCopy = r.needProfile || toCopy;
    } else log(w.pendingInvites.length ? `invitations: none of ${w.pendingInvites.length} pending accepted yet` : "invitations: none pending");
    // Accepted, with no message queued to follow: copy their profile for Karma Connect to
    // analyse and draft a first message from. A few per round — each is a page visit.
    for (const handle of toCopy.slice(0, 5)) {
      doing("working", "Copying " + handle + "'s profile");
      const c = await captureProfile(page, handle);
      if (c.halt) return stop(c.halt);
      const r = await api("/api/outreach/agent/profile", { method: "POST", body: { handle, text: c.text } }).catch(() => ({}));
      log(r.stored ? `copied ${handle}'s profile — a first message will be drafted in the Send Queue` : `couldn't copy ${handle}'s profile (will try again)`, r.stored ? "success" : "warn");
      await jitter(20000, 60000);
    }
  }
  if (dueInbox) {
    lastInbox = Date.now();
    me.lastInboxAt = new Date().toISOString();
    doing("working", "Reading the LinkedIn inbox");
    const r = await readInbox(page, w.people, memo);
    if (r.halt) return stop(r.halt);
    if (r.threads.length) {
      const saved = await api("/api/outreach/agent/inbox", { method: "POST", body: { threads: r.threads } });
      log(`inbox: ${saved.stored} conversation${saved.stored === 1 ? "" : "s"} updated, ${saved.needReply} waiting for a reply in Karma Connect`, saved.needReply ? "success" : "info");
    } else log("inbox: " + (r.note || "nothing new"));
  }
  return true;
}

// ── Copy on request ─────────────────────────────────────────────────
// Someone pressed "Copy it with the agent" in Karma Connect: open the profile, copy the page,
// send it back. Checked on every check-in, so the page fills in quickly.
async function copies(page) {
  const r = await api("/api/outreach/agent/copies", { method: "POST" }).catch(() => ({ items: [] }));
  for (const it of r.items || []) {
    doing("working", "Copying " + it.handle + "'s profile (asked in Karma Connect)");
    const c = await captureProfile(page, it.handle).catch((e) => ({ text: "", halt: "", error: e.message }));
    await api("/api/outreach/agent/copies/" + encodeURIComponent(it.id), { method: "POST", body: { text: c.text, halt: c.halt || undefined, error: c.error } }).catch(() => {});
    if (c.halt) { log("Stopped while copying a profile: " + c.halt, "error"); return false; }
    log(c.text ? `copied ${it.handle}'s profile into Karma Connect` : `couldn't copy ${it.handle}'s profile`, c.text ? "success" : "warn");
    await jitter(4000, 9000);
  }
  return true;
}

// ── The browser: open while the agent is on, closed while it's paused ──
let session = null; // { ctx, page }
async function closeBrowser() {
  if (!session) return;
  const s = session; session = null;
  await s.ctx.close().catch(() => {});
}
async function openBrowser() {
  if (session) return session;
  doing("starting", "Opening the browser");
  const { ctx, page, browser } = await open();
  me.browser = browser;
  session = { ctx, page };
  ctx.on("close", () => { if (session && session.ctx === ctx) session = null; }); // someone closed the window
  if (!(await isSignedIn(page))) {
    await closeBrowser();
    me.linkedin = null;
    doing("signed_out", "LinkedIn is signed out on this PC");
    await api("/api/outreach/agent/halt", { method: "POST", body: { reason: `LinkedIn is signed out on ${me.host}. Press "Sign in to LinkedIn", sign in on that PC, then press Start.` } }).catch(() => {});
    return null;
  }
  const who = await whoAmI(page).catch(() => null);
  if (who && (who.name || who.handle)) {
    const changed = !me.linkedin || me.linkedin.handle !== who.handle;
    me.linkedin = who;
    if (changed) log(`LinkedIn: signed in as ${who.name || who.handle}${who.handle ? " (linkedin.com/in/" + who.handle + ")" : ""}`);
  }
  return session;
}

async function signInToLinkedIn() {
  await closeBrowser();
  doing("signing_in", `Waiting for someone to sign in to LinkedIn on ${me.host}`);
  await checkIn().catch(() => {});
  log(`Opened LinkedIn on ${me.host} — sign in there with email and password (not "Continue with Google").`, "warn");
  const ok = await login({ waitMinutes: 10 }).catch(() => false);
  me.linkedin = null;
  log(ok ? "LinkedIn sign-in saved on this PC." : "Nobody signed in within 10 minutes.", ok ? "success" : "warn");
}

// ── Main loop ───────────────────────────────────────────────────────
const CHECK_IN_SEC = 15;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (flag("--login")) { await login(); return; }
  if (flag("--pair")) {
    const code = argVal("--pair");
    if (!code) throw new Error("Put the code after --pair, e.g.  npm run agent -- --pair K7Q4-MZ2P");
    await pair(code);
    return;
  }
  if (flag("--install-startup")) { console.log(installStartup() ? "It will start with Windows. (" + STARTUP_FILE + ")" : "Only on Windows."); return; }
  if (flag("--uninstall-startup")) { try { fs.unlinkSync(STARTUP_FILE); console.log("It won't start with Windows any more."); } catch (e) { console.log("It wasn't set to start with Windows."); } return; }

  if (!cfg.token) {
    console.log("This PC isn't connected to Karma Connect yet.");
    console.log("In Karma Connect open LinkedIn agent → Connect a PC, then run the command it shows:");
    console.log("  npm run agent -- --pair <code>");
    process.exit(1);
  }
  if (!takeLock()) { console.log("The agent is already running on this PC (see agent.log). Control it from Karma Connect → LinkedIn agent."); return; }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    log("Agent closed on " + me.host + ".", "warn");
    doing("paused", "Closed on the PC");
    await checkIn().catch(() => {});
    await closeBrowser();
    dropLock();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", dropLock);

  log(`Agent ${VERSION} started on ${me.host}${DRY_FLAG ? " (dry run forced on this PC)" : ""}. Profile: ${PROFILE_DIR}`, "info");
  let nextTick = 0;
  let offlineSince = 0;

  while (!stopping) {
    // 1. Check in: what does Karma Connect want?
    try {
      await checkIn();
      if (offlineSince) { log("Back in touch with Karma Connect.", "info"); offlineSince = 0; }
    } catch (e) {
      if (e.unpaired) {
        writeLocal("Karma Connect doesn't recognise this PC any more (" + e.message + "). Pair it again: npm run agent -- --pair <code>");
        await closeBrowser();
        await sleep(300000);
        cfg = readConfig(); // it may have been re-paired meanwhile
      } else {
        if (!offlineSince) { offlineSince = Date.now(); writeLocal("Can't reach Karma Connect: " + e.message + " — retrying."); }
        await sleep(30000);
      }
      continue;
    }

    try {
      // 2. A command from Karma Connect comes first — it works even while the agent is paused.
      const cmd = control.command;
      if (cmd === "linkedin_login") { await signInToLinkedIn(); continue; }
      if (cmd === "check_inbox") { lastInbox = 0; log("Checking the inbox now (asked in Karma Connect)."); }
      if (cmd === "check_accepts") { lastAccept = 0; log("Checking for accepted invitations now (asked in Karma Connect)."); }

      // 3. Paused or stopped: close the browser and wait.
      if (!control.enabled) {
        if (session) { await closeBrowser(); log(control.haltReason ? "Browser closed — the agent is stopped." : "Paused. Browser closed."); }
        if (me.state !== "signed_out") doing("paused", control.haltReason ? "Stopped: " + control.haltReason : "Paused in Karma Connect");
        await sleep(CHECK_IN_SEC * 1000);
        continue;
      }

      // 4. On: make sure the browser is open and signed in.
      const s = await openBrowser();
      if (!s) { await sleep(CHECK_IN_SEC * 1000); continue; }

      // 5. Send what's due, then read the inbox / new connections when they're due.
      if (Date.now() >= nextTick || cmd) {
        const wait = await tick(s.page);
        if (wait === null) { nextTick = 0; continue; } // halted — the next check-in sees it's off
        nextTick = Date.now() + wait * 1000;
        if (!(await chores(s.page))) continue;
      }
      // 6. Copy requests between rounds.
      if (!(await copies(s.page))) continue;
      doing("idle", dryRun() ? "Dry run: waiting for work" : "Waiting for work");
    } catch (e) {
      log("Something went wrong: " + (e.message || e), "warn");
      if (/Target .*closed|browser has been closed|Browser closed/i.test(String(e.message))) await closeBrowser();
    }
    await sleep(CHECK_IN_SEC * 1000);
  }
}

main().catch((e) => { writeLocal("agent: " + e.message); console.error("agent:", e.message); dropLock(); process.exit(1); });
