// SVG icons and the Karma mark, kept together as presentational constants/components.

// Karma Staff mark — traced 1:1 from the official logo (three ascending bars + tall stem
// + the solid filled "k" wedge). viewBox/coords are the real pixel proportions.
export function KarmaMark({ color = "#fff", w = 24 }) {
  return (
    <svg width={w} height={w * (86 / 131)} viewBox="-4 -4 131 86" fill="none" aria-hidden="true">
      <g fill={color}>
        <rect x="0"  y="52" width="20" height="21" />
        <rect x="23" y="34" width="20" height="39" />
        <rect x="46" y="16" width="20" height="57" />
        <rect x="69" y="0"  width="20" height="73" />
        {/* k = two clear diagonal strokes (arm up-right, leg down-right) starting inside the
            stem so they blend with no spike; the gap between them is the notch. */}
        <path d="M84 47 L118 24 M84 47 L118 70" fill="none" stroke={color} strokeWidth="17" strokeLinecap="butt" />
      </g>
    </svg>
  );
}

// The real Karma Staff logo, cut from the supplied artwork to transparency.
// Use it where the logo is shown large and branded.
//
//   variant="mark"   the bars + k           212x128  (1.66:1)
//   variant="lockup" mark + "karma staff"   340x200  (1.70:1)
//
// WIDTH DRIVES HEIGHT. The asset it replaced was a square tile, so this used to
// render w x w; passing the real artwork through a square box would letterbox it
// to two thirds its size. `height: auto` via the attribute ratio keeps it honest.
//
// It deliberately does NOT replace KarmaMark everywhere. KarmaMark stays for two
// things a PNG cannot do: it is drawn in `currentColor` or a passed colour in the
// nav and footer, and it stays legible at 18px, where a raster mark goes soft.
const LOGO = {
  mark: { src: "/karma-mark-white.png", w: 212, h: 128 },
  lockup: { src: "/karma-lockup-white.png", w: 340, h: 200 },
};
export function KarmaIcon({ w = 64, variant = "mark", alt = "Karma Staff" }) {
  const a = LOGO[variant] || LOGO.mark;
  return (
    <img className="kicon" src={a.src} alt={alt}
      width={w} height={Math.round(w * (a.h / a.w))}
      style={{ width: w, height: "auto", display: "block" }} />
  );
}

export const Ic = {
  hub: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>,
  intel: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg>,
  conn: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/></svg>,
  rel: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
  meet: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>,
  fup: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9.7 9.7 0 0 0-6.7 2.7L3 8"/><path d="M3 3v5h5"/></svg>,
  hist: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v5h5"/><path d="M3.05 13a9 9 0 1 0 2.6-6.4L3 8"/><path d="M12 7v5l3 2"/></svg>,
  cog: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  usage: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="5" width="3" height="13"/></svg>,
  dash: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>,
  board: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/></svg>,
  team: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 4a3 3 0 0 1 0 6"/><path d="M18 14a6 6 0 0 1 3 6"/></svg>,
  send: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>,
  // the Karma Leads switcher in the sidebar — same arrows Leads uses for the trip back
  swap: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 3h5v5"/><path d="M21 3l-7 7"/><path d="M8 21H3v-5"/><path d="M3 21l7-7"/></svg>,
};

export const CopyIc = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>;
export const RegenIc = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9.7 9.7 0 0 0-6.7 2.7L3 8"/><path d="M3 3v5h5"/></svg>;
export const StarIc = (f) => <svg viewBox="0 0 24 24" fill={f ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2"><path d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z"/></svg>;
// Paper plane — the "Queue this message to send" action on a generated message card.
export const SendIc = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>;
