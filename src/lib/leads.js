// Leads + pipeline stats reads for the dashboard, board, and export. No AI tokens used.

async function get(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error("Request failed (" + res.status + ").");
  return res.json();
}

// All leads (minimal fields), newest first — powers the board and export.
export async function getAllLeads() {
  const data = await get("/api/connect/leads/all");
  return data.rows || [];
}

// Pipeline counts for the dashboard.
export async function getStats() {
  const data = await get("/api/stats");
  return data.stats || {};
}

// Branded PDF of all leads (generated server-side). Returns a Blob.
export async function getLeadsPdf() {
  const res = await fetch("/api/connect/leads/export.pdf");
  if (!res.ok) throw new Error("Could not generate the PDF.");
  return res.blob();
}

// One prospect's brief (details + fit + AI analysis) as a PDF. Returns a Blob.
export async function getProspectBriefPdf(payload) {
  const res = await fetch("/api/connect/leads/brief.pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) throw new Error("Could not generate the PDF.");
  return res.blob();
}
