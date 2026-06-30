// AI usage & cost dashboard — reads the server-recorded usage table. No AI tokens used.
import { useState, useEffect } from "react";
import { getUsage } from "../lib/usage.js";

const usd = (n) => "$" + (Number(n) || 0).toFixed(2);
const num = (n) => (Number(n) || 0).toLocaleString();
const KIND_LABEL = { generate: "Message generation", research: "Company research", ai: "Analysis / other", analysis: "Analysis" };

function Stat({ label, value, sub }) {
  return (
    <div className="scorecard" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
      <div className="scl">{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: "var(--text)", fontFamily: "'Lora',serif" }}>{value}</div>
      {sub && <div className="scv">{sub}</div>}
    </div>
  );
}

export function UsageView() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    getUsage().then((d) => { if (alive) { setData(d); setLoading(false); } })
      .catch((e) => { if (alive) { setErr((e && e.message) || "Could not load usage."); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  const t = data?.totals || {};
  const m = data?.month || {};
  const byKind = data?.byKind || [];

  return (
    <div>
      <div className="head"><div className="eyebrow">Account</div><h2>Usage &amp; cost</h2><p>Your AI spend, recorded per call. Updates as you generate. Numbers are estimates from list prices.</p></div>

      {loading && <div className="panel" style={{ color: "var(--muted)" }}>Loading usage…</div>}
      {err && <div className="err">{err}</div>}

      {!loading && !err && (
        <>
          <div className="scorestrip">
            <Stat label="This month — cost" value={usd(m.cost_usd)} sub={num(m.calls) + " AI calls"} />
            <Stat label="This month — tokens" value={num((Number(m.input_tokens) || 0) + (Number(m.output_tokens) || 0))} sub="input + output" />
            <Stat label="All time — cost" value={usd(t.cost_usd)} sub={num(t.calls) + " calls total"} />
          </div>

          <div className="panel">
            <div className="sect-title">All-time breakdown by activity</div>
            {byKind.length === 0 ? (
              <p style={{ color: "var(--muted)", fontSize: 13 }}>No AI usage recorded yet.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--faint)", fontSize: 11.5 }}>
                    <th style={{ padding: "6px 0" }}>Activity</th>
                    <th style={{ padding: "6px 0" }}>Calls</th>
                    <th style={{ padding: "6px 0" }}>Tokens</th>
                    <th style={{ padding: "6px 0", textAlign: "right" }}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {byKind.map((k) => (
                    <tr key={k.kind || "?"} style={{ borderTop: "1px solid var(--border)" }}>
                      <td style={{ padding: "8px 0", color: "var(--text)" }}>{KIND_LABEL[k.kind] || k.kind || "Other"}</td>
                      <td style={{ padding: "8px 0", color: "var(--muted)" }}>{num(k.calls)}</td>
                      <td style={{ padding: "8px 0", color: "var(--muted)" }}>{num(k.tokens)}</td>
                      <td style={{ padding: "8px 0", textAlign: "right", color: "var(--text)", fontWeight: 700 }}>{usd(k.cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="hint" style={{ marginTop: 12 }}>Cached input tokens cost ~10% of fresh ones; totals already reflect that. Web research is the priciest call — skip it when you already have the company info.</div>
          </div>
        </>
      )}
    </div>
  );
}
