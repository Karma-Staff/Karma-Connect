// Generates a PDF playbook of token-reduction options for Karma Connect.
// Usage: node scripts/token-report.mjs [out.pdf]
import PDFDocument from "pdfkit";
import fs from "node:fs";

const OUT = process.argv[2] || "Karma-Connect-Token-Reduction.pdf";
const REPORT_DATE = "2026-06-16";

const doc = new PDFDocument({ size: "A4", margin: 50 });
doc.pipe(fs.createWriteStream(OUT));
const PAGE_W = doc.page.width - 100;
const NAVY = "#0b2545", GOLD = "#b8860b", GREY = "#333", LIGHT = "#777", GREEN = "#2e7d32";

function rule() { doc.moveDown(0.3); doc.moveTo(50, doc.y).lineTo(50 + PAGE_W, doc.y).strokeColor("#dddddd").lineWidth(1).stroke(); doc.moveDown(0.5); }
function h(t) { doc.moveDown(0.6); doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(13).text(t); doc.moveDown(0.25); }
function bullet(t, color) { doc.fillColor(color || GREY).font("Helvetica").fontSize(9.5).text("-  " + t, { width: PAGE_W, indent: 4 }); doc.moveDown(0.15); }
// A lever block: bold name, then Saves / Trade-off lines.
function lever(name, saves, trade) {
  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(10).text(name, { width: PAGE_W });
  doc.font("Helvetica").fontSize(9).fillColor(GREEN).text("   Saves: ", { continued: true }).fillColor(GREY).text(saves, { width: PAGE_W });
  doc.fillColor("#b03030").text("   Trade-off: ", { continued: true }).fillColor(GREY).text(trade, { width: PAGE_W });
  doc.moveDown(0.35);
}
// 4-column table row at the current y.
function trow(c1, c2, c3, c4, opts = {}) {
  const y = doc.y;
  doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(opts.color || GREY);
  doc.text(c1, 55, y, { width: 215 });
  doc.text(c2, 272, y, { width: 80, align: "right" });
  doc.text(c3, 357, y, { width: 80, align: "right" });
  doc.text(c4, 442, y, { width: 100, align: "right" });
  doc.y = y + 15;
  doc.x = 50; // reset cursor to left margin so following flowing text isn't stuck in a column
}

// Header
doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(22).text("Karma Connect");
doc.fillColor(GOLD).font("Helvetica").fontSize(13).text("Token Reduction Playbook");
doc.fillColor(LIGHT).fontSize(9).text(`Generated ${REPORT_DATE}  -  how to lower AI cost per prospect`);
rule();

doc.fillColor(GREY).font("Helvetica").fontSize(9.5).text(
  "The largest savings are already in place. A typical prospect now costs roughly $0.05-0.12. What remains are smaller levers that trade against message quality or features - so they are judgement calls, not automatic wins.",
  { width: PAGE_W });

h("Already optimized");
bullet("Message variations per engine: 10 -> 3 (cut generation output ~70%).", GREEN);
bullet("Company web research: 3 searches -> 1 (cut the biggest variable input).", GREEN);
bullet("Hybrid model: Haiku for parsing + research, Sonnet for analysis + message generation (~1/3 cost on research-heavy prospects).", GREEN);

h("Before vs after  (typical prospect, billed at 2,000/month)");
trow("Stage", "Tokens", "Cost/prospect", "Per month", { bold: true, color: NAVY });
doc.moveTo(50, doc.y - 2).lineTo(50 + PAGE_W, doc.y - 2).strokeColor("#dddddd").lineWidth(1).stroke(); doc.moveDown(0.2);
trow("Now (baseline)", "~16,300", "$0.095", "$191");
trow("+ Code tweaks (cache brand-voice + drop AI Coach)", "~15,900", "$0.084", "$169");
trow("+ Usage discipline (run ~2 engines, not 5)", "~8,700", "$0.045", "$89");
doc.moveDown(0.1);
doc.font("Helvetica-Bold").fontSize(9.5).fillColor(GREEN).text("Full recommended set: ~47% fewer tokens, ~53% lower cost (about $100/month saved at 2,000).", { width: PAGE_W });
doc.moveDown(0.2);
doc.font("Helvetica-Oblique").fontSize(8).fillColor(LIGHT).text(
  "Notes: \"Typical\" = analysis + 4 engines (connection, relationship, 1 meeting, follow-up). Caching lowers cost without lowering raw token count - cached input is billed at ~10%. The big drop comes from usage discipline (opening only the engines you need), not the code tweaks.",
  { width: PAGE_W });

h("A. Quick code tweaks  (small-medium saving, low risk)");
lever("Cache the brand-voice block",
  "Input tokens on every generation call within a prospect run.",
  "None visible - the ~830-token humanize instructions move into the cached system prompt. Safest option.");
lever("Remove the \"AI Coach\" note under each draft",
  "Output tokens (the pricier kind) on every draft.",
  "You lose the one-line rationale shown under each message in the UI.");
lever("Slim the AI profile sent into generation",
  "Input tokens per generation call (send only hooks + pain points + persona, not the full profile).",
  "Slightly less context could marginally reduce personalization.");
lever("Drop the analysis auto-retry",
  "A rare double-charge when the analysis JSON fails to parse.",
  "A parse hiccup shows an error instead of silently retrying. Tiny saving.");

h("B. Model choices  (bigger cost saving, quality trade-off)");
lever("Push more engines to Haiku",
  "~2/3 on whichever engines move (e.g. connection/relationship on Haiku, keep Sonnet for meeting/follow-up).",
  "Lower-quality short messages.");
lever("All-Haiku",
  "~2/3 across the board.",
  "Noticeable drop in outreach-copy quality - not advised for the messages your team sends.");
lever("Fewer variations (3 -> 2)",
  "~1/3 more of generation output.",
  "Less choice per engine.");

h("C. Usage habits  (often the biggest real-world lever, zero build)");
bullet("Only open the engines you will use. Each engine (connection / relationship / each meeting length / follow-up) is a separate paid call. Generating all of them \"just in case\" is the #1 hidden cost - using 2 instead of 5 is ~60% less per prospect.");
bullet("Skip company web-research when you already have the info. It is the single most expensive call (web pages pulled into context).");
bullet("Avoid \"Regenerate all\" unless needed - each regenerate is a fresh paid call.");
bullet("Paste a focused LinkedIn profile, not giant pages - the parser reads up to ~24k characters.");

h("Recommended order");
bullet("1. Cache the brand-voice block (A) - free of downsides.", NAVY);
bullet("2. Enforce usage discipline (C) - moves the needle more than any code change.", NAVY);
bullet("3. Optionally remove the AI Coach note (A) if the team does not use it.", NAVY);
bullet("4. Only consider model downgrades (B) if you need a step-change and accept lower message quality.", NAVY);

doc.moveDown(0.4);
doc.fillColor(LIGHT).font("Helvetica-Oblique").fontSize(8.5).text(
  "Reality check: beyond caching + usage discipline, you are shaving cents per prospect against rising quality risk. At ~$190/mo for 2,000 typical prospects, usage discipline will save more than further code changes. Exact per-call usage is recorded in the app's usage table (GET /api/usage).",
  { width: PAGE_W });

doc.end();
console.log("Wrote", OUT);
