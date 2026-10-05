/* Build the world map the Dashboard draws.
 *
 *   node leads/scripts/build-world-geo.mjs <ne_50m_admin_0_countries.geojson> <ne_50m_admin_1_states_provinces.geojson>
 *
 * Inputs are Natural Earth 1:50m (PUBLIC DOMAIN), from
 * github.com/nvkelso/natural-earth-vector/tree/master/geojson. Output is
 * leads/public/world-geo.js, a plain script that sets window.WORLD_GEO — the
 * same arrangement as na-geo.js: no map library, no tile server, nothing for
 * the CSP to allow. Generated; do not hand-edit, re-run this.
 *
 * Projection: Equal Earth (Šavrič, Patterson & Jenny, 2018). Equal-area like
 * the North America map's Albers, for the same reason — on a Mercator,
 * Greenland is the size of Africa and a reader takes size as meaning.
 * Antarctica is left out: no calls go there, and it would take a fifth of
 * the height.
 *
 * TIBET is drawn as its own region, on top of China, with its own outline,
 * fill, tooltip and label — a deliberate choice of this product, not Natural
 * Earth's default. It is the whole of Tibet: Ü-Tsang, Kham and Amdo, not
 * only the "Tibet Autonomous Region".
 *
 * Natural Earth has province borders but not the prefectures that Kham and
 * Amdo are made of, so the shape is assembled:
 *   whole provinces   Xizang (Ü-Tsang, western Kham) and Qinghai (most of
 *                     Amdo, Kham's Yushu and Golog) — real borders.
 *   clipped parts     the Tibetan west of Sichuan (Garzê, Ngawa, Muli),
 *                     southern Gansu (Kanlho / Gannan) and north-west Yunnan
 *                     (Dechen / Dêqên) — each cut from its real province
 *                     outline by a convex boundary drawn below, so every
 *                     edge Tibet shares with India, Nepal, Bhutan or Burma
 *                     is a real border, and only the eastern edge inside
 *                     China is approximated.
 * The parts overlap slightly and are drawn as one region (see the renderer:
 * an outline pass, then a fill pass, so no seams show).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "public", "world-geo.js");
const [SRC0, SRC1] = process.argv.slice(2);
if (!SRC0 || !SRC1) {
  console.error("usage: build-world-geo.mjs <admin-0 countries geojson> <admin-1 geojson>");
  process.exit(1);
}

/* Equal Earth. y is negated for SVG, which grows downward. */
const D = Math.PI / 180;
const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796;
const M = Math.sqrt(3) / 2;
function project([lon, lat]) {
  const lam = lon * D, theta = Math.asin(M * Math.sin(lat * D));
  const t2 = theta * theta, t6 = t2 * t2 * t2;
  const x = (2 * Math.sqrt(3) * lam * Math.cos(theta))
    / (3 * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)));
  const y = theta * (A1 + A2 * t2 + t6 * (A3 + A4 * t2));
  return [x, -y];
}

/* Douglas-Peucker, as in build-na-geo.mjs. */
function simplify(pts, tol) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    let far = -1, best = 0;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d2 = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      if (d2 > best) { best = d2; far = i; }
    }
    if (best > tol2 && far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const ringArea = (pts) => {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
    a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return Math.abs(a / 2);
};
const ringsOf = (g) => g.type === "Polygon" ? [g.coordinates[0]]
  : g.type === "MultiPolygon" ? g.coordinates.map((p) => p[0]) : [];

const TOL = 2.2e-3;           // projected units (~0.4px at 1000px wide)
const MIN_AREA = 4e-5;        // drop specks smaller than a couple of pixels

const shape = (geom) => ringsOf(geom)
  .map((r) => simplify(r.map(project), TOL))
  .filter((r) => r.length > 3 && ringArea(r) > MIN_AREA);

/* ---- countries ---- */
const c0 = JSON.parse(fs.readFileSync(SRC0, "utf8"));
const regions = [];
const seen = new Set();
for (const f of c0.features) {
  const p = f.properties;
  if (p.ADM0_A3 === "ATA") continue;                       // Antarctica
  /* ISO_A2_EH fills the -99s ISO_A2 leaves (France, Norway); anything still
     without a code keeps its A3, so every shape has a unique key. */
  let code = [p.ISO_A2_EH, p.ISO_A2].find((v) => v && v !== "-99") || p.ADM0_A3;
  if (seen.has(code)) code = p.ADM0_A3;
  seen.add(code);
  const rings = shape(f.geometry);
  if (!rings.length) continue;
  regions.push({ code, name: p.NAME || p.ADMIN, rings,
    label: p.LABEL_X != null ? project([p.LABEL_X, p.LABEL_Y]) : null });
}

/* ---- Tibet — Ü-Tsang, Kham and Amdo — drawn over China ---- */

/* Sutherland–Hodgman: the part of `subject` inside the CONVEX polygon
   `clip` (both [lon, lat] rings, clip wound either way). */
function clipConvex(subject, clip) {
  const area = clip.reduce((a, p, i) => {
    const q = clip[(i + 1) % clip.length];
    return a + (p[0] * q[1] - q[0] * p[1]);
  }, 0);
  const sgn = Math.sign(area);
  const inside = (p, a, b) => sgn * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) >= 0;
  const cross = (p, q, a, b) => {
    const d = (p[0] - q[0]) * (a[1] - b[1]) - (p[1] - q[1]) * (a[0] - b[0]);
    const t = ((p[0] - a[0]) * (a[1] - b[1]) - (p[1] - a[1]) * (a[0] - b[0])) / d;
    return [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
  };
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length], inp = out;
    out = [];
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j], q = inp[(j + 1) % inp.length];
      if (inside(q, a, b)) { if (!inside(p, a, b)) out.push(cross(p, q, a, b)); out.push(q); }
      else if (inside(p, a, b)) out.push(cross(p, q, a, b));
    }
  }
  return out.length > 2 ? [...out, out[0]] : [];
}

/* The cut lines, [lon, lat], convex, generous on the province-border sides
   (those edges come from the real outline) and approximate on the east. */
const TIBET_WHOLE = ["CN-XZ", "CN-QH"];
const TIBET_CUT = {
  /* Garzê, Ngawa and Muli: everything west of a line from Ngawa's eastern
     edge (~103.6°E) down past Kangding to Muli's south (~27.6°N) */
  "CN-SC": [[96.5, 34.6], [104.3, 34.6], [103.6, 31.3], [102.4, 29.0], [101.6, 27.6], [96.5, 27.6]],
  /* Kanlho (Gannan) */
  "CN-GS": [[100.6, 35.8], [103.9, 35.8], [104.5, 34.1], [103.8, 32.5], [100.6, 33.4]],
  /* Dechen (Dêqên) */
  "CN-YN": [[98.3, 29.4], [100.3, 29.4], [100.3, 26.9], [98.3, 26.4]],
};

const c1 = JSON.parse(fs.readFileSync(SRC1, "utf8"));
const byIso = new Map(c1.features.map((f) => [f.properties.iso_3166_2, f]));
const tibParts = [];
for (const iso of TIBET_WHOLE) {
  const f = byIso.get(iso);
  if (!f) { console.error(`${iso} not found in the admin-1 file`); process.exit(1); }
  tibParts.push(...ringsOf(f.geometry));
}
for (const [iso, cut] of Object.entries(TIBET_CUT)) {
  const f = byIso.get(iso);
  if (!f) { console.error(`${iso} not found in the admin-1 file`); process.exit(1); }
  for (const r of ringsOf(f.geometry)) {
    const part = clipConvex(r.slice(0, -1), cut);
    if (part.length) tibParts.push(part);
  }
}
const tibRings = tibParts
  .map((r) => simplify(r.map(project), TOL))
  .filter((r) => r.length > 3 && ringArea(r) > MIN_AREA);
/* Label in the middle of the whole plateau, not of the TAR alone. */
regions.push({ code: "TIB", name: "Tibet", rings: tibRings, overlay: true,
  parts: true, label: project([92.5, 33.2]) });

/* ---- frame ---- */
let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
for (const s of regions) for (const r of s.rings) for (const [x, y] of r) {
  if (x < x0) x0 = x; if (x > x1) x1 = x;
  if (y < y0) y0 = y; if (y > y1) y1 = y;
}
const W = 1000, scale = W / (x1 - x0), H = Math.round((y1 - y0) * scale);
const put = ([x, y]) => [(x - x0) * scale, (y - y0) * scale];

const shapes = {}, labels = {}, meta = {}, parts = {};
const order = [];
const ringPath = (r) => "M" + r.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L") + "Z";
for (const s of regions) {
  const rings = s.rings.map((r) => r.map(put));
  shapes[s.code] = rings.map(ringPath).join("");
  /* A region assembled from overlapping pieces is also shipped piece by
     piece: one path holding them all would let opposite windings cancel
     where they overlap and punch holes in it. */
  if (s.parts) parts[s.code] = rings.map(ringPath);
  let lab = s.label ? put(s.label) : null;
  if (!lab) {
    const big = rings.reduce((a, r) => (ringArea(r) > ringArea(a) ? r : a), rings[0]);
    lab = [big.reduce((a, p) => a + p[0], 0) / big.length, big.reduce((a, p) => a + p[1], 0) / big.length];
  }
  labels[s.code] = [Math.round(lab[0]), Math.round(lab[1])];
  meta[s.code] = { name: s.name, ...(s.overlay ? { overlay: true } : {}) };
  order.push(s.code);
}

const body = JSON.stringify({ width: W, height: H, shapes, parts, labels, meta, order });
fs.writeFileSync(OUT,
  `/* GENERATED by leads/scripts/build-world-geo.mjs — do not hand-edit, re-run it.\n`
  + `   Geometry: Natural Earth 1:50m admin-0 (public domain), Equal Earth projection,\n`
  + `   Douglas-Peucker simplified, Antarctica omitted. Tibet — Ü-Tsang, Kham and\n`
  + `   Amdo — is its own region, drawn over China; see the script for its parts. */\n`
  + `window.WORLD_GEO = ${body};\n`);
console.log(`wrote ${OUT}: ${regions.length} regions, ${(body.length / 1024).toFixed(0)} KB, ${W}x${H}`);
