import { useState, useEffect } from "react";

// Animated multi-stage progress indicator; advances one stage every 950ms and holds on the last.
export function Loader({ stages }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => Math.min(v + 1, stages.length - 1)), 950);
    return () => clearInterval(t);
  }, [stages]);
  return (
    <div className="loader">
      {stages.map((s, k) => (
        <div key={k} className={"lstage " + (k < i ? "done" : k === i ? "act" : "")}>
          <span className="ld">{k < i && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"><path d="M5 13l4 4L19 7" /></svg>}</span>{s}
        </div>
      ))}
    </div>
  );
}
