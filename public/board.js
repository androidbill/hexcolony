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
//   classic    rows of 3,4,5,4,3     = 19 tiles
//   expansion  rows of 3,4,5,6,5,4,3 = 30 tiles (the 5-6 player board)

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

/** Point the module at a board size. Returns the key actually used. */
export function useLayout(name) {
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
// Two 6s or 8s side by side make a runaway spot. The printed board never does it, and
// neither do we: reshuffle until no two red tokens touch. The expansion carries three
// 6s and three 8s on a bigger island, so this matters more there, not less.
function dealTokens(terrain, rng, info) {
  const slots = HEXES.map((h) => h.i).filter((i) => terrain[i] !== 'desert');
  const neighbours = slots.map((i) => hexNeighbours(i).filter((n) => terrain[n] !== 'desert'));
  const bag = tokenBag(info);

  // Same numbers touching is also ugly, but with three copies of most numbers on the
  // expansion it is not always avoidable — so it is a preference, not a requirement.
  for (const strict of [true, false]) {
    for (let attempt = 0; attempt < 600; attempt++) {
      const order = shuffled(bag, rng);
      const numbers = {};
      slots.forEach((h, k) => { numbers[h] = order[k]; });
      const clash = slots.some((h, k) => neighbours[k].some((n) => {
        const a = numbers[h], b = numbers[n];
        return (isRed(a) && isRed(b)) || (strict && a === b);
      }));
      if (!clash) return numbers;
    }
  }
  // Vanishingly unlikely, but never hang the lobby over token aesthetics.
  const order = shuffled(bag, rng);
  const numbers = {};
  slots.forEach((h, k) => { numbers[h] = order[k]; });
  return numbers;
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
  if (hit) { useLayout(hit.layout); return hit; }

  const built = buildBoard(seed, mode, layout);
  // The map picker walks through boards one seed at a time; only a handful are ever
  // wanted again, so this is a small window rather than a permanent store.
  if (boardCache.size > 24) boardCache.clear();
  boardCache.set(cacheKey, built);
  return built;
}

function buildBoard(seed, mode, layout) {
  const key = useLayout(layout);
  const info = LAYOUT_INFO[key];
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
// One per layout, worked out once. The renderer asks for this while clamping a pan,
// which is to say on every frame of every drag.
const extentCache = {};
export function boardExtent() {
  const hit = extentCache[LAYOUT];
  if (hit) return hit;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const v of VERTS) {
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
  }
  extentCache[LAYOUT] = { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY };
  return extentCache[LAYOUT];
}

// The outward direction of a coastal edge, used to float the port badge off the shore.
export function edgeOutward(edgeId) {
  const e = EDGES[edgeId];
  const h = HEXES[e.hexes[0]];
  const dx = e.x - h.x, dy = e.y - h.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}
