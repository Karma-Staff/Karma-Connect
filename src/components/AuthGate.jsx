import { useState, useEffect, cloneElement } from "react";
import { signIn, signUp, signOut, currentUser, onAuthChange, refreshUser, authAvailable, resendVerification } from "../lib/auth.js";
import { hasPassword, setPassword as setLocalPw, verifyPassword, clearPassword } from "../lib/localpass.js";
import { KarmaMark } from "./icons.jsx";

const LS_KEY = "kc_email";
const EMAIL_RE = /\S+@\S+\.\S+/;

const AUTH_CSS = `
.kcauth{position:fixed; inset:0; overflow:hidden; display:flex; align-items:center; justify-content:center; padding:28px;
  color:#eef2fb; letter-spacing:-.01em;
  font-family:'Inter',ui-sans-serif,system-ui,-apple-system,'SF Pro Display','Segoe UI',sans-serif;
  background:
    radial-gradient(1100px 760px at 78% 16%, rgba(124,92,255,.18), transparent 55%),
    radial-gradient(900px 680px at 8% 92%, rgba(231,183,75,.11), transparent 55%),
    radial-gradient(700px 600px at 50% 50%, rgba(74,134,200,.06), transparent 60%),
    linear-gradient(160deg, #071426 0%, #081B38 46%, #020B1C 100%);}
.kcauth *{box-sizing:border-box}
.kcauth .net{position:absolute; inset:0; pointer-events:none; opacity:.5}
.kcauth .pdot{position:absolute; width:4px; height:4px; border-radius:50%; background:rgba(160,140,255,.8); box-shadow:0 0 10px rgba(124,92,255,.9); animation:kcfloat 7s ease-in-out infinite}
.kcauth .pdot.g{background:rgba(231,183,75,.85); box-shadow:0 0 10px rgba(231,183,75,.9)}
@keyframes kcfloat{0%,100%{transform:translateY(-6px); opacity:.5}50%{transform:translateY(8px); opacity:1}}
.kcauth .center{position:relative; z-index:2; width:100%; max-width:540px; animation:kcrise .6s cubic-bezier(.22,1,.36,1) both}
@keyframes kcrise{from{opacity:0; transform:translateY(16px)}to{opacity:1; transform:none}}
.kcauth .brand{text-align:center; margin-bottom:26px}
.kcauth .brand .mk{width:62px; height:62px; margin:0 auto 16px; border-radius:18px; display:flex; align-items:center; justify-content:center;
  background:linear-gradient(150deg,#0a1c44,#16385A); border:1px solid rgba(124,92,255,.3);
  box-shadow:0 18px 50px -18px rgba(124,92,255,.6), inset 0 1px 0 rgba(255,255,255,.16)}
.kcauth .brand h1{font-size:27px; font-weight:700; letter-spacing:-.02em}
.kcauth .brand h1 b{background:linear-gradient(135deg,#FFD83A,#E7B74B); -webkit-background-clip:text; background-clip:text; color:transparent; font-weight:700}
.kcauth .brand p{margin-top:7px; font-size:13px; font-weight:500; color:#8fa0c4; letter-spacing:.04em}
.kcauth .card{position:relative; padding:34px 36px; border-radius:20px;
  background:linear-gradient(150deg, rgba(255,255,255,.07), rgba(255,255,255,.02) 42%, rgba(255,255,255,.012) 100%);
  border:1px solid rgba(140,160,220,.18);
  backdrop-filter:blur(26px) saturate(1.4); -webkit-backdrop-filter:blur(26px) saturate(1.4);
  box-shadow:0 40px 90px -42px rgba(0,0,0,.9), 0 0 0 1px rgba(124,92,255,.06), inset 0 1px 0 rgba(255,255,255,.14)}
.kcauth .card:before{content:""; position:absolute; inset:-1px; border-radius:20px; pointer-events:none;
  background:linear-gradient(135deg, rgba(124,92,255,.35), transparent 30%, transparent 70%, rgba(231,183,75,.22)); -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite:xor; mask-composite:exclude; padding:1px}
.kcauth h2{font-size:24px; font-weight:700; text-align:center; letter-spacing:-.02em}
.kcauth .sub{text-align:center; color:#9aa7c4; font-size:13.5px; margin-top:8px; margin-bottom:24px; line-height:1.5}
.kcauth label{display:block; font-size:12px; font-weight:600; color:#aeb9d6; margin:0 0 7px 2px}
.kcauth .field{position:relative; margin-bottom:15px}
.kcauth .field .ic{position:absolute; left:14px; top:50%; transform:translateY(-50%); color:#5f72a0; display:flex; pointer-events:none}
.kcauth .field .ic svg{width:17px; height:17px}
.kcauth .field input{width:100%; height:48px; padding:0 44px 0 42px; border-radius:13px; font-size:14px; color:#eef2fb; outline:none;
  background:rgba(3,9,22,.55); border:1px solid rgba(140,160,220,.18); transition:border .18s, box-shadow .18s, background .18s; font-family:inherit}
.kcauth .field input::placeholder{color:#4d5d84}
.kcauth .field input:focus{border-color:rgba(124,92,255,.6); background:rgba(3,9,22,.7); box-shadow:0 0 0 4px rgba(124,92,255,.16)}
.kcauth .field .eye{position:absolute; right:10px; top:50%; transform:translateY(-50%); background:none; border:none; color:#5f72a0; cursor:pointer; padding:6px; display:flex; border-radius:8px}
.kcauth .field .eye:hover{color:#cfe0f6}
.kcauth .row2{display:grid; grid-template-columns:1fr 1fr; gap:12px}
.kcauth .util{display:flex; align-items:center; justify-content:space-between; margin:4px 0 20px; font-size:12.5px}
.kcauth .util .rm{display:flex; align-items:center; gap:8px; color:#aeb9d6; cursor:pointer; user-select:none}
.kcauth .util .rm .box{width:17px; height:17px; border-radius:6px; border:1px solid rgba(140,160,220,.4); background:rgba(3,9,22,.5); display:flex; align-items:center; justify-content:center; color:#071226}
.kcauth .util .rm .box.on{background:linear-gradient(135deg,#FFD83A,#E7B74B); border-color:transparent}
.kcauth .util .lk{background:none; border:none; color:#9b7cff; cursor:pointer; font-weight:600; font-size:12.5px; font-family:inherit; padding:0}
.kcauth .util .lk:hover{color:#b8a3ff}
.kcauth .cta{width:100%; height:50px; border:none; border-radius:13px; cursor:pointer; font-family:inherit; font-weight:700; font-size:14.5px; color:#071226;
  background:linear-gradient(135deg,#FFD83A 0%,#FFCF00 45%,#E7B74B 100%);
  box-shadow:0 18px 40px -16px rgba(231,183,75,.7), inset 0 1px 0 rgba(255,255,255,.5); transition:transform .22s ease, box-shadow .22s ease; letter-spacing:-.01em}
.kcauth .cta:hover:not(:disabled){transform:translateY(-2px); box-shadow:0 26px 54px -14px rgba(231,183,75,.92), inset 0 1px 0 rgba(255,255,255,.6)}
.kcauth .cta:disabled{opacity:.6; cursor:default}
.kcauth .msg{font-size:12.5px; margin-top:14px; line-height:1.5}
.kcauth .msg.err{color:#ffb3b3}
.kcauth .msg.ok{color:#bfe6ff}
.kcauth .foot{text-align:center; margin-top:22px; padding-top:20px; border-top:1px solid rgba(140,160,220,.14); font-size:13px; color:#9aa7c4}
.kcauth .foot .lk{background:none; border:none; cursor:pointer; font-family:inherit; font-size:13px; font-weight:700; padding:0;
  background:linear-gradient(135deg,#FFD83A,#E7B74B); -webkit-background-clip:text; background-clip:text; color:transparent}
.kcauth :focus-visible{outline:2px solid rgba(155,124,255,.7); outline-offset:2px}
@media(max-width:560px){ .kcauth .card{padding:28px 22px} .kcauth .row2{grid-template-columns:1fr} }
`;

function I({ d, c }) { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{c || <path d={d} />}</svg>; }
const MailIc = <I c={<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>} />;
const LockIc = <I c={<><rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>} />;
const UserIc = <I c={<><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>} />;
const EyeIc = <I c={<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>} />;
const EyeOffIc = <I c={<><path d="M3 3l18 18" /><path d="M10.6 10.6a3 3 0 0 0 4.2 4.2" /><path d="M9.9 5.2A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.8 17.8 0 0 1-3.3 4.1M6.6 6.6A17.6 17.6 0 0 0 2 12s3.5 7 10 7a10.3 10.3 0 0 0 3.4-.6" /></>} />;
const CheckIc = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"><path d="M5 13l4 4L19 7" /></svg>;

// Decorative background: particles + a faint intelligence-network.
function Backdrop() {
  const dots = [[12, 18], [86, 12, "g"], [22, 78], [70, 84, "g"], [50, 8], [92, 60], [6, 50], [40, 92], [78, 38]];
  return (
    <>
      <svg className="net" viewBox="0 0 100 100" preserveAspectRatio="none">
        <g stroke="rgba(124,92,255,.22)" strokeWidth=".15" fill="none">
          <path d="M12 18 L50 8 L86 12 M50 8 L40 40 L22 78 M40 40 L70 50 L92 60 M70 50 L78 84 M40 40 L6 50" />
        </g>
        <g fill="rgba(124,92,255,.5)">
          {[[12, 18], [50, 8], [86, 12], [40, 40], [22, 78], [70, 50], [92, 60], [78, 84], [6, 50]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r=".5" />)}
        </g>
      </svg>
      {dots.map(([l, t, g], i) => <span key={i} className={"pdot" + (g ? " g" : "")} style={{ left: l + "%", top: t + "%", animationDelay: (i * 0.7) + "s" }} />)}
    </>
  );
}

// Front door. Open sign-up: anyone can create an account. Data stays per-account
// (server-side, scoped by user_id) when a database is configured, or per-browser otherwise.
export function AuthGate({ children }) {
  const [localEmail, setLocalEmail] = useState(() => { try { return localStorage.getItem(LS_KEY) || ""; } catch (e) { return ""; } });
  // authMode: undefined (probing) | "remote" (DB-backed accounts) | "local" (per-browser fallback)
  const [authMode, setAuthMode] = useState(undefined);
  const [session, setSession] = useState(() => currentUser()); // the signed-in user object, or null
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [remember, setRemember] = useState(true);
  const [showPw, setShowPw] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showResend, setShowResend] = useState(false);

  // After the email-confirmation link redirects back with ?verified=1 / ?verified=0.
  useEffect(() => {
    let v;
    try { v = new URLSearchParams(window.location.search).get("verified"); } catch (e) { return; }
    if (v == null) return;
    if (v === "1") setNotice("Email confirmed. You can sign in now.");
    else { setErr("That confirmation link is invalid or has expired. Sign in to get a new one."); setShowResend(true); }
    try { window.history.replaceState({}, "", window.location.pathname); } catch (e) {}
  }, []);

  useEffect(() => {
    let active = true;
    const unsub = onAuthChange((u) => { if (active) setSession(u); });
    authAvailable().then(async (ok) => {
      if (!active) return;
      setAuthMode(ok ? "remote" : "local");
      if (ok) { await refreshUser(); if (active) setSession(currentUser()); }
    });
    return () => { active = false; unsub(); };
  }, []);

  const remote = authMode === "remote";
  const sessionEmail = session?.email;
  function grant(userEmail, onSignOut) {
    return cloneElement(children, { key: userEmail || "anon", userEmail: userEmail || "", onSignOut });
  }
  if (remote) {
    if (session) return grant(sessionEmail, () => signOut());
  } else if (authMode === "local" && localEmail) {
    return grant(localEmail, () => { try { localStorage.removeItem(LS_KEY); } catch (e) {} setLocalEmail(""); });
  }

  const typedAddr = email.trim().toLowerCase();
  const softCreating = !remote && EMAIL_RE.test(typedAddr) && !hasPassword(typedAddr);
  const creating = remote ? mode === "signup" : softCreating;

  async function handleSubmit(e) {
    e.preventDefault();
    setErr(""); setNotice("");
    const addr = email.trim().toLowerCase();
    if (!addr) { setErr("Enter your email."); return; }
    if (!EMAIL_RE.test(addr)) { setErr("Enter a valid email address."); return; }

    if (!remote) {
      setBusy(true);
      try {
        if (!hasPassword(addr)) {
          if (!password || password.length < 6) { setErr("Choose a password of at least 6 characters."); setBusy(false); return; }
          if (password !== password2) { setErr("The two passwords don't match."); setBusy(false); return; }
          await setLocalPw(addr, password);
        } else {
          if (!(await verifyPassword(addr, password))) { setErr("Wrong password."); setBusy(false); return; }
        }
        try { localStorage.setItem(LS_KEY, addr); } catch (e2) {}
        setLocalEmail(addr);
      } catch (e4) { setErr("Could not process the password. Try again."); }
      setBusy(false);
      return;
    }

    if (!password || password.length < 8) { setErr("Use a password of at least 8 characters."); return; }
    if (mode === "signup" && password !== password2) { setErr("The two passwords don't match."); return; }
    setBusy(true);
    try {
      if (mode === "signup") {
        const r = await signUp({ email: addr, password, firstName: firstName.trim(), lastName: lastName.trim() });
        if (r && r.needsVerification) {
          // Email confirmation required — don't log in; prompt them to check their inbox.
          setNotice(r.message || "Account created. Check your email for a confirmation link, then sign in.");
          setMode("signin"); setPassword(""); setPassword2(""); setShowResend(true);
        }
        // else: verification off → signUp logged us in; onAuthChange flips the gate.
      } else {
        await signIn({ email: addr, password });
        // onAuthChange updates `session`, which flips the gate to the app.
      }
    } catch (e3) {
      const msg = (e3 && e3.message) || "Could not sign in. Check your details and try again.";
      setErr(msg);
      if (/confirm your email/i.test(msg)) setShowResend(true);
    }
    setBusy(false);
  }

  async function resend() {
    setErr(""); setNotice("");
    const addr = email.trim().toLowerCase();
    if (!EMAIL_RE.test(addr)) { setErr("Enter your email first, then tap Resend."); return; }
    setBusy(true);
    try {
      const r = await resendVerification(addr);
      setNotice((r && r.message) || "If that account exists and is unconfirmed, a new confirmation email is on its way.");
    } catch (e) { setErr("Could not resend right now. Try again in a moment."); }
    setBusy(false);
  }

  async function forgot() {
    setErr(""); setNotice("");
    const addr = email.trim().toLowerCase();
    if (!remote) {
      if (!EMAIL_RE.test(addr)) { setErr("Enter your email first."); return; }
      if (!window.confirm("Reset the password for " + addr + "? You'll set a new one.")) return;
      clearPassword(addr); setPassword(""); setPassword2(""); setNotice("Password cleared. Set a new one below.");
      return;
    }
    setNotice("Password reset isn't enabled yet — contact your administrator to reset it.");
  }

  if (authMode === undefined) {
    return <div className="kcauth"><style>{AUTH_CSS}</style><p style={{ color: "#9aa7c4" }}>Loading…</p></div>;
  }

  return (
    <div className="kcauth">
      <style>{AUTH_CSS}</style>
      <Backdrop />
      <div className="center">
        <div className="brand">
          <div className="mk"><KarmaMark color="#fff" w={28} /></div>
          <h1>Karma <b>Connect</b></h1>
          <p>AI-Powered Prospect Intelligence</p>
        </div>

        <div className="card">
          <h2>{creating ? "Create Your Account" : "Welcome Back"}</h2>
          <div className="sub">{creating ? "Set up your workspace access to Karma Connect." : "Sign in to continue your prospecting journey."}</div>

          <form onSubmit={handleSubmit}>
            {remote && mode === "signup" && (
              <div className="row2">
                <div><label>First name</label><div className="field"><span className="ic">{UserIc}</span><input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Jane" /></div></div>
                <div><label>Last name</label><div className="field"><span className="ic">{UserIc}</span><input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Doe" /></div></div>
              </div>
            )}

            <label>{creating ? "Work email" : "Email address"}</label>
            <div className="field"><span className="ic">{MailIc}</span><input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></div>

            <label>Password</label>
            <div className="field">
              <span className="ic">{LockIc}</span>
              <input type={showPw ? "text" : "password"} autoComplete={creating ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" />
              <button type="button" className="eye" onClick={() => setShowPw((v) => !v)} aria-label={showPw ? "Hide password" : "Show password"}>{showPw ? EyeOffIc : EyeIc}</button>
            </div>

            {creating && (
              <>
                <label>Confirm password</label>
                <div className="field"><span className="ic">{LockIc}</span><input type={showPw ? "text" : "password"} autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} placeholder="Re-enter your password" /></div>
              </>
            )}

            {!creating && (
              <div className="util">
                <span className="rm" onClick={() => setRemember((v) => !v)}><span className={"box" + (remember ? " on" : "")}>{remember && CheckIc}</span>Remember me</span>
                <button type="button" className="lk" onClick={forgot}>Forgot password?</button>
              </div>
            )}

            <button className="cta" type="submit" disabled={busy}>
              {busy ? "Working…" : creating ? "Create Account" : "Sign In"}
            </button>
            {err && <p className="msg err">{err}</p>}
            {notice && <p className="msg ok">{notice}</p>}
            {showResend && remote && (
              <p className="msg" style={{ marginTop: 10, color: "#9aa7c4" }}>
                Didn't get the email? <button type="button" className="lk" onClick={resend} disabled={busy}>Resend confirmation</button>
              </p>
            )}
          </form>

          {remote && (
            <div className="foot">
              {mode === "signup" ? "Already have an account? " : "New here? "}
              <button type="button" className="lk" onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setErr(""); setNotice(""); }}>
                {mode === "signup" ? "Sign in" : "Create an account"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
