// Board effects: everything that makes the pieces look and feel less like flat stickers.
//
// Kept out of render.js on purpose. That file is the board — tiles, camera, hit testing —
// and this is decoration on top of it, all of it optional: a player can turn the whole
// layer off in Settings, and a phone set to reduce motion keeps only the parts that do not
// move. So nothing here may be needed for the game to be readable.
//
// Every function takes the BoardView and draws through its context in the same screen
// space the rest of the board uses (`view.toScreen`, `view.scale` = pixels per hex radius).

import { HEXES, VERTS, EDGES } from './board.js';

const TAU = Math.PI * 2;
const clamp01 = (t) => Math.max(0, Math.min(1, t));
const easeOut = (t) => 1 - (1 - clamp01(t)) ** 3;
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// How long each thing takes, in milliseconds.
export const ROAD_DRAW_MS = 300;       // a road drawing itself from one end to the other
const RING_MS = 420;                   // the ripple a landing piece sends across its tile
const FLASH_MS = 170;                  // the white flash a new city lands with
const SHAKE_MS = 150;
const POP_MS = 1150;                   // a resource icon leaving a paid building for its owner
const POP_STAGGER_MS = 110;
const SWEEP_MS = 800;                  // the one-off end-to-end light when Longest Road changes hands
const SWEEP_FADE_MS = 450;

// A full day-and-night cycle, in game turns. Long enough that a single turn never looks
// like a change of light, short enough that a normal game sees night fall once or twice.
const DAY_TURNS = 48;

// ---------------------------------------------------------------- colour
/** A #rrggbb lightened (t > 0) or darkened (t < 0) by that fraction, as an rgb() string. */
export function shade(hex, t) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const target = t >= 0 ? 255 : 0;
  const a = Math.abs(t);
  const ch = (v) => Math.round(v + (target - v) * a);
  return `rgb(${ch((n >> 16) & 255)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`;
}

/** 0 in daylight, 1 at the dead of night, rising and falling smoothly with the turn count. */
export function nightLevel(turnNum) {
  const u = (((turnNum || 0) % DAY_TURNS) + DAY_TURNS) % DAY_TURNS / DAY_TURNS;
  return smooth(0.40, 0.58, u) - smooth(0.82, 0.98, u);
}

// A small deterministic hash so each building flickers and smokes out of step with the
// others without Math.random, which would make a still frame different from the next.
const hash = (n) => ((Math.sin((n + 1) * 12.9898) * 43758.5453) % 1 + 1) % 1;

// ---------------------------------------------------------------- the longest road
/**
 * The longest trail through one player's roads, as the list of vertices it passes.
 *
 * The same search the rules use to score it (an opponent's building cuts the road there),
 * but this one keeps the path, because the board wants to light it up rather than count it.
 */
export function longestTrail(g, pid) {
  const mine = new Set(Object.keys(g.roads).filter((e) => g.roads[e] === pid).map(Number));
  if (!mine.size) return null;
  const blocked = (v) => { const b = g.bldg[v]; return !!b && b.p !== pid; };
  const used = new Set();
  let best = { len: 0, verts: [] };
  const walk = [];

  function extend(v) {
    for (const e of VERTS[v].edges) {
      if (!mine.has(e) || used.has(e)) continue;
      used.add(e);
      const other = EDGES[e].a === v ? EDGES[e].b : EDGES[e].a;
      walk.push(other);
      if (walk.length - 1 > best.len) best = { len: walk.length - 1, verts: walk.slice() };
      if (!blocked(other)) extend(other);
      walk.pop();
      used.delete(e);
    }
  }
  const ends = new Set();
  for (const e of mine) { ends.add(EDGES[e].a); ends.add(EDGES[e].b); }
  for (const v of ends) { walk.length = 0; walk.push(v); extend(v); }
  return best.len ? best : null;
}

// ---------------------------------------------------------------- the effects layer
export class Effects {
  constructor() {
    this.roads = new Map();        // edge -> when it was laid
    this.landings = [];            // { v, t0 } — when a dropped piece touches its corner
    this.shake = null;             // { t0, amp }
    this.sweep = null;             // { kind, pid, t0 } — an award changing hands
    this._trail = null;            // the cached longest trail, and what it was worked out for
  }

  reset() {
    this.roads.clear();
    this.landings.length = 0;
    this.shake = null;
    this.sweep = null;
    this._trail = null;
  }

  // ------------------------------------------------------------ events from the game
  roadLaid(eid, now) { this.roads.set(eid, { at: now, from: null }); }

  /** A piece will touch down at `t0`; a city lands harder than a house. */
  landing(v, t0) { this.landings.push({ v, t0 }); }

  awardChanged(kind, pid, now) { this.sweep = { kind, pid, t0: now }; }

  /** [dx, dy] to nudge the whole board by this frame. */
  shakeOffset(now) {
    const s = this.shake;
    if (!s) return [0, 0];
    const u = (now - s.t0) / SHAKE_MS;
    if (u < 0) return [0, 0];
    if (u > 1) { this.shake = null; return [0, 0]; }
    const decay = (1 - u) * s.amp;
    return [Math.sin(u * 38) * decay, Math.cos(u * 31) * decay * 0.7];
  }

  // ------------------------------------------------------------ roads
  /**
   * Where a road is in being laid: `{ p, fromA }`, or null once it is simply there.
   * It grows out of whichever end already touches something of its owner's.
   */
  roadProgress(eid, now, game) {
    const r = this.roads.get(eid);
    if (!r) return null;
    const u = (now - r.at) / ROAD_DRAW_MS;
    if (u >= 1) { this.roads.delete(eid); return null; }
    if (r.from === null) {
      const pid = game?.roads?.[eid];
      const e = EDGES[eid];
      const anchored = (v) => {
        const b = game?.bldg?.[v];
        if (b && b.p === pid) return true;
        return VERTS[v].edges.some((x) => x !== Number(eid) && game?.roads?.[x] === pid);
      };
      r.from = anchored(e.a) || !anchored(e.b) ? 'a' : 'b';
    }
    return { p: easeOut(Math.max(0, u)), fromA: r.from === 'a' };
  }

  /** The cobbled look on top of a finished road: a lighter centre line and plank ticks. */
  roadTexture(view, ax, ay, bx, by, color) {
    const c = view.ctx;
    const R = view.scale;
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 2) return;
    const ux = (bx - ax) / len, uy = (by - ay) / len;
    const nx = -uy, ny = ux;

    c.save();
    c.lineCap = 'butt';
    // Plank ticks, perpendicular to the road, a touch darker than the road itself.
    c.strokeStyle = 'rgba(0, 0, 0, 0.20)';
    c.lineWidth = Math.max(1, R * 0.022);
    const step = R * 0.17;
    const half = R * 0.052;
    c.beginPath();
    for (let d = step * 0.6; d < len - step * 0.3; d += step) {
      const px = ax + ux * d, py = ay + uy * d;
      c.moveTo(px - nx * half, py - ny * half);
      c.lineTo(px + nx * half, py + ny * half);
    }
    c.stroke();
    // The lighter centre stripe, dashed so it reads as paint rather than a second road.
    c.strokeStyle = shade(color, 0.5);
    c.globalAlpha = 0.7;
    c.lineWidth = Math.max(1, R * 0.024);
    c.setLineDash([R * 0.085, R * 0.075]);
    c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke();
    c.restore();
  }

  /** A few specks kicked up at the end of a road that is still being laid. */
  roadDust(view, x, y, seed, p) {
    if (view.calm) return;
    const c = view.ctx;
    const R = view.scale;
    c.save();
    for (let i = 0; i < 4; i++) {
      const j = hash(seed * 7 + i);
      const a = j * TAU + view.now / 300;
      const d = R * (0.04 + j * 0.12) * (0.4 + p);
      c.globalAlpha = (1 - p) * 0.5;
      c.fillStyle = '#e8dcc0';
      c.beginPath();
      c.arc(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.6 - R * 0.03, Math.max(0.6, R * 0.035), 0, TAU);
      c.fill();
    }
    c.restore();
  }

  // ------------------------------------------------------------ pieces
  /** A flat contact shadow so a piece sits on the board rather than hovering over it. */
  groundShadow(view, x, y, width) {
    const c = view.ctx;
    c.save();
    c.fillStyle = 'rgba(0, 0, 0, 0.30)';
    c.beginPath();
    c.ellipse(x, y + width * 0.02, width * 0.46, width * 0.15, 0, 0, TAU);
    c.fill();
    c.restore();
  }

  /**
   * Shading and detail for a piece, drawn in the piece's own coordinate space (the
   * silhouette's path units) between its fill and its outlines. `clip` is the silhouette,
   * so the shading cannot spill past the edge.
   */
  pieceBody(view, kind, path, color, v, night) {
    const c = view.ctx;
    const dark = shade(color, -0.32);
    const light = shade(color, 0.38);

    c.save();
    c.clip(path);
    // Lit from the upper left: lighter there, darker toward the lower right.
    const g = c.createLinearGradient(15, 10, 105, 90);
    g.addColorStop(0, 'rgba(255, 255, 255, 0.34)');
    g.addColorStop(0.5, 'rgba(255, 255, 255, 0)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0.34)');
    c.fillStyle = g;
    c.fillRect(0, 0, 120, 100);

    c.fillStyle = dark;
    c.globalAlpha = 0.8;
    c.beginPath();
    if (kind === 'settlement') {
      // The roof, a shade darker than the walls, with its sunlit slope picked out.
      c.moveTo(18, 47); c.lineTo(50, 14); c.lineTo(82, 47); c.closePath();
      c.fill();
      c.globalAlpha = 0.9;
      c.fillStyle = light;
      c.beginPath(); c.moveTo(20, 45); c.lineTo(50, 16); c.lineTo(50, 22); c.lineTo(26, 46); c.closePath();
      c.fill();
    } else {
      // Tower cap and hall roof.
      c.moveTo(13, 32); c.lineTo(35, 13); c.lineTo(57, 32); c.closePath();
      c.moveTo(53, 57); c.lineTo(80, 28); c.lineTo(107, 57); c.closePath();
      c.fill();
      c.globalAlpha = 0.9;
      c.fillStyle = light;
      c.beginPath();
      c.moveTo(15, 30); c.lineTo(35, 15); c.lineTo(35, 21); c.lineTo(22, 31); c.closePath();
      c.moveTo(57, 55); c.lineTo(80, 30); c.lineTo(80, 36); c.lineTo(64, 55); c.closePath();
      c.fill();
    }
    c.restore();

    // Windows: dark by day, warm at night, with the odd glint of sun on the glass.
    const windows = kind === 'settlement'
      ? [[44, 56, 11, 14]]
      : [[30, 46, 9, 12], [67, 62, 9, 11], [85, 62, 9, 11]];
    windows.forEach(([wx, wy, ww, wh], i) => {
      c.save();
      if (night > 0.12) {
        const flick = view.calm ? 1 : 0.88 + 0.12 * Math.sin(view.now / 260 + v * 1.7 + i * 2.1);
        c.fillStyle = `rgba(255, 214, 120, ${Math.min(1, night * 1.15) * flick})`;
        c.shadowColor = 'rgba(255, 190, 90, 0.9)';
        c.shadowBlur = 6 * night;
      } else {
        c.fillStyle = 'rgba(8, 16, 26, 0.55)';
      }
      c.fillRect(wx, wy, ww, wh);
      c.restore();
      if (!view.calm && night < 0.4) {
        // A sweep of light across the glass every few seconds, each window out of step.
        const cycle = 5200 + hash(v + i) * 3000;
        const s = ((view.now + hash(v * 3 + i) * cycle) % cycle) / cycle;
        if (s < 0.09) {
          c.save();
          c.globalAlpha = Math.sin((s / 0.09) * Math.PI) * 0.85;
          c.fillStyle = '#fff';
          c.fillRect(wx + ww * (s / 0.09) * 0.7, wy, ww * 0.28, wh);
          c.restore();
        }
      }
    });
  }

  /** What stands outside the silhouette: a city's chimney smoke and its flag. */
  pieceTop(view, kind, color, v) {
    if (kind !== 'city') return;
    const c = view.ctx;
    const t = view.calm ? 0 : view.now;

    // Smoke from the hall's chimney: three puffs rising out of step.
    if (!view.calm) {
      c.save();
      for (let i = 0; i < 3; i++) {
        const u = ((t / 2200) + hash(v) + i / 3) % 1;
        const y = 33 - u * 30;
        const x = 92 + u * 9 + Math.sin(u * 7 + v) * 2.2;
        c.globalAlpha = 0.42 * (1 - u) * smooth(0, 0.12, u);
        c.fillStyle = '#eceef2';
        c.beginPath(); c.arc(x, y, 2.4 + u * 4.4, 0, TAU); c.fill();
      }
      c.restore();
    }
    // The chimney itself.
    c.fillStyle = shade(color, -0.45);
    c.fillRect(89, 31, 6, 9);

    // A flag on the tower, waving.
    c.save();
    c.strokeStyle = 'rgba(8, 16, 26, 0.9)';
    c.lineWidth = 1.6;
    c.beginPath(); c.moveTo(35, 14); c.lineTo(35, -9); c.stroke();
    const wave = (a) => (view.calm ? 0 : Math.sin(t / 230 + a + v) * 2.2);
    c.fillStyle = shade(color, 0.15);
    c.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(35, -9);
    c.quadraticCurveTo(43 + wave(0), -8 + wave(1.4), 52 + wave(0.6), -4 + wave(2));
    c.quadraticCurveTo(43 + wave(1), -3 + wave(0.3), 35, 0);
    c.closePath();
    c.fill(); c.stroke();
    c.restore();
  }

  // ------------------------------------------------------------ landings
  /**
   * The ripple and flash a piece sends out when it touches down. Starts when the drop
   * ends, which is why it is kept here and not drawn with the piece.
   */
  drawLandings(view) {
    if (!this.landings.length) return;
    const c = view.ctx;
    const R = view.scale;
    const now = view.now;
    this.landings = this.landings.filter((l) => now - l.t0 < RING_MS + 200);
    for (const l of this.landings) {
      const ms = now - l.t0;
      if (ms < 0) continue;
      const city = view.game?.bldg?.[l.v]?.t === 'c';
      if (city && !this.shake && ms < 40 && !view.calm) this.shake = { t0: l.t0, amp: 3.2 };
      const [x, y] = view.toScreen(VERTS[l.v].x, VERTS[l.v].y);

      c.save();
      const rings = city ? [0, 90] : [0];
      for (const delay of rings) {
        const u = (ms - delay) / RING_MS;
        if (u < 0 || u > 1) continue;
        const rad = R * ((city ? 0.95 : 0.6) * easeOut(u) + 0.12);
        c.globalAlpha = (1 - u) * (city ? 0.85 : 0.6);
        c.strokeStyle = city ? '#ffd45c' : '#ffffff';
        c.lineWidth = Math.max(1.5, R * (city ? 0.07 : 0.045) * (1 - u * 0.6));
        c.beginPath(); c.ellipse(x, y, rad, rad * 0.5, 0, 0, TAU); c.stroke();
      }
      if (city && ms < FLASH_MS) {
        const u = ms / FLASH_MS;
        const rad = R * (0.3 + u * 0.3);
        const glow = c.createRadialGradient(x, y - R * 0.2, 0, x, y - R * 0.2, rad);
        glow.addColorStop(0, `rgba(255, 246, 210, ${0.5 * (1 - u)})`);
        glow.addColorStop(1, 'rgba(255, 214, 92, 0)');
        c.fillStyle = glow;
        c.beginPath(); c.arc(x, y - R * 0.2, rad, 0, TAU); c.fill();
      }
      c.restore();
    }
  }

  // ------------------------------------------------------------ the roll pays out
  /**
   * Resource icons leaving the buildings that were just paid, bound for their owner's
   * pill at the top of the screen. `pops` is `[{ v, res, pid }]`, one per card paid.
   */
  drawPops(view) {
    const pay = view.payout;
    if (!pay?.pops?.length || view.calm) return;
    const c = view.ctx;
    const R = view.scale;
    const now = view.now;
    const per = new Map();
    pay.pops.forEach((p) => {
      const k = per.get(p.v) || 0;
      per.set(p.v, k + 1);
      const ms = now - pay.at - k * POP_STAGGER_MS;
      if (ms < 0 || ms > POP_MS) return;
      const u = ms / POP_MS;
      const [x0, y0] = view.toScreen(VERTS[p.v].x, VERTS[p.v].y);
      const icon = view.resIcon?.[p.res];
      if (!icon) return;

      let x, y, s, a;
      const rise = 0.42;
      if (u < rise) {
        // Pops up above the building with a little overshoot.
        const t = u / rise;
        x = x0;
        y = y0 - R * (0.35 + 0.55 * easeOut(t));
        s = 0.4 + 0.85 * Math.sin(Math.min(1, t * 1.15) * Math.PI / 2);
        a = clamp01(t * 3);
      } else {
        // Then away to the owner's pill, or on up and out if there is nowhere to go.
        const t = (u - rise) / (1 - rise);
        const target = view.pillPos?.(p.pid);
        const sx = x0, sy = y0 - R * 0.9;
        const e = t * t * (3 - 2 * t);
        x = target ? sx + (target[0] - sx) * e : sx;
        y = target ? sy + (target[1] - sy) * e : sy - R * 0.7 * e;
        s = 1.2 - 0.55 * e;
        a = 1 - smooth(0.7, 1, t);
      }
      c.save();
      c.globalAlpha = a;
      c.font = `${Math.max(11, R * 0.42 * s)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.shadowColor = 'rgba(0, 0, 0, 0.55)';
      c.shadowBlur = 4;
      c.fillText(icon, x, y);
      c.restore();
    });
  }

  /**
   * A quick pulse and a few twinkles on a building that was just paid. Returns the scale
   * to draw it at, and paints the twinkles — a pulse, not the halo it replaced.
   */
  payoutPulse(view, v) {
    const pay = view.payout;
    if (!pay?.pops || view.calm) return 1;
    if (!pay.paidVerts) pay.paidVerts = new Set(pay.pops.map((p) => p.v));
    if (!pay.paidVerts.has(v)) return 1;
    const ms = view.now - pay.at;
    if (ms < 0 || ms > 520) return 1;
    const u = ms / 520;
    const [x, y] = view.toScreen(VERTS[v].x, VERTS[v].y);
    const R = view.scale;
    const c = view.ctx;
    c.save();
    for (let i = 0; i < 4; i++) {
      const j = hash(v * 5 + i);
      const a = j * TAU;
      const d = R * (0.22 + j * 0.2) * (0.5 + u);
      const tw = Math.sin(clamp01(u * 1.2 - j * 0.3) * Math.PI);
      if (tw <= 0) continue;
      const sx = x + Math.cos(a) * d, sy = y - R * 0.18 + Math.sin(a) * d * 0.8;
      const r = R * 0.07 * tw;
      c.globalAlpha = 0.9 * tw;
      c.fillStyle = '#fff6c8';
      c.beginPath();
      c.moveTo(sx, sy - r * 1.6); c.lineTo(sx + r * 0.4, sy - r * 0.4); c.lineTo(sx + r * 1.6, sy);
      c.lineTo(sx + r * 0.4, sy + r * 0.4); c.lineTo(sx, sy + r * 1.6); c.lineTo(sx - r * 0.4, sy + r * 0.4);
      c.lineTo(sx - r * 1.6, sy); c.lineTo(sx - r * 0.4, sy - r * 0.4); c.closePath();
      c.fill();
    }
    c.restore();
    return 1 + 0.14 * Math.sin(u * Math.PI);
  }

  // ------------------------------------------------------------ awards
  /** Longest Road: a light that runs along the holder's road, and an end-to-end sweep when it changes hands. */
  drawRoadLight(view) {
    const g = view.game;
    if (!g?.award) return;
    const sweep = this.sweep?.kind === 'road' ? this.sweep : null;
    const holder = g.award.road;
    if (!holder && !sweep) return;
    const pid = holder || sweep.pid;

    const key = `${g.seq}|${Object.keys(g.roads).length}|${Object.keys(g.bldg).length}|${pid}`;
    if (!this._trail || this._trail.key !== key) this._trail = { key, trail: longestTrail(g, pid) };
    const trail = this._trail.trail;
    if (!trail || trail.verts.length < 2) return;

    const c = view.ctx;
    const R = view.scale;
    const pts = trail.verts.map((v) => view.toScreen(VERTS[v].x, VERTS[v].y));
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[cum.length - 1];
    if (total < 2) return;

    // The points of the trail between two distances along it, as one polyline.
    const stroke = (from, to, width, style, alpha) => {
      from = Math.max(0, from); to = Math.min(total, to);
      if (to <= from) return;
      c.beginPath();
      let started = false;
      const at = (d) => {
        let i = 1;
        while (i < cum.length - 1 && cum[i] < d) i++;
        const t = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
      };
      const first = at(from);
      c.moveTo(first[0], first[1]);
      started = true;
      for (let i = 1; i < cum.length - 1; i++) if (cum[i] > from && cum[i] < to) c.lineTo(pts[i][0], pts[i][1]);
      const last = at(to);
      if (started) c.lineTo(last[0], last[1]);
      c.globalAlpha = alpha;
      c.strokeStyle = style;
      c.lineWidth = width;
      c.stroke();
    };

    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';

    if (sweep) {
      const ms = view.now - sweep.t0;
      if (ms > SWEEP_MS + SWEEP_FADE_MS) this.sweep = null;
      else {
        const head = easeOut(ms / SWEEP_MS) * total;
        const fade = ms < SWEEP_MS ? 1 : 1 - (ms - SWEEP_MS) / SWEEP_FADE_MS;
        stroke(0, head, R * 0.3, shade(view.colorOf(sweep.pid), 0.4), 0.35 * fade);
        stroke(0, head, R * 0.13, '#ffffff', 0.95 * fade);
      }
    }
    if (holder && !view.calm) {
      // The faint, continuous one: a short bright run travelling the length of it.
      const span = total * 0.22;
      const head = (((view.now / 2600) % 1.25)) * (total + span) - span * 0.1;
      stroke(head - span, head, R * 0.2, shade(view.colorOf(holder), 0.5), 0.22);
      stroke(head - span, head, R * 0.085, '#ffffff', 0.7);
    }
    c.restore();
  }

  /** Largest Army: a small shield over each of the holder's buildings. */
  drawArmyBadges(view) {
    const g = view.game;
    const pid = g?.award?.army;
    if (!pid) return;
    const c = view.ctx;
    const R = view.scale;
    const pulse = this.sweep?.kind === 'army' && view.now - this.sweep.t0 < 900
      ? 1 + 0.6 * Math.sin(((view.now - this.sweep.t0) / 900) * Math.PI) : 1;
    const color = view.colorOf(pid);
    for (const [vid, b] of Object.entries(g.bldg)) {
      if (b.p !== pid) continue;
      const [x, y] = view.toScreen(VERTS[vid].x, VERTS[vid].y);
      const w = R * 0.17 * pulse, h = R * 0.21 * pulse;
      const cx = x + R * 0.27, cy = y - R * (b.t === 'c' ? 0.52 : 0.46);
      c.save();
      c.translate(cx, cy);
      c.beginPath();
      c.moveTo(-w, -h * 0.55); c.lineTo(w, -h * 0.55); c.lineTo(w, h * 0.1);
      c.quadraticCurveTo(w * 0.8, h * 0.62, 0, h * 0.85);
      c.quadraticCurveTo(-w * 0.8, h * 0.62, -w, h * 0.1); c.closePath();
      c.fillStyle = shade(color, -0.1);
      c.shadowColor = 'rgba(0,0,0,0.5)'; c.shadowBlur = 3; c.shadowOffsetY = 1;
      c.fill();
      c.shadowColor = 'transparent';
      c.lineWidth = Math.max(1, R * 0.03);
      c.strokeStyle = '#f2c94c';
      c.stroke();
      // A sword: blade and cross-guard.
      c.strokeStyle = '#fff';
      c.lineWidth = Math.max(1, R * 0.028);
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(0, -h * 0.4); c.lineTo(0, h * 0.5);
      c.moveTo(-w * 0.48, -h * 0.02); c.lineTo(w * 0.48, -h * 0.02);
      c.stroke();
      c.restore();
    }
  }

  // ------------------------------------------------------------ the robber and the light
  /** Whether a corner is on the robber's tile, and so is not being paid. */
  robbed(game, v) {
    if (!game || game.useRobber === false || game.robber === undefined || game.robber < 0) return false;
    return !!HEXES[game.robber]?.corners?.includes(Number(v));
  }

  /** Dusk and night over the sea and the tiles, laid down before any piece is drawn. */
  drawSky(view, night) {
    if (night <= 0.01) return;
    const c = view.ctx;
    c.save();
    // Orange at the edges of the day, blue in the middle of the night.
    const warm = 0.13 * (1 - Math.abs(night * 2 - 1));
    if (warm > 0.005) { c.fillStyle = `rgba(255, 140, 50, ${warm})`; c.fillRect(0, 0, view.w, view.h); }
    c.fillStyle = `rgba(14, 30, 92, ${0.26 * night})`;
    c.fillRect(0, 0, view.w, view.h);
    c.restore();
  }
}
