// Profile & account settings: see your role, upgrade to admin with the code, delete account.
import { useState } from "react";
import { promoteToAdmin, deleteAccount } from "../lib/auth.js";

export function SettingsView({ user, isAdmin, askConfirm, showToast }) {
  const [code, setCode] = useState("");
  const [pBusy, setPBusy] = useState(false);
  const [pMsg, setPMsg] = useState("");
  const [pErr, setPErr] = useState("");
  const [pw, setPw] = useState("");
  const [dBusy, setDBusy] = useState(false);
  const [dErr, setDErr] = useState("");

  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "—";

  async function promote() {
    setPMsg(""); setPErr("");
    if (!code.trim()) { setPErr("Enter the admin code."); return; }
    setPBusy(true);
    try {
      await promoteToAdmin(code.trim());
      setCode("");
      setPMsg("You're now an admin — the Approvals section is available in the sidebar.");
      if (showToast) showToast("You're now an admin");
    } catch (e) {
      setPErr((e && e.message) || "Could not update your role.");
    }
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
        try {
          await deleteAccount(pw); // signs out → the gate returns to the login screen
        } catch (e) {
          setDErr((e && e.message) || "Could not delete the account.");
          setDBusy(false);
        }
      },
    });
  }

  return (
    <div>
      <div className="head"><div className="eyebrow">Account</div><h2>Profile &amp; settings</h2><p>Manage your account, role, and access.</p></div>

      <div className="panel">
        <div className="sect-title">Your account</div>
        <div className="fgrid">
          <div className="f"><label>Name</label><input value={fullName} readOnly /></div>
          <div className="f"><label>Email</label><input value={user?.email || ""} readOnly /></div>
        </div>
        <div className="hint" style={{ marginTop: 10 }}>
          Role: <b style={{ color: isAdmin ? "#52d39e" : "var(--ice)" }}>{isAdmin ? "Admin" : "Member"}</b>
          {isAdmin ? " — you can approve leads and use every engine." : " — you can work leads through connection requests."}
        </div>
      </div>

      {!isAdmin && (
        <div className="panel">
          <div className="sect-title">Become an admin</div>
          <p style={{ color: "var(--muted)", fontSize: 13.5, lineHeight: 1.6, marginBottom: 12 }}>
            Created a normal account but you should be an admin? Enter the admin code to upgrade. Admins approve leads and unlock the Relationship, Meeting and Follow-up engines.
          </p>
          <div className="f full" style={{ maxWidth: 360 }}>
            <label>Admin code</label>
            <input type="password" autoComplete="off" value={code} placeholder="Enter the admin code" onChange={(e) => setCode(e.target.value)} />
          </div>
          <div className="toprow" style={{ marginTop: 14 }}>
            <button className="btn primary" onClick={promote} disabled={pBusy}>{pBusy ? "Working…" : "Make me an admin"}</button>
          </div>
          {pMsg && <div className="reason" style={{ marginTop: 12 }}><b>Done</b> · {pMsg}</div>}
          {pErr && <div className="err" style={{ marginTop: 12 }}>⚠ {pErr}</div>}
        </div>
      )}

      <div className="panel" style={{ borderColor: "rgba(226,74,74,.3)", background: "rgba(226,74,74,.03)" }}>
        <div className="sect-title" style={{ color: "#ff9a9a" }}>Delete account</div>
        <p style={{ color: "var(--muted)", fontSize: 13.5, lineHeight: 1.6, marginBottom: 12 }}>
          Permanently delete your account and everything saved to it. This can't be undone. Enter your password to confirm.
        </p>
        <div className="f full" style={{ maxWidth: 360 }}>
          <label>Confirm your password</label>
          <input type="password" autoComplete="current-password" value={pw} placeholder="Your password" onChange={(e) => setPw(e.target.value)} />
        </div>
        <div className="toprow" style={{ marginTop: 14 }}>
          <button className="btn danger" onClick={confirmDelete} disabled={dBusy}>{dBusy ? "Deleting…" : "Delete my account"}</button>
        </div>
        {dErr && <div className="err" style={{ marginTop: 12 }}>⚠ {dErr}</div>}
      </div>
    </div>
  );
}
