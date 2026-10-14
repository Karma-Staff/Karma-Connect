#!/usr/bin/env node
/* Generates docs/architecture/API.md from the source.
 *
 * WHY GENERATED: a hand-written list of 120 routes is wrong within a week and
 * nobody notices, because nothing compares it to the code. This reads the
 * route declarations themselves, so the document is either current or the
 * script is broken — and a broken script is loud.
 *
 * Run: node scripts/gen-api-docs.mjs          (writes the file)
 *      node scripts/gen-api-docs.mjs --check  (exits 1 if it is out of date)
 *
 * The parse is deliberately simple: a regex over `app.METHOD("path", ...)` and
 * `router.METHOD("path", ...)`. It does not evaluate the code, so a route
 * built from a computed string would be missed. None currently are, and the
 * totals are printed so a mismatch with reality is visible.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not .pathname: the URL form keeps %20 for spaces ("OneDrive - Karma Staff")
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "docs/architecture/API.md");

/* Which files hold routes, and which half of the product they belong to. */
const SOURCES = [
  { half: "Connect", files: ["server.js"] },
  { half: "Connect", dir: "server", match: /\.cjs$/ },
  { half: "Connect", dir: "api", match: /^_proxy\.cjs$/ },
  { half: "Leads", dir: "leads/server", match: /\.js$/, skip: /\.test\.js$/ },
];

const METHODS = "get|post|put|patch|delete|all";
/* The first argument is a string OR an array of strings — `router.use(["/api/leads",
   "/api/comments"], requireUser)` is how several routers scope their auth, and an
   earlier version of this script missed exactly those, which made a dozen properly
   guarded routes look wide open. Match both. */
const ROUTE = new RegExp(
  `\\b(?:app|router)\\.(${METHODS}|use)\\(\\s*(\\[[^\\]]*\\]|(["'\`])[^"'\`]+\\3)([^\\n]*)`, "g");

/* "/a" -> ["/a"];  '["/a", "/b"]' -> ["/a","/b"] */
const pathsIn = (raw) =>
  [...raw.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);

/* Middleware names worth reporting. Anything else in the argument list is
   noise (body parsers, rate limiters we name explicitly, inline handlers). */
const GUARDS = [
  ["requireOwner", "owner"],
  ["requireAdmin", "admin"],
  ["requireRank", "rank"],
  ["requireOwnLead", "own lead"],
  ["requireUser", "signed in"],
  ["requireService", "service token"],
  ["serviceAuth", "service token"],
];

/* Guards are sometimes aliased to a local name, e.g.
     const gate = requireScope("imports:write", requireAdmin);
   so the route reads `router.post("/api/import-jobs", gate, …)` and a search
   for "requireAdmin" finds nothing. Resolve those per file before matching. */
function aliasesIn(text) {
  const out = [];
  for (const m of text.matchAll(
    /const\s+(\w+)\s*=\s*requireScope\(\s*["']([^"']+)["']/g))
    out.push([m[1], `service token (${m[2]}) or admin`]);
  for (const m of text.matchAll(
    /const\s+(\w+)\s*=\s*(?:auth\.)?(requireOwner|requireAdmin|requireUser)\b/g)) {
    const label = GUARDS.find(([n]) => n === m[2])?.[1];
    if (label) out.push([m[1], label]);
  }
  return out;
}

const guardsIn = (tail, aliases = []) => {
  const found = [];
  const add = (l) => { if (l && !found.includes(l)) found.push(l); };
  for (const [needle, label] of GUARDS) if (tail.includes(needle)) add(label);
  /* aliases matched on a word boundary — "gate" must not match "gateway" */
  for (const [name, label] of aliases)
    if (new RegExp(`\\b${name}\\b`).test(tail)) add(label);
  if (/\b\w*[Ll]imiter\b/.test(tail)) add("rate-limited");
  return found;
};

function filesFor(src) {
  if (src.files) return src.files.filter((f) => existsSync(join(ROOT, f)));
  const dir = join(ROOT, src.dir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => src.match.test(f) && !(src.skip && src.skip.test(f)))
    .map((f) => `${src.dir}/${f}`)
    .sort();
}

const routes = [];
const prefixGuards = [];   // router.use("/api/bulk", requireAdmin) style

for (const src of SOURCES) {
  for (const rel of filesFor(src)) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    const lines = text.split("\n");
    const aliases = aliasesIn(text);
    for (const m of text.matchAll(ROUTE)) {
      const [, method, rawPath, , tail] = m;
      const line = text.slice(0, m.index).split("\n").length;
      const guards = guardsIn(tail, aliases);
      for (const path of pathsIn(rawPath)) {
        if (!path.startsWith("/api")) continue;
        if (method === "use") {
          /* A `use` with a path and a guard protects everything beneath it.
             That is how /api/bulk/* is admin-only without saying so per route. */
          if (guards.length)
            prefixGuards.push({ path, guards, half: src.half, file: rel, line });
          continue;
        }
        routes.push({
          half: src.half, method: method.toUpperCase(), path, guards,
          file: rel, line, comment: leadingComment(lines, line),
        });
      }
    }
  }
}

/* The first sentence of the comment block above a route.
 *
 * Taking the nearest line instead gives you the *last* line of a paragraph —
 * "ways to end up half-recorded." — which reads as gibberish in a table. So
 * walk up while the lines are still comments, then read down from the top.
 * Divider lines (`----- working it -----`) are not prose and are skipped. */
/* Declarations, not consts: leadingComment is called from the scan loop above,
   and a const in this position is not yet initialised when that runs. */
function isComment(t) { return /^(\/\/|\/\*|\*)/.test(t); }
function strip(t) { return t.replace(/^\/\*+|^\/\/+|^\*+\/?|\*\/$/g, "").trim(); }
function isDivider(t) { return !/[a-z]{3}/.test(t) || /^-{4,}|-{4,}$/.test(t); }

function leadingComment(lines, line) {
  const at = (i) => (lines[i] || "").trim();
  const last = line - 2;                               // 0-based: the line above
  if (last < 0) return "";

  /* Two comment shapes, and the second one is why an earlier version of this
     found nothing. This codebase writes block comments as
         /* How many are callable, before committing to a session.
            asks this so nobody presses go on an empty list. * /
     so the line immediately above a route often starts with a WORD, not with
     `*`. Testing only that line for "looks like a comment" fails. */
  let top;
  if (at(last).startsWith("//")) {
    top = last;
    while (top > 0 && at(top - 1).startsWith("//")) top--;
  } else if (at(last).endsWith("*/")) {
    top = last;
    while (top > 0 && !at(top).includes("/*")) top--;
    if (!at(top).includes("/*")) return "";
  } else return "";

  const block = [];
  for (let i = top; i < line - 1; i++) {
    const c = strip(at(i));
    if (!c || isDivider(c)) { if (block.length) break; else continue; }
    block.push(c);
  }
  if (!block.length) return "";

  /* First sentence, or the first line if it does not end cleanly. */
  const text = block.join(" ").replace(/\s+/g, " ");
  const stop = text.search(/[.:]( |$)/);
  const out = stop > 12 ? text.slice(0, stop + 1) : text;
  return out.length > 96 ? out.slice(0, 93).trimEnd() + "…" : out;
}

/* Attach inherited guards. Longest matching prefix wins. */
for (const r of routes) {
  const owner = prefixGuards
    .filter((p) => r.path === p.path || r.path.startsWith(p.path.replace(/\/$/, "") + "/"))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (owner)
    for (const g of owner.guards)
      if (!r.guards.includes(g)) { r.guards.push(g); r.inherited = owner.path; }
}

/* Group by the path's second segment: /api/leads/... -> "leads". */
const groupOf = (p) => (p.split("/")[2] || "").split(":")[0] || "—";

const byHalf = {};
for (const r of routes) {
  byHalf[r.half] ??= {};
  (byHalf[r.half][groupOf(r.path)] ??= []).push(r);
}

const ORDER = { GET: 0, POST: 1, PUT: 2, PATCH: 3, DELETE: 4, ALL: 5 };
const sortRoutes = (a, b) =>
  a.path.localeCompare(b.path) || (ORDER[a.method] - ORDER[b.method]);

const esc = (s) => s.replace(/\|/g, "\\|");

let md = `<!-- GENERATED by scripts/gen-api-docs.mjs — do not edit by hand.
     Regenerate:  node scripts/gen-api-docs.mjs
     Verify:      node scripts/gen-api-docs.mjs --check  -->

# API

**${routes.length} routes**, generated from the source on ${new Date().toISOString().slice(0, 10)}.

Every path is absolute. That is deliberate: Karma Leads' API paths are the same
whether it runs standalone or mounted into Connect, which is what let its front
end survive the merge untouched ([ADR-001](../decisions/ADR-001-merge-at-the-app-layer.md)).

**Verified, not just parsed.** On 2026-09-28 all 43 parameterless \`GET\` paths
below were probed against a running server: **no 404s**, so the extraction is
not inventing routes. (Several returned 500 locally because that instance had no
Connect database and no Apify token — a configuration state, not a bad route.)

## Reading the guard column

| Guard | Meaning |
|---|---|
| *(blank)* | no authentication — check the handler before assuming that is wrong |
| \`signed in\` | any valid \`kc_session\` |
| \`own lead\` | a member may only reach leads assigned to them; **404, not 403**, so they cannot learn the lead exists |
| \`admin\` | rank ≥ admin. A **rank comparison**, never \`=== "admin"\` |
| \`owner\` | rank ≥ owner. Conferred by \`OWNER_EMAILS\` ([ADR-002](../decisions/ADR-002-owner-tier-lives-in-the-environment.md)) |
| \`service token\` | a machine caller, hashed token in \`service_tokens\` |
| \`rate-limited\` | carries an explicit limiter |

A guard marked *(inherited)* comes from a \`router.use\` on a path prefix rather
than from the route's own argument list — the protection is real, it is just
declared once for the group.
`;

if (prefixGuards.length) {
  md += `\n### Guards applied to whole prefixes\n\n| Prefix | Guard | Where |\n|---|---|---|\n`;
  for (const p of prefixGuards.sort((a, b) => a.path.localeCompare(b.path)))
    md += `| \`${p.path}\` | ${p.guards.join(", ")} | [${p.file}:${p.line}](../../${p.file}#L${p.line}) |\n`;
}

for (const half of ["Leads", "Connect"]) {
  const groups = byHalf[half];
  if (!groups) continue;
  const n = Object.values(groups).reduce((a, g) => a + g.length, 0);
  md += `\n---\n\n## Karma ${half} — ${n} routes\n`;
  for (const g of Object.keys(groups).sort()) {
    md += `\n### \`/api/${g}\`\n\n| Method | Path | Guard | Source | |\n|---|---|---|---|---|\n`;
    for (const r of groups[g].sort(sortRoutes)) {
      const guard = r.guards.length
        ? r.guards.join(", ") + (r.inherited ? " *(inherited)*" : "")
        : "—";
      md += `| ${r.method} | \`${esc(r.path)}\` | ${guard} | [${r.file}:${r.line}](../../${r.file}#L${r.line}) | ${esc(r.comment)} |\n`;
    }
  }
}

md += `
---

## What this cannot tell you

The generator reads route declarations, not behaviour. It does not know:

- **what a route returns.** Read the handler.
- **routes built from computed paths.** None exist today; if one is added it
  will be missing here silently. The total above is the check.
- **whether a guard is sufficient.** \`signed in\` on a route that mutates other
  people's data would look correct in this table and be wrong.
- **client-side gating.** \`.admin-only\` in the CSS is presentation. The server
  is the only thing that enforces anything.
- **which branch actually registers.** \`/api/auth/login\`, \`/api/auth/callback\`
  and \`/api/auth/logout\` each appear twice from \`leads/server/auth.js\`. They are
  not duplicates: the second set is the \`else\` branch that renders "Sign-in is
  not configured" when the WorkOS variables are missing. Only one set is ever
  mounted.

## Routes that are deliberately open

Fifteen routes are reachable without a session — **ten with no guard at all,
five behind a rate limiter only** — and none of them should be otherwise:

| Route | Why |
|---|---|
| \`POST /api/auth/signup\`, \`signin\`, \`forgot\`, \`reset\`, \`resend\` | you cannot require a session to get a session. These are the five that are rate-limited |
| \`GET /api/auth/verify\` | the link in a verification email |
| \`POST /api/auth/signout\`, \`POST /api/auth/logout\` | clearing a cookie must work even with a bad one |
| \`GET /api/auth/login\`, \`GET /api/auth/callback\` | the sign-in round trip |
| \`GET /api/health\` | the Render health check, which has no cookie |
| \`POST /api/cron/daily\` | the caller is a scheduler, not a person. It carries the \`CRON_TOKEN\` shared secret instead, compared in full, and **returns 503 when the token is unset rather than defaulting to open** |

If a future route appears in this list, that is the thing to look at first.
`;

const existing = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
const norm = (s) => s.replace(/generated from the source on \d{4}-\d{2}-\d{2}/, "");

if (process.argv.includes("--check")) {
  if (norm(existing) !== norm(md)) {
    console.error("API.md is out of date — run: node scripts/gen-api-docs.mjs");
    process.exit(1);
  }
  console.log(`API.md is current (${routes.length} routes)`);
} else {
  writeFileSync(OUT, md);
  const counts = {};
  for (const r of routes) counts[r.half] = (counts[r.half] || 0) + 1;
  console.log(`wrote ${relative(ROOT, OUT)} — ${routes.length} routes ` +
    `(${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}), ` +
    `${prefixGuards.length} prefix guards`);
  const open = routes.filter((r) => !r.guards.length);
  if (open.length) {
    console.log(`\n${open.length} routes with no detected guard — worth an eye:`);
    for (const r of open) console.log(`  ${r.method.padEnd(6)} ${r.path.padEnd(38)} ${r.file}:${r.line}`);
  }
}
