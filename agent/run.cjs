// The agent loop. Leases approved LinkedIn messages from Karma Connect, sends them, reports back.
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
const { sendOne, jitter } = require("./send.cjs");

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
  log(`leased ${batch.items.length} — ${batch.counts?.day ?? "?"}/${batch.limits?.perDay ?? "?"} sent today`);

  for (const item of batch.items) {
    const who = item.lead_label || item.prospect_id;
    let outcome;
    try {
      outcome = await sendOne(page, item, { dryRun: DRY_RUN });
    } catch (e) {
      outcome = { result: "failed", error: String(e.message || e).slice(0, 300), scrape: null };
    }

    try {
      await api("/api/outreach/agent/report/" + encodeURIComponent(item.id), {
        method: "POST",
        body: { result: outcome.result, error: outcome.error, leaseId, scrape: outcome.scrape },
      });
    } catch (e) { log("could not report", who + ":", e.message); }

    if (outcome.result === "halted") {
      log("HALTED on", who + ":", outcome.error);
      log("The agent has switched itself off. Sort it out on LinkedIn, then turn it back on in the Send Queue.");
      return null; // stop the loop entirely
    }
    log(outcome.result === "sent" ? "sent → " + who : "failed → " + who + ": " + outcome.error);

    // Pace between sends, even inside a batch.
    if (item !== batch.items[batch.items.length - 1]) await jitter(minGapSec * 1000, maxGapSec * 1000);
  }
  return minGapSec;
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
  log("LinkedIn session is live." + (DRY_RUN ? "  [DRY RUN — nothing will be sent]" : ""));

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
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  await ctx.close().catch(() => {});
}

main().catch((e) => { console.error("agent:", e.message); process.exit(1); });
