// Who is allowed into Karma Connect. For now this is a single address; add more by either
// editing the default below or setting VITE_ALLOWED_EMAILS="a@x.com,b@x.com" in your env.
const RAW = import.meta.env.VITE_ALLOWED_EMAILS || "tenzinwoesel@karmastaff.com";

export const ALLOWED_EMAILS = RAW.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export function isAllowedEmail(email) {
  const e = (email || "").trim().toLowerCase();
  return ALLOWED_EMAILS.includes(e);
}
