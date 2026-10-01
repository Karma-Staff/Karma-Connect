"use strict";
/* Settings an owner can change without a deploy (migration 013).
 *
 * Narrow on purpose: secrets stay in the environment, where a careless SELECT
 * cannot reach them. This is for decisions — "stop offering Zoho" — not for
 * credentials, and not a feature-flag system.
 *
 * Cached for a few seconds because /api/voice/config is hit on every page
 * load by every rep, and a database round trip per load to answer a question
 * that changes twice a year is waste. The window is short enough that an owner
 * flipping a switch sees it take effect before they can finish reading the
 * confirmation.
 */

const { query } = require("./db");

const TTL_MS = 10000;
let cache = null;
let cachedAt = 0;

async function all(force) {
  if (!force && cache && Date.now() - cachedAt < TTL_MS) return cache;
  try {
    const rows = (await query("SELECT key, value FROM app_settings")).rows;
    cache = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    cachedAt = Date.now();
  } catch (e) {
    /* A settings table that cannot be read must not take telephony down with
       it. Fall back to "nothing configured", which is how the app behaved
       before this existed. */
    console.warn("[karma] settings unreadable:", e.message);
    cache = cache || {};
  }
  return cache;
}

async function get(key, fallback) {
  const s = await all();
  return s[key] === undefined ? fallback : s[key];
}

async function set(key, value, who) {
  await query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), String(who || "").slice(0, 200)]);
  cache = null;                       // the next read is the new value
  return value;
}

async function describe(key) {
  return (await query(
    "SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = $1",
    [key])).rows[0] || null;
}

module.exports = { get, set, all, describe };
