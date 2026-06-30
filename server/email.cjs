// Email (Resend) + the email-verification/reset config, extracted from server.js.
// Reads RESEND_* env at load, so require this AFTER the .env loader has run.
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "Karma Connect <noreply@karmastaff.com>";
const emailVerifyOn = !!RESEND_API_KEY; // when off (no key), signups are created already-verified
const VERIFY_TTL_HOURS = 24;
const RESET_TTL_HOURS = 1; // password-reset links expire fast

// Escape user-supplied text before embedding it in email HTML.
function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function send(to, subject, html) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("Resend " + r.status + ": " + t); }
}

// Outreach send: goes out AS the chosen sender (from/reply-to = their @karmastaff.com address,
// which must be on the domain verified in Resend). The body is the plain-text message the app
// generated; we wrap it in minimal HTML and append a CAN-SPAM-style footer (sender identity +
// reply-to-opt-out). Returns the Resend message id. Throws on failure so the queue can retry/flag.
async function sendOutreachEmail({ fromName, fromEmail, to, subject, text }) {
  if (!RESEND_API_KEY) throw new Error("Email sending is not configured (RESEND_API_KEY missing).");
  if (!fromEmail || !to || !subject) throw new Error("Outreach email needs fromEmail, to and subject.");
  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const safeBody = escapeHtml(text).replace(/\n/g, "<br>");
  const footer = `Sent by ${escapeHtml(fromName || fromEmail)}, Karma Staff. ` +
    `If this isn't relevant, just reply "unsubscribe" and you won't hear from us again.`;
  const html = `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:560px;color:#101828;font-size:15px;line-height:1.6">` +
    `<div>${safeBody}</div>` +
    `<div style="margin-top:28px;padding-top:14px;border-top:1px solid #e4e7ec;font-size:12px;color:#98a2b3">${footer}</div>` +
    `</div>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], reply_to: fromEmail, subject, html, text }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("Resend " + r.status + ": " + t); }
  const data = await r.json().catch(() => ({}));
  return data.id || null;
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

module.exports = { emailVerifyOn, VERIFY_TTL_HOURS, RESET_TTL_HOURS, escapeHtml, sendVerificationEmail, sendResetEmail, sendApprovalRequestEmail, sendApprovalDecisionEmail, sendOutreachEmail };
