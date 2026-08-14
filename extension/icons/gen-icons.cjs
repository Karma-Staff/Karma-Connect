// Generates the extension PNG icons (navy rounded square + green "K") with no dependencies.
// Run: node icons/gen-icons.cjs   (from the extension/ folder)
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function png(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) { raw[y * stride] = 0; rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function icon(N) {
  const bg = [7, 24, 85, 255];     // #071855
  const fg = [82, 211, 158, 255];  // #52d39e
  const buf = Buffer.alloc(N * N * 4);
  const r = N * 0.22, th = N * 0.12;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    const cx = Math.min(x, N - 1 - x), cy = Math.min(y, N - 1 - y);
    if (cx < r && cy < r && Math.hypot(r - cx, r - cy) > r) { buf[i + 3] = 0; continue; }
    const stem = x > N * 0.26 && x < N * 0.26 + th && y > N * 0.24 && y < N * 0.76;
    const up = distSeg(x, y, N * 0.36, N * 0.5, N * 0.74, N * 0.24) < th * 0.72 && y < N * 0.53;
    const dn = distSeg(x, y, N * 0.36, N * 0.5, N * 0.74, N * 0.76) < th * 0.72 && y > N * 0.47;
    const c = stem || up || dn ? fg : bg;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = c[3];
  }
  return png(N, N, buf);
}
for (const N of [16, 48, 128]) fs.writeFileSync(path.join(__dirname, `icon${N}.png`), icon(N));
console.log("wrote icon16.png, icon48.png, icon128.png");
