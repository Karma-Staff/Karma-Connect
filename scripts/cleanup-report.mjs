// Generates a PDF explaining each cleanup item, what it does, and what removing it saves.
// Usage: node scripts/cleanup-report.mjs [out.pdf]
import PDFDocument from "pdfkit";
import fs from "node:fs";

const OUT = process.argv[2] || "Karma-Connect-Cleanup-Report.pdf";
const DATE = "2026-06-17";

const doc = new PDFDocument({ size: "A4", margin: 50 });
doc.pipe(fs.createWriteStream(OUT));
const PAGE_W = doc.page.width - 100;
const NAVY = "#0b2545", GOLD = "#b8860b", GREY = "#333", LIGHT = "#777", GREEN = "#2e7d32";

function rule() { doc.moveDown(0.3); doc.moveTo(50, doc.y).lineTo(50 + PAGE_W, doc.y).strokeColor("#dddddd").lineWidth(1).stroke(); doc.moveDown(0.5); }
function h(t) { doc.moveDown(0.5); doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(13).text(t); doc.moveDown(0.25); }
function p(t, color) { doc.fillColor(color || GREY).font("Helvetica").fontSize(9.5).text(t, { width: PAGE_W }); doc.moveDown(0.2); }
function item(name, what, does, money, benefit) {
  doc.moveDown(0.25);
  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(10.5).text(name, { width: PAGE_W });
  const line = (label, val, c) => { doc.font("Helvetica-Bold").fontSize(9).fillColor(c || GREY).text("   " + label + " ", { continued: true }).font("Helvetica").fillColor(GREY).text(val, { width: PAGE_W }); };
  line("What it is:", what);
  line("What it does now:", does);
  line("Money saved by removing:", money, GREEN);
  line("Real benefit:", benefit, NAVY);
  doc.moveDown(0.15);
}
function trow(cols, widths, xs, opts = {}) {
  const y = doc.y;
  doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(opts.color || GREY);
  cols.forEach((c, i) => doc.text(c, xs[i], y, { width: widths[i], align: opts.align && opts.align[i] ? opts.align[i] : "left" }));
  doc.y = y + (opts.h || 15); doc.x = 50;
}

doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(22).text("Karma Connect");
doc.fillColor(GOLD).font("Helvetica").fontSize(13).text("Cleanup Report - what each item is, and what removing it saves");
doc.fillColor(LIGHT).fontSize(9).text(`Generated ${DATE}`);
rule();

// Banner: the honest headline
const by = doc.y;
doc.roundedRect(50, by, PAGE_W, 46, 6).fillAndStroke("#f4f1ea", "#e2d9c2");
doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(10.5).text("These cleanup items cost $0 to keep - none of them make AI calls.", 65, by + 11, { width: PAGE_W - 30 });
doc.fillColor(GREY).font("Helvetica").fontSize(9).text("Removing them saves clutter, confusion and risk - not money. The real dollar savings (shown at the end) came from the token + model changes already shipped.", 65, by + 27, { width: PAGE_W - 30 });
doc.y = by + 54; doc.x = 50;

h("The items, one by one");

item("1. Five generated PDF reports committed to the repo",
  "Cost / token report PDFs produced by the scripts, accidentally checked into git.",
  "Nothing at runtime - they just sit in the repo, add weight, and go out of date as numbers change.",
  "$0 (they are files, not API calls).",
  "Cleaner, smaller repo; no stale numbers shipped to anyone who clones it. Keep the files on disk, stop versioning them.");

item("2. setup.bat / setup.command",
  "\"One-click\" installers from the old download-a-ZIP distribution model (Windows + macOS).",
  "Writes a .env containing REMOVED Supabase variables and NO database / auth / Resend keys - i.e. a broken config. Assumes the old Vite-only app.",
  "$0.",
  "Stops a teammate from creating a broken setup. They are actively misleading now.");

item("3. start.sh",
  "A macOS dev launcher.",
  "Looks for a bundled Node in a .tools/ folder that no longer exists. On this Windows PC you use \"Start Karma Connect.bat\" instead.",
  "$0.",
  "Removes a dead, OS-specific launcher.");

item("4. login.sh / push.sh",
  "macOS helpers that used a bundled GitHub CLI to log in and push to main.",
  "Reference a .tools/ gh binary that is gone -> broken. Pushing is done with normal git now.",
  "$0.",
  "Removes broken, OS-specific git scripts.");

item("5. SETUP.md",
  "Setup instructions for the old ZIP / setup.bat flow.",
  "Documents the wrong things (localhost:5173, VITE_ANTHROPIC_API_KEY, Supabase). Would mislead a new person.",
  "$0.",
  "Either delete, or rewrite for the current Render + Postgres flow so docs are accurate.");

item("6. The \"deep\" web-search tier (code)",
  "An unused option in the AI client for 4 web searches per call.",
  "Never called - only \"light\" (1 search) is used. A dead code branch; it never runs.",
  "$0 (it is not executed, so it costs nothing even today).",
  "Marginally simpler code. Low priority - safe to leave.");

item("7. Loader caption \"Scoring fit...\"",
  "A line in the loading animation shown during analysis.",
  "Says the AI is \"scoring fit\" although the AI no longer does that (the code scorer does). Cosmetic mismatch only.",
  "$0.",
  "Accurate on-screen wording.");

h("Where the money actually WAS saved (for context)");
const xs = [55, 330, 460], w = [270, 120, 90];
trow(["Change (already shipped)", "Saves / month*", ""], w, xs, { bold: true, color: NAVY });
doc.moveTo(50, doc.y - 2).lineTo(50 + PAGE_W, doc.y - 2).strokeColor("#dddddd").lineWidth(1).stroke(); doc.moveDown(0.15);
trow(["Message variations 10 -> 3", "~$120", ""], w, xs);
trow(["Hybrid model (Haiku for parse + research)", "~$95 (research-heavy)", ""], w, xs);
trow(["Lighter company research (3 -> 1 search)", "folded into above", ""], w, xs);
trow(["Removed unused AI fit scores", "~$4", ""], w, xs);
trow(["This cleanup report's items", "$0", ""], w, xs, { bold: true, color: GREEN });
doc.moveDown(0.2);
p("* Estimates at 2,000 typical prospects / month on Sonnet. These are the real cost levers; the cleanup items above are about code quality and safety, not spend.", LIGHT);

h("Bottom line");
p("Removing the cleanup items saves $0 per month - but makes the project safer (no broken installer), clearer (accurate docs/UI), and tidier (no artifacts in git). It is worth doing for hygiene, not for cost. All actual savings already came from the token + model work.", GREEN);

doc.end();
console.log("Wrote", OUT);
