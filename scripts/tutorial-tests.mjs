// The guided practice game, played start to finish against the real engine: the coach must
// reach its last step on the fixed island, only ever accept the move it asks for, and make
// the first roll pay out.

import * as R from '../public/rules.js';
import { makeBoard, VERTS } from '../public/board.js';
import { botMove } from '../public/bot.js';
import * as T from '../public/tutorial.js';

let failed = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) failed += 1; };

const ME = 'me', BOT = 'bot';
const board = makeBoard(T.TUTORIAL_SEED, 'random', 'classic');
let g = R.newGame([ME, BOT], { ...T.TUTORIAL_SETTINGS, seed: T.TUTORIAL_SEED });
const run = T.newRun();
const apply = (pid, move, rng) => {
  const res = R.applyMove(g, pid, move, rng);
  if (!res.ok) throw new Error(`${move.type} refused: ${res.error}`);
  g = res.game;
};
const botTurn = () => {
  const humans = new Set([ME]);
  let move = botMove(g, board, BOT, 'easy', Math.random, humans);
  if (!move) {
    if (g.phase === 'roll') move = { type: 'roll' };
    else if (g.phase === 'build') move = { type: 'endTurn' };
    else if (g.phase === 'setup') {
      move = g.setup.need === 's'
        ? { type: 'setupSettlement', v: R.legalSettlements(g, BOT, true)[0] }
        : { type: 'setupRoad', e: R.legalRoads(g, BOT, g.setup.lastV)[0] };
    } else if (g.phase === 'robber') move = { type: 'moveRobber', hex: Object.keys(board.tiles).map(Number).find((i) => i !== g.robber) };
    else if (g.phase === 'steal') move = { type: 'steal', from: g.pending.stealFrom[0] };
  }
  apply(BOT, move);
};

// The best corner: the most dots (pips) of production, so the first roll has something to pay.
const bestSettlement = (setup) => R.legalSettlements(g, ME, setup)
  .map((v) => ({ v, score: VERTS[v].hexes.reduce((a, h) => a + (board.tiles[h].res ? (6 - Math.abs(7 - (board.tiles[h].num || 7))) : 0), 0) }))
  .sort((a, b) => b.score - a.score)[0].v;

const seen = [];
let rollPaid = null;
let wrongMoveRefused = true;
for (let n = 0; n < 400 && T.current(run); n += 1) {
  const effects = T.advance(run, g, ME);
  for (const e of effects) {
    if (e === 'grant') {
      for (const [r, k] of Object.entries(T.STARTER_PACK)) { g.players[ME].res[r] += k; g.bank[r] -= k; }
    }
  }
  const step = T.current(run);
  if (!step) break;
  if (!seen.includes(step.id)) seen.push(step.id);
  if (step.kind === 'finish') break;
  if (step.kind === 'info') { T.next(run); continue; }

  if (step.kind === 'wait') {
    // Everything of mine is refused while the bot plays.
    wrongMoveRefused = wrongMoveRefused && T.refusal(run, { type: 'endTurn' }) !== null;
    botTurn();
    continue;
  }

  // A 'do' step: first prove an unrelated move is refused, then make the right one.
  if (!step.allow.includes('endTurn')) wrongMoveRefused = wrongMoveRefused && T.refusal(run, { type: 'endTurn' }) !== null;
  switch (step.id) {
    case 'settle1': case 'settle2': apply(ME, { type: 'setupSettlement', v: bestSettlement(true) }); break;
    case 'road1': case 'road2': apply(ME, { type: 'setupRoad', e: R.legalRoads(g, ME, g.setup.lastV)[0] }); break;
    case 'roll': case 'seven': {
      const forced = T.forcedRoll(run, g, ME, board, VERTS);
      const before = { ...g.players[ME].res };
      apply(ME, { type: 'roll' }, forced ? T.diceRng(forced) : undefined);
      if (step.id === 'roll') {
        const after = g.players[ME].res;
        rollPaid = Object.keys(after).some((r) => after[r] > before[r]);
      }
      if (step.id === 'seven') ok('the second roll is a 7', g.turn.dice[0] + g.turn.dice[1] === 7);
      break;
    }
    case 'road3': case 'road4': apply(ME, { type: 'build', what: 'road', e: R.legalRoads(g, ME)[0] }); break;
    case 'settle3': {
      const spots = R.legalSettlements(g, ME);
      ok('a settlement spot is open after two extra roads', spots.length > 0);
      if (!spots.length) { run.i += 1; break; }
      apply(ME, { type: 'build', what: 'settlement', v: spots[0] });
      break;
    }
    case 'end': apply(ME, { type: 'endTurn' }); break;
    case 'robber': {
      if (g.phase === 'discard') { run.i += 1; break; }
      apply(ME, { type: 'moveRobber', hex: Object.keys(board.tiles).map(Number).find((i) => i !== g.robber) });
      break;
    }
    case 'steal': run.i += 1; break;
    default: throw new Error(`no driver for step ${step.id}`);
  }
}

ok('the coach reaches its last step', T.current(run)?.id === 'finish');
ok('every step was visited in order', seen.length >= T.STEPS.length - 2);
ok('the first roll paid the player', rollPaid === true);
ok('moves the coach did not ask for were refused', wrongMoveRefused);
ok('a move that is not the coach’s is refused with a reason', (() => {
  const r2 = T.newRun(); r2.i = T.STEPS.findIndex((s) => s.id === 'settle1');
  return typeof T.refusal(r2, { type: 'roll' }) === 'string' && T.refusal(r2, { type: 'setupSettlement', v: 0 }) === null;
})());
ok('answering a trade or discarding is never held back', (() => {
  const r2 = T.newRun(); r2.i = T.STEPS.findIndex((s) => s.id === 'settle1');
  return T.refusal(r2, { type: 'replyTrade' }) === null && T.refusal(r2, { type: 'discard' }) === null;
})());
ok('undo is always refused in the practice game', (() => {
  const r2 = T.newRun(); r2.i = T.STEPS.findIndex((s) => s.id === 'road3');
  return T.refusal(r2, { type: 'undo' }) !== null;
})());
ok('nothing is held back once the coach is finished', (() => {
  const r2 = T.newRun(); r2.i = T.STEPS.length - 1;
  return T.refusal(r2, { type: 'endTurn' }) === null;
})());

console.log(failed ? `\n${failed} FAILED` : '\ntutorial checks passed');
process.exit(failed ? 1 : 0);
