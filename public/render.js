// HexColony board renderer.
//
// Everything on the board is drawn with maths — no bitmaps, no sprite sheets, no
// fonts beyond the system stack. Same rule as the other games in this collection:
// the whole island is a few hundred lines of canvas calls.
//
// The renderer owns the camera (pan + pinch zoom) and the hit testing. It knows how
// to draw a game state but nothing about how the game is played; legality arrives
// pre-computed in `highlights`.

import { HEXES, VERTS, EDGES, boardExtent, edgeOutward, pips, isRed } from './board.js';

const TERRAIN_STYLE = {
  forest:    { a: '#2f6b3a', b: '#1e4a27', ink: '#12331a' },
  hills:     { a: '#b8613a', b: '#8d4425', ink: '#5d2a13' },
  pasture:   { a: '#78bf5c', b: '#579a3e', ink: '#33682a' },
  fields:    { a: '#e3ba57', b: '#c9963a', ink: '#8a6320' },
  mountains: { a: '#8d94a8', b: '#5f6678', ink: '#3b4152' },
  desert:    { a: '#ddc48d', b: '#c2a469', ink: '#8a734a' },
};

// A bright band just inside each hex's edge, in that tile's own resource colour. On an
// illustrated board every tile is a photograph and they all read as "picture" from a
// arm's length; this puts the thing the tile actually pays out back on its rim, where it
// can be scanned without looking at the middle of the tile at all.
//
// Brighter than TERRAIN_STYLE, deliberately — those are the body colours, chosen to sit
// behind artwork, and at the rim they would be one more dark edge. The two greens are
// pulled apart the way the resources are: forest is a true green, pasture a yellow-green,
// because a ring that cannot be told apart at a glance is not worth drawing.
const TERRAIN_EDGE = {
  forest:    '#3fd964',   // wood
  hills:     '#ff8a5c',   // brick
  pasture:   '#c3f04a',   // sheep
  fields:    '#ffd34d',   // wheat
  mountains: '#c7d2e4',   // ore
  desert:    '#f0d9a0',   // pays nothing, so it gets its own sand rather than a resource
};

const RES_COLOR = {
  wood: '#2f6b3a', brick: '#b8613a', sheep: '#78bf5c', wheat: '#e3ba57', ore: '#8d94a8',
};
const RES_ICON = { wood: '🌲', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '⛰️' };
export { RES_COLOR, RES_ICON };

/**
 * The sea, which the host picks before the game starts.
 *
 * Twenty-six of them, ordered from the darkest water to the lightest.
 *
 * An earlier note here claimed light was a constraint rather than a preference — that the
 * cream coastline, the cream port rings and the white piece outlines all needed a bright
 * sea behind them. That was wrong, and backwards: cream and white show up MORE against
 * dark water, not less. What a dark sea actually costs is the board reading as a lit panel
 * inset into dark chrome, which is a look rather than a requirement. So the whole range is
 * here, and the choice is the host's.
 *
 * Each entry gives only the two gradient stops. The wave colours are derived from them,
 * because the right answer flips with the water: on pale seas the swell reads as shadow
 * and has to be darker than the base, and on dark seas it reads as reflected light and has
 * to be lighter. Twenty-six pairs of hand-picked wave colours would be twenty-six chances
 * to get that backwards.
 */
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgbToHex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const towards = (hex, target, t) => rgbToHex(hexToRgb(hex).map((v, i) => v + (target[i] - v) * t));
const relLum = (hex) => {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const BLACK = [0, 0, 0];

/**
 * Both wave colours are found along the gradient the sea already describes, never by
 * mixing with white or black.
 *
 * On pale water the swell reads as shadow, so it carries on PAST the foreground stop —
 * more of the same gradient, which stays in the hue family. Mixing toward black instead
 * washed the colour out of it. On dark water the swell reads as reflected light, so it
 * moves back toward the horizon stop, which is the lighter of the two and is where that
 * sea keeps its colour. Mixing toward white turned every dark sea's swell the same
 * lifeless grey, whatever the water underneath it was.
 */
function makeSea(key, name, a, b) {
  const A = hexToRgb(a), B = hexToRgb(b);
  const past = (k) => rgbToHex(B.map((v, i) => v + (v - A[i]) * k));
  const back = (k) => rgbToHex(B.map((v, i) => v + (A[i] - v) * k));
  const light = relLum(b) > 0.38;
  return {
    key, name, a, b,
    trough: light ? past(0.9) : back(0.85),
    deep: light ? past(1.6) : back(0.5),
    // White crests everywhere except on near-white water, where they would simply vanish;
    // there the highlight has to be a darkening instead.
    crest: relLum(b) > 0.78 ? towards(b, BLACK, 0.3) : '#ffffff',
  };
}

export const SEA_COLORS = [
  makeSea('midnight', 'Midnight',  '#123a5c', '#05121f'),
  makeSea('ink',      'Ink',       '#23304a', '#0b1220'),
  makeSea('abyss',    'Abyss',     '#0f3348', '#04121b'),
  makeSea('pitch',    'Pitch',     '#14513f', '#062018'),
  makeSea('plum',     'Plum',      '#3d2a56', '#170f22'),
  makeSea('wine',     'Wine',      '#6b2740', '#2c0f1b'),
  makeSea('deep',     'Deep',      '#1c5b8c', '#08203a'),
  makeSea('jade',     'Jade',      '#1d7a63', '#0a3c30'),
  makeSea('umber',    'Umber',     '#a06232', '#4d2c15'),
  makeSea('storm',    'Storm',     '#4a5b70', '#222c3a'),
  makeSea('ocean',    'Ocean',     '#2a74ad', '#114166'),
  makeSea('pine',     'Pine',      '#2f9a63', '#12492f'),
  makeSea('reef',     'Reef',      '#1a8f86', '#0a4a45'),
  makeSea('cobalt',   'Cobalt',    '#3f8fd8', '#1e5ea1'),
  makeSea('harbour',  'Harbour',   '#7fb2d8', '#4f83ab'),
  makeSea('slate',    'Slate',     '#aebccb', '#7a8b9c'),
  makeSea('lagoon',   'Lagoon',    '#bfe7f7', '#7cc2e4'),
  makeSea('tropic',   'Tropical',  '#c6f5ee', '#79d9cd'),
  makeSea('moss',     'Moss',      '#cfe3b4', '#9dc17a'),
  makeSea('sky',      'Sky',       '#d8f0ff', '#9ad3f5'),
  makeSea('mint',     'Mint',      '#d6f6e4', '#93ddb4'),
  makeSea('rose',     'Coral',     '#fbe2e4', '#f0aeb4'),
  makeSea('lilac',    'Lilac',     '#e9e2fb', '#bcaaf0'),
  makeSea('overcast', 'Overcast',  '#e6edf3', '#b3c4d2'),
  makeSea('dawn',     'Dawn',      '#fdeed6', '#f5c79b'),
  makeSea('sand',     'Shallows',  '#f6ecd2', '#dfc99a'),
  makeSea('ice',      'Ice',       '#eef8ff', '#c6e6f7'),
].sort((x, y) => relLum(x.b) - relLum(y.b));

/**
 * The sea a game uses, looked up by key.
 *
 * By key and not by index, deliberately. The player colours were stored as positions in
 * an array, and reordering that array silently repainted everybody's pieces. A list this
 * long is going to be reordered again.
 */
export const SEA_DEFAULT = 'lagoon';
export const seaAt = (key) => {
  const preset = SEA_COLORS.find((c) => c.key === key);
  if (preset) return preset;
  const match = String(key || '').match(/^custom:(#[0-9a-f]{6})$/i);
  if (match) {
    const base = match[1].toLowerCase();
    return makeSea(key, 'Custom', towards(base, [255, 255, 255], 0.28), towards(base, [0, 0, 0], 0.28));
  }
  return SEA_COLORS.find((c) => c.key === SEA_DEFAULT);
};

/**
 * A colour that will still be seen against a given sea.
 *
 * The turn ring is drawn in the player's own colour, which is right — it should be *your*
 * colour telling you it is your turn — but the sea is now anything a colour wheel can
 * produce, so "blue player, blue sea" is a ring nobody notices. Rather than abandon the
 * player's colour, it is pushed away from the water until it separates. The hue survives,
 * so the ring still reads as yours; only its lightness moves, and only as far as it has to.
 *
 * The sea is a gradient, so there are two numbers to satisfy and they pull against each
 * other. The bar is 3:1 against the middle of it — the WCAG threshold for a shape rather
 * than for text, which is exactly what this is — with a floor of 2:1 at each end so the
 * ring cannot fade out along the top or the bottom edge.
 *
 * Demanding the full 3 at BOTH ends instead was tried and is too strict to be worth it: a
 * mid blue sea has almost nothing that clears it except white, so every player's ring came
 * back pure white and the one thing the ring is for — telling four players apart at a
 * glance — was gone. Better a red that is plainly red and plainly visible.
 *
 * Every sea the app can produce has an answer that meets that — the tests sweep the
 * presets and a range of custom greys — but the search still tracks its best near-miss
 * and returns that rather than the untouched colour, so a change to the gradient degrades
 * instead of silently handing back a ring that cannot be seen.
 */
const WHITE_RGB = [255, 255, 255];
// Not relLum. That one is a plain channel average, which is all the wave colours need to
// decide whether a swell reads as shadow or as reflected light. A contrast ratio is
// defined against the gamma-decoded value, and the two disagree most in exactly the
// mid-tones a colour wheel lands on — a naive average called a steel-grey sea light
// enough to push a red ring toward black, where it vanished.
const srgbLum = (hex) => {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrastRatio = (a, b) => {
  const la = srgbLum(a) + 0.05, lb = srgbLum(b) + 0.05;
  return la > lb ? la / lb : lb / la;
};
export function readableOnSea(hex, seaValue) {
  const sea = seaAt(seaValue);
  const mid = towards(sea.a, hexToRgb(sea.b), 0.5);
  const ends = (c) => Math.min(contrastRatio(c, sea.a), contrastRatio(c, sea.b));
  const ok = (c) => contrastRatio(c, mid) >= 3 && ends(c) >= 2;
  if (ok(hex)) return hex;

  // Which way to push is settled by measuring, not by a lightness threshold. A bright
  // mid-tone — hot pink, say — reads as "not dark", so a threshold sends the colour
  // toward white, where it arrives at 2.8:1 and stops; black was more than twice as far
  // away the whole time. Both directions are walked and the first shift that passes wins,
  // so the colour moves as little as it has to and keeps its hue.
  let best = hex, score = ends(hex);
  // Whichever end the water is further from is tried first. Order is not cosmetic: on a
  // mid sea both directions eventually pass, and taking the near one lands on a muddy
  // near-black that only just scrapes over the bar, when white was half again as far away.
  const dark = contrastRatio('#000000', mid) > contrastRatio('#ffffff', mid);
  for (const target of dark ? [BLACK, WHITE_RGB] : [WHITE_RGB, BLACK]) {
    // Out to the extreme itself, not almost. Where nothing passes, the answer is whichever
    // end is furthest from the water, and stopping a step short of it gives up contrast
    // for a trace of hue that is not visible at that distance anyway.
    for (let t = 0.085; t <= 1.0001; t += 0.085) {
      const shifted = towards(hex, target, Math.min(t, 1));
      if (ok(shifted)) return shifted;
      const s = ends(shifted);
      if (s > score) { best = shifted; score = s; }
    }
  }
  return best;
}

// Wave layers drawn over the gradient, drifting in opposite directions so the sea never
// looks like a repeating pattern. `role` picks the colour out of whichever sea is in use;
// crests are white in all of them.
const WAVE_LAYERS = [
  { role: 'trough', alpha: 0.30, amp: 3.4, len: 118, rows: 7, speed: 0.055, phase: 0.0, width: 2.0 },
  { role: 'deep',   alpha: 0.20, amp: 2.4, len: 71,  rows: 9, speed: -0.085, phase: 1.7, width: 1.5 },
  { role: 'crest',  alpha: 0.40, amp: 2.0, len: 93,  rows: 8, speed: 0.038, phase: 3.1, width: 1.6 },
];

// Everything a player owns is outlined in the same bright white: roads, settlements and
// cities. Against illustrated tiles the pieces were reading as dark shapes on a dark
// picture, and a colour alone is not enough to pick out at a glance.
//
// A hairline of near-black sits outside the white. It is not decoration — four of the
// fourteen player colours are pale enough to disappear into a white outline on their own,
// and without an outer edge a white player's settlement on a desert tile would have no
// silhouette at all. Dark players get the white, pale players get the dark, and every
// piece keeps an edge on every background.
const OUTLINE = 'rgba(255, 255, 255, 0.95)';
const EDGE_INK = 'rgba(8, 16, 26, 0.85)';

// The roll flash: how long the rolled number stands up at full size, and how long it
// takes getting there and back. The hold is the part that matters — it has to survive a
// glance away and back, which is why the whole thing is well over a second.
const ROLL_ZOOM_MS = 1800;
const ROLL_GROW_MS = 260;
const ROLL_SHRINK_MS = 380;
// About a tenth over the hex at the peak — enough to read as a pop rather than a
// resize, not so much that it lands on the tiles next door.
const ROLL_OVERSHOOT = 1.9;

// A piece landing on the board. The same envelope as the roll flash but half its length
// and without the long hold: the rolled number is a callout you have to be able to read,
// and this is only ever "look here, something happened".
const BUILD_POP_MS = 900;
const BUILD_GROW_MS = 170;
const BUILD_SHRINK_MS = 360;
const BUILD_PEAK = 1.85;

// ---------------------------------------------------------------- terrain art
// Illustrated tiles, if they are present in art/. Each terrain is tried in extension
// order and the first one that decodes wins. Nothing here is required: a missing or
// failed image simply leaves that terrain drawing its procedural motif, so the board
// never ends up blank because a download died.
const TILE_ART = {
  forest:    'wood',
  hills:     'brick',
  pasture:   'sheep',
  fields:    'wheat',
  mountains: 'ore',
  desert:    'desert',   // produces nothing, but it is still a tile you look at
};
const ART_EXT = ['jpg', 'png', 'webp', 'jpeg'];
const artImages = {};   // terrain -> HTMLImageElement once decoded

// Tiles are keyed by terrain but ports are keyed by the resource they trade, so the
// two-for-one badges need the mapping the other way round: 'wood' -> 'forest'.
const TERRAIN_BY_RES = Object.fromEntries(
  Object.entries(TILE_ART).map(([terrain, res]) => [res, terrain])
);

/**
 * Kick off loading the terrain art. Safe to call repeatedly; each terrain is only
 * fetched once. `onLoad` fires per successful image so the caller can redraw.
 */
export function loadTerrainArt(onLoad) {
  for (const [terrain, base] of Object.entries(TILE_ART)) {
    if (artImages[terrain] !== undefined) continue;
    artImages[terrain] = null;                     // "attempted", so we don't retry
    let ext = 0;
    const tryNext = () => {
      if (ext >= ART_EXT.length) return;           // no art for this terrain — fine
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => { artImages[terrain] = img; onLoad?.(terrain); };
      img.onerror = () => { ext += 1; tryNext(); };
      img.src = `art/${base}.${ART_EXT[ext]}`;
    };
    tryNext();
  }
}

/**
 * Bill's settlement and city outlines, from house.svg and city.svg.
 *
 * Path data drawn with Path2D rather than loaded as images: a piece is about twenty
 * pixels across at normal zoom on a phone, where a vector stays crisp and a bitmap turns
 * to mush, and it costs no request, no tint compositing and no cache. The colour is
 * simply the fill.
 *
 * Module level, and the Path2D built once. As a static getter this rebuilt the whole
 * object — and re-parsed both path strings — for every building on the board, on every
 * frame of a loop that runs sixty times a second.
 *
 * `box` is the ink's own extent, not the viewBox: both drawings sit inside a larger
 * canvas, and centring on the viewBox would hang them off the corner.
 */
const PIECES = {
  settlement: {
    d: 'M 20 85 L 80 85 L 80 45 L 50 15 L 20 45 Z',
    box: { x: 20, y: 15, w: 60, h: 70 },
  },
  city: {
    d: 'M 15 85 L 105 85 L 105 55 L 80 30 L 55 55 L 55 30 L 35 15 L 15 30 Z',
    box: { x: 15, y: 15, w: 90, h: 70 },
  },
};
for (const spec of Object.values(PIECES)) spec.path = new Path2D(spec.d);

/** A #rrggbb from the player palette, at an alpha — canvas gradients need the components. */
function hexToRgba(hex, alpha) {
  const h = String(hex).replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, (ch) => ch + ch) : h, 16);
  if (!Number.isFinite(n)) return `rgba(255, 255, 255, ${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export class BoardView {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.board = null;
    this.game = null;
    this.spinPieces = false;
    this.highlights = { verts: [], edges: [], hexes: [], cities: [] };
    this.payout = null;                // what the last roll paid, and to whom
    this.rolled = null;                // the number the dice just showed, and when
    this.zoom = null;                  // this frame's reading of that, set in draw()
    this.built = new Map();            // vertex -> when a piece landed on it
    this.now = 0;                      // this frame's timestamp, for the pops
    this.sea = seaAt(SEA_DEFAULT);
    this.colorOf = () => '#888';       // pid -> css colour, injected by the app
    this.scale = 40;
    this.ox = 0; this.oy = 0;          // pan, in screen pixels
    this.userScale = 1;                // pinch zoom on top of the fit scale
    this.fitScale = 40;
    this.pulse = 0;
    this.onPick = null;                // ({ kind, id }) => void
    this._pointers = new Map();
    this._pinch = null;
    this._moved = false;
    this._bind();

    // A window 'resize' event is not enough. The canvas box also changes when the
    // surrounding layout moves — an on-screen keyboard, a pane being dragged, the
    // address bar collapsing — and those do not always produce a window resize. The
    // observer watches the element itself, which is the thing we actually care about.
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas);
    }
  }

  setBoard(board) { this.board = board; this.built.clear(); this.fit(); }
  setGame(game) { this.game = game; }
  setHighlights(h) { this.highlights = h || { verts: [], edges: [], hexes: [], cities: [] }; }
  setSea(key) { this.sea = seaAt(key); }
  /** `{ hexes, spots: [{ v, colour, city }], until }`, or null for nothing to show. */
  setPayout(p) { this.payout = p; }

  /**
   * Blow the rolled number up to fill every hex that carries it.
   *
   * A number token is small — deliberately, it has to sit on a tile without hiding it —
   * and on a phone, at a glance, "was that an eight or a six, and where are the eights?"
   * is a real question. For a second and a half after the dice land, it is answered
   * without anyone having to look for it.
   *
   * Seven is not a token on any board, so it has nothing to show.
   */
  setRolled(num) {
    this.rolled = (!num || num === 7) ? null : { num, at: performance.now() };
  }

  /**
   * A piece just went up here: make it jump.
   *
   * Keyed by corner rather than kept as a single value, because two can land at once —
   * a city replacing a settlement while somebody else's snake placement lands elsewhere,
   * or simply two quick builds in one turn.
   */
  setBuilt(v) {
    if (!Number.isInteger(v)) return;
    this.built.set(v, performance.now());
  }

  /**
   * How far through its jump a piece is: 0 at rest, 1 at full size.
   *
   * Expired entries are dropped as they are read, so the map never holds more than the
   * pieces currently moving.
   */
  buildPop(v) {
    const at = this.built.get(v);
    if (at === undefined) return 0;
    const ms = this.now - at;
    if (ms < 0) return 0;
    if (ms > BUILD_POP_MS) { this.built.delete(v); return 0; }
    if (ms < BUILD_GROW_MS) {
      const u = ms / BUILD_GROW_MS - 1;
      return Math.max(0, u * u * ((ROLL_OVERSHOOT + 1) * u + ROLL_OVERSHOOT) + 1);
    }
    if (ms < BUILD_POP_MS - BUILD_SHRINK_MS) return 1;
    const u = (BUILD_POP_MS - ms) / BUILD_SHRINK_MS;
    return Math.max(0, u * u);
  }

  /**
   * How far the rolled tokens have grown: 0 at rest, 1 filling the hex.
   *
   * Up with a little overshoot so it reads as a pop rather than a resize, a long hold
   * so it can actually be read, then back down — a token that snapped back to normal
   * looked like a rendering fault.
   */
  rollZoom(t) {
    if (!this.rolled) return null;
    const ms = t - this.rolled.at;
    if (ms < 0 || ms > ROLL_ZOOM_MS) return null;
    let k;
    if (ms < ROLL_GROW_MS) {
      // ease-out-back
      const u = ms / ROLL_GROW_MS - 1;
      k = u * u * ((ROLL_OVERSHOOT + 1) * u + ROLL_OVERSHOOT) + 1;
    } else if (ms < ROLL_ZOOM_MS - ROLL_SHRINK_MS) {
      k = 1;
    } else {
      const u = (ROLL_ZOOM_MS - ms) / ROLL_SHRINK_MS;
      k = u * u;
    }
    return { num: this.rolled.num, k: Math.max(0, k) };
  }

  /**
   * How strongly the payout flash is showing, 0 when it is over.
   *
   * It comes up fast, holds, then fades — a flash that simply vanished at the end read
   * as a glitch, and one that stayed up competed with the build highlights for the rest
   * of the turn.
   */
  payoutLevel(t) {
    if (!this.payout) return 0;
    const left = this.payout.until - t;
    if (left <= 0) return 0;
    return Math.min(1, left / 900);
  }

  // ------------------------------------------------------------ camera
  /** Size the backing store to the element and refit the island inside it. */
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const r = this.cv.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    if (this.cv.width !== w * dpr || this.cv.height !== h * dpr) {
      this.cv.width = w * dpr;
      this.cv.height = h * dpr;
    }
    this.dpr = dpr;
    this.w = w; this.h = h;
    this.fit();
  }

  fit() {
    if (!this.w) return;
    const ext = boardExtent();
    // Leave room for the port badges, which float outside the coastline.
    const pad = 1.25;
    const sx = this.w / (ext.w + pad * 2);
    const sy = this.h / (ext.h + pad * 2);
    this.fitScale = Math.min(sx, sy);
    this.scale = this.fitScale * this.userScale;
    // Centre on the island's own middle rather than on the world origin. The classic
    // board happens to straddle the origin; the expansion does not, and assuming it
    // does would hang it off the bottom of the screen.
    this.cx = this.w / 2 - ((ext.minX + ext.maxX) / 2) * this.scale;
    this.cy = this.h / 2 - ((ext.minY + ext.maxY) / 2) * this.scale;
  }

  toScreen(x, y) {
    return [this.cx + x * this.scale + this.ox, this.cy + y * this.scale + this.oy];
  }
  toWorld(px, py) {
    return [(px - this.cx - this.ox) / this.scale, (py - this.cy - this.oy) / this.scale];
  }

  zoomBy(factor, atX, atY) {
    const before = this.toWorld(atX, atY);
    this.userScale = Math.max(0.75, Math.min(3.2, this.userScale * factor));
    this.scale = this.fitScale * this.userScale;
    const after = this.toWorld(atX, atY);
    // Keep the point under the fingers pinned while the scale changes.
    this.ox += (after[0] - before[0]) * this.scale;
    this.oy += (after[1] - before[1]) * this.scale;
    this.clampPan();
  }

  resetView() { this.userScale = 1; this.ox = 0; this.oy = 0; this.fit(); }

  // Don't let the island be dragged off screen entirely.
  clampPan() {
    const ext = boardExtent();
    const halfW = (ext.w / 2 + 1.5) * this.scale;
    const halfH = (ext.h / 2 + 1.5) * this.scale;
    const limX = Math.max(0, halfW - this.w / 2 + this.w * 0.35);
    const limY = Math.max(0, halfH - this.h / 2 + this.h * 0.35);
    this.ox = Math.max(-limX, Math.min(limX, this.ox));
    this.oy = Math.max(-limY, Math.min(limY, this.oy));
  }

  // ------------------------------------------------------------ input
  _bind() {
    const cv = this.cv;
    cv.style.touchAction = 'none';

    cv.addEventListener('pointerdown', (e) => {
      // Capture keeps a drag alive if the finger leaves the canvas. It throws for a
      // pointer the browser doesn't recognise (synthetic events, some older engines),
      // and losing capture is far better than losing the whole gesture.
      try { cv.setPointerCapture(e.pointerId); } catch { /* drag still works */ }
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
      if (this._pointers.size === 2) {
        const [a, b] = [...this._pointers.values()];
        this._pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
      this._moved = false;
    });

    cv.addEventListener('pointermove', (e) => {
      const p = this._pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > 9) this._moved = true;

      if (this._pointers.size === 2 && this._pinch) {
        const [a, b] = [...this._pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const r = cv.getBoundingClientRect();
        this.zoomBy(dist / this._pinch, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
        this._pinch = dist;
        this._moved = true;
      } else if (this._pointers.size === 1) {
        this.ox += dx; this.oy += dy;
        this.clampPan();
      }
    });

    const end = (e) => {
      const p = this._pointers.get(e.pointerId);
      this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) this._pinch = null;
      if (!p || this._moved || this._pointers.size) return;
      // A tap that didn't drag is a pick.
      const r = cv.getBoundingClientRect();
      const hit = this.hitTest(e.clientX - r.left, e.clientY - r.top);
      if (hit && this.onPick) this.onPick(hit);
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', (e) => { this._pointers.delete(e.pointerId); this._pinch = null; });

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
  }

  /**
   * What did the player tap? Only currently-legal targets are pickable, so a stray
   * tap near a vertex can never be read as an illegal build.
   */
  hitTest(px, py) {
    const [wx, wy] = this.toWorld(px, py);
    const h = this.highlights;

    if (h.verts?.length || h.cities?.length) {
      let best = null, bestD = 0.42, kind = 'vertex';
      for (const v of h.verts || []) {
        const d = Math.hypot(VERTS[v].x - wx, VERTS[v].y - wy);
        if (d < bestD) { bestD = d; best = v; kind = 'vertex'; }
      }
      for (const v of h.cities || []) {
        const d = Math.hypot(VERTS[v].x - wx, VERTS[v].y - wy);
        if (d < bestD) { bestD = d; best = v; kind = 'city'; }
      }
      if (best !== null) return { kind, id: best };
    }
    if (h.edges?.length) {
      let best = null, bestD = 0.34;
      for (const e of h.edges) {
        const d = Math.hypot(EDGES[e].x - wx, EDGES[e].y - wy);
        if (d < bestD) { bestD = d; best = e; }
      }
      if (best !== null) return { kind: 'edge', id: best };
    }
    if (h.hexes?.length) {
      let best = null, bestD = 0.95;
      for (const i of h.hexes) {
        const d = Math.hypot(HEXES[i].x - wx, HEXES[i].y - wy);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best !== null) return { kind: 'hex', id: best };
    }
    // Nothing legal nearby — report the tile so the UI can show what it produces.
    let best = null, bestD = 0.95;
    for (const hex of HEXES) {
      const d = Math.hypot(hex.x - wx, hex.y - wy);
      if (d < bestD) { bestD = d; best = hex.i; }
    }
    return best === null ? null : { kind: 'info', id: best };
  }

  // ------------------------------------------------------------ drawing
  draw(t = 0) {
    if (!this.board || !this.w) return;
    this.pulse = (Math.sin(t / 340) + 1) / 2;
    this.now = t;
    // Read once per frame: drawHex leaves the rolled tokens out so they can be drawn
    // again at the end, over everything, instead of being painted over by the next tile.
    this.zoom = this.rollZoom(t);
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);

    const paying = this.payoutLevel(t);

    this.drawWater(t);
    this.drawCoast();
    for (const tile of this.board.tiles) this.drawHex(tile);
    if (paying) this.drawPayingHexes(paying);
    this.drawPorts();
    this.drawHexHighlights();
    this.drawRoads();
    this.drawEdgeHighlights();
    if (paying) this.drawPayingSpots(paying);
    this.drawBuildings();
    this.drawRobber();
    this.drawVertexHighlights();
    this.drawCityHighlights();
    if (this.zoom) this.drawRolledTokens(this.zoom.k);
  }

  drawWater(t = 0) {
    const c = this.ctx;
    c.fillStyle = this.waterGrad();
    c.fillRect(0, 0, this.w, this.h);

    // The swell drifts. The render loop already runs every frame for the highlight
    // pulse, so animating this costs nothing beyond the strokes themselves.
    c.save();
    c.lineCap = 'round';
    for (const L of WAVE_LAYERS) {
      c.globalAlpha = L.alpha;
      c.strokeStyle = this.sea[L.role];
      c.lineWidth = L.width;
      const drift = (t / 1000) * L.speed * 60;
      for (let i = 0; i < L.rows; i++) {
        // Rows are nudged off an even grid so the layers never line up into bands.
        const y = ((i + 0.5) / L.rows) * this.h + Math.sin(i * 2.3 + L.phase) * 6;
        c.beginPath();
        for (let x = 0; x <= this.w + 8; x += 8) {
          const yy = y
            + Math.sin(x / L.len + drift + i * 1.31 + L.phase) * L.amp
            + Math.sin(x / (L.len * 0.41) + drift * 1.6 + i) * (L.amp * 0.38);
          x === 0 ? c.moveTo(x, yy) : c.lineTo(x, yy);
        }
        c.stroke();
      }
    }
    c.restore();
  }

  /**
   * The outline of one tile, as a Path2D that survives between uses.
   *
   * Every hexagon used to be walked from scratch at each use, and a tile is used four
   * times in a single pass of drawHex alone — fill, clip, inside border, outer hairline —
   * on top of twice more for the coast and twice again when it is highlighted. That is
   * around two hundred rebuilds a frame for thirty tiles, each one six toScreen calls
   * handing back a fresh two-element array. Sixty times a second it is the largest source
   * of garbage in the renderer, and none of it describes anything new: the shape only
   * moves when the view does.
   *
   * So the shapes are kept, and thrown away together the moment the view changes. The key
   * is the whole transform, which means a pan or a pinch invalidates every path at once
   * (correctly, and without needing to be told), while a still board — which is what the
   * board is almost all of the time — rebuilds nothing at all.
   */
  /**
   * What the caches are allowed to outlive: everything that decides where a world point
   * lands on screen. Anything cached in screen coordinates is keyed on this, so a pan, a
   * pinch or a resize drops the lot without any of them having to be told separately.
   */
  viewEpoch() {
    const epoch = `${this.cx},${this.cy},${this.ox},${this.oy},${this.scale}`;
    if (epoch !== this._epoch) {
      this._epoch = epoch;
      this._paths = new Map();
      this._terrainGrads = new Map();
    }
    return epoch;
  }

  hexPath(tile, shrink = 1) {
    this.viewEpoch();
    const key = `${tile.i}|${shrink}`;
    let path = this._paths.get(key);
    if (!path) {
      path = new Path2D();
      const corners = HEXES[tile.i].corners;
      corners.forEach((vid, i) => {
        const v = VERTS[vid];
        const x = tile.x + (v.x - tile.x) * shrink;
        const y = tile.y + (v.y - tile.y) * shrink;
        const [sx, sy] = this.toScreen(x, y);
        i === 0 ? path.moveTo(sx, sy) : path.lineTo(sx, sy);
      });
      path.closePath();
      this._paths.set(key, path);
    }
    return path;
  }

  /**
   * The two gradients every tile is painted with, kept rather than rebuilt.
   *
   * Both were being constructed per tile per frame — sixty objects a frame on the big
   * board, each parsing its colour stops afresh — to describe a picture that had not
   * changed. Neither depends on anything that moves between frames: the terrain ramp is
   * the terrain's two colours over the tile's height, and the vignette is the same wash on
   * every tile of a given size.
   *
   * A canvas gradient carries its own coordinates, which is what decides how each is
   * cached. The terrain ramp is built where the tile is, so it is keyed on that and
   * dropped whenever the view moves. The vignette is filled through a translate to the
   * tile centre, so its shape is the same wherever it lands and its size is the whole key.
   */
  terrainGrad(terrain, cx, cy, R) {
    this.viewEpoch();
    const key = `${terrain}|${cx}|${cy}`;
    let g = this._terrainGrads.get(key);
    if (!g) {
      const st = TERRAIN_STYLE[terrain];
      g = this.ctx.createLinearGradient(cx, cy - R, cx, cy + R);
      g.addColorStop(0, st.a);
      g.addColorStop(1, st.b);
      this._terrainGrads.set(key, g);
    }
    return g;
  }

  vignetteGrad(R) {
    if (!this._vignette || this._vignetteR !== R) {
      const g = this.ctx.createRadialGradient(0, 0, R * 0.16, 0, 0, R);
      g.addColorStop(0, 'rgba(10, 20, 32, 0.32)');
      g.addColorStop(0.55, 'rgba(10, 20, 32, 0.06)');
      g.addColorStop(1, 'rgba(10, 20, 32, 0.22)');
      this._vignette = g;
      this._vignetteR = R;
    }
    return this._vignette;
  }

  waterGrad() {
    const key = `${this.h}|${this.sea.a}|${this.sea.b}`;
    if (this._waterKey !== key) {
      const g = this.ctx.createLinearGradient(0, 0, 0, this.h);
      g.addColorStop(0, this.sea.a);
      g.addColorStop(1, this.sea.b);
      this._water = g;
      this._waterKey = key;
    }
    return this._water;
  }

  /** A soft sand halo around the whole island so the land reads as one landmass. */
  drawCoast() {
    const c = this.ctx;
    c.save();
    // Deeper and more opaque than it needs to be on a dark sea: against bright water a
    // pale halo at low alpha simply is not there.
    c.strokeStyle = 'rgba(214, 178, 116, 0.55)';
    c.lineJoin = 'round';
    for (const w of [0.30, 0.16]) {
      c.lineWidth = this.scale * w;
      for (const tile of this.board.tiles) c.stroke(this.hexPath(tile, 1.04));
    }
    c.restore();
  }

  drawHex(tile) {
    const c = this.ctx;
    const st = TERRAIN_STYLE[tile.terrain];
    const [cx, cy] = this.toScreen(tile.x, tile.y);
    const R = this.scale;

    // One shape, used four times over: the flat fill, the mask the art sits inside, the
    // inside border and the outer hairline are all this same hexagon.
    const path = this.hexPath(tile, 0.985);

    // The flat colour goes down first either way: it is what shows through the
    // gaps if an illustration has transparent corners, and it is the whole tile
    // when there is no illustration.
    c.fillStyle = this.terrainGrad(tile.terrain, cx, cy, R);
    c.fill(path);

    const art = artImages[tile.terrain];
    c.save();
    c.clip(path);
    if (art && art.naturalWidth) this.drawTerrainArt(art, cx, cy, R);
    else this.drawTerrainMotif(tile, cx, cy, R, st);

    // Still inside the clip, which is what makes this an inside border: the stroke is
    // drawn at twice its intended width and the outer half is clipped away, leaving a
    // band that hugs the edge exactly instead of straddling it.
    c.strokeStyle = TERRAIN_EDGE[tile.terrain] || st.a;
    c.lineWidth = Math.max(2, R * 0.15);
    c.globalAlpha = 0.9;
    c.stroke(path);
    c.restore();

    c.strokeStyle = 'rgba(12, 24, 36, 0.45)';
    c.lineWidth = Math.max(1, R * 0.035);
    c.stroke(path);

    if (tile.num && tile.num !== this.zoom?.num) this.drawToken(tile, cx, cy, R);
  }

  /**
   * Paint an illustrated tile inside the current hex clip.
   *
   * The art is cropped to the artwork hexagon's exact bounding box (see
   * scripts/slice-tiles.mjs), and those tiles are pointy-top — the same orientation the
   * board draws — so the illustration lines up with the hex instead of being an
   * arbitrary texture behind it. The four corners of the image lie outside the hexagon
   * and are simply masked away by the caller's clip.
   *
   * The small overscan covers the pixel or two of slop in measuring where the printed
   * border ends, so no sliver of it can appear along an edge. A vignette at the end
   * keeps the number token readable over a busy picture.
   */
  drawTerrainArt(img, cx, cy, R) {
    const c = this.ctx;
    const boxW = R * Math.sqrt(3) * 1.02;
    const boxH = R * 2 * 1.02;
    const scale = Math.max(boxW / img.naturalWidth, boxH / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    c.drawImage(img, cx - w / 2, cy - h / 2, w, h);

    // Darken the middle a little so the cream token and its number stay legible.
    c.save();
    c.translate(cx, cy);
    c.fillStyle = this.vignetteGrad(R);
    c.fillRect(-R * 1.1, -R * 1.1, R * 2.2, R * 2.2);
    c.restore();
  }

  /** Each terrain gets a cheap procedural texture: trees, rows, tufts, stalks, peaks. */
  drawTerrainMotif(tile, cx, cy, R, st) {
    const c = this.ctx;
    c.save();
    c.globalAlpha = 0.5;
    c.fillStyle = st.ink;
    c.strokeStyle = st.ink;
    // A per-tile jitter keeps neighbouring tiles from looking stamped.
    const j = (n) => ((Math.sin((tile.i + 1) * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;

    if (tile.terrain === 'forest') {
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + j(i);
        const rr = R * (0.28 + j(i + 20) * 0.42);
        const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
        const s = R * 0.17;
        c.beginPath();
        c.moveTo(x, y - s); c.lineTo(x + s * 0.62, y + s * 0.7); c.lineTo(x - s * 0.62, y + s * 0.7);
        c.closePath(); c.fill();
      }
    } else if (tile.terrain === 'hills') {
      c.lineWidth = R * 0.05;
      for (let row = -3; row <= 3; row++) {
        const y = cy + row * R * 0.24;
        c.beginPath(); c.moveTo(cx - R * 0.8, y); c.lineTo(cx + R * 0.8, y); c.stroke();
        for (let k = -3; k <= 3; k++) {
          const x = cx + k * R * 0.32 + (row % 2 ? R * 0.16 : 0);
          c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + R * 0.24); c.stroke();
        }
      }
    } else if (tile.terrain === 'pasture') {
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2 + j(i) * 2;
        const rr = R * (0.2 + j(i + 30) * 0.5);
        const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
        c.beginPath(); c.ellipse(x, y, R * 0.09, R * 0.06, 0, 0, Math.PI * 2); c.fill();
      }
    } else if (tile.terrain === 'fields') {
      c.lineWidth = R * 0.045;
      for (let i = 0; i < 11; i++) {
        const x = cx + (i - 5) * R * 0.17;
        c.beginPath();
        c.moveTo(x, cy + R * 0.55);
        c.lineTo(x + R * 0.05, cy - R * 0.5);
        c.stroke();
      }
    } else if (tile.terrain === 'mountains') {
      for (let i = 0; i < 4; i++) {
        const x = cx + (i - 1.5) * R * 0.42;
        const y = cy + (i % 2 ? R * 0.18 : -R * 0.05);
        const s = R * 0.34;
        c.beginPath();
        c.moveTo(x, y - s); c.lineTo(x + s * 0.85, y + s * 0.6); c.lineTo(x - s * 0.85, y + s * 0.6);
        c.closePath(); c.fill();
      }
    } else {
      // desert dunes
      c.lineWidth = R * 0.055;
      for (let i = 0; i < 4; i++) {
        const y = cy + (i - 1.5) * R * 0.32;
        c.beginPath();
        c.moveTo(cx - R * 0.62, y);
        c.quadraticCurveTo(cx, y - R * 0.16, cx + R * 0.62, y);
        c.stroke();
      }
    }
    c.restore();
  }

  /**
   * The number token. `grow` of 1 is its resting size; the roll flash passes more, and
   * every part of it — ring, shadow, digits, pips — is sized off the same number, so it
   * scales as one piece rather than a circle with a fixed-size number inside it.
   */
  drawToken(tile, cx, cy, R, grow = 1) {
    const c = this.ctx;
    const S = R * grow;
    const rad = S * 0.30;
    const red = isRed(tile.num);
    const robbed = this.game && this.game.robber === tile.i;

    c.save();
    c.beginPath(); c.arc(cx, cy, rad, 0, Math.PI * 2);
    c.fillStyle = robbed ? '#9aa0ac' : '#f3e6cb';
    c.shadowColor = 'rgba(0,0,0,0.45)';
    c.shadowBlur = S * 0.16;
    c.shadowOffsetY = S * 0.045;
    c.fill();
    c.restore();

    c.beginPath(); c.arc(cx, cy, rad, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(60,44,20,0.55)';
    c.lineWidth = Math.max(1, S * 0.025);
    c.stroke();

    c.fillStyle = red ? '#b3261e' : '#3b2f1c';
    c.font = `700 ${rad * 1.06}px ui-rounded, "Segoe UI", system-ui, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(String(tile.num), cx, cy - rad * 0.12);

    // Probability dots — the quickest read of how good a tile is.
    const n = pips(tile.num);
    const dr = Math.max(0.9, rad * 0.075);
    const gap = dr * 2.7;
    for (let i = 0; i < n; i++) {
      const x = cx + (i - (n - 1) / 2) * gap;
      c.beginPath(); c.arc(x, cy + rad * 0.52, dr, 0, Math.PI * 2);
      c.fillStyle = red ? '#b3261e' : '#3b2f1c';
      c.fill();
    }
  }

  /**
   * The rolled number, over the top of everything, on every hex that carries it.
   *
   * Full size is the hexagon's incircle — a circle at 0.866 of the circumradius grazes
   * all six edges — so the token grows to exactly fill its tile and no further. It does
   * cover a house or a road for the second it is up, which is the trade: a callout that
   * ducked behind the pieces would be no callout at all.
   */
  drawRolledTokens(k) {
    const full = 0.86 / 0.30;               // token radius at rest is 0.30 of the hex
    const grow = 1 + k * (full - 1);
    for (const tile of this.board.tiles) {
      if (tile.num !== this.zoom.num) continue;
      const [cx, cy] = this.toScreen(tile.x, tile.y);
      this.drawToken(tile, cx, cy, this.scale, grow);
    }
  }

  drawPorts() {
    const c = this.ctx;
    const R = this.scale;
    for (const p of this.board.ports) {
      const out = edgeOutward(p.edge);
      const e = EDGES[p.edge];
      const bx = e.x + out.x * 0.72;
      const by = e.y + out.y * 0.72;
      const [sx, sy] = this.toScreen(bx, by);

      // Two mooring lines from the badge back to the vertices that can use it, in
      // white so they read as rope against the water rather than as more water.
      //
      // Drawn twice: a dark line first, a little wider, then the white one over it. The
      // seas run from near-black to near-white, and a plain white line simply vanishes
      // on Ice or Sky — the darker line underneath is what keeps it a line on all
      // twenty-seven of them.
      c.save();
      c.lineCap = 'round';
      const ropeW = Math.max(1, R * 0.055);
      for (const [style, width] of [['rgba(10, 28, 44, 0.45)', ropeW + Math.max(1.2, R * 0.03)],
                                    ['rgba(255, 255, 255, 0.95)', ropeW]]) {
        c.strokeStyle = style;
        c.lineWidth = width;
        for (const vid of [p.a, p.b]) {
          const [vx, vy] = this.toScreen(VERTS[vid].x, VERTS[vid].y);
          c.beginPath(); c.moveTo(sx, sy); c.lineTo(vx, vy); c.stroke();
        }
      }
      c.restore();

      const rad = R * 0.33;
      const art = p.kind === 'any' ? null : artImages[TERRAIN_BY_RES[p.kind]];

      if (art && art.naturalWidth) {
        // A two-for-one port wears a picture of what it trades in.
        //
        // Scaling by WIDTH is exact rather than approximate: the tile images are
        // cropped to a pointy-top hexagon's bounding box, and the incircle of a
        // pointy-top hexagon has a diameter equal to that width. So a circle fitted to
        // the image width is precisely the hexagon's incircle — it grazes the six edges
        // and cannot reach the corner areas that lie outside the hexagon.
        c.save();
        c.beginPath(); c.arc(sx, sy, rad, 0, Math.PI * 2);
        c.clip();
        const scale = (rad * 2) / art.naturalWidth;
        const w = art.naturalWidth * scale;
        const h = art.naturalHeight * scale;
        c.drawImage(art, sx - w / 2, sy - h / 2, w, h);
        c.restore();
      } else {
        // No art loaded (yet, or at all) — the flat colour still says which resource.
        c.beginPath(); c.arc(sx, sy, rad, 0, Math.PI * 2);
        c.fillStyle = p.kind === 'any' ? '#e8d6b2' : RES_COLOR[p.kind];
        c.fill();
      }

      // A cream ring reads as a life buoy and separates the badge from the sea.
      c.beginPath(); c.arc(sx, sy, rad, 0, Math.PI * 2);
      c.strokeStyle = 'rgba(232, 214, 178, 0.92)';
      c.lineWidth = Math.max(1.2, R * 0.05);
      c.stroke();
      c.beginPath(); c.arc(sx, sy, rad + Math.max(1, R * 0.03), 0, Math.PI * 2);
      c.strokeStyle = 'rgba(18,45,64,0.75)';
      c.lineWidth = Math.max(1, R * 0.022);
      c.stroke();

      if (p.kind === 'any') {
        c.fillStyle = '#2a2118';
        c.font = `800 ${rad * 0.72}px ui-rounded, "Segoe UI", system-ui, sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('3:1', sx, sy);
      } else if (rad > 15) {
        // The rate only fits once the board is zoomed in. Below that the picture is the
        // label — a resource port is always 2:1 — and stamping tiny text over a photo
        // would be noise rather than information.
        const bandH = rad * 0.52;
        c.save();
        c.beginPath(); c.arc(sx, sy, rad, 0, Math.PI * 2); c.clip();
        c.fillStyle = 'rgba(8, 18, 30, 0.72)';
        c.fillRect(sx - rad, sy + rad - bandH, rad * 2, bandH);
        c.restore();
        c.fillStyle = '#f3e6cb';
        c.font = `800 ${bandH * 0.78}px ui-rounded, "Segoe UI", system-ui, sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('2:1', sx, sy + rad - bandH / 2);
      }
    }
  }

  drawRoads() {
    if (!this.game) return;
    const c = this.ctx;
    const R = this.scale;
    for (const [eid, pid] of Object.entries(this.game.roads)) {
      const e = EDGES[eid];
      const [ax, ay] = this.toScreen(VERTS[e.a].x, VERTS[e.a].y);
      const [bx, by] = this.toScreen(VERTS[e.b].x, VERTS[e.b].y);
      // Pull the ends in so two roads meeting at a vertex read as two pieces.
      const t = 0.16;
      const x1 = ax + (bx - ax) * t, y1 = ay + (by - ay) * t;
      const x2 = bx - (bx - ax) * t, y2 = by - (by - ay) * t;
      c.lineCap = 'round';
      // Three passes, widest first, so each one leaves a ring of the one beneath: a thin
      // dark edge on the outside, then the bright white outline, then the owner's colour
      // down the middle. See OUTLINE for why both edges are there.
      const stripe = (w, style) => {
        c.strokeStyle = style;
        c.lineWidth = w;
        c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
      };
      stripe(R * 0.245, EDGE_INK);
      stripe(R * 0.215, OUTLINE);
      stripe(R * 0.125, this.colorOf(pid));
    }
  }

  drawBuildings() {
    if (!this.game) return;
    // A piece mid-jump is drawn after the settled ones. Corners are close enough together
    // that at nearly twice size a neighbour would otherwise paint over the very piece the
    // jump is pointing at.
    const jumping = [];
    const activePid = this.game.seats?.[this.game.turn?.seat];
    for (const [vid, b] of Object.entries(this.game.bldg)) {
      const v = Number(vid);
      const k = this.buildPop(v);
      if (k > 0) { jumping.push([v, b, k]); continue; }
      const [x, y] = this.toScreen(VERTS[v].x, VERTS[v].y);
      const spin = this.spinPieces && b.p === activePid;
      b.t === 'c' ? this.drawCity(x, y, this.colorOf(b.p), 1, spin) : this.drawSettlement(x, y, this.colorOf(b.p), 1, spin);
    }
    for (const [v, b, k] of jumping) {
      const [x, y] = this.toScreen(VERTS[v].x, VERTS[v].y);
      const grow = 1 + k * (BUILD_PEAK - 1);
      const spin = this.spinPieces && b.p === activePid;
      b.t === 'c' ? this.drawCity(x, y, this.colorOf(b.p), grow, spin) : this.drawSettlement(x, y, this.colorOf(b.p), grow, spin);
    }
  }

  /** The piece outlines, for anything outside the renderer that wants them. */
  static get PIECES() { return PIECES; }

  /**
   * Stand a piece on a corner, sized by height so a city reads as wider than a house
   * rather than merely taller.
   */
  drawPiece(kind, x, y, color, height, spin = false) {
    const spec = PIECES[kind];
    if (!spec) return;
    const c = this.ctx;
    const k = height / spec.box.h;

    c.save();
    c.translate(x, y);
    if (spin) {
      // Rotate around the building's screen-space centre before applying the
      // local artwork transform, keeping the board corner fixed.
      const centreY = -(spec.box.h * 0.28) * k;
      c.translate(0, centreY);
      c.rotate(this.now / 900);
      c.translate(0, -centreY);
    }
    c.scale(k, k);
    // Bottom-centre of the drawing on the corner, nudged down so it sits on the
    // junction instead of floating above it.
    c.translate(-(spec.box.x + spec.box.w / 2), -spec.box.y - spec.box.h + spec.box.h * 0.22);

    const path = spec.path;
    c.shadowColor = 'rgba(0, 0, 0, 0.5)';
    c.shadowBlur = 7;
    c.shadowOffsetY = 3;
    c.fillStyle = color;
    c.fill(path);

    c.shadowColor = 'transparent';
    c.lineJoin = 'round';
    // Same two edges as the roads. Widest first: the dark pass survives only as a hairline
    // outside the white, which is what keeps a pale piece from dissolving into it.
    c.lineWidth = 11;
    c.strokeStyle = EDGE_INK;
    c.stroke(path);
    c.lineWidth = 7;
    c.strokeStyle = OUTLINE;
    c.stroke(path);
    c.restore();
  }

  drawSettlement(x, y, color, grow = 1, spin = false) { this.drawPiece('settlement', x, y, color, this.scale * 0.52 * grow, spin); }
  drawCity(x, y, color, grow = 1, spin = false) { this.drawPiece('city', x, y, color, this.scale * 0.58 * grow, spin); }

  drawRobber() {
    if (!this.game) return;
    // Switched off for this game: there is no piece and no blocked tile.
    if (this.game.useRobber === false) return;
    const tile = this.board.tiles[this.game.robber];
    if (!tile) return;
    const [x, y] = this.toScreen(tile.x, tile.y - 0.42);
    const c = this.ctx;
    const s = this.scale * 0.26;
    c.save();
    c.translate(x, y);
    c.fillStyle = '#15181f';
    c.strokeStyle = 'rgba(240,240,245,0.55)';
    c.lineWidth = Math.max(1, s * 0.13);
    c.beginPath();               // hooded body
    c.moveTo(-s * 0.72, s * 1.0);
    c.quadraticCurveTo(-s * 0.72, -s * 0.25, 0, -s * 0.55);
    c.quadraticCurveTo(s * 0.72, -s * 0.25, s * 0.72, s * 1.0);
    c.closePath();
    c.shadowColor = 'rgba(0,0,0,0.6)';
    c.shadowBlur = s * 0.9;
    c.fill();
    c.shadowColor = 'transparent';
    c.stroke();
    c.beginPath();               // head
    c.arc(0, -s * 0.72, s * 0.42, 0, Math.PI * 2);
    c.fill(); c.stroke();
    c.restore();
  }

  // ------------------------------------------------------------ the payout flash
  //
  // The tiles that just came up, and every building standing on them. Between them these
  // answer "what did that roll do, and who got it?" without anyone having to read the
  // log or count corners.

  /** The producing tiles, lit from within and ringed. */
  drawPayingHexes(level) {
    const c = this.ctx;
    const beat = 0.72 + this.pulse * 0.28;
    for (const i of this.payout.hexes) {
      const tile = this.board.tiles[i];
      if (!tile) continue;
      const [cx, cy] = this.toScreen(tile.x, tile.y);
      const R = this.scale;

      const path = this.hexPath(tile, 0.985);
      c.save();
      c.clip(path);
      // Brightest at the rim, so the illustration underneath still shows through. This one
      // is rebuilt each frame on purpose: its stops carry the payout's own fade.
      const glow = c.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
      glow.addColorStop(0, `rgba(255, 248, 214, ${0.06 * level * beat})`);
      glow.addColorStop(1, `rgba(255, 236, 150, ${0.52 * level * beat})`);
      c.fillStyle = glow;
      c.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);

      c.strokeStyle = `rgba(255, 255, 255, ${0.95 * level})`;
      c.lineWidth = Math.max(3, R * 0.22);
      c.stroke(path);
      c.restore();

      c.strokeStyle = `rgba(255, 214, 92, ${0.9 * level * beat})`;
      c.lineWidth = Math.max(2, R * 0.07);
      c.stroke(path);
    }
  }

  /** A halo in the owner's colour under every building that is being paid. */
  drawPayingSpots(level) {
    const c = this.ctx;
    const R = this.scale;
    const beat = 0.7 + this.pulse * 0.3;
    for (const spot of this.payout.spots) {
      const [x, y] = this.toScreen(VERTS[spot.v].x, VERTS[spot.v].y);
      const rad = R * (spot.city ? 0.46 : 0.38) * (0.94 + this.pulse * 0.12);

      // A soft disc of their colour first — this is the part that says WHO at a glance.
      const halo = c.createRadialGradient(x, y, rad * 0.15, x, y, rad);
      halo.addColorStop(0, hexToRgba(spot.colour, 0.9 * level));
      halo.addColorStop(1, hexToRgba(spot.colour, 0));
      c.fillStyle = halo;
      c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2); c.fill();

      c.beginPath(); c.arc(x, y, rad * 0.82, 0, Math.PI * 2);
      c.strokeStyle = `rgba(255, 255, 255, ${0.85 * level * beat})`;
      c.lineWidth = Math.max(1.5, R * 0.045);
      c.stroke();
    }
  }

  // ------------------------------------------------------------ highlights
  /**
   * Corners a settlement could go on.
   *
   * Half the size they were. They are a pointer at a spot, not a picture of the piece
   * that will land on it, and at the old size a board full of legal corners in the
   * opening placements read as a rash of white blobs with an island somewhere behind it.
   *
   * The dot shrinking does not shrink what you can hit: hitTest works to a fixed radius
   * in board coordinates and has never looked at what was drawn, so the target stays as
   * generous as it was while the mark over it gets out of the way.
   */
  drawVertexHighlights() {
    const list = this.highlights.verts || [];
    if (!list.length) return;
    const c = this.ctx;
    const R = this.scale;
    const grow = 0.10 + this.pulse * 0.03;
    for (const vid of list) {
      const [x, y] = this.toScreen(VERTS[vid].x, VERTS[vid].y);
      c.beginPath(); c.arc(x, y, R * grow, 0, Math.PI * 2);
      c.fillStyle = `rgba(255,255,255,${0.20 + this.pulse * 0.16})`;
      c.fill();
      c.beginPath(); c.arc(x, y, R * grow, 0, Math.PI * 2);
      c.strokeStyle = `rgba(255,255,255,${0.65 + this.pulse * 0.3})`;
      // Halved with the circle. A ring drawn at the old width around a dot half the size
      // is mostly ring, and the pulse stops reading as a pulse.
      c.lineWidth = Math.max(1, R * 0.025);
      c.stroke();
    }
  }

  /**
   * Corners that would take an upgrade, ringed in gold rather than white.
   *
   * The distinction matters because both kinds of corner are tappable at the same time
   * now: white means a new settlement goes here, gold means the settlement already here
   * becomes a city. Drawn as a ring around the existing piece rather than a disc over it,
   * so the piece and its owner stay visible.
   */
  drawCityHighlights() {
    const list = this.highlights.cities || [];
    if (!list.length) return;
    const c = this.ctx;
    const R = this.scale;
    const rad = R * (0.30 + this.pulse * 0.05);
    for (const vid of list) {
      const [x, y] = this.toScreen(VERTS[vid].x, VERTS[vid].y);
      c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2);
      c.strokeStyle = `rgba(255, 214, 92, ${0.75 + this.pulse * 0.25})`;
      c.lineWidth = Math.max(2, R * 0.06);
      c.stroke();
      c.beginPath(); c.arc(x, y, rad + Math.max(1.5, R * 0.045), 0, Math.PI * 2);
      c.strokeStyle = `rgba(20, 12, 0, ${0.35 * (0.6 + this.pulse * 0.4)})`;
      c.lineWidth = Math.max(1, R * 0.02);
      c.stroke();
    }
  }

  drawEdgeHighlights() {
    const list = this.highlights.edges || [];
    if (!list.length) return;
    const c = this.ctx;
    const R = this.scale;
    c.save();
    c.lineCap = 'round';
    c.setLineDash([R * 0.16, R * 0.13]);
    for (const eid of list) {
      const e = EDGES[eid];
      const [ax, ay] = this.toScreen(VERTS[e.a].x, VERTS[e.a].y);
      const [bx, by] = this.toScreen(VERTS[e.b].x, VERTS[e.b].y);
      const t = 0.18;
      c.beginPath();
      c.moveTo(ax + (bx - ax) * t, ay + (by - ay) * t);
      c.lineTo(bx - (bx - ax) * t, by - (by - ay) * t);
      c.strokeStyle = `rgba(255,255,255,${0.55 + this.pulse * 0.35})`;
      c.lineWidth = R * 0.11;
      c.stroke();
    }
    c.restore();
  }

  drawHexHighlights() {
    const list = this.highlights.hexes || [];
    if (!list.length) return;
    const c = this.ctx;
    for (const i of list) {
      const tile = this.board.tiles[i];
      const path = this.hexPath(tile, 0.9);
      c.fillStyle = `rgba(255,255,255,${0.10 + this.pulse * 0.13})`;
      c.fill(path);
      c.strokeStyle = `rgba(255,255,255,${0.5 + this.pulse * 0.35})`;
      c.lineWidth = Math.max(1.5, this.scale * 0.045);
      c.setLineDash([this.scale * 0.15, this.scale * 0.12]);
      c.stroke(path);
      c.setLineDash([]);
    }
  }
}
