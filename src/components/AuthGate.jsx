import { useState, useEffect } from "react";
import { supabase, supabaseConfigured } from "../lib/supabase.js";
import { KarmaMark } from "./icons.jsx";

const ALLOWED_DOMAIN = (import.meta.env.VITE_ALLOWED_EMAIL_DOMAIN || "").toLowerCase();

// Gates the app behind Supabase email login (magic link). If Supabase isn't configured
// (local quick dev), it renders children directly so nothing blocks local work.
export function AuthGate({ children }) {
  const [session, setSession] = useState(undefined); // undefined = still loading
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!supabase) { setSession(null); return; }
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // No Supabase configured -> run without a gate (local dev).
  if (!supabaseConfigured) return children;
  // Signed in -> show the app.
  if (session) return children;

  async function sendLink(e) {
    e.preventDefault();
    setErr("");
    const addr = email.trim().toLowerCase();
    if (!addr) { setErr("Enter your work email."); return; }
    if (ALLOWED_DOMAIN && !addr.endsWith("@" + ALLOWED_DOMAIN)) {
      setErr("Use your @" + ALLOWED_DOMAIN + " email."); return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: addr,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
      setSent(true);
    } catch (e2) {
      setErr((e2 && e2.message) || "Could not send the login link. Try again.");
    }
    setBusy(false);
  }

  const wrap = {
    minHeight: "100vh", background: "#040a24", color: "#eef2fb",
    fontFamily: "Manrope, system-ui, sans-serif", display: "flex",
    alignItems: "center", justifyContent: "center", padding: 24,
  };
  const card = {
    width: "100%", maxWidth: 380, background: "rgba(255,255,255,.04)",
    border: "1px solid rgba(74,134,200,.26)", borderRadius: 18, padding: 30,
    boxShadow: "0 24px 60px -34px rgba(0,0,0,.85)",
  };
  const input = {
    width: "100%", background: "rgba(0,0,0,.3)", border: "1px solid rgba(74,134,200,.26)",
    borderRadius: 11, padding: "12px 13px", color: "#eef2fb", fontSize: 14, outline: "none", marginBottom: 12,
  };
  const btn = {
    width: "100%", background: "#FFCF00", color: "#071855", border: "none", borderRadius: 12,
    padding: "13px 22px", fontWeight: 700, fontSize: 14, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
  };

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
          <span style={{ width: 42, height: 42, borderRadius: 12, background: "linear-gradient(150deg,#071855,#16385A)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <KarmaMark color="#fff" w={22} />
          </span>
          <div>
            <div style={{ fontFamily: "Lora, serif", fontSize: 18, fontWeight: 700 }}>Karma <b style={{ color: "#FFCF00" }}>Connect</b></div>
            <div style={{ fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase", color: "#65769e", fontWeight: 700 }}>Team sign in</div>
          </div>
        </div>

        {session === undefined ? (
          <p style={{ color: "#9aa7c4", fontSize: 14 }}>Loading…</p>
        ) : sent ? (
          <p style={{ color: "#cfe0f6", fontSize: 14, lineHeight: 1.6 }}>
            Check <b>{email}</b> for a login link. Open it on this device to continue.
          </p>
        ) : (
          <form onSubmit={sendLink}>
            <p style={{ color: "#9aa7c4", fontSize: 13.5, lineHeight: 1.6, marginBottom: 16 }}>
              Enter your work email and we'll send a one-tap login link. No password to remember.
            </p>
            <input
              style={input}
              type="email"
              autoComplete="email"
              placeholder={ALLOWED_DOMAIN ? "you@" + ALLOWED_DOMAIN : "you@company.com"}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button style={btn} type="submit" disabled={busy}>{busy ? "Sending…" : "Email me a login link"}</button>
            {err && <p style={{ color: "#ffb3b3", fontSize: 12.5, marginTop: 12 }}>{err}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
