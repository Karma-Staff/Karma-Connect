// Email + the email-verification/reset config, extracted from server.js.
// Reads its env at load, so require this AFTER the .env loader has run.
//
// ONE way out: the internal mail gateway. This app POSTs to ${GATEWAY_URL}/send
// with its own bearer token; the gateway holds the provider key and decides
// which sender addresses the token may use. No provider credential lives here,
// which is the point — this service cannot leak a key it never has, and a
// token can be revoked for this app alone without touching anyone else.
//
// Unconfigured: sending is OFF, signups are created already-verified rather
// than waiting for a confirmation that can never arrive, and password resets
// report that they cannot be sent instead of failing silently.
//
// Values, all from the environment, nothing hardcoded:
//   GATEWAY_URL    base URL of the gateway
//   GATEWAY_TOKEN  this app's bearer token, issued by an admin
//   MAIL_FROM      sender address; must be allowlisted for that token, or the
//                  gateway answers 403
const GATEWAY_URL = (process.env.GATEWAY_URL || "").trim().replace(/\/+$/, ""); // trim trailing slash
const GATEWAY_TOKEN = (process.env.GATEWAY_TOKEN || "").trim();
const MAIL_FROM = (process.env.MAIL_FROM || "Karma Connect <karmaconnect@karmastaff.com>").trim();
const emailVerifyOn = !!(GATEWAY_URL && GATEWAY_TOKEN);
const VERIFY_TTL_HOURS = 24;
const RESET_TTL_HOURS = 1; // password-reset links expire fast

if (!emailVerifyOn) {
  console.warn("[karma] email is OFF (set GATEWAY_URL and GATEWAY_TOKEN) — "
    + "signups are auto-verified and password resets cannot be sent.");
}

// Escape user-supplied text before embedding it in email HTML.
function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* Deliver one email through the gateway. Returns the gateway's message_id on
   success — callers that recorded a provider id keep recording one, it is just
   the gateway's now.

   opts.idempotencyKey, when a caller supplies one, rides along as an
   Idempotency-Key header so a retried send cannot become two emails. Nothing
   sets it today; it is here so a caller that needs it does not have to reach
   into the transport.

   The bearer token is never logged, and no error message below echoes it. */
async function send(to, subject, html, opts = {}) {
  if (!emailVerifyOn) {
    throw new Error("Email is not configured (set GATEWAY_URL and GATEWAY_TOKEN).");
  }
  const headers = {
    Authorization: "Bearer " + GATEWAY_TOKEN,
    "Content-Type": "application/json",
  };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = String(opts.idempotencyKey);

  const r = await fetch(GATEWAY_URL + "/send", {
    method: "POST",
    headers,
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html }),
  });
  if (r.status === 200) {
    const { message_id } = await r.json().catch(() => ({}));
    return message_id;
  }
  /* Error mapping. The first two are configuration rather than faults, and
     saying which one saves a hunt through the gateway's own logs. */
  if (r.status === 401) throw new Error("Email gateway: bad or missing token (401) — check GATEWAY_TOKEN.");
  if (r.status === 403) throw new Error("Email gateway: sender " + MAIL_FROM + " not permitted for this token (403) — the admin must allowlist MAIL_FROM.");
  if (r.status === 429) { const ra = r.headers.get("retry-after"); throw new Error("Email gateway: rate limited (429)" + (ra ? " — retry after " + ra + "s." : ".")); }
  const t = await r.text().catch(() => ""); // 400 (bad request) / 502 (upstream send failure) / other
  throw new Error("Email gateway " + r.status + ": " + t);
}

async function sendVerificationEmail(email, firstName, link) {
  const hi = firstName ? "Hi " + escapeHtml(firstName) + "," : "Hi,";
  const html = `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0b2545">
    <h2 style="color:#0b2545">Confirm your email</h2>
    <p>${hi}</p>
    <p>Thanks for creating a Karma Connect account. Please confirm this email address to activate your login.</p>
    <p style="margin:28px 0">
      <a href="${link}" style="background:#E7B74B;color:#071226;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;display:inline-block">Confirm my email</a>
    </p>
    <p style="font-size:12px;color:#667">Or paste this link into your browser:<br><a href="${link}">${link}</a></p>
    <p style="font-size:12px;color:#667">This link expires in ${VERIFY_TTL_HOURS} hours. If you didn't create this account, you can ignore this email.</p>
  </div>`;
  await send(email, "Confirm your email for Karma Connect", html);
}

async function sendResetEmail(email, firstName, link) {
  const hi = firstName ? "Hi " + escapeHtml(firstName) + "," : "Hi,";
  const html = `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0b2545">
    <h2 style="color:#0b2545">Reset your password</h2>
    <p>${hi}</p>
    <p>We received a request to reset your Karma Connect password. Click below to choose a new one.</p>
    <p style="margin:28px 0">
      <a href="${link}" style="background:#E7B74B;color:#071226;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;display:inline-block">Set a new password</a>
    </p>
    <p style="font-size:12px;color:#667">Or paste this link into your browser:<br><a href="${link}">${link}</a></p>
    <p style="font-size:12px;color:#667">This link expires in ${RESET_TTL_HOURS} hour. If you didn't request this, you can safely ignore this email — your password won't change.</p>
  </div>`;
  await send(email, "Reset your Karma Connect password", html);
}

// Notify a chosen admin that a member is requesting approval for a lead.
async function sendApprovalRequestEmail(adminEmail, { adminName, memberName, leadLabel, leadSub, link }) {
  const hi = adminName ? "Hi " + escapeHtml(adminName) + "," : "Hi,";
  const sub = leadSub ? `<p style="color:#667;margin-top:-8px">${escapeHtml(leadSub)}</p>` : "";
  const html = `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0b2545">
    <h2 style="color:#0b2545">Approval requested</h2>
    <p>${hi}</p>
    <p><b>${escapeHtml(memberName || "A team member")}</b> is asking you to approve a lead so they can unlock the Relationship, Meeting and Follow-up engines for it.</p>
    <p style="font-size:16px;font-weight:700;margin:18px 0 0">${escapeHtml(leadLabel || "A lead")}</p>
    ${sub}
    <p style="margin:24px 0">
      <a href="${link}" style="background:#E7B74B;color:#071226;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;display:inline-block">Review in Karma Connect</a>
    </p>
    <p style="font-size:12px;color:#667">Open Karma Connect and go to Approvals to approve or deny this request.</p>
  </div>`;
  await send(adminEmail, "Approval needed: " + (leadLabel || "a lead"), html);
}

// Tell a member their approval request was decided (approved or denied).
async function sendApprovalDecisionEmail(memberEmail, { memberName, leadLabel, decision, adminName, link }) {
  const approved = decision === "approved";
  const hi = memberName ? "Hi " + escapeHtml(memberName) + "," : "Hi,";
  const by = adminName ? " by " + escapeHtml(adminName) : "";
  const body = approved
    ? `<p>Good news — your request to unlock the advanced engines for <b>${escapeHtml(leadLabel || "your lead")}</b> was <b>approved</b>${by}.</p>
       <p>The Relationship, Meeting and Follow-up engines are now unlocked for this lead.</p>`
    : `<p>Your request for <b>${escapeHtml(leadLabel || "your lead")}</b> was <b>not approved</b>${by} this time. You can adjust the lead and request again.</p>`;
  const html = `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0b2545">
    <h2 style="color:#0b2545">${approved ? "Lead approved" : "Approval update"}</h2>
    <p>${hi}</p>
    ${body}
    <p style="margin:24px 0">
      <a href="${link}" style="background:#E7B74B;color:#071226;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;display:inline-block">Open Karma Connect</a>
    </p>
  </div>`;
  await send(memberEmail, (approved ? "Approved: " : "Update on: ") + (leadLabel || "your lead"), html);
}

// Outreach send: goes out AS the chosen sender (from / reply-to = their @karmastaff.com
// address), so replies land with the recruiter rather than the app. The body is the plain-text
// message the app generated; we wrap it in minimal HTML and append a CAN-SPAM-style footer
// (sender identity + reply-to-opt-out). Returns the gateway message id. Throws on failure so
// the outreach queue can flag or retry.
//
// Unlike send(), this overrides `from` — the gateway allowlists senders per token, so each
// recruiter address has to be permitted there or the gateway answers 403.
/* A "follow back" reminder falling due (leads/server/followups.js).
   Everything a rep needs to act without opening anything: who, where, their
   number as a tel: link, and whatever note they left themselves. */
async function sendFollowupEmail(to, lead, note, link, idempotencyKey) {
  const who = lead.company || lead.name || lead.lead_code || "this lead";
  const where = [lead.city, lead.state].filter(Boolean).join(", ");
  const html = `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0b2545">
    <h2 style="color:#0b2545">Time to follow back</h2>
    <p>You asked to be reminded about this one.</p>
    <p style="font-size:16px;font-weight:700;margin:18px 0 0">${escapeHtml(who)}</p>
    ${where ? `<p style="color:#667;margin-top:2px">${escapeHtml(where)}</p>` : ""}
    ${lead.phone ? `<p style="margin:4px 0 0"><a href="tel:${escapeHtml(lead.phone)}" style="color:#0b2545">${escapeHtml(lead.phone)}</a></p>` : ""}
    ${note ? `<p style="background:#f4f6fb;border-left:3px solid #E7B74B;padding:10px 14px;margin:18px 0">${escapeHtml(note)}</p>` : ""}
    ${link
      ? `<p style="margin:24px 0"><a href="${link}" style="background:#E7B74B;color:#071226;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;display:inline-block">Open the lead</a></p>`
      : `<p style="font-size:12px;color:#667">Open Karma Connect and search for ${escapeHtml(who)}.</p>`}
    <p style="font-size:12px;color:#667">Set from Karma Connect. Marking it done on the lead stops any further reminder.</p>
  </div>`;
  await send(to, "Follow back: " + who, html, { idempotencyKey });
}

/* The 7am storm digest (leads/server/digest.js). Written to be read on a
   phone before the first coffee: the number that matters, then where, then
   a way in. Only sent on a morning when something actually happened. */
async function sendStormDigestEmail(to, d, idempotencyKey) {
  const hi = d.name ? "Morning " + escapeHtml(d.name) + "," : "Morning,";
  const row = (s) => `<tr>
    <td style="padding:7px 10px;border-bottom:1px solid #e6e9f0"><b>${escapeHtml(s.name)}</b><br>
      <span style="color:#667;font-size:12px">${escapeHtml(s.events.slice(0, 2).join(", "))}</span></td>
    <td style="padding:7px 10px;border-bottom:1px solid #e6e9f0;text-align:right;white-space:nowrap">
      <b>${s.leads.toLocaleString()}</b><br>
      <span style="color:#667;font-size:12px">${s.unassigned.toLocaleString()} unassigned</span></td>
  </tr>`;
  const html = `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0b2545">
    <h2 style="color:#0b2545;margin-bottom:4px">Storm watch</h2>
    <p style="color:#667;margin-top:0">${d.totalStates} state${d.totalStates === 1 ? "" : "s"} under a severe-weather alert this morning.</p>
    <p>${hi}</p>
    <p>You have <b>${d.leads.toLocaleString()} leads</b> in the affected states,
       <b>${d.unassigned.toLocaleString()}</b> of them unassigned.</p>
    <table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:14px">
      <tr><th style="text-align:left;padding:0 10px 6px;color:#667;font-size:11px;letter-spacing:.06em;text-transform:uppercase">Where</th>
          <th style="text-align:right;padding:0 10px 6px;color:#667;font-size:11px;letter-spacing:.06em;text-transform:uppercase">Leads</th></tr>
      ${d.states.map(row).join("")}
    </table>
    ${d.link ? `<p style="margin:24px 0"><a href="${d.link}" style="background:#E7B74B;color:#071226;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;display:inline-block">Open Storm watch</a></p>` : ""}
    <p style="font-size:12px;color:#667">Restoration firms in these areas are about to be short-handed.
      Source: US National Weather Service. Marine and beach advisories are filtered out.</p>
  </div>`;
  await send(to, `Storm watch: ${d.totalStates} state${d.totalStates === 1 ? "" : "s"} hit`, html, { idempotencyKey });
}

/* The morning call report (leads/server/call-digest.js).

   Goes to admins and the owner rather than the whole team: this is everyone's
   numbers side by side, which is a management view and not a team one.

   It shows people who called NOTHING as a zero rather than leaving them out.
   A list of only the active makes an idle day look like a quiet one, and the
   gap is the thing a manager needs to see. */
async function sendCallDigestEmail(to, d, idempotencyKey) {
  const hi = d.name ? "Morning " + escapeHtml(d.name) + "," : "Morning,";
  const pct = d.calls ? Math.round((d.connected / d.calls) * 100) : 0;

  const row = (p, i) => `<tr${p.calls === 0 ? ' style="opacity:.62"' : ""}>
    <td style="padding:8px 10px;border-bottom:1px solid #e6e9f0">
      <b>${escapeHtml(p.label)}</b>${p.role && p.role !== "member"
        ? ` <span style="color:#8a93a3;font-size:11px">${escapeHtml(p.role)}</span>` : ""}
      ${p.calls === 0 ? '<br><span style="color:#b0342c;font-size:12px">no calls</span>' : ""}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #e6e9f0;text-align:right"><b>${p.calls}</b></td>
    <td style="padding:8px 10px;border-bottom:1px solid #e6e9f0;text-align:right">${p.connected}${
      p.placed ? `<br><span style="color:#8a93a3;font-size:11px">+${p.placed} unknown</span>` : ""}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #e6e9f0;text-align:right;color:#667">${
      p.calls ? Math.round((p.connected / p.calls) * 100) + "%" : "—"}</td>
  </tr>`;

  const th = (t, right) => `<th style="text-align:${right ? "right" : "left"};padding:0 10px 6px;
    color:#667;font-size:11px;letter-spacing:.06em;text-transform:uppercase">${t}</th>`;

  const html = `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0b2545">
    <h2 style="color:#0b2545;margin-bottom:4px">Call report — ${escapeHtml(d.dayLabel)}</h2>
    <p style="color:#667;margin-top:0">${d.calls.toLocaleString()} call${d.calls === 1 ? "" : "s"}
       by ${d.callers} of ${d.members} · ${d.connected.toLocaleString()} connected (${pct}%)</p>
    <p>${hi}</p>
    <table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:14px">
      <tr>${th("Person")}${th("Calls", 1)}${th("Connected", 1)}${th("Rate", 1)}</tr>
      ${d.people.map(row).join("")}
      <tr><td style="padding:9px 10px;border-top:2px solid #0b2545"><b>Total</b></td>
          <td style="padding:9px 10px;border-top:2px solid #0b2545;text-align:right"><b>${d.calls}</b></td>
          <td style="padding:9px 10px;border-top:2px solid #0b2545;text-align:right"><b>${d.connected}</b></td>
          <td style="padding:9px 10px;border-top:2px solid #0b2545;text-align:right"><b>${pct}%</b></td></tr>
    </table>
    ${d.vsPrev ? `<p style="font-size:13px;color:#667">${escapeHtml(d.vsPrev)}</p>` : ""}
    ${d.placed ? `<p style="font-size:12px;color:#8a6100;background:#fdf6e6;padding:9px 11px;border-radius:7px">
      ${d.placed} of these were handed to Zoho's own dialler, which never reports back how
      they went. They count as calls and never as connections, so the connected figure is a
      floor rather than a rate.</p>` : ""}
    ${d.link ? `<p style="margin:22px 0"><a href="${d.link}" style="background:#0b2545;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;display:inline-block">Open the call report</a></p>` : ""}
    <p style="font-size:12px;color:#667">Counts calls placed <b>through the dashboard</b>.
      A rep dialling from a handset or the Zoho app directly appears here as zero.
      Times are ${escapeHtml(d.tz)}.</p>
  </div>`;
  await send(to, `Call report ${d.dayLabel}: ${d.calls} calls, ${d.connected} connected`,
    html, { idempotencyKey });
}

/* Being added to the team (leads/server/users.js).

   This email is the whole invite. Adding somebody only creates their row —
   they still have to make an account of their own before it does anything,
   and without being told, they never do. So it says what happened, what to
   do, and to use this exact address, since the row is keyed on it and
   signing up with a different one silently misses. */
async function sendTeamInviteEmail(to, { inviterName, role, link }) {
  const rank = role === "admin" ? "an <b>admin</b>" : role === "owner" ? "an <b>owner</b>" : "a <b>member</b>";
  const html = `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0b2545">
    <h2 style="color:#0b2545">You have been added to Karma Connect</h2>
    <p>${inviterName ? escapeHtml(inviterName) + " has" : "You have been"} added you to the team as ${rank}.</p>
    <p><b>One step left:</b> create your sign-in. Use this exact address —
       <b>${escapeHtml(to)}</b> — or your access will not be found.</p>
    ${link ? `<p style="margin:24px 0"><a href="${link}" style="background:#E7B74B;color:#071226;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;display:inline-block">Create your sign-in</a></p>` : ""}
    <p>${role === "member"
      ? "As a member you will see the leads assigned to you, and can call, take notes and set reminders on them."
      : "You will see the whole base, the team's activity, and can assign work."}</p>
    <p style="font-size:12px;color:#667">One sign-in covers the whole of Karma Connect.
      If you already have a Karma Connect account, just sign in — nothing more to do.</p>
  </div>`;
  await send(to, "You have been added to Karma Connect", html, { idempotencyKey: "invite-" + to });
}

async function sendOutreachEmail({ fromName, fromEmail, to, subject, text }) {
  if (!emailVerifyOn) throw new Error("Email sending is not configured (GATEWAY_URL / GATEWAY_TOKEN missing).");
  if (!fromEmail || !to || !subject) throw new Error("Outreach email needs fromEmail, to and subject.");
  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const safeBody = escapeHtml(text).replace(/\n/g, "<br>");
  const footer = `Sent by ${escapeHtml(fromName || fromEmail)}, Karma Staff. ` +
    `If this isn't relevant, just reply "unsubscribe" and you won't hear from us again.`;
  const html = `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:560px;color:#101828;font-size:15px;line-height:1.6">` +
    `<div>${safeBody}</div>` +
    `<div style="margin-top:28px;padding-top:14px;border-top:1px solid #e4e7ec;font-size:12px;color:#98a2b3">${footer}</div>` +
    `</div>`;
  const r = await fetch(GATEWAY_URL + "/send", {
    method: "POST",
    headers: { Authorization: "Bearer " + GATEWAY_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], reply_to: fromEmail, subject, html, text }),
  });
  if (r.status === 200) {
    const { message_id } = await r.json().catch(() => ({}));
    return message_id;
  }
  if (r.status === 401) throw new Error("Email gateway: bad or missing token (401) — check GATEWAY_TOKEN.");
  if (r.status === 403) throw new Error("Email gateway: sender " + from + " not permitted for this token (403) — the admin must allowlist this recruiter's address.");
  if (r.status === 429) { const ra = r.headers.get("retry-after"); throw new Error("Email gateway: rate limited (429)" + (ra ? " — retry after " + ra + "s." : ".")); }
  const t = await r.text().catch(() => "");
  throw new Error("Email gateway " + r.status + ": " + t);
}

module.exports = { emailVerifyOn, VERIFY_TTL_HOURS, RESET_TTL_HOURS, escapeHtml, sendVerificationEmail, sendResetEmail, sendApprovalRequestEmail, sendApprovalDecisionEmail, sendOutreachEmail, sendFollowupEmail, sendStormDigestEmail, sendCallDigestEmail, sendTeamInviteEmail };
