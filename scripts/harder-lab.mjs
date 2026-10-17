// Measures candidate settings for the "harder" bot against "hard".
//
//   node scripts/harder-lab.mjs '{"pipMult":1.5}' [games] [layout] [seats]
//
// The settings are merged over hard's and played against hard with seats alternating, so a
// first-player edge cancels. Reports harder's win share with a 95% interval; anything inside
// the interval around 50% is noise, not strength.

import { makeBoard } from '../public/board.js';
import * as R from '../public/rules.js';
import { botMove, LEVELS } from '../public/bot.js';

function rngFrom(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function whoActs(g) {
  if (g.phase === 'discard') { const k = Object.keys(g.pending.discard); if (k.length) return k[0]; }
  for (const t of g.trades || []) {
    const pend = g.seats.filter((s) => s !== t.from && !t.replies[s]);
    if (pend.length) return pend[0];
    return t.from;
  }
  return R.currentPid(g);
}

function playGame(levels, seed, layout) {
  const rng = rngFrom(seed);
  const seats = levels.map((_, i) => 'p' + i);
  let g = R.newGame(seats, { targetVP: 10, layout }, rng);
  const board = makeBoard(g.seed, g.mode, g.layout);
  let moves = 0;
  while (g.phase !== 'over' && moves < 12000) {
    const actor = whoActs(g);
    const mv = botMove(g, board, actor, levels[seats.indexOf(actor)], rng);
    const who = mv ? actor : R.currentPid(g);
    const res = R.applyMove(g, who, mv || { type: 'endTurn' }, rng);
    if (!res.ok) {
      const r = R.applyMove(g, R.currentPid(g), { type: 'endTurn' }, rng);
      if (!r.ok) return { winner: -1 };
      g = r.game; moves++; continue;
    }
    g = res.game; moves++;
  }
  return { winner: g.phase === 'over' ? seats.indexOf(g.winner) : -1 };
}

const overrides = JSON.parse(process.argv[2] || '{}');
const N = Number(process.argv[3] || 400);
const layout = process.argv[4] || 'classic';
const nSeats = Number(process.argv[5] || 2);
LEVELS.harder = { ...LEVELS.hard, ...overrides };

let wins = 0, played = 0;
for (let i = 0; i < N; i++) {
  // harder sits in a different seat each game; the rest are hard
  const pos = i % nSeats;
  const levels = Array.from({ length: nSeats }, (_, k) => (k === pos ? 'harder' : 'hard'));
  const r = playGame(levels, i * 104729 + 17, layout);
  if (r.winner < 0) continue;
  played++;
  if (r.winner === pos) wins++;
}
const share = wins / played;
const fair = 1 / nSeats;
const se = Math.sqrt(share * (1 - share) / played);
console.log(`${JSON.stringify(overrides)} ${layout} ${nSeats}p: harder wins ${(share * 100).toFixed(1)}% (fair ${(fair * 100).toFixed(0)}%) ±${(1.96 * se * 100).toFixed(1)}  n=${played}`);
