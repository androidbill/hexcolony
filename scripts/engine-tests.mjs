// Engine tests for HexColony.
//
// The rules engine is pure — no DOM, no network, no clock — which is the whole reason it
// can be driven from here. A game takes four people and half an hour to play; these run
// thousands of them in a few seconds.
//
//   node scripts/engine-tests.mjs
//
// Two halves: targeted checks for the awkward cases, and a soak that plays complete
// games with the real bots while asserting the invariants that must never break.

import { makeBoard, RESOURCES, HEXES, VERTS, EDGES, LAYOUT_INFO } from '../public/board.js';
import * as R from '../public/rules.js';
import { botMove } from '../public/bot.js';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const eq = (a, b, msg) => assert(a === b, `${msg} — expected ${b}, got ${a}`);

// A deterministic stream, so a failure can be reproduced exactly.
function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEATS = ['p1', 'p2', 'p3', 'p4'];
const newG = (over = {}) => R.newGame(SEATS, { seed: 12345, layout: 'classic', ...over }, rngFrom(7));

/** Drive the whole opening with nothing but expired clocks. */
function autoSetup(g, rng = rngFrom(99)) {
  let guard = 0;
  while (g.phase === 'setup') {
    const res = R.applyMove(g, 'p3', { type: 'timeout' }, rng);   // any seated player
    assert(res.ok, `timeout refused during setup: ${res.error}`);
    g = res.game;
    assert(guard++ < 40, 'setup did not finish');
  }
  return g;
}

// ---------------------------------------------------------------- the opening clock

check('setup starts on the clock', () => {
  const g = newG({ turnSeconds: 0 });
  eq(g.phase, 'setup', 'phase');
  eq(g.turn.allowMs, R.SETUP_SECONDS * 1000, 'opening allowance');
  assert(g.turn.clockRestart, 'the opening allowance needs a start stamp');
});

check('the setup clock restarts on every placement', () => {
  let g = newG({ turnSeconds: 0 });
  const first = R.currentPid(g);
  const v = R.legalSettlements(g, first, true)[0];
  g = R.applyMove(g, first, { type: 'setupSettlement', v }).game;
  eq(g.turn.allowMs, R.SETUP_SECONDS * 1000, 'allowance after the settlement');
  assert(g.turn.clockRestart, 'restart flag after the settlement');

  const e = R.legalRoads(g, first, g.setup.lastV)[0];
  g = R.applyMove(g, first, { type: 'setupRoad', e }).game;
  eq(g.turn.allowMs, R.SETUP_SECONDS * 1000, 'allowance for the next player');
});

check('an untimed game is untimed once play starts', () => {
  const g = autoSetup(newG({ turnSeconds: 0 }));
  eq(g.phase, 'roll', 'phase after setup');
  eq(g.turn.allowMs, 0, 'no allowance in an untimed game');
});

check('a timed game keeps its allowance after setup', () => {
  const g = autoSetup(newG({ turnSeconds: 30 }));
  eq(g.turn.allowMs, R.ROLL_SECONDS * 1000, 'roll allowance');
});

// ---------------------------------------------------------------- running out of time

check('a whole opening can be played by the clock alone', () => {
  const g = autoSetup(newG());
  eq(g.phase, 'roll', 'phase');
  // Two settlements and two roads each, and everybody paid for the second settlement.
  for (const pid of SEATS) {
    const p = g.players[pid];
    eq(p.left.settlement, R.PIECES.settlement - 2, `${pid} settlements placed`);
    eq(p.left.road, R.PIECES.road - 2, `${pid} roads placed`);
    assert(R.handSize(p) > 0, `${pid} should have been paid for the second settlement`);
  }
});

check('anyone at the table may push a stalled turn along', () => {
  const g = autoSetup(newG({ turnSeconds: 15 }));
  const up = R.currentPid(g);
  const other = SEATS.find((s) => s !== up);
  const res = R.applyMove(g, other, { type: 'timeout' }, rngFrom(3));
  assert(res.ok, `a bystander could not force the roll: ${res.error}`);
  assert(res.game.turn.rolled, 'the dice should have been rolled');
  // Credited to the player who owed it, not to the one who reported the stall.
  const roll = res.events.find((e) => e.t === 'roll');
  eq(roll.p, up, 'the roll belongs to');
});

check('a stranger cannot force anything', () => {
  const g = autoSetup(newG());
  const res = R.applyMove(g, 'nobody', { type: 'timeout' });
  assert(!res.ok, 'a player who is not seated forced a move');
});

check('every blocked step has a way out', () => {
  // Walk a real game and force every phase the engine can stop in.
  const seen = new Set();
  let g = autoSetup(newG({ turnSeconds: 15, discardLimit: 7 }));
  const rng = rngFrom(2024);
  for (let i = 0; i < 4000 && g.phase !== 'over'; i++) {
    seen.add(g.phase);
    const res = R.applyMove(g, 'p1', { type: 'timeout' }, rng);
    assert(res.ok, `nothing could be forced in phase ${g.phase}: ${res.error}`);
    g = res.game;
  }
  for (const phase of ['roll', 'build']) assert(seen.has(phase), `never reached ${phase}`);
});

check('a forced discard clears the whole seven', () => {
  let g = autoSetup(newG({ discardLimit: 7, turnSeconds: 15 }));
  // Hand everyone enough to owe a discard, then roll a seven.
  for (const pid of SEATS) for (const r of RESOURCES) g.players[pid].res[r] = 3;
  g.phase = 'roll';
  const seven = () => 0.5;   // 1 + floor(0.5*6) = 4 each, so 8 — force it by hand instead
  g.turn.rolled = false;
  const rolled = R.applyMove(g, R.currentPid(g), { type: 'roll' }, seven);
  g = rolled.game;
  if (g.phase !== 'discard') {
    // The dice are the dice; set the state up directly rather than fishing for a seven.
    g.phase = 'discard';
    g.pending.discard = Object.fromEntries(SEATS.map((s) => [s, Math.floor(R.handSize(g.players[s]) / 2)]));
  }
  let guard = 0;
  while (g.phase === 'discard') {
    const res = R.applyMove(g, 'p2', { type: 'timeout' }, rngFrom(1));
    assert(res.ok, `forced discard refused: ${res.error}`);
    g = res.game;
    assert(guard++ < 10, 'the discards never cleared');
  }
  eq(Object.keys(g.pending.discard).length, 0, 'discards left owing');
});

// ---------------------------------------------------------------- nobody to choose from

/**
 * A game past setup with the robber switched off, ready for a raid.
 *
 * `victims` is how many OTHER players are left holding cards — which is what decides
 * whether there is a choice to make. Nobody is given cards by seat name, because the
 * seat order is shuffled and a test that assumed p1 was on the clock would pass or fail
 * on the shuffle rather than on the rule.
 */
function raidState(ids, victims) {
  let g = R.newGame(ids, { seed: 4242, layout: 'classic', useRobber: false }, rngFrom(5));
  let guard = 0;
  while (g.phase === 'setup') {
    g = R.applyMove(g, ids[0], { type: 'timeout' }, rngFrom(guard + 1)).game;
    if (guard++ > 40) throw new Error('setup did not finish');
  }
  for (const pid of ids) for (const r of RESOURCES) g.players[pid].res[r] = 0;
  const me = R.currentPid(g);
  const others = ids.filter((s) => s !== me);
  for (const pid of others.slice(0, victims)) g.players[pid].res.wood = 3;

  g.phase = 'build';
  g.turn.rolled = true;
  g.players[me].dev.knight = 1;          // a knight is a raid, with the robber off
  return { g, me, others };
}

const raid = (g, me, seed) => R.applyMove(g, me, { type: 'playDev', card: 'knight' }, rngFrom(seed));

check('a two-player raid does not ask who', () => {
  const { g, me, others } = raidState(['p1', 'p2'], 1);
  const them = others[0];
  const before = R.handSize(g.players[them]);

  const done = raid(g, me, 11);
  assert(done.ok, `knight refused: ${done.error}`);
  assert(done.game.phase !== 'take', 'still asked who to take from with one candidate');
  eq(R.handSize(done.game.players[them]), before - 1, 'their hand after the raid');
  eq(R.handSize(done.game.players[me]), 1, 'my hand after the raid');
  eq(done.game.pending.stealFrom.length, 0, 'a target list was left behind');
});

check('a raid with two possible victims still asks', () => {
  const { g, me } = raidState(['p1', 'p2', 'p3'], 2);
  const done = raid(g, me, 12);
  assert(done.ok, `knight refused: ${done.error}`);
  eq(done.game.phase, 'take', 'phase with two candidates');
  eq(done.game.pending.stealFrom.length, 2, 'candidates offered');
  eq(R.handSize(done.game.players[me]), 0, 'took a card before being asked who from');
});

check('a raid with nobody holding cards just moves on', () => {
  const { g, me } = raidState(['p1', 'p2'], 0);
  const done = raid(g, me, 13);
  assert(done.ok, `knight refused: ${done.error}`);
  assert(done.game.phase !== 'take', 'asked who to raid when nobody had anything');
  eq(done.game.phase, 'build', 'phase when there was nobody to raid');
});

check('the robber still takes the only victim without asking', () => {
  const ids = ['p1', 'p2'];
  let g = R.newGame(ids, { seed: 909, layout: 'classic', useRobber: true }, rngFrom(6));
  let guard = 0;
  while (g.phase === 'setup') {
    g = R.applyMove(g, ids[0], { type: 'timeout' }, rngFrom(guard + 20)).game;
    if (guard++ > 40) throw new Error('setup did not finish');
  }
  const me = R.currentPid(g);
  const them = ids.find((s) => s !== me);
  for (const r of RESOURCES) { g.players[me].res[r] = 0; g.players[them].res[r] = 0; }
  g.players[them].res.ore = 2;
  g.phase = 'robber';
  g.turn.rolled = true;

  // A tile the other player is standing on, and this one is not.
  const target = HEXES.find((h) => h.i !== g.robber
    && h.corners.some((v) => g.bldg[v]?.p === them)
    && !h.corners.some((v) => g.bldg[v]?.p === me));
  if (!target) return;                            // this board did not produce one
  const done = R.applyMove(g, me, { type: 'moveRobber', hex: target.i }, rngFrom(14));
  assert(done.ok, `moveRobber refused: ${done.error}`);
  eq(done.game.phase, 'build', 'phase after robbing the only victim');
  eq(R.handSize(done.game.players[me]), 1, 'stolen card');
});

// ---------------------------------------------------------------- hostile input

check('a negative trade offer cannot pull cards out of a hand', () => {
  let g = autoSetup(newG());
  g.phase = 'build';
  g.turn.rolled = true;
  const me = R.currentPid(g);
  const them = SEATS.find((s) => s !== me);
  g.players[me].res.wood = 0;
  g.players[them].res.wood = 5;
  const res = R.applyMove(g, me, { type: 'offerTrade', give: { wood: -3 }, want: { brick: 1 } });
  assert(!res.ok, 'a negative offer was accepted');
});

check('fractional cards are refused', () => {
  let g = autoSetup(newG());
  g.phase = 'build';
  g.turn.rolled = true;
  const me = R.currentPid(g);
  g.players[me].res.wood = 2;
  assert(!R.applyMove(g, me, { type: 'offerTrade', give: { wood: 0.5 }, want: { ore: 1 } }).ok,
    'a fractional offer was accepted');

  g.phase = 'discard';
  g.pending.discard[me] = 2;
  g.players[me].res.wood = 4;
  assert(!R.applyMove(g, me, { type: 'discard', res: { wood: 1.5, brick: 0.5 } }).ok,
    'a fractional discard was accepted');
});

check('unknown resources are refused', () => {
  let g = autoSetup(newG());
  g.phase = 'build';
  g.turn.rolled = true;
  const me = R.currentPid(g);
  g.players[me].res.wood = 5;
  assert(!R.applyMove(g, me, { type: 'offerTrade', give: { gold: 1 }, want: { ore: 1 } }).ok,
    'an offer of gold was accepted');
});

// ---------------------------------------------------------------- several offers at once

/** A game in the build phase with a known hand, ready to make offers. */
function tradeState(hand = { wood: 2, brick: 2, sheep: 2, wheat: 2, ore: 2 }) {
  let g = autoSetup(newG());
  g.phase = 'build';
  g.turn.rolled = true;
  for (const pid of SEATS) {
    for (const r of RESOURCES) g.players[pid].res[r] = hand[r] || 0;
  }
  return { g, me: R.currentPid(g) };
}

check('two offers can be on the table at once', () => {
  let { g, me } = tradeState();
  g = R.applyMove(g, me, { type: 'offerTrade', give: { sheep: 1 }, want: { brick: 1 } }).game;
  const second = R.applyMove(g, me, { type: 'offerTrade', give: { ore: 1 }, want: { wood: 1 } });
  assert(second.ok, `second offer refused: ${second.error}`);
  g = second.game;
  eq(g.trades.length, 2, 'offers on the table');
  assert(g.trades[0].id !== g.trades[1].id, 'the two offers share an id');
});

check('closing one offer leaves the others up', () => {
  let { g, me } = tradeState();
  const them = SEATS.find((s) => s !== me);
  g = R.applyMove(g, me, { type: 'offerTrade', give: { sheep: 1 }, want: { brick: 1 } }).game;
  g = R.applyMove(g, me, { type: 'offerTrade', give: { ore: 1 }, want: { wood: 1 } }).game;
  const [a, b] = g.trades;

  g = R.applyMove(g, them, { type: 'replyTrade', id: a.id, yes: true }).game;
  const done = R.applyMove(g, me, { type: 'acceptTrade', id: a.id, with: them });
  assert(done.ok, `accept refused: ${done.error}`);
  g = done.game;

  eq(g.trades.length, 1, 'offers left');
  eq(g.trades[0].id, b.id, 'the wrong offer survived');
  eq(g.players[me].res.sheep, 1, 'my sheep after the swap');
  eq(g.players[me].res.brick, 3, 'my brick after the swap');
  eq(g.players[them].res.sheep, 3, 'their sheep after the swap');
});

check('the same card may be promised twice, but only spent once', () => {
  let { g, me } = tradeState({ sheep: 1, wood: 4 });
  const [them, other] = SEATS.filter((s) => s !== me);
  // One sheep, offered to the table twice. Both offers are legal to make.
  g = R.applyMove(g, me, { type: 'offerTrade', give: { sheep: 1 }, want: { wood: 1 } }).game;
  const twice = R.applyMove(g, me, { type: 'offerTrade', give: { sheep: 1 }, want: { wood: 2 } });
  assert(twice.ok, 'could not offer the same card to two people');
  g = twice.game;
  const [a, b] = g.trades;

  g = R.applyMove(g, them, { type: 'replyTrade', id: a.id, yes: true }).game;
  g = R.applyMove(g, other, { type: 'replyTrade', id: b.id, yes: true }).game;
  g = R.applyMove(g, me, { type: 'acceptTrade', id: a.id, with: them }).game;
  eq(g.players[me].res.sheep, 0, 'sheep after the first deal');

  // The second cannot close: the sheep is gone.
  const second = R.applyMove(g, me, { type: 'acceptTrade', id: b.id, with: other });
  assert(!second.ok, 'the same sheep was traded away twice');
});

check('offers are capped', () => {
  let { g, me } = tradeState({ wood: 9 });
  for (let i = 0; i < R.MAX_OFFERS; i++) {
    const res = R.applyMove(g, me, { type: 'offerTrade', give: { wood: 1 }, want: { ore: 1 } });
    assert(res.ok, `offer ${i + 1} refused: ${res.error}`);
    g = res.game;
  }
  assert(!R.applyMove(g, me, { type: 'offerTrade', give: { wood: 1 }, want: { ore: 1 } }).ok,
    `a ${R.MAX_OFFERS + 1}th offer was accepted`);
});

check('withdrawing takes one offer or all of them', () => {
  let { g, me } = tradeState();
  g = R.applyMove(g, me, { type: 'offerTrade', give: { sheep: 1 }, want: { brick: 1 } }).game;
  g = R.applyMove(g, me, { type: 'offerTrade', give: { ore: 1 }, want: { wood: 1 } }).game;
  const first = g.trades[0].id;

  const one = R.applyMove(g, me, { type: 'cancelTrade', id: first });
  assert(one.ok, `single withdraw refused: ${one.error}`);
  eq(one.game.trades.length, 1, 'after withdrawing one');

  const all = R.applyMove(g, me, { type: 'cancelTrade' });
  assert(all.ok, `withdraw-all refused: ${all.error}`);
  eq(all.game.trades.length, 0, 'after withdrawing all');
});

check('only the offerer can withdraw or close', () => {
  let { g, me } = tradeState();
  const them = SEATS.find((s) => s !== me);
  g = R.applyMove(g, me, { type: 'offerTrade', give: { sheep: 1 }, want: { brick: 1 } }).game;
  const id = g.trades[0].id;
  assert(!R.applyMove(g, them, { type: 'cancelTrade', id }).ok, 'someone else withdrew my offer');
  g = R.applyMove(g, them, { type: 'replyTrade', id, yes: true }).game;
  assert(!R.applyMove(g, them, { type: 'acceptTrade', id, with: me }).ok, 'the replier closed the deal');
});

check('ending the turn clears the table', () => {
  let { g, me } = tradeState();
  g = R.applyMove(g, me, { type: 'offerTrade', give: { sheep: 1 }, want: { brick: 1 } }).game;
  g = R.applyMove(g, me, { type: 'offerTrade', give: { ore: 1 }, want: { wood: 1 } }).game;
  const done = R.applyMove(g, me, { type: 'endTurn' });
  assert(done.ok, `endTurn refused: ${done.error}`);
  eq(done.game.trades.length, 0, 'offers left after the turn ended');
});

check('a player leaving takes their offers and replies with them', () => {
  let { g, me } = tradeState();
  const [them, other] = SEATS.filter((s) => s !== me);
  g = R.applyMove(g, me, { type: 'offerTrade', give: { sheep: 1 }, want: { brick: 1 } }).game;
  const id = g.trades[0].id;
  g = R.applyMove(g, other, { type: 'replyTrade', id, yes: false }).game;

  const gone = R.applyMove(g, me, { type: 'dropPlayer', who: other });
  assert(gone.ok, `dropPlayer refused: ${gone.error}`);
  assert(!(other in gone.game.trades[0].replies), 'a departed player left a reply behind');

  const hostLeft = R.applyMove(g, me, { type: 'dropPlayer', who: me });
  assert(hostLeft.ok, `dropPlayer refused: ${hostLeft.error}`);
  eq(hostLeft.game.trades.length, 0, 'the offers of the player who left');
});

check('an offer nobody can pay for cannot be accepted', () => {
  let { g, me } = tradeState({ sheep: 2 });      // nobody holds any brick
  const them = SEATS.find((s) => s !== me);
  g = R.applyMove(g, me, { type: 'offerTrade', give: { sheep: 1 }, want: { brick: 1 } }).game;
  const id = g.trades[0].id;
  assert(!R.applyMove(g, them, { type: 'replyTrade', id, yes: true }).ok,
    'accepted an offer they could not pay for');
  assert(R.applyMove(g, them, { type: 'replyTrade', id, yes: false }).ok, 'could not decline');
});

// ---------------------------------------------------------------- leaving

check('leaving mid-setup does not skip the players behind you', () => {
  let g = newG();
  // Get a few placements in, then drop the player who is about to go again.
  for (let i = 0; i < 5 && g.phase === 'setup'; i++) {
    g = R.applyMove(g, R.currentPid(g), { type: 'timeout' }, rngFrom(i + 1)).game;
  }
  const gone = g.seats[1];
  const before = g.seats.filter((s) => s !== gone);
  const res = R.applyMove(g, 'p1', { type: 'dropPlayer', who: gone });
  assert(res.ok, `dropPlayer refused: ${res.error}`);
  g = res.game;
  assert(!g.seats.includes(gone), 'the departed player is still seated');

  let guard = 0;
  while (g.phase === 'setup') {
    const step = R.applyMove(g, g.seats[0], { type: 'timeout' }, rngFrom(guard + 50));
    assert(step.ok, `setup stalled after a player left: ${step.error}`);
    g = step.game;
    assert(guard++ < 40, 'setup never finished after a player left');
  }
  // Everyone still in should have placed two settlements — nobody skipped, nobody twice.
  for (const pid of before) {
    eq(g.players[pid].left.settlement, R.PIECES.settlement - 2, `${pid} settlements`);
  }
});

check('leaving during a discard does not park a no-robber game', () => {
  let g = autoSetup(newG({ useRobber: false }));
  g.phase = 'discard';
  g.turn.rolled = true;
  g.pending.discard = { [g.seats[1]]: 2 };
  for (const r of RESOURCES) g.players[g.seats[1]].res[r] = 2;
  const res = R.applyMove(g, g.seats[0], { type: 'dropPlayer', who: g.seats[1] });
  assert(res.ok, `dropPlayer refused: ${res.error}`);
  assert(res.game.phase !== 'robber', 'parked in the robber phase with no robber in play');
});

check('a departed player is no longer paid', () => {
  let g = autoSetup(newG());
  const gone = g.seats[1];
  const board = makeBoard(g.seed, g.mode, g.layout);
  g = R.applyMove(g, g.seats[0], { type: 'dropPlayer', who: gone }).game;
  const before = R.handSize(g.players[gone]);
  // Roll every number and confirm the empty seat never gains.
  for (let n = 2; n <= 12; n++) {
    if (n === 7) continue;
    g.phase = 'roll';
    g.turn.rolled = false;
    const d = Math.min(6, n - 1);
    let k = 0;
    const dice = () => (k++ % 2 === 0 ? (d - 1) / 6 + 1e-9 : (n - d - 1) / 6 + 1e-9);
    const res = R.applyMove(g, R.currentPid(g), { type: 'roll' }, dice);
    if (res.ok) g = res.game;
  }
  eq(R.handSize(g.players[gone]), before, 'an empty seat was paid');
});

// ---------------------------------------------------------------- the soak

function conserved(g, board) {
  // Every resource card is in exactly one place: the bank or a hand.
  for (const r of RESOURCES) {
    let total = g.bank[r];
    for (const pid of Object.keys(g.players)) total += g.players[pid].res[r];
    assert(total === board.info.bank, `${r}: ${total} cards in play, should be ${board.info.bank}`);
  }
  for (const pid of Object.keys(g.players)) {
    const p = g.players[pid];
    for (const r of RESOURCES) {
      assert(Number.isInteger(p.res[r]), `${pid} holds a fractional ${r}: ${p.res[r]}`);
      assert(p.res[r] >= 0, `${pid} holds ${p.res[r]} ${r}`);
    }
    assert(p.left.road >= 0 && p.left.settlement >= 0 && p.left.city >= 0, `${pid} oversupplied`);
  }
  // Nobody built where the distance rule forbids it.
  for (const v of Object.keys(g.bldg)) {
    for (const n of VERTS[v].adj) {
      assert(!g.bldg[n], `buildings touching at ${v} and ${n}`);
    }
  }
}

function soak(games, layout, seats, opts) {
  let finished = 0, forced = 0, moves = 0;
  for (let n = 0; n < games; n++) {
    const rng = rngFrom(1000 + n);
    const ids = seats.map((_, i) => `p${i + 1}`);
    let g = R.newGame(ids, { seed: 5000 + n, layout, ...opts }, rng);
    const board = makeBoard(g.seed, g.mode, g.layout);
    for (let i = 0; i < 6000 && g.phase !== 'over'; i++) {
      const actor = g.phase === 'discard'
        ? Object.keys(g.pending.discard)[0]
        : (g.trade && !g.trade.replies[ids.find((s) => s !== g.trade.from)]
            ? ids.find((s) => s !== g.trade.from && !g.trade.replies[s])
            : R.currentPid(g));
      let move = null;
      try { move = botMove(g, board, actor, 'medium', rng); } catch { /* falls through */ }
      let res = move ? R.applyMove(g, actor, move, rng) : { ok: false };
      if (!res.ok) {
        // Whatever the bot wanted, the clock always has an answer.
        res = R.applyMove(g, ids[0], { type: 'timeout' }, rng);
        forced += 1;
        assert(res.ok, `nothing legal in phase ${g.phase}: ${res.error}`);
      }
      g = res.game;
      moves += 1;
      conserved(g, board);
    }
    if (g.phase === 'over') finished += 1;
  }
  return { finished, forced, moves };
}

check('classic, four players, robber on', () => {
  const r = soak(12, 'classic', [0, 1, 2, 3], { turnSeconds: 30, useRobber: true });
  assert(r.finished >= 10, `only ${r.finished}/12 games reached a winner`);
});

check('expansion, six players, robber off', () => {
  const r = soak(6, 'expansion', [0, 1, 2, 3, 4, 5], { turnSeconds: 0, useRobber: false });
  assert(r.finished >= 4, `only ${r.finished}/6 games reached a winner`);
});

// ---------------------------------------------------------------- board sanity

check('both islands are the shape they claim to be', () => {
  for (const [name, info] of Object.entries(LAYOUT_INFO)) {
    const b = makeBoard(4242, 'random', name);
    eq(b.tiles.length, info.tiles, `${name} tile count`);
    eq(b.ports.length, info.ports, `${name} port count`);
    const numbered = b.tiles.filter((t) => t.num).length;
    const deserts = b.tiles.filter((t) => t.terrain === 'desert').length;
    eq(numbered + deserts, info.tiles, `${name} tokens plus deserts`);
  }
});

check('the same seed always gives the same island', () => {
  const a = makeBoard(777, 'random', 'classic');
  const b = makeBoard(777, 'random', 'classic');
  eq(JSON.stringify(a.tiles), JSON.stringify(b.tiles), 'tiles differ between builds');
  const c = makeBoard(778, 'random', 'classic');
  assert(JSON.stringify(a.tiles) !== JSON.stringify(c.tiles), 'two seeds gave one island');
});

check('caching a board does not leave the wrong island loaded', () => {
  makeBoard(1, 'random', 'expansion');
  makeBoard(1, 'random', 'classic');
  // Warm hits have to re-point the shared topology, not just hand the object back.
  makeBoard(1, 'random', 'expansion');
  eq(HEXES.length, LAYOUT_INFO.expansion.tiles, 'active topology after a cached build');
  makeBoard(1, 'random', 'classic');
  eq(HEXES.length, LAYOUT_INFO.classic.tiles, 'active topology after a cached build');
});

// ---------------------------------------------------------------- report

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL  ' + f);
process.exit(failures.length ? 1 : 0);
