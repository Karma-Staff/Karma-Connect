"use strict";
/* GET /api/voice/rc/users — the team directory: everyone on the phone
   system and everyone with a Karma Connect account, one row per person.

   READ-ONLY on purpose. Adding, editing or deleting a RingCentral user
   changes billing and who can make calls; that stays in RingCentral's own
   admin portal, where it is audited. Karma Connect access (invites, roles,
   disabling) already has its own screen — the page links to it.

   Joined by email, from:
     RingCentral   users (name, extension, status, role, time zone, language,
                   permissions), their phone numbers and devices, and live
                   presence;
     Karma Connect app role, whether they connected RingCentral here, and
                   when they last did anything in the app;
     call log      today's calls and talk time per person, from the same
                   cached day the Dashboard reads (no extra requests).

   Department and call queues are shown when RingCentral has them; this
   account has neither set today, so those come back empty rather than
   invented. */

const express = require("express");
const XLSX = require("xlsx");
const { query } = require("./db");
const { requireAdmin, isOwnerEmail } = require("./auth");
const rc = require("./ringcentral");
const dash = require("./rc-dashboard");

const router = express.Router();
const lc = (s) => String(s || "").trim().toLowerCase();

/* Per-user detail costs three requests each, so it is fetched a few at a
   time and kept for ten minutes — a directory changes on the scale of days. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function rcUsers(uid) {
  return dash.cached("dir-users", 10 * 60e3, async () => {
    const list = (await dash.rcGet(uid, "/restapi/v1.0/account/~/extension",
      { type: "User", perPage: 1000 })).records || [];
    return pool(list, 4, async (e) => {
      const base = `/restapi/v1.0/account/~/extension/${e.id}`;
      const [det, role, dev] = await Promise.all([
        dash.rcGet(uid, base).catch(() => ({})),
        dash.rcGet(uid, base + "/assigned-role").catch(() => ({})),
        dash.rcGet(uid, base + "/device").catch(() => ({})),
      ]);
      const c = e.contact || {};
      return {
        id: String(e.id), ext: e.extensionNumber || "",
        name: e.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || `x${e.extensionNumber}`,
        email: lc(c.email), department: c.department || "", status: e.status || "",
        role: (role.records || []).map((r) => r.displayName).filter(Boolean).join(", "),
        timezone: det.regionalSettings?.timezone?.name || "",
        language: det.regionalSettings?.language?.name || "",
        admin: !!(det.permissions || e.permissions)?.admin?.enabled,
        international: !!(det.permissions || e.permissions)?.internationalCalling?.enabled,
        devices: (dev.records || []).map((d) => ({ type: d.type || "", name: d.name || "", status: d.status || "" })),
        created: e.creationTime || null,
      };
    });
  });
}

async function appAccounts() {
  const { rows } = await query(`
    SELECT lower(u.email) AS email, coalesce(nullif(btrim(u.display_name), ''), u.email) AS name,
           u.disabled, u.created_at, m.role,
           nullif(btrim(v.extension), '') AS rc_ext, v.connected_at, v.last_error,
           (SELECT max(a.at) FROM activity_log a WHERE a.actor = u.email) AS last_active
      FROM app_users u
      LEFT JOIN organization_memberships m ON m.user_id = u.id
      LEFT JOIN voice_identities v ON v.user_id = u.id AND v.provider = 'ringcentral'`);
  return rows.map((r) => ({ ...r, role: isOwnerEmail(r.email) ? "owner" : (r.role || "member") }));
}

async function build(req) {
  const uid = req.user.id;
  const warnings = [];
  const tz = dash.safeTz(String(req.query.tz || ""));
  const today = (() => { const w = dash.wall(Date.now(), tz); return `${w.year}-${w.month}-${w.day}`; })();

  let users = [], pres = [], nums = [], calls = [];
  if (rc.ENABLED) {
    try {
      [users, pres, nums, calls] = await Promise.all([
        rcUsers(uid),
        dash.cached("live-presence", 4000, async () =>
          (await dash.rcGet(uid, "/restapi/v1.0/account/~/presence",
            { detailedTelephonyState: true, activeCalls: true, perPage: 1000 })).records || []).catch(() => []),
        dash.companyNumbers(uid).catch(() => []),
        dash.fetchDay(uid, today, tz, "account").catch(() => []),
      ]);
    } catch (e) {
      warnings.push(e.status === 428 ? "Connect your RingCentral account to see phone-system details."
        : "RingCentral unavailable: " + e.message);
    }
  }
  const apps = await appAccounts();

  const presById = new Map(pres.map((p) => [String(p.extension?.id || ""), p]));
  const numsByExt = new Map();
  for (const n of nums) if (n.extId) {
    if (!numsByExt.has(n.extId)) numsByExt.set(n.extId, []);
    numsByExt.get(n.extId).push({ number: n.number, usage: n.usage });
  }
  const today_ = new Map();
  for (const c of calls) {
    if (!c.extId) continue;
    const t = today_.get(c.extId) || { calls: 0, talk: 0, missed: 0 };
    t.calls++; t.talk += c.dur;
    if (c.dir === "Inbound" && !["Accepted", "Call connected"].includes(c.res)) t.missed++;
    today_.set(c.extId, t);
  }
  /* People are matched by EMAIL only. Matching by extension would merge two
     different people whenever one has connected Karma Connect's dialler
     with somebody else's RingCentral login — which is exactly the case
     worth surfacing, so it is flagged instead (`borrowedBy` / `dialsAs`). */
  const appByEmail = new Map(apps.map((a) => [a.email, a]));
  const appsByExt = new Map();
  for (const a of apps) if (a.rc_ext) {
    if (!appsByExt.has(a.rc_ext)) appsByExt.set(a.rc_ext, []);
    appsByExt.get(a.rc_ext).push(a);
  }
  const userByExt = new Map(users.map((u) => [u.ext, u]));

  const RC_STATE = { Ringing: "Ringing", CallConnected: "On call", OnHold: "On hold", ParkedCall: "On hold" };
  const seen = new Set();
  const rows = users.map((u) => {
    const app = appByEmail.get(u.email) || null;
    if (app) seen.add(app.email);
    const borrowedBy = (appsByExt.get(u.ext) || []).filter((a) => a.email !== u.email).map((a) => a.email);
    const p = presById.get(u.id);
    const agentStatus = !p ? "Unknown" : RC_STATE[p.telephonyStatus]
      || (p.presenceStatus === "Offline" ? "Offline" : p.dndStatus === "DoNotAcceptAnyCalls" ? "Do not disturb"
        : p.presenceStatus === "Busy" ? "Busy" : "Available");
    return {
      key: "rc:" + u.id, name: u.name, email: u.email || app?.email || "",
      ext: u.ext, department: u.department, status: u.status === "Enabled" ? "Active" : u.status || "—",
      rcRole: u.role, timezone: u.timezone, language: u.language,
      admin: u.admin, international: u.international, devices: u.devices,
      numbers: numsByExt.get(u.id) || [], agentStatus,
      today: today_.get(u.id) || { calls: 0, talk: 0, missed: 0 },
      app: app ? { role: app.role, disabled: app.disabled, connected: !!app.rc_ext,
        dialsAs: app.rc_ext && app.rc_ext !== u.ext ? app.rc_ext : null,
        lastActive: app.last_active, lastError: app.last_error } : null,
      borrowedBy, onRc: true, created: u.created,
    };
  });
  /* People with a Karma Connect account but no RingCentral seat still belong
     in "all the users" — they are the ones who cannot call yet. */
  for (const a of apps) {
    if (seen.has(a.email)) continue;
    rows.push({
      key: "app:" + a.email, name: a.name, email: a.email, ext: "", department: "",
      status: a.disabled ? "Disabled" : "Active", rcRole: "", timezone: "", language: "",
      admin: false, international: false, devices: [], numbers: [],
      agentStatus: a.rc_ext ? "Using another seat" : "No phone seat",
      today: { calls: 0, talk: 0, missed: 0 },
      app: { role: a.role, disabled: a.disabled, connected: !!a.rc_ext,
        /* connected the dialler, but with a login whose email is not theirs */
        dialsAs: a.rc_ext || null, dialsAsName: a.rc_ext ? userByExt.get(a.rc_ext)?.name || null : null,
        lastActive: a.last_active, lastError: a.last_error },
      borrowedBy: [], onRc: false, created: a.created_at,
    });
  }

  const f = { q: lc(req.query.q), status: String(req.query.status || "active"),
    role: String(req.query.role || ""), dept: String(req.query.dept || ""), agent: String(req.query.agent || "") };
  const kept = rows.filter((r) => {
    if (f.status === "active" && r.status !== "Active") return false;
    if (f.status === "inactive" && r.status === "Active") return false;
    if (f.role && r.rcRole !== f.role && r.app?.role !== f.role) return false;
    if (f.dept && r.department !== f.dept) return false;
    if (f.agent && r.agentStatus !== f.agent) return false;
    if (f.q && ![r.name, r.email, r.department, r.ext].some((s) => lc(s).includes(f.q))) return false;
    return true;
  }).sort((a, b) => (b.onRc - a.onRc) || (+a.ext || 1e9) - (+b.ext || 1e9) || a.name.localeCompare(b.name));

  return {
    warnings, total: kept.length, all: rows.length, rows: kept,
    options: {
      roles: [...new Set(rows.flatMap((r) => [r.rcRole, r.app?.role]).filter(Boolean))].sort(),
      departments: [...new Set(rows.map((r) => r.department).filter(Boolean))].sort(),
      agentStatuses: [...new Set(rows.map((r) => r.agentStatus))].sort(),
    },
  };
}

router.get("/api/voice/rc/users", requireAdmin, async (req, res, next) => {
  try {
    const b = await build(req);
    const format = String(req.query.format || "");
    if (format !== "csv" && format !== "xlsx") return res.json(b);

    const head = ["Name", "Email", "Extension", "Department", "Phone role", "Karma Connect role", "Status",
      "Agent status", "Number(s)", "Time zone", "Language", "International calling", "Devices",
      "Connected in Karma Connect", "Calls today", "Talk today (min)"];
    const data = b.rows.map((r) => [r.name, r.email, r.ext, r.department, r.rcRole, r.app?.role || "",
      r.status, r.agentStatus, r.numbers.map((n) => n.number).join(" / "), r.timezone, r.language,
      r.onRc ? (r.international ? "Yes" : "No") : "", r.devices.map((d) => d.type).join(" / "),
      r.app ? (r.app.connected ? "Yes" : "No") : "No account", r.today.calls, Math.round(r.today.talk / 60)]);
    const name = `users_${new Date().toISOString().slice(0, 10)}`;
    if (format === "csv") {
      const cell = (v) => {
        const s = String(v ?? "");
        const safe = /^[=@]/.test(s) || /^[+\-](?!\d+$)/.test(s) ? "'" + s : s;
        return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
      };
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`);
      return res.send("﻿" + [head, ...data].map((r) => r.map(cell).join(",")).join("\r\n"));
    }
    const ws = XLSX.utils.aoa_to_sheet([head, ...data]);
    ws["!cols"] = head.map((h) => ({ wch: Math.max(12, h.length + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Users");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.xlsx"`);
    res.send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  } catch (e) { next(e); }
});

module.exports = { router };
