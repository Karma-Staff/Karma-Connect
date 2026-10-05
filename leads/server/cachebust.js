"use strict";
/* Stamp index.html's ?v= from the files themselves, so nobody has to remember.

   The rule in leads/CLAUDE.md was "bump the ?v= cache-busters in index.html on
   every markup/script change", and it failed the way every manual step
   eventually does: app.js shipped twice while index.html still said v=76, so
   every browser that had already cached that URL kept serving the old file and
   never saw the fix. Nothing looked wrong — the deploy was green, the server
   had the new code, and the reps did not.

   A hash of the actual bytes cannot drift from the actual bytes. index.html
   keeps its hand-written ?v= in source (it is still a useful marker in a
   diff); this rewrites it on the way out.

   Cheap: the hash is computed from size and mtime, not by reading the files,
   and it is cached until one of them changes. In production that is once per
   deploy. */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PUBLIC = path.join(__dirname, "..", "public");
/* Only the files index.html actually references with a ?v=. A stylesheet
   added later without one is not silently covered, which is the honest
   behaviour — it would be worse to look after something we do not. */
const WATCHED = ["app.js", "app.css", "na-geo.js", "world-geo.js"];

let cache = { key: "", html: "", at: 0 };
const TTL_MS = 2000;            // in dev, notice an edit without a restart

function stamp() {
  const parts = [];
  for (const f of WATCHED) {
    try {
      const s = fs.statSync(path.join(PUBLIC, f));
      parts.push(`${f}:${s.size}:${s.mtimeMs}`);
    } catch { parts.push(f + ":missing"); }
  }
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 8);
}

/* Serve index.html with every ?v=<anything> replaced by one content stamp.
   Returns a middleware; anything that is not the document falls through to
   express.static untouched. */
function indexWithStamp() {
  const file = path.join(PUBLIC, "index.html");
  return (req, res, next) => {
    // only the document itself; every asset is served by express.static
    const p = req.path;
    if (p !== "/" && p !== "/index.html") return next();
    let html;
    try {
      const key = stamp();
      if (cache.key === key && Date.now() - cache.at < TTL_MS) {
        html = cache.html;
      } else {
        html = fs.readFileSync(file, "utf8").replace(/\?v=[0-9a-z.]+/gi, "?v=" + key);
        cache = { key, html, at: Date.now() };
      }
    } catch (e) {
      // if anything here breaks, the hand-written version is still correct
      return next();
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(html);
  };
}

module.exports = { indexWithStamp, stamp, WATCHED };
