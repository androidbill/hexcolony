# Terrain tile art

Drop the five hex illustrations in this folder with these exact names:

| file         | terrain   | produces |
|--------------|-----------|----------|
| `wood.jpg`   | forest    | wood     |
| `brick.jpg`  | hills     | brick    |
| `sheep.jpg`  | pasture   | sheep    |
| `wheat.jpg`  | fields    | wheat    |
| `ore.jpg`    | mountains | ore      |

`.png` and `.webp` also work — `TILE_ART` in `../render.js` lists the extensions it
tries, in order, and uses the first one that loads.

The renderer clips each image to the hex and scales it to cover, so the artwork does
not need to be hex-shaped or match the board's orientation: the source tiles are
flat-top hexes while the board draws pointy-top ones, and only the centre of each
illustration is used. Square crops are fine. Anything decorative right at the edge of
the source hex (a printed border, for example) gets cropped away.

Aim for roughly 400-600px on the short side. A tile is at most ~120 CSS pixels on a
phone, so more than that is bytes the players download for nothing — and these files
are precached by the service worker for offline play.

If the files are missing the game still runs: `render.js` falls back to the procedural
terrain motifs it shipped with, so a failed download degrades to the old look rather
than a blank board.
