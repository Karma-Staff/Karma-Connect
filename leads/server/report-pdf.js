"use strict";
/* The call report as a PDF a manager can send to somebody.
 *
 * WHY PDFKIT AND NOT A HEADLESS BROWSER: the docs PDF is rendered by
 * Playwright's Chromium, which gives beautiful print CSS — and Playwright is
 * deliberately NOT installed on the deploy (render.yaml omits optional deps,
 * because it exists for the local LinkedIn agent and would add hundreds of
 * megabytes to every build). So on the server there is no browser. pdfkit is
 * already a runtime dependency and draws straight to the response stream.
 *
 * The cost is that layout is manual: fixed column positions, explicit page
 * breaks, a footer drawn per page. That is the whole of the complexity below.
 *
 * Colours are Karma's, matching server/pdf.cjs so the two exports look like
 * they came from the same company.
 */

const PDFDocument = require("pdfkit");

const NAVY = "#0b2545", GOLD = "#b8860b", INK = "#1c2433",
      GREY = "#5f6a7d", FAINT = "#98a2b3", RULE = "#e1e5ec", ZEBRA = "#f7f8fb";

const PAGE = { size: "A4", margin: 40 };
const LEFT = 40, RIGHT = 555, WIDTH = RIGHT - LEFT;   // 515pt of usable width
const BOTTOM = 762;                                   // start a new page past this

/* Column sets per shape. Widths are absolute points and must sum to WIDTH, or
   the last column runs off the page — there is no layout engine to catch it. */
const COLUMNS = {
  summary: [
    { k: "label", t: "Person", w: 142 },
    { k: "calls", t: "Calls", w: 46, n: 1 },
    { k: "connected", t: "Connected", w: 66, n: 1 },
    { k: "rate", t: "Rate", w: 44, n: 1 },
    { k: "placed", t: "Via Zoho", w: 62, n: 1 },
    { k: "talk", t: "Talk time", w: 60, n: 1 },
    { k: "leads", t: "Leads", w: 48, n: 1 },
    { k: "days", t: "Days", w: 47, n: 1 },
  ],
  daily: [
    { k: "day", t: "Date", w: 74 },
    { k: "label", t: "Person", w: 136 },
    { k: "calls", t: "Calls", w: 48, n: 1 },
    { k: "connected", t: "Connected", w: 66, n: 1 },
    { k: "rate", t: "Rate", w: 46, n: 1 },
    { k: "talk", t: "Talk time", w: 66, n: 1 },
    { k: "leads", t: "Leads", w: 79, n: 1 },
  ],
  calls: [
    { k: "day", t: "Date", w: 60 },
    { k: "time", t: "Time", w: 38 },
    { k: "lead_name", t: "Company", w: 196 },
    { k: "city", t: "City", w: 86 },
    { k: "state", t: "State", w: 38 },
    { k: "outcome", t: "Outcome", w: 64, n: 1 },
    { k: "seconds", t: "Secs", w: 33, n: 1 },
  ],
};

const TITLES = {
  summary: "Totals per person",
  daily: "Day by day",
  calls: "Every call",
};

/* Trim a string until it fits the column, with an ellipsis.

   pdfkit's own `lineBreak: false` and `ellipsis: true` did not hold here —
   long company names wrapped onto a second line and, because rows are a fixed
   15pt tall, the overflow printed on top of the row below. Measuring and
   cutting is deterministic, and the row height stays honest. */
function fit(doc, text, width) {
  /* Collapse whitespace first. Scraped company names carry newlines — one in
     this data reads "SERVPRO of Downtown Team Nichols DBA\nNichols Enterprises
     LLC" — and a newline breaks the line however narrow the text is, which
     measuring alone will never catch. */
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (!s || doc.widthOfString(s) <= width) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.widthOfString(s.slice(0, mid) + "…") <= width) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo).trimEnd() + "…";
}

/* "Mon 29 Sep 2026" — noon UTC so the date cannot slip either side of a zone. */
const pretty = (iso) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ""))) return String(iso || "");
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB",
    { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

function streamCallReportPdf(res, d) {
  const { from, to, who, scope, shape, rows, totals, tz, filename } = d;
  const cols = COLUMNS[shape] || COLUMNS.summary;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ ...PAGE, bufferPages: true,
    info: { Title: `Karma Leads call report ${from} to ${to}`, Author: "Karma Staff" } });
  doc.pipe(res);

  /* ---------- masthead ---------- */
  doc.rect(0, 0, 595, 86).fill(NAVY);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(17)
     .text("Karma Leads", LEFT, 24);
  doc.fillColor("#c7d4e8").font("Helvetica").fontSize(10.5)
     .text("Call report  ·  " + TITLES[shape], LEFT, 46);
  doc.fillColor("#8fa6c8").fontSize(8.5)
     .text(scope, LEFT, 63, { width: 330 });
  /* The period goes top-right, the first thing anyone checks on a report that
     has been forwarded to them. */
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(10)
     .text(from === to ? pretty(from) : pretty(from) + "  –  " + pretty(to),
       RIGHT - 250, 46, { width: 250, align: "right" });
  doc.fillColor("#8fa6c8").font("Helvetica").fontSize(8)
     .text("generated " + new Date().toISOString().slice(0, 10) + "  ·  times in " + tz,
       RIGHT - 250, 63, { width: 250, align: "right" });

  doc.y = 104;

  /* ---------- the four numbers ---------- */
  if (totals) {
    const tiles = [
      ["Calls", String(totals.calls)],
      ["Connected", String(totals.connected)],
      ["Connect rate", totals.calls ? Math.round((totals.connected / totals.calls) * 100) + "%" : "—"],
      ["Talk time", totals.talk],
    ];
    const tw = WIDTH / tiles.length;
    const top = doc.y;
    tiles.forEach(([label, value], i) => {
      const x = LEFT + i * tw;
      if (i) doc.moveTo(x - 6, top + 4).lineTo(x - 6, top + 40).strokeColor(RULE).lineWidth(1).stroke();
      doc.fillColor(FAINT).font("Helvetica").fontSize(7.5)
         .text(label.toUpperCase(), x, top + 4, { width: tw - 12, characterSpacing: 0.6 });
      doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(18)
         .text(value, x, top + 16, { width: tw - 12 });
    });
    doc.y = top + 52;
  }

  /* ---------- table ---------- */
  const drawHead = () => {
    const y = doc.y;
    doc.rect(LEFT, y, WIDTH, 17).fill(NAVY);
    let x = LEFT;
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7.6);
    for (const c of cols) {
      doc.text(c.t.toUpperCase(), x + 5, y + 5.5,
        { width: c.w - 10, align: c.n ? "right" : "left", characterSpacing: 0.5, lineBreak: false });
      x += c.w;
    }
    doc.y = y + 17;
  };

  drawHead();

  let zebra = false;
  for (const r of rows) {
    if (doc.y > BOTTOM) { doc.addPage(); doc.y = 48; drawHead(); zebra = false; }
    const y = doc.y;
    if (zebra) doc.rect(LEFT, y, WIDTH, 15).fill(ZEBRA);
    zebra = !zebra;
    let x = LEFT;
    for (const c of cols) {
      const v = r[c.k] === undefined || r[c.k] === null ? "" : String(r[c.k]);
      const strong = c.k === "label" || c.k === "lead_name";
      doc.fillColor(strong ? INK : GREY)
         .font(strong ? "Helvetica-Bold" : "Helvetica")
         .fontSize(8);
      doc.text(fit(doc, v, c.w - 10), x + 5, y + 4,
        { width: c.w - 10, align: c.n ? "right" : "left", lineBreak: false });
      x += c.w;
    }
    doc.y = y + 15;
    doc.moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).strokeColor(RULE).lineWidth(0.5).stroke();
  }

  /* ---------- totals ---------- */
  if (totals && shape !== "calls") {
    if (doc.y > BOTTOM - 20) { doc.addPage(); doc.y = 48; }
    const y = doc.y + 2;
    doc.rect(LEFT, y, WIDTH, 18).fill("#eef1f7");
    let x = LEFT;
    const tr = {
      label: "TOTAL", day: "TOTAL", calls: totals.calls, connected: totals.connected,
      rate: totals.calls ? Math.round((totals.connected / totals.calls) * 100) + "%" : "",
      placed: totals.placed, talk: totals.talk, leads: totals.leads, days: "",
    };
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(8.2);
    for (const c of cols) {
      doc.text(tr[c.k] === undefined ? "" : String(tr[c.k]), x + 5, y + 5,
        { width: c.w - 10, align: c.n ? "right" : "left", lineBreak: false });
      x += c.w;
    }
    doc.y = y + 22;
  }

  if (!rows.length) {
    doc.fillColor(GREY).font("Helvetica-Oblique").fontSize(10)
       .text("No calls were recorded in this period.", LEFT, doc.y + 14, { width: WIDTH });
  }

  /* ---------- footer on every page ----------
     The caveat travels with the file. A PDF gets forwarded and read by somebody
     who never saw the screen it came from, and a connect rate without this line
     is a number that will be quoted at a customer. */
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    /* Drawing into the bottom margin makes pdfkit think the content has
       overflowed, so it helpfully starts another page — and the footer that
       caused it lands there instead of here. Two blank pages and no caveat.
       Clearing the margin for the footer pass is the documented way out. */
    doc.page.margins.bottom = 0;
    doc.moveTo(LEFT, 788).lineTo(RIGHT, 788).strokeColor(RULE).lineWidth(0.5).stroke();
    doc.fillColor(FAINT).font("Helvetica").fontSize(6.8)
       .text("Counts only calls placed through the dashboard — a call dialled from a handset or the Zoho app is not recorded."
         + (shape !== "calls" ? "  “Via Zoho” are calls Zoho's own dialler took and never reported back, so they never count as connected and the rate is a floor." : ""),
         LEFT, 795, { width: WIDTH - 60 });
    doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(7.5)
       .text(`${i + 1} / ${range.count}`, RIGHT - 58, 795, { width: 58, align: "right" });
  }

  doc.end();
}

module.exports = { streamCallReportPdf };
