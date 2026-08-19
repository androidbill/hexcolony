// Prepares a playing-piece image for the board.
//
//   node scripts/prep-piece.mjs "<in.png>" <name> [width]
//   node scripts/prep-piece.mjs "C:/Users/billd/OneDrive/Desktop/catan house.png" house 256
//
// Trims the transparent margin, resizes, and writes public/art/pieces/<name>.png.
//
// Trimming is the part that matters. A piece is positioned by its own edges — a house
// stands with the bottom of its base on the corner — so any invisible padding in the
// source becomes an invisible offset on the board, and every piece would need a
// different hand-tuned nudge. Trimmed, they all behave the same.
//
// Pieces stay greyscale on transparent: the renderer tints each one to the owning
// player's colour, so one file serves every player.

import { mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const sharp = (await import('sharp')).default;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'art', 'pieces');

const [src, name, widthArg] = process.argv.slice(2);
if (!src || !name) {
  console.error('usage: node scripts/prep-piece.mjs <in.png> <name> [width]');
  process.exit(1);
}
const width = Number(widthArg || 256);

mkdirSync(OUT, { recursive: true });
const dest = join(OUT, `${name}.png`);

const before = statSync(src).size;
const meta = await sharp(src).metadata();

const buf = await sharp(src)
  .trim()                                    // drop the transparent margin
  .resize({ width, withoutEnlargement: true })
  .png({ compressionLevel: 9, palette: true })
  .toBuffer();

await sharp(buf).toFile(dest);
const after = statSync(dest).size;
const out = await sharp(dest).metadata();

console.log(`${name}: ${meta.width}x${meta.height} ${(before / 1024).toFixed(0)} KB`
  + `  ->  ${out.width}x${out.height} ${(after / 1024).toFixed(0)} KB`);
console.log(`written to public/art/pieces/${name}.png`);
