// The agent loop. Runs in the background on the PC that holds the LinkedIn sessions, and does
// what Karma Connect tells it: everything is controlled from the LinkedIn agent page there —
// adding LinkedIn accounts (up to four), start/pause, dry run, limits and hours, "check the
// inbox now", "sign in to LinkedIn".
//
//   npm run agent -- --pair K7Q4-MZ2P   connect this PC (code from LinkedIn agent → Connect a PC),
//                                       start with Windows, and start now in the background
//   npm run agent                       run in this window instead (you see the log)
//   npm run agent:login [-- 2]          sign in to LinkedIn by hand for account 1 (or 2, 3, 4)
//                                       (also a button on each account in Karma Connect)
//   npm run agent -- --dry-run          force a dry run whatever Karma Connect says
//   npm run agent -- --uninstall-startup   stop it starting with Windows
//
// One process per PC. Each LinkedIn account runs side by side in its own browser profile
// (agent/.profile for the first, agent/.profile-<id> for the others) with its own loop; one
// check-in every 3 seconds carries all of them. Between sends each reads its inbox for replies
// and its new-connections list for accepted invitations (inbox.cjs), and copies profiles on
// request (capture.cjs).
//
// It cannot exceed the sending caps: every batch is granted by the server, which counts sends
// per account in the database. Restarting the worker, or running two of them, resets nothing.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { open, isSignedIn, login, whoAmI, PROFILE_DIR } = require("./session.cjs");
const { sendOne, replyOne } = require("./send.cjs");
const { inviteOne } = require("./invite.cjs");
const { readInbox, readAccepted } = require("./inbox.cjs");
const { captureProfile } = require("./capture.cjs");

const VERSION = "0.5.0";
const ARGS = process.argv.slice(2);
const flag = (f) => ARGS.includes(f);
const argVal = (f) => { const i = ARGS.indexOf(f); return i >= 0 ? ARGS[i + 1] : undefined; };
const DRY_FLAG = flag("--dry-run");
const BACKGROUND = flag("--background");

// Where this PC keeps its connection to Karma Connect, and which browser profile belongs to which
// LinkedIn account. Holds the device token: never share it, never commit it (it's gitignored and
// not in the download zip).
const CONFIG_FILE = path.join(__dirname, ".kc-agent.json");
const LOCK_FILE = path.join(__dirname, ".agent.lock");
const LOG_FILE = path.join(__dirname, "agent.log");
const DEFAULT_BASE = "https://karma-connect-9s2z.onrender.com";

function readConfigFile() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch (e) { return {}; } // not paired yet
}
function readConfig() {
  const c = readConfigFile();
  return {
    baseUrl: (process.env.KC_BASE_URL || c.baseUrl || DEFAULT_BASE).replace(/\/$/, ""),
    token: process.env.KC_AGENT_TOKEN || c.token || "",
    email: c.email || "",
  };
}
let cfg = readConfig();
function saveConfig(patch) {
  const c = { ...readConfigFile(), ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
}

// ── Browser profile per account ─────────────────────────────────────
// { accountId: { dir, slot, label } }. The first account this PC runs gets agent/.profile, so a
// sign-in from before accounts existed carries on; every other one gets its own folder.
function profiles() { return readConfigFile().profiles || {}; }
function profileFor(acct) {
  const map = profiles();
  let p = map[acct.id];
  if (!p) {
    const legacyTaken = Object.values(map).some((x) => x.dir === ".profile");
    p = { dir: legacyTaken ? ".profile-" + String(acct.id).slice(0, 8) : ".profile" };
  }
  if (p.slot !== acct.slot || p.label !== acct.label || !map[acct.id]) {
    saveConfig({ profiles: { ...map, [acct.id]: { ...p, slot: acct.slot, label: acct.label } } });
  }
  return path.join(__dirname, p.dir);
}
// An account taken off the agent in Karma Connect: delete its saved LinkedIn sign-in.
function forgetProfile(id) {
  const map = profiles();
  const p = map[id];
  if (!p) return false;
  const dir = path.join(__dirname, p.dir);
  if (path.dirname(dir) === __dirname && /^\.profile(-[0-9a-f]{8})?$/.test(p.dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* in use — next time */ return false; }
  }
  delete map[id];
  saveConfig({ profiles: map });
  return true;
}

// ── Log: this window (or agent.log in the background) AND Karma Connect's activity log ──
const pending = []; // lines not yet sent to Karma Connect
function writeLocal(line) {
  if (!BACKGROUND) { console.log(line); return; }
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + ".old");
    fs.appendFileSync(LOG_FILE, line + os.EOL);
  } catch (e) { /* nowhere to log */ }
}
// `level`: info | success | warn | error. `account` puts the line on that account's log in
// Karma Connect; local:true keeps it on this PC.
function log(text, level = "info", { local = false, account = null } = {}) {
  writeLocal(new Date().toLocaleTimeString() + "  " + (account ? "[" + account.label + "] " : "") + text);
  if (!local) {
    pending.push({ at: new Date().toISOString(), level, text: String(text).slice(0, 400), accountId: account ? account.id : undefined });
    if (pending.length > 200) pending.shift();
    soon(); // so Karma Connect shows it in a moment, not at the next regular check-in
  }
}
// Check in early: a log line or a new state should reach Karma Connect right away.
let kickMain = null;
let soonTimer = null;
function soon() {
  if (soonTimer) return;
  soonTimer = setTimeout(() => { soonTimer = null; if (kickMain) kickMain(); }, 400);
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
    err.removed = !!data?.error?.removed;
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
  saveConfig({ baseUrl: cfg.baseUrl, token: r.token, email: r.email, pairedAt: new Date().toISOString() });
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
// A browser profile can only be open in one browser, and two workers would double the reads.
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

// The PC checks in this often; an account acts on what it hears straight away (wake()).
const CHECK_IN_SEC = 3;
const IDLE_SEC = 15; // an account with nothing to do looks again after this, unless woken
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const everyMin = (envKey, fromServer, floor, dflt) =>
  Math.max(floor, parseInt(process.env[envKey] || "", 10) || fromServer || dflt);

// What this PC tells Karma Connect about itself.
const pc = { version: VERSION, host: os.hostname(), browser: null, startedAt: new Date().toISOString() };

// ── One LinkedIn account ────────────────────────────────────────────
// Its own browser, its own loop, its own pacing. `control` is what Karma Connect last said about
// it (refreshed by every check-in, even while this loop is busy), so Pause takes effect between
// two sends rather than at the end of a batch.
class Account {
  constructor(c) {
    this.id = c.id;
    this.slot = c.slot;
    this.label = c.label;
    this.control = c;
    this.command = null;
    this.gone = false;
    this.session = null; // { ctx, page }
    this.dir = profileFor(c);
    this.leaseId = "w-" + Math.random().toString(36).slice(2, 10);
    this.memo = new Map(); // thread → preview last read, so unchanged threads aren't reopened
    this.lastInbox = 0;
    this.lastAccept = 0;
    this.nextTick = 0;
    this.me = { state: "starting", activity: "Starting up", linkedin: null, lastInboxAt: null, lastAcceptAt: null };
    this.signingIn = false;
    this.wakeUp = null;
  }
  // Wait, but stop waiting the moment Karma Connect says something new (a command, Start, Pause).
  nap(ms) {
    return new Promise((r) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); r(); }
      this.wakeUp = done;
    }).finally(() => { this.wakeUp = null; });
  }
  wake() { if (this.wakeUp) this.wakeUp(); }
  // A random pause between actions that Pause in Karma Connect cuts short.
  gap(min, max) { return this.nap(min + Math.random() * Math.max(0, max - min)); }
  update(c) {
    const changed = c.enabled !== this.control.enabled || c.dryRun !== this.control.dryRun;
    this.control = c;
    // A second "Sign in" while the sign-in window is already open would only open another one later.
    if (c.command && !(c.command === "linkedin_login" && this.signingIn)) { this.command = c.command; this.wake(); }
    else if (changed) this.wake();
    if (c.label !== this.label || c.slot !== this.slot) { this.label = c.label; this.slot = c.slot; profileFor(c); }
  }
  report() { return { id: this.id, ...this.me }; }
  doing(state, activity) {
    const changed = this.me.state !== state;
    this.me.state = state; this.me.activity = activity;
    if (changed) soon();
  }
  log(text, level = "info", opts = {}) { log(text, level, { ...opts, account: this }); }
  dryRun() { return DRY_FLAG || !!this.control.dryRun; }
  // Every worker call names the account it acts for.
  call(p, opts = {}) {
    const method = opts.method || "GET";
    if (method === "GET") return api(p + (p.includes("?") ? "&" : "?") + "accountId=" + encodeURIComponent(this.id || ""), opts);
    return api(p, { ...opts, body: { ...(opts.body || {}), accountId: this.id || undefined } });
  }
  async stopHere(reason) {
    await this.call("/api/outreach/agent/halt", { method: "POST", body: { reason } }).catch(() => {});
  }

  // ── The browser: open while the account is on, closed while it's paused ──
  async closeBrowser() {
    if (!this.session) return;
    const s = this.session; this.session = null;
    await s.ctx.close().catch(() => {});
  }
  async openBrowser() {
    if (this.session) return this.session;
    this.doing("starting", "Opening the browser");
    const { ctx, page, browser } = await open(this.dir);
    pc.browser = browser;
    this.session = { ctx, page };
    ctx.on("close", () => { if (this.session && this.session.ctx === ctx) this.session = null; }); // someone closed the window
    if (!(await isSignedIn(page))) {
      await this.closeBrowser();
      this.me.linkedin = null;
      this.doing("signed_out", "LinkedIn is signed out for this account");
      await this.stopHere(`LinkedIn is signed out for "${this.label}" on ${pc.host}. Press "Sign in to LinkedIn", sign in on that PC, then press Start.`);
      return null;
    }
    const who = await whoAmI(page).catch(() => null);
    if (who && (who.name || who.handle)) {
      const changed = !this.me.linkedin || this.me.linkedin.handle !== who.handle;
      this.me.linkedin = who;
      if (changed) this.log(`LinkedIn: signed in as ${who.name || who.handle}${who.handle ? " (linkedin.com/in/" + who.handle + ")" : ""}`);
    }
    return this.session;
  }

  async signInToLinkedIn() {
    await this.closeBrowser();
    this.doing("signing_in", `Waiting for someone to sign in to LinkedIn on ${pc.host}`);
    this.log(`Opened LinkedIn on ${pc.host} — sign in there with email and password (not "Continue with Google").`, "warn");
    this.signingIn = true;
    const ok = await login({ waitMinutes: 10, dir: this.dir }).catch(() => false);
    this.signingIn = false;
    this.me.linkedin = null;
    this.log(ok ? "LinkedIn sign-in saved on this PC." : "Nobody signed in within 10 minutes.", ok ? "success" : "warn");
    this.doing("paused", ok ? "Signed in" : "Not signed in");
  }

  // ── Sending ───────────────────────────────────────────────────────
  async tick(page) {
    const now = new Date();
    const batch = await this.call("/api/outreach/agent/lease", {
      method: "POST",
      body: { leaseId: this.leaseId, localHour: now.getHours(), localDay: now.getDay() },
    });

    if (!batch.items || !batch.items.length) {
      this.log("nothing to send — " + (batch.reason || "queue empty"), "info", { local: true });
      return Math.max(30, batch.wait || 300);
    }

    const { minGapSec = 45, maxGapSec = 180 } = batch.limits || {};
    this.log(`picked up ${batch.items.length} — today: ${batch.counts?.day ?? "?"}/${batch.limits?.perDay ?? "?"} messages, ${batch.counts?.invDay ?? "?"}/${batch.limits?.invitesPerDay ?? "?"} invitations${this.dryRun() ? " [dry run]" : ""}`);

    for (let i = 0; i < batch.items.length; i++) {
      const item = batch.items[i];
      const who = item.lead_label || item.prospect_id;
      // Paused in Karma Connect mid-batch: hand the rest back (the lease expires) and stop here.
      if (!this.control.enabled || this.gone) { this.log("Paused mid-batch; the rest go back to the queue.", "info", { local: true }); return null; }
      const doIt = item.action === "invite" ? inviteOne : item.action === "reply" ? replyOne : sendOne;
      const what = item.action === "invite" ? "invitation" : item.action === "reply" ? "reply" : "message";
      this.doing("working", (this.dryRun() ? "Dry run: " : "Sending ") + what + " → " + who);
      let outcome;
      try {
        outcome = await doIt(page, item, { dryRun: this.dryRun() });
      } catch (e) {
        outcome = { result: "failed", error: String(e.message || e).slice(0, 300), scrape: null };
      }

      try {
        await this.call("/api/outreach/agent/report/" + encodeURIComponent(item.id), {
          method: "POST",
          body: { result: outcome.result, error: outcome.error, leaseId: this.leaseId, scrape: outcome.scrape,
            connected: !!outcome.connected, final: !!outcome.final, profileText: outcome.profileText || undefined },
        });
      } catch (e) { this.log("could not report " + who + ": " + e.message, "warn"); }

      if (outcome.result === "halted") {
        this.log("Stopped on " + who + ": " + outcome.error + " — sort it out on LinkedIn, then press Start in Karma Connect.", "error");
        return null;
      }
      if (outcome.result === "sent") this.log(what + " sent → " + who + (outcome.connected ? " (already connected)" : ""), "success");
      else this.log(outcome.result + " → " + who + " (" + what + "): " + outcome.error, outcome.result === "failed" && this.dryRun() ? "info" : "warn");

      // Pace between sends, even inside a batch.
      if (i < batch.items.length - 1) {
        this.doing("working", "Waiting between actions");
        await this.gap(minGapSec * 1000, maxGapSec * 1000);
      }
    }
    return minGapSec;
  }

  // ── Reading: replies and accepted invitations ─────────────────────
  async chores(page) {
    const now = new Date();
    const L = this.control.limits || {};
    const dueInbox = Date.now() - this.lastInbox >= everyMin("LI_AGENT_INBOX_MIN", L.inboxEveryMin, 5, 15) * 60000;
    const dueAccept = Date.now() - this.lastAccept >= everyMin("LI_AGENT_ACCEPT_MIN", L.acceptEveryMin, 15, 60) * 60000;
    if (!dueInbox && !dueAccept) return true;
    const w = await this.call("/api/outreach/agent/watch", { method: "POST", body: { localHour: now.getHours(), localDay: now.getDay() } });
    if (!w.ok) return true; // off or outside the window — try again later, quietly

    const stop = async (reason) => {
      await this.stopHere(reason);
      this.log("Stopped while reading LinkedIn: " + reason, "error");
      return false;
    };

    if (dueAccept) {
      this.lastAccept = Date.now();
      this.me.lastAcceptAt = new Date().toISOString();
      this.doing("working", "Checking for accepted invitations");
      const a = await readAccepted(page, w.pendingInvites);
      if (a.halt) return stop(a.halt);
      let toCopy = w.needProfile || [];
      if (a.accepted.length) {
        const r = await this.call("/api/outreach/agent/accepted", { method: "POST", body: { handles: a.accepted } });
        this.log(`${r.accepted} invitation${r.accepted === 1 ? "" : "s"} accepted`, "success");
        toCopy = r.needProfile || toCopy;
      } else this.log(w.pendingInvites.length ? `invitations: none of ${w.pendingInvites.length} pending accepted yet` : "invitations: none pending");
      // Accepted, with no message queued to follow: copy their profile for Karma Connect to
      // analyse and draft a first message from. A few per round — each is a page visit.
      for (const handle of toCopy.slice(0, 5)) {
        this.doing("working", "Copying " + handle + "'s profile");
        const c = await captureProfile(page, handle);
        if (c.halt) return stop(c.halt);
        const r = await this.call("/api/outreach/agent/profile", { method: "POST", body: { handle, text: c.text } }).catch(() => ({}));
        this.log(r.stored ? `copied ${handle}'s profile — a first message will be drafted in the Send Queue` : `couldn't copy ${handle}'s profile (will try again)`, r.stored ? "success" : "warn");
        await this.gap(20000, 60000);
      }
    }
    if (dueInbox) {
      this.lastInbox = Date.now();
      this.me.lastInboxAt = new Date().toISOString();
      this.doing("working", "Reading the LinkedIn inbox");
      const r = await readInbox(page, w.people, this.memo);
      if (r.halt) return stop(r.halt);
      if (r.threads.length) {
        const saved = await this.call("/api/outreach/agent/inbox", { method: "POST", body: { threads: r.threads } });
        this.log(`inbox: ${saved.stored} conversation${saved.stored === 1 ? "" : "s"} updated, ${saved.needReply} waiting for a reply in Karma Connect`, saved.needReply ? "success" : "info");
      } else this.log("inbox: " + (r.note || "nothing new"));
    }
    return true;
  }

  // ── Copy on request ───────────────────────────────────────────────
  // Someone pressed "Copy it with the agent" in Karma Connect: whichever running account asks
  // first opens the profile, copies the page, and sends it back.
  async copies(page) {
    const r = await this.call("/api/outreach/agent/copies", { method: "POST" }).catch(() => ({ items: [] }));
    for (const it of r.items || []) {
      this.doing("working", "Copying " + it.handle + "'s profile (asked in Karma Connect)");
      const c = await captureProfile(page, it.handle).catch((e) => ({ text: "", halt: "", error: e.message }));
      await this.call("/api/outreach/agent/copies/" + encodeURIComponent(it.id), { method: "POST", body: { text: c.text, halt: c.halt || undefined, error: c.error } }).catch(() => {});
      if (c.halt) { this.log("Stopped while copying a profile: " + c.halt, "error"); return false; }
      this.log(c.text ? `copied ${it.handle}'s profile into Karma Connect` : `couldn't copy ${it.handle}'s profile`, c.text ? "success" : "warn");
      await this.gap(4000, 9000);
    }
    return true;
  }

  // ── This account's loop ───────────────────────────────────────────
  async step() {
    // 1. A command from Karma Connect comes first — it works even while the account is paused.
    const cmd = this.command;
    this.command = null;
    if (cmd === "linkedin_login") { await this.signInToLinkedIn(); return; }
    if (cmd === "check_inbox") { this.lastInbox = 0; this.log("Checking the inbox now (asked in Karma Connect)."); }
    if (cmd === "check_accepts") { this.lastAccept = 0; this.log("Checking for accepted invitations now (asked in Karma Connect)."); }

    // 2. Paused or stopped: close the browser and wait.
    const c = this.control;
    if (!c.enabled) {
      if (this.session) { await this.closeBrowser(); this.log(c.haltReason ? "Browser closed — this account is stopped." : "Paused. Browser closed."); }
      if (this.me.state !== "signed_out") this.doing("paused", c.haltReason ? "Stopped: " + c.haltReason : "Paused in Karma Connect");
      return;
    }

    // 3. On: make sure the browser is open and signed in.
    const s = await this.openBrowser();
    if (!s) return;

    // 4. Send what's due, then read the inbox / new connections when they're due.
    if (Date.now() >= this.nextTick || cmd) {
      const wait = await this.tick(s.page);
      if (wait === null) { this.nextTick = 0; return; } // halted or paused — the next check-in says which
      this.nextTick = Date.now() + wait * 1000;
      if (!(await this.chores(s.page))) return;
    }
    // 5. Copy requests between rounds.
    if (!(await this.copies(s.page))) return;
    this.doing("idle", this.dryRun() ? "Dry run: waiting for work" : "Waiting for work");
  }

  async run() {
    while (!this.gone) {
      try {
        await this.step();
      } catch (e) {
        if (e.removed) { this.log("This account was taken off the agent.", "warn", { local: true }); break; }
        this.log("Something went wrong: " + (e.message || e), "warn");
        if (/Target .*closed|browser has been closed|Browser closed/i.test(String(e.message))) await this.closeBrowser();
      }
      if (!this.gone && !this.command) await this.nap(IDLE_SEC * 1000);
    }
    await this.closeBrowser();
  }
}

// ── The PC: one check-in for every account ──────────────────────────
const accounts = new Map(); // id → Account
let paused = false; // Karma Connect can't be reached / doesn't know this PC: every account waits

async function checkIn() {
  const events = pending.splice(0, pending.length);
  let r;
  try {
    r = await api("/api/outreach/agent/heartbeat", { method: "POST", body: { worker: pc, accounts: [...accounts.values()].map((a) => a.report()), events } });
  } catch (e) {
    pending.unshift(...events.slice(-100)); // try those again next time
    throw e;
  }
  // A server from before accounts answers for one agent: run it as a single account.
  const list = Array.isArray(r.accounts) ? r.accounts : [{ id: null, slot: 1, label: "LinkedIn", ...r }];
  const seen = new Set();
  for (const c of list) {
    const key = c.id || "single";
    seen.add(key);
    const cur = accounts.get(key);
    if (cur) { cur.update(c); continue; }
    const a = new Account(c);
    if (c.command) a.command = c.command;
    accounts.set(key, a);
    log(`Running LinkedIn account "${c.label}" (profile ${path.basename(a.dir)}).`, "info", { local: true });
    // Stagger the start so four browsers don't all open in the same second.
    sleep((accounts.size - 1) * 1500).then(() => a.run());
  }
  for (const [key, a] of accounts) {
    if (!seen.has(key)) { a.gone = true; a.wake(); accounts.delete(key); log(`"${a.label}" isn't on this PC any more — closing its browser.`, "info", { local: true }); }
  }
  for (const id of r.removed || []) {
    if (!accounts.has(id) && forgetProfile(id)) log("Deleted the saved LinkedIn sign-in of an account removed in Karma Connect.", "info", { local: true });
  }
  return r;
}

async function main() {
  if (flag("--login")) {
    // npm run agent:login [-- 2]: sign in the account in that slot (default 1) by hand.
    const slot = parseInt(ARGS.find((x) => /^\d+$/.test(x)) || "1", 10);
    const p = Object.values(profiles()).find((x) => x.slot === slot);
    if (!p && slot !== 1) { console.log(`No account ${slot} on this PC yet. Add it in Karma Connect → LinkedIn agent and let the agent pick it up first.`); return; }
    await login({ dir: path.join(__dirname, p ? p.dir : ".profile") });
    return;
  }
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
    log("Agent closed on " + pc.host + ".", "warn");
    for (const a of accounts.values()) { a.gone = true; a.doing("paused", "Closed on the PC"); }
    await checkIn().catch(() => {});
    await Promise.all([...accounts.values()].map((a) => a.closeBrowser()));
    dropLock();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", dropLock);

  log(`Agent ${VERSION} started on ${pc.host}${DRY_FLAG ? " (dry run forced on this PC)" : ""}. Profiles in ${path.dirname(PROFILE_DIR)}`, "info");
  let offlineSince = 0;

  while (!stopping) {
    try {
      await checkIn();
      if (offlineSince) { log("Back in touch with Karma Connect.", "info"); offlineSince = 0; }
      if (paused) { paused = false; }
    } catch (e) {
      if (e.unpaired) {
        writeLocal("Karma Connect doesn't recognise this PC any more (" + e.message + "). Pair it again: npm run agent -- --pair <code>");
        // Nothing may run without a working connection: stop every account and wait.
        for (const a of accounts.values()) a.gone = true;
        accounts.clear();
        paused = true;
        await sleep(300000);
        cfg = readConfig(); // it may have been re-paired meanwhile
      } else {
        if (!offlineSince) { offlineSince = Date.now(); writeLocal("Can't reach Karma Connect: " + e.message + " — retrying."); }
        await sleep(30000);
      }
      continue;
    }
    await new Promise((r) => { const t = setTimeout(r, CHECK_IN_SEC * 1000); kickMain = () => { clearTimeout(t); r(); }; });
    kickMain = null;
  }
}

main().catch((e) => { writeLocal("agent: " + e.message); console.error("agent:", e.message); dropLock(); process.exit(1); });
