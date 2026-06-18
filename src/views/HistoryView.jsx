// Saved-prospects list with search, pipeline-status filter, and a per-lead status picker.
// Presentational: all state + actions come in as props.
import { useState, useRef, useEffect } from "react";
import { Ic } from "../components/icons.jsx";

export const LEAD_STATUSES = [
  { v: "new", label: "New", color: "#9aa7c4" },
  { v: "connected", label: "Connected", color: "#4a86c8" },
  { v: "replied", label: "Replied", color: "#7C5CFF" },
  { v: "meeting", label: "Meeting", color: "#E7B74B" },
  { v: "won", label: "Won", color: "#52d39e" },
  { v: "lost", label: "Lost", color: "#e24a4a" },
];
const META = Object.fromEntries(LEAD_STATUSES.map((s) => [s.v, s]));

// Themed dropdown to match the dark/glass UI (a native <select> renders an unstyled
// white OS popup that can't be themed). Closes on outside-click or Escape.
function StatusPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const cur = META[value] || META.new;
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className={"statuspick" + (open ? " open" : "")} ref={ref}>
      <button type="button" className="statuspick-btn" onClick={() => setOpen((o) => !o)}
        style={{ color: cur.color, borderColor: cur.color + "66", background: cur.color + "1f" }} aria-haspopup="listbox" aria-expanded={open}>
        <span className="dot" style={{ background: cur.color }} />
        {cur.label}
        <svg className="chev" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="statuspick-menu" role="listbox">
          {LEAD_STATUSES.map((s) => (
            <button type="button" key={s.v} role="option" aria-selected={s.v === value}
              className={"statuspick-opt" + (s.v === value ? " on" : "")}
              onClick={() => { onChange(s.v); setOpen(false); }}>
              <span className="dot" style={{ background: s.color, boxShadow: "0 0 8px " + s.color }} />
              {s.label}
              {s.v === value && <span className="tick">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function HistoryView({ history, historyMore, onOpen, onDelete, onLoadMore, onGoHub, askConfirm, query, status, onSearch, onFilter, onSetStatus }) {
  return (
    <div>
      <div className="head"><div className="eyebrow">Saved prospects</div><h2>History</h2><p>Every prospect you save lands here, tied to your account. Track each lead's stage, search, open to restore everything, or remove it.</p></div>

      <div className="toprow" style={{ gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <input
          value={query}
          placeholder="Search by name or company…"
          onChange={(e) => onSearch(e.target.value)}
          style={{ flex: "1 1 220px", minWidth: 180, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, padding: "9px 12px", color: "var(--text)", fontSize: 13 }}
        />
        <div className="seg">
          <button className={status === "" ? "on" : ""} onClick={() => onFilter("")}>All</button>
          {LEAD_STATUSES.map((s) => <button key={s.v} className={status === s.v ? "on" : ""} onClick={() => onFilter(s.v)}>{s.label}</button>)}
        </div>
      </div>

      {history.length === 0 ? (
        <div className="empty">
          <div className="eic">{Ic.hist}</div>
          <h3>{query || status ? "No matching prospects" : "No saved prospects yet"}</h3>
          <p>{query || status ? "Try a different search or filter." : <>Run <b>AI Analysis</b> on a prospect and it's saved here automatically, along with everything you generate for them.</>}</p>
          {!query && !status && <button className="btn primary" onClick={onGoHub}>Go to Prospect Hub</button>}
        </div>
      ) : (
        <div className="grid2">
          {history.map((h) => {
            const m = META[h.status || "new"] || META.new;
            return (
              <div className="mcard" key={h.id}>
                <div className="mctop">
                  <span className="av" style={{ width: 30, height: 30, borderRadius: 8, background: "var(--grad)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 12, color: "#fff", fontFamily: "'Lora',serif" }}>
                    {((h.label || "?")[0] || "?").toUpperCase()}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="pn" style={{ fontSize: 14, fontWeight: 700 }}>{h.label}</div>
                    {h.sub && <div className="pr" style={{ fontSize: 11.5, color: "var(--muted)" }}>{h.sub}</div>}
                  </div>
                  <span style={{ marginLeft: "auto", fontSize: 10.5, fontWeight: 700, color: m.color, border: "1px solid " + m.color + "55", background: m.color + "1a", borderRadius: 999, padding: "2px 9px", whiteSpace: "nowrap" }}>{m.label}</span>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--faint)", display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <span>Saved {new Date(h.savedAt).toLocaleDateString()} {new Date(h.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  {h.snapshot?.analysis && <span style={{ color: "#52d39e" }}>Analysis ✓</span>}
                  {(() => { const r = h.snapshot?.results || {}; const n = Object.values(r).reduce((a, x) => a + (Array.isArray(x) ? x.length : 0), 0); return n ? <span>{n} messages</span> : null; })()}
                </div>
                <div className="mact" style={{ alignItems: "center", gap: 8 }}>
                  <label style={{ fontSize: 11, color: "var(--faint)" }}>Stage</label>
                  <StatusPicker value={h.status || "new"} onChange={(v) => onSetStatus(h.id, v)} />
                  <button className="iconbtn" onClick={() => onOpen(h)} style={{ marginLeft: "auto" }}>Open</button>
                  <button className="iconbtn" onClick={() => askConfirm({ title: "Remove from history?", message: "Remove " + (h.label || "this prospect") + " and everything saved for them. This can't be undone.", confirmLabel: "Delete", danger: true, onConfirm: () => onDelete(h.id) })}>Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {history.length > 0 && historyMore && (
        <div className="toprow" style={{ justifyContent: "center", marginTop: 18 }}>
          <button className="btn ghost sm" onClick={onLoadMore}>Load older</button>
        </div>
      )}
    </div>
  );
}
