// Trade regressions.
// Run with:  node scripts/trade-tests.mjs   (npm test runs it)
//
// The one that matters here is the last: a move must not be editable after it is sent.
// That was a real bug, and a nasty shape of one — the trade appeared to happen, then was
// taken back half a second later with an error about a number the player never chose.

import { makeBoard } from '../public/board.js';
import * as R from '../public/rules.js';

let passed = 0;
const failures = [];
const check = (name, fn) => { try { fn(); passed += 1; } catch (e) { failures.push(`${name}: ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => assert(a === b, `${m} — expected ${b}, got ${a}`);

function table(res, seed = 5) {
  const g = R.newGame(['p0', 'p1'], { targetVP: 10, layout: 'classic', useRobber: true, turnSeconds: 0, seed });
  g.phase = 'build'; g.turn.rolled = true; g.turn.seat = 0;
  g.players.p0.res = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0, ...res };
  return { g, board: makeBoard(g.seed, g.mode, g.layout) };
}

check('a four-for-one bank trade at the default rate', () => {
  const { g, board } = table({ wheat: 7 });
  eq(R.tradeRate(g, board, 'p0', 'wheat'), 4, 'no port means 4:1');
  const r = R.applyMove(g, 'p0', { type: 'bankTrade', give: { wheat: 4 }, want: { ore: 1 } });
  assert(r.ok, `refused: ${r.error}`);
  eq(r.game.players.p0.res.wheat, 3, 'four wheat left the hand');
  eq(r.game.players.p0.res.ore, 1, 'one ore arrived');
});

check('a part-lot is refused, and says so', () => {
  const { g } = table({ wheat: 7 });
  const r = R.applyMove(g, 'p0', { type: 'bankTrade', give: { wheat: 3 }, want: { ore: 1 } });
  assert(!r.ok, 'three wheat at 4:1 should be refused');
  assert(/4:1/.test(r.error), `the error should name the rate, got: ${r.error}`);
});

check('two lots buy two cards, and one lot does not', () => {
  const { g } = table({ wheat: 8 });
  assert(R.applyMove(g, 'p0', { type: 'bankTrade', give: { wheat: 8 }, want: { ore: 2 } }).ok, 'eight for two');
  const bad = R.applyMove(g, 'p0', { type: 'bankTrade', give: { wheat: 4 }, want: { ore: 2 } });
  assert(!bad.ok, 'four wheat cannot buy two cards at 4:1');
});

check('a basket of two kinds settles as one move', () => {
  const { g } = table({ wheat: 4, sheep: 4 });
  const r = R.applyMove(g, 'p0', { type: 'bankTrade', give: { wheat: 4, sheep: 4 }, want: { ore: 2 } });
  assert(r.ok, `refused: ${r.error}`);
  eq(r.game.players.p0.res.ore, 2, 'two ore arrived');
  eq(r.game.players.p0.res.wheat, 0, 'wheat spent');
  eq(r.game.players.p0.res.sheep, 0, 'sheep spent');
});

check('you cannot ask for what you are handing over', () => {
  const { g } = table({ wheat: 8 });
  assert(!R.applyMove(g, 'p0', { type: 'bankTrade', give: { wheat: 4 }, want: { wheat: 1 } }).ok,
    'wheat for wheat should be refused');
});

check('a move cannot be edited after it has been made', () => {
  // The bug: the interface handed its live selection object to the move, and then the
  // optimistic redraw trimmed that selection against the hand the trade had just emptied.
  // Four wheat became three inside a move already on its way to the server.
  const { g } = table({ wheat: 7 });
  const selection = { wheat: 4 };
  const move = { type: 'bankTrade', give: { ...selection }, want: { ore: 1 } };

  const guess = R.applyMove(g, 'p0', move);
  assert(guess.ok, 'the local guess should be accepted');

  // Whatever the interface does to its own selection afterwards...
  const handAfter = guess.game.players.p0.res;
  for (const r of Object.keys(selection)) {
    if (selection[r] > (handAfter[r] || 0)) selection[r] = handAfter[r] || 0;
  }
  eq(selection.wheat, 3, 'the selection itself is trimmed, as it should be');

  // ...must not reach the move.
  eq(move.give.wheat, 4, 'the move still says four');
  const server = R.applyMove(g, 'p0', move);
  assert(server.ok, `the server should accept the same move: ${server.error}`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL  ' + f);
process.exit(failures.length ? 1 : 0);
