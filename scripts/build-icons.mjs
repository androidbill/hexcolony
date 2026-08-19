// Builds the HexColony app icons from the source logo.
// Run with:  node scripts/build-icons.mjs
//
// The source is assets/hexcolony-logo.jpg. It lives outside public/ because it is a
// megabyte and only this script reads it; what ships is the four PNGs below.
//
// The only real decision is the maskable icon. Android crops an adaptive icon to whatever
// shape the launcher likes — circle, squircle, rounded square — and only guarantees that
// the central 80%-diameter circle survives. At full bleed the corners of a square logo,
// and the points of a hexagonal one, are simply sliced off on most phones. So the whole
// artwork is scaled to fit inside that circle and the rest is padded out.
//
// An earlier version of this script measured where the artwork sat by finding its dark
// pixels, so the scaling could be as tight as possible. That broke on the second logo it
// was ever given: this one is mounted on a torn paper sheet whose deckled edge and shadow
// run right to the border, so "the dark part" was the whole image and the measurement
// said nothing. Fitting the entire square inside the safe circle needs no measurement, is
// correct for any artwork, and costs about five percent of size against a measurement
// that was only ever right by luck.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'assets', 'hexcolony-logo.jpg');
const OUT = join(ROOT, 'public', 'icons');
mkdirSync(OUT, { recursive: true });

// A square's furthest point from its centre is a corner, at half the diagonal. Fitting
// that inside the safe circle is what guarantees nothing is ever cropped, whatever shape
// the launcher masks to.
const SAFE_RADIUS = 0.41;                 // of the icon's width; Android promises 0.40
const MASK_SCALE = SAFE_RADIUS / (Math.SQRT2 / 2);

// 256 colours, and not fewer. Dropping to 128 halves the file but turns the pasture and
// forest tiles muddy brown — and telling the resources apart at a glance is the whole job
// of this logo, so the bytes are the right trade.
const png = (img) => img
  .png({ compressionLevel: 9, effort: 10, palette: true, colours: 256, dither: 0.5 })
  .toBuffer();

/**
 * The mount the padding is made of: a corner of the source, blown up and softened.
 *
 * Not a flat fill of the average colour. A solid rectangle behind a textured one leaves a
 * visible square seam exactly where the artwork ends, which is what the first attempt at
 * this looked like. A corner is whatever the artwork is mounted on — parchment on one
 * logo, a brown ground on the next — so the padding always continues it.
 *
 * Small on purpose. At 64px the patch reached past the backdrop and onto the torn sheet,
 * and blowing that up gave the padding a blotchy light patch down one side. Measured, a
 * 28px corner is uniform (standard deviation 7 across the channel) where a 64px one is
 * not (21). Better a small clean swatch stretched than a large dirty one.
 */
const ground = (size) => sharp(SRC)
  .extract({ left: 0, top: 0, width: 28, height: 28 })
  .resize(size, size, { kernel: 'lanczos3' })
  .blur(1.6)
  .png()
  .toBuffer();

async function main() {
  const meta = await sharp(SRC).metadata();
  console.log(`source ${meta.width}x${meta.height} ${meta.format}`);

  for (const [name, size, maskable] of [
    ['icon-192.png', 192, false],
    ['icon-512.png', 512, false],
    ['icon-maskable-512.png', 512, true],
    // iOS applies its own rounded-square mask, which takes the corners but not the edges,
    // so full bleed is fine — and this artwork carries its own margin anyway. It also
    // ignores transparency and composites onto black, a non-issue only because the source
    // is opaque to its edges.
    ['apple-touch-icon.png', 180, false],
  ]) {
    const inner = maskable ? Math.round(size * MASK_SCALE) : size;
    const pad = Math.floor((size - inner) / 2);

    const art = await sharp(SRC)
      .resize(inner, inner, { fit: 'cover', kernel: 'lanczos3' })
      .png()
      .toBuffer();
    const img = pad > 0
      ? sharp(await ground(size)).composite([{ input: art, left: pad, top: pad }])
      : sharp(art);

    const buf = await png(img);
    writeFileSync(join(OUT, name), buf);
    console.log(`${name.padEnd(24)} ${size}x${size}  art ${inner}px  ${(buf.length / 1024).toFixed(1)} KB`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
