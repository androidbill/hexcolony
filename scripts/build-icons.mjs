// Builds the HexColony app icons.
// Run with:  node scripts/build-icons.mjs
//
// The icon is one of the board's own tiles: the wheat hex, ringed in bright blue, cut to
// the shape of the hexagon rather than sat inside a square. What ships is the three PNGs
// at the bottom of this file.
//
// The source is public/art/wheat.jpg — the same file the board draws that tile from, so
// the icon and the game cannot drift apart. Those tiles are cropped to a pointy-top
// hexagon's exact bounding box (see scripts/slice-tiles.mjs), width to height in the
// ratio √3:2, which is why the artwork lines up with the hexagon path here without any
// measuring: the two are the same shape by construction.
//
// Drawn as SVG and rendered by sharp rather than composed from bitmaps. A hexagon needs a
// clip and a stroke, and librsvg antialiases both — a hand-built alpha mask gives you six
// staircased edges instead.

import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'public', 'art', 'wheat.jpg');
const OUT = join(ROOT, 'public', 'icons');
mkdirSync(OUT, { recursive: true });

// Sky, straight off the player palette in rules.js. The ring has to hold its own against
// a pale gold tile and against whatever the launcher puts behind it, and a colour the
// game already uses beats a new one invented for the icon.
const RING = '#35c4ff';
// A hairline of the deep sea under the ring, so the blue has an edge on a white
// background as well as on a dark one.
const EDGE = '#06283c';
// iOS has no transparency: it composites an icon onto black. Naming the colour makes it
// the game's own water rather than a void the artwork happens to sit in.
const IOS_BACKDROP = '#071a2c';

const RING_W = 0.05;      // of the icon's width
const EDGE_W = 0.066;     // wider, so it survives as a rim on both sides of the ring

/** A pointy-top hexagon: a vertex at the top, flats to left and right. */
function hexPoints(cx, cy, r) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 180) * (60 * i - 90);
    return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
  }).join(' ');
}

const artData = `data:image/jpeg;base64,${readFileSync(SRC).toString('base64')}`;

/**
 * One icon, as an SVG string.
 *
 * The hexagon is sized off the icon's HEIGHT, because a pointy-top hex is taller than it
 * is wide — fitting it to the width would push its points off the top and bottom. The
 * space either side is the price of the shape being a hexagon and not a square, which is
 * the whole point of the exercise.
 */
function svg(size) {
  const r = (size - size * EDGE_W) / 2;      // leave room for the outer half of the rim
  const cx = size / 2;
  const cy = size / 2;
  const pts = hexPoints(cx, cy, r);
  const w = Math.sqrt(3) * r;                // the tile's own aspect, so it fits exactly
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs><clipPath id="hex"><polygon points="${pts}"/></clipPath></defs>
  <g clip-path="url(#hex)">
    <image href="${artData}" x="${(cx - w / 2).toFixed(2)}" y="${(cy - r).toFixed(2)}"
           width="${w.toFixed(2)}" height="${(r * 2).toFixed(2)}"
           preserveAspectRatio="xMidYMid slice"/>
  </g>
  <polygon points="${pts}" fill="none" stroke="${EDGE}" stroke-width="${size * EDGE_W}" stroke-linejoin="round"/>
  <polygon points="${pts}" fill="none" stroke="${RING}" stroke-width="${size * RING_W}" stroke-linejoin="round"/>
</svg>`;
}

// A palette, as the old script had. Full-colour RGBA put a 512 icon at 1.4 MB; 256
// colours with a little dither brings it under a tenth of that and this is one tile of
// wheat, not a photograph. The alpha channel survives — PNG8 carries per-entry alpha, so
// the hexagon's edge stays soft.
const png = (img) => img
  .png({ compressionLevel: 9, effort: 10, palette: true, colours: 256, dither: 0.5 })
  .toBuffer();

/**
 * Rasterise at double size and come back down.
 *
 * Six slanted edges and a stroke on each of them; rendering straight to the target size
 * leaves them visibly stepped. Supersampling and a lanczos reduction is what makes the
 * hexagon's silhouette clean, which matters more here than anywhere else in the app —
 * the silhouette IS the icon.
 */
const render = (size) => sharp(Buffer.from(svg(size * 2)), { density: 288 })
  .resize(size, size, { kernel: 'lanczos3' });

async function main() {
  const meta = await sharp(SRC).metadata();
  console.log(`source ${meta.width}x${meta.height} ${meta.format}`
    + `  aspect ${(meta.width / meta.height).toFixed(4)} (hex box is ${(Math.sqrt(3) / 2).toFixed(4)})`);

  for (const [name, size, flatten] of [
    ['icon-192.png', 192, false],
    ['icon-512.png', 512, false],
    // iOS draws its own rounded square and ignores the alpha channel, so this one is
    // given a ground on purpose instead of being flattened onto black.
    ['apple-touch-icon.png', 180, true],
  ]) {
    let img = render(size);
    if (flatten) {
      const hex = await img.png().toBuffer();
      img = sharp({
        create: { width: size, height: size, channels: 4, background: IOS_BACKDROP },
      }).composite([{ input: hex }]);
    }
    const buf = await png(img);
    writeFileSync(join(OUT, name), buf);
    console.log(`${name.padEnd(24)} ${size}x${size}  ${flatten ? 'on ' + IOS_BACKDROP : 'transparent'}`
      + `  ${(buf.length / 1024).toFixed(1)} KB`);
  }

  // There is no maskable icon any more. Android crops one to whatever shape the launcher
  // likes and only promises the middle 80% survives, so a maskable hexagon loses its
  // points — and the only way to keep them is to pad the hexagon out on a square ground,
  // which is exactly the "hex in a box" this icon exists not to be. Without one, Chrome
  // puts the transparent icon on a plain backdrop and the silhouette stays a hexagon.
  rmSync(join(OUT, 'icon-maskable-512.png'), { force: true });
  console.log('icon-maskable-512.png     removed — see the note in this script');
}

main().catch((e) => { console.error(e); process.exit(1); });
