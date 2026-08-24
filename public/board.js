// HexColony board geometry.
//
// The whole board is derived from one thing: a list of hex centres. Every vertex, edge,
// adjacency and coastline below is *computed* from those centres by generating the six
// corners of each hex and de-duplicating the shared points. Nothing here is a hand-typed
// table, so the topology cannot drift out of sync with the drawing — and it means a
// second board size costs only a new list of centres.
//
// Hexes are pointy-top in axial (q, r) coordinates. In `size = 1` units:
//   centre  x = sqrt(3) * (q + r/2),  y = 1.5 * r
//
//   classic       rows of 3,4,5,4,3     = 19 tiles
//   expansion     rows of 3,4,5,6,5,4,3 = 30 tiles (the 5-6 player board)
//   star          41 tiles, a six-pointed island
//   newfoundland  52 tiles, the island's outline in hexes

export const SQ3 = Math.sqrt(3);
const HALF_SQ3 = SQ3 / 2;

// Corner offsets from a hex centre, clockwise from the upper-right. Written as exact
// constants rather than sin/cos so two hexes sharing a corner produce the same float.
const CORNER_OFFSETS = [
  [HALF_SQ3, -0.5], // 0  upper right
  [HALF_SQ3, 0.5],  // 1  lower right
  [0, 1],           // 2  bottom
  [-HALF_SQ3, 0.5], // 3  lower left
  [-HALF_SQ3, -0.5],// 4  upper left
  [0, -1],          // 5  top
];

export const RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];

// Terrain -> what it pays out. The desert pays nothing and starts with the robber.
export const TERRAIN = {
  forest:   { res: 'wood',  label: 'Forest',   short: 'Wood' },
  hills:    { res: 'brick', label: 'Hills',    short: 'Brick' },
  pasture:  { res: 'sheep', label: 'Pasture',  short: 'Sheep' },
  fields:   { res: 'wheat', label: 'Fields',   short: 'Wheat' },
  mountains:{ res: 'ore',   label: 'Mountains',short: 'Ore' },
  desert:   { res: null,    label: 'Desert',   short: '—' },
};

// ---------------------------------------------------------------- layouts
// Each layout is a row plan: how many tiles in each row, top to bottom.
//
// The parity here is not free. A row's tiles sit at x = (q + r/2) hex-widths, so rows
// with an even `r` land on whole widths and rows with an odd `r` land on halves — and a
// row can only be centred if its tile count matches that parity. Odd counts need whole
// offsets, even counts need halves. The expansion's 3,4,5,6,5,4,3 therefore has to start
// at an even `r`, which is why its rows run 0..6 rather than -3..3.
const ROW_PLANS = {
  classic:   { firstRow: -2, counts: [3, 4, 5, 4, 3] },
  expansion: { firstRow: 0, counts: [3, 4, 5, 6, 5, 4, 3] },
};

/**
 * A shape that is not a stack of centred rows.
 *
 * The row plan above can only describe something symmetrical about x = 0, which covers a
 * round island and nothing else. A star has to reach further out on some rows than the
 * ones above them, and a coastline has bays in it — a row of an island is not always one
 * unbroken run of tiles.
 *
 * So these are written as runs of `[column, count]` in offset coordinates, where a column
 * is one hex across and odd rows sit half a hex to the right — which is how the tiles
 * actually sit, and means the source reads roughly like the island it draws. Two runs in
 * one row leave water between them.
 *
 * There is one rule a shape has to keep, and it is not obvious: no two tiles may meet at
 * a bare corner. `walkCoast` steps from one coastal edge to the next through the vertex
 * they share, which only works while every coastal vertex has exactly two of them. Tiles
 * touching corner-to-corner give a vertex four, the walk forks, and the ring of ports
 * comes out as a fragment of the coast. scripts/shape-lab.mjs draws a candidate and
 * checks this before it ever reaches the game.
 */
function runCoords(rows) {
  const out = [];
  rows.forEach((runs, r) => {
    for (const [col0, n] of runs) {
      // odd-r offset -> axial
      for (let k = 0; k < n; k++) out.push({ q: col0 + k - ((r - (r & 1)) >> 1), r });
    }
  });
  return out;
}

// A six-pointed island: a tip, a broad shoulder, and an arm reaching out either side,
// mirrored below. The narrow waist between the two arms is what keeps it a star rather
// than a blob, and it is the part of the board people will fight over.
const STAR_ROWS = [
  [[5, 1]],
  [[3, 4]],
  [[1, 9]],
  [[3, 4]],
  [[3, 5]],
  [[3, 4]],
  [[1, 9]],
  [[3, 4]],
  [[5, 1]],
];

// Newfoundland, north up and generalised to fifty-two hexes: the Great Northern Peninsula
// running down from the top left, the broad body below it, and the Avalon hanging off the
// south-east across a bay, joined by a single tile where the isthmus is. At this size it
// is a likeness rather than a map, but the three parts are all there and the isthmus is
// a real choke point to build across.
const NEWFOUNDLAND_ROWS = [
  [[4, 2]],                 // Great Northern Peninsula, running north
  [[3, 2]],
  [[4, 2]],
  [[3, 3]],
  [[3, 5]],                 // it opens out into the body
  [[2, 6]],
  [[2, 7]],
  [[2, 7]],
  [[3, 6]],
  [[4, 6]],                 // the last tile of this row is the isthmus
  [[5, 3], [9, 3]],         // bay, then the Avalon
];

// ---------------------------------------------------------------- the dynamic island
export const DYNAMIC_MIN = 30;
export const DYNAMIC_MAX = 80;

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
const ckey = (q, r) => `${q},${r}`;

/**
 * An island grown from one tile rather than drawn, different for every seed.
 *
 * Growth keeps it in one piece for free: every tile added touches one already there. What
 * growth does not give you is a shape worth playing on — picking uniformly from the tiles
 * on the edge produces something spindly and full of dead ends, because a lone tile poking
 * out has as much chance of being extended as the broad side of the island does.
 *
 * So a candidate's weight is how many neighbours it already has, raised to a power that
 * varies per seed. Near 1 the island comes out ragged and many-armed; near 4 it fills in
 * to something close to round. Rolling that exponent per seed rather than fixing it is
 * most of why two dynamic boards feel like different places.
 *
 * Then any lake is filled in. A shape with water enclosed inside it has two coastlines,
 * and the coast walk that spaces the ports only follows one — it would go round the outer
 * ring twice over and leave most of the shore without a harbour. Filling is better than
 * rejecting: a lake means the growth reached round and closed on itself, which is a
 * perfectly good island once the middle is land.
 */
function dynamicCoords(seed) {
  // Its own stream, so the shape cannot shift the terrain and token deals that follow.
  const pick = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const wanted = DYNAMIC_MIN + Math.floor(pick() * (DYNAMIC_MAX - DYNAMIC_MIN + 1));
  const bias = 1 + pick() * 3;

  // Filling a lake adds tiles after the growth has stopped, so a board that grew to the
  // ceiling can come back one over it. Rather than let the range be approximate, grow
  // again a little smaller until it fits. Each attempt draws from its own stream keyed on
  // the attempt number, so this stays identical on every device.
  let coords = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    coords = growIsland(wanted - attempt, bias, mulberry32((seed * 2654435761 + attempt) >>> 0));
    if (coords.length <= DYNAMIC_MAX) break;
  }
  return coords;
}

/** Grow one island to `target` tiles and fill in anything it wrapped around. */
function growIsland(target, bias, rng) {
  const have = new Set([ckey(0, 0)]);
  const coords = [{ q: 0, r: 0 }];
  const cand = new Map();
  const offer = (q, r) => {
    for (const [dq, dr] of DIRS) {
      const nq = q + dq, nr = r + dr, k = ckey(nq, nr);
      if (have.has(k)) continue;
      const c = cand.get(k);
      if (c) c.n += 1; else cand.set(k, { q: nq, r: nr, n: 1 });
    }
  };
  offer(0, 0);

  while (coords.length < target && cand.size) {
    const list = [...cand.values()];
    let total = 0;
    for (const c of list) total += c.n ** bias;
    let x = rng() * total;
    let take = list[list.length - 1];
    for (const c of list) { x -= c.n ** bias; if (x <= 0) { take = c; break; } }
    cand.delete(ckey(take.q, take.r));
    have.add(ckey(take.q, take.r));
    coords.push({ q: take.q, r: take.r });
    offer(take.q, take.r);
  }

  // Fill anything the growth wrapped around: flood the empty cells from outside the
  // bounding box, and whatever the flood never reaches is a lake.
  const qs = coords.map((c) => c.q), rs = coords.map((c) => c.r);
  const lo = { q: Math.min(...qs) - 1, r: Math.min(...rs) - 1 };
  const hi = { q: Math.max(...qs) + 1, r: Math.max(...rs) + 1 };
  const outside = new Set([ckey(lo.q, lo.r)]);
  const stack = [[lo.q, lo.r]];
  while (stack.length) {
    const [q, r] = stack.pop();
    for (const [dq, dr] of DIRS) {
      const nq = q + dq, nr = r + dr, k = ckey(nq, nr);
      if (nq < lo.q || nq > hi.q || nr < lo.r || nr > hi.r) continue;
      if (have.has(k) || outside.has(k)) continue;
      outside.add(k); stack.push([nq, nr]);
    }
  }
  for (let q = lo.q; q <= hi.q; q++) {
    for (let r = lo.r; r <= hi.r; r++) {
      if (!have.has(ckey(q, r)) && !outside.has(ckey(q, r))) coords.push({ q, r });
    }
  }
  return coords;
}

// Built per seed and kept, because the rules engine rebuilds the board on every move.
const dynamicTopos = new Map();
function dynamicTopo(seed) {
  let t = dynamicTopos.get(seed);
  if (!t) {
    t = buildTopology(dynamicCoords(seed));
    if (dynamicTopos.size > 16) dynamicTopos.clear();
    dynamicTopos.set(seed, t);
  }
  return t;
}

/**
 * The bags and decks for an island of a size nobody wrote down in advance.
 *
 * Every ratio here is read off the four fixed boards rather than invented: one desert per
 * thirteen tiles, five terrains in near-equal share with the three commonest taking the
 * remainder, and 2 and 12 half as common as every other number, which is what the printed
 * board does and what keeps the extremes rare.
 */
function dynamicInfo(tiles) {
  const desert = Math.max(1, Math.round(tiles / 13));
  const land = tiles - desert;

  const order = ['forest', 'pasture', 'fields', 'hills', 'mountains'];
  const base = Math.floor(land / 5), extra = land - base * 5;
  const terrain = { desert };
  order.forEach((t, i) => { terrain[t] = base + (i < extra ? 1 : 0); });

  const middle = [3, 4, 5, 6, 8, 9, 10, 11];
  const c = Math.max(1, Math.round((land + 2) / 10));
  const tokens = { 2: Math.max(1, c - 1), 12: Math.max(1, c - 1) };
  for (const n of middle) tokens[n] = c;

  // Trim or pad to exactly the number of land tiles. 6 and 8 move last: they have to be
  // placed without touching, and every extra red makes that harder.
  const nudge = [5, 9, 4, 10, 3, 11, 2, 12, 6, 8];
  let total = Object.values(tokens).reduce((a, b) => a + b, 0);
  for (let i = 0; total !== land && i < 5000; i++) {
    const n = nudge[i % nudge.length];
    if (total > land) { if (tokens[n] > 1) { tokens[n] -= 1; total -= 1; } }
    else { tokens[n] += 1; total += 1; }
  }

  return {
    key: 'dynamic',
    label: 'Dynamic',
    tiles,
    blurb: `${tiles} tiles, drawn fresh for this game.`,
    terrain,
    tokens,
    ports: Math.max(6, Math.round(tiles / 3.3)),
    bank: Math.round(19 + (tiles - 19) * 0.4),
    dev: {
      knight: Math.round(tiles * 0.62),
      vp: Math.round(tiles * 0.15),
      road: Math.max(2, Math.round(tiles * 0.10)),
      plenty: Math.max(2, Math.round(tiles * 0.10)),
      mono: Math.max(2, Math.round(tiles * 0.06)),
    },
  };
}

/**
 * What a layout is made of. Fixed boards answer from the table; the dynamic one has to be
 * grown first, because its size is not known until its seed is.
 */
export function layoutInfo(layout, seed) {
  if (layout === 'dynamic' && Number.isFinite(seed)) return dynamicInfo(dynamicTopo(seed).hexes.length);
  return LAYOUT_INFO[layout] || LAYOUT_INFO.classic;
}

function planCoords({ firstRow, counts }) {
  const out = [];
  counts.forEach((n, i) => {
    const r = firstRow + i;
    // Centre the row on x = 0: offsets run -(n-1)/2 .. (n-1)/2, and q = offset - r/2.
    const qmin = -((n - 1) + r) / 2;
    if (!Number.isInteger(qmin)) {
      throw new Error(`row ${r} of ${n} tiles cannot be centred — parity mismatch`);
    }
    for (let k = 0; k < n; k++) out.push({ q: qmin + k, r });
  });
  return out;
}

// The bag of terrain for each board, and the number tokens that go on it.
export const LAYOUT_INFO = {
  classic: {
    key: 'classic',
    label: 'Classic',
    tiles: 19,
    blurb: '19 tiles. The standard island, best for 3 or 4 players.',
    terrain: { forest: 4, pasture: 4, fields: 4, hills: 3, mountains: 3, desert: 1 },
    tokens: { 2: 1, 3: 2, 4: 2, 5: 2, 6: 2, 8: 2, 9: 2, 10: 2, 11: 2, 12: 1 },
    ports: 9,
    bank: 19,
    dev: { knight: 14, vp: 5, road: 2, plenty: 2, mono: 2 },
  },
  expansion: {
    key: 'expansion',
    label: 'Expansion',
    tiles: 30,
    blurb: '30 tiles and two deserts. A much bigger island, made for 5 or 6.',
    terrain: { forest: 6, pasture: 6, fields: 6, hills: 5, mountains: 5, desert: 2 },
    // The bigger board repeats every number once more except 2 and 12 — three 6s and
    // three 8s, which is what makes it feel richer than the classic island.
    tokens: { 2: 2, 3: 3, 4: 3, 5: 3, 6: 3, 8: 3, 9: 3, 10: 3, 11: 3, 12: 2 },
    ports: 11,
    bank: 24,
    dev: { knight: 20, vp: 6, road: 3, plenty: 3, mono: 2 },
  },
  star: {
    key: 'star',
    label: 'Beetle',
    tiles: 41,
    blurb: '41 tiles in a six-pointed island. Long coast, narrow waist, room for six.',
    terrain: { forest: 8, pasture: 8, fields: 8, hills: 7, mountains: 7, desert: 3 },
    tokens: { 2: 3, 3: 4, 4: 4, 5: 4, 6: 4, 8: 4, 9: 4, 10: 4, 11: 4, 12: 3 },
    // Ports are scaled by island rather than by coastline. A star has far more shore than
    // its area deserves — going by coast alone would ring it in harbours and make the
    // 2-for-1s ordinary.
    ports: 14,
    bank: 28,
    dev: { knight: 26, vp: 7, road: 4, plenty: 4, mono: 3 },
  },
  // No sizes here: a dynamic board's are decided by its seed, so anything that needs them
  // has to ask layoutInfo(layout, seed) rather than read them off this table.
  dynamic: {
    key: 'dynamic',
    label: 'Dynamic',
    tiles: null,
    dynamic: true,
    blurb: `A different island every game, anywhere from ${DYNAMIC_MIN} to ${DYNAMIC_MAX} tiles.`,
  },
  newfoundland: {
    key: 'newfoundland',
    label: 'Island',
    tiles: 52,
    blurb: '52 tiles shaped like the island. The Avalon is one tile from the mainland.',
    terrain: { forest: 10, pasture: 10, fields: 10, hills: 9, mountains: 9, desert: 4 },
    tokens: { 2: 4, 3: 5, 4: 5, 5: 5, 6: 5, 8: 5, 9: 5, 10: 5, 11: 5, 12: 4 },
    ports: 16,
    bank: 32,
    dev: { knight: 32, vp: 8, road: 5, plenty: 5, mono: 3 },
  },
};

const terrainBag = (info) => Object.entries(info.terrain).flatMap(([t, n]) => Array(n).fill(t));
const tokenBag = (info) => Object.entries(info.tokens).flatMap(([n, c]) => Array(c).fill(Number(n)));

// How likely a number is, as dots on the token. 6 and 8 get five dots and are printed
// red on a real board; `isRed` drives the same colouring here.
export const pips = (n) => (n ? 6 - Math.abs(7 - n) : 0);
export const isRed = (n) => n === 6 || n === 8;

// ---------------------------------------------------------------- deterministic RNG
// Every device generates the identical board from the room's seed, so the board itself
// never has to be written to Firestore — only the seed does.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------- topology
function buildTopology(coords) {
  const hexes = coords.map(({ q, r }, i) => ({
    i, q, r,
    x: SQ3 * (q + r / 2),
    y: 1.5 * r,
    corners: [],   // 6 vertex ids, clockwise from upper-right
    edges: [],     // 6 edge ids
  }));

  const vertices = [];
  const vertexByKey = new Map();
  // Quantising to 1e-3 absorbs the last-bit float differences between two hexes that
  // compute the same shared corner by different routes.
  const key = (x, y) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;

  function vertexAt(x, y) {
    const k = key(x, y);
    let id = vertexByKey.get(k);
    if (id === undefined) {
      id = vertices.length;
      vertexByKey.set(k, id);
      vertices.push({ i: id, x, y, hexes: [], adj: [], edges: [], port: null });
    }
    return id;
  }

  for (const h of hexes) {
    for (const [dx, dy] of CORNER_OFFSETS) {
      const v = vertexAt(h.x + dx, h.y + dy);
      h.corners.push(v);
      if (!vertices[v].hexes.includes(h.i)) vertices[v].hexes.push(h.i);
    }
  }

  const edges = [];
  const edgeByKey = new Map();
  for (const h of hexes) {
    for (let c = 0; c < 6; c++) {
      const a = h.corners[c];
      const b = h.corners[(c + 1) % 6];
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      let id = edgeByKey.get(k);
      if (id === undefined) {
        id = edges.length;
        edgeByKey.set(k, id);
        edges.push({
          i: id, a: Math.min(a, b), b: Math.max(a, b), hexes: [],
          x: (vertices[a].x + vertices[b].x) / 2,
          y: (vertices[a].y + vertices[b].y) / 2,
        });
        vertices[a].edges.push(id);
        vertices[b].edges.push(id);
        if (!vertices[a].adj.includes(b)) vertices[a].adj.push(b);
        if (!vertices[b].adj.includes(a)) vertices[b].adj.push(a);
      }
      if (!edges[id].hexes.includes(h.i)) edges[id].hexes.push(h.i);
      h.edges.push(id);
    }
  }

  // An edge with only one hex behind it is coastline, and those edges form a single
  // closed ring — which is what the ports get spaced around.
  const coastEdges = edges.filter((e) => e.hexes.length === 1).map((e) => e.i);
  const coastSet = new Set(coastEdges);
  const coastRing = walkCoast(edges, vertices, coastEdges, coastSet);

  // Two hexes are neighbours when they share an edge.
  const neighbours = hexes.map((h) =>
    edges.filter((e) => e.hexes.includes(h.i) && e.hexes.length === 2)
      .map((e) => e.hexes.find((x) => x !== h.i))
  );

  return { hexes, vertices, edges, coastEdges, coastRing, neighbours };
}

// Follow the coastline edge to edge. Every coastal vertex has exactly two coastal
// edges, so this traversal is forced and closes back on itself.
function walkCoast(edges, vertices, coastEdges, coastSet) {
  if (!coastEdges.length) return [];
  const ring = [coastEdges[0]];
  let prevEdge = coastEdges[0];
  let at = edges[prevEdge].b;
  while (ring.length < coastEdges.length) {
    const next = vertices[at].edges.find((e) => e !== prevEdge && coastSet.has(e));
    if (next === undefined) break;
    ring.push(next);
    at = edges[next].a === at ? edges[next].b : edges[next].a;
    prevEdge = next;
  }
  return ring;
}

const TOPOS = {
  classic: buildTopology(planCoords(ROW_PLANS.classic)),
  expansion: buildTopology(planCoords(ROW_PLANS.expansion)),
  star: buildTopology(runCoords(STAR_ROWS)),
  newfoundland: buildTopology(runCoords(NEWFOUNDLAND_ROWS)),
};

// These are `let` on purpose. Exported `let` bindings are live, so switching the layout
// updates every module that imported them without threading a topology argument through
// the rules engine, the renderer and the bots. Only one game is ever active in a page,
// and `makeBoard` sets the layout before anything reads it.
export let LAYOUT = 'classic';
export let TOPO = TOPOS.classic;
export let HEXES = TOPO.hexes;
export let VERTS = TOPO.vertices;
export let EDGES = TOPO.edges;

/**
 * Point the module at a board. Returns the key actually used.
 *
 * The dynamic board is the one that needs a seed: its shape is grown from it, so there is
 * no single topology to switch to the way there is for the fixed islands.
 */
export function useLayout(name, seed) {
  if (name === 'dynamic' && Number.isFinite(seed)) {
    LAYOUT = 'dynamic';
    TOPO = dynamicTopo(seed);
    HEXES = TOPO.hexes;
    VERTS = TOPO.vertices;
    EDGES = TOPO.edges;
    return 'dynamic';
  }
  const key = TOPOS[name] ? name : 'classic';
  LAYOUT = key;
  TOPO = TOPOS[key];
  HEXES = TOPO.hexes;
  VERTS = TOPO.vertices;
  EDGES = TOPO.edges;
  return key;
}

export function hexNeighbours(i) { return TOPO.neighbours[i]; }

// ---------------------------------------------------------------- ports
const PORT_BAG_BASE = ['wood', 'brick', 'sheep', 'wheat', 'ore'];

/**
 * Ports spaced evenly around the coastline. Walking the ring and stepping
 * `ringLength / portCount` reproduces the two-and-three-gap rhythm of the printed
 * board on the classic island, and generalises to the longer expansion coast without
 * a second hand-tuned pattern.
 */
function placePorts(rng, info) {
  const ring = TOPO.coastRing;
  const count = Math.min(info.ports, ring.length);
  const slots = [];
  for (let i = 0; i < count; i++) slots.push(ring[Math.round((i * ring.length) / count) % ring.length]);

  // One two-for-one per resource, the rest generic.
  const kinds = shuffled([
    ...PORT_BAG_BASE,
    ...Array(Math.max(0, count - PORT_BAG_BASE.length)).fill('any'),
  ], rng);

  return slots.map((edgeId, i) => {
    const e = EDGES[edgeId];
    return { edge: edgeId, a: e.a, b: e.b, kind: kinds[i] };
  });
}

// ---------------------------------------------------------------- number tokens
/**
 * Two 6s or 8s side by side make a runaway spot, and the printed board never does it.
 *
 * This used to shuffle the whole bag and check the result, which works while touching reds
 * are easy to avoid by luck and quietly stops working when they are not. On a compact
 * island the interior tiles have six neighbours each, and ten red tokens will not fall
 * clear of one another in six hundred throws: Newfoundland was landing on a board with
 * reds touching about one game in twelve, and the fallback at the end handed back a deal
 * with no constraint applied at all — which is how it produced boards with seven touching
 * pairs rather than a near miss.
 *
 * So the reds are placed first and deliberately, as a set of tiles no two of which touch.
 * Choosing them greedily from a shuffled order finds one immediately where one exists,
 * and every remaining number is dealt into what is left. The rule that matters is then
 * satisfied by construction rather than by rejection sampling.
 *
 * Two of the same number touching is a lesser thing — unavoidable on the big islands,
 * where most numbers appear four or five times — so that stays a preference, retried for
 * and then accepted. Reds never touch either way.
 */
function dealTokens(terrain, rng, info) {
  const slots = HEXES.map((h) => h.i).filter((i) => terrain[i] !== 'desert');
  const inPlay = new Set(slots);
  const nbrs = new Map(slots.map((i) => [i, hexNeighbours(i).filter((n) => inPlay.has(n))]));
  const bag = tokenBag(info);
  const reds = bag.filter((n) => isRed(n));
  const rest = bag.filter((n) => !isRed(n));

  // Tiles for the reds: walk a shuffled order taking any tile not already next to one
  // taken. That is an independent set by construction; the retries are only for the rare
  // order that paints itself into a corner before it has placed them all.
  let redSlots = null;
  for (let attempt = 0; attempt < 400 && !redSlots; attempt++) {
    const taken = [];
    const blocked = new Set();
    for (const s of shuffled(slots, rng)) {
      if (blocked.has(s)) continue;
      taken.push(s);
      blocked.add(s);
      for (const n of nbrs.get(s)) blocked.add(n);
      if (taken.length === reds.length) { redSlots = taken; break; }
    }
  }

  // No such set exists on this island — it is too small or too tightly packed for this
  // many reds. Nothing here can fix that, so deal straight and let the board be what it is.
  if (!redSlots) {
    const order = shuffled(bag, rng);
    const numbers = {};
    slots.forEach((h, k) => { numbers[h] = order[k]; });
    return numbers;
  }

  const redSet = new Set(redSlots);
  const restSlots = slots.filter((s) => !redSet.has(s));
  const deal = () => {
    const numbers = {};
    shuffled(reds, rng).forEach((n, i) => { numbers[redSlots[i]] = n; });
    shuffled(rest, rng).forEach((n, i) => { numbers[restSlots[i]] = n; });
    return numbers;
  };

  for (let attempt = 0; attempt < 400; attempt++) {
    const numbers = deal();
    if (!slots.some((s) => nbrs.get(s).some((n) => numbers[s] === numbers[n]))) return numbers;
  }
  return deal();
}

// ---------------------------------------------------------------- board generation
// The classic printed arrangement: terrain in a fixed ring and the numbers laid out
// A-R spiralling inward from the top-left. Kept as an option because some people know
// the standard board by heart. There is no equivalent for the expansion, which is
// always shuffled.
const CLASSIC_TERRAIN = [
  'mountains', 'pasture', 'forest',
  'fields', 'hills', 'pasture', 'hills',
  'fields', 'forest', 'desert', 'forest', 'mountains',
  'forest', 'mountains', 'fields', 'pasture',
  'hills', 'fields', 'pasture',
];
const SPIRAL = [0, 1, 2, 6, 11, 15, 18, 17, 16, 12, 7, 3, 4, 5, 10, 14, 13, 8, 9];
const CLASSIC_TOKENS = [5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 4, 5, 6, 3, 11];

function classicBoard() {
  const terrain = CLASSIC_TERRAIN.slice();
  const numbers = {};
  let t = 0;
  for (const h of SPIRAL) {
    if (terrain[h] === 'desert') continue;
    numbers[h] = CLASSIC_TOKENS[t++];
  }
  return { terrain, numbers };
}

/**
 * Build the full playing board from a seed. Deterministic: the same seed, mode and
 * layout produce byte-identical output on every device, which is why only those three
 * values travel over the wire.
 *
 * Also switches the module's active layout, so calling this is what makes the rest of
 * the topology exports correct for this game.
 */
const boardCache = new Map();

export function makeBoard(seed, mode = 'random', layout = 'classic') {
  // Deterministic in its three arguments, and the rules engine rebuilds it on every
  // single move — including every move of every bot turn. Generating it costs a terrain
  // shuffle, a port walk and a token deal that reshuffles until no two red numbers
  // touch, which on the expansion island can run to hundreds of attempts. Handing back
  // the same object is exact, not an approximation.
  //
  // Switching the shared topology is a side effect callers rely on, so that still runs.
  const cacheKey = `${seed}|${mode}|${layout}`;
  const hit = boardCache.get(cacheKey);
  if (hit) { useLayout(hit.layout, seed); return hit; }

  const built = buildBoard(seed, mode, layout);
  // The map picker walks through boards one seed at a time; only a handful are ever
  // wanted again, so this is a small window rather than a permanent store.
  if (boardCache.size > 24) boardCache.clear();
  boardCache.set(cacheKey, built);
  return built;
}

function buildBoard(seed, mode, layout) {
  const key = useLayout(layout, seed);
  const info = layoutInfo(key, seed);
  const rng = mulberry32(seed);

  let terrain, numbers;
  // The fixed arrangement only exists for the classic island.
  if (mode === 'classic' && key === 'classic') {
    ({ terrain, numbers } = classicBoard());
  } else {
    terrain = shuffled(terrainBag(info), rng);
    numbers = dealTokens(terrain, rng, info);
  }
  const ports = placePorts(rng, info);
  const robber = terrain.indexOf('desert');

  const tiles = HEXES.map((h) => ({
    i: h.i, q: h.q, r: h.r, x: h.x, y: h.y,
    terrain: terrain[h.i],
    res: TERRAIN[terrain[h.i]].res,
    num: numbers[h.i] ?? null,
    corners: h.corners,
  }));

  // Which vertices sit on a port, for fast trade-rate lookups.
  const portAt = {};
  for (const p of ports) { portAt[p.a] = p.kind; portAt[p.b] = p.kind; }

  // Which hexes pay out on each roll — precomputed so a roll is one lookup.
  const byNumber = {};
  for (const t of tiles) {
    if (!t.num) continue;
    (byNumber[t.num] ||= []).push(t.i);
  }

  return { seed, mode, layout: key, info, tiles, ports, portAt, byNumber, robber };
}

// ---------------------------------------------------------------- spatial helpers
/**
 * How far the island reaches, which is what the view is scaled to fit.
 *
 * Worked out once and kept on the topology itself. It used to be cached under the layout's
 * NAME, which is the same thing for the fixed islands and quietly wrong for the dynamic
 * one: every seed grows a different shape under the one name 'dynamic', so the second
 * board of a session was drawn to the first board's extent — a big island fitted to a
 * small one's box, hanging off every edge of the screen. Hanging it on the topology object
 * means a new shape cannot borrow an old shape's measurements.
 *
 * The renderer asks for this while clamping a pan, which is to say on every frame of
 * every drag, so it does want to be cached.
 */
export function boardExtent() {
  if (TOPO.extent) return TOPO.extent;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const v of VERTS) {
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
  }
  TOPO.extent = { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY };
  return TOPO.extent;
}

// The outward direction of a coastal edge, used to float the port badge off the shore.
export function edgeOutward(edgeId) {
  const e = EDGES[edgeId];
  const h = HEXES[e.hexes[0]];
  const dx = e.x - h.x, dy = e.y - h.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}
