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
 * All light, and that is a constraint rather than a preference: the board chrome
 * (topbar, tray, sheets) stays dark whatever is chosen, so the sea has to read as a lit
 * map inset rather than as the app changing theme. It is also what the coastline halo,
 * the cream port rings and the white piece outlines were all drawn against — a dark sea
 * would leave every one of them invisible.
 *
 * Each entry carries its own wave colours. Deriving them by darkening the base looks
 * fine on the blues and muddy on everything else, so they are chosen per palette.
 */
export const SEA_COLORS = [
  { key: 'lagoon', name: 'Lagoon',   a: '#bfe7f7', b: '#7cc2e4', trough: '#2f86b8', deep: '#1d6d9c' },
  { key: 'tropic', name: 'Tropical', a: '#c6f5ee', b: '#79d9cd', trough: '#2aa295', deep: '#17786e' },
  { key: 'mint',   name: 'Mint',     a: '#d6f6e4', b: '#93ddb4', trough: '#37a06a', deep: '#227a4c' },
  { key: 'sand',   name: 'Shallows', a: '#f6ecd2', b: '#dfc99a', trough: '#b8974f', deep: '#93753a' },
  { key: 'rose',   name: 'Coral',    a: '#fbe2e4', b: '#f0aeb4', trough: '#d3707c', deep: '#ac4f5c' },
  { key: 'lilac',  name: 'Lilac',    a: '#e9e2fb', b: '#bcaaf0', trough: '#8b73d6', deep: '#6a53b4' },
  { key: 'slate',  name: 'Overcast', a: '#e6edf3', b: '#b3c4d2', trough: '#7a91a4', deep: '#5c7183' },
  { key: 'dawn',   name: 'Dawn',     a: '#fdeed6', b: '#f5c79b', trough: '#d99457', deep: '#b3703a' },
];
export const seaAt = (i) => SEA_COLORS[Number.isInteger(i) && SEA_COLORS[i] ? i : 0];

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
    this.highlights = { verts: [], edges: [], hexes: [] };
    this.payout = null;                // what the last roll paid, and to whom
    this.sea = SEA_COLORS[0];
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

  setBoard(board) { this.board = board; this.fit(); }
  setGame(game) { this.game = game; }
  setHighlights(h) { this.highlights = h || { verts: [], edges: [], hexes: [] }; }
  setSea(idx) { this.sea = seaAt(idx); }
  /** `{ hexes, spots: [{ v, colour, city }], until }`, or null for nothing to show. */
  setPayout(p) { this.payout = p; }

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

    if (h.verts?.length) {
      let best = null, bestD = 0.42;
      for (const v of h.verts) {
        const d = Math.hypot(VERTS[v].x - wx, VERTS[v].y - wy);
        if (d < bestD) { bestD = d; best = v; }
      }
      if (best !== null) return { kind: 'vertex', id: best };
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
  }

  drawWater(t = 0) {
    const c = this.ctx;
    const g = c.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, this.sea.a);
    g.addColorStop(1, this.sea.b);
    c.fillStyle = g;
    c.fillRect(0, 0, this.w, this.h);

    // The swell drifts. The render loop already runs every frame for the highlight
    // pulse, so animating this costs nothing beyond the strokes themselves.
    c.save();
    c.lineCap = 'round';
    for (const L of WAVE_LAYERS) {
      c.globalAlpha = L.alpha;
      c.strokeStyle = L.role === 'crest' ? '#ffffff' : this.sea[L.role];
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

  hexPath(tile, shrink = 1) {
    const c = this.ctx;
    c.beginPath();
    const corners = HEXES[tile.i].corners;
    corners.forEach((vid, i) => {
      const v = VERTS[vid];
      const x = tile.x + (v.x - tile.x) * shrink;
      const y = tile.y + (v.y - tile.y) * shrink;
      const [sx, sy] = this.toScreen(x, y);
      i === 0 ? c.moveTo(sx, sy) : c.lineTo(sx, sy);
    });
    c.closePath();
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
      for (const tile of this.board.tiles) { this.hexPath(tile, 1.04); c.stroke(); }
    }
    c.restore();
  }

  drawHex(tile) {
    const c = this.ctx;
    const st = TERRAIN_STYLE[tile.terrain];
    const [cx, cy] = this.toScreen(tile.x, tile.y);
    const R = this.scale;

    // The flat colour goes down first either way: it is what shows through the
    // gaps if an illustration has transparent corners, and it is the whole tile
    // when there is no illustration.
    this.hexPath(tile, 0.985);
    const g = c.createLinearGradient(cx, cy - R, cx, cy + R);
    g.addColorStop(0, st.a);
    g.addColorStop(1, st.b);
    c.fillStyle = g;
    c.fill();

    const art = artImages[tile.terrain];
    c.save();
    this.hexPath(tile, 0.985);
    c.clip();
    if (art && art.naturalWidth) this.drawTerrainArt(art, cx, cy, R);
    else this.drawTerrainMotif(tile, cx, cy, R, st);

    // Still inside the clip, which is what makes this an inside border: the stroke is
    // drawn at twice its intended width and the outer half is clipped away, leaving a
    // band that hugs the edge exactly instead of straddling it.
    this.hexPath(tile, 0.985);
    c.strokeStyle = TERRAIN_EDGE[tile.terrain] || st.a;
    c.lineWidth = Math.max(2, R * 0.15);
    c.globalAlpha = 0.9;
    c.stroke();
    c.restore();

    this.hexPath(tile, 0.985);
    c.strokeStyle = 'rgba(12, 24, 36, 0.45)';
    c.lineWidth = Math.max(1, R * 0.035);
    c.stroke();

    if (tile.num) this.drawToken(tile, cx, cy, R);
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
    const vg = c.createRadialGradient(cx, cy, R * 0.16, cx, cy, R);
    vg.addColorStop(0, 'rgba(10, 20, 32, 0.32)');
    vg.addColorStop(0.55, 'rgba(10, 20, 32, 0.06)');
    vg.addColorStop(1, 'rgba(10, 20, 32, 0.22)');
    c.fillStyle = vg;
    c.fillRect(cx - R * 1.1, cy - R * 1.1, R * 2.2, R * 2.2);
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

  drawToken(tile, cx, cy, R) {
    const c = this.ctx;
    const rad = R * 0.30;
    const red = isRed(tile.num);
    const robbed = this.game && this.game.robber === tile.i;

    c.save();
    c.beginPath(); c.arc(cx, cy, rad, 0, Math.PI * 2);
    c.fillStyle = robbed ? '#9aa0ac' : '#f3e6cb';
    c.shadowColor = 'rgba(0,0,0,0.45)';
    c.shadowBlur = R * 0.16;
    c.shadowOffsetY = R * 0.045;
    c.fill();
    c.restore();

    c.beginPath(); c.arc(cx, cy, rad, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(60,44,20,0.55)';
    c.lineWidth = Math.max(1, R * 0.025);
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

  drawPorts() {
    const c = this.ctx;
    const R = this.scale;
    for (const p of this.board.ports) {
      const out = edgeOutward(p.edge);
      const e = EDGES[p.edge];
      const bx = e.x + out.x * 0.72;
      const by = e.y + out.y * 0.72;
      const [sx, sy] = this.toScreen(bx, by);

      // Two mooring lines from the badge back to the vertices that can use it. Dark
      // rope, not cream — these cross open water and have to read against it.
      c.save();
      c.strokeStyle = 'rgba(51, 78, 96, 0.62)';
      c.lineWidth = Math.max(1, R * 0.055);
      c.lineCap = 'round';
      for (const vid of [p.a, p.b]) {
        const [vx, vy] = this.toScreen(VERTS[vid].x, VERTS[vid].y);
        c.beginPath(); c.moveTo(sx, sy); c.lineTo(vx, vy); c.stroke();
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
    for (const [vid, b] of Object.entries(this.game.bldg)) {
      const [x, y] = this.toScreen(VERTS[vid].x, VERTS[vid].y);
      b.t === 'c' ? this.drawCity(x, y, this.colorOf(b.p)) : this.drawSettlement(x, y, this.colorOf(b.p));
    }
  }

  /** The piece outlines, for anything outside the renderer that wants them. */
  static get PIECES() { return PIECES; }

  /**
   * Stand a piece on a corner, sized by height so a city reads as wider than a house
   * rather than merely taller.
   */
  drawPiece(kind, x, y, color, height) {
    const spec = PIECES[kind];
    if (!spec) return;
    const c = this.ctx;
    const k = height / spec.box.h;

    c.save();
    c.translate(x, y);
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

  drawSettlement(x, y, color) { this.drawPiece('settlement', x, y, color, this.scale * 0.52); }
  drawCity(x, y, color) { this.drawPiece('city', x, y, color, this.scale * 0.58); }

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

      c.save();
      this.hexPath(tile, 0.985);
      c.clip();
      // Brightest at the rim, so the illustration underneath still shows through.
      const glow = c.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
      glow.addColorStop(0, `rgba(255, 248, 214, ${0.06 * level * beat})`);
      glow.addColorStop(1, `rgba(255, 236, 150, ${0.52 * level * beat})`);
      c.fillStyle = glow;
      c.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);

      this.hexPath(tile, 0.985);
      c.strokeStyle = `rgba(255, 255, 255, ${0.95 * level})`;
      c.lineWidth = Math.max(3, R * 0.22);
      c.stroke();
      c.restore();

      this.hexPath(tile, 0.985);
      c.strokeStyle = `rgba(255, 214, 92, ${0.9 * level * beat})`;
      c.lineWidth = Math.max(2, R * 0.07);
      c.stroke();
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
  drawVertexHighlights() {
    const list = this.highlights.verts || [];
    if (!list.length) return;
    const c = this.ctx;
    const R = this.scale;
    const grow = 0.20 + this.pulse * 0.06;
    for (const vid of list) {
      const [x, y] = this.toScreen(VERTS[vid].x, VERTS[vid].y);
      c.beginPath(); c.arc(x, y, R * grow, 0, Math.PI * 2);
      c.fillStyle = `rgba(255,255,255,${0.20 + this.pulse * 0.16})`;
      c.fill();
      c.beginPath(); c.arc(x, y, R * grow, 0, Math.PI * 2);
      c.strokeStyle = `rgba(255,255,255,${0.65 + this.pulse * 0.3})`;
      c.lineWidth = Math.max(1.5, R * 0.05);
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
      this.hexPath(tile, 0.9);
      c.fillStyle = `rgba(255,255,255,${0.10 + this.pulse * 0.13})`;
      c.fill();
      this.hexPath(tile, 0.9);
      c.strokeStyle = `rgba(255,255,255,${0.5 + this.pulse * 0.35})`;
      c.lineWidth = Math.max(1.5, this.scale * 0.045);
      c.setLineDash([this.scale * 0.15, this.scale * 0.12]);
      c.stroke();
      c.setLineDash([]);
    }
  }
}
