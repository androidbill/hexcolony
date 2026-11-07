// Bot games with random events and secret objectives on: the game must still finish, the
// supply of every resource must be conserved, and the new features must actually fire.
import { makeBoard, RESOURCES } from '../public/board.js';
import * as R from '../public/rules.js';
import { botMove } from '../public/bot.js';

function rngFrom(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function whoActs(g){
  if(g.phase==='discard'){const k=Object.keys(g.pending.discard); if(k.length) return k[0];}
  for(const t of g.trades||[]){const pend=g.seats.filter(s=>s!==t.from&&!t.replies[s]); if(pend.length) return pend[0]; return t.from;}
  return R.currentPid(g);
}
let fails = 0; const check = (ok, m) => { if (!ok) { fails++; console.log('FAIL', m); } };
const N = Number(process.argv[2] || 10);
const kinds = {}; let goalsDone = 0, goalsDealt = 0, finished = 0;
for (let i = 0; i < N; i++) {
  const rng = rngFrom(i * 104729 + 11);
  const seats = ['p0','p1','p2','p3'];
  let g = R.newGame(seats, { targetVP: 10, layout: i % 2 ? 'expansion' : 'classic', events: true, goals: true }, rng);
  const board = makeBoard(g.seed, g.mode, g.layout);
  const total0 = Object.fromEntries(RESOURCES.map(r => [r, g.bank[r]]));
  check(seats.every(p => g.players[p].goal), `game ${i}: goals dealt`);
  goalsDealt += seats.length;
  let moves = 0;
  while (g.phase !== 'over' && moves < 12000) {
    const actor = whoActs(g);
    const mv = botMove(g, board, actor, 'hard', rng);
    let r = mv ? R.applyMove(g, actor, mv, rng) : { ok: false };
    if (!r.ok) r = R.applyMove(g, R.currentPid(g), { type: 'endTurn' }, rng);
    if (!r.ok) break;
    g = r.game; moves++;
    for (const e of r.events || []) if (e.t === 'event') kinds[e.kind] = (kinds[e.kind] || 0) + 1;
    for (const res of RESOURCES) {
      const sum = g.bank[res] + seats.reduce((n, p) => n + g.players[p].res[res], 0);
      if (sum !== total0[res]) { check(false, `game ${i}: ${res} supply ${sum} vs ${total0[res]} at move ${moves}`); break; }
    }
  }
  if (g.phase === 'over') finished++;
  check(g.phase === 'over', `game ${i}: finished`);
  for (const p of seats) {
    const pl = g.players[p];
    if (pl.goalDone) goalsDone++;
    check(R.totalVP(g, p) === R.publicVP(g, p) + (pl.dev.vp||0) + (pl.devNew.vp||0) + (pl.goalDone ? 1 : 0), `game ${i}: vp ${p}`);
  }
}
console.log('events seen:', JSON.stringify(kinds), `| goals done ${goalsDone}/${goalsDealt} | finished ${finished}/${N}`);
check(Object.keys(kinds).length >= 3, 'at least three kinds of event occurred');
check(goalsDone > 0, 'some goals were completed');
console.log(fails ? `${fails} FAILURES` : 'events: all checks passed');
process.exit(fails ? 1 : 0);
