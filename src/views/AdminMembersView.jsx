// Member management. Admins read this screen; only the owner can act on it.
//
// The split is deliberate: a manager should be able to see who is on the team
// and what they are spending, but appointing another admin and deleting an
// account are the two moves that change who has access and cannot be taken
// back. Both are owner-gated on the routes; the buttons below just stop
// promising something the server will refuse.
import { useState, useEffect } from "react";
import { listUsers, setUserRole, removeUser } from "../lib/admin.js";

const usd = (n) => "$" + (Number(n) || 0).toFixed(2);

export function AdminMembersView({ meId, askConfirm, showToast }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState("");
  const [isOwner, setIsOwner] = useState(false);

  function load() {
    setLoading(true); setErr("");
    listUsers().then(({ users: u, youAreOwner }) => { setUsers(u); setIsOwner(youAreOwner); setLoading(false); })
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
      <div className="head"><div className="eyebrow">Admin</div><h2>Members</h2>
        <p>Everyone with an account, and what they have spent.{isOwner
          ? " As the owner you can also grant admin or remove someone."
          : " Granting admin and removing an account are the owner's — ask them."}</p></div>
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
                {(u.is_owner || u.is_admin) && <span style={{ marginLeft: "auto", fontSize: 10.5, fontWeight: 700, color: u.is_owner ? "#FFCF00" : "#52d39e", border: "1px solid " + (u.is_owner ? "#FFCF0055" : "#52d39e55"), background: (u.is_owner ? "#FFCF00" : "#52d39e") + "1a", borderRadius: 999, padding: "2px 9px" }}>{u.is_owner ? "Owner" : "Admin"}</span>}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--faint)", display: "flex", gap: 12, flexWrap: "wrap" }}>
                <span>Joined {new Date(u.created_at).toLocaleDateString()}</span>
                <span>{u.calls} calls · {usd(u.cost_usd)}</span>
                {!u.email_verified && <span style={{ color: "#E7B74B" }}>Unverified</span>}
              </div>
              <div className="mact">
                {/* An owner's rank comes from OWNER_EMAILS, so there is no
                    button that could revoke it — the server says the same. */}
                <button className="iconbtn" onClick={() => toggleRole(u)}
                        disabled={busyId === u.id || u.id === meId || !isOwner || u.is_owner}
                        title={u.is_owner ? "Owners are set in OWNER_EMAILS" : isOwner ? "" : "Only the owner can change this"}>
                  {u.is_admin ? "Revoke admin" : "Make admin"}
                </button>
                <button className="iconbtn" onClick={() => confirmRemove(u)}
                        disabled={busyId === u.id || u.id === meId || !isOwner || u.is_owner}
                        title={isOwner ? "" : "Only the owner can remove an account"}
                        style={{ marginLeft: "auto", color: (u.id === meId || !isOwner || u.is_owner) ? "var(--faint)" : "#ff9a9a" }}>
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
