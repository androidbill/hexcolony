// A running record of one game as this device watched it: what went up where and when,
// everybody's points over time, and what the dice paid out against what they should have.
//
// It exists because the game's own log is capped (older entries are dropped as the game
// goes on), so by the end it can no longer say how the game began. This keeps its own
// copy, in this phone's localStorage only — nothing here is ever written to the database.
//
// Pure functions over a plain object, so the bookkeeping can be tested in Node.

import { VERTS, EDGES, pips } from './board.js';

export const CHRON_KEY = 'hexcolony_chronicle';

export function newChron(gid, seats, partial) {
  return {
    gid, seats: seats.slice(), partial: !!partial, last: 0, done: false,
    bldg: {}, roads: {}, award: { road: null, army: null },
    steps: [],            // { n, k: 's'|'c'|'r'|'x', p, v|e|hex }, in the order they happened
    series: [],           // { n, vp: { pid: points } } — a point each time anyone's score moved
    rolls: 0,
    robber: null,         // where the robber stands, so a blocked tile is not counted as luck
    exp: {},              // pid -> resource cards the dice were expected to pay, summed over rolls
    act: {},              // pid -> resource cards actually paid by rolls (setup excluded)
    final: null,
  };
}

const publicPoints = (c, pid) => {
  let vp = 0;
  for (const b of Object.values(c.bldg)) if (b.p === pid) vp += b.t === 'c' ? 2 : 1;
  if (c.award.road === pid) vp += 2;
  if (c.award.army === pid) vp += 2;
  return vp;
};

function sample(c, n) {
  const vp = Object.fromEntries(c.seats.map((pid) => [pid, publicPoints(c, pid)]));
  const prev = c.series[c.series.length - 1];
  if (prev && c.seats.every((pid) => prev.vp[pid] === vp[pid])) return;
  if (prev && prev.n === n) prev.vp = vp; else c.series.push({ n, vp });
}

/** What the dice should pay `pid` per roll, given what they own right now. */
function expectedPerRoll(c, board, pid, useRobber) {
  let e = 0;
  for (const [v, b] of Object.entries(c.bldg)) {
    if (b.p !== pid) continue;
    for (const hi of VERTS[v].hexes) {
      if (useRobber && hi === c.robber) continue;
      const t = board.tiles[hi];
      if (t?.res && t.num) e += (b.t === 'c' ? 2 : 1) * pips(t.num) / 36;
    }
  }
  return e;
}

/**
 * Take in whatever the game log has that the chronicle has not seen. Safe to call on every
 * render. A chronicle begun in the middle of a game starts from the board as it stands.
 */
export function ingest(c, g, board) {
  if (!c || c.done) return c;
  const log = g.log || [];
  if (c.robber === null) c.robber = g.robber ?? null;
  const useRobber = g.useRobber !== false;
  if (c.last === 0 && c.partial && !c.seeded) {
    // Joined late: take the position as it is, flagged so the replay says so.
    c.seeded = true;
    for (const [v, b] of Object.entries(g.bldg || {})) {
      c.bldg[v] = { p: b.p, t: b.t };
      c.steps.push({ n: 0, k: 's', p: b.p, v: Number(v) });
      if (b.t === 'c') c.steps.push({ n: 0, k: 'c', p: b.p, v: Number(v) });
    }
    for (const [e, p] of Object.entries(g.roads || {})) {
      c.roads[e] = p;
      c.steps.push({ n: 0, k: 'r', p, e: Number(e) });
    }
    c.award = { road: g.award?.road ?? null, army: g.award?.army ?? null };
    c.last = Math.max(0, ...log.map((e) => e.i || 0));
    sample(c, g.turn?.num || 0);
    return c;
  }
  const fresh = log.filter((e) => (e.i || 0) > c.last).sort((a, b) => a.i - b.i);
  for (const e of fresh) {
    c.last = e.i;
    const n = e.n ?? 0;
    switch (e.t) {
      case 'build':
        if (e.what === 'road') {
          c.roads[e.e] = e.p;
          c.steps.push({ n, k: 'r', p: e.p, e: Number(e.e) });
        } else {
          c.bldg[e.v] = { p: e.p, t: e.what === 'city' ? 'c' : 's' };
          c.steps.push({ n, k: e.what === 'city' ? 'c' : 's', p: e.p, v: Number(e.v) });
          sample(c, n);
        }
        break;
      case 'roll':
        c.rolls += 1;
        for (const pid of c.seats) c.exp[pid] = (c.exp[pid] || 0) + expectedPerRoll(c, board, pid, useRobber);
        break;
      case 'produce':
        // Roll 0 is the setup payout — a free start, not the dice.
        if (e.roll > 0 && !e.bonus) {
          for (const [pid, byRes] of Object.entries(e.gains || {})) {
            c.act[pid] = (c.act[pid] || 0) + Object.values(byRes).reduce((a, b) => a + b, 0);
          }
        }
        break;
      case 'robber': c.robber = e.hex; c.steps.push({ n, k: 'x', p: e.p, hex: e.hex }); break;
      case 'longest': c.award.road = e.p; sample(c, n); break;
      case 'army': c.award.army = e.p; sample(c, n); break;
      default: break;
    }
  }
  return c;
}

/** The game is over: fix the final points, hidden victory cards included. */
export function finish(c, g, totalVP) {
  if (!c || c.done) return c;
  c.final = Object.fromEntries(c.seats.map((pid) => [pid, totalVP(g, pid)]));
  const n = g.turn?.num || 0;
  const prev = c.series[c.series.length - 1];
  if (prev && prev.n === n) prev.vp = c.final; else c.series.push({ n, vp: c.final });
  c.done = true;
  return c;
}

/** Actual against expected production for one player, as a percentage either side of 0. */
export function luckOf(c, pid) {
  const exp = c.exp[pid] || 0;
  const act = c.act[pid] || 0;
  return { exp, act, pct: exp > 0.5 ? Math.round((act / exp - 1) * 100) : 0 };
}

const TERRAIN_CODE = { forest: 'F', hills: 'H', pasture: 'P', fields: 'W', mountains: 'M', desert: 'D' };
const round2 = (x) => Math.round(x * 100) / 100;

/**
 * The compact, self-contained copy kept in the history: enough to redraw the island and
 * play the game back without needing the board it was played on.
 */
export function compact(c, board, people) {
  const idx = Object.fromEntries(c.seats.map((pid, i) => [pid, i]));
  const tiles = board.tiles.map((t) => {
    const first = VERTS[t.corners[0]];
    return [round2(t.x), round2(t.y), TERRAIN_CODE[t.terrain] || 'D', t.num || 0,
      round2(Math.hypot(first.x - t.x, first.y - t.y)), round2(Math.atan2(first.y - t.y, first.x - t.x))];
  });
  const steps = c.steps.map((s) => {
    if (s.k === 's' || s.k === 'c') return [s.n, s.k, idx[s.p] ?? 0, round2(VERTS[s.v].x), round2(VERTS[s.v].y)];
    if (s.k === 'r') {
      const ed = EDGES[s.e];
      return [s.n, 'r', idx[s.p] ?? 0, round2(VERTS[ed.a].x), round2(VERTS[ed.a].y), round2(VERTS[ed.b].x), round2(VERTS[ed.b].y)];
    }
    const t = board.tiles[s.hex];
    return [s.n, 'x', idx[s.p] ?? 0, t ? round2(t.x) : 0, t ? round2(t.y) : 0];
  });
  return {
    tiles,
    steps,
    series: c.series.map((s) => [s.n, c.seats.map((pid) => s.vp[pid] || 0)]),
    people: c.seats.map((pid) => ({ ...(people[pid] || {}), luck: luckOf(c, pid) })),
    partial: c.partial,
  };
}

export function loadChron() {
  try {
    const c = JSON.parse(localStorage.getItem(CHRON_KEY) || 'null');
    return c && typeof c === 'object' && Array.isArray(c.steps) ? c : null;
  } catch { return null; }
}

export function saveChron(c) {
  try { localStorage.setItem(CHRON_KEY, JSON.stringify(c)); } catch { /* nice to have only */ }
}
