// Admin lead-approval queue. Presentational: data + actions come in as props.
import { Ic } from "../components/icons.jsx";

export function ApprovalsView({ adminList, onRefresh, onDecide }) {
  return (
    <div>
      <div className="head"><div className="eyebrow">Admin</div><h2>Lead approvals</h2><p>Approve a lead to unlock the Relationship, Meeting and Follow-up engines for the member who requested it. Keeps the advanced (and pricier) stages gated.</p></div>
      <div className="toprow"><button className="btn ghost sm" onClick={onRefresh}>Refresh</button></div>
      {adminList.length === 0 ? (
        <div className="empty"><div className="eic">{Ic.intel}</div><h3>No requests yet</h3><p>When a member requests approval for a lead, it appears here for you to approve or deny.</p></div>
      ) : (
        <div className="grid2">
          {adminList.map((a) => (
            <div className="mcard" key={a.id}>
              <div className="mctop">
                <span className={"chip" + (a.status === "approved" ? " idx" : "")}>{a.status}</span>
                <span className="stagehd">{a.label || a.prospect_id}</span>
              </div>
              {a.sub && <div className="pr" style={{ fontSize: 12, color: "var(--muted)" }}>{a.sub}</div>}
              <div className="pr" style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>Requested by {a.member_email}</div>
              {a.status === "pending" ? (
                <div className="mact" style={{ marginTop: 10 }}>
                  <button className="btn primary sm" onClick={() => onDecide(a.id, "approved")}>Approve</button>
                  <button className="btn danger sm" onClick={() => onDecide(a.id, "denied")} style={{ marginLeft: 8 }}>Deny</button>
                </div>
              ) : (
                <div className="pr" style={{ fontSize: 12, marginTop: 8, color: a.status === "approved" ? "#52d39e" : "var(--faint)" }}>{a.status}{a.decided_by ? " · by " + a.decided_by : ""}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
