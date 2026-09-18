// Profile & account settings: identity, change password, upgrade to admin, delete account.
import { useState } from "react";
import { promoteToAdmin, deleteAccount, changePassword } from "../lib/auth.js";

/* The reveal eye. A password field people cannot read back is where typos
   live, and every one of these forms rejects a typo only after a round trip
   — or, in the delete-account case, after the confirm dialog. Same two icons
   as the sign-in screen, so the control means the same thing in both places. */
const EyeSvg = ({ off }) => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
       strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    {off ? (<>
      <path d="M3 3l18 18" /><path d="M10.6 10.6a3 3 0 0 0 4.2 4.2" />
      <path d="M9.9 5.2A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.8 17.8 0 0 1-3.3 4.1M6.6 6.6A17.6 17.6 0 0 0 2 12s3.5 7 10 7a10.3 10.3 0 0 0 3.4-.6" />
    </>) : (<>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </>)}
  </svg>
);

/* One field, its own show/hide state. Per-field rather than one switch for
   the panel: revealing the current password to check a typo should not also
   put the new one on screen behind whoever is walking past. */
function PwField({ label, value, onChange, placeholder, autoComplete, className }) {
  const [show, setShow] = useState(false);
  return (
    <div className={"f pw" + (className ? " " + className : "")}>
      <label>{label}</label>
      <input type={show ? "text" : "password"} autoComplete={autoComplete}
             value={value} placeholder={placeholder}
             onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="eye" onClick={() => setShow((v) => !v)}
              aria-label={show ? "Hide " + label.toLowerCase() : "Show " + label.toLowerCase()}>
        <EyeSvg off={show} />
      </button>
    </div>
  );
}

export function SettingsView({ user, isAdmin, askConfirm, showToast }) {
  const [code, setCode] = useState("");
  const [pBusy, setPBusy] = useState(false);
  const [pMsg, setPMsg] = useState("");
  const [pErr, setPErr] = useState("");
  const [pw, setPw] = useState("");
  const [dBusy, setDBusy] = useState(false);
  const [dErr, setDErr] = useState("");
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [cBusy, setCBusy] = useState(false);
  const [cMsg, setCMsg] = useState("");
  const [cErr, setCErr] = useState("");

  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ");
  const displayName = fullName || user?.email || "Your account";
  const initial = ((fullName || user?.email || "?").trim()[0] || "?").toUpperCase();

  async function doChangePassword() {
    setCMsg(""); setCErr("");
    if (newPw.length < 8) { setCErr("Use a new password of at least 8 characters."); return; }
    if (newPw !== newPw2) { setCErr("The two new passwords don't match."); return; }
    setCBusy(true);
    try {
      await changePassword(curPw, newPw);
      setCurPw(""); setNewPw(""); setNewPw2("");
      setCMsg("Password changed.");
      if (showToast) showToast("Password changed");
    } catch (e) { setCErr((e && e.message) || "Could not change the password."); }
    setCBusy(false);
  }

  async function promote() {
    setPMsg(""); setPErr("");
    if (!code.trim()) { setPErr("Enter the admin code."); return; }
    setPBusy(true);
    try {
      await promoteToAdmin(code.trim());
      setCode("");
      setPMsg("You're now an admin — the Approvals & Members sections are in the sidebar.");
      if (showToast) showToast("You're now an admin");
    } catch (e) { setPErr((e && e.message) || "Could not update your role."); }
    setPBusy(false);
  }

  function confirmDelete() {
    setDErr("");
    if (!pw) { setDErr("Enter your password to confirm."); return; }
    askConfirm({
      title: "Delete your account?",
      message: "This permanently deletes your account and everything saved to it — prospects, history, and approvals. This can't be undone.",
      confirmLabel: "Delete my account",
      danger: true,
      onConfirm: async () => {
        setDBusy(true);
        try { await deleteAccount(pw); } // signs out → gate returns to login
        catch (e) { setDErr((e && e.message) || "Could not delete the account."); setDBusy(false); }
      },
    });
  }

  const rolePill = isAdmin
    ? { color: "#52d39e", borderColor: "#52d39e55", background: "#52d39e1a" }
    : { color: "var(--ice)", borderColor: "var(--border2)", background: "rgba(255,255,255,.04)" };

  return (
    <div className="vstack">
      <div className="head"><div className="eyebrow">Account</div><h2>Profile &amp; settings</h2><p>Manage your account, role, and access.</p></div>

      {/* Identity */}
      <div className="panel">
        <div className="idrow">
          <span className="idav">{initial}</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="idname">{displayName}</div>
            <div className="idmail">{user?.email}</div>
          </div>
          <span className="rolepill" style={rolePill}><span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }} />{isAdmin ? "Admin" : "Member"}</span>
        </div>
        <div className="hint" style={{ marginTop: 14 }}>
          {isAdmin ? "You can approve leads, manage members, and use every engine." : "You can work leads through connection requests. Enter an admin code below to upgrade."}
        </div>
      </div>

      {/* Change password */}
      <div className="panel">
        <div className="sect-title">Change password</div>
        <div className="fgrid">
          <PwField label="Current password" autoComplete="current-password"
                   value={curPw} onChange={setCurPw} placeholder="Current password" />
          <PwField label="New password" autoComplete="new-password"
                   value={newPw} onChange={setNewPw} placeholder="At least 8 characters" />
          <PwField label="Confirm new password" autoComplete="new-password"
                   value={newPw2} onChange={setNewPw2} placeholder="Re-enter new password" />
        </div>
        <div className="toprow" style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={doChangePassword} disabled={cBusy}>{cBusy ? "Working…" : "Change password"}</button>
          {cMsg && <span style={{ color: "#52d39e", fontSize: 12.5 }}>✓ {cMsg}</span>}
        </div>
        {cErr && <div className="err" style={{ marginTop: 12 }}>⚠ {cErr}</div>}
      </div>

      {/* Become an admin */}
      {!isAdmin && (
        <div className="panel">
          <div className="sect-title">Become an admin</div>
          <p style={{ color: "var(--muted)", fontSize: 13.5, lineHeight: 1.6, marginBottom: 14 }}>
            Created a normal account but you should be an admin? Enter the admin code to upgrade — admins approve leads and unlock the Relationship, Meeting and Follow-up engines.
          </p>
          <div style={{ maxWidth: 380 }}>
            <PwField className="full" label="Admin code" autoComplete="off"
                     value={code} onChange={setCode} placeholder="Enter the admin code" />
          </div>
          <div className="toprow" style={{ marginTop: 16 }}>
            <button className="btn primary" onClick={promote} disabled={pBusy}>{pBusy ? "Working…" : "Make me an admin"}</button>
            {pMsg && <span style={{ color: "#52d39e", fontSize: 12.5 }}>✓ {pMsg}</span>}
          </div>
          {pErr && <div className="err" style={{ marginTop: 12 }}>⚠ {pErr}</div>}
        </div>
      )}

      {/* Danger zone */}
      <div className="panel danger-zone">
        <div className="sect-title" style={{ color: "#ff9a9a" }}>Danger zone</div>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 280px", minWidth: 0 }}>
            <div style={{ fontWeight: 700, color: "var(--text)", fontSize: 14, marginBottom: 4 }}>Delete account</div>
            <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.6, margin: "0 0 12px" }}>
              Permanently deletes your account and everything saved to it. This can't be undone.
            </p>
            <div style={{ maxWidth: 320 }}>
              <PwField className="full" label="Confirm your password"
                       autoComplete="current-password" value={pw} onChange={setPw}
                       placeholder="Your password" />
            </div>
          </div>
          <button className="btn danger" onClick={confirmDelete} disabled={dBusy}>{dBusy ? "Deleting…" : "Delete my account"}</button>
        </div>
        {dErr && <div className="err" style={{ marginTop: 12 }}>⚠ {dErr}</div>}
      </div>
    </div>
  );
}
