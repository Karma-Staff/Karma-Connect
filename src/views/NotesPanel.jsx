// Notes + activity timeline for one lead. Loads on mount. No AI tokens used.
import { useState, useEffect } from "react";
import { listNotes, addNote, deleteNote } from "../lib/notes.js";

const when = (t) => {
  const d = new Date(t);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

export function NotesPanel({ prospectId }) {
  const [notes, setNotes] = useState(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    listNotes(prospectId).then((n) => { if (alive) setNotes(n); }).catch(() => { if (alive) setNotes([]); });
    return () => { alive = false; };
  }, [prospectId]);

  async function add() {
    const text = body.trim();
    if (!text) return;
    setBusy(true); setErr("");
    try {
      const n = await addNote(prospectId, text);
      setNotes((cur) => [n, ...(cur || [])]);
      setBody("");
    } catch (e) { setErr((e && e.message) || "Could not add the note."); }
    setBusy(false);
  }
  async function remove(id) {
    setNotes((cur) => cur.filter((n) => n.id !== id));
    try { await deleteNote(prospectId, id); } catch (e) { /* best-effort */ }
  }

  return (
    <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note (e.g. “left a voicemail”, “sent follow-up”)…"
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) add(); }}
          style={{ flex: 1, minHeight: 38, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 9, padding: "8px 10px", color: "var(--text)", fontSize: 12.5, resize: "vertical" }} />
        <button className="btn primary sm" onClick={add} disabled={busy || !body.trim()}>{busy ? "…" : "Add"}</button>
      </div>
      {err && <div className="err" style={{ marginTop: 8 }}>⚠ {err}</div>}

      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 7 }}>
        {notes == null && <div style={{ fontSize: 12, color: "var(--faint)" }}>Loading…</div>}
        {notes && notes.length === 0 && <div style={{ fontSize: 12, color: "var(--faint)" }}>No notes yet. Add one above, or change the stage to log activity.</div>}
        {notes && notes.map((n) => (
          <div key={n.id} style={{ display: "flex", gap: 9, alignItems: "flex-start", fontSize: 12.5 }}>
            <span style={{ width: 7, height: 7, marginTop: 5, borderRadius: "50%", flex: "0 0 auto", background: n.kind === "activity" ? "var(--steel)" : "var(--ai2)" }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: n.kind === "activity" ? "var(--muted)" : "var(--text)", fontStyle: n.kind === "activity" ? "italic" : "normal", whiteSpace: "pre-wrap" }}>{n.body}</div>
              <div style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 1 }}>{when(n.created_at)}</div>
            </div>
            {n.kind === "note" && <button className="iconbtn" onClick={() => remove(n.id)} style={{ padding: "2px 6px", fontSize: 11 }}>Delete</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
