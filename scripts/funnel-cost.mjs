// Staged-funnel monthly cost estimate.
// Stage 1 (ALL prospects): LinkedIn parse + analysis + connection.
// Stage 2 (the continuing subset): relationship + meeting + follow-up.
// Usage: node scripts/funnel-cost.mjs [total] [continuing] [out.pdf]
import PDFDocument from "pdfkit";
import fs from "node:fs";

const TOTAL = parseInt(process.argv[2] || "2441", 10);
const CONT = parseInt(process.argv[3] || "241", 10);
const OUT = process.argv[4] || "Karma-Connect-Funnel-Cost.pdf";
const DATE = "2026-06-17";

const PRICE = { sonnet: { in: 3.0, out: 15.0 }, haiku: { in: 1.0, out: 5.0 } };
// [label, inputTokens, outputTokens, model]  (current settings: 3 variations, hybrid, fit removed)
const CALLS = {
  parse:        ["LinkedIn parse  [Haiku]", 6000, 2000, "haiku"],
  analysis:     ["AI Analysis  [Sonnet]",   1650, 700,  "sonnet"],
  connection:   ["Connection x3  [Sonnet]", 2550, 360,  "sonnet"],
  relationship: ["Relationship x3  [Sonnet]", 2650, 540, "sonnet"],
  meeting:      ["Meeting x3  [Sonnet]",     2750, 780,  "sonnet"],
  followup:     ["Follow-up (5 steps)  [Sonnet]", 2800, 1400, "sonnet"],
};
const STAGE1 = ["parse", "analysis", "connection"];
const STAGE2 = ["relationship", "meeting", "followup"];

const callCost = (k) => { const [, i, o, m] = CALLS[k]; return (i * PRICE[m].in + o * PRICE[m].out) / 1_000_000; };
const sumCost = (keys) => keys.reduce((a, k) => a + callCost(k), 0);
const sumTok = (keys) => keys.reduce((a, k) => ({ i: a.i + CALLS[k][1], o: a.o + CALLS[k][2] }), { i: 0, o: 0 });
const money = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money4 = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const num = (n) => Math.round(n).toLocaleString("en-US");

const s1cost = sumCost(STAGE1), s2cost = sumCost(STAGE2);
const s1month = s1cost * TOTAL, s2month = s2cost * CONT;
const grand = s1month + s2month;
const s1tok = sumTok(STAGE1), s2tok = sumTok(STAGE2);
const totalTok = (s1tok.i + s1tok.o) * TOTAL + (s2tok.i + s2tok.o) * CONT;

const doc = new PDFDocument({ size: "A4", margin: 50 });
doc.pipe(fs.createWriteStream(OUT));
const PAGE_W = doc.page.width - 100;
const NAVY = "#0b2545", GOLD = "#b8860b", GREY = "#333", LIGHT = "#777";
function rule() { doc.moveDown(0.3); doc.moveTo(50, doc.y).lineTo(50 + PAGE_W, doc.y).strokeColor("#dddddd").lineWidth(1).stroke(); doc.moveDown(0.5); }
function h(t) { doc.moveDown(0.5); doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(12.5).text(t); doc.moveDown(0.25); }
function p(t, c) { doc.fillColor(c || GREY).font("Helvetica").fontSize(9.5).text(t, { width: PAGE_W }); doc.moveDown(0.15); }
function trow(cols, w, xs, opts = {}) {
  const y = doc.y;
  doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(opts.color || GREY);
  cols.forEach((c, i) => doc.text(c, xs[i], y, { width: w[i], align: opts.align && opts.align[i] ? opts.align[i] : "left" }));
  doc.y = y + 15; doc.x = 50;
}

doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(22).text("Karma Connect");
doc.fillColor(GOLD).font("Helvetica").fontSize(13).text("Monthly Cost Estimate - staged funnel");
doc.fillColor(LIGHT).fontSize(9).text(`Generated ${DATE}  -  ${num(TOTAL)} prospects, ${num(CONT)} continue  -  hybrid Sonnet + Haiku`);
rule();

h("Assumptions");
p(`Stage 1 - ALL ${num(TOTAL)} prospects: LinkedIn paste parsing + AI analysis + connection requests (3 drafts).`);
p(`Stage 2 - only ${num(CONT)} prospects continue to: relationship (3) + one meeting length (3) + follow-up (5 steps).`);
p("Model: Haiku 4.5 for LinkedIn parsing; Sonnet 4.6 for analysis + all message generation. 3 variations per engine. AI fit-scoring removed.");
p("Pricing: Sonnet $3 / $15 per 1M tokens; Haiku $1 / $5 per 1M. Estimates from prompt sizes; caching not applied (conservative).", LIGHT);

const w = [230, 70, 70, 95], xs = [55, 285, 360, 440];
h(`Stage 1 - every prospect  (x ${num(TOTAL)})`);
trow(["Call (model)", "Input", "Output", "Cost each"], w, xs, { bold: true, color: NAVY, align: ["left", "right", "right", "right"] });
doc.moveTo(50, doc.y - 2).lineTo(50 + PAGE_W, doc.y - 2).strokeColor("#dddddd").stroke(); doc.moveDown(0.15);
for (const k of STAGE1) { const [l, i, o] = CALLS[k]; trow([l, num(i), num(o), money4(callCost(k))], w, xs, { align: ["left", "right", "right", "right"] }); }
trow(["Per prospect (Stage 1)", num(s1tok.i), num(s1tok.o), money4(s1cost)], w, xs, { bold: true, color: NAVY, align: ["left", "right", "right", "right"] });
doc.moveDown(0.1);
p(`Stage 1 monthly:  ${money4(s1cost)} x ${num(TOTAL)} = ${money(s1month)}`, NAVY);

h(`Stage 2 - the ${num(CONT)} who continue  (x ${num(CONT)})`);
trow(["Call (model)", "Input", "Output", "Cost each"], w, xs, { bold: true, color: NAVY, align: ["left", "right", "right", "right"] });
doc.moveTo(50, doc.y - 2).lineTo(50 + PAGE_W, doc.y - 2).strokeColor("#dddddd").stroke(); doc.moveDown(0.15);
for (const k of STAGE2) { const [l, i, o] = CALLS[k]; trow([l, num(i), num(o), money4(callCost(k))], w, xs, { align: ["left", "right", "right", "right"] }); }
trow(["Per prospect (Stage 2 extra)", num(s2tok.i), num(s2tok.o), money4(s2cost)], w, xs, { bold: true, color: NAVY, align: ["left", "right", "right", "right"] });
doc.moveDown(0.1);
p(`Stage 2 monthly:  ${money4(s2cost)} x ${num(CONT)} = ${money(s2month)}`, NAVY);

// Total box
doc.moveDown(0.3);
const by = doc.y, bh = 64;
doc.roundedRect(50, by, PAGE_W, bh, 6).fillAndStroke("#f4f1ea", "#e2d9c2");
doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11).text("Estimated monthly total", 65, by + 11);
doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(18).text(money(grand) + " / month", 65, by + 28);
doc.fillColor(GREY).font("Helvetica").fontSize(9.5).text(`(${money(grand * 12)} / year  -  about ${num(totalTok / 1e6)} million tokens / month)`, 65, by + 50);
doc.y = by + bh + 12; doc.x = 50;

h("Summary");
const sw = [300, 110, 110], sx = [55, 320, 440];
trow(["Stage", "Prospects", "Monthly"], sw, sx, { bold: true, color: NAVY, align: ["left", "right", "right"] });
doc.moveTo(50, doc.y - 2).lineTo(50 + PAGE_W, doc.y - 2).strokeColor("#dddddd").stroke(); doc.moveDown(0.15);
trow(["1. Parse + analysis + connection (all)", num(TOTAL), money(s1month)], sw, sx, { align: ["left", "right", "right"] });
trow(["2. Relationship + meeting + follow-up (continue)", num(CONT), money(s2month)], sw, sx, { align: ["left", "right", "right"] });
trow(["TOTAL", "", money(grand)], sw, sx, { bold: true, color: GOLD, align: ["left", "right", "right"] });

doc.moveDown(0.4);
doc.fillColor(LIGHT).font("Helvetica-Oblique").fontSize(8).text(
  "Estimate only. Real per-call usage is recorded in the app's usage table (GET /api/usage); rebuild from actuals after a real batch. Web-search company research is NOT included here (it was not part of this funnel) - add it only for prospects where you run it.",
  { width: PAGE_W });

doc.end();
console.log("Wrote", OUT, "-> total", money(grand), "/mo");
