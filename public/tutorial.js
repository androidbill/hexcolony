// The guided practice game for new players.
//
// Pure: given the game, say which step the player is on, what that step says, and which of
// their moves it will accept. app.js owns the screen — it draws the coach card, pulses the
// button a step points at, and asks `refusal` before every move in solo.
//
// The practice game is an ordinary solo game (one Easy bot, a fixed small island, no timer,
// nothing saved, no XP) with one difference: until the last step, only the move the coach is
// asking for goes through. Anything else is refused with the reason, in plain words, which is
// the point — a new player learns the rules fastest from being told why a tap did nothing.

import * as R from './rules.js';

/** The same island every time, so the steps can rely on what the board looks like. */
export const TUTORIAL_SEED = 20261121;
export const TUTORIAL_SETTINGS = {
  targetVP: 5,
  discardLimit: 9,
  boardMode: 'random',
  layout: 'classic',
  useRobber: true,
  turnSeconds: 0,           // no timer: nobody learns anything with a clock running
  fog: false,
  events: false,
  goals: false,
};
/** Handed over once play starts, so there is something to build with. */
export const STARTER_PACK = { wood: 3, brick: 3, sheep: 1, wheat: 1 };

export const SEEN_KEY = 'hexcolony_tutorial_seen';

const mySettlements = (g, pid) => Object.values(g.bldg).filter((b) => b.p === pid && b.t === 's').length;
const myRoads = (g, pid) => Object.values(g.roads).filter((p) => p === pid).length;

/** The key a move is filed under: builds are told apart by what they build. */
export const moveKey = (move) => (move.type === 'build' ? `build:${move.what}` : move.type);

/**
 * The moves a player starts on their own initiative. Everything else — answering a trade,
 * discarding when the game demands it, picking who to rob — is the game asking, and is never
 * held back. Undo is in here and in no step's allow list: stepping backwards would leave the
 * coach pointing at something already done.
 */
const GATED = new Set([
  'roll', 'endTurn', 'build:road', 'build:settlement', 'build:city', 'buyDev', 'playDev',
  'bankTrade', 'offerTrade', 'setupSettlement', 'setupRoad', 'moveRobber', 'undo',
]);

/**
 * kind: 'info' waits for the Next button; 'do' waits for `done`; 'wait' waits for `done`
 * while the bot plays. `allow` lists the moves that go through. `target` is a data-act
 * button to pulse. `skip` drops the step when the game has already moved past it.
 */
export const STEPS = [
  {
    id: 'welcome', kind: 'info', title: 'Welcome to HexColony',
    text: 'This is a short practice game against one friendly bot. I will tell you what to do at each step, and only that move will work, so you cannot go wrong. It takes about five minutes.',
  },
  {
    id: 'board', kind: 'info', title: 'The island',
    text: 'The island is made of hexagon tiles. Each makes one kind of card: forest gives wood, hills brick, pasture sheep, fields wheat, mountains ore. The number on a tile is the dice roll that makes it pay out. 6 and 8 come up most often; 2 and 12 almost never.',
  },
  {
    id: 'settle1', kind: 'do', title: 'Place your first settlement',
    text: 'Tap a glowing corner to put a settlement there. A corner that touches three tiles with good numbers, like 5, 6, 8 or 9, will pay you the most.',
    allow: ['setupSettlement'], done: (g, pid) => mySettlements(g, pid) >= 1,
    why: 'Place your first settlement first: tap one of the glowing corners.',
  },
  {
    id: 'road1', kind: 'do', title: 'Add a road',
    text: 'Every settlement comes with a road. Tap a glowing edge next to the settlement you just placed. Roads are how you reach new places to build.',
    allow: ['setupRoad'], done: (g, pid) => myRoads(g, pid) >= 1,
    why: 'Place a road next to your new settlement: tap one of the glowing edges.',
  },
  {
    id: 'botsetup', kind: 'wait', title: 'Your opponent places',
    text: 'The bot is placing its two settlements. Watch where it goes. You will place your second one right after.',
    allow: [], done: (g, pid) => g.phase !== 'setup' || R.isTurn(g, pid),
    why: 'It is the bot’s turn to place. Wait a moment.',
  },
  {
    id: 'settle2', kind: 'do', title: 'Place your second settlement',
    text: 'Your second settlement pays you right away: one card for every tile it touches. Pick a corner that touches different resources from your first, so you are not short of anything.',
    allow: ['setupSettlement'], done: (g, pid) => mySettlements(g, pid) >= 2,
    why: 'Place your second settlement first: tap one of the glowing corners.',
  },
  {
    id: 'road2', kind: 'do', title: 'And its road',
    text: 'One more road, next to the settlement you just placed. Then the game proper starts, and you go first.',
    allow: ['setupRoad'], done: (g, pid) => myRoads(g, pid) >= 2,
    why: 'Place the road next to your new settlement: tap one of the glowing edges.',
  },
  {
    id: 'roll', kind: 'do', title: 'Roll the dice',
    text: 'Every turn starts with a roll. Any tile showing the number rolled pays one card to each player with a settlement on it (a city pays two). Tap Roll.',
    allow: ['roll'], target: 'roll', done: (g) => g.phase !== 'roll',
    why: 'Every turn starts with a roll. Tap the Roll button.',
  },
  {
    id: 'cards', kind: 'info', title: 'Your cards',
    text: 'These are your cards, along the bottom. I have also added a starter bundle of wood, brick, sheep and wheat, so you have enough to build something. Next you will spend them.',
    enter: 'grant',
  },
  {
    id: 'road3', kind: 'do', title: 'Build a road',
    text: 'A road costs 1 wood and 1 brick. Tap a glowing edge that touches one of your roads or settlements. Anything you can afford glows on the board.',
    allow: ['build:road'], done: (g, pid) => myRoads(g, pid) >= 3,
    why: 'Build a road first: tap a glowing edge on the board.',
  },
  {
    id: 'road4', kind: 'do', title: 'Reach further',
    text: 'One more road. A new settlement has to be at least two corners away from any other settlement, so you need a road or two to reach an open spot.',
    allow: ['build:road'], done: (g, pid) => myRoads(g, pid) >= 4,
    why: 'Build another road first: tap a glowing edge on the board.',
  },
  {
    id: 'settle3', kind: 'do', title: 'Build a settlement',
    text: 'A settlement costs 1 each of wood, brick, sheep and wheat, and must connect to one of your roads. It is worth 1 victory point and makes you money from every new tile it touches. Tap a glowing corner.',
    allow: ['build:settlement'], done: (g, pid) => mySettlements(g, pid) >= 3,
    why: 'Build a settlement: tap one of the glowing corners.',
    stuck: 'No corner glowing? Tap Skip step: your roads may not reach an open spot yet.',
  },
  {
    id: 'points', kind: 'info', title: 'How you win',
    text: 'Settlements are worth 1 point, and you can upgrade one to a city for 2 (3 ore and 2 wheat). Development cards, the Longest Road and the Largest Army earn more. The first player to reach 5 points wins this practice game.',
  },
  {
    id: 'trade', kind: 'info', title: 'Trading',
    text: 'Short of something? You can trade 4 of one card to the bank for 1 of another, or less if you own a port (a settlement on the coast). You can also offer a deal to other players. The trade options are in your tray, under your cards.',
  },
  {
    id: 'end', kind: 'do', title: 'End your turn',
    text: 'You are done for now. Tap End turn to pass play to the bot.',
    allow: ['endTurn'], target: 'end', mark: 'num', done: (g, pid, st) => g.turn.num > st.num,
    why: 'Tap End turn when you have finished building.',
  },
  {
    id: 'botturn', kind: 'wait', title: 'The bot plays',
    text: 'The bot is taking its turn. If it offers you a trade you can say no, or just watch.',
    allow: [], done: (g, pid) => g.phase === 'over' || R.isTurn(g, pid),
    why: 'It is the bot’s turn. Wait a moment.',
  },
  {
    id: 'seven', kind: 'do', title: 'The dreaded 7',
    text: 'It is your turn again. This time something different: a 7. Tap Roll.',
    allow: ['roll'], target: 'roll', done: (g) => g.phase !== 'roll',
    why: 'Tap the Roll button.',
    forceRoll: 7,
  },
  {
    id: 'robber', kind: 'do', title: 'The robber',
    text: (g) => (g.phase === 'discard'
      ? 'A 7 makes anyone holding more than 9 cards throw half away. Tap Discard and choose.'
      : 'A 7 means no one gets paid. Instead you move the robber: tap any tile. It blocks that tile from paying while it sits there, and you steal a card from whoever has a settlement next to it.'),
    allow: ['moveRobber'], done: (g) => g.phase !== 'robber' && g.phase !== 'discard',
    why: 'Move the robber: tap any glowing tile.',
  },
  {
    id: 'steal', kind: 'do', title: 'Steal a card',
    text: 'More than one player is next to that tile. Choose who to steal from.',
    allow: [], skip: (g) => g.phase !== 'steal' && g.phase !== 'take',
    done: (g) => g.phase !== 'steal' && g.phase !== 'take',
    why: 'Choose who to steal from first.',
  },
  {
    id: 'finish', kind: 'finish', title: 'You have got it',
    text: 'That is the whole loop: roll, collect, build, trade, end your turn, and watch out for the 7. The first to 5 points wins here, 10 in a normal game. Keep playing this one for practice, or head back and start a real game.',
  },
];

/** Starting state for a new tutorial run. */
export const newRun = () => ({ i: 0, num: 0, granted: false, entered: -1 });

/** The step the run is on, or null when it is over. */
export const current = (run) => STEPS[run.i] || null;

/**
 * Move the run forward over every step the game has already satisfied.
 * Returns what changed so the caller can act: `enter` names a one-off effect to apply.
 */
export function advance(run, g, pid) {
  const effects = [];
  for (let guard = 0; guard < STEPS.length; guard += 1) {
    const step = current(run);
    if (!step) break;
    if (run.entered !== run.i) {
      run.entered = run.i;
      if (step.mark === 'num') run.num = g.turn.num;
      if (step.enter) effects.push(step.enter);
    }
    if (step.kind === 'info' || step.kind === 'finish') break;
    if ((step.skip && step.skip(g, pid, run)) || step.done(g, pid, run)) { run.i += 1; continue; }
    break;
  }
  return effects;
}

/** Next button on an info step. */
export function next(run) { run.i += 1; }

/** Why this move is refused right now, or null if it goes through. */
export function refusal(run, move) {
  const step = current(run);
  if (!step || step.kind === 'finish') return null;
  const key = moveKey(move);
  if (!GATED.has(key)) return null;
  if (step.kind === 'info') return 'Tap Next on the coach card to carry on.';
  if (key === 'undo') return 'Undo is switched off in the practice game.';
  if ((step.allow || []).includes(key)) return null;
  return step.why || 'Follow the coach card: it says what to do next.';
}

/** The text of a step, which may depend on the game. */
export const stepText = (step, g) => (typeof step.text === 'function' ? step.text(g) : step.text);

/** Hide any highlight the current step is not asking for, so the board points one way. */
export function trimHighlights(run, h, g, pid) {
  const step = current(run);
  if (!step || step.kind === 'finish') return h;
  const allow = step.allow || [];
  const keep = (k) => allow.includes(k);
  if (step.kind === 'info') return { verts: [], edges: [], hexes: [], cities: [] };
  return {
    verts: keep('setupSettlement') || keep('build:settlement') ? h.verts : [],
    edges: keep('setupRoad') || keep('build:road') ? h.edges : [],
    hexes: keep('moveRobber') ? h.hexes : [],
    cities: keep('build:city') ? h.cities : [],
  };
}

/** The roll the dice must show on the player's next roll, or null to leave it to chance. */
export function forcedRoll(run, g, pid, board, verts) {
  const step = current(run);
  if (!step || step.id !== 'roll' && step.id !== 'seven') return null;
  if (step.forceRoll) return step.forceRoll;
  // The first roll should pay: pick a number that one of the player's buildings sits on.
  for (const [v, b] of Object.entries(g.bldg)) {
    if (b.p !== pid) continue;
    for (const hi of verts[v].hexes) {
      const t = board.tiles[hi];
      if (t.res && t.num && g.robber !== hi && t.num !== 7) return t.num;
    }
  }
  return null;
}

/** An rng that hands back two chosen dice, then behaves normally. */
export function diceRng(total) {
  const d1 = Math.max(1, Math.min(6, Math.floor(total / 2)));
  const d2 = total - d1;
  const seq = [(d1 - 1) / 6 + 0.01, (d2 - 1) / 6 + 0.01];
  return () => (seq.length ? seq.shift() : Math.random());
}
