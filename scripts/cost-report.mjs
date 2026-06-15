// Generates a one-off PDF cost estimate for running Karma Connect at a given monthly volume.
// Usage: node scripts/cost-report.mjs [prospectsPerMonth] [out.pdf]
import PDFDocument from "pdfkit";
import fs from "node:fs";

// ── Inputs / assumptions ──
const PROSPECTS_PER_MONTH = parseInt(process.argv[2] || "2000", 10);
const OUT = process.argv[3] || "Karma-Connect-Cost-Report.pdf";
const REPORT_DATE = "2026-06-15";          // passed in (Date.now is unavailable in some envs)
const WORKING_DAYS = 22;                    // weekdays per month (excludes weekends)

// Anthropic pricing, USD per 1,000,000 tokens.
const PRICE = {
  "Sonnet 4.6": { in: 3.0, out: 15.0 },
  "Haiku 4.5":  { in: 1.0, out: 5.0 },
};

// Per-prospect token estimates (5 variations per engine, after the 10→5 cut).
// Each call: [label, inputTokens, outputTokens]
const CALLS = {
  analysis:     ["AI Analysis",            1650, 800],
  connection:   ["Connection (5 drafts)",  2600, 600],
  relationship: ["Relationship (5 drafts)",2700, 900],
  meeting:      ["Meeting, 1 length (5)",  2800, 1300],
  followup:     ["Follow-up (5 steps)",    2800, 1400],
  paste:        ["LinkedIn paste parse",   3500, 1200],
  research:     ["Company research (web)", 15000, 600],
};

const sum = (keys) => keys.reduce(
  (a, k) => ({ in: a.in + CALLS[k][1], out: a.out + CALLS[k][2] }),
  { in: 0, out: 0 },
);

// Scenarios: which calls run per prospect.
const SCENARIOS = [
  { name: "Light", desc: "Analysis + connection + relationship only", keys: ["analysis", "connection", "relationship"] },
  { name: "Typical (full)", desc: "Analysis + connection + relationship + 1 meeting + follow-up", keys: ["analysis", "connection", "relationship", "meeting", "followup"] },
  { name: "Full + research", desc: "Typical + LinkedIn paste parse + web-search company research", keys: ["analysis", "connection", "relationship", "meeting", "followup", "paste", "research"] },
];

const costPerProspect = (toks, model) => (toks.in * PRICE[model].in + toks.out * PRICE[model].out) / 1_000_000;
const money = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money4 = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const num = (n) => n.toLocaleString("en-US");

// ── PDF ──
const doc = new PDFDocument({ size: "A4", margin: 50 });
doc.pipe(fs.createWriteStream(OUT));

const PAGE_W = doc.page.width - 100; // usable width inside margins
const NAVY = "#0b2545", GOLD = "#b8860b", GREY = "#555", LIGHT = "#888";

function hr(y) { doc.moveTo(50, y).lineTo(50 + PAGE_W, y).strokeColor("#dddddd").lineWidth(1).stroke(); }

// Header
doc.fillColor(NAVY).fontSize(22).font("Helvetica-Bold").text("Karma Connect", 50, 50);
doc.fillColor(GOLD).fontSize(13).font("Helvetica").text("Anthropic API Cost Estimate", 50, 78);
doc.fillColor(LIGHT).fontSize(9).text(`Generated ${REPORT_DATE}  ·  Model: Claude Sonnet 4.6  ·  ${num(PROSPECTS_PER_MONTH)} prospects/month`, 50, 96);
hr(115);

// Assumptions
let y = 128;
doc.fillColor(NAVY).fontSize(13).font("Helvetica-Bold").text("Assumptions", 50, y);
y += 20;
doc.fillColor(GREY).fontSize(9.5).font("Helvetica");
const assumptions = [
  `Volume: ${num(PROSPECTS_PER_MONTH)} prospects per month, worked on weekdays only (~${WORKING_DAYS} working days = ~${Math.round(PROSPECTS_PER_MONTH / WORKING_DAYS)} prospects/day).`,
  "Model: Claude Sonnet 4.6 at $3.00 / 1M input tokens and $15.00 / 1M output tokens.",
  "5 message variations per engine (reduced from 10 to 5).",
  "Estimates from prompt sizes + typical output lengths; prompt caching (~5–10% input saving) is NOT applied, so figures are conservative.",
  "Each engine is generated on demand — you only pay for the ones opened. Web-search research is the largest and most variable item.",
];
for (const a of assumptions) { doc.text("•  " + a, 55, y, { width: PAGE_W - 5 }); y = doc.y + 4; }

// Per-prospect token table (typical scenario)
y += 8;
doc.fillColor(NAVY).fontSize(13).font("Helvetica-Bold").text("Per-prospect token breakdown (Typical full run)", 50, y);
y += 22;

const col = { label: 55, inT: 320, outT: 410, cost: 500 };
function row(label, a, b, c, opts = {}) {
  doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5).fillColor(opts.color || GREY);
  doc.text(label, col.label, y, { width: col.inT - col.label - 10 });
  doc.text(a, col.inT, y, { width: 80, align: "right" });
  doc.text(b, col.outT, y, { width: 80, align: "right" });
  doc.text(c, col.cost, y, { width: 50, align: "right" });
  y += 16;
}
row("Call", "Input tok", "Output tok", "Cost", { bold: true, color: NAVY });
hr(y - 2); y += 4;
const typicalKeys = SCENARIOS[1].keys;
for (const k of typicalKeys) {
  const [label, i, o] = CALLS[k];
  const c = costPerProspect({ in: i, out: o }, "Sonnet 4.6");
  row(label, num(i), num(o), money4(c));
}
const tt = sum(typicalKeys);
const ttCost = costPerProspect(tt, "Sonnet 4.6");
hr(y - 2); y += 4;
row("Total per prospect", num(tt.in), num(tt.out), money4(ttCost), { bold: true, color: NAVY });

// Scenarios table
y += 18;
doc.fillColor(NAVY).fontSize(13).font("Helvetica-Bold").text("Monthly & annual cost by usage scenario (Sonnet 4.6)", 50, y);
y += 22;
const sc = { name: 55, per: 250, month: 350, year: 460 };
function srow(name, per, month, year, opts = {}) {
  doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5).fillColor(opts.color || GREY);
  doc.text(name, sc.name, y, { width: sc.per - sc.name - 10 });
  doc.text(per, sc.per, y, { width: 90, align: "right" });
  doc.text(month, sc.month, y, { width: 95, align: "right" });
  doc.text(year, sc.year, y, { width: 85, align: "right" });
  y += 16;
}
srow("Scenario", "Per prospect", "Per month", "Per year", { bold: true, color: NAVY });
hr(y - 2); y += 4;
for (const s of SCENARIOS) {
  const toks = sum(s.keys);
  const per = costPerProspect(toks, "Sonnet 4.6");
  const highlight = s.name === "Typical (full)";
  srow(s.name, money4(per), money(per * PROSPECTS_PER_MONTH), money(per * PROSPECTS_PER_MONTH * 12), { bold: highlight, color: highlight ? GOLD : GREY });
}
y += 2;
doc.font("Helvetica-Oblique").fontSize(8).fillColor(LIGHT);
for (const s of SCENARIOS) { doc.text(`${s.name}: ${s.desc}`, 55, y, { width: PAGE_W - 5 }); y = doc.y + 2; }

// Headline box (typical)
y += 10;
const boxH = 56;
doc.roundedRect(50, y, PAGE_W, boxH, 6).fillAndStroke("#f4f1ea", "#e2d9c2");
const tMonth = ttCost * PROSPECTS_PER_MONTH;
doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11).text("Most likely (Typical full run):", 65, y + 12);
doc.fillColor(GOLD).fontSize(16).font("Helvetica-Bold")
   .text(`${money(tMonth)} / month   ·   ${money(tMonth * 12)} / year`, 65, y + 30);
y += boxH + 18;

// Haiku comparison
doc.fillColor(NAVY).fontSize(13).font("Helvetica-Bold").text("If switched to Claude Haiku 4.5 (about 1/3 the price)", 50, y);
y += 22;
srow("Scenario", "Per prospect", "Per month", "Per year", { bold: true, color: NAVY });
hr(y - 2); y += 4;
for (const s of SCENARIOS) {
  const toks = sum(s.keys);
  const per = costPerProspect(toks, "Haiku 4.5");
  srow(s.name, money4(per), money(per * PROSPECTS_PER_MONTH), money(per * PROSPECTS_PER_MONTH * 12));
}
y += 6;
doc.font("Helvetica-Oblique").fontSize(8).fillColor(LIGHT).text(
  "Haiku cuts cost ~3× but lowers output quality — best reserved for parsing/research, with Sonnet kept for the outreach copy.",
  55, y, { width: PAGE_W - 5 });

// Footnote
doc.fontSize(7.5).fillColor(LIGHT).text(
  "Estimate only. The app records exact per-call token usage to the usage table in production; query GET /api/usage after a real run for actuals.",
  50, doc.page.height - 60, { width: PAGE_W, align: "center" });

doc.end();
console.log("Wrote", OUT);
