// CatanX board renderer.
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

const RES_COLOR = {
  wood: '#2f6b3a', brick: '#b8613a', sheep: '#78bf5c', wheat: '#e3ba57', ore: '#8d94a8',
};
const RES_ICON = { wood: '🌲', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '⛰️' };
export { RES_COLOR, RES_ICON };

const WATER_A = '#123a5c';
const WATER_B = '#0b2540';

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
};
const ART_EXT = ['jpg', 'png', 'webp', 'jpeg'];
const artImages = {};   // terrain -> HTMLImageElement once decoded

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

export class BoardView {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.board = null;
    this.game = null;
    this.highlights = { verts: [], edges: [], hexes: [] };
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
    this.cx = this.w / 2;
    this.cy = this.h / 2;
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

    this.drawWater();
    this.drawCoast();
    for (const tile of this.board.tiles) this.drawHex(tile);
    this.drawPorts();
    this.drawHexHighlights();
    this.drawRoads();
    this.drawEdgeHighlights();
    this.drawBuildings();
    this.drawRobber();
    this.drawVertexHighlights();
  }

  drawWater() {
    const c = this.ctx;
    const g = c.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, WATER_A);
    g.addColorStop(1, WATER_B);
    c.fillStyle = g;
    c.fillRect(0, 0, this.w, this.h);

    // Lazy swell lines, so the sea isn't a flat slab.
    c.save();
    c.globalAlpha = 0.07;
    c.strokeStyle = '#bfe4ff';
    c.lineWidth = 1.5;
    for (let i = 0; i < 9; i++) {
      const y = (i + 0.5) * (this.h / 9);
      c.beginPath();
      for (let x = 0; x <= this.w; x += 12) {
        const yy = y + Math.sin((x / 60) + i * 1.7) * 3;
        x === 0 ? c.moveTo(x, yy) : c.lineTo(x, yy);
      }
      c.stroke();
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
    c.strokeStyle = 'rgba(224, 201, 150, 0.30)';
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
   * The source art is a flat-top hex and the board draws pointy-top ones, so the
   * shapes are deliberately NOT aligned: the image is scaled to cover the hex and
   * centred, which uses the middle of the illustration and crops whatever decorative
   * border the source had. A vignette at the end keeps the number token readable over
   * a busy picture.
   */
  drawTerrainArt(img, cx, cy, R) {
    const c = this.ctx;
    // The hex's bounding box, plus a margin so no corner can fall outside the image.
    const boxW = R * Math.sqrt(3) * 1.04;
    const boxH = R * 2 * 1.04;
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

      // Two mooring lines from the badge back to the vertices that can use it.
      c.save();
      c.strokeStyle = 'rgba(232, 214, 178, 0.55)';
      c.lineWidth = Math.max(1, R * 0.055);
      c.lineCap = 'round';
      for (const vid of [p.a, p.b]) {
        const [vx, vy] = this.toScreen(VERTS[vid].x, VERTS[vid].y);
        c.beginPath(); c.moveTo(sx, sy); c.lineTo(vx, vy); c.stroke();
      }
      c.restore();

      const rad = R * 0.31;
      c.beginPath(); c.arc(sx, sy, rad, 0, Math.PI * 2);
      c.fillStyle = p.kind === 'any' ? '#e8d6b2' : RES_COLOR[p.kind];
      c.fill();
      c.strokeStyle = 'rgba(10,20,32,0.6)';
      c.lineWidth = Math.max(1, R * 0.03);
      c.stroke();

      c.fillStyle = p.kind === 'any' ? '#2a2118' : '#0d1b28';
      c.font = `800 ${rad * 0.72}px ui-rounded, "Segoe UI", system-ui, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(p.kind === 'any' ? '3:1' : '2:1', sx, sy);
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
      c.strokeStyle = 'rgba(8,16,26,0.7)';
      c.lineWidth = R * 0.20;
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
      c.strokeStyle = this.colorOf(pid);
      c.lineWidth = R * 0.135;
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    }
  }

  drawBuildings() {
    if (!this.game) return;
    for (const [vid, b] of Object.entries(this.game.bldg)) {
      const [x, y] = this.toScreen(VERTS[vid].x, VERTS[vid].y);
      b.t === 'c' ? this.drawCity(x, y, this.colorOf(b.p)) : this.drawSettlement(x, y, this.colorOf(b.p));
    }
  }

  drawSettlement(x, y, color) {
    const c = this.ctx;
    const s = this.scale * 0.24;
    c.save();
    c.translate(x, y);
    c.beginPath();
    c.moveTo(-s, s * 0.55);
    c.lineTo(-s, -s * 0.25);
    c.lineTo(0, -s);
    c.lineTo(s, -s * 0.25);
    c.lineTo(s, s * 0.55);
    c.closePath();
    c.fillStyle = color;
    c.shadowColor = 'rgba(0,0,0,0.5)';
    c.shadowBlur = s * 0.7;
    c.shadowOffsetY = s * 0.18;
    c.fill();
    c.shadowColor = 'transparent';
    c.strokeStyle = 'rgba(8,16,26,0.75)';
    c.lineWidth = Math.max(1, s * 0.17);
    c.stroke();
    c.restore();
  }

  drawCity(x, y, color) {
    const c = this.ctx;
    const s = this.scale * 0.27;
    c.save();
    c.translate(x, y);
    c.beginPath();
    // A long hall with a taller tower on the left — reads as "bigger" at thumbnail size.
    c.moveTo(-s * 1.15, s * 0.6);
    c.lineTo(-s * 1.15, -s * 0.35);
    c.lineTo(-s * 0.55, -s * 0.95);
    c.lineTo(0, -s * 0.35);
    c.lineTo(0, -s * 0.05);
    c.lineTo(s * 1.1, -s * 0.05);
    c.lineTo(s * 1.1, s * 0.6);
    c.closePath();
    c.fillStyle = color;
    c.shadowColor = 'rgba(0,0,0,0.5)';
    c.shadowBlur = s * 0.7;
    c.shadowOffsetY = s * 0.18;
    c.fill();
    c.shadowColor = 'transparent';
    c.strokeStyle = 'rgba(8,16,26,0.75)';
    c.lineWidth = Math.max(1, s * 0.16);
    c.stroke();
    c.restore();
  }

  drawRobber() {
    if (!this.game) return;
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
