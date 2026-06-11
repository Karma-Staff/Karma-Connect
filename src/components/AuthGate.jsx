import { useState, useEffect } from "react";
import { supabase, supabaseConfigured } from "../lib/supabase.js";
import { ALLOWED_EMAILS, isAllowedEmail } from "../lib/access.js";
import { KarmaMark } from "./icons.jsx";

const LS_KEY = "kc_email";

// Front door for the app. Two modes:
//  - Supabase configured  -> real magic-link login, restricted to the allowlist (and the
//    server proxy re-checks the login token, so this is enforced for real).
//  - Supabase NOT configured (local / pre-setup) -> a soft email gate: only allowlisted
//    addresses proceed. This controls the UI; it is not hard security on its own.
export function AuthGate({ children }) {
  // Soft-gate remembered email (used when Supabase isn't set up).
  const [localEmail, setLocalEmail] = useState(() => {
    try { return localStorage.getItem(LS_KEY) || ""; } catch (e) { return ""; }
  });
  // Supabase session (used when configured). undefined = still loading.
  const [session, setSession] = useState(undefined);
  // Form state (shared by both modes).
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

  // ---- Access decisions (after all hooks, so hook order stays stable) ----
  const sessionEmail = session?.user?.email;
  if (supabaseConfigured) {
    if (session && isAllowedEmail(sessionEmail)) return children;
  } else {
    if (localEmail && isAllowedEmail(localEmail)) return children;
  }

  const onlyOne = ALLOWED_EMAILS.length === 1 ? ALLOWED_EMAILS[0] : "";

  async function handleSubmit(e) {
    e.preventDefault();
    setErr("");
    const addr = email.trim().toLowerCase();
    if (!addr) { setErr("Enter your email."); return; }
    if (!isAllowedEmail(addr)) { setErr("That email isn't on the access list."); return; }

    if (supabaseConfigured) {
      setBusy(true);
      try {
        const { error } = await supabase.auth.signInWithOtp({ email: addr, options: { emailRedirectTo: window.location.origin } });
        if (error) throw error;
        setSent(true);
      } catch (e2) {
        setErr((e2 && e2.message) || "Could not send the login link. Try again.");
      }
      setBusy(false);
    } else {
      // Soft gate: remember the allowed email and let them in.
      try { localStorage.setItem(LS_KEY, addr); } catch (e3) {}
      setLocalEmail(addr);
    }
  }

  async function signOut() {
    if (supabase) await supabase.auth.signOut();
  }

  const wrap = { minHeight: "100vh", background: "#040a24", color: "#eef2fb", fontFamily: "Manrope, system-ui, sans-serif", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 };
  const card = { width: "100%", maxWidth: 392, background: "rgba(255,255,255,.04)", border: "1px solid rgba(74,134,200,.26)", borderRadius: 18, padding: 30, boxShadow: "0 24px 60px -34px rgba(0,0,0,.85)" };
  const input = { width: "100%", background: "rgba(0,0,0,.3)", border: "1px solid rgba(74,134,200,.26)", borderRadius: 11, padding: "12px 13px", color: "#eef2fb", fontSize: 14, outline: "none", marginBottom: 12 };
  const btn = { width: "100%", background: "#FFCF00", color: "#071855", border: "none", borderRadius: 12, padding: "13px 22px", fontWeight: 700, fontSize: 14, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 };

  // Signed in via Supabase but not on the allowlist.
  const deniedSession = supabaseConfigured && session && !isAllowedEmail(sessionEmail);

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <span style={{ width: 42, height: 42, borderRadius: 12, background: "linear-gradient(150deg,#071855,#16385A)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <KarmaMark color="#fff" w={22} />
          </span>
          <div>
            <div style={{ fontFamily: "Lora, serif", fontSize: 18, fontWeight: 700 }}>Karma <b style={{ color: "#FFCF00" }}>Connect</b></div>
            <div style={{ fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase", color: "#65769e", fontWeight: 700 }}>Private access</div>
          </div>
        </div>

        {session === undefined ? (
          <p style={{ color: "#9aa7c4", fontSize: 14 }}>Loading…</p>
        ) : deniedSession ? (
          <div>
            <p style={{ color: "#ffb3b3", fontSize: 13.5, lineHeight: 1.6, marginBottom: 16 }}>
              <b>{sessionEmail}</b> isn't on the access list. Sign in with an approved account.
            </p>
            <button style={{ ...btn, background: "rgba(255,255,255,.07)", color: "#eef2fb" }} onClick={signOut}>Sign out</button>
          </div>
        ) : sent ? (
          <p style={{ color: "#cfe0f6", fontSize: 14, lineHeight: 1.6 }}>
            Check <b>{email}</b> for a login link. Open it on this device to continue.
          </p>
        ) : (
          <form onSubmit={handleSubmit}>
            <p style={{ color: "#9aa7c4", fontSize: 13.5, lineHeight: 1.6, marginBottom: 16 }}>
              {supabaseConfigured
                ? "Enter your approved work email and we'll send a one-tap login link."
                : "This workspace is private. Enter your approved email to continue."}
            </p>
            <input
              style={input}
              type="email"
              autoComplete="email"
              placeholder={onlyOne || "you@karmastaff.com"}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button style={btn} type="submit" disabled={busy}>
              {busy ? "Sending…" : supabaseConfigured ? "Email me a login link" : "Enter"}
            </button>
            {err && <p style={{ color: "#ffb3b3", fontSize: 12.5, marginTop: 12 }}>{err}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
