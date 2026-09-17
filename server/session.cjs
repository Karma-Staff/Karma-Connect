// The site's own sign-in session — the one both Karma products read.
//
// Why a cookie and not the bearer token Karma Connect used to carry: Karma
// Leads' front end never sets an Authorization header. It is 3,300 lines of
// vanilla JS that relies on the browser attaching a cookie by itself. A token
// in localStorage cannot be shared with it without rewriting every call it
// makes. A cookie is shared for free, and httpOnly means page scripts cannot
// read it at all — which the old localStorage token could not claim.
//
// The cookie holds a signed JWT, verified with the same HS256 helpers the AI
// proxy uses, so there is one signing secret (AUTH_JWT_SECRET) rather than two
// schemes to keep in step. Rotating that secret signs everybody out, which is
// the revocation lever.
const { signJWT, verifyJWT, JWT_ISS } = require("../api/_proxy.cjs");

const COOKIE = "kc_session";
const TTL_DAYS = 30;

const JWT_SECRET = process.env.AUTH_JWT_SECRET || "";

/* Secure only where there is TLS to be secure about: Render sets RENDER, and a
   Secure cookie on plain http://localhost is simply never stored, which would
   make local development impossible to sign into. */
const SECURE = (process.env.RENDER || process.env.NODE_ENV === "production") ? "; Secure" : "";

function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(/; */)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) {
      try { return decodeURIComponent(part.slice(i + 1)); } catch { return part.slice(i + 1); }
    }
  }
  return null;
}

/* Path=/ so the one cookie covers Karma Connect at / and Karma Leads at
   /leads. SameSite=Lax keeps it off cross-site requests while still arriving
   when someone follows a link into the app. */
function setSession(res, user) {
  if (!JWT_SECRET) throw new Error("AUTH_JWT_SECRET is not set — cannot sign in anyone.");
  const token = signJWT(
    { sub: user.id, email: String(user.email || "").toLowerCase() },
    JWT_SECRET,
    TTL_DAYS * 24 * 60 * 60,
  );
  res.append("Set-Cookie",
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; `
    + `Max-Age=${TTL_DAYS * 24 * 60 * 60}${SECURE}`);
  return token;
}

function clearSession(res) {
  res.append("Set-Cookie",
    `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE}`);
}

/* The verified claims, or null. Never throws: a malformed or expired cookie is
   simply "not signed in", the same as no cookie at all. */
function readSession(req) {
  if (!JWT_SECRET) return null;
  const raw = readCookie(req, COOKIE);
  if (!raw) return null;
  const claims = verifyJWT(raw, JWT_SECRET, JWT_ISS);
  if (!claims || !claims.sub) return null;
  return { id: claims.sub, email: String(claims.email || "").toLowerCase() };
}

module.exports = { COOKIE, setSession, clearSession, readSession, hasSecret: () => !!JWT_SECRET };
