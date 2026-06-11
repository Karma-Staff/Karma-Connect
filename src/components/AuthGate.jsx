import { useState, useEffect, cloneElement } from "react";
import { supabase, supabaseConfigured } from "../lib/supabase.js";
import { ALLOWED_EMAILS, isAllowedEmail } from "../lib/access.js";
import { hasPassword, setPassword as setLocalPw, verifyPassword, clearPassword } from "../lib/localpass.js";
import { KarmaMark } from "./icons.jsx";

const LS_KEY = "kc_email";

// Front door. Grants access (rendering the app with userEmail + onSignOut props) when:
//  - Supabase configured: user is signed in with email+password AND on the allowlist.
//    (The server proxy independently re-checks the login token, so this is real security.)
//  - Supabase NOT configured (local / pre-setup): a soft email gate; only allowlisted
//    addresses proceed. Controls the UI, not hard security on its own.
export function AuthGate({ children }) {
  const [localEmail, setLocalEmail] = useState(() => {
    try { return localStorage.getItem(LS_KEY) || ""; } catch (e) { return ""; }
  });
  const [session, setSession] = useState(undefined); // undefined = loading
  const [mode, setMode] = useState("signin"); // signin | signup (Supabase mode)
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!supabase) { setSession(null); return; }
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const sessionEmail = session?.user?.email;

  function grant(userEmail, onSignOut) {
    return cloneElement(children, { key: userEmail || "anon", userEmail: userEmail || "", onSignOut });
  }

  // ---- Access decisions (after hooks) ----
  if (supabaseConfigured) {
    if (session && isAllowedEmail(sessionEmail)) {
      return grant(sessionEmail, () => supabase.auth.signOut());
    }
  } else {
    if (localEmail && isAllowedEmail(localEmail)) {
      return grant(localEmail, () => { try { localStorage.removeItem(LS_KEY); } catch (e) {} setLocalEmail(""); });
    }
  }

  const onlyOne = ALLOWED_EMAILS.length === 1 ? ALLOWED_EMAILS[0] : "";
  const deniedSession = supabaseConfigured && session && !isAllowedEmail(sessionEmail);
  // In local mode, an allowlisted email with no stored password is creating one.
  const typedAddr = email.trim().toLowerCase();
  const softCreating = !supabaseConfigured && isAllowedEmail(typedAddr) && !hasPassword(typedAddr);

  function softReset() {
    if (!typedAddr) { setErr("Enter your email first."); return; }
    if (!window.confirm("Reset the password for " + typedAddr + "? You'll set a new one.")) return;
    clearPassword(typedAddr);
    setPassword(""); setPassword2(""); setErr(""); setNotice("Password cleared. Set a new one below.");
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErr(""); setNotice("");
    const addr = email.trim().toLowerCase();
    if (!addr) { setErr("Enter your email."); return; }
    if (!isAllowedEmail(addr)) { setErr("That email isn't on the access list."); return; }

    // ----- Local (no Supabase) password gate -----
    if (!supabaseConfigured) {
      setBusy(true);
      try {
        if (!hasPassword(addr)) {
          if (!password || password.length < 6) { setErr("Choose a password of at least 6 characters."); setBusy(false); return; }
          if (password !== password2) { setErr("The two passwords don't match."); setBusy(false); return; }
          await setLocalPw(addr, password);
        } else {
          const ok = await verifyPassword(addr, password);
          if (!ok) { setErr("Wrong password."); setBusy(false); return; }
        }
        try { localStorage.setItem(LS_KEY, addr); } catch (e2) {}
        setLocalEmail(addr);
      } catch (e4) {
        setErr("Could not process the password. Try again.");
      }
      setBusy(false);
      return;
    }

    // ----- Supabase password auth -----
    if (!password || password.length < 8) { setErr("Use a password of at least 8 characters."); return; }
    setBusy(true);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email: addr, password });
        if (error) throw error;
        if (!data.session) setNotice("Account created. Check your email to confirm, then sign in.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: addr, password });
        if (error) throw error;
      }
    } catch (e3) {
      setErr((e3 && e3.message) || "Could not sign in. Check your details and try again.");
    }
    setBusy(false);
  }

  const wrap = { minHeight: "100vh", background: "#040a24", color: "#eef2fb", fontFamily: "Manrope, system-ui, sans-serif", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 };
  const card = { width: "100%", maxWidth: 392, background: "rgba(255,255,255,.04)", border: "1px solid rgba(74,134,200,.26)", borderRadius: 18, padding: 30, boxShadow: "0 24px 60px -34px rgba(0,0,0,.85)" };
  const input = { width: "100%", background: "rgba(0,0,0,.3)", border: "1px solid rgba(74,134,200,.26)", borderRadius: 11, padding: "12px 13px", color: "#eef2fb", fontSize: 14, outline: "none", marginBottom: 12 };
  const btn = { width: "100%", background: "#FFCF00", color: "#071855", border: "none", borderRadius: 12, padding: "13px 22px", fontWeight: 700, fontSize: 14, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 };
  const link = { background: "none", border: "none", color: "#4a86c8", cursor: "pointer", fontSize: 12.5, fontWeight: 600, padding: 0, marginTop: 14 };

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
            <button style={{ ...btn, background: "rgba(255,255,255,.07)", color: "#eef2fb" }} onClick={() => supabase.auth.signOut()}>Sign out</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <p style={{ color: "#9aa7c4", fontSize: 13.5, lineHeight: 1.6, marginBottom: 16 }}>
              {!supabaseConfigured
                ? (softCreating ? "First time on this device, set a password for your email." : "This workspace is private. Sign in to continue.")
                : mode === "signup"
                  ? "Create your account with an approved email and a password."
                  : "Sign in to your Karma Connect account."}
            </p>
            <input style={input} type="email" autoComplete="email" placeholder={onlyOne || "you@karmastaff.com"} value={email} onChange={(e) => setEmail(e.target.value)} />
            <input style={input} type="password" autoComplete={(supabaseConfigured ? mode === "signup" : softCreating) ? "new-password" : "current-password"} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
            {((!supabaseConfigured && softCreating) || (supabaseConfigured && mode === "signup")) && (
              <input style={input} type="password" autoComplete="new-password" placeholder="Confirm password" value={password2} onChange={(e) => setPassword2(e.target.value)} />
            )}
            <button style={btn} type="submit" disabled={busy}>
              {busy ? "Working…"
                : !supabaseConfigured ? (softCreating ? "Set password & enter" : "Sign in")
                : mode === "signup" ? "Create account" : "Sign in"}
            </button>
            {err && <p style={{ color: "#ffb3b3", fontSize: 12.5, marginTop: 12 }}>{err}</p>}
            {notice && <p style={{ color: "#cfe0f6", fontSize: 12.5, marginTop: 12 }}>{notice}</p>}
            {supabaseConfigured ? (
              <button type="button" style={link} onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setErr(""); setNotice(""); }}>
                {mode === "signup" ? "Already have an account? Sign in" : "First time? Create a password"}
              </button>
            ) : (
              !softCreating && isAllowedEmail(typedAddr) && (
                <button type="button" style={link} onClick={softReset}>Forgot password? Reset it</button>
              )
            )}
          </form>
        )}
      </div>
    </div>
  );
}
