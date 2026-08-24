// Scratch tool for designing a board outline.
//
// A layout is only a list of hex centres, but not every list makes a playable island.
// This draws a candidate, counts it, and checks the two things that actually break a
// board — neither of which is obvious, and one of which used to be checked for wrongly.
//
// The coast walk in board.js follows one closed ring of coastal edges. That works for any
// shape with a single outline, and fails for a shape with two: an island in two pieces, or
// an island with a lake in it. The walk takes whichever ring it starts on, and then, since
// it only stops when it has collected as many edges as the coast has, it goes round again
// re-adding the same ones. A donut of six tiles has twenty-four coastal edges and comes
// back as the same six repeated four times — so most of the coast gets no port and a few
// edges get several.
//
// It is NOT a problem for tiles to meet at a bare corner, which an earlier version of this
// file claimed and checked for. Three mutually-adjacent hexes meet at every vertex of a
// hex grid, so a coastal vertex has exactly two coastal edges however the tiles fall: the
// check could not fail, and passed the donut it should have caught.
//
//   node scripts/shape-lab.mjs

const SQ3 = Math.sqrt(3);
const HALF_SQ3 = SQ3 / 2;
const CORNER_OFFSETS = [
  [HALF_SQ3, -0.5], [HALF_SQ3, 0.5], [0, 1],
  [-HALF_SQ3, 0.5], [-HALF_SQ3, -0.5], [0, -1],
];

/**
 * Rows given as runs of tiles, so a shape can be written the way it looks.
 *
 * Each row is a list of [startColumn, count] pairs in "offset" columns, where a column is
 * one hex width and odd rows sit half a width to the right. Several runs in a row leave a
 * bay between them.
 */
export function coordsFromRows(rows) {
  const out = [];
  rows.forEach((runs, i) => {
    const r = i;
    for (const [c0, n] of runs) {
      for (let k = 0; k < n; k++) {
        const col = c0 + k;
        // odd-r offset -> axial
        out.push({ q: col - ((r - (r & 1)) >> 1), r });
      }
    }
  });
  return out;
}

function analyse(coords) {
  const hexes = coords.map((c, i) => ({
    i, q: c.q, r: c.r,
    x: SQ3 * (c.q + c.r / 2), y: 1.5 * c.r,
    corners: [],
  }));

  const key = (x, y) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
  const vByKey = new Map();
  const verts = [];
  const vertexAt = (x, y) => {
    const k = key(x, y);
    let id = vByKey.get(k);
    if (id === undefined) { id = verts.length; vByKey.set(k, id); verts.push({ i: id, edges: [], hexes: [] }); }
    return id;
  };
  for (const h of hexes) {
    for (const [dx, dy] of CORNER_OFFSETS) {
      const v = vertexAt(h.x + dx, h.y + dy);
      h.corners.push(v);
      if (!verts[v].hexes.includes(h.i)) verts[v].hexes.push(h.i);
    }
  }

  const edges = [];
  const eByKey = new Map();
  for (const h of hexes) {
    for (let c = 0; c < 6; c++) {
      const a = h.corners[c], b = h.corners[(c + 1) % 6];
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      let id = eByKey.get(k);
      if (id === undefined) {
        id = edges.length; eByKey.set(k, id);
        edges.push({ i: id, a, b, hexes: [] });
        verts[a].edges.push(id); verts[b].edges.push(id);
      }
      if (!edges[id].hexes.includes(h.i)) edges[id].hexes.push(h.i);
    }
  }

  const coastEdges = edges.filter((e) => e.hexes.length === 1).map((e) => e.i);
  const coastSet = new Set(coastEdges);

  // Walk the coast the way board.js does, and count DISTINCT edges reached. A single
  // outline reaches all of them; anything with a second outline goes round the first one
  // again, so the shortfall is the tell.
  let ringLen = 0, ringDistinct = 0;
  if (coastEdges.length) {
    const ring = [coastEdges[0]];
    let prev = coastEdges[0];
    let at = edges[prev].b;
    while (ring.length < coastEdges.length) {
      const next = verts[at].edges.find((e) => e !== prev && coastSet.has(e));
      if (next === undefined) break;
      ring.push(next);
      at = edges[next].a === at ? edges[next].b : edges[next].a;
      prev = next;
    }
    ringLen = ring.length;
    ringDistinct = new Set(ring).size;
  }

  // Contiguity: every tile reachable from the first by shared edges.
  const nbr = hexes.map((h) => edges.filter((e) => e.hexes.includes(h.i) && e.hexes.length === 2)
    .map((e) => e.hexes.find((x) => x !== h.i)));
  const seen = new Set([0]); const stack = [0];
  while (stack.length) for (const n of nbr[stack.pop()]) if (!seen.has(n)) { seen.add(n); stack.push(n); }

  // Holes: flood the empty cells inward from outside the bounding box. An empty cell the
  // flood never reaches is enclosed, and its shore is a second ring.
  const have = new Set(coords.map((c) => `${c.q},${c.r}`));
  const qs = coords.map((c) => c.q), rs = coords.map((c) => c.r);
  const lo = { q: Math.min(...qs) - 2, r: Math.min(...rs) - 2 };
  const hi = { q: Math.max(...qs) + 2, r: Math.max(...rs) + 2 };
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
  const outside = new Set([`${lo.q},${lo.r}`]);
  const queue = [[lo.q, lo.r]];
  while (queue.length) {
    const [q, r] = queue.pop();
    for (const [dq, dr] of DIRS) {
      const nq = q + dq, nr = r + dr, k = `${nq},${nr}`;
      if (nq < lo.q || nq > hi.q || nr < lo.r || nr > hi.r) continue;
      if (have.has(k) || outside.has(k)) continue;
      outside.add(k); queue.push([nq, nr]);
    }
  }
  let holes = 0;
  for (let q = lo.q; q <= hi.q; q++) {
    for (let r = lo.r; r <= hi.r; r++) {
      const k = `${q},${r}`;
      if (!have.has(k) && !outside.has(k)) holes++;
    }
  }

  return {
    tiles: hexes.length,
    coastEdges: coastEdges.length,
    ringLen,
    ringDistinct,
    oneOutline: ringDistinct === coastEdges.length,
    holes,
    contiguous: seen.size === hexes.length,
    stranded: hexes.length - seen.size,
    hexes,
  };
}

function draw(hexes) {
  // Two output columns per hex width so odd rows can sit half a width across.
  const minR = Math.min(...hexes.map((h) => h.r));
  const cols = hexes.map((h) => h.q + ((h.r - (h.r & 1)) >> 1));
  const minC = Math.min(...cols), maxC = Math.max(...cols);
  const byRow = new Map();
  hexes.forEach((h) => {
    const row = h.r - minR;
    if (!byRow.has(row)) byRow.set(row, new Set());
    byRow.get(row).add(h.q + ((h.r - (h.r & 1)) >> 1));
  });
  const lines = [];
  for (let row = 0; row <= Math.max(...byRow.keys()); row++) {
    const set = byRow.get(row) || new Set();
    const r = row + minR;
    let s = (r & 1) ? ' ' : '';
    for (let c = minC; c <= maxC; c++) s += set.has(c) ? '⬢ ' : '  ';
    lines.push(s.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

export function report(name, rows) {
  const coords = coordsFromRows(rows);
  const a = analyse(coords);
  console.log(`\n=== ${name} ===`);
  console.log(draw(a.hexes));
  console.log(`tiles: ${a.tiles}   coast edges: ${a.coastEdges}`);
  console.log(`one outline: ${a.oneOutline ? 'yes ✓' : `NO ✗ (walk reaches ${a.ringDistinct} of ${a.coastEdges})`}`);
  console.log(`contiguous: ${a.contiguous ? 'yes ✓' : `NO ✗ (${a.stranded} stranded)`}`);
  console.log(`holes: ${a.holes ? `✗ ${a.holes}` : 'none ✓'}`);
  return a;
}

/** Same checks, for a shape already in axial coordinates. */
export function reportCoords(name, coords) {
  const a = analyse(coords);
  console.log(`\n=== ${name} ===`);
  console.log(draw(a.hexes));
  console.log(`tiles: ${a.tiles}   coast edges: ${a.coastEdges}`);
  console.log(`one outline: ${a.oneOutline ? 'yes ✓' : `NO ✗ (walk reaches ${a.ringDistinct} of ${a.coastEdges})`}`);
  console.log(`contiguous: ${a.contiguous ? 'yes ✓' : `NO ✗ (${a.stranded} stranded)`}`);
  console.log(`holes: ${a.holes ? `✗ ${a.holes}` : 'none ✓'}`);
  return a;
}

// Run with no arguments to check the two hand-drawn islands that ship. Paste a candidate
// in alongside them to see it drawn and checked before it goes anywhere near board.js.
//
// The dynamic board is checked in scripts/engine-tests.mjs instead, across many seeds:
// its shapes are grown rather than written down, so there is nothing here to eyeball.
report('star · 41', [
  [[5, 1]], [[3, 4]], [[1, 9]], [[3, 4]], [[3, 5]], [[3, 4]], [[1, 9]], [[3, 4]], [[5, 1]],
]);
report('newfoundland · 52', [
  [[4, 2]], [[3, 2]], [[4, 2]], [[3, 3]], [[3, 5]], [[2, 6]],
  [[2, 7]], [[2, 7]], [[3, 6]], [[4, 6]], [[5, 3], [9, 3]],
]);
