// Follow-up reminders dashboard: Overdue / Today / Upcoming. Zero AI tokens.
import { useState, useEffect } from "react";
import { listReminders, setReminder } from "../lib/reminders.js";
import { Ic } from "../components/icons.jsx";

const dayStr = (t) => new Date(t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
function bucketOf(t) {
  const d = new Date(t); const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startTomorrow = new Date(startToday.getTime() + 86400000);
  if (d < startToday) return "overdue";
  if (d < startTomorrow) return "today";
  return "upcoming";
}
const GROUPS = [
  { key: "overdue", label: "Overdue", color: "#e24a4a" },
  { key: "today", label: "Due today", color: "#E7B74B" },
  { key: "upcoming", label: "Upcoming", color: "#4a86c8" },
];

export function RemindersView({ onChanged }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");

  function load() {
    listReminders().then(setRows).catch((e) => setErr((e && e.message) || "Could not load reminders."));
  }
  useEffect(() => { load(); }, []);

  async function clear(id) {
    setRows((cur) => (cur || []).filter((r) => r.id !== id));
    try { await setReminder(id, null); } catch (e) { /* best-effort */ }
    if (onChanged) onChanged();
  }

  const groups = { overdue: [], today: [], upcoming: [] };
  (rows || []).forEach((r) => groups[bucketOf(r.next_action_at)].push(r));

  return (
    <div>
      <div className="head"><div className="eyebrow">Follow-ups</div><h2>Reminders</h2><p>Leads with a next-action date. Set a reminder from any lead's Notes panel in History.</p></div>

      {err && <div className="err">{err}</div>}
      {rows == null && !err && <div className="panel" style={{ color: "var(--muted)" }}>Loading…</div>}

      {rows && rows.length === 0 && (
        <div className="empty"><div className="eic">{Ic.fup}</div><h3>No reminders set</h3><p>Open a lead in History, expand Notes, and set a follow-up date — it'll appear here.</p></div>
      )}

      {rows && rows.length > 0 && GROUPS.map((g) => groups[g.key].length > 0 && (
        <div className="panel" key={g.key} style={{ marginBottom: 14 }}>
          <div className="sect-title" style={{ color: g.color }}>{g.label} <span style={{ color: "var(--faint)", fontWeight: 600 }}>· {groups[g.key].length}</span></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {groups[g.key].map((r) => (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderTop: "1px solid var(--border)" }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: g.color, flex: "0 0 auto" }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{r.label || "Untitled"}</div>
                  <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{r.sub}{r.next_action_note ? " · " + r.next_action_note : ""}</div>
                </div>
                <span style={{ fontSize: 12, color: g.color, fontWeight: 700, whiteSpace: "nowrap" }}>{dayStr(r.next_action_at)}</span>
                <button className="iconbtn" onClick={() => clear(r.id)}>Done</button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
