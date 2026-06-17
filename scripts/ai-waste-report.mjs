// Generates a PDF audit: where the app calls the AI but doesn't need to.
// Usage: node scripts/ai-waste-report.mjs [out.pdf]
import PDFDocument from "pdfkit";
import fs from "node:fs";

const OUT = process.argv[2] || "Karma-Connect-AI-Waste-Audit.pdf";
const DATE = "2026-06-17";

const doc = new PDFDocument({ size: "A4", margin: 50 });
doc.pipe(fs.createWriteStream(OUT));
const PAGE_W = doc.page.width - 100;
const NAVY = "#0b2545", GOLD = "#b8860b", GREY = "#333", LIGHT = "#777", GREEN = "#2e7d32", RED = "#b03030";

function rule() { doc.moveDown(0.3); doc.moveTo(50, doc.y).lineTo(50 + PAGE_W, doc.y).strokeColor("#dddddd").lineWidth(1).stroke(); doc.moveDown(0.5); }
function h(t) { doc.moveDown(0.5); doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(13).text(t); doc.moveDown(0.25); }
function p(t, color) { doc.fillColor(color || GREY).font("Helvetica").fontSize(9.5).text(t, { width: PAGE_W }); doc.moveDown(0.2); }
function bullet(t, color) { doc.fillColor(color || GREY).font("Helvetica").fontSize(9.5).text("-  " + t, { width: PAGE_W, indent: 4 }); doc.moveDown(0.12); }
function trow(cols, widths, xs, opts = {}) {
  const y = doc.y;
  doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(opts.color || GREY);
  cols.forEach((c, i) => doc.text(c, xs[i], y, { width: widths[i], align: opts.align && opts.align[i] ? opts.align[i] : "left" }));
  doc.y = y + (opts.h || 15); doc.x = 50;
}

// Header
doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(22).text("Karma Connect");
doc.fillColor(GOLD).font("Helvetica").fontSize(13).text("AI Usage Audit - is the AI ever doing work we don't need?");
doc.fillColor(LIGHT).fontSize(9).text(`Generated ${DATE}`);
rule();

// Finding banner
const by = doc.y;
doc.roundedRect(50, by, PAGE_W, 50, 6).fillAndStroke("#f4f1ea", "#e2d9c2");
doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11).text("Finding: the AI computes fit scores that the app never uses.", 65, by + 12, { width: PAGE_W - 30 });
doc.fillColor(GREY).font("Helvetica").fontSize(9.5).text("The on-screen fit scores come from a free, code-based scorer - so the AI's version is generated and thrown away.", 65, by + 30, { width: PAGE_W - 30 });
doc.y = by + 58; doc.x = 50;

h("What's happening");
p("The AI Analysis step asks the model to return a \"fit\" object (ICP / qualification / buying-readiness scores with reasons). That is extra output on every analysis call.");
p("But the fit scores shown in the UI come from scoreFit() - a deterministic, rules-based scorer computed in code (free, no AI). A full code review found the AI's fit object is read nowhere; only the code scores are displayed.");
p("So the model spends tokens producing fit scores that are immediately discarded.", RED);

h("Evidence (code references)");
bullet("Prompt asks for it:  src/lib/prompts.js -> pAnalysis()  (the \"fit\": { icp, qualification, readiness } block).");
bullet("Real scores are code-based:  src/lib/scoring.js -> scoreFit();  used at src/KarmaConnectAI.jsx:422 (fitRows) and :435 (aiConfidence).");
bullet("The AI's analysis.fit is never referenced anywhere in src/.");

h("Impact (estimate, at 2,000 analyses / month)");
const xs = [55, 300, 410], w = [240, 100, 130];
trow(["Item", "Per analysis", "Per month"], w, xs, { bold: true, color: NAVY, align: ["left", "right", "right"] });
doc.moveTo(50, doc.y - 2).lineTo(50 + PAGE_W, doc.y - 2).strokeColor("#dddddd").lineWidth(1).stroke(); doc.moveDown(0.15);
trow(["Wasted output tokens", "~120", "~240,000"], w, xs, { align: ["left", "right", "right"] });
trow(["Wasted input tokens", "~50", "~100,000"], w, xs, { align: ["left", "right", "right"] });
trow(["Wasted cost (Sonnet)", "~$0.002", "~$4 / mo  (~$47 / yr)"], w, xs, { bold: true, color: NAVY, align: ["left", "right", "right"] });
doc.moveDown(0.2);
p("Small in dollars - but it is 100% waste: zero benefit for the spend. The value is that removing it has no downside at all.", LIGHT);

h("Recommendation");
p("Remove the \"fit\" block (and the \"Score honestly...\" line) from the pAnalysis prompt. Effect: smaller AI output on every analysis call, and ZERO visible change - the on-screen fit scores come from code and will not move. No impact on message quality (this is the analysis step, not message generation).", GREEN);

h("Every AI call reviewed");
const cx = [55, 250, 360], cw = [195, 110, 130];
trow(["AI call", "Needs AI?", "Verdict"], cw, cx, { bold: true, color: NAVY });
doc.moveTo(50, doc.y - 2).lineTo(50 + PAGE_W, doc.y - 2).strokeColor("#dddddd").lineWidth(1).stroke(); doc.moveDown(0.15);
trow(["Company research", "Yes (web search)", "Keep"], cw, cx);
trow(["LinkedIn paste parsing", "Yes (messy text)", "Keep"], cw, cx);
trow(["Analysis: profile (persona/hooks/pains)", "Yes", "Keep"], cw, cx);
trow(["Analysis: fit scores", "No - code does it", "REMOVE (this finding)"], cw, cx, { color: RED });
trow(["Message generation", "Yes", "Keep"], cw, cx);
trow(["personalization % / acceptance % / AI Coach", "Shown, not essential", "Feature choice"], cw, cx);

doc.moveDown(0.4);
doc.fillColor(LIGHT).font("Helvetica-Oblique").fontSize(8).text(
  "Note: estimates from prompt sizes. \"personalization/acceptance/AI Coach\" are AI extras that ARE displayed - removing them is a feature decision, not dead weight. Company research and paste parsing genuinely need AI (the text is too variable for plain code).",
  { width: PAGE_W });

doc.end();
console.log("Wrote", OUT);
