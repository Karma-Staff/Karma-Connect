import { useState, useRef, useEffect } from "react";

// A fully-styled dropdown to replace the native <select> (whose option list can't be themed).
// options: [{ value, label, ...extra }]. renderOption(o) customizes each row + the trigger.
// Accessible: button + listbox roles, closes on outside-click / Escape, arrow-key navigation.
const Chevron = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><path d="M6 9l6 6 6-6" /></svg>
);

const REDUCE = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
  : false;

// Cursor-following 3D tilt for one option row (written straight to the node, no re-render).
function optMove(e) {
  if (REDUCE) return;
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const rx = -(((e.clientY - r.top) / r.height) - 0.5) * 2 * 7;
  const ry = (((e.clientX - r.left) / r.width) - 0.5) * 2 * 7;
  el.style.transform = `perspective(500px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateZ(8px)`;
}
function optLeave(e) { e.currentTarget.style.transform = ""; }

export function Dropdown({ value, onChange, options = [], placeholder = "Select…", renderOption, id }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef(null);
  const selected = options.find((o) => o.value === value) || null;
  const draw = (o) => (renderOption ? renderOption(o) : o.label);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => {
      if (e.key === "Escape") { setOpen(false); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
      if (e.key === "Enter") { e.preventDefault(); const o = options[active]; if (o) { onChange(o.value); setOpen(false); } }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active, options, value]);

  return (
    <div className="kcdd" ref={ref}>
      <button type="button" id={id} className={"kcdd-trigger" + (open ? " open" : "")} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="kcdd-val">{selected ? draw(selected) : <span className="kcdd-ph">{placeholder}</span>}</span>
        <span className={"kcdd-chev" + (open ? " up" : "")}>{Chevron}</span>
      </button>
      {open && (
        <ul className="kcdd-menu" role="listbox">
          {options.map((o, i) => (
            <li key={o.value} role="option" aria-selected={o.value === value}
              className={"kcdd-opt" + (o.value === value ? " sel" : "") + (i === active ? " active" : "")}
              onMouseEnter={() => setActive(i)}
              onMouseMove={optMove}
              onMouseLeave={optLeave}
              onClick={() => { onChange(o.value); setOpen(false); }}>
              {draw(o)}
              {o.value === value && <span className="kcdd-check" aria-hidden="true">✓</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
