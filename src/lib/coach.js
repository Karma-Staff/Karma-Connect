// Message coach — the "learn from results" loop. Pulls the account's sent messages + outcomes,
// asks Claude to distill a short playbook of what works per message kind, saves it, and (via
// KarmaConnectAI's sysFor) injects it into future generation so the engine keeps improving.
import { callClaude } from "./claude.js";
import { SYSTEM } from "./brand.js";
import { pLearnPlaybook } from "./prompts.js";

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) throw new Error(data?.error?.message || "Request failed (" + res.status + ").");
  return data;
}

export const KINDS = ["connection", "relationship", "inmail", "meeting", "followup"];
export const KIND_LABEL = { connection: "Connection notes", relationship: "Relationship openers", inmail: "InMails", meeting: "Meeting requests", followup: "Follow-ups" };

// { connection: "…playbook text…", … }
export const getPlaybook = () => api("/api/coach/playbook").then((d) => d.playbook || {});
export const getPlaybookMeta = () => api("/api/coach/playbook").then((d) => d.meta || []);
export const getChanges = () => api("/api/coach/changes").then((d) => d.changes || []);
const getDataset = () => api("/api/coach/dataset").then((d) => d.rows || []);
const savePlaybook = (kind, playbook, sampleSize, source) => api("/api/coach/playbook", { method: "PUT", body: { kind, playbook, sampleSize, source } });

// Minimum sends of a kind before a "learn" pass is worth running.
export const MIN_SAMPLE = 3;
// How many NEW sends since the last learn should trigger an automatic re-learn of a kind.
export const AUTO_DELTA = 4;

function groupByKind(rows) {
  const byKind = {};
  for (const r of rows) { (byKind[r.kind] = byKind[r.kind] || []).push(r); }
  return byKind;
}

// Only DECIDED leads teach the coach: 'won' (replied/booked) vs 'lost' (ghosted/rejected).
// 'pending' leads (too new to have responded) are ignored so they don't dilute the signal.
const decidedCount = (list) => list.filter((r) => r.outcome === "won" || r.outcome === "lost").length;

// Distill and save the playbook for ONE kind. Compares what LANDED against what got GHOSTED.
// source ('auto' | 'manual') is recorded in the change log.
async function distillKind(kind, list, source) {
  const winners = list.filter((r) => r.outcome === "won").map((r) => r.message);
  const ghosted = list.filter((r) => r.outcome === "lost").map((r) => r.message);
  const sample = winners.length + ghosted.length;
  try {
    const text = await callClaude(SYSTEM, pLearnPlaybook(kind, winners, ghosted), false, 600);
    const playbook = (text || "").trim();
    if (!playbook) return { kind, status: "error", sampleSize: sample };
    await savePlaybook(kind, playbook, sample, source);
    return { kind, status: "learned", sampleSize: sample, playbook };
  } catch (e) {
    return { kind, status: "error", sampleSize: sample, error: e.message };
  }
}

// Manual full pass over every eligible kind. Returns per-kind summaries.
export async function learnFromResults(onProgress) {
  const byKind = groupByKind(await getDataset());
  const results = [];
  for (const kind of KINDS) {
    const list = byKind[kind] || [];
    const decided = decidedCount(list);
    if (decided < MIN_SAMPLE) { results.push({ kind, status: "skipped", sampleSize: decided }); continue; }
    if (onProgress) onProgress(kind);
    results.push(await distillKind(kind, list, "manual"));
  }
  return results;
}

// AUTOMATIC self-improvement. Cheap when nothing changed (two GETs, no model call). Only
// re-learns a kind once it has crossed MIN_SAMPLE and grown by AUTO_DELTA new sends since the
// playbook it produced. Call on load / after outcomes change; runs silently in the background.
export async function maybeAutoLearn(onProgress) {
  let rows, meta;
  try { [rows, meta] = await Promise.all([getDataset(), getPlaybookMeta()]); }
  catch (e) { return []; } // not signed in / offline → skip quietly
  const byKind = groupByKind(rows);
  const prev = {};
  for (const m of meta) prev[m.kind] = m.sample_size || 0;

  const due = KINDS.filter((k) => {
    const cur = decidedCount(byKind[k] || []); // count only decided (won/ghosted) outcomes
    if (cur < MIN_SAMPLE) return false;
    const was = prev[k] || 0;
    return was === 0 ? true : cur - was >= AUTO_DELTA;
  });

  const updated = [];
  for (const kind of due) {
    if (onProgress) onProgress(kind);
    const r = await distillKind(kind, byKind[kind], "auto");
    if (r.status === "learned") updated.push(r);
  }
  return updated;
}
