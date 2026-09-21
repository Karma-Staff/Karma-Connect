/* Build the North America map the Storm watch pane draws.
 *
 *   node leads/scripts/build-na-geo.mjs <ne_50m_admin_1_states_provinces_lakes.geojson>
 *
 * Input is Natural Earth 1:50m admin-1 (PUBLIC DOMAIN — no attribution
 * required, though it is decent to give it). Output is leads/public/na-geo.js,
 * a plain script that sets window.NA_GEO — no build step, no map library at
 * runtime, no tile server, and nothing for the content-security policy to
 * allow. The cost is that this file is generated: do not hand-edit it, re-run
 * this instead.
 *
 * Three things happen here, and each is why the output is ~10% of the input:
 *
 *   Projection. Albers equal-area conic, the standard choice for a
 *   mid-latitude country and the only sane one for a map spanning Canada.
 *   Equal-area matters: on a Mercator, Nunavut would dwarf Texas and a
 *   reader would take that as meaning something.
 *
 *   Simplification. Douglas-Peucker in projected space. At the size this
 *   renders, a fjord is three pixels of noise and several kilobytes.
 *
 *   Island pruning. Natural Earth gives Alaska over a thousand rings, almost
 *   all of them specks. Rings below a minimum projected area are dropped.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "public", "na-geo.js");
const SRC = process.argv[2];
if (!SRC) { console.error("usage: build-na-geo.mjs <natural-earth admin-1 geojson>"); process.exit(1); }

/* Albers equal-area conic. Standard parallels at 29.5N and 57N and an origin
   at 45N/-100 frame the US and southern Canada without shearing either — the
   populated band, which is where every lead is. */
const D = Math.PI / 180;
const phi0 = 45 * D, lam0 = -100 * D, phi1 = 29.5 * D, phi2 = 57 * D;
const n = 0.5 * (Math.sin(phi1) + Math.sin(phi2));
const C = Math.cos(phi1) ** 2 + 2 * n * Math.sin(phi1);
const rho0 = Math.sqrt(C - 2 * n * Math.sin(phi0)) / n;

function project([lon, lat]) {
  const phi = lat * D;
  let lam = lon * D - lam0;
  // Alaska runs past the antimeridian; unwrap so it stays west, not east
  while (lam > Math.PI) lam -= 2 * Math.PI;
  while (lam < -Math.PI) lam += 2 * Math.PI;
  const q = C - 2 * n * Math.sin(phi);
  const rho = Math.sqrt(Math.max(q, 0)) / n;
  const theta = n * lam;
  /* y is NEGATED: Albers' y grows northward, SVG's grows downward, and
     without this the whole continent renders upside down with Canada
     along the bottom edge. */
  return [rho * Math.sin(theta), rho * Math.cos(theta) - rho0];
}

/* Douglas-Peucker: keep the points that carry the shape, drop the rest. */
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
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d2;
      if (len2 === 0) { d2 = (px - ax) ** 2 + (py - ay) ** 2; }
      else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d2 = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      }
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

const ringsOf = (geom) => geom.type === "Polygon" ? [geom.coordinates[0]]
  : geom.type === "MultiPolygon" ? geom.coordinates.map((p) => p[0]) : [];

const gj = JSON.parse(fs.readFileSync(SRC, "utf8"));
const wanted = new Set(["United States of America", "Canada"]);
const regions = gj.features.filter((f) => wanted.has(f.properties.admin) && f.properties.postal);

const TOL = 1.2e-3;            // projected units; tuned against the output size
const MIN_AREA = 2.5e-5;       // drop specks
/* DC is smaller than the speck threshold and would vanish — but it is a
   place with leads in it, and a map missing a jurisdiction the rest of the
   app can filter by is a map that lies by omission. Keep it whatever its
   area, and let the renderer give it a minimum touchable size. */
const ALWAYS_KEEP = new Set(["DC"]);

const shaped = [];
for (const f of regions) {
  const p = f.properties;
  const rings = ringsOf(f.geometry)
    .map((r) => simplify(r.map(project), TOL))
    .filter((r) => r.length > 3 && (ringArea(r) > MIN_AREA || ALWAYS_KEEP.has(p.postal)));
  if (!rings.length) continue;
  shaped.push({
    code: p.postal,
    name: p.name,
    country: p.admin === "Canada" ? "CA" : "US",
    rings,
  });
}

/* Hawaii sits 4,000km south-west of everything and would double the width of
   the frame for two pixels of island. Inset it, the way every US map does,
   and say so on the page rather than pretending it is in scale. */
const hi = shaped.find((s) => s.code === "HI");
const rest = shaped.filter((s) => s.code !== "HI");

const bounds = (list) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of list) for (const r of s.rings) for (const [x, y] of r) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
};

const b = bounds(rest);
const W = 1000;
const scale = W / (b.x1 - b.x0);
const H = Math.round((b.y1 - b.y0) * scale);
const put = ([x, y]) => [(x - b.x0) * scale, (y - b.y0) * scale];

if (hi) {
  // scale Hawaii up a little; it is repositioned below, once the frame exists
  const hb = bounds([hi]);
  const hs = (W * 0.10) / (hb.x1 - hb.x0);
  hi.rings = hi.rings.map((r) => r.map(([x, y]) => [(x - hb.x0) * hs, (y - hb.y0) * hs]));
  hi.inset = true;
}

/* The frame. Fitting all of it puts 3,000km of empty Arctic on screen and
   squeezes the lower 48 — where every lead and every alert actually is —
   into a strip along the bottom. So the viewBox is the US bounding box with
   headroom above it: Canada still draws and its populated south is in
   frame, the tundra simply runs off the top edge. Equal-area is kept, so
   nothing is distorted; it is cropped, which is honest and legible. */
const usBox = (() => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of shaped) {
    if (s.country !== "US" || s.code === "AK" || s.code === "HI") continue;
    for (const r of s.rings) for (const pt of r) {
      const [x, y] = s.inset ? pt : put(pt);
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { x0, y0, x1, y1 };
})();
// room above for southern Canada, a little below for the Gulf and the inset
const padTop = (usBox.y1 - usBox.y0) * 0.42;
const view = [
  Math.round(usBox.x0 - 30),
  Math.round(usBox.y0 - padTop),
  Math.round((usBox.x1 - usBox.x0) + 60),
  Math.round((usBox.y1 - usBox.y0) + padTop + 40),
];

/* park the Hawaii inset in the frame's bottom-left, out of the Gulf */
if (hi) {
  const hb = bounds([hi]);
  const dx = view[0] + view[2] * 0.02 - hb.x0;
  const dy = view[1] + view[3] * 0.86 - hb.y0;
  hi.rings = hi.rings.map((r) => r.map(([x, y]) => [x + dx, y + dy]));
}

const out = {};
const labels = {};
for (const s of [...rest, ...(hi ? [hi] : [])]) {
  const rings = s.inset ? s.rings : s.rings.map((r) => r.map(put));
  out[s.code] = rings.map((r) =>
    "M" + r.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L") + "Z").join("");
  // label on the biggest ring's centroid — good enough for a state code
  const big = rings.reduce((a, r) => (ringArea(r) > ringArea(a) ? r : a), rings[0]);
  const cx = big.reduce((a, p) => a + p[0], 0) / big.length;
  const cy = big.reduce((a, p) => a + p[1], 0) / big.length;
  labels[s.code] = [Math.round(cx), Math.round(cy)];
}

const meta = Object.fromEntries(shaped.map((s) => [s.code, { name: s.name, country: s.country }]));
const js = `/* GENERATED by leads/scripts/build-na-geo.mjs — do not hand-edit, re-run it.
   Geometry: Natural Earth 1:50m admin-1 (public domain), Albers equal-area
   conic, Douglas-Peucker simplified. Hawaii is an inset and not to scale. */
window.NA_GEO = ${JSON.stringify({ width: W, height: H, view, shapes: out, labels, meta })};
`;
fs.writeFileSync(OUT, js);

const kb = (js.length / 1024).toFixed(0);
console.log(`${shaped.length} regions (${shaped.filter((s) => s.country === "CA").length} CA, ${shaped.filter((s) => s.country === "US").length} US)`);
console.log(`full 0 0 ${W} ${H} — framed on ${view.join(' ')}`);
console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${kb} KB`);
