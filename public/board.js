// CatanX board geometry.
//
// The whole board is derived from one thing: 19 hex centres. Every vertex, edge,
// adjacency and coastline below is *computed* from those centres by generating the
// six corners of each hex and de-duplicating the shared points. Nothing here is a
// hand-typed table, so the topology cannot drift out of sync with the drawing.
//
// Hexes are pointy-top in axial (q, r) coordinates. In `size = 1` units:
//   centre  x = sqrt(3) * (q + r/2),  y = 1.5 * r
// which puts the classic 3-4-5-4-3 island in rows from r = -2 (top) to r = 2.

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

// A standard 19-tile island: 4 forest, 4 pasture, 4 fields, 3 hills, 3 mountains, 1 desert.
const TERRAIN_BAG = [
  ...Array(4).fill('forest'),
  ...Array(4).fill('pasture'),
  ...Array(4).fill('fields'),
  ...Array(3).fill('hills'),
  ...Array(3).fill('mountains'),
  'desert',
];

// The 18 number tokens. No 7 — that is the robber's roll.
const TOKEN_BAG = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

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
// Built once at module load: the hex/vertex/edge graph is the same for every game,
// only the terrain and numbers painted onto it change.

function axialCoords() {
  const out = [];
  for (let r = -2; r <= 2; r++) {
    for (let q = -2; q <= 2; q++) {
      // cube distance from the centre; <= 2 carves the 19-hex island out of the grid
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(-q - r)) <= 2) out.push({ q, r });
    }
  }
  return out;
}

function buildTopology() {
  const hexes = axialCoords().map(({ q, r }, i) => ({
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

  // An edge with only one hex behind it is coastline. There are 30 of them and they
  // form a single closed ring, which is what the ports get spaced around.
  const coastEdges = edges.filter((e) => e.hexes.length === 1).map((e) => e.i);
  const coastSet = new Set(coastEdges);
  const coastRing = walkCoast(edges, vertices, coastEdges, coastSet);

  return { hexes, vertices, edges, coastEdges, coastRing };
}

// Follow the coastline edge to edge. Every coastal vertex has exactly two coastal
// edges, so this traversal is forced and closes back on itself after 30 steps.
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

export const TOPO = buildTopology();

// Handy aliases — these never change, so callers can read them straight off.
export const HEXES = TOPO.hexes;
export const VERTS = TOPO.vertices;
export const EDGES = TOPO.edges;

// ---------------------------------------------------------------- ports
// Nine ports around a thirty-edge coastline. Stepping 3, 3, 4 and repeating lands
// exactly back on the start (3+3+4 = 10, three times round = 30) and reproduces the
// two-and-three-gap rhythm of the printed board.
const PORT_STEPS = [3, 3, 4];
const PORT_BAG = ['any', 'any', 'any', 'any', 'wood', 'brick', 'sheep', 'wheat', 'ore'];

function placePorts(rng) {
  const ring = TOPO.coastRing;
  const slots = [];
  let at = 0;
  for (let i = 0; i < 9; i++) {
    slots.push(ring[at % ring.length]);
    at += PORT_STEPS[i % PORT_STEPS.length];
  }
  const kinds = shuffled(PORT_BAG, rng);
  // Rotating the ring start means the 2:1 wood port isn't always in the same bay.
  const spin = Math.floor(rng() * 9);
  return slots.map((edgeId, i) => {
    const e = EDGES[edgeId];
    return { edge: edgeId, a: e.a, b: e.b, kind: kinds[(i + spin) % 9] };
  });
}

// ---------------------------------------------------------------- number tokens
// Two 6s or 8s side by side make a runaway spot. The printed board never does it, and
// neither do we: reshuffle until no two red tokens (and no two equal numbers) touch.
function dealTokens(terrain, rng) {
  const slots = HEXES.map((h) => h.i).filter((i) => terrain[i] !== 'desert');
  const neighbours = slots.map((i) => hexNeighbours(i).filter((n) => terrain[n] !== 'desert'));

  for (let attempt = 0; attempt < 400; attempt++) {
    const bag = shuffled(TOKEN_BAG, rng);
    const numbers = {};
    slots.forEach((h, k) => { numbers[h] = bag[k]; });
    const clash = slots.some((h, k) => neighbours[k].some((n) => {
      const a = numbers[h], b = numbers[n];
      return (isRed(a) && isRed(b)) || a === b;
    }));
    if (!clash) return numbers;
  }
  // Vanishingly unlikely, but never hang the lobby over token aesthetics.
  const bag = shuffled(TOKEN_BAG, rng);
  const numbers = {};
  slots.forEach((h, k) => { numbers[h] = bag[k]; });
  return numbers;
}

// Two hexes are neighbours when they share an edge.
const HEX_NEIGHBOURS = HEXES.map((h) =>
  EDGES.filter((e) => e.hexes.includes(h.i) && e.hexes.length === 2)
    .map((e) => e.hexes.find((x) => x !== h.i))
);
export function hexNeighbours(i) { return HEX_NEIGHBOURS[i]; }

// ---------------------------------------------------------------- board generation
// The classic printed arrangement: terrain in a fixed ring and the numbers laid out
// A-R spiralling inward from the top-left. Kept as an option because some people know
// the standard board by heart.
const CLASSIC_TERRAIN = [
  'mountains', 'pasture', 'forest',
  'fields', 'hills', 'pasture', 'hills',
  'fields', 'forest', 'desert', 'forest', 'mountains',
  'forest', 'mountains', 'fields', 'pasture',
  'hills', 'fields', 'pasture',
];
// Hex ids in spiral order, outer ring clockwise from the top-left then inward.
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
 * Build the full playing board from a seed. Deterministic: the same seed and mode
 * produce byte-identical output on every device, which is why only the seed travels
 * over the wire.
 */
export function makeBoard(seed, mode = 'random') {
  const rng = mulberry32(seed);
  let terrain, numbers;
  if (mode === 'classic') {
    ({ terrain, numbers } = classicBoard());
  } else {
    terrain = shuffled(TERRAIN_BAG, rng);
    numbers = dealTokens(terrain, rng);
  }
  const ports = placePorts(rng);
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

  return { seed, mode, tiles, ports, portAt, byNumber, robber };
}

// ---------------------------------------------------------------- spatial helpers
export function boardExtent() {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const v of VERTS) {
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
  }
  return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY };
}

// The outward direction of a coastal edge, used to float the port badge off the shore.
export function edgeOutward(edgeId) {
  const e = EDGES[edgeId];
  const h = HEXES[e.hexes[0]];
  const dx = e.x - h.x, dy = e.y - h.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}
