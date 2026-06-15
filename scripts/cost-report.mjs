// Generates a one-off PDF cost estimate for running Karma Connect at a given monthly volume.
// Reflects the HYBRID model setup: Haiku for parsing + company research, Sonnet for the
// intelligence profile + message generation. 3 message variations per engine.
// Usage: node scripts/cost-report.mjs [prospectsPerMonth] [out.pdf]
import PDFDocument from "pdfkit";
import fs from "node:fs";

const PROSPECTS_PER_MONTH = parseInt(process.argv[2] || "200", 10);
const OUT = process.argv[3] || "Karma-Connect-Cost-Report.pdf";
const REPORT_DATE = "2026-06-15";
const WORKING_DAYS = 22;

// Anthropic pricing, USD per 1,000,000 tokens.
const PRICE = {
  sonnet: { in: 3.0, out: 15.0, label: "Sonnet 4.6" },
  haiku:  { in: 1.0, out: 5.0,  label: "Haiku 4.5" },
};

// Per-prospect token estimates (3 variations per engine; lighter research; deeper LinkedIn).
// [label, inputTokens, outputTokens, defaultModelForHybrid]
const CALLS = {
  analysis:     ["AI Analysis",              1650, 800,  "sonnet"],
  connection:   ["Connection (3 drafts)",    2550, 360,  "sonnet"],
  relationship: ["Relationship (3 drafts)",  2650, 540,  "sonnet"],
  meeting:      ["Meeting, 1 length (3)",    2750, 780,  "sonnet"],
  followup:     ["Follow-up (5 steps)",      2800, 1400, "sonnet"],
  paste:        ["LinkedIn parse  [Haiku]",  6000, 2000, "haiku"],
  research:     ["Company research [Haiku]", 5500, 450,  "haiku"],
};

// mode: "sonnet" (all Sonnet) | "haiku" (all Haiku) | "hybrid" (per-call model)
function callCost(key, mode) {
  const [, i, o, dflt] = CALLS[key];
  const m = mode === "hybrid" ? dflt : mode;
  const p = PRICE[m];
  return (i * p.in + o * p.out) / 1_000_000;
}
const scenarioCost = (keys, mode) => keys.reduce((a, k) => a + callCost(k, mode), 0);
const sumTok = (keys) => keys.reduce((a, k) => ({ in: a.in + CALLS[k][1], out: a.out + CALLS[k][2] }), { in: 0, out: 0 });

const SCENARIOS = [
  { name: "Light", desc: "Analysis + connection + relationship only", keys: ["analysis", "connection", "relationship"] },
  { name: "Typical", desc: "Analysis + connection + relationship + 1 meeting + follow-up", keys: ["analysis", "connection", "relationship", "meeting", "followup"] },
  { name: "Full + research", desc: "Typical + LinkedIn paste parse + web-search company research", keys: ["analysis", "connection", "relationship", "meeting", "followup", "paste", "research"] },
];

const money = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money4 = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const num = (n) => n.toLocaleString("en-US");

// ── PDF ──
const doc = new PDFDocument({ size: "A4", margin: 50 });
doc.pipe(fs.createWriteStream(OUT));
const PAGE_W = doc.page.width - 100;
const NAVY = "#0b2545", GOLD = "#b8860b", GREY = "#555", LIGHT = "#888";
function hr(y) { doc.moveTo(50, y).lineTo(50 + PAGE_W, y).strokeColor("#dddddd").lineWidth(1).stroke(); }

doc.fillColor(NAVY).fontSize(22).font("Helvetica-Bold").text("Karma Connect", 50, 50);
doc.fillColor(GOLD).fontSize(13).font("Helvetica").text("Anthropic API Cost Estimate - Hybrid model", 50, 78);
doc.fillColor(LIGHT).fontSize(9).text(`Generated ${REPORT_DATE}  -  ${num(PROSPECTS_PER_MONTH)} prospects/month  -  Sonnet 4.6 + Haiku 4.5`, 50, 96);
hr(115);

let y = 128;
doc.fillColor(NAVY).fontSize(13).font("Helvetica-Bold").text("Assumptions", 50, y); y += 20;
doc.fillColor(GREY).fontSize(9.5).font("Helvetica");
const assumptions = [
  `Volume: ${num(PROSPECTS_PER_MONTH)} prospects per month, worked on weekdays only (~${WORKING_DAYS} working days = ~${Math.round(PROSPECTS_PER_MONTH / WORKING_DAYS)} prospects/day).`,
  "HYBRID model: Haiku 4.5 ($1 / $5 per 1M) for LinkedIn parsing + company research; Sonnet 4.6 ($3 / $15 per 1M) for the intelligence profile + all message generation.",
  "3 message variations per engine. Company research uses 1 web search; LinkedIn parse reads more of the profile.",
  "Estimates from prompt sizes + typical output lengths; prompt caching (~5-10% input saving) is NOT applied, so figures are conservative.",
  "Each engine runs on demand - you only pay for the ones opened. Hybrid only differs from all-Sonnet when parsing/research run (those move to Haiku).",
];
for (const a of assumptions) { doc.text("-  " + a, 55, y, { width: PAGE_W - 5 }); y = doc.y + 4; }

// Per-prospect breakdown (Full + research, to show the Haiku rows)
y += 8;
doc.fillColor(NAVY).fontSize(13).font("Helvetica-Bold").text("Per-prospect breakdown (Full + research, hybrid pricing)", 50, y); y += 22;
const col = { label: 55, inT: 300, outT: 390, cost: 480 };
function row(label, a, b, c, opts = {}) {
  doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5).fillColor(opts.color || GREY);
  doc.text(label, col.label, y, { width: col.inT - col.label - 10 });
  doc.text(a, col.inT, y, { width: 80, align: "right" });
  doc.text(b, col.outT, y, { width: 80, align: "right" });
  doc.text(c, col.cost, y, { width: 60, align: "right" });
  y += 16;
}
row("Call (model)", "Input", "Output", "Cost", { bold: true, color: NAVY });
hr(y - 2); y += 4;
const fullKeys = SCENARIOS[2].keys;
for (const k of fullKeys) {
  const [label, i, o] = CALLS[k];
  row(label, num(i), num(o), money4(callCost(k, "hybrid")));
}
const ft = sumTok(fullKeys);
hr(y - 2); y += 4;
row("Total per prospect", num(ft.in), num(ft.out), money4(scenarioCost(fullKeys, "hybrid")), { bold: true, color: NAVY });

// Monthly cost: three model strategies side by side
y += 18;
doc.fillColor(NAVY).fontSize(13).font("Helvetica-Bold").text(`Monthly cost for ${num(PROSPECTS_PER_MONTH)} prospects - by model strategy`, 50, y); y += 22;
const sc = { name: 55, sonnet: 250, hybrid: 360, haiku: 470 };
function srow(name, a, b, c, opts = {}) {
  doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5).fillColor(opts.color || GREY);
  doc.text(name, sc.name, y, { width: sc.sonnet - sc.name - 10 });
  doc.text(a, sc.sonnet, y, { width: 95, align: "right" });
  doc.text(b, sc.hybrid, y, { width: 95, align: "right" });
  doc.text(c, sc.haiku, y, { width: 80, align: "right" });
  y += 16;
}
srow("Scenario", "All Sonnet", "Hybrid", "All Haiku", { bold: true, color: NAVY });
hr(y - 2); y += 4;
for (const s of SCENARIOS) {
  const son = scenarioCost(s.keys, "sonnet") * PROSPECTS_PER_MONTH;
  const hyb = scenarioCost(s.keys, "hybrid") * PROSPECTS_PER_MONTH;
  const hai = scenarioCost(s.keys, "haiku") * PROSPECTS_PER_MONTH;
  const hl = s.name === "Typical";
  srow(s.name, money(son), money(hyb), money(hai), { bold: hl, color: hl ? GOLD : GREY });
}
y += 2;
doc.font("Helvetica-Oblique").fontSize(8).fillColor(LIGHT);
for (const s of SCENARIOS) { doc.text(`${s.name}: ${s.desc}`, 55, y, { width: PAGE_W - 5 }); y = doc.y + 2; }

// Headline box - Hybrid, typical + full
y += 10;
const boxH = 64;
doc.roundedRect(50, y, PAGE_W, boxH, 6).fillAndStroke("#f4f1ea", "#e2d9c2");
const hybTyp = scenarioCost(SCENARIOS[1].keys, "hybrid") * PROSPECTS_PER_MONTH;
const hybFull = scenarioCost(SCENARIOS[2].keys, "hybrid") * PROSPECTS_PER_MONTH;
doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11).text(`Hybrid cost for ${num(PROSPECTS_PER_MONTH)} prospects/month:`, 65, y + 12);
doc.fillColor(GOLD).fontSize(15).font("Helvetica-Bold")
   .text(`Typical: ${money(hybTyp)}/mo  (${money(hybTyp * 12)}/yr)`, 65, y + 30);
doc.fillColor(GREY).fontSize(11).font("Helvetica")
   .text(`Full + research: ${money(hybFull)}/mo  (${money(hybFull * 12)}/yr)`, 65, y + 48);
y += boxH + 16;

doc.font("Helvetica-Oblique").fontSize(8).fillColor(LIGHT).text(
  "Note: for Typical/Light, Hybrid equals All-Sonnet because no parsing/research runs - there is nothing to offload to Haiku. The hybrid saving shows up on research-heavy prospects, while keeping outreach-copy quality on Sonnet.",
  55, y, { width: PAGE_W - 5 });

doc.fontSize(7.5).fillColor(LIGHT).text(
  "Estimate only. The app records exact per-call token usage to the usage table; query GET /api/usage after real runs for actuals.",
  50, doc.y + 14, { width: PAGE_W, align: "center" });

doc.end();
console.log("Wrote", OUT, "for", PROSPECTS_PER_MONTH, "prospects/month");
