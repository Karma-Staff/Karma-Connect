// Leads + pipeline stats reads for the dashboard, board, and export. No AI tokens used.
import { getAccessToken } from "./auth.js";

async function get(path) {
  const res = await fetch(path, { headers: { Authorization: "Bearer " + getAccessToken() } });
  if (!res.ok) throw new Error("Request failed (" + res.status + ").");
  return res.json();
}

// All leads (minimal fields), newest first — powers the board and export.
export async function getAllLeads() {
  const data = await get("/api/leads/all");
  return data.rows || [];
}

// Pipeline counts for the dashboard.
export async function getStats() {
  const data = await get("/api/stats");
  return data.stats || {};
}
