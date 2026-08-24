// Scratch tool for designing a board outline.
//
// A layout is only a list of hex centres, but not every list makes a playable island. The
// coast walk in board.js assumes each coastal vertex has exactly two coastal edges, which
// is true of any shape whose tiles never meet at a bare corner. This draws a candidate,
// counts it, and checks the things that would otherwise only show up as a broken ring of
// ports or a board nobody can build a road across.
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

  // Every coastal vertex must have exactly two coastal edges, or the walk forks.
  const bad = [];
  for (const v of verts) {
    const n = v.edges.filter((e) => coastSet.has(e)).length;
    if (n !== 0 && n !== 2) bad.push({ v: v.i, coastEdges: n });
  }

  // Walk the coast the way board.js does and see whether it closes.
  let ringLen = 0;
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
  }

  // Contiguity: every tile reachable from the first by shared edges.
  const nbr = hexes.map((h) => edges.filter((e) => e.hexes.includes(h.i) && e.hexes.length === 2)
    .map((e) => e.hexes.find((x) => x !== h.i)));
  const seen = new Set([0]); const stack = [0];
  while (stack.length) for (const n of nbr[stack.pop()]) if (!seen.has(n)) { seen.add(n); stack.push(n); }

  return {
    tiles: hexes.length,
    coastEdges: coastEdges.length,
    ringLen,
    ringCloses: ringLen === coastEdges.length,
    badVertices: bad,
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
  console.log(`tiles: ${a.tiles}   coast edges: ${a.coastEdges}   ring: ${a.ringLen} ${a.ringCloses ? '(closes ✓)' : '(BROKEN ✗)'}`);
  console.log(`contiguous: ${a.contiguous ? 'yes ✓' : `NO ✗ (${a.stranded} stranded)`}`);
  console.log(a.badVertices.length
    ? `pinch points: ✗ ${a.badVertices.length} vertex/vertices with ${[...new Set(a.badVertices.map((b) => b.coastEdges))].join('/')} coastal edges`
    : 'pinch points: none ✓');
  return a;
}

// Run with no arguments to check the two shaped islands that ship. Paste a candidate in
// alongside them to see it drawn and checked before it goes anywhere near board.js.
report('star · 41', [
  [[5, 1]], [[3, 4]], [[1, 9]], [[3, 4]], [[3, 5]], [[3, 4]], [[1, 9]], [[3, 4]], [[5, 1]],
]);
report('newfoundland · 52', [
  [[4, 2]], [[3, 2]], [[4, 2]], [[3, 3]], [[3, 5]], [[2, 6]],
  [[2, 7]], [[2, 7]], [[3, 6]], [[4, 6]], [[5, 3], [9, 3]],
]);
