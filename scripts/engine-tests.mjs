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

import { makeBoard, RESOURCES, HEXES, VERTS, EDGES, LAYOUT_INFO, layoutInfo,
  useLayout, TOPO, DYNAMIC_MIN, DYNAMIC_MAX, isRed, hexNeighbours } from '../public/board.js';
import * as R from '../public/rules.js';
import { botMove } from '../public/bot.js';
import { APP_VERSION } from '../public/version.js';
import { readFileSync } from 'node:fs';

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

// ---------------------------------------------------------------- the discard clock

/**
 * Dice that always come up seven.
 *
 * applyMove takes each die as 1 + floor(rng() * 6), so 0.4 is a three and 0.55 is a four.
 * Worth spelling out: the first attempt at this used two values that made ten, and every
 * test below then quietly checked the wrong branch of the roll.
 */
const sevens = () => { let k = 0; return () => (k++ % 2 === 0 ? 0.4 : 0.55); };

/** A game at the roll, with everybody holding enough to owe a discard. */
function sevenState(opts = {}) {
  let g = autoSetup(newG(opts));
  for (const pid of SEATS) for (const r of RESOURCES) g.players[pid].res[r] = 3;
  g.phase = 'roll';
  g.turn.rolled = false;
  return { g, me: R.currentPid(g) };
}

check('a seven starts the discard clock, not the turn clock', () => {
  const { g, me } = sevenState({ turnSeconds: 15, discardSeconds: 45 });
  const res = R.applyMove(g, me, { type: 'roll' }, sevens());
  assert(res.ok, `roll refused: ${res.error}`);
  eq(res.game.phase, 'discard', 'phase after a seven');
  eq(res.game.turn.allowMs, 45000, 'the allowance while discarding');
  assert(res.game.turn.clockRestart, 'the discard clock needs its own start stamp');
});

check('the discard clock runs even with the turn timer off', () => {
  // A discard blocks the whole table, so it is timed whatever the game is set to —
  // the same call as the opening placement.
  const { g, me } = sevenState({ turnSeconds: 0, discardSeconds: 30 });
  const res = R.applyMove(g, me, { type: 'roll' }, sevens());
  assert(res.ok, `roll refused: ${res.error}`);
  eq(res.game.phase, 'discard', 'phase');
  eq(res.game.turn.allowMs, 30000, 'allowance in an untimed game');
});

check('the turn gets a whole allowance back once the discards are done', () => {
  const { g, me } = sevenState({ turnSeconds: 30, discardSeconds: 60 });
  let after = R.applyMove(g, me, { type: 'roll' }, sevens()).game;
  eq(after.turn.allowMs, 60000, 'discarding');

  let guard = 0;
  while (after.phase === 'discard') {
    const step = R.applyMove(after, SEATS[0], { type: 'timeout' }, rngFrom(guard + 1));
    assert(step.ok, `forced discard refused: ${step.error}`);
    after = step.game;
    assert(guard++ < 10, 'the discards never cleared');
  }
  // The roller was only ever waiting, so none of that time was theirs to lose.
  eq(after.phase, 'robber', 'phase once everybody has discarded');
  eq(after.turn.allowMs, 30000, 'the turn allowance afterwards');
});

check('the discard length is a choice, and a bad one is ignored', () => {
  for (const secs of R.DISCARD_OPTIONS) {
    const g = R.newGame(SEATS, { seed: 1, layout: 'classic', discardSeconds: secs }, rngFrom(2));
    eq(g.discardSeconds, secs, `discardSeconds ${secs}`);
  }
  const bad = R.newGame(SEATS, { seed: 1, layout: 'classic', discardSeconds: 12 }, rngFrom(2));
  eq(bad.discardSeconds, R.DISCARD_SECONDS, 'an option that is not on the list');
  const none = R.newGame(SEATS, { seed: 1, layout: 'classic' }, rngFrom(2));
  eq(none.discardSeconds, R.DISCARD_SECONDS, 'no choice made');
});

check('a game from before the discard clock existed still gets one', () => {
  const { g, me } = sevenState({ turnSeconds: 15 });
  delete g.discardSeconds;                       // as an in-flight room would arrive
  const res = R.applyMove(g, me, { type: 'roll' }, sevens());
  assert(res.ok, `roll refused: ${res.error}`);
  eq(res.game.discardSeconds, R.DISCARD_SECONDS, 'the default filled in');
  eq(res.game.turn.allowMs, R.DISCARD_SECONDS * 1000, 'allowance');
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

// ---------------------------------------------------------------- a card that does nothing

check('a knight always says what it did', () => {
  for (const useRobber of [true, false]) {
    for (const phase of ['roll', 'build']) {
      let g = R.newGame(SEATS, { seed: 12345, layout: 'classic', useRobber }, rngFrom(7));
      const rng = rngFrom(50);
      while (g.phase === 'setup') g = R.applyMove(g, 'p1', { type: 'timeout' }, rng).game;
      const me = R.currentPid(g);
      g.phase = phase;
      g.turn.rolled = phase === 'build';
      g.players[me].dev.knight = 1;
      for (const s2 of SEATS) if (s2 !== me) for (const r of RESOURCES) g.players[s2].res[r] = 2;

      const res = R.applyMove(g, me, { type: 'playDev', card: 'knight' }, rngFrom(11));
      assert(res.ok, `knight refused (robber=${useRobber}, ${phase}): ${res.error}`);
      const want = useRobber ? 'robber' : 'take';
      eq(res.game.phase, want, `phase after a knight (robber=${useRobber}, from ${phase})`);
      if (useRobber) {
        const lit = R.highlightsFor(res.game, me, null);
        assert(lit.hexes.length > 0, 'no tiles offered for the robber');
      }
    }
  }
});

check('a raid with nobody to rob says so instead of vanishing', () => {
  const { g, me } = raidState(['p1', 'p2'], 0);      // nobody else holds anything
  const done = raid(g, me, 21);
  assert(done.ok, `knight refused: ${done.error}`);
  assert(done.events.some((e) => e.t === 'noloot'), 'a knight was spent in total silence');
  eq(done.game.players[me].knights, 1, 'the knight still counted toward Largest Army');
});

check('a robber landing on nobody says so too', () => {
  const ids = ['p1', 'p2'];
  let g = R.newGame(ids, { seed: 909, layout: 'classic', useRobber: true }, rngFrom(6));
  let guard = 0;
  while (g.phase === 'setup') {
    g = R.applyMove(g, ids[0], { type: 'timeout' }, rngFrom(guard + 20)).game;
    if (guard++ > 40) throw new Error('setup did not finish');
  }
  const me = R.currentPid(g);
  g.phase = 'robber';
  g.turn.rolled = true;
  // A tile with nothing built on it at all.
  const bare = HEXES.find((h) => h.i !== g.robber && !h.corners.some((v) => g.bldg[v]));
  if (!bare) return;
  const done = R.applyMove(g, me, { type: 'moveRobber', hex: bare.i }, rngFrom(22));
  assert(done.ok, `moveRobber refused: ${done.error}`);
  assert(done.events.some((e) => e.t === 'noloot'), 'the robber moved in silence');
  eq(done.game.phase, 'build', 'phase after robbing an empty tile');
});

// ---------------------------------------------------------------- tapping a card

check('tapping a card takes a whole trade at a time', () => {
  // Five sheep and a 3:1 port: one tap takes three, the next wraps back to nothing.
  eq(R.lotAfterTap(0, 5, 3), 3, 'first tap');
  eq(R.lotAfterTap(3, 5, 3), 0, 'second tap, with no second lot affordable');

  // Seven sheep is two lots, so it steps through both before clearing.
  eq(R.lotAfterTap(0, 7, 3), 3, 'first of two lots');
  eq(R.lotAfterTap(3, 7, 3), 6, 'second of two lots');
  eq(R.lotAfterTap(6, 7, 3), 0, 'wraps after the last lot');

  // Standard 4:1.
  eq(R.lotAfterTap(0, 9, 4), 4, 'first lot at 4:1');
  eq(R.lotAfterTap(4, 9, 4), 8, 'second lot at 4:1');
  eq(R.lotAfterTap(8, 9, 4), 0, 'wraps at 4:1');
});

check('an odd count snaps up to the next whole trade', () => {
  // The plus button can leave a count the bank would refuse; a tap tidies it.
  eq(R.lotAfterTap(1, 7, 3), 3, 'from one');
  eq(R.lotAfterTap(2, 7, 3), 3, 'from two');
  eq(R.lotAfterTap(4, 7, 3), 6, 'from four');
  eq(R.lotAfterTap(5, 9, 4), 8, 'from five at 4:1');
});

check('a hand too small for one trade selects all of it', () => {
  // Two sheep at 3:1 buys nothing, but they are still worth offering to a player.
  eq(R.lotAfterTap(0, 2, 3), 2, 'takes what there is');
  eq(R.lotAfterTap(2, 2, 3), 0, 'and clears on the next tap');
  eq(R.lotAfterTap(0, 0, 3), 0, 'nothing to take');
});

check('a tap always gets back to nothing', () => {
  // Whatever the rate and the hand, tapping repeatedly must return to zero rather than
  // sticking — otherwise a mis-tap can only be undone with the minus button.
  for (let rate = 2; rate <= 4; rate++) {
    for (let have = 0; have <= 12; have++) {
      let cur = 0;
      let reachedZero = false;
      for (let i = 0; i < 12; i++) {
        cur = R.lotAfterTap(cur, have, rate);
        assert(cur >= 0 && cur <= have, `rate ${rate}, have ${have}: selected ${cur}`);
        if (i > 0 && cur === 0) { reachedZero = true; break; }
      }
      assert(reachedZero || have === 0, `rate ${rate}, have ${have}: never cycled back to zero`);
    }
  }
});

// ---------------------------------------------------------------- the bank as a basket

/**
 * Give this player exactly the ports named and no others.
 *
 * Opening placement can drop a settlement on a port by chance, so a test that assumed
 * 4:1 was really testing the shuffle. Clearing first makes the rate a property of the
 * test rather than of the seed.
 */
function setPorts(g, board, pid, kinds = []) {
  const mine = Object.keys(g.bldg).filter((v) => g.bldg[v].p === pid);
  for (const v of mine) delete board.portAt[v];
  kinds.forEach((kind, i) => { if (mine[i] !== undefined) board.portAt[mine[i]] = kind; });
  return mine;
}

check('a basket buys several cards in one move', () => {
  const { g, me } = tradeState({ wood: 8 });
  const board = makeBoard(g.seed, g.mode, g.layout);
  setPorts(g, board, me, ['wood']);                     // 2:1 wood, nothing else
  eq(R.tradeRate(g, board, me, 'wood'), 2, 'wood rate with the port');

  // Six wood at 2:1 is three cards, and they may be three different ones.
  const res = R.applyMove(g, me, {
    type: 'bankTrade', give: { wood: 6 }, want: { brick: 1, ore: 1, sheep: 1 },
  });
  assert(res.ok, `basket refused: ${res.error}`);
  eq(res.game.players[me].res.wood, 2, 'wood left');
  eq(res.game.players[me].res.brick, 1, 'brick gained');
  eq(res.game.players[me].res.ore, 1, 'ore gained');
  eq(res.game.players[me].res.sheep, 1, 'sheep gained');
});

check('resources in one basket are priced separately', () => {
  const { g, me } = tradeState({ wood: 4, brick: 4 });
  const board = makeBoard(g.seed, g.mode, g.layout);
  setPorts(g, board, me, ['wood']);                     // wood 2:1, brick left at 4:1
  eq(R.tradeRate(g, board, me, 'wood'), 2, 'wood rate');
  eq(R.tradeRate(g, board, me, 'brick'), 4, 'brick rate');
  // 4 wood at 2:1 is two, 4 brick at 4:1 is one — three cards.
  const good = R.applyMove(g, me, {
    type: 'bankTrade', give: { wood: 4, brick: 4 }, want: { ore: 3 },
  });
  assert(good.ok, `mixed basket refused: ${good.error}`);
  eq(good.game.players[me].res.ore, 3, 'ore gained');

  const wrong = R.applyMove(g, me, {
    type: 'bankTrade', give: { wood: 4, brick: 4 }, want: { ore: 2 },
  });
  assert(!wrong.ok, 'a basket that did not balance was accepted');
});

check('cards that do not make a whole trade are refused', () => {
  const { g, me } = tradeState({ wood: 9 });
  const board = makeBoard(g.seed, g.mode, g.layout);
  setPorts(g, board, me, []);
  const rate = R.tradeRate(g, board, me, 'wood');
  // One card over a whole trade would simply vanish, so it is refused rather than eaten.
  assert(!R.applyMove(g, me, { type: 'bankTrade', give: { wood: rate + 1 }, want: { ore: 1 } }).ok,
    'a basket with a remainder was accepted');
  assert(R.applyMove(g, me, { type: 'bankTrade', give: { wood: rate }, want: { ore: 1 } }).ok,
    'the exact basket was refused');
});

check('the bank cannot be asked for what it does not have', () => {
  const { g, me } = tradeState({ wood: 8 });
  const board = makeBoard(g.seed, g.mode, g.layout);
  setPorts(g, board, me, []);
  const rate = R.tradeRate(g, board, me, 'wood');
  g.bank.ore = 0;
  assert(!R.applyMove(g, me, { type: 'bankTrade', give: { wood: rate }, want: { ore: 1 } }).ok,
    'traded for a resource the bank had run out of');
});

check('a basket cannot ask for what it is handing over', () => {
  const { g, me } = tradeState({ wood: 8 });
  assert(!R.applyMove(g, me, { type: 'bankTrade', give: { wood: 8 }, want: { wood: 2 } }).ok,
    'traded wood for wood');
});

check('the bank is settled whole or not at all', () => {
  const { g, me } = tradeState({ wood: 8 });
  const board = makeBoard(g.seed, g.mode, g.layout);
  setPorts(g, board, me, []);
  const rate = R.tradeRate(g, board, me, 'wood');
  // Enough wood for two cards, but the bank can only supply one of them.
  g.bank.ore = 0;
  const before = JSON.stringify(g.players[me].res);
  const res = R.applyMove(g, me, {
    type: 'bankTrade', give: { wood: rate * 2 }, want: { ore: 1, sheep: 1 },
  });
  assert(!res.ok, 'a basket the bank could not fill went through anyway');
  eq(JSON.stringify(g.players[me].res), before, 'a refused basket still moved cards');
});

// ---------------------------------------------------------------- what the board offers

check('everything affordable lights up at once', () => {
  const { g, me } = tradeState({ wood: 6, brick: 6, sheep: 6, wheat: 6, ore: 6 });
  const h = R.highlightsFor(g, me, null);
  assert(h.edges.length, 'no roads offered while holding everything');
  assert(h.verts.length || h.cities.length, 'neither settlements nor cities offered');
  // A corner is one thing or the other, never both — which is what makes a bare tap
  // unambiguous.
  const overlap = h.verts.filter((v) => h.cities.includes(v));
  eq(overlap.length, 0, 'corners offered as both a settlement and an upgrade');
});

check('nothing lights up that cannot be paid for', () => {
  const { g, me } = tradeState({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
  const h = R.highlightsFor(g, me, null);
  eq(h.edges.length, 0, 'roads offered with an empty hand');
  eq(h.verts.length, 0, 'settlements offered with an empty hand');
  eq(h.cities.length, 0, 'cities offered with an empty hand');
});

check('free roads crowd out everything else', () => {
  const { g, me } = tradeState({ wood: 6, brick: 6, sheep: 6, wheat: 6, ore: 6 });
  g.turn.freeRoads = 2;
  const h = R.highlightsFor(g, me, null);
  assert(h.edges.length, 'no roads offered while free roads are owed');
  eq(h.verts.length, 0, 'settlements offered before the free roads were placed');
  eq(h.cities.length, 0, 'cities offered before the free roads were placed');
});

check('the board offers nothing while you are waiting', () => {
  const { g, me } = tradeState({ wood: 6, brick: 6, sheep: 6, wheat: 6, ore: 6 });
  const other = SEATS.find((s) => s !== me);
  const h = R.highlightsFor(g, other, null);
  eq(h.edges.length + h.verts.length + h.cities.length, 0, 'targets lit for a waiting player');
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

check('every island is the shape it claims to be', () => {
  for (const name of Object.keys(LAYOUT_INFO)) {
    const b = makeBoard(4242, 'random', name);
    // Asked with the seed, because a dynamic island has no size until one grows it.
    const info = layoutInfo(name, 4242);
    eq(b.tiles.length, info.tiles, `${name} tile count`);
    eq(b.ports.length, info.ports, `${name} port count`);
    const numbered = b.tiles.filter((t) => t.num).length;
    const deserts = b.tiles.filter((t) => t.terrain === 'desert').length;
    eq(numbered + deserts, info.tiles, `${name} tokens plus deserts`);
  }
});

check('a dynamic island is playable whatever the seed grows', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const b = makeBoard(seed, 'random', 'dynamic');
    const n = b.tiles.length;
    assert(n >= DYNAMIC_MIN && n <= DYNAMIC_MAX, `seed ${seed} grew ${n} tiles`);

    // One coastline. A lake or a second piece leaves the port walk going round the same
    // ring twice, which shows up as two ports on one edge.
    eq(new Set(b.ports.map((p) => p.edge)).size, b.ports.length, `seed ${seed} repeated a port edge`);

    // Every tile reachable from every other, so no settlement is stranded off the island.
    const seen = new Set([0]); const stack = [0];
    while (stack.length) {
      for (const nb of hexNeighbours(stack.pop())) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
    eq(seen.size, n, `seed ${seed} is not one island`);

    // The rule the token deal exists to keep.
    for (const t of b.tiles) {
      if (!isRed(t.num)) continue;
      for (const nb of hexNeighbours(t.i)) {
        assert(!isRed(b.tiles[nb].num), `seed ${seed} put ${t.num} next to ${b.tiles[nb].num}`);
      }
    }
  }
});

check('a dynamic island is the same island on every device', () => {
  const a = makeBoard(31337, 'random', 'dynamic');
  useLayout('classic');                       // shunt the shared topology elsewhere
  const b = makeBoard(31337, 'random', 'dynamic');
  eq(JSON.stringify(a.tiles), JSON.stringify(b.tiles), 'same seed gave two islands');
  const c = makeBoard(31338, 'random', 'dynamic');
  assert(JSON.stringify(a.tiles) !== JSON.stringify(c.tiles), 'two seeds gave one island');
});

check('the shipped page asks for this build of the CSS and the JS', () => {
  // index.html pins its own assets with ?v=. If one drifts from APP_VERSION, a refresh
  // inside GitHub Pages' ten-minute cache window can leave new JavaScript being laid out
  // by the previous build's stylesheet — which is not a failure anything else would
  // catch, because both files load and neither complains.
  //
  // Every pin is checked rather than a named two: iro.min.js was added later, kept the
  // version it was added on, and nothing noticed. Whatever is pinned has to agree.
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const pinned = [...html.matchAll(/(?:href|src)="([^"?]+)\?v=([^"]+)"/g)];
  assert(pinned.length >= 2, `expected the page to pin its assets, found ${pinned.length}`);
  for (const [, file, v] of pinned) eq(v, APP_VERSION, `${file} is pinned to the wrong build`);
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

// ---------------------------------------------------------------- the two awards
//
// Everything below goes through applyMove, which is the only door into the engine —
// a human's tap and a bot's move both arrive here — so proving it once proves it for
// both.

/** A game parked in the build phase with everybody rich enough to act. */
function armed(seats = ['p0', 'p1', 'p2']) {
  const g = R.newGame(seats, { targetVP: 10, layout: 'classic', useRobber: true, turnSeconds: 0, seed: 42 });
  g.phase = 'build'; g.turn.rolled = true; g.turn.seat = 0;
  for (const s of seats) g.players[s].res = { wood: 20, brick: 20, sheep: 20, wheat: 20, ore: 20 };
  return g;
}
function handTurnTo(g, pid) {
  g.turn.seat = g.seats.indexOf(pid);
  g.phase = 'build'; g.turn.rolled = true; g.turn.playedDev = false;
}
/** Play one knight for `pid`, and walk back out of the robber steps it opens. */
function playKnight(g, pid) {
  handTurnTo(g, pid);
  g.players[pid].dev.knight = (g.players[pid].dev.knight || 0) + 1;
  let r = R.applyMove(g, pid, { type: 'playDev', card: 'knight' });
  assert(r.ok, `knight refused: ${r.error}`);
  g = r.game;
  if (g.phase === 'robber') {
    const hex = HEXES.map((h) => h.i).find((h) => h !== g.robber);
    r = R.applyMove(g, pid, { type: 'moveRobber', hex });
    if (r.ok) g = r.game;
    if (g.phase === 'steal') {
      r = R.applyMove(g, pid, { type: 'steal', from: g.pending.stealFrom[0] });
      if (r.ok) g = r.game;
    }
  }
  return g;
}

check('largest army needs three knights, and not two', () => {
  let g = armed();
  g = playKnight(g, 'p0');
  eq(g.players.p0.knights, 1, 'first knight counted');
  assert(g.award.army === null, 'one knight must not take the award');
  g = playKnight(g, 'p0');
  assert(g.award.army === null, 'two knights must not take the award');
  const before = R.publicVP(g, 'p0');
  g = playKnight(g, 'p0');
  eq(g.players.p0.knights, 3, 'third knight counted');
  eq(g.award.army, 'p0', 'three knights takes Largest Army');
  eq(g.award.armySize, 3, 'army size recorded');
  eq(R.publicVP(g, 'p0'), before + 2, 'Largest Army is worth two points');
  assert(g.log.some((e) => e.t === 'army' && e.p === 'p0'), 'taking it is announced');
});

check('largest army moves only on a strict win', () => {
  let g = armed();
  for (let i = 0; i < 3; i++) g = playKnight(g, 'p0');
  const held = R.publicVP(g, 'p0');
  for (let i = 0; i < 3; i++) g = playKnight(g, 'p1');
  eq(g.award.army, 'p0', 'a tie at three leaves it where it is');
  g = playKnight(g, 'p1');
  eq(g.award.army, 'p1', 'four takes it from three');
  eq(g.award.armySize, 4, 'new size recorded');
  eq(R.publicVP(g, 'p0'), held - 2, 'the old holder loses the points');
});

check('longest road needs five, and pays two points', () => {
  const g0 = armed();
  makeBoard(g0.seed, g0.mode, g0.layout);
  let g = g0;
  // A settlement, then a chain of roads walking away from it.
  const start = R.legalSettlements(g, 'p0', true)[0];
  g.bldg[start] = { t: 's', p: 'p0' };
  const chain = [];
  const used = new Set();
  let at = start;
  while (chain.length < 5) {
    const next = VERTS[at].edges.find((e) => !used.has(e) && !g.roads[e]);
    if (next === undefined) break;
    used.add(next); chain.push(next);
    at = EDGES[next].a === at ? EDGES[next].b : EDGES[next].a;
  }
  eq(chain.length, 5, 'found five connected edges to build on');

  // Lays up TO a total, carrying on from wherever it got to — laying "the first five"
  // after "the first four" would try to build the first four a second time, on top of
  // themselves.
  let built = 0;
  const layUpTo = (total) => {
    while (built < total) {
      handTurnTo(g, 'p0');
      const r = R.applyMove(g, 'p0', { type: 'build', what: 'road', e: chain[built] });
      assert(r.ok, `road ${built} refused: ${r.error}`);
      g = r.game;
      built += 1;
    }
  };
  layUpTo(4);
  eq(g.players.p0.roadLen, 4, 'four roads measure as four');
  assert(g.award.road === null, 'four roads must not take the award');
  const before = R.publicVP(g, 'p0');
  layUpTo(5);
  eq(g.players.p0.roadLen, 5, 'five roads measure as five');
  eq(g.award.road, 'p0', 'five roads takes Longest Road');
  eq(R.publicVP(g, 'p0'), before + 2, 'Longest Road is worth two points');
  assert(g.log.some((e) => e.t === 'longest' && e.p === 'p0'), 'taking it is announced');
});

// ---------------------------------------------------------------- report

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL  ' + f);
process.exit(failures.length ? 1 : 0);
