// Builds the HexColony app icons from the source logo.
// Run with:  node scripts/build-icons.mjs
//
// The source is assets/hexcolony-logo.jpg — Bill's illustration of the hex frame holding
// the five resources. It lives outside public/ because it is 900 KB and only this script
// ever reads it; what ships is the four PNGs below.
//
// The only real decision here is the maskable icon. Android crops an adaptive icon to
// whatever shape the launcher likes — circle, squircle, rounded square — and only
// guarantees that the central 80%-diameter circle survives. The logo's hexagon reaches to
// within 3% of the top and bottom edges, so at full bleed its points would simply be
// sliced off on most phones. It is therefore scaled down and padded out to the parchment
// colour: smaller, but the shape stays whole on every launcher.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'assets', 'hexcolony-logo.jpg');
const OUT = join(ROOT, 'public', 'icons');
mkdirSync(OUT, { recursive: true });

/**
 * Where the hexagon actually sits, and the colour of the paper behind it.
 *
 * Measured rather than assumed: if the logo is ever re-exported with a different margin,
 * the maskable icon has to follow it or the points start getting clipped again. A row
 * counts as artwork only once several pixels are dark, so the parchment's JPEG speckle
 * cannot drag the box out to the edges.
 */
async function measure() {
  const { data, info } = await sharp(SRC).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  const lum = (x, y) => {
    const i = (y * w + x) * ch;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  const DARK = 165, MIN = 8;
  const rowDark = (y) => { let n = 0; for (let x = 0; x < w; x++) if (lum(x, y) < DARK) n++; return n; };
  const colDark = (x) => { let n = 0; for (let y = 0; y < h; y++) if (lum(x, y) < DARK) n++; return n; };

  let top = 0, bot = h - 1, left = 0, right = w - 1;
  while (top < h && rowDark(top) < MIN) top++;
  while (bot > 0 && rowDark(bot) < MIN) bot--;
  while (left < w && colDark(left) < MIN) left++;
  while (right > 0 && colDark(right) < MIN) right--;

  // The paper, averaged over the four corners so one speckle cannot set it.
  const px = (x, y) => { const i = (y * w + x) * ch; return [data[i], data[i + 1], data[i + 2]]; };
  const corners = [px(3, 3), px(w - 4, 3), px(3, h - 4), px(w - 4, h - 4)];
  const paper = [0, 1, 2].map((k) => Math.round(corners.reduce((n, c) => n + c[k], 0) / 4));

  // Half the hexagon's widest span, as a fraction of the image — the radius that has to
  // fit inside a launcher's safe circle. Measured from the image centre, not the box
  // centre, because that is what the icon is centred on.
  const c = w / 2;
  const reach = Math.max(bot - c, c - top, right - c, c - left) / w;
  return { w, h, left, right, top, bot, paper, reach };
}

// 256 colours, and not fewer. Dropping to 128 halves the file but turns the pasture and
// forest tiles muddy brown — and telling the five resources apart at a glance is the
// entire job of this logo, so the bytes are the right trade.
const png = (img) => img
  .png({ compressionLevel: 9, effort: 10, palette: true, colours: 256, dither: 0.5 })
  .toBuffer();

async function main() {
  const m = await measure();
  console.log(`source ${m.w}x${m.h}  hexagon ${m.right - m.left + 1}x${m.bot - m.top + 1}`
    + `  reach ${(m.reach * 100).toFixed(1)}% of width  paper rgb(${m.paper.join(', ')})`);


  // Padding is real paper, not a flat fill. A solid rectangle of the average parchment
  // colour behind a textured one leaves a visible square seam exactly where the artwork
  // ends; lifting a corner of the source and blowing it up keeps the grain running to the
  // edge. The corner is taken from left of x=81, which the measurement above shows is
  // clear of the hexagon on every row.
  const paperGround = async (size) => sharp(SRC)
    .extract({ left: 0, top: 0, width: 80, height: 80 })
    .resize(size, size, { kernel: 'lanczos3' })
    .blur(1.4)
    .png()
    .toBuffer();

  for (const [name, size, mode] of [
    ['icon-192.png', 192, 'full'],
    ['icon-512.png', 512, 'full'],
    ['icon-maskable-512.png', 512, 'safe'],
    // iOS applies its own rounded-square mask, which takes the corners but not the edges,
    // so the hexagon's points survive at close to full bleed. It also ignores
    // transparency and composites onto black — a non-issue here only because the source
    // has opaque paper behind it.
    ['apple-touch-icon.png', 180, 'inset'],
  ]) {
    // 'safe' keeps the hexagon's furthest point inside the 80%-diameter circle Android
    // promises to show. 0.41 rather than 0.40 buys back a little size and is still inside
    // every launcher shape.
    const scale = mode === 'safe' ? 0.41 / m.reach : mode === 'inset' ? 0.94 : 1;
    const inner = Math.round(size * scale);
    const padL = Math.floor((size - inner) / 2);
    const padR = size - inner - padL;

    const art = await sharp(SRC).resize(inner, inner, { fit: 'cover', kernel: 'lanczos3' }).png().toBuffer();
    const img = (padL > 0 || padR > 0)
      ? sharp(await paperGround(size)).composite([{ input: art, left: padL, top: padL }])
      : sharp(art);
    const buf = await png(img);
    writeFileSync(join(OUT, name), buf);
    console.log(`${name.padEnd(24)} ${size}x${size}  art ${inner}px  ${(buf.length / 1024).toFixed(1)} KB`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
