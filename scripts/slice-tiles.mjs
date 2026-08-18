// Cuts the five terrain illustrations out of a single contact sheet and writes them
// into public/art/.
//
//   node scripts/slice-tiles.mjs <sheet.png> [--write]
//
// Without --write it only reports what it found, so you can check the detection before
// it overwrites anything.
//
// PNG decoding is done here rather than with an image library: the project has no
// dependencies and zlib ships with Node, so inflating and un-filtering the scanlines
// by hand keeps it that way.

import { inflateSync, deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'art');

// These are photographic illustrations, and PNG is the wrong container for them — the
// five tiles come to about 1.3 MB, which players would download and the service worker
// would hold for offline play. JPEG at the same pixel size is roughly a tenth of that
// with no visible difference at the size a hex is drawn.
//
// sharp is a devDependency and only ever runs here, never in the browser. Without it
// the script still works and simply writes PNGs.
let sharp = null;
try { sharp = (await import('sharp')).default; } catch { /* PNG fallback below */ }

// ---------------------------------------------------------------- PNG decode
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504E47) throw new Error('not a PNG');
  let pos = 8;
  let w = 0, h = 0, depth = 0, colour = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8]; colour = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }

  if (depth !== 8) throw new Error(`unsupported bit depth ${depth} (need 8)`);
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported');

  // channels in the raw stream, before we expand to RGBA
  const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour];
  if (!CH) throw new Error(`unsupported colour type ${colour}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * CH;
  const out = Buffer.alloc(h * stride);

  // Undo the per-scanline filters. Each line is prefixed with its filter byte and is
  // predicted from the pixel to the left (a), the line above (b) and up-left (c).
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= CH ? cur[i - CH] : 0;
      const b = prev ? prev[i] : 0;
      const c = (prev && i >= CH) ? prev[i - CH] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xFF;
    }
  }

  // Expand whatever we decoded into straight RGBA.
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    let r, g, b, a = 255;
    if (colour === 6) { r = out[i * 4]; g = out[i * 4 + 1]; b = out[i * 4 + 2]; a = out[i * 4 + 3]; }
    else if (colour === 2) { r = out[i * 3]; g = out[i * 3 + 1]; b = out[i * 3 + 2]; }
    else if (colour === 0) { r = g = b = out[i]; }
    else if (colour === 4) { r = g = b = out[i * 2]; a = out[i * 2 + 1]; }
    else { const p = out[i]; r = palette[p * 3]; g = palette[p * 3 + 1]; b = palette[p * 3 + 2]; if (trns && p < trns.length) a = trns[p]; }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { w, h, rgba, colour, depth };
}

// ---------------------------------------------------------------- PNG encode
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgb) {          // rgb: Uint8Array w*h*3
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;              // 8-bit truecolour, no alpha
  const stride = w * 3;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 1;           // filter 1 (Sub) compresses photos better than none
    const row = rgb.subarray(y * stride, (y + 1) * stride);
    const dst = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) dst[i] = (row[i] - (i >= 3 ? row[i - 3] : 0)) & 0xFF;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- hex detection
/**
 * Find the illustrations on the sheet. Anything that is nearly white is background and
 * anything nearly black is caption text, so what is left is artwork; flood filling that
 * mask and keeping the big blobs gives one component per hex.
 */
function findHexes(img) {
  const { w, h, rgba } = img;
  const isArt = new Uint8Array(w * h);
  for (let i = 0, n = w * h; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    if (a < 128) continue;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const nearWhite = mn > 228;
    const nearBlack = mx < 90;
    const grey = (mx - mn) < 14;
    if (!nearWhite && !nearBlack && !(grey && mx < 160)) isArt[i] = 1;
  }

  const seen = new Uint8Array(w * h);
  const comps = [];
  const stack = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!isArt[s] || seen[s]) continue;
    let sp = 0; stack[sp++] = s; seen[s] = 1;
    let minX = w, maxX = 0, minY = h, maxY = 0, area = 0;
    while (sp) {
      const p = stack[--sp];
      const x = p % w, y = (p / w) | 0;
      area++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && isArt[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && isArt[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && isArt[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && isArt[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
    comps.push({ minX, maxX, minY, maxY, area, w: maxX - minX + 1, h: maxY - minY + 1 });
  }

  // A tile is big and roughly as wide as it is tall. Captions and stray marks are not.
  const big = comps
    .filter((c) => c.area > (w * h) / 400 && c.w > w / 12 && c.h > h / 12)
    .filter((c) => { const ar = c.w / c.h; return ar > 0.65 && ar < 1.55; })
    .sort((a, b) => b.area - a.area)
    .slice(0, 5);

  // Reading order: top row left-to-right, then the next row.
  const rowH = Math.max(...big.map((c) => c.h), 1);
  big.sort((a, b) => {
    const ay = a.minY + a.h / 2, by = b.minY + b.h / 2;
    if (Math.abs(ay - by) > rowH * 0.5) return ay - by;
    return a.minX - b.minX;
  });
  return big;
}

// ---------------------------------------------------------------- crop + resize
/**
 * The source tiles are POINTY-TOP hexes — their bounding boxes measure ~374x437, an
 * aspect of 0.856, which is the sqrt(3):2 of a pointy-top hex and not the 2:sqrt(3) of
 * a flat-top one. That is the same orientation the board draws, so the art lines up
 * and we can keep nearly all of it instead of cutting a small rectangle out of the
 * middle.
 *
 * All we shave off is the printed cream border: shrinking the bounding box about its
 * centre by `INSET` lands just inside it, and the renderer then maps that box straight
 * onto the hex because the aspects already match.
 */
// The printed tiles have a cream border around the illustration, so the shape we
// actually want is the INNER artwork hexagon, not the outer one the flood fill found.
// Getting this exactly right matters: the renderer clips the image to a hex, and that
// mask only lines up if the artwork hexagon precisely fills the image it is given.
const isBorder = (r, g, b) => Math.min(r, g, b) > 185 && (Math.max(r, g, b) - Math.min(r, g, b)) < 70;

/**
 * Measure the artwork hexagon and return the rectangle it exactly fills.
 *
 * Scanning INWARD from the outside is what makes this robust: the run of white page
 * and cream border is always light, and the first non-light pixel is the artwork edge.
 * Scanning outward from the middle would fail on the sheep, whose fleece is as pale as
 * the border.
 *
 * Only the width is measured, across the hexagon's vertical side edges where the
 * crossing is perpendicular. The height is then derived from the pointy-top ratio
 * (2/sqrt(3)), which keeps the aspect exact instead of inheriting a pixel or two of
 * error from probing a pointed corner.
 */
const HEX_ASPECT = 2 / Math.sqrt(3);
function inscribedRect(c, img) {
  const cx = Math.round(c.minX + c.w / 2);
  const cy = Math.round(c.minY + c.h / 2);
  const at = (x, y) => { const i = (y * img.w + x) * 4; return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]]; };

  // Take the INNER end of the cream band rather than the first non-cream pixel: the
  // tiles are printed with a thin dark keyline on the outside of the border, so
  // "first pixel that isn't cream" stops immediately and measures nothing. Looking for
  // the last cream pixel within the outer quarter steps over that keyline.
  const limit = Math.round(c.w * 0.25);
  let left = c.minX;
  for (let x = c.minX; x < c.minX + limit; x++) if (isBorder(...at(x, cy))) left = x + 1;
  let right = c.maxX;
  for (let x = c.maxX; x > c.maxX - limit; x--) if (isBorder(...at(x, cy))) right = x - 1;

  return { inset: (right - left + 1) / c.w, cx, cy };
}

/**
 * Turn a measured inset into the crop rectangle.
 *
 * The border is printed at one uniform width across the whole sheet, so the MEDIAN of
 * the five measurements is the trustworthy number and any single tile that disagrees is
 * a misread rather than a different tile. The sheep is exactly that case: its pale
 * fleece reaches the edge of the frame and reads as cream, which measures the border as
 * far thicker than it is. Taking the median throws that reading away.
 */
function rectFrom(c, inset) {
  const cx = c.minX + c.w / 2, cy = c.minY + c.h / 2;
  const rw = c.w * inset;
  const rh = rw * HEX_ASPECT;
  return {
    x: Math.round(cx - rw / 2), y: Math.round(cy - rh / 2),
    w: Math.round(rw), h: Math.round(rh),
  };
}

/** Box-filter downscale straight out of the source RGBA into a packed RGB buffer. */
function cropResize(img, rect, outW, outH) {
  const out = new Uint8Array(outW * outH * 3);
  const sx = rect.w / outW, sy = rect.h / outH;
  for (let y = 0; y < outH; y++) {
    const y0 = rect.y + y * sy, y1 = y0 + sy;
    for (let x = 0; x < outW; x++) {
      const x0 = rect.x + x * sx, x1 = x0 + sx;
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        if (yy < 0 || yy >= img.h) continue;
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          if (xx < 0 || xx >= img.w) continue;
          const i = (yy * img.w + xx) * 4;
          r += img.rgba[i]; g += img.rgba[i + 1]; b += img.rgba[i + 2]; n++;
        }
      }
      const o = (y * outW + x) * 3;
      out[o] = n ? Math.round(r / n) : 0;
      out[o + 1] = n ? Math.round(g / n) : 0;
      out[o + 2] = n ? Math.round(b / n) : 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------- main
const sheetPath = process.argv[2];
const write = process.argv.includes('--write');
if (!sheetPath) {
  console.error('usage: node scripts/slice-tiles.mjs <sheet.png> [--write]');
  process.exit(1);
}

// The order the tiles appear on the sheet, reading top row then bottom.
const ORDER = (process.env.TILE_ORDER || 'sheep,wood,brick,wheat,ore').split(',');
const TARGET_W = Number(process.env.TILE_W || 420);
const QUALITY = Number(process.env.TILE_Q || 82);

const img = decodePNG(readFileSync(sheetPath));
console.log(`sheet ${basename(sheetPath)}  ${img.w}x${img.h}  colourType=${img.colour}`);

const hexes = findHexes(img);
console.log(`found ${hexes.length} tile-shaped regions:`);
hexes.forEach((c, i) => {
  console.log(`  ${(ORDER[i] || '?').padEnd(6)} box ${c.minX},${c.minY} ${c.w}x${c.h}  area=${c.area}`);
});
if (hexes.length !== 5) {
  console.error(`\nExpected 5 tiles, got ${hexes.length}. Not writing anything.`);
  process.exit(1);
}

const measured = hexes.map((c) => inscribedRect(c, img).inset);
const sorted = measured.slice().sort((a, b) => a - b);
// A hair inside the measured edge. The border measurement is good to a pixel or two,
// and a sliver of cream left in the corner of a tile is far more visible on the board
// than the 3% of grass it costs to be sure.
const TRIM = Number(process.env.TILE_TRIM || 0.97);
const INSET = sorted[Math.floor(sorted.length / 2)] * TRIM;
console.log(`border insets measured: ${measured.map((m) => m.toFixed(3)).join(', ')}`);
console.log(`using the median, ${INSET.toFixed(3)}, for every tile`);

mkdirSync(OUT, { recursive: true });
for (let i = 0; i < hexes.length; i++) {
  const name = ORDER[i];
  const rect = rectFrom(hexes[i], INSET);
  // Never upscale — the sheet is the limit of the detail that exists.
  const outW = Math.min(TARGET_W, rect.w);
  const outH = Math.round(outW * (rect.h / rect.w));
  const rgb = cropResize(img, rect, outW, outH);

  let bytes, ext;
  if (sharp) {
    bytes = await sharp(Buffer.from(rgb), { raw: { width: outW, height: outH, channels: 3 } })
      .jpeg({ quality: QUALITY, mozjpeg: true, chromaSubsampling: '4:4:4' })
      .toBuffer();
    ext = 'jpg';
  } else {
    bytes = encodePNG(outW, outH, rgb);
    ext = 'png';
  }

  if (write) {
    writeFileSync(join(OUT, `${name}.${ext}`), bytes);
    // Drop any earlier run's file in the other format so the service worker is not
    // precaching a stale duplicate of every tile.
    const other = join(OUT, `${name}.${ext === 'jpg' ? 'png' : 'jpg'}`);
    if (existsSync(other)) rmSync(other);
  }
  console.log(`  ${name.padEnd(6)} artwork hex ${rect.w}x${rect.h} -> ${outW}x${outH} ${ext}  ${(bytes.length / 1024).toFixed(0)} KB${write ? '  written' : '  (dry run)'}`);
}
if (!write) console.log('\nDry run. Re-run with --write to save.');
