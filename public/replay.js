// Drawing for the game replay and the points-over-time graph. Everything is drawn from the
// compact copy chronicle.js keeps in the history (tiles, steps, series), so a game can be
// watched again long after the board it was played on has gone.

const TAU = Math.PI * 2;

const TERRAIN = {
  F: ['#2f6b3a', '#1e4a27'], H: ['#b8613a', '#8d4425'], P: ['#78bf5c', '#579a3e'],
  W: ['#e3ba57', '#c9963a'], M: ['#8d94a8', '#5f6678'], D: ['#ddc48d', '#c2a469'],
};

function bounds(data) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y, , , r] of data.tiles) {
    minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r);
    minY = Math.min(minY, y - r); maxY = Math.max(maxY, y + r);
  }
  return { minX, maxX, minY, maxY };
}

/** Fit the island into w x h and give back the world -> screen mapping. */
function fitTo(data, w, h) {
  const b = bounds(data);
  const pad = 10;
  const s = Math.min((w - pad * 2) / (b.maxX - b.minX), (h - pad * 2) / (b.maxY - b.minY));
  const ox = (w - (b.maxX - b.minX) * s) / 2 - b.minX * s;
  const oy = (h - (b.maxY - b.minY) * s) / 2 - b.minY * s;
  return { s, at: (x, y) => [ox + x * s, oy + y * s] };
}

/**
 * The island with everything built in the first `upTo` steps on it. `colors[i]` is the
 * i-th player's colour; `sea` is [light, dark] for the water behind it.
 */
export function drawBoard(ctx, w, h, data, upTo, colors, sea, now = 0) {
  const { s, at } = fitTo(data, w, h);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, sea?.[0] || '#bfe7f7'); g.addColorStop(1, sea?.[1] || '#5aa9cf');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Tiles.
  for (const [x, y, code, num, r, a0] of data.tiles) {
    const [cx, cy] = at(x, y);
    const [a, b] = TERRAIN[code] || TERRAIN.D;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const ang = a0 + (k * TAU) / 6;
      const px = cx + Math.cos(ang) * r * s * 0.98;
      const py = cy + Math.sin(ang) * r * s * 0.98;
      k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
    const tg = ctx.createLinearGradient(cx, cy - r * s, cx, cy + r * s);
    tg.addColorStop(0, a); tg.addColorStop(1, b);
    ctx.fillStyle = tg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (num) {
      ctx.fillStyle = '#f6ecd2';
      ctx.beginPath(); ctx.arc(cx, cy, r * s * 0.3, 0, TAU); ctx.fill();
      ctx.fillStyle = num === 6 || num === 8 ? '#c0392b' : '#1b2430';
      ctx.font = `700 ${Math.max(8, r * s * 0.34)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(num), cx, cy + 0.5);
    }
  }

  // What has been built so far. A city replaces the settlement under it.
  let robber = null;
  const cityAt = new Set();
  const shown = data.steps.slice(0, upTo);
  for (const st of shown) if (st[1] === 'c') cityAt.add(`${st[3]},${st[4]}`);
  const lastIdx = shown.length - 1;
  shown.forEach((st, i) => {
    const [, k, pi, x1, y1, x2, y2] = st;
    const col = colors[pi] || '#888';
    if (k === 'x') { robber = [x1, y1]; return; }
    if (k === 'r') {
      const [ax, ay] = at(x1, y1), [bx, by] = at(x2, y2);
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(8,16,26,.85)'; ctx.lineWidth = Math.max(4, s * 0.17);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(2.5, s * 0.11);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      return;
    }
    const key = `${x1},${y1}`;
    if (k === 's' && cityAt.has(key)) return; // the city standing on it replaces it
    const [px, py] = at(x1, y1);
    const u = Math.max(5, s * (k === 'c' ? 0.3 : 0.22));
    ctx.fillStyle = col; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (k === 'c') {
      ctx.rect(px - u, py - u * 0.55, u * 2, u * 1.1);
      ctx.moveTo(px - u, py - u * 0.55); ctx.lineTo(px - u * 0.4, py - u * 1.25); ctx.lineTo(px + u * 0.1, py - u * 0.55);
    } else {
      ctx.rect(px - u * 0.75, py - u * 0.2, u * 1.5, u * 0.95);
      ctx.moveTo(px - u * 0.95, py - u * 0.2); ctx.lineTo(px, py - u * 1.05); ctx.lineTo(px + u * 0.95, py - u * 0.2);
    }
    ctx.fill(); ctx.stroke();
    if (i === lastIdx) {
      // The newest piece pulses so the eye finds it.
      ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py - u * 0.3, u * (1.4 + 0.25 * Math.sin(now / 160)), 0, TAU); ctx.stroke();
    }
  });
  if (robber) {
    const [rx, ry] = at(robber[0], robber[1]);
    ctx.fillStyle = 'rgba(20,20,24,.85)'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(rx, ry + s * 0.25, s * 0.16, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(rx, ry + s * 0.02, s * 0.1, 0, TAU); ctx.fill(); ctx.stroke();
  }
}

/** Everyone's points against turn number, one line per player. */
export function drawGraph(ctx, w, h, data, colors, target) {
  const left = 26, right = 10, top = 10, bottom = 20;
  const pw = w - left - right, ph = h - top - bottom;
  const series = data.series;
  const maxN = Math.max(1, ...series.map((p) => p[0]));
  const maxVP = Math.max(target || 10, ...series.flatMap((p) => p[1]));
  const X = (n) => left + (n / maxN) * pw;
  const Y = (v) => top + ph - (v / maxVP) * ph;

  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.lineWidth = 1;
  const step = maxVP > 12 ? 4 : 2;
  for (let v = 0; v <= maxVP; v += step) {
    ctx.beginPath(); ctx.moveTo(left, Y(v)); ctx.lineTo(w - right, Y(v)); ctx.stroke();
    ctx.fillText(String(v), left - 5, Y(v));
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('turn', left + pw / 2, h - 13);
  ctx.fillText(String(maxN), X(maxN), h - 13);
  if (target) {
    ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(227,186,87,.7)';
    ctx.beginPath(); ctx.moveTo(left, Y(target)); ctx.lineTo(w - right, Y(target)); ctx.stroke();
    ctx.setLineDash([]);
  }

  const players = series[0] ? series[0][1].length : 0;
  for (let i = 0; i < players; i++) {
    ctx.strokeStyle = colors[i] || '#888'; ctx.lineWidth = 2.6; ctx.lineJoin = 'round';
    ctx.beginPath();
    // A step line: points only change at an event, so hold the old value up to it.
    let prev = null;
    series.forEach(([n, vp], k) => {
      const x = X(n), y = Y(vp[i]);
      if (k === 0) ctx.moveTo(x, y);
      else { ctx.lineTo(x, Y(prev)); ctx.lineTo(x, y); }
      prev = vp[i];
    });
    const lastN = series[series.length - 1][0];
    ctx.lineTo(X(lastN), Y(prev));
    ctx.stroke();
    ctx.fillStyle = colors[i] || '#888';
    ctx.beginPath(); ctx.arc(X(lastN), Y(prev), 3.2, 0, TAU); ctx.fill();
  }
}
