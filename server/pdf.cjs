// PDF rendering for the API (extracted from server.js for maintainability).
// Each function sets the response headers, pipes a PDFDocument to `res`, and ends it.
const PDFDocument = require("pdfkit");

const STATUS_LABEL = { new: "New", connected: "Connected", replied: "Replied", meeting: "Meeting", won: "Won", lost: "Lost" };

// Branded export of all the user's leads (name, title/company, stage, dates) + stage summary.
function streamLeadsPdf(res, rows, preparedBy) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="karma-connect-leads.pdf"');
  const doc = new PDFDocument({ size: "A4", margin: 48 });
  doc.pipe(res);

  const NAVY = "#0b2545", GOLD = "#b8860b", GREY = "#444", LIGHT = "#888";
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;

  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(20).text("Karma Connect");
  doc.fillColor(GOLD).font("Helvetica").fontSize(12).text("Lead export");
  doc.fillColor(LIGHT).fontSize(9).text(new Date().toISOString().slice(0, 10) + "  ·  " + (preparedBy || "") + "  ·  " + rows.length + " leads");
  doc.moveDown(0.5);
  doc.moveTo(48, doc.y).lineTo(547, doc.y).strokeColor("#dddddd").lineWidth(1).stroke();
  doc.moveDown(0.4);
  const summary = ["new", "connected", "replied", "meeting", "won", "lost"].map((k) => STATUS_LABEL[k] + ": " + (counts[k] || 0)).join("    ");
  doc.fillColor(GREY).font("Helvetica").fontSize(9.5).text(summary);
  doc.moveDown(0.6);

  const COLS = [{ x: 48, w: 150, t: "Name" }, { x: 200, w: 210, t: "Title / Company" }, { x: 412, w: 70, t: "Stage" }, { x: 484, w: 63, t: "Updated" }];
  const header = () => {
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(9);
    for (const c of COLS) doc.text(c.t, c.x, doc.y, { width: c.w, continued: false });
    doc.moveDown(0.2);
    doc.moveTo(48, doc.y).lineTo(547, doc.y).strokeColor("#eeeeee").lineWidth(1).stroke();
    doc.moveDown(0.25);
  };
  header();
  doc.font("Helvetica").fontSize(9);
  for (const r of rows) {
    if (doc.y > 790) { doc.addPage(); header(); doc.font("Helvetica").fontSize(9); }
    const y = doc.y;
    doc.fillColor(GREY).text(r.label || "Untitled", COLS[0].x, y, { width: COLS[0].w, ellipsis: true, lineBreak: false });
    doc.fillColor(LIGHT).text(r.sub || "", COLS[1].x, y, { width: COLS[1].w, ellipsis: true, lineBreak: false });
    doc.fillColor(GREY).text(STATUS_LABEL[r.status] || r.status || "", COLS[2].x, y, { width: COLS[2].w, lineBreak: false });
    doc.fillColor(LIGHT).text(new Date(r.updated_at).toISOString().slice(0, 10), COLS[3].x, y, { width: COLS[3].w, lineBreak: false });
    doc.moveDown(0.55);
    doc.x = 48;
  }
  if (rows.length === 0) doc.fillColor(LIGHT).text("No leads yet.", 48);
  doc.end();
}

// One prospect's brief: details + computed fit + AI intelligence profile.
function streamProspectBriefPdf(res, payload, preparedBy) {
  const b = payload || {};
  const p = b.prospect || {};
  const a = b.analysis || {};
  const fit = b.fit || null;
  const name = [p.firstName, p.lastName].filter(Boolean).join(" ") || "Prospect";
  const fileSafe = name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "prospect";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="karma-connect-' + fileSafe + '-brief.pdf"');

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  doc.pipe(res);
  const NAVY = "#0b2545", GOLD = "#b8860b", GREY = "#333", LIGHT = "#777";
  const W = doc.page.width - 100;
  const ensure = (h) => { if (doc.y > doc.page.height - h) doc.addPage(); };
  const rule = () => { doc.moveTo(50, doc.y).lineTo(50 + W, doc.y).strokeColor("#e6e6e6").lineWidth(1).stroke(); doc.moveDown(0.4); };
  const h1 = (t) => { doc.moveDown(0.7); ensure(110); doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(13).text(t); doc.moveDown(0.15); rule(); };
  const para = (t) => { doc.fillColor(GREY).font("Helvetica").fontSize(10).text(String(t), { width: W, lineGap: 2 }); doc.moveDown(0.3); };
  const bullet = (t) => { ensure(40); doc.fillColor(GREY).font("Helvetica").fontSize(10).text("•  " + String(t), { width: W, indent: 4, lineGap: 2 }); doc.moveDown(0.12); };
  const kv = (k, v) => { if (!v || !String(v).trim()) return; ensure(30); doc.font("Helvetica-Bold").fontSize(9.5).fillColor(NAVY).text(k + ":  ", { continued: true }).font("Helvetica").fillColor(GREY).text(String(v).trim(), { width: W }); doc.moveDown(0.15); };
  const block = (k, v) => { if (!v || !String(v).trim()) return; ensure(50); doc.font("Helvetica-Bold").fontSize(9.5).fillColor(NAVY).text(k + ":"); doc.moveDown(0.1); para(v); };
  const list = (title, arr) => { if (!Array.isArray(arr) || !arr.length) return; doc.moveDown(0.2); ensure(70); doc.font("Helvetica-Bold").fontSize(10).fillColor(NAVY).text(title); doc.moveDown(0.15); arr.forEach(bullet); };

  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(19).text("Karma Connect");
  doc.fillColor(GOLD).font("Helvetica").fontSize(11.5).text("Prospect brief");
  doc.fillColor(LIGHT).fontSize(9).text(new Date().toISOString().slice(0, 10) + "  ·  prepared by " + (preparedBy || ""));
  doc.moveDown(0.7);
  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(22).text(name);
  const subline = [p.title, p.company].filter(Boolean).join("  ·  ");
  if (subline) doc.fillColor(GREY).font("Helvetica").fontSize(12).text(subline);
  if (p.location) doc.fillColor(LIGHT).font("Helvetica").fontSize(10).text(p.location);

  h1("Prospect details");
  kv("Industry", p.industry); kv("Company", p.company); kv("Website", p.website);
  kv("LinkedIn headline", p.headline);
  block("About", p.about);
  block("Experience", p.experience);
  kv("Company description", p.companyDesc);
  kv("Recent news / signals", p.news);
  kv("Mutual interests", p.mutual);
  block("Notes", p.notes);
  kv("Known pain points", p.pain); kv("Growth objectives", p.growth);
  kv("Staffing challenges", p.staffing); kv("Operational challenges", p.ops);
  block("Additional research", p.research);

  if (fit) {
    h1("Fit & opportunity (computed)");
    const fitRow = (label, d) => {
      if (!d) return; ensure(40);
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor(NAVY).text(label + " — " + (d.score || 0) + "/100  ", { continued: true })
        .font("Helvetica").fontSize(9).fillColor(LIGHT).text("(" + (d.confidence || "low") + " confidence)");
      if (d.why) { doc.font("Helvetica").fontSize(9.5).fillColor(GREY).text(d.why, { width: W }); }
      doc.moveDown(0.3);
    };
    fitRow("ICP fit", fit.icp); fitRow("Qualification", fit.qualification); fitRow("Buying readiness", fit.readiness);
    kv("Overall opportunity", (fit.overall || 0) + "/100");
  }

  const hasAnalysis = a && (a.persona || a.responsibilities || a.painPoints || a.goals || a.hooks);
  if (hasAnalysis) {
    h1("AI intelligence profile");
    block("Who they are", a.persona);
    list("Likely responsibilities", a.responsibilities);
    list("Pain points", a.painPoints);
    list("Goals they're pursuing", a.goals);
    list("Connection angles", a.hooks);
    list("Industry trends", a.trends);
    list("Sector challenges", a.challenges);
  }

  doc.moveDown(1);
  ensure(40);
  doc.fillColor(LIGHT).font("Helvetica-Oblique").fontSize(8.5).text("Generated by Karma Connect. Fit scores are computed from the entered data; the intelligence profile is AI-inferred and should be verified before outreach.", { width: W });
  doc.end();
}

module.exports = { streamLeadsPdf, streamProspectBriefPdf };
