// Generates the CatanX app icons as real PNG files with no image library — the pixels
// are computed here and the PNG container is written by hand (zlib ships with Node).
// Run with:  node scripts/build-icons.mjs
//
// The icon is the game in miniature: a ring of sea, a seven-hex island, and a number
// token sitting on the middle tile.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- PNG writer
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array of size w*h*4. */
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Each scanline is prefixed with filter type 0 (none) — simplest valid encoding.
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.subarray(y * w * 4, (y + 1) * w * 4).forEach((v, i) => {
      raw[y * (w * 4 + 1) + 1 + i] = v;
    });
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- drawing
const hex2rgb = (h) => [
  parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16),
];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

const SEA_TOP = hex2rgb('#1c5b8c');
const SEA_BOT = hex2rgb('#08203a');
const SAND = hex2rgb('#e8d6b2');
const GOLD = hex2rgb('#e3ba57');
const BRICK = hex2rgb('#b8613a');
const FOREST = hex2rgb('#2f6b3a');
const INK = hex2rgb('#0d1b28');
const PARCH = hex2rgb('#f3e6cb');
const RED = hex2rgb('#b3261e');

const SQ3 = Math.sqrt(3);

/** Pointy-top regular hexagon test, circumradius r, centred on (0,0). */
function inHex(dx, dy, r) {
  const w = (SQ3 / 2) * r;
  return Math.abs(dx) <= w && Math.abs(dx) + SQ3 * Math.abs(dy) <= SQ3 * r;
}

// Seven hexes: a centre plus its six neighbours, in the same pointy-top layout the
// game board uses.
function islandHexes(r) {
  // Pointy-top neighbours sit left/right at sqrt(3)r, and on the diagonals at
  // (sqrt(3)r/2, 1.5r). Nothing sits directly above or below — that would overlap.
  const dx = SQ3 * r, dy = 1.5 * r;
  return [
    { x: 0, y: 0, fill: FOREST },
    { x: -dx, y: 0, fill: GOLD }, { x: dx, y: 0, fill: GOLD },
    { x: -dx / 2, y: -dy, fill: BRICK }, { x: dx / 2, y: -dy, fill: BRICK },
    { x: -dx / 2, y: dy, fill: BRICK }, { x: dx / 2, y: dy, fill: BRICK },
  ];
}

/**
 * @param size    pixel size
 * @param maskable when true the sea fills the whole square and the island is drawn
 *                 smaller, so nothing important lands outside the safe circle.
 */
function drawIcon(size, maskable) {
  const px = new Uint8Array(size * size * 4);
  const c = size / 2;
  const seaR = maskable ? size : size * 0.485;
  const hexR = size * (maskable ? 0.108 : 0.135);
  const hexes = islandHexes(hexR);
  const tokenR = hexR * 0.52;

  const set = (i, rgb, a = 255) => {
    px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = a;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - c + 0.5;
      const dy = y - c + 0.5;
      const dist = Math.hypot(dx, dy);

      // Outside the disc: transparent for the round icon, sea for the maskable one.
      if (!maskable && dist > seaR) { px[i + 3] = 0; continue; }

      // Sea, with a vertical gradient and a sand rim just inside the edge.
      let rgb = mix(SEA_TOP, SEA_BOT, Math.min(1, Math.max(0, y / size)));
      if (!maskable && dist > seaR - size * 0.028) rgb = SAND;

      // Land.
      for (const h of hexes) {
        const hx = dx - h.x, hy = dy - h.y;
        if (inHex(hx, hy, hexR * 0.985)) {
          rgb = h.fill;
          // A darker inner edge so neighbouring tiles stay legible when tiny.
          if (!inHex(hx, hy, hexR * 0.86)) rgb = mix(h.fill, INK, 0.35);
          break;
        }
      }

      // The number token on the middle tile.
      if (dist < tokenR) rgb = PARCH;
      if (dist < tokenR && dist > tokenR * 0.82) rgb = mix(PARCH, INK, 0.3);

      set(i, rgb);
    }
  }

  // A fat red "8" on the token — the luckiest number on the board, drawn as two rings.
  const ringOuter = tokenR * 0.50, ringInner = tokenR * 0.24, ringW = tokenR * 0.145;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c + 0.5;
      for (const [cy, rad] of [[-ringOuter * 0.52, ringOuter * 0.52], [ringOuter * 0.52, ringOuter * 0.58]]) {
        const dy = y - c + 0.5 - cy;
        const d = Math.hypot(dx, dy);
        if (Math.abs(d - rad) < ringW / 2) {
          const i = (y * size + x) * 4;
          if (px[i + 3] > 0) set(i, RED);
        }
      }
    }
  }

  return encodePNG(size, size, px);
}

for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
]) {
  const buf = drawIcon(size, maskable);
  writeFileSync(join(OUT, name), buf);
  console.log(`${name.padEnd(24)} ${size}x${size}  ${(buf.length / 1024).toFixed(1)} KB`);
}
