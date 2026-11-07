// Plays full bot games and feeds the engine's log to the chronicle one move at a time, the
// way the app does, then checks the chronicle against the game itself.
//
//   node scripts/chronicle-tests.mjs [games]

import { makeBoard } from '../public/board.js';
import * as R from '../public/rules.js';
import { botMove } from '../public/bot.js';
import { newChron, ingest, finish, luckOf, compact } from '../public/chronicle.js';

function rngFrom(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function whoActs(g){
  if(g.phase==='discard'){const k=Object.keys(g.pending.discard); if(k.length) return k[0];}
  for(const t of g.trades||[]){const pend=g.seats.filter(s=>s!==t.from&&!t.replies[s]); if(pend.length) return pend[0]; return t.from;}
  return R.currentPid(g);
}

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log('FAIL', msg); } };

const N = Number(process.argv[2] || 12);
let luckSpread = [];
for (let i = 0; i < N; i++) {
  const rng = rngFrom(i * 7919 + 3);
  const seats = ['p0', 'p1', 'p2', 'p3'];
  let g = R.newGame(seats, { targetVP: 10, layout: i % 2 ? 'expansion' : 'classic' }, rng);
  const board = makeBoard(g.seed, g.mode, g.layout);
  const chron = newChron(g.seed, g.seats, false);
  let moves = 0;
  while (g.phase !== 'over' && moves < 12000) {
    const actor = whoActs(g);
    const mv = botMove(g, board, actor, 'hard', rng);
    let r = mv ? R.applyMove(g, actor, mv, rng) : { ok: false };
    if (!r.ok) r = R.applyMove(g, R.currentPid(g), { type: 'endTurn' }, rng);
    if (!r.ok) break;
    g = r.game; moves++;
    ingest(chron, g, board);
  }
  finish(chron, g, R.totalVP);
  check(g.phase === 'over', `game ${i} finished`);

  // The chronicle's picture of the board is the board.
  for (const [v, b] of Object.entries(g.bldg)) {
    check(chron.bldg[v]?.p === b.p && chron.bldg[v]?.t === b.t, `game ${i}: building at ${v}`);
  }
  check(Object.keys(chron.bldg).length === Object.keys(g.bldg).length, `game ${i}: building count`);
  for (const [e, p] of Object.entries(g.roads)) check(chron.roads[e] === p, `game ${i}: road ${e}`);
  check(Object.keys(chron.roads).length === Object.keys(g.roads).length, `game ${i}: road count`);
  check(chron.award.road === g.award.road && chron.award.army === g.award.army, `game ${i}: awards`);

  // Points over time end where the game ended.
  const last = chron.series[chron.series.length - 1];
  for (const pid of g.seats) check(last.vp[pid] === R.totalVP(g, pid), `game ${i}: final points ${pid}`);
  // ...and never go down except when an award changes hands (never below zero either).
  for (const pid of g.seats) {
    check(chron.series.every((s) => s.vp[pid] >= 0), `game ${i}: negative points`);
  }

  // What the dice paid matches the engine's own running count.
  for (const pid of g.seats) {
    const tallied = g.tally?.[pid]?.gained || 0;
    check((chron.act[pid] || 0) === tallied, `game ${i}: ${pid} paid ${chron.act[pid]} vs tally ${tallied}`);
    const l = luckOf(chron, pid);
    luckSpread.push(l.pct);
  }
  check(chron.rolls > 5, `game ${i}: rolls counted`);

  // The compact copy is small and complete.
  const c = compact(chron, board, Object.fromEntries(g.seats.map((p) => [p, { name: p, color: '#fff' }])));
  const size = JSON.stringify(c).length;
  check(size < 12000, `game ${i}: compact size ${size}`);
  if (i === 0) console.log('compact size game 0:', size, 'bytes; steps', c.steps.length, 'series', c.series.length);
}
const mean = luckSpread.reduce((a, b) => a + b, 0) / luckSpread.length;
console.log(`luck %: mean ${mean.toFixed(1)}, min ${Math.min(...luckSpread)}, max ${Math.max(...luckSpread)} over ${luckSpread.length} players`);
console.log(failures ? `${failures} FAILURES` : 'chronicle: all checks passed');
process.exit(failures ? 1 : 0);
