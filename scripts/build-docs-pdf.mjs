#!/usr/bin/env node
/* Builds the whole /docs set into one designed PDF.
 *
 * WHY THIS AND NOT A MARKDOWN TOOL: the runtime is twelve dependencies and that
 * is a feature. The docs use a small, known subset of markdown — headings,
 * tables, fences, lists, quotes, rules — so rendering it here costs less than
 * another dependency tree. Playwright is already present (for the LinkedIn
 * agent) and its Chromium gives real print CSS and embedded fonts, which is
 * what makes the output look like a document rather than a web page saved to
 * paper.
 *
 * Run: node scripts/build-docs-pdf.mjs        (or: npm run docs:pdf)
 *      node scripts/build-docs-pdf.mjs --html (keep the intermediate HTML)
 *
 * Needs a network on first run for the three Google fonts. Without it the
 * fallbacks are used and the output is plainer but correct.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { chromium } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const OUT = join(ROOT, "docs/Karma-Connect-Technical-Reference.pdf");

/* Reading order, grouped into parts. This is a deliberate narrative: what the
   product is, then how it is built, then how to run it, then how to change it,
   then why it is like that, then what is still owed. It is NOT the order the
   files were written in. */
const PARTS = [
  {
    part: "Preface", docs: [
      ["README.md", "About this documentation", "How it was written, and how much to trust it"],
    ],
  },
  {
    part: "Part One · The product", docs: [
      ["PROJECT.md", "The product", "What it is, who uses it, what it is not"],
      ["product/FEATURES.md", "Features", "What exists, who can reach it, how you would know it works"],
    ],
  },
  {
    part: "Part Two · How it is built", docs: [
      ["architecture/ARCHITECTURE.md", "Architecture", "One process, two products, two databases"],
      ["architecture/DATABASE.md", "The data", "21 tables, the invariants, and the known data problems"],
      ["architecture/API.md", "API", "133 routes, generated from the source"],
      ["architecture/SECURITY.md", "Security", "What is enforced, where, and the gaps"],
      ["architecture/INTEGRATIONS.md", "External services", "Ten dependencies and how each one fails"],
    ],
  },
  {
    part: "Part Three · Running it", docs: [
      ["operations/RUNBOOK.md", "Runbook", "What is set where, what breaks without it, how to check"],
    ],
  },
  {
    part: "Part Four · Working on it", docs: [
      ["ai/PROJECT-MEMORY.md", "Project memory", "What to know before editing"],
      ["ai/AI-RULES.md", "Rules for changing this codebase", "Aimed at an agent; they are just good rules"],
    ],
  },
  {
    part: "Part Five · Decisions", docs: [
      ["decisions/ADR-001-merge-at-the-app-layer.md", "ADR-001", "Merge at the app layer, not the data layer"],
      ["decisions/ADR-002-owner-tier-lives-in-the-environment.md", "ADR-002", "The owner tier lives in the environment"],
      ["decisions/ADR-003-scheduled-work-is-triggered-from-outside.md", "ADR-003", "Scheduled work is triggered from outside"],
      ["decisions/ADR-004-map-geometry-is-generated-offline.md", "ADR-004", "Map geometry is generated offline"],
    ],
  },
  {
    part: "Part Six · What is still owed", docs: [
      ["OUTSTANDING.md", "Outstanding", "What is missing, what needs a decision, what was fixed in passing"],
    ],
  },
];

const DOCS = PARTS.flatMap((p) => p.docs.map(([file, title, blurb]) => ({
  file, title, blurb, part: p.part, id: docId(file),
})));

function docId(file) {
  return basename(file, ".md").toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/* ── markdown ─────────────────────────────────────────────────────────────
   A focused renderer for the subset these documents use. Anything it does not
   know about passes through as a paragraph, which is visible rather than
   silent. */

const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* GitHub's heading-anchor rules, because the documents already link to each
   other using them (e.g. "#the-owner-column-is-free-text"). Emoji and
   punctuation are dropped, which is why "### ⚠️ The old service…" becomes
   "-the-old-service…" with a leading hyphen — that is correct, not a bug. */
const slug = (text) => text.toLowerCase()
  .replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-");

const BY_BASENAME = new Map(DOCS.map((d) => [basename(d.file), d]));

function href(text, target, doc) {
  const label = text;
  if (/^https?:\/\//.test(target))
    return `<a class="ext" href="${esc(target)}">${label}</a>`;
  if (target.startsWith("#"))
    return `<a href="#${doc.id}--${target.slice(1)}">${label}</a>`;
  const md = target.match(/^([^#]*\.md)(?:#(.*))?$/);
  if (md) {
    const other = BY_BASENAME.get(basename(md[1]));
    if (other) {
      const anchor = md[2] ? `${other.id}--${md[2]}` : other.id;
      return `<a href="#${anchor}">${label}</a>`;
    }
  }
  /* A path into the source tree. Clickable in a repo, dead in a PDF, so it is
     typeset as a reference instead of pretending to be a link. */
  return `<span class="srcref">${label}</span>`;
}

function inline(src, doc) {
  const codes = [];
  let s = String(src).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c); return `\u0001${codes.length - 1}\u0001`;
  });
  s = esc(s);
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, t, u) => href(t, u, doc));
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  return s;
}

/* Callout detection. A paragraph or quote that opens with a warning sign, or
   that carries DECISION REQUIRED / ACTION, is a different kind of statement
   from prose around it and is set differently. */
function calloutClass(text) {
  if (/DECISION REQUIRED/.test(text)) return "callout decision";
  if (/^\s*⚠️|^\s*⚠/.test(text) || /⚠️ \*\*/.test(text)) return "callout warn";
  if (/`ACTION`/.test(text)) return "callout action";
  return "";
}

const PIPE = "\u0002";   // stands in for an escaped \| while a row is split

function renderTable(rows, doc) {
  const cells = (line) => line
    .replace(/\\\|/g, PIPE)
    .replace(/^\s*\|/, "").replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.replace(new RegExp(PIPE, "g"), "|").trim());

  const head = cells(rows[0]);
  const align = cells(rows[1]).map((d) =>
    /^:-+:$/.test(d) ? "center" : /-+:$/.test(d) ? "right" : "left");
  const body = rows.slice(2).map(cells);

  const th = head.map((h, i) =>
    `<th style="text-align:${align[i] || "left"}">${inline(h, doc)}</th>`).join("");
  const tr = body.map((r) => "<tr>" + r.map((c, i) =>
    `<td style="text-align:${align[i] || "left"}">${inline(c, doc)}</td>`).join("") + "</tr>").join("\n");

  /* A table whose first column is narrow and whose rows are one line each is a
     reference table; wide prose tables get a looser class. Judged on the
     longest cell, which is crude and right often enough. */
  const widest = Math.max(...body.map((r) => Math.max(...r.map((c) => c.length), 0)), 0);
  const cls = widest > 90 ? "t-prose" : "t-ref";
  return `<table class="${cls}"><thead><tr>${th}</tr></thead><tbody>\n${tr}\n</tbody></table>`;
}

function renderMarkdown(md, doc) {
  const lines = md.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const out = [];
  const headings = [];
  let i = 0;
  let firstH1 = true;

  const para = [];
  const flushPara = () => {
    if (!para.length) return;
    const text = para.join(" ");
    const cls = calloutClass(text);
    out.push(cls ? `<div class="${cls}">${inline(text, doc)}</div>`
                 : `<p>${inline(text, doc)}</p>`);
    para.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    /* fenced code */
    if (/^```/.test(t)) {
      flushPara();
      const lang = t.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) buf.push(lines[i++]);
      i++;
      /* A wide block is usually an ASCII diagram; it must not wrap, so it is
         set a size down rather than reflowed into nonsense. */
      const w = Math.max(...buf.map((b) => b.length), 0);
      const cls = w > 78 ? "code wide" : "code";
      out.push(`<pre class="${cls}"${lang ? ` data-lang="${esc(lang)}"` : ""}>` +
        `<code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    /* table */
    if (t.startsWith("|") && /^\|[\s:|-]+\|?\s*$/.test((lines[i + 1] || "").trim())) {
      flushPara();
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(lines[i++]);
      out.push(renderTable(rows, doc));
      continue;
    }

    /* heading */
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const level = h[1].length;
      const text = h[2].replace(/\s+$/, "");
      if (level === 1 && firstH1) { firstH1 = false; i++; continue; }  // chapter opener carries it
      const id = `${doc.id}--${slug(text)}`;
      headings.push({ level, text: text.replace(/[*`]/g, ""), id });
      out.push(`<h${level} id="${id}">${inline(text, doc)}</h${level}>`);
      i++;
      continue;
    }

    /* horizontal rule */
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushPara(); out.push('<hr />'); i++; continue;
    }

    /* blockquote */
    if (t.startsWith(">")) {
      flushPara();
      const buf = [];
      while (i < lines.length && lines[i].trim().startsWith(">"))
        buf.push(lines[i++].trim().replace(/^>\s?/, ""));
      const text = buf.join(" ");
      const cls = calloutClass(text) || "quote";
      out.push(`<div class="${cls}">${inline(text, doc)}</div>`);
      continue;
    }

    /* list — bullets and ordered, with indentation for nesting, and an
       indented non-bullet line continuing the item above it */
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      flushPara();
      out.push(renderList(lines, doc, (n) => { i = n; }, i));
      continue;
    }

    if (!t) { flushPara(); i++; continue; }

    para.push(t);
    i++;
  }
  flushPara();
  return { html: out.join("\n"), headings };
}

/* Returns the list HTML and moves the caller's cursor past it. */
function renderList(lines, doc, setI, start) {
  let i = start;
  const items = [];   // {indent, ordered, parts:[]}
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    const m = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (m) {
      items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), parts: [m[3]] });
      i++; continue;
    }
    /* continuation of the previous item */
    if (t && items.length && /^\s+/.test(line)) { items.at(-1).parts.push(t); i++; continue; }
    break;
  }
  setI(i);

  /* Build nested lists from the indent column. */
  const render = (from, indent) => {
    const html = [];
    let k = from;
    const ordered = items[from].ordered;
    html.push(ordered ? "<ol>" : "<ul>");
    while (k < items.length && items[k].indent >= indent) {
      if (items[k].indent > indent) {
        const [sub, next] = [render(k, items[k].indent), null];
        html.push(sub.html);
        k = sub.end;
        continue;
      }
      html.push(`<li>${inline(items[k].parts.join(" "), doc)}</li>`);
      k++;
    }
    html.push(ordered ? "</ol>" : "</ul>");
    return { html: html.join("\n"), end: k };
  };
  return render(0, items[0].indent).html;
}

/* ── transforms on specific files ────────────────────────────────────────── */

function preprocess(file, md) {
  /* The README's index duplicates the table of contents two pages later.
     Printing both would be sloppy. */
  if (basename(file) === "README.md")
    md = md.replace(/\n## Index\n[\s\S]*?(?=\n## )/, "\n");

  /* "see DATABASE.md" is right in a repo and meaningless in a bound document —
     there are no files here, only chapters. A link whose label is nothing but
     a filename is relabelled with the chapter's title. Labels that say
     something ("RUNBOOK §The 7am digest") are left alone. */
  md = md.replace(/\[`?([A-Za-z0-9_./-]+\.md)`?\]\(([^)]+)\)/g, (m, name, target) => {
    const d = BY_BASENAME.get(basename(name));
    return d ? `[${d.title}](${target})` : m;
  });
  return md;
}

/* ── assembly ─────────────────────────────────────────────────────────────── */

const chapters = [];
let n = 0;
for (const doc of DOCS) {
  const path = join(ROOT, "docs", doc.file);
  if (!existsSync(path)) { console.warn(`skipped (missing): ${doc.file}`); continue; }
  const md = preprocess(doc.file, readFileSync(path, "utf8"));
  const { html, headings } = renderMarkdown(md, doc);
  const numbered = doc.part !== "Preface";
  if (numbered) n++;
  chapters.push({ ...doc, html, headings, number: numbered ? n : null });
}

const stamp = new Date().toLocaleDateString("en-GB",
  { day: "numeric", month: "long", year: "numeric" });
let sha = "";
try { sha = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim(); } catch { /* not a repo */ }

/* Contents. Sections are listed inline under their chapter rather than one per
   line: as a stacked list this ran to three pages, which is a wall rather than
   a way in. ADRs are skipped because all four have the same five sections
   (Context, Options, Decision, Reason, Tradeoffs) and printing that twenty
   times says nothing. */
const toc = [];
let lastPart = "";
for (const c of chapters) {
  if (c.part !== lastPart) { toc.push(`<div class="toc-part">${esc(c.part)}</div>`); lastPart = c.part; }
  const subs = c.file.includes("ADR-") ? [] : c.headings.filter((x) => x.level === 2);
  toc.push(
    `<div class="toc-group"><div class="toc-ch"><a href="#${c.id}">` +
    `<span class="toc-n">${c.number ?? ""}</span>` +
    `<span class="toc-t">${esc(c.title)}</span></a></div>` +
    (subs.length
      ? `<div class="toc-s">` + subs.map((h) =>
          `<a href="#${h.id}">${esc(h.text)}</a>`).join('<i>·</i>') + `</div>`
      : `<div class="toc-s muted">${esc(c.blurb)}</div>`) +
    `</div>`);
}

const body = chapters.map((c) => `
<section class="chapter" id="${c.id}">
  <header class="opener">
    <div class="eyebrow">${esc(c.part)}</div>
    <h1>${c.number ? `<span class="chno">${c.number}</span>` : ""}${esc(c.title)}</h1>
    <p class="blurb">${esc(c.blurb)}</p>
  </header>
  ${c.html}
</section>`).join("\n");

const CSS = `
:root{
  /* The product's own palette, taken from leads/public/app.css, so the
     document reads as part of the thing it describes. Dark navy is the app's
     background; on paper it becomes the ink. */
  --ink:#1c2433; --ink-strong:#081224; --muted:#5f6a7d; --faint:#8b95a6;
  --rule:#e1e5ec; --rule-soft:#eef1f5;
  --accent:#2f54eb; --accent-soft:#eef1fd; --accent-ink:#2545c8;
  --gold:#8a6100; --gold-soft:#fdf6e6; --gold-rule:#e8d9ae;
  --good:#0a6b43; --good-soft:#eaf6f0;
  --code-bg:#f7f8fb; --code-rule:#e6eaf1;
}
@page{ size:A4; margin:19mm 17mm 17mm 17mm; }

*{ box-sizing:border-box; }
html{ -webkit-print-color-adjust:exact; print-color-adjust:exact; }
body{
  margin:0; color:var(--ink); background:#fff;
  font:10.3pt/1.62 "Source Serif 4","Source Serif Pro",Georgia,serif;
  font-variant-numeric:tabular-nums lining-nums;
  text-rendering:geometricPrecision;
}
p{ margin:0 0 .62em; orphans:2; widows:2; }
strong{ color:var(--ink-strong); font-weight:600; }
em{ font-style:italic; }
a{ color:var(--accent-ink); text-decoration:none; border-bottom:.4pt solid #c3cdf5; }
a.ext{ border-bottom-style:dotted; }
.srcref{
  font:8.2pt/1.4 "JetBrains Mono","Cascadia Mono",Consolas,monospace;
  color:var(--muted); white-space:nowrap;
}
code{
  font:.85em/1.35 "JetBrains Mono","Cascadia Mono",Consolas,"DejaVu Sans Mono",monospace;
  background:var(--code-bg); border:.4pt solid var(--code-rule);
  border-radius:2pt; padding:.3pt 1.6pt; color:var(--ink-strong);
  /* the padding otherwise opens a visible gap before a following comma */
  margin:0 -.2pt;
}

/* ── cover ── */
/* The composition is three bands: mark at the top, the title block set on the
   upper-middle third, and the imprint pinned to the foot. An earlier version
   pushed everything to the bottom with one auto margin and left a dead void
   through the middle of the page. */
.cover{ height:247mm; display:flex; flex-direction:column; break-after:page; }
.cover .mark{ display:flex; gap:3pt; margin:0 0 62mm; }
.cover .mark i{ display:block; width:13pt; height:13pt; border-radius:2pt; }
.cover h1{
  font:600 33pt/1.1 Inter,"Segoe UI",system-ui,sans-serif;
  letter-spacing:-.9pt; color:var(--ink-strong); margin:0 0 6pt;
}
.cover .sub{
  font:400 14.5pt/1.35 "Source Serif 4",Georgia,serif;
  color:var(--muted); margin:0 0 20pt; max-width:125mm;
}
.cover .rule{ height:2.2pt; background:var(--ink-strong); width:52mm; margin:0; }
/* The stats sit with the imprint at the foot rather than under the title, so
   the page has ONE band of air (between the rule and the stats) instead of two
   smaller voids that read as a mistake. */
.cover .stats{ display:flex; gap:11mm; margin:auto 0 17pt; }
.cover .stat b{
  display:block; font:600 17pt/1 Inter,system-ui,sans-serif;
  color:var(--ink-strong); letter-spacing:-.4pt;
}
.cover .stat span{
  font:400 7.6pt/1.3 Inter,system-ui,sans-serif; color:var(--faint);
  text-transform:uppercase; letter-spacing:.9pt;
}
.cover .meta{
  font:400 8.6pt/1.7 Inter,system-ui,sans-serif; color:var(--muted);
  border-top:.5pt solid var(--rule); padding-top:9pt;
}
.cover .meta b{ color:var(--ink-strong); font-weight:500; }

/* ── contents ── */
.contents{ break-after:page; }
.contents h2{
  font:600 9pt/1 Inter,system-ui,sans-serif; letter-spacing:1.6pt;
  text-transform:uppercase; color:var(--faint);
  border-bottom:.5pt solid var(--rule); padding-bottom:7pt; margin:0 0 15pt;
}
.toc-part{
  font:600 7.8pt/1 Inter,system-ui,sans-serif; letter-spacing:1.3pt;
  text-transform:uppercase; color:var(--accent-ink);
  margin:15pt 0 7pt; padding-bottom:4pt; border-bottom:.4pt solid var(--rule-soft);
}
.toc-part:first-child{ margin-top:0; }
.toc-group{ break-inside:avoid; margin:0 0 8pt; }
.toc-ch a{ display:flex; gap:7pt; border:0; align-items:baseline; }
.toc-ch{ margin:0 0 1.5pt; }
.toc-n{
  font:600 8.4pt/1.5 Inter,system-ui,sans-serif; color:var(--faint);
  min-width:11pt; text-align:right;
}
.toc-t{ font:600 11pt/1.4 Inter,system-ui,sans-serif; color:var(--ink-strong); letter-spacing:-.15pt; }
.toc-s{ margin:0 0 0 18pt; font:400 8.7pt/1.5 "Source Serif 4",Georgia,serif; }
.toc-s a{ color:var(--muted); border:0; }
.toc-s i{ color:var(--faint); font-style:normal; margin:0 4pt; }
.toc-s.muted{ color:var(--faint); font-style:italic; }

/* ── chapter openers ── */
.chapter{ break-before:page; }
.opener{ margin:0 0 17pt; padding-bottom:11pt; border-bottom:1.6pt solid var(--ink-strong); }
.eyebrow{
  font:600 7.6pt/1 Inter,system-ui,sans-serif; letter-spacing:1.5pt;
  text-transform:uppercase; color:var(--accent-ink); margin-bottom:9pt;
}
.opener h1{
  font:600 24pt/1.12 Inter,system-ui,sans-serif; letter-spacing:-.75pt;
  color:var(--ink-strong); margin:0 0 5pt; display:flex; align-items:baseline; gap:9pt;
}
.chno{
  font:600 12pt/1 Inter,system-ui,sans-serif; color:#fff; background:var(--ink-strong);
  border-radius:3pt; padding:4.5pt 6.5pt; letter-spacing:0;
}
.blurb{ font:400 11pt/1.45 "Source Serif 4",Georgia,serif; color:var(--muted); margin:0; }

/* ── headings ── */
h2,h3,h4{ color:var(--ink-strong); break-after:avoid; font-family:Inter,system-ui,sans-serif; }
h2{
  font-size:13.6pt; font-weight:600; letter-spacing:-.35pt; line-height:1.25;
  margin:20pt 0 7pt; padding-bottom:4.5pt; border-bottom:.5pt solid var(--rule);
}
h3{ font-size:10.9pt; font-weight:600; letter-spacing:-.15pt; margin:14pt 0 5pt; }
h4{ font-size:9.5pt; font-weight:600; margin:11pt 0 4pt; color:var(--muted);
    text-transform:uppercase; letter-spacing:.7pt; }
h2+h3,h3+h4{ margin-top:7pt; }

hr{ border:0; border-top:.5pt solid var(--rule); margin:16pt 0; }

/* ── lists ── */
ul,ol{ margin:0 0 .65em; padding-left:15pt; }
li{ margin:0 0 .3em; orphans:2; widows:2; }
li::marker{ color:var(--faint); }
ul ul,ol ol,ul ol,ol ul{ margin:.3em 0 .1em; }

/* ── tables ── */
table{
  width:100%; border-collapse:collapse; margin:9pt 0 13pt;
  font:8.7pt/1.45 Inter,system-ui,sans-serif;
  font-variant-numeric:tabular-nums lining-nums;
}
thead{ display:table-header-group; }
tr{ break-inside:avoid; }
th{
  font-weight:600; font-size:7.7pt; letter-spacing:.7pt; text-transform:uppercase;
  color:#fff; background:var(--ink-strong); padding:5pt 6pt; vertical-align:bottom;
}
td{ padding:4.6pt 6pt; border-bottom:.4pt solid var(--rule-soft); vertical-align:top; }
tbody tr:nth-child(even) td{ background:#fafbfd; }
table.t-ref td:first-child{ font-weight:500; color:var(--ink-strong); }
table.t-prose{ font-size:8.5pt; }
td code{ font-size:.84em; white-space:nowrap; }
td strong{ font-weight:600; }

/* ── code ── */
pre.code{
  background:var(--code-bg); border:.5pt solid var(--code-rule);
  border-left:2pt solid var(--accent); border-radius:2.5pt;
  padding:8pt 10pt; margin:9pt 0 12pt; overflow:hidden; break-inside:avoid;
}
pre.code code{
  background:none; border:0; padding:0; display:block; white-space:pre;
  font-size:8.2pt; line-height:1.48; color:#25304a;
}
pre.code.wide code{ font-size:7.1pt; line-height:1.42; }
pre.code[data-lang]::before{
  content:attr(data-lang); display:block; float:right;
  font:600 6.4pt/1 Inter,system-ui,sans-serif; letter-spacing:1pt;
  text-transform:uppercase; color:var(--faint);
}

/* ── quotes and callouts ── */
.quote,.callout{
  margin:9pt 0 12pt; padding:8pt 11pt; border-radius:3pt;
  break-inside:avoid; font-size:9.9pt;
}
.quote{ background:#fafbfd; border-left:2pt solid var(--rule); color:var(--muted); }
.callout.warn{ background:var(--gold-soft); border-left:2.4pt solid var(--gold); }
.callout.warn strong{ color:var(--gold); }
.callout.decision{ background:var(--accent-soft); border-left:2.4pt solid var(--accent); }
.callout.decision strong{ color:var(--accent-ink); }
.callout.action{ background:var(--good-soft); border-left:2.4pt solid var(--good); }
.callout.action strong{ color:var(--good); }
`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Karma Connect &middot; Karma Leads — Technical Reference</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${CSS}</style></head>
<body>

<section class="cover">
  <div class="mark">
    <i style="background:#081224"></i><i style="background:#2f54eb"></i>
    <i style="background:#52d39e"></i><i style="background:#FFCF00"></i>
  </div>
  <h1>Karma Connect<br>&amp; Karma Leads</h1>
  <p class="sub">Technical reference — the product, the architecture, the data,
     and how to run it without guessing.</p>
  <div class="rule"></div>
  <div class="stats">
    <div class="stat"><b>36,619</b><span>Leads</span></div>
    <div class="stat"><b>133</b><span>API routes</span></div>
    <div class="stat"><b>21</b><span>Tables</span></div>
    <div class="stat"><b>116</b><span>Tests</span></div>
    <div class="stat"><b>11</b><span>People</span></div>
  </div>
  <div class="meta">
    <b>Karma Staff</b> · internal · ${chapters.length} chapters<br>
    Written from the running system on <b>${stamp}</b>${sha ? ` · commit <b>${sha}</b>` : ""}<br>
    Regenerate with <b>npm run docs:pdf</b>
  </div>
</section>

<section class="contents">
  <h2>Contents</h2>
  ${toc.join("\n  ")}
</section>

${body}
</body></html>`;

const htmlPath = join(ROOT, "docs/.reference.html");
writeFileSync(htmlPath, html);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("file:///" + htmlPath.replace(/\\/g, "/"), { waitUntil: "load" });
try { await page.evaluate(() => document.fonts.ready); } catch { /* fallbacks */ }
await page.emulateMedia({ media: "print" });

const foot = (inner) => `<div style="width:100%;font:7.6pt Inter,system-ui,sans-serif;
  color:#8b95a6;padding:0 17mm;display:flex;justify-content:space-between;">${inner}</div>`;

await page.pdf({
  path: OUT,
  format: "A4",
  printBackground: true,
  /* Bookmarks built from the headings, so an 80-page reference is navigable
     from the reader's sidebar rather than only by scrolling. `tagged` also
     gives it a real reading order for screen readers. */
  outline: true,
  tagged: true,
  displayHeaderFooter: true,
  headerTemplate: "<div></div>",
  margin: { top: "19mm", bottom: "15mm", left: "17mm", right: "17mm" },
  footerTemplate: foot(
    `<span>Karma Connect &amp; Karma Leads — Technical Reference</span>
     <span class="pageNumber"></span>`),
});
await browser.close();

if (!process.argv.includes("--html")) {
  try { (await import("node:fs")).unlinkSync(htmlPath); } catch { /* fine */ }
}

const size = readFileSync(OUT).length;
const pages = (readFileSync(OUT, "latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
console.log(`wrote docs/${basename(OUT)} — ${chapters.length} chapters, ` +
  `~${pages} pages, ${(size / 1024 / 1024).toFixed(2)} MB`);
