// Saved-prospects list. Presentational: all state + actions come in as props.
import { Ic } from "../components/icons.jsx";

export function HistoryView({ history, historyMore, onOpen, onDelete, onLoadMore, onGoHub, askConfirm }) {
  return (
    <div>
      <div className="head"><div className="eyebrow">Saved prospects</div><h2>History</h2><p>Every prospect you save lands here, tied to your account. Open one to restore the full prospect, analysis, and generated messages, or remove it.</p></div>
      {history.length === 0 ? (
        <div className="empty">
          <div className="eic">{Ic.hist}</div>
          <h3>No saved prospects yet</h3>
          <p>Run <b>AI Analysis</b> on a prospect and it's saved here automatically, along with everything you generate for them.</p>
          <button className="btn primary" onClick={onGoHub}>Go to Prospect Hub</button>
        </div>
      ) : (
        <div className="grid2">
          {history.map((h) => (
            <div className="mcard" key={h.id}>
              <div className="mctop">
                <span className="av" style={{ width: 30, height: 30, borderRadius: 8, background: "var(--grad)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 12, color: "#fff", fontFamily: "'Lora',serif" }}>
                  {((h.label || "?")[0] || "?").toUpperCase()}
                </span>
                <div>
                  <div className="pn" style={{ fontSize: 14, fontWeight: 700 }}>{h.label}</div>
                  {h.sub && <div className="pr" style={{ fontSize: 11.5, color: "var(--muted)" }}>{h.sub}</div>}
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--faint)", display: "flex", gap: 12, flexWrap: "wrap" }}>
                <span>Saved {new Date(h.savedAt).toLocaleDateString()} {new Date(h.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                {h.snapshot?.analysis && <span style={{ color: "#52d39e" }}>Analysis ✓</span>}
                {(() => { const r = h.snapshot?.results || {}; const n = Object.values(r).reduce((a, x) => a + (Array.isArray(x) ? x.length : 0), 0); return n ? <span>{n} messages</span> : null; })()}
              </div>
              <div className="mact">
                <button className="iconbtn" onClick={() => onOpen(h)}>Open</button>
                <button className="iconbtn" onClick={() => askConfirm({ title: "Remove from history?", message: "Remove " + (h.label || "this prospect") + " and everything saved for them. This can't be undone.", confirmLabel: "Delete", danger: true, onConfirm: () => onDelete(h.id) })} style={{ marginLeft: "auto" }}>Delete</button>
              </div>
            </div>
          ))}
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
