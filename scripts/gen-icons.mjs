// Every app icon in the repo, cut from the one mark asset.
//
//   node scripts/gen-icons.mjs
//
// Writes Connect's favicons, the copies Karma Leads serves from its own folder,
// and the browser extension's icons. All three used to be drawn separately —
// Connect carried a glossy handshake tile, Leads an inline SVG "K", and the
// extension a green "K" from a generator that drew its own letterform in a
// colour on no palette. Three surfaces, three different marks, none of them the
// logo. They are now one composition from public/karma-mark-white.png, so the
// logo changing again is this command, not an archaeology exercise.
//
// Chromium does the pixel work — it is already a devDependency for the docs PDF,
// and nothing else here decodes a PNG.

import { chromium } from "playwright";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const MARK = root + "public/karma-mark-white.png";

/* Where each size lands. The 32 and 256 are written twice because Karma Leads
   serves its own static folder: a relative href from its index.html cannot
   reach Connect's public/. */
const TARGETS = [
  { size: 32, out: ["public/icon-32.png", "leads/public/icon-32.png"] },
  { size: 180, out: ["public/icon-180.png"] },
  { size: 256, out: ["public/icon-256.png", "leads/public/icon-256.png"] },
  { size: 16, out: ["extension/icons/icon16.png"] },
  { size: 48, out: ["extension/icons/icon48.png"] },
  { size: 128, out: ["extension/icons/icon128.png"] },
];

const b64 = readFileSync(MARK).toString("base64");
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<body></body>");

const files = await page.evaluate(async ({ data, sizes }) => {
  const img = new Image();
  img.src = "data:image/png;base64," + data;
  await img.decode();
  const out = {};
  for (const S of sizes) {
    const c = document.createElement("canvas");
    c.width = S; c.height = S;
    const x = c.getContext("2d");

    // Navy tile in the iOS corner proportion: reads as an app icon at 128+ and
    // still shows a shoulder at 16, where a larger radius would eat the corner.
    x.fillStyle = "#0B2545";
    x.beginPath();
    x.roundRect(0, 0, S, S, Math.round(S * 0.22));
    x.fill();

    /* Width drives height — the mark is 1.66:1 and squashing it to the square
       is the one thing that would make this look wrong at every size. The small
       tiles give it more of the tile because the padding that frames a 256 just
       costs legibility at 16, where the four bars are about a pixel each. */
    const w = Math.round(S * (S <= 48 ? 0.8 : 0.66));
    const h = Math.round(w * (img.naturalHeight / img.naturalWidth));
    x.imageSmoothingQuality = "high";
    x.drawImage(img, Math.round((S - w) / 2), Math.round((S - h) / 2), w, h);
    out[S] = c.toDataURL("image/png").split(",")[1];
  }
  return out;
}, { data: b64, sizes: TARGETS.map((t) => t.size) });

await browser.close();

for (const t of TARGETS) {
  const buf = Buffer.from(files[t.size], "base64");
  for (const p of t.out) writeFileSync(root + p, buf);
  console.log(`${String(t.size).padStart(3)}px  ${(statSync(root + t.out[0]).size / 1024).toFixed(1)} KB  ${t.out.join("  ")}`);
}
