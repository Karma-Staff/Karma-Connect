"use strict";
/* The call report as a document somebody can send to somebody.
 *
 * WHY PDFKIT AND NOT A HEADLESS BROWSER: the docs PDF is rendered by
 * Playwright's Chromium, and Playwright is deliberately NOT installed on the
 * deploy — render.yaml omits optional dependencies because it exists for the
 * local LinkedIn agent and would add hundreds of megabytes to every build. So
 * there is no browser on the server. pdfkit is already a runtime dependency
 * and draws straight to the response stream.
 *
 * The cost is that everything is manual: absolute coordinates, explicit page
 * breaks, charts drawn as rectangles, a footer per page. That is the whole of
 * the length below. It is worth it here because this report is generated
 * occasionally and read carefully, which is the opposite of the dashboard.
 *
 * STRUCTURE
 *   masthead      who, what, when
 *   headline      six numbers, with the previous period for contrast
 *   activity      calls per day, connected shaded solid
 *   table         the rows, whichever shape was asked for
 *   people        a card each: their run of days and their outcome mix
 *   outcomes      how the calls ended, as proportions
 *   geography     where the calling went
 *   footer        the caveat, on every page
 */

const PDFDocument = require("pdfkit");

/* Karma's palette, matching server/pdf.cjs so the two exports look related,
   with the Leads accent from leads/public/app.css for the charts. */
const NAVY = "#0b2545", ACCENT = "#2f54eb", ACCENT_SOFT = "#dfe6fb",
      GOLD = "#b8860b", INK = "#1c2433", GREY = "#5f6a7d", FAINT = "#98a2b3",
      RULE = "#e1e5ec", ZEBRA = "#f8f9fc", GOOD = "#0a6b43", WARN = "#b0342c";

const LEFT = 40, RIGHT = 555, WIDTH = RIGHT - LEFT;   // 515pt usable
const BOTTOM = 756;                                   // break past this
const TOP = 48;                                       // top of a continuation page

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

const TITLES = { summary: "Totals per person", daily: "Day by day", calls: "Every call" };

const OUTCOME_WORDS = {
  connected: "Connected", "no-answer": "No answer", busy: "Busy",
  failed: "Failed", cancelled: "Cancelled", placed: "Handed to Zoho",
  unknown: "Not recorded",
};
const OUTCOME_COLOUR = {
  connected: GOOD, "no-answer": "#c98a00", busy: "#c98a00",
  failed: WARN, cancelled: FAINT, placed: ACCENT, unknown: FAINT,
};

/* ── small helpers ─────────────────────────────────────────────────────── */

const pretty = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ""))
  ? new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB",
      { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
  : String(iso || ""));

const shortDay = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ""))
  ? new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB",
      { day: "numeric", month: "short", timeZone: "UTC" })
  : "");

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

/* Trim a string until it fits, with an ellipsis.

   pdfkit's own lineBreak:false and ellipsis:true did not hold — long company
   names wrapped onto a second line and, because rows are a fixed height, the
   overflow printed on top of the row below. Whitespace is collapsed first
   because scraped names carry newlines, which break a line however narrow the
   text is and which measuring alone will never catch. */
function fit(doc, text, width) {
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (!s || doc.widthOfString(s) <= width) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.widthOfString(s.slice(0, mid) + "…") <= width) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo).trimEnd() + "…";
}

function sectionTitle(doc, text, sub) {
  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11)
     .text(text.toUpperCase(), LEFT, doc.y, { characterSpacing: 1.1 });
  if (sub) {
    doc.fillColor(FAINT).font("Helvetica").fontSize(8)
       .text(sub, LEFT, doc.y + 1, { width: WIDTH });
  }
  doc.moveDown(0.25);
  doc.moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).strokeColor(NAVY).lineWidth(1.2).stroke();
  doc.y += 10;
}

/* Vertical bars, one per day. Total height is the attempt; the solid part is
   what connected — height inside the bar, never a second bar beside it, so
   the two can never be read as separate quantities. */
function dayChart(doc, x, y, w, h, series, { labels = true } = {}) {
  const max = Math.max(1, ...series.map((d) => +d.calls));
  const n = series.length || 1;
  const gap = n > 40 ? 1 : 2;
  const bw = Math.max(1.5, (w - gap * (n - 1)) / n);

  /* A baseline and a max line, so a bar has something to be tall against. */
  doc.moveTo(x, y + h).lineTo(x + w, y + h).strokeColor(RULE).lineWidth(0.6).stroke();
  doc.fillColor(FAINT).font("Helvetica").fontSize(6.5)
     .text(String(max), x + w + 4, y - 2, { width: 28, lineBreak: false });

  series.forEach((d, i) => {
    const bx = x + i * (bw + gap);
    const bh = Math.max(+d.calls ? 1.2 : 0, (+d.calls / max) * h);
    if (bh) {
      doc.rect(bx, y + h - bh, bw, bh).fill(ACCENT_SOFT);
      const ch = (+d.connected / max) * h;
      if (ch > 0) doc.rect(bx, y + h - ch, bw, ch).fill(ACCENT);
    }
  });

  if (labels && n) {
    /* Label the ends and the busiest, not every day — a row of overlapping
       dates is noise, and these three are the ones anyone looks for. Where two
       of them would collide the later one wins, because "29 Sept30 Sept"
       printed on top of itself is worse than one date missing. */
    const peak = series.reduce((a, d, i) => (+d.calls > +series[a].calls ? i : a), 0);
    const marks = [...new Set([0, peak, n - 1])].sort((a, b) => a - b);
    doc.fillColor(FAINT).font("Helvetica").fontSize(6.5);
    const placed = [];
    for (const i of marks) {
      const t = shortDay(series[i].day);
      const tw = doc.widthOfString(t);
      const bx = x + i * (bw + gap);
      const at = Math.min(Math.max(x, bx + bw / 2 - tw / 2), x + w - tw);
      /* drop any earlier label this one would sit on top of */
      while (placed.length && placed[placed.length - 1].end + 4 > at) placed.pop();
      placed.push({ t, at, end: at + tw });
    }
    for (const p of placed) doc.text(p.t, p.at, y + h + 3, { lineBreak: false });
  }
  /* dayChart draws with absolute coordinates, but doc.text() still advances
     doc.y to wherever the last label landed. Put it back, or the caller adds
     its spacing on top of that and leaves a hole. */
  doc.y = y + h + (labels ? 14 : 2);
}

/* A horizontal proportion bar with a label and a count. */
function propRow(doc, x, y, w, label, n, total, colour) {
  const barX = x + 104, barW = w - 150;
  doc.fillColor(INK).font("Helvetica").fontSize(8)
     .text(fit(doc, label, 100), x, y, { width: 100, lineBreak: false });
  doc.rect(barX, y + 1.5, barW, 6).fill("#eef1f6");
  const fillW = Math.max(total ? 1 : 0, (n / (total || 1)) * barW);
  doc.rect(barX, y + 1.5, fillW, 6).fill(colour || ACCENT);
  doc.fillColor(GREY).font("Helvetica-Bold").fontSize(8)
     .text(`${n}  ${pct(n, total)}%`, barX + barW + 6, y, { width: 44, align: "right", lineBreak: false });
}

/* ── the document ──────────────────────────────────────────────────────── */

function streamCallReportPdf(res, d) {
  const { from, to, who, scope, shape, tz, totals, rows, filename,
          series = [], perPerson = [], outcomes = [], states = [],
          prev = { calls: 0 }, busiest = null, span = 0 } = d;
  const cols = COLUMNS[shape] || COLUMNS.summary;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true,
    info: { Title: `Karma Leads call report ${from} to ${to}`,
            Author: "Karma Staff", Subject: scope } });
  doc.pipe(res);

  const need = (h) => { if (doc.y + h > BOTTOM) { doc.addPage(); doc.y = TOP; } };

  /* ---------- masthead ---------- */
  doc.rect(0, 0, 595, 96).fill(NAVY);
  doc.rect(0, 94, 595, 2.5).fill(GOLD);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(18).text("Karma Leads", LEFT, 22);
  doc.fillColor("#b9c9e4").font("Helvetica").fontSize(10.5)
     .text("Call report  ·  " + (TITLES[shape] || ""), LEFT, 45);
  doc.fillColor("#8fa6c8").fontSize(8.5).text(scope, LEFT, 64, { width: 320 });
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(10.5)
     .text(from === to ? pretty(from) : pretty(from) + "   –   " + pretty(to),
       RIGHT - 270, 45, { width: 270, align: "right" });
  doc.fillColor("#8fa6c8").font("Helvetica").fontSize(7.8)
     .text(`${span} day${span === 1 ? "" : "s"}  ·  generated ${new Date().toISOString().slice(0, 10)}  ·  times in ${tz}`,
       RIGHT - 270, 64, { width: 270, align: "right" });
  doc.y = 116;

  /* ---------- headline ---------- */
  const callers = rows.filter((r) => +r.calls > 0).length;
  const tiles = [
    ["Calls", String(totals.calls), prev.calls
      ? (totals.calls >= prev.calls ? "+" : "") + (totals.calls - prev.calls) + " vs previous"
      : "no previous period"],
    ["Connected", String(totals.connected), `${pct(totals.connected, totals.calls)}% of calls`],
    ["Via Zoho", String(totals.placed || 0), "result never reported"],
    ["Leads reached", String(totals.leads || 0), "distinct companies"],
    ["Talk time", totals.talk, totals.talk === "0:00:00" ? "not reported" : "recorded"],
    /* On an individual report the rows are days, not people, so counting them
       as "people calling" says 3 of 3 and means nothing. */
    who
      ? ["Days calling", String(series.filter((x) => +x.calls > 0).length),
         `of ${span} in the period`]
      : shape === "calls"
        ? ["Rows", String(rows.length), "listed below"]
        : ["People calling", String(callers), `of ${rows.length} on the team`],
  ];
  const tw = WIDTH / tiles.length;
  const top = doc.y;
  tiles.forEach(([label, value, sub], i) => {
    const x = LEFT + i * tw;
    if (i) doc.moveTo(x - 4, top).lineTo(x - 4, top + 44).strokeColor(RULE).lineWidth(0.8).stroke();
    doc.fillColor(FAINT).font("Helvetica").fontSize(6.6)
       .text(label.toUpperCase(), x, top, { width: tw - 10, characterSpacing: 0.7, lineBreak: false });
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(16)
       .text(fit(doc, value, tw - 10), x, top + 11, { width: tw - 10, lineBreak: false });
    doc.fillColor(FAINT).font("Helvetica").fontSize(6.4)
       .text(fit(doc, sub, tw - 8), x, top + 32, { width: tw - 8, lineBreak: false });
  });
  doc.y = top + 58;

  /* ---------- activity ---------- */
  if (series.length > 1) {
    sectionTitle(doc, "Activity", busiest && busiest.calls
      ? `Busiest day ${pretty(busiest.day)} with ${busiest.calls} calls. Solid shows the share that connected.`
      : "Solid shows the share that connected.");
    dayChart(doc, LEFT, doc.y, WIDTH - 32, 74, series);
    doc.y += 10;
  }

  /* ---------- table ---------- */
  need(90);
  sectionTitle(doc, shape === "calls" ? "Every call" : "The numbers",
    shape === "summary" ? "Everyone on the team, including those who placed no calls." : null);

  const drawHead = () => {
    const y = doc.y;
    doc.rect(LEFT, y, WIDTH, 17).fill(NAVY);
    let x = LEFT;
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7.4);
    for (const c of cols) {
      doc.text(c.t.toUpperCase(), x + 5, y + 5.5,
        { width: c.w - 10, align: c.n ? "right" : "left", characterSpacing: 0.4, lineBreak: false });
      x += c.w;
    }
    doc.y = y + 17;
  };
  drawHead();

  let zebra = false;
  for (const r of rows) {
    if (doc.y > BOTTOM) { doc.addPage(); doc.y = TOP; drawHead(); zebra = false; }
    const y = doc.y;
    if (zebra) doc.rect(LEFT, y, WIDTH, 15).fill(ZEBRA);
    zebra = !zebra;
    let x = LEFT;
    for (const c of cols) {
      const strong = c.k === "label" || c.k === "lead_name";
      const quiet = shape === "summary" && !+r.calls;      // nobody calling, said softly
      doc.fillColor(quiet ? FAINT : strong ? INK : GREY)
         .font(strong && !quiet ? "Helvetica-Bold" : "Helvetica").fontSize(8);
      doc.text(fit(doc, r[c.k] == null ? "" : r[c.k], c.w - 10), x + 5, y + 4,
        { width: c.w - 10, align: c.n ? "right" : "left", lineBreak: false });
      x += c.w;
    }
    doc.y = y + 15;
    doc.moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).strokeColor(RULE).lineWidth(0.4).stroke();
  }

  if (!rows.length) {
    doc.fillColor(GREY).font("Helvetica-Oblique").fontSize(9.5)
       .text("No calls were recorded in this period.", LEFT, doc.y + 12, { width: WIDTH });
    doc.y += 30;
  }

  if (shape !== "calls" && rows.length) {
    const y = doc.y + 1;
    doc.rect(LEFT, y, WIDTH, 19).fill("#eef1f7");
    /* Only the first column is labelled, or "TOTAL TOTAL" prints across the
       date and person columns of the day-by-day shape. */
    const tr = { [cols[0].k]: "TOTAL", calls: totals.calls,
      connected: totals.connected, rate: pct(totals.connected, totals.calls) + "%",
      placed: totals.placed, talk: totals.talk, leads: totals.leads, days: "" };
    let x = LEFT;
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(8.4);
    for (const c of cols) {
      doc.text(tr[c.k] == null ? "" : String(tr[c.k]), x + 5, y + 5.5,
        { width: c.w - 10, align: c.n ? "right" : "left", lineBreak: false });
      x += c.w;
    }
    doc.y = y + 26;
  }

  /* ---------- a card per person ----------
     Only where it says something: the day-by-day table already IS per person,
     and the per-call list is about companies rather than people. */
  if (shape === "summary" && !who) {
    const byActor = new Map();
    for (const r of perPerson) {
      if (!byActor.has(r.actor)) byActor.set(r.actor, []);
      byActor.get(r.actor).push(r);
    }
    const active = rows.filter((r) => +r.calls > 0);
    if (active.length) {
      need(120);
      sectionTitle(doc, "Each person", "Their run of days over the period, and how their calls ended.");

      const CARD_W = (WIDTH - 15) / 2, CARD_H = 104;
      active.forEach((p, i) => {
        if (i % 2 === 0) need(CARD_H + 8);
        const col = i % 2;
        const x = LEFT + col * (CARD_W + 15);
        const y = doc.y;

        doc.roundedRect(x, y, CARD_W, CARD_H, 4).fillAndStroke("#fcfdff", RULE);
        doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(9.5)
           .text(fit(doc, p.label, CARD_W - 86), x + 10, y + 9, { lineBreak: false });
        doc.fillColor(FAINT).font("Helvetica").fontSize(6.6)
           .text(String(p.role || "member").toUpperCase(), x + 10, y + 21,
             { characterSpacing: 0.6, lineBreak: false });
        /* The two numbers that matter, top-right where the eye lands. */
        doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(15)
           .text(String(p.calls), x + CARD_W - 76, y + 8, { width: 66, align: "right", lineBreak: false });
        doc.fillColor(FAINT).font("Helvetica").fontSize(6.4)
           .text(`${p.connected} connected · ${p.rate || "—"}`, x + CARD_W - 110, y + 25,
             { width: 100, align: "right", lineBreak: false });

        const own = byActor.get(String(p.actor || "").toLowerCase()) || [];
        const map = new Map(own.map((o) => [o.day, o]));
        const filled = series.map((s) => map.get(s.day) || { day: s.day, calls: 0, connected: 0 });
        dayChart(doc, x + 10, y + 40, CARD_W - 46, 32, filled, { labels: false });

        doc.fillColor(GREY).font("Helvetica").fontSize(6.6)
           .text(`${p.days} day${+p.days === 1 ? "" : "s"} calling · ${p.perDay} a day · ${p.leads} companies`
             + (+p.placed ? ` · ${p.placed} via Zoho` : ""),
             x + 10, y + CARD_H - 16, { width: CARD_W - 20, lineBreak: false });

        /* Every draw inside the card moves doc.y, so it is restored at the END
           of the card, not the middle: the left card must leave the cursor on
           the row it started, or the right one lands lower and the grid walks
           diagonally down the page. */
        doc.y = (col === 1 || i === active.length - 1) ? y + CARD_H + 8 : y;
      });
      doc.y += 6;
    }
  }

  /* ---------- outcomes ---------- */
  if (outcomes.length) {
    const tot = outcomes.reduce((a, o) => a + o.n, 0);
    need(40 + outcomes.length * 13);
    sectionTitle(doc, "How the calls ended",
      "“Handed to Zoho” are dials Zoho's own dialler took and never reported back, so they never count as connected.");
    let y = doc.y;
    for (const o of outcomes) {
      propRow(doc, LEFT, y, WIDTH, OUTCOME_WORDS[o.outcome] || o.outcome, o.n, tot,
        OUTCOME_COLOUR[o.outcome] || ACCENT);
      y += 13;
    }
    doc.y = y + 10;
  }

  /* ---------- geography ---------- */
  if (states.length) {
    const tot = states.reduce((a, s) => a + s.n, 0);
    need(40 + states.length * 13);
    sectionTitle(doc, "Where the calling went", "Top states by calls placed.");
    let y = doc.y;
    for (const s of states) {
      propRow(doc, LEFT, y, WIDTH, s.state, s.n, tot, NAVY);
      y += 13;
    }
    doc.y = y + 8;
  }

  /* ---------- footer on every page ----------
     The caveat travels with the file: a PDF gets forwarded and read by
     somebody who never saw the screen it came from, and a connect rate
     without this line is a number that will be quoted at a customer. */
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    /* Drawing into the bottom margin makes pdfkit think the content has
       overflowed, so it starts another page — and the footer that caused it
       lands there instead of here. Two blank pages and no caveat. */
    doc.page.margins.bottom = 0;
    doc.moveTo(LEFT, 786).lineTo(RIGHT, 786).strokeColor(RULE).lineWidth(0.5).stroke();
    doc.fillColor(FAINT).font("Helvetica").fontSize(6.6)
       .text("Counts only calls placed through the dashboard — a call dialled from a handset or the Zoho app is not recorded. "
         + "Talk time comes from the in-page softphone, so it is blank wherever the hand-off dialler was used.",
         LEFT, 792, { width: WIDTH - 70 });
    doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(7.5)
       .text(`${i + 1} / ${range.count}`, RIGHT - 60, 792, { width: 60, align: "right" });
  }

  doc.end();
}

module.exports = { streamCallReportPdf };
