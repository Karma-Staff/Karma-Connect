"use strict";
/* The domain API — the only process the dashboard talks to.

   Two ways in:
     - `node leads/server/index.js` runs it standalone on :8080, app at / and
       /app, exactly as it always did.
     - mount(app, opts) hangs the same routes off Karma Connect's Express app
       so one Render service serves both products. There, the static app lives
       under /leads and Connect owns /.

   The API paths are IDENTICAL either way (/api/...), because public/app.js
   calls them absolutely. Keeping them put is what lets the front end stay
   untouched. */

const express = require("express");
const path = require("path");
const auth = require("./auth");
const cachebust = require("./cachebust");

/* same no-cache policy as the old server: revalidate, don't blind-serve — a
   half-cached app.js/index.html pair breaks the page and the round trip is
   cheap on localhost. Assets are referenced relatively, so the same files
   work from whichever prefix they are mounted under. */
function staticHandler() {
  return express.static(path.join(__dirname, "..", "public"), {
    etag: true,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  });
}

/**
 * Attach every Leads route to `app`.
 *
 * opts.staticPaths  where the SPA is served. Standalone: ["/app", "/"].
 *                   Merged: ["/leads"] — "/" belongs to Karma Connect.
 * opts.terminal     register the /api 404 and the error handler. False when a
 *                   host app supplies its own, so Leads' handlers cannot
 *                   swallow the host's routes.
 */
function mount(app, opts = {}) {
  const staticPaths = opts.staticPaths || ["/app", "/"];
  const terminal = opts.terminal !== false;

  const statics = staticHandler();
  for (const p of staticPaths) {
    /* /leads (no trailing slash) would serve index.html while the browser still
       thinks it is at /, so "app.css" would resolve to /app.css and the page
       would load bare. Redirect to the directory form first.

       Express matches "/leads" and "/leads/" with the same route, so redirect
       ONLY when the slash is genuinely absent — otherwise /leads/ redirects to
       itself, forever. */
    if (p !== "/") {
      app.get(p, (req, res, next) => {
        if (req.originalUrl.split("?")[0].endsWith("/")) return next();
        res.redirect(301, p + "/");
      });
    }
    /* index.html first, so its ?v= markers carry a stamp of the real file
       contents rather than whatever was last typed by hand. See
       cachebust.js — a version bump that gets forgotten leaves every
       browser that cached the old URL running old code. */
    app.use(p, cachebust.indexWithStamp());
    app.use(p, statics);
  }

  /* ---------------- auth: WorkOS AuthKit
     Point post-sign-in redirects at wherever we just served the app, or a
     WorkOS round trip would land the user on Karma Connect's front page. */
  const first = staticPaths[0] || "/";
  auth.setAppPath(process.env.LEADS_APP_PATH || (first === "/" ? "/" : first + "/"));
  auth.mountAuthRoutes(app);

  app.get("/api/me", auth.requireUser, (req, res) => {
    res.json({ id: req.user.id, email: req.user.email,
      display_name: req.user.name, role: req.user.role });
  });

  /* ---------------- demo mode (development only)
     Mounted FIRST so it can answer before the database-backed routers, and
     only when KARMA_DEMO=1 outside production. In every other configuration
     these handlers are never registered at all. */
  const demo = require("./demo");
  if (demo.ON) app.use(demo.router);

  /* ---------------- feature routers */
  app.use(require("./leads").router);
  app.use(require("./counts").router);
  app.use(require("./recents").router);
  app.use(require("./users").router);
  app.use(require("./jobsearch").router);
  app.use(require("./imports").router);
  /* bulk actions on a ticked selection (admin) — mounted at /api/bulk, clear of
     leads.js's /api/leads/:id routes */
  app.use(require("./bulk").router);
  /* the Team activity pane's phone-refresh button (admin) */
  app.use(require("./webphone").router);
  /* the assignments board (admin): read-only workload per person — assigning
     itself still goes through bulk.js, mounted above */
  app.use(require("./assignments").router);
  /* click-to-call config + the OAuth token the in-page softphone asks for */
  app.use(require("./voice").router);
  /* RingCentral sits alongside Zoho rather than replacing it: both can be
     configured at once while the team moves across, and the front end picks
     whichever actually has a working seat for that rep. */
  app.use(require("./ringcentral").router);
  app.use(require("./rc-dashboard").router);
  app.use(require("./live").router);
  app.use(require("./calllogs").router);
  app.use(require("./users-dir").router);
  /* calls into Zoho CRM's call log, and leads from connected calls — off
     until an owner turns it on (app_settings "crm.sync") */
  const crmSync = require("./crm-sync");
  app.use(crmSync.router);
  crmSync.startSweeper();
  app.use(require("./zoho-crm").router);
  /* each person's own Zoho CRM sign-in, so what they create there is theirs */
  app.use(require("./crm-identity").router);
  /* recording calls, and the manager's report built from them. After leads.js
     so its requireOwnLead guard has already run for /api/leads/:id paths. */
  app.use(require("./calls").router);
  /* one rep's own working queue — always the caller's own, never the team's */
  app.use(require("./tasks").router);
  /* the prospect briefing. After leads.js so requireOwnLead has already run:
     a member cannot spend the research budget on somebody else's lead. */
  app.use(require("./research").router);
  /* live severe-weather alerts, scored for restoration and joined to leads */
  app.use(require("./alerts").router);
  /* the 7am digest, and the external knock that fires it — see digest.js on
     why this cannot be a timer on the free plan */
  app.use(require("./digest").router);
  /* call sessions — working an assigned list straight through */
  app.use(require("./campaign").router);
  /* "Follow back" reminders, and the sweeper that emails them when due */
  const followups = require("./followups");
  app.use(followups.router);
  followups.startSweeper();

  /* the trash bin, plus its 30-day sweep — mounted after leads so the leads
     router's requireUser has already run for /api/leads/:id paths */
  const trash = require("./trash");
  app.use(trash.router);
  trash.startSweeper();

  const activity = require("./activity");
  app.get("/api/activity", auth.requireAdmin, async (req, res, next) => {
    try { res.json(await activity.summary(req.query.days, req.query.full === "1")); }
    catch (e) { next(e); }
  });

  /* ---------------- errors */
  if (terminal) {
    app.use("/api", (req, res) => res.status(404).json({ error: "no such endpoint" }));
    app.use((err, req, res, next) => {       // eslint-disable-line no-unused-vars
      console.error("[karma]", req.method, req.path, "->", err.message);
      res.status(500).json({ error: "server error" });
    });
  }

  return app;
}

module.exports = { mount };

/* Standalone: only when run directly, never when Karma Connect requires us. */
if (require.main === module) {
  const PORT = +process.env.PORT || 8080;
  const app = mount(express());
  app.listen(PORT, () =>
    console.log(`Karma Leads API on http://localhost:${PORT} — app at / (and /app)`));
}
