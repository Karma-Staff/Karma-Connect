// Admin-only member management: list users, grant/revoke admin, remove a member.
// All actions are admin-gated server-side. No AI tokens used.
import { useState, useEffect } from "react";
import { listUsers, setUserRole, removeUser } from "../lib/admin.js";

const usd = (n) => "$" + (Number(n) || 0).toFixed(2);

export function AdminMembersView({ meId, askConfirm, showToast }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState("");

  function load() {
    setLoading(true); setErr("");
    listUsers().then((u) => { setUsers(u); setLoading(false); })
      .catch((e) => { setErr((e && e.message) || "Could not load members."); setLoading(false); });
  }
  useEffect(() => { load(); }, []);

  async function toggleRole(u) {
    setBusyId(u.id);
    try { await setUserRole(u.id, !u.is_admin); setUsers((cur) => cur.map((x) => (x.id === u.id ? { ...x, is_admin: !u.is_admin } : x))); if (showToast) showToast(u.is_admin ? "Admin removed" : "Made admin"); }
    catch (e) { if (showToast) showToast((e && e.message) || "Could not update role"); }
    setBusyId("");
  }

  function confirmRemove(u) {
    askConfirm({
      title: "Remove this member?",
      message: "Permanently delete " + (u.email || "this user") + " and all their data (prospects, history, approvals). This can't be undone.",
      confirmLabel: "Remove member", danger: true,
      onConfirm: async () => {
        setBusyId(u.id);
        try { await removeUser(u.id); setUsers((cur) => cur.filter((x) => x.id !== u.id)); if (showToast) showToast("Member removed"); }
        catch (e) { if (showToast) showToast((e && e.message) || "Could not remove member"); }
        setBusyId("");
      },
    });
  }

  return (
    <div>
      <div className="head"><div className="eyebrow">Admin</div><h2>Members</h2><p>Everyone with an account. Grant or revoke admin, see usage, or remove a member.</p></div>
      <div className="toprow"><button className="btn ghost sm" onClick={load}>Refresh</button></div>

      {loading && <div className="panel" style={{ color: "var(--muted)" }}>Loading members…</div>}
      {err && <div className="err">⚠ {err}</div>}

      {!loading && !err && (
        <div className="grid2">
          {users.map((u) => (
            <div className="mcard" key={u.id}>
              <div className="mctop">
                <span className="av" style={{ width: 30, height: 30, borderRadius: 8, background: "var(--grad)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 12, color: "#fff", fontFamily: "'Lora',serif" }}>
                  {((u.first_name || u.email || "?")[0] || "?").toUpperCase()}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="pn" style={{ fontSize: 13.5, fontWeight: 700 }}>{[u.first_name, u.last_name].filter(Boolean).join(" ") || u.email}</div>
                  <div className="pr" style={{ fontSize: 11.5, color: "var(--muted)" }}>{u.email}</div>
                </div>
                {u.is_admin && <span style={{ marginLeft: "auto", fontSize: 10.5, fontWeight: 700, color: "#52d39e", border: "1px solid #52d39e55", background: "#52d39e1a", borderRadius: 999, padding: "2px 9px" }}>Admin</span>}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--faint)", display: "flex", gap: 12, flexWrap: "wrap" }}>
                <span>Joined {new Date(u.created_at).toLocaleDateString()}</span>
                <span>{u.calls} calls · {usd(u.cost_usd)}</span>
                {!u.email_verified && <span style={{ color: "#E7B74B" }}>Unverified</span>}
              </div>
              <div className="mact">
                <button className="iconbtn" onClick={() => toggleRole(u)} disabled={busyId === u.id || u.id === meId}>
                  {u.is_admin ? "Revoke admin" : "Make admin"}
                </button>
                <button className="iconbtn" onClick={() => confirmRemove(u)} disabled={busyId === u.id || u.id === meId} style={{ marginLeft: "auto", color: u.id === meId ? "var(--faint)" : "#ff9a9a" }}>
                  {u.id === meId ? "You" : "Remove"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
