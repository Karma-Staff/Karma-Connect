import { useState } from "react";

// Inline "Edit" affordance under a generated message: a toggle that opens a small box where
// the user describes the change they want; on submit, onRefine(instruction) regenerates that
// one message (the AI keeps the original intent and applies the tweak). onRefine is async.
const PencilIc = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>;

export function RefineBox({ onRefine }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const t = draft.trim();
    if (!t || !onRefine) return;
    setBusy(true);
    try { await onRefine(t); setOpen(false); setDraft(""); }
    finally { setBusy(false); }
  }

  if (!open) {
    return (
      <button type="button" className="iconbtn refine-toggle" onClick={() => setOpen(true)}>
        {PencilIc} Edit
      </button>
    );
  }

  return (
    <div className="refinebox">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="What should change? e.g. make it warmer, mention their recent award, make it shorter, end with a question…"
        rows={2}
        autoFocus
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
      />
      <div className="refinerow">
        <button type="button" className="btn primary sm" onClick={submit} disabled={busy || !draft.trim()}>
          {busy ? "Refining…" : "Refine with AI"}
        </button>
        <button type="button" className="btn ghost sm" onClick={() => { setOpen(false); setDraft(""); }} disabled={busy}>Cancel</button>
        <span className="refinehint">Keeps the original intent, applies your change.</span>
      </div>
    </div>
  );
}
