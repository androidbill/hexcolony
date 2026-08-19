// Bot tournament: plays the difficulties against each other and reports the results.
//
//   node scripts/bot-tournament.mjs [gamesPerMatchup]
//
// This exists so "easy / medium / hard" is a measured claim rather than a label. Seats
// alternate every game so first-player advantage cancels out. It also doubles as the
// regression test for the rules engine and the bots together: any illegal move or any
// game that fails to finish is reported at the end.

import { makeBoard, RESOURCES } from '../public/board.js';
import * as R from '../public/rules.js';
import { botMove } from '../public/bot.js';

function rngFrom(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}

const stats={rejects:0,stalls:0,moves:0,rejectMsgs:{}};

function whoActs(g){
  if(g.phase==='discard'){const k=Object.keys(g.pending.discard); if(k.length) return k[0];}
  if(g.trade){
    const pend=g.seats.filter(s=>s!==g.trade.from&&!g.trade.replies[s]);
    if(pend.length) return pend[0];
    return g.trade.from;
  }
  return R.currentPid(g);
}

function playGame(levels, seed){
  const rng=rngFrom(seed);
  const seats=levels.map((_,i)=>'p'+i);
  let g=R.newGame(seats,{targetVP:10},rng);
  const board=makeBoard(g.seed,g.mode);
  let moves=0;
  while(g.phase!=='over'&&moves<12000){
    const actor=whoActs(g);
    const lvl=levels[seats.indexOf(actor)];
    let mv=botMove(g,board,actor,lvl,rng);
    if(!mv){
      // bot had nothing to say; end the current player's turn to keep things moving
      const r=R.applyMove(g,R.currentPid(g),{type:'endTurn'},rng);
      if(!r.ok){ stats.stalls++; break; }
      g=r.game; moves++; continue;
    }
    const res=R.applyMove(g,actor,mv,rng);
    if(!res.ok){
      stats.rejects++;
      stats.rejectMsgs[mv.type+': '+res.error]=(stats.rejectMsgs[mv.type+': '+res.error]||0)+1;
      const r=R.applyMove(g,R.currentPid(g),{type:'endTurn'},rng);
      if(!r.ok){ stats.stalls++; break; }
      g=r.game; moves++; continue;
    }
    g=res.game; moves++; stats.moves++;
  }
  if(g.phase!=='over') stats.stalls++;
  return {winner:g.winner?seats.indexOf(g.winner):-1, turns:g.turn.num, vp:seats.map(s=>R.totalVP(g,s))};
}

function duel(a,b,n){
  let wa=0,wb=0,draws=0,turns=0;
  for(let i=0;i<n;i++){
    // alternate seating so first-player advantage cancels out
    const levels = i%2===0 ? [a,b] : [b,a];
    const r=playGame(levels, i*104729+7);
    turns+=r.turns;
    if(r.winner<0){draws++;continue;}
    const who=levels[r.winner];
    if(who===a&&levels.indexOf(a)===r.winner) wa++; else wb++;
  }
  return {wa,wb,draws,avgTurns:Math.round(turns/n)};
}

const N=Number(process.argv[2]||120);
console.log(`bot-vs-bot, ${N} games per matchup (seats alternate each game)\n`);
for(const [a,b] of [['hard','easy'],['hard','medium'],['medium','easy']]){
  const t0=Date.now();
  const r=duel(a,b,N);
  const pct=(r.wa/(r.wa+r.wb||1)*100).toFixed(1);
  console.log(`${a.padEnd(6)} vs ${b.padEnd(6)}  ${String(r.wa).padStart(3)} - ${String(r.wb).padEnd(3)}  ${a} wins ${pct}%   avg ${r.avgTurns} turns   ${((Date.now()-t0)/1000).toFixed(1)}s`);
}

console.log('\nfour-player table (hard, medium, medium, easy):');
const tally=[0,0,0,0];
for(let i=0;i<N;i++){
  const r=playGame(['hard','medium','medium','easy'], i*7919+31);
  if(r.winner>=0) tally[r.winner]++;
}
console.log(`  hard=${tally[0]}  medium=${tally[1]}  medium=${tally[2]}  easy=${tally[3]}`);

console.log(`\nmoves=${stats.moves}  rejectedMoves=${stats.rejects}  stalls=${stats.stalls}`);
if(stats.rejects) console.log('reject reasons:', stats.rejectMsgs);
const ok = stats.rejects===0 && stats.stalls===0;
console.log(ok?'\nBOTS PRODUCE ONLY LEGAL MOVES AND EVERY GAME FINISHED':'\nPROBLEMS ABOVE');
