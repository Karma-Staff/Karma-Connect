// Profile & account settings: identity, role, and account deletion.
// Passwords and the admin code are gone — sign-in is WorkOS, shared with Karma
// Leads, and roles are granted by an administrator rather than self-claimed.
import { useState } from "react";
import { deleteAccount } from "../lib/auth.js";

export function SettingsView({ user, isAdmin, askConfirm }) {
  // "type your email to confirm" is all that guards deletion now.
  const [confirmEmail, setConfirmEmail] = useState("");
  const [dBusy, setDBusy] = useState(false);
  const [dErr, setDErr] = useState("");

  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ");
  const displayName = fullName || user?.email || "Your account";
  const initial = ((fullName || user?.email || "?").trim()[0] || "?").toUpperCase();

  function confirmDelete() {
    setDErr("");
    const typed = confirmEmail.trim().toLowerCase();
    if (typed !== String(user?.email || "").toLowerCase()) {
      setDErr("Type your email address exactly to confirm."); return;
    }
    askConfirm({
      title: "Delete your account?",
      message: "This permanently deletes your account and everything saved to it — prospects, history, and approvals. This can't be undone.",
      confirmLabel: "Delete my account",
      danger: true,
      onConfirm: async () => {
        setDBusy(true);
        try { await deleteAccount(confirmEmail.trim()); } // signs out → gate returns to login
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
          {isAdmin ? "You can approve leads, manage members, and use every engine." : "You can work leads through connection requests. Ask an administrator if you need admin access."}
        </div>
      </div>

      {/* Sign-in */}
      <div className="panel">
        <div className="sect-title">Sign-in</div>
        <p style={{ color: "var(--muted)", fontSize: 13.5, lineHeight: 1.6, margin: 0 }}>
          Karma Connect and Karma Leads share one sign-in, managed by your
          organisation. There is no separate password here to change — update it
          where you sign in. Admin access is granted by an administrator.
        </p>
      </div>

      {/* Danger zone */}
      <div className="panel danger-zone">
        <div className="sect-title" style={{ color: "#ff9a9a" }}>Danger zone</div>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 280px", minWidth: 0 }}>
            <div style={{ fontWeight: 700, color: "var(--text)", fontSize: 14, marginBottom: 4 }}>Delete account</div>
            <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.6, margin: "0 0 12px" }}>
              Permanently deletes your account and everything saved to it. This can't be undone.
            </p>
            <div className="f full" style={{ maxWidth: 320 }}>
              <label>Type <b>{user?.email || "your email"}</b> to confirm</label>
              <input type="email" autoComplete="off" value={confirmEmail} placeholder={user?.email || "you@company.com"} onChange={(e) => setConfirmEmail(e.target.value)} />
            </div>
          </div>
          <button className="btn danger" onClick={confirmDelete} disabled={dBusy}>{dBusy ? "Deleting…" : "Delete my account"}</button>
        </div>
        {dErr && <div className="err" style={{ marginTop: 12 }}>⚠ {dErr}</div>}
      </div>
    </div>
  );
}
