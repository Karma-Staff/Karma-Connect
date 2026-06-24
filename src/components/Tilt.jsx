import { useRef } from "react";

// Wrap any glass surface to give it a subtle cursor-following 3D tilt: the element rotates
// toward the pointer (parallax) and lifts slightly, then eases back on leave. Transform is
// written straight to the DOM node (no React re-render per mousemove). Honors reduced-motion.
const REDUCE = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
  : false;

export function Tilt({ max = 9, scale = 1.015, className = "", children, ...rest }) {
  const ref = useRef(null);

  function onMove(e) {
    if (REDUCE) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const rx = -(((e.clientY - r.top) / r.height) - 0.5) * 2 * max; // tilt up/down
    const ry = (((e.clientX - r.left) / r.width) - 0.5) * 2 * max;  // tilt left/right
    el.style.transform = `perspective(1100px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale(${scale})`;
  }
  function onLeave() {
    const el = ref.current;
    if (el) el.style.transform = "";
  }

  return (
    <div ref={ref} className={"tilt3d " + className} onMouseMove={onMove} onMouseLeave={onLeave} {...rest}>
      {children}
    </div>
  );
}
