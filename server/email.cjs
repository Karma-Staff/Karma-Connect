// Email (internal mail gateway) + the email-verification/reset config, extracted from server.js.
// Reads GATEWAY_* / MAIL_FROM env at load, so require this AFTER the .env loader has run.
// The gateway holds the real Resend key server-side; this app only carries a per-client
// bearer token and POSTs to ${GATEWAY_URL}/send (a body that mirrors Resend's /emails shape).
const GATEWAY_URL = (process.env.GATEWAY_URL || "").replace(/\/+$/, ""); // trim trailing slash
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "";
const MAIL_FROM = process.env.MAIL_FROM || "Karma Connect <karmaconnect@karmastaff.com>";
const emailVerifyOn = !!(GATEWAY_URL && GATEWAY_TOKEN); // when off (unconfigured), signups are created already-verified
const VERIFY_TTL_HOURS = 24;
const RESET_TTL_HOURS = 1; // password-reset links expire fast

// Escape user-supplied text before embedding it in email HTML.
function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Deliver one email via the gateway. Returns the gateway's message_id on success.
// Never logs the bearer token. Maps gateway error statuses to clear, actionable messages.
async function send(to, subject, html) {
  const r = await fetch(GATEWAY_URL + "/send", {
    method: "POST",
    headers: { Authorization: "Bearer " + GATEWAY_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html }),
  });
  if (r.status === 200) {
    const { message_id } = await r.json().catch(() => ({}));
    return message_id;
  }
  // Error mapping — surface the cause without ever echoing the token.
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

module.exports = { emailVerifyOn, VERIFY_TTL_HOURS, RESET_TTL_HOURS, escapeHtml, sendVerificationEmail, sendResetEmail, sendApprovalRequestEmail, sendApprovalDecisionEmail, sendOutreachEmail };
