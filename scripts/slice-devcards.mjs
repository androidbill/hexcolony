// Cuts the five development-card illustrations out of one sheet and writes them to
// public/art/. The crop boxes were measured off the sheet this was made from.
//
//   node scripts/slice-devcards.mjs <sheet.webp>
import sharp from 'sharp';

const sheet = process.argv[2];
if (!sheet) { console.error('usage: node scripts/slice-devcards.mjs <sheet>'); process.exit(1); }

const COLS = [[16, 322], [332, 623], [633, 917], [925, 1215], [1225, 1505]];
const NAMES = ['knight', 'road', 'plenty', 'mono', 'vp'];
const TOP = 19, BOTTOM = 491;
const OUT_H = 520;

for (let i = 0; i < NAMES.length; i++) {
  const [x0, x1] = COLS[i];
  const w = x1 - x0 + 1, h = BOTTOM - TOP + 1;
  const scale = OUT_H / h;
  const ow = Math.round(w * scale);
  // Rounded corners, so the card sits on the board as a card and not as a white rectangle.
  const mask = Buffer.from(`<svg width="${ow}" height="${OUT_H}"><rect width="${ow}" height="${OUT_H}" rx="${Math.round(ow * 0.055)}" fill="#fff"/></svg>`);
  await sharp(sheet)
    .extract({ left: x0, top: TOP, width: w, height: h })
    .resize(ow, OUT_H)
    .composite([{ input: mask, blend: 'dest-in' }])
    .webp({ quality: 88 })
    .toFile(`public/art/dev-${NAMES[i]}.webp`);
  console.log(`dev-${NAMES[i]}.webp ${ow}x${OUT_H}`);
}
