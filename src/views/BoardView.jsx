// Pipeline board: a column per stage with drag-and-drop to re-stage a lead. Zero AI tokens.
import { useState, useEffect } from "react";
import { getAllLeads } from "../lib/leads.js";
import { LEAD_STATUSES } from "./HistoryView.jsx";

export function BoardView({ onSetStatus }) {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [dragId, setDragId] = useState(null);
  const [over, setOver] = useState("");

  useEffect(() => {
    let alive = true;
    getAllLeads().then((rows) => { if (alive) { setLeads(rows); setLoading(false); } })
      .catch((e) => { if (alive) { setErr((e && e.message) || "Could not load the board."); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  function drop(status) {
    const id = dragId;
    setOver(""); setDragId(null);
    if (!id) return;
    const lead = leads.find((l) => l.id === id);
    if (!lead || lead.status === status) return;
    setLeads((cur) => cur.map((l) => (l.id === id ? { ...l, status } : l))); // optimistic
    if (onSetStatus) onSetStatus(id, status); // persist + keep History in sync
  }

  return (
    <div>
      <div className="head"><div className="eyebrow">Pipeline</div><h2>Board</h2><p>Drag a lead between stages to update it. Mirrors the status you set anywhere else.</p></div>

      {loading && <div className="panel" style={{ color: "var(--muted)" }}>Loading board…</div>}
      {err && <div className="err">⚠ {err}</div>}

      {!loading && !err && (
        <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 8 }}>
          {LEAD_STATUSES.map((st) => {
            const items = leads.filter((l) => (l.status || "new") === st.v);
            return (
              <div key={st.v}
                onDragOver={(e) => { e.preventDefault(); setOver(st.v); }}
                onDragLeave={() => setOver((o) => (o === st.v ? "" : o))}
                onDrop={() => drop(st.v)}
                style={{ flex: "0 0 220px", minWidth: 220, background: over === st.v ? st.color + "14" : "var(--panel)", border: "1px solid " + (over === st.v ? st.color + "88" : "var(--border)"), borderRadius: 14, padding: 10, transition: "background .15s, border-color .15s" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 4px 10px" }}>
                  <span style={{ width: 9, height: 9, borderRadius: "50%", background: st.color, boxShadow: "0 0 8px " + st.color }} />
                  <span style={{ fontWeight: 700, fontSize: 13, color: "var(--text)" }}>{st.label}</span>
                  <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--faint)", fontWeight: 700 }}>{items.length}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 40 }}>
                  {items.map((l) => (
                    <div key={l.id} draggable
                      onDragStart={() => setDragId(l.id)}
                      onDragEnd={() => { setDragId(null); setOver(""); }}
                      style={{ cursor: "grab", background: "var(--panel2)", border: "1px solid var(--border)", borderLeft: "3px solid " + st.color, borderRadius: 10, padding: "9px 11px", opacity: dragId === l.id ? 0.5 : 1 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.label || "Untitled"}</div>
                      {l.sub && <div style={{ fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.sub}</div>}
                    </div>
                  ))}
                  {items.length === 0 && <div style={{ fontSize: 11.5, color: "var(--faint)", padding: "10px 4px", textAlign: "center" }}>Drop here</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
