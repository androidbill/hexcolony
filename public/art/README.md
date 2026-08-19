# Terrain tile art

Drop the five hex illustrations in this folder with these exact names:

| file         | terrain   | produces |
|--------------|-----------|----------|
| `wood.jpg`   | forest    | wood     |
| `brick.jpg`  | hills     | brick    |
| `sheep.jpg`  | pasture   | sheep    |
| `wheat.jpg`  | fields    | wheat    |
| `ore.jpg`    | mountains | ore      |
| `desert.jpg` | desert    | nothing  |

`.png` and `.webp` also work — `TILE_ART` in `../render.js` lists the extensions it
tries, in order, and uses the first one that loads.

These are produced by `node scripts/slice-tiles.mjs <sheet.png> --write`, which finds
the five tiles on a contact sheet, measures where the printed cream border ends, crops
each artwork hexagon to its exact bounding box and writes JPEGs.

The tiles are **pointy-top** hexes, the same orientation the board draws, so each image
lines up with its hex rather than sitting behind it as a texture. That is why the crop
has to be the artwork hexagon's bounding box and nothing else — the renderer's hex mask
only matches if the hexagon exactly fills the image. The four corners of each file fall
outside the hexagon and are masked away when drawn.

Keep them small. A tile is at most ~120 CSS pixels on a phone, so ~340px on the short
side is already generous, and these files are precached by the service worker for
offline play. The five current tiles total about 250 KB as JPEG; the same crops as PNG
were 1.3 MB.

If the files are missing the game still runs: `render.js` falls back to the procedural
terrain motifs it shipped with, so a failed download degrades to the old look rather
than a blank board.
