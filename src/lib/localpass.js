// Local (browser-only) password store for the soft access gate. NOT real security:
// it's per-browser and bypassable via dev tools. Used only when Supabase isn't configured.
// Passwords are hashed (SHA-256, salted by email) so plain text is never stored.
const STORE = "kc_pw_v1";

function load() {
  try { return JSON.parse(localStorage.getItem(STORE) || "{}") || {}; } catch (e) { return {}; }
}
function save(map) {
  try { localStorage.setItem(STORE, JSON.stringify(map)); } catch (e) {}
}
async function hash(email, pw) {
  const data = new TextEncoder().encode("kc::" + email.toLowerCase() + "::" + pw);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hasPassword(email) {
  return !!load()[(email || "").toLowerCase()];
}
export async function setPassword(email, pw) {
  const map = load();
  map[(email || "").toLowerCase()] = await hash(email, pw);
  save(map);
}
export async function verifyPassword(email, pw) {
  const map = load();
  const h = await hash(email, pw);
  return map[(email || "").toLowerCase()] === h;
}
export function clearPassword(email) {
  const map = load();
  delete map[(email || "").toLowerCase()];
  save(map);
}
