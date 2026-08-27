// The app's own icons.
//
// These replace the emoji that used to sit in the action bar, the awards and the prompts.
// Emoji were never really a choice — they were the quickest thing to type — and they cost
// more than they look: every platform draws them differently, they carry their own colour
// so they cannot follow a button's state, they sit on their own baseline so a row of them
// never quite lines up, and at 18px Apple's and Google's versions of the same character
// are barely the same picture. A set drawn here looks the same on every device and
// inherits `currentColor`, so a disabled button's icon dims with its label.
//
// Drawn to match the chevrons and the kebab that were already hand-rolled in index.html:
// a 24-unit box, 2px strokes, round caps and joins, no fills except where a shape reads
// better solid. Keeping one geometry across the set is most of what makes icons look
// bought rather than collected.

const SVG = (body, { size = 20, fill = 'none' } = {}) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false"`
  + ` fill="${fill}" stroke="currentColor" stroke-width="2"`
  + ` stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const PATHS = {
  // Two figures, the front one whole and the back one half-shown, which is how a crowd
  // reads at this size without turning into a blob.
  players: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19.5c.6-3.4 2.9-5.3 6-5.3s5.4 1.9 6 5.3"/>'
    + '<path d="M16 5.2a3.2 3.2 0 0 1 0 5.6"/><path d="M17.4 14.6c2.3.5 3.8 2.2 4.3 4.9"/>',

  // A development card: a card with a corner turned, so it is not mistaken for a tile.
  dev: '<rect x="4" y="3" width="13" height="18" rx="2"/><path d="M17 8l3.2 1.2a1.6 1.6 0 0 1 .9 2.1l-3.6 9.1"/>'
    + '<path d="M8 8.5h5M8 12h5"/>',

  // Two arrows passing, which is a trade in one glyph and reads at any size.
  trade: '<path d="M4 8.5h13l-3.2-3.2"/><path d="M20 15.5H7l3.2 3.2"/>',

  // A die showing five, because a blank square is a box and one pip is a full stop.
  roll: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/>'
    + '<circle cx="8.5" cy="8.5" r="1.3" fill="currentColor" stroke="none"/>'
    + '<circle cx="15.5" cy="8.5" r="1.3" fill="currentColor" stroke="none"/>'
    + '<circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/>'
    + '<circle cx="8.5" cy="15.5" r="1.3" fill="currentColor" stroke="none"/>'
    + '<circle cx="15.5" cy="15.5" r="1.3" fill="currentColor" stroke="none"/>',

  done: '<path d="M4.5 12.5l5 5 10-11"/>',

  // A bin with its lid slightly proud, so the lid is legible as a lid.
  discard: '<path d="M4 7h16"/><path d="M10 4.5h4"/><path d="M6.5 7l1 12.2a1.8 1.8 0 0 0 1.8 1.8h5.4a1.8 1.8 0 0 0 1.8-1.8L17.5 7"/>'
    + '<path d="M10.5 11v6M13.5 11v6"/>',

  trophy: '<path d="M7.5 4h9v5.5a4.5 4.5 0 0 1-9 0V4z"/><path d="M7.5 5.5H5a2.5 2.5 0 0 0 2.5 4"/>'
    + '<path d="M16.5 5.5H19a2.5 2.5 0 0 1-2.5 4"/><path d="M12 14v3.5"/><path d="M8.5 20.5h7"/>',

  // The robber: a hooded figure, which is the piece rather than an emoji ninja.
  robber: '<path d="M12 3.2c-3 0-5 2.2-5 5.2 0 1.6.5 2.6 1.2 3.4"/>'
    + '<path d="M12 3.2c3 0 5 2.2 5 5.2 0 1.6-.5 2.6-1.2 3.4"/>'
    + '<path d="M8.2 11.8h7.6c1.6 0 2.7 1.2 2.9 2.8l.5 5.9H4.8l.5-5.9c.2-1.6 1.3-2.8 2.9-2.8z"/>',

  map: '<path d="M9 4.5L3.5 6.8v12.7L9 17.2l6 2.3 5.5-2.3V4.5L15 6.8 9 4.5z"/>'
    + '<path d="M9 4.5v12.7M15 6.8v12.7"/>',

  pause: '<path d="M9.5 5v14M14.5 5v14"/>',

  // An hourglass, sand shown as a solid wedge so it is not four bare lines.
  waiting: '<path d="M7 3.5h10M7 20.5h10"/><path d="M8 3.5v3.2c0 2 4 3.9 4 5.3s-4 3.3-4 5.3v3.2"/>'
    + '<path d="M16 3.5v3.2c0 2-4 3.9-4 5.3s4 3.3 4 5.3v3.2"/>',

  // Longest Road: a road running into the distance, with its centre line.
  road: '<path d="M8.5 3.5L5 20.5"/><path d="M15.5 3.5L19 20.5"/>'
    + '<path d="M12 5v2.5M12 11v2.5M12 17v2.5"/>',

  // Largest Army: crossed swords, kept simple enough to read at 15px on a chip.
  army: '<path d="M5 4.5l10.5 12.2"/><path d="M19 4.5L8.5 16.7"/>'
    + '<path d="M4 19.5l3-2.4M20 19.5l-3-2.4"/>',

  // A card back, for the count on a player chip.
  card: '<rect x="5" y="3.5" width="14" height="17" rx="2.2"/><path d="M9 8.5l6 7M15 8.5l-6 7"/>',

  house: '<path d="M4 11.2L12 4.5l8 6.7"/><path d="M6.2 10v9.5h11.6V10"/>',
  city: '<path d="M3.5 20.5h17"/><path d="M5 20.5V9.2L10.5 5v15.5"/><path d="M10.5 11.5H19v9"/>'
    + '<path d="M13.5 15h2.5"/>',
};

/**
 * One icon, as an SVG string ready to drop into a template.
 *
 * A string rather than an element because everything that draws these builds its markup
 * with innerHTML, and handing back a node would mean every call site changed shape.
 */
export function icon(name, opts) {
  const body = PATHS[name];
  return body ? SVG(body, opts) : '';
}

export const ICON_NAMES = Object.keys(PATHS);
