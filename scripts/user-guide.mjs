// Generates the Karma Connect User & Admin Guide PDF.
// Usage: node scripts/user-guide.mjs [out.pdf]
import PDFDocument from "pdfkit";
import fs from "node:fs";

const OUT = process.argv[2] || "Karma-Connect-Guide.pdf";
const DATE = "2026-06-18";

const doc = new PDFDocument({ size: "A4", margin: 54 });
doc.pipe(fs.createWriteStream(OUT));
const W = doc.page.width - 108;
const NAVY = "#0b2545", GOLD = "#b8860b", GREY = "#333", LIGHT = "#777", VIOLET = "#5b3fd6", RED = "#b03030", GREEN = "#2e7d32";

function rule(c) { doc.moveTo(54, doc.y).lineTo(54 + W, doc.y).strokeColor(c || "#e0e0e0").lineWidth(1).stroke(); doc.moveDown(0.5); }
function h1(t, color) { doc.moveDown(0.7); if (doc.y > doc.page.height - 130) doc.addPage(); doc.fillColor(color || NAVY).font("Helvetica-Bold").fontSize(15).text(t); doc.moveDown(0.15); rule(GOLD); }
function h2(t) { doc.moveDown(0.45); if (doc.y > doc.page.height - 110) doc.addPage(); doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11.5).text(t); doc.moveDown(0.2); }
function p(t, c) { doc.fillColor(c || GREY).font("Helvetica").fontSize(9.7).text(t, { width: W, lineGap: 1.5 }); doc.moveDown(0.28); }
function b(t) { doc.fillColor(GREY).font("Helvetica").fontSize(9.7).text("•  " + t, { width: W, indent: 6, lineGap: 1.5 }); doc.moveDown(0.16); }
function step(n, t) { doc.font("Helvetica-Bold").fontSize(9.7).fillColor(VIOLET).text(n + ".  ", { continued: true }).font("Helvetica").fillColor(GREY).text(t, { width: W, lineGap: 1.5 }); doc.moveDown(0.2); }
function qa(problem, fix) {
  doc.font("Helvetica-Bold").fontSize(9.7).fillColor(RED).text("Problem: ", { continued: true }).fillColor(NAVY).text(problem, { width: W });
  doc.font("Helvetica-Bold").fontSize(9.7).fillColor(GREEN).text("Fix: ", { continued: true }).font("Helvetica").fillColor(GREY).text(fix, { width: W, lineGap: 1.5 });
  doc.moveDown(0.35);
}

// ── Cover ──
doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(26).text("Karma Connect");
doc.fillColor(GOLD).font("Helvetica").fontSize(15).text("User & Admin Guide");
doc.fillColor(LIGHT).fontSize(9.5).text("AI-powered prospect outreach  ·  " + DATE);
doc.moveDown(0.5); rule(GOLD);
p("This guide walks through everything in Karma Connect, step by step, for both members and admins, and shows how to handle the problems you are most likely to hit. The live app is at karma-connect-9s2z.onrender.com.");
p("There are two roles. MEMBERS research prospects and write connection requests. ADMINS can also approve leads to unlock the advanced outreach engines (Relationship, Meeting, Follow-up). Most of this guide applies to everyone; the admin-only parts are marked.", NAVY);

// ── Part 1: getting in ──
h1("1. Getting started (everyone)");
h2("Create your account");
step(1, "Open the app and click \"Create an account\".");
step(2, "Enter your first name, last name, work email, and a password (at least 8 characters).");
step(3, "Admin code field: leave it BLANK unless an admin gave you a code. (Entering the correct code makes your account an admin.)");
step(4, "Click Create Account. You'll see \"Check your email for a confirmation link.\"");
step(5, "Open the email from karmaconnect@karmastaff.com and click the confirmation link. (Check your Spam/Junk folder if you don't see it.)");
step(6, "You'll land back on the app showing \"Email confirmed.\" Now sign in with your email and password.");
p("You cannot sign in until you confirm your email. This is intentional - it verifies the address is real.", LIGHT);

h2("Sign in / sign out");
b("Sign in: enter your email + password on the welcome screen.");
b("Sign out: use the \"Sign out\" link at the bottom of the left sidebar (under your email).");
b("\"Remember me\" keeps you signed in on that browser.");

// ── Part 2: the workflow ──
h1("2. Working a prospect, step by step (everyone)");
p("The app follows a funnel down the left sidebar: Prospect Hub -> Intelligence -> Connection Requests -> (after approval) Relationship -> Meeting -> Follow-up.");

h2("Step A - Prospect Hub: enter who you're targeting");
step(1, "Pick the SENDER you're reaching out as (Nordon, Ogyen, Tenzin Jigme, Tenzin Wangjor, or Scott Sandel). Each has its own voice and calendar link.");
step(2, "Fill in the prospect's details: name, title, company, industry, location. The more you add, the better the AI output.");
step(3, "Optional - Company research: paste the company website / name and let the AI pull in verifiable company facts (uses one quick web search).");
step(4, "Optional - Deep LinkedIn paste: open the prospect's LinkedIn profile, select all (Ctrl+A), copy (Ctrl+C), and paste into the LinkedIn box. The AI extracts their profile into the fields.");

h2("Step B - Intelligence: run the AI analysis");
step(1, "Click \"Run AI Analysis\". The AI builds an intelligence profile (persona, responsibilities, pain points, goals, hooks) and a fit score.");
step(2, "The fit scores (ICP Fit, Qualification, Buying readiness) are calculated automatically from the data - they cost nothing.");
step(3, "Once analysis runs, the prospect is auto-saved to your History, and the outreach engines unlock.");

h2("Step C - Connection Requests (open to all members)");
step(1, "Open \"Connection Requests\" and click Generate. You get several distinct invite notes (each under 300 characters, no pitch - just a genuine connection).");
step(2, "Use the Copy button on the draft you like. Star a favorite to keep track.");
step(3, "\"Regenerate all\" makes a fresh set (note: each regenerate is a new AI call).");

h2("Step D - Relationship / Meeting / Follow-up (needs admin approval)");
p("These three engines are LOCKED per lead until an admin approves that lead. This keeps the more advanced (and higher-cost) outreach deliberate.");
step(1, "Open Relationship Builder, Meeting Requests, or Follow-up Engine. If it's locked you'll see a \"Request approval\" panel.");
step(2, "Click \"Request approval\". An admin is notified. The status shows \"Approval requested\".");
step(3, "When an admin approves the lead, the engines unlock - click \"Check again\" or refresh, then Generate as usual.");
b("Relationship Builder: openers after they accept your connection.");
b("Meeting Requests: pick Short / Standard / Executive length. You can paste the prospect's reply so the AI responds to their tone.");
b("Follow-up Engine: a 5-step sequence, each step introducing something new.");

h2("History");
b("Every analyzed prospect is saved here automatically, tied to your account.");
b("Open one to restore the full prospect + everything you generated; Delete removes it.");
b("History follows you across devices and survives a cleared browser.");

// ── Part 3: admins ──
h1("3. For admins only", VIOLET);
p("Admins do everything members do, PLUS they approve leads and bypass the engine locks. You become an admin one of two ways (set up by whoever runs the app): by entering the admin code at signup, or by having your email on the admin list.");

h2("Approving leads");
step(1, "In the sidebar (under \"Admin\") open \"Approvals\".");
step(2, "You'll see each request: the lead name, who requested it, and its status.");
step(3, "Click Approve to unlock Relationship/Meeting/Follow-up for that member on that lead, or Deny to refuse.");
step(4, "Use \"Refresh\" to pull the latest requests.");
p("As an admin, your own leads are never locked - you can use every engine immediately.", LIGHT);

h2("Who can do what");
b("Member: works the leads assigned to them. Nothing else is visible.");
b("Admin (the manager): assigns work, imports, runs job searches, and reads the whole team's numbers. Everything an admin can do is either recoverable or costs money.");
b("Owner: the things that change who has access or cannot be undone - appointing admins, deleting accounts, emptying the Leads bin, lifting a do-not-call ban.");

h2("Making someone an admin");
b("The owner opens Members and clicks \"Make admin\". That is the only way in the app.");
b("Admin list: set ADMIN_EMAILS (comma-separated) in Render to grant it from configuration instead.");
b("Owner list: set OWNER_EMAILS in Render. The owner tier lives only there, never in the database, so it holds even if a row is wrong and cannot be granted from inside the app.");
b("There is no longer an admin signup code. One shared string that promoted whoever typed it could not be revoked for a single person and left no record of who had used it.");
b("After a change, the person should sign out and back in so the app picks up their new status.");

h2("Keeping costs sensible (admins + power users)");
b("Only open the engines you'll actually use - each one is a separate paid AI call.");
b("Skip the company web-research when you already have the info (it's the most expensive single call).");
b("Avoid \"Regenerate\" unless you need a fresh set.");
b("Approve leads selectively - that's the main lever for controlling spend on the advanced engines.");

// ── Part 4: troubleshooting ──
h1("4. Troubleshooting - common problems & fixes");

h2("Signing up / signing in");
qa("I didn't get the confirmation email.", "Check Spam/Junk first. On the sign-in screen use \"Resend confirmation\". Make sure your email is spelled correctly. Company mail filters can be slow - wait a few minutes.");
qa("It says \"Please confirm your email first\" when I try to sign in.", "You must click the link in the confirmation email before you can sign in. Resend it if needed.");
qa("\"Wrong email or password.\"", "Re-check both. If you forgot it, click \"Forgot password?\" on the sign-in screen - we email you a link (valid 1 hour) to set a new one.");
qa("\"An account with that email already exists.\"", "You already signed up - just sign in instead (and confirm the email if you never did).");
qa("\"Invalid admin code.\"", "The code you entered doesn't match. Leave it blank to sign up as a normal member, or get the correct code from your admin.");

h2("Using the app");
qa("The Relationship / Meeting / Follow-up engines are locked (lock icon).", "That's the approval gate. Click \"Request approval\" and an admin will approve the lead. Members can always use Connection Requests.");
qa("I requested approval but it's still locked.", "An admin hasn't approved it yet. Once they do, click \"Check again\" or refresh the page.");
qa("\"The service is busy / try again\" when generating.", "That's a temporary rate limit. Wait a few seconds and try again - the app retries automatically and recovers.");
qa("Messages won't generate / an error appears.", "Click Generate again (the app auto-retries once). Check your internet connection. If it persists, an admin should check the server.");
qa("I don't see a new feature / the page looks old.", "Your browser cached old files. Hard refresh with Ctrl+Shift+R, then sign out and back in.");

h2("Admin-side / setup problems");
qa("Nobody can approve leads (no Approvals panel for anyone).", "No admin is configured. Set ADMIN_EMAILS (or OWNER_EMAILS) in Render, save (the service restarts), then the admin signs out and back in.");
qa("I'm an admin but don't see \"Approvals\".", "Sign out, hard refresh (Ctrl+Shift+R), and sign back in so the app re-reads your admin status.");
qa("Signup fails with \"Could not create the account.\"", "Usually the database tables aren't set up. The operator runs the one-time schema setup (npm run db:init) against the database.");
qa("Confirmation emails never send.", "Email isn't configured: set GATEWAY_URL, GATEWAY_TOKEN and MAIL_FROM in Render, and ask an admin to allowlist your MAIL_FROM address on the mail gateway.");
qa("The whole site won't load.", "Check the hosting dashboard (Render) - the service may be redeploying or asleep on the free tier (first load can take ~30s). Logs there show any error.");

doc.moveDown(0.6);
doc.fillColor(LIGHT).font("Helvetica-Oblique").fontSize(8.5).text("Karma Connect - internal guide. For anything not covered here, contact whoever administers the app.", { width: W });

doc.end();
console.log("Wrote", OUT);
