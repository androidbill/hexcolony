// HexColony rules engine.
//
// Pure and headless: no DOM, no network, no randomness that isn't handed in. Every
// move goes through `applyMove(game, playerId, move)`, which clones the state, applies
// the move if it is legal, and returns the new state plus the events that happened.
// The caller (app.js) writes the result back to Firestore inside a transaction, so a
// move either lands whole or not at all.
//
// The engine is deliberately strict — it re-validates everything, because the client
// that sends a move is the same untrusted device that drew the buttons.

import { HEXES, VERTS, EDGES, RESOURCES, makeBoard, hexNeighbours, LAYOUT_INFO, pips } from './board.js';

export const COSTS = {
  road:       { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city:       { wheat: 2, ore: 3 },
  dev:        { sheep: 1, wheat: 1, ore: 1 },
};

export const PIECES = { road: 15, settlement: 5, city: 4 };

// Turn timers.
//
// The rules never touch a clock. They only say how long the current step is allowed to
// last (`turn.allowMs`) and raise `turn.clockRestart` when that allowance should start
// running again. The caller stamps the actual start time with Firestore's own
// serverTimestamp, so no device's opinion of the time can ever enter the shared state —
// which is the whole point: one phone with a wrong clock must not be able to break the
// timer for everybody else.
export const TURN_OPTIONS = [0, 15, 30, 45, 60];   // 0 = no timer at all
export const ROLL_SECONDS = 10;                    // fixed: rolling is not a decision

// Opening placement is timed even when the rest of the game is not, and that is
// deliberate. A turn nobody takes during play holds up one round; a settlement nobody
// places holds up the entire game before it has started, and there is no board yet for
// the others to look at while they wait. Ninety seconds is long enough to think about an
// opening and short enough that a phone that went to sleep does not end the evening.
export const SETUP_SECONDS = 90;

// Discarding after a seven gets its own allowance, and gets it whether or not the game is
// using a turn timer at all.
//
// It is not the turn's time being spent. Everyone who is over the limit discards at once,
// nobody can do anything until they have all finished, and the player whose turn it is
// gets a fresh allowance afterwards — so this is the one clock that is running for
// several people at the same time, and the only one whose expiry does not end a turn.
export const DISCARD_OPTIONS = [30, 45, 60];
export const DISCARD_SECONDS = 30;
export const ACTION_BONUS_MS = 10000;              // earned by actually doing something
export const BANK_PER_RESOURCE = 19;   // classic; see LAYOUT_INFO for the expansion

// How many offers one player may have on the table at once. There is no rule of the game
// here; it is a limit on how much other people have to read before they can act.
export const MAX_OFFERS = 4;

/**
 * How long an offer stands before it lapses.
 *
 * The deadline itself is not in here and is not in the game state either. applyMove has
 * to stay a pure function of the state it is given — the tournament replays a quarter of
 * a million moves through it — so it cannot read a clock, and a clock a phone worked out
 * for itself has no business in shared state. Firestore stamps the moment an offer was
 * made, in `tradeDeadlines` on the room, exactly as it stamps the turn clock; every
 * device adds this many seconds to that and reads the answer against its own measured
 * offset. Nothing here needs to know any of it.
 */
export const TRADE_SECONDS = 10;

/**
 * How much history the room carries, and what gets thrown out first.
 *
 * The whole log rides inside the room document, and every move rewrites that document to
 * every phone in the room — so this is a bandwidth number, not a storage one. Measured on
 * a finished six-player game: the log is most of the document, and 61% of the log by
 * weight is turns, rolls and payouts. Those are also the entries nobody scrolls back to
 * read. Simply raising the cap to hold more builds and trades tripled every write to buy
 * mostly dice results.
 *
 * So the budget stays small and the routine entries are evicted first. A build or a trade
 * survives until the log is nothing but builds and trades, which is what the log is for
 * looking at.
 */
export const LOG_KEEP = 80;
/**
 * The tail nothing is evicted from, so the last minute of play stays whole — rolls,
 * payouts and all. Without it a long game ends up holding nothing but builds and trades,
 * and "what did I just miss" becomes the one question the log cannot answer.
 */
const LOG_RECENT = 24;
const LOG_ROUTINE = new Set(['turn', 'roll', 'produce', 'nothing', 'shortfall', 'discard', 'robber', 'noloot']);

/**
 * Seats at a table.
 *
 * Two because a trade needs somebody to trade with; six because that is what the boards
 * are built for — the expansion island and its scaled bank exist precisely to carry five
 * and six, and there is no seventh arrangement. The number lived as a bare 6 in one
 * branch of one join path, which is to say it was enforced for players arriving by room
 * code and for nobody else.
 */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

/** Whether this set of seats can start a game. Null when it can. */
export function seatingProblem(seats) {
  const n = (seats || []).length;
  if (n < MIN_PLAYERS) return `You need at least ${MIN_PLAYERS} players.`;
  if (n > MAX_PLAYERS) return `${MAX_PLAYERS} players is the most this board seats.`;
  return null;
}

// The development deck and the bank both scale with the board — a 30-tile island with
// six players would drain a 19-card bank and a 25-card deck long before anyone won.
// The per-layout numbers live in LAYOUT_INFO.
const devBag = (info) => Object.entries(info.dev).flatMap(([kind, n]) => Array(n).fill(kind));

export const DEV_INFO = {
  knight: { name: 'Knight', blurb: 'Move the robber and steal a card. Three knights takes Largest Army.' },
  road:   { name: 'Road Building', blurb: 'Place two roads for free.' },
  plenty: { name: 'Year of Plenty', blurb: 'Take any two resources from the bank.' },
  mono:   { name: 'Monopoly', blurb: 'Name a resource. Every other player hands you all of theirs.' },
  vp:     { name: 'Victory Point', blurb: 'Worth 1 point. Stays secret until someone wins.' },
};

// The five victory-point cards are distinct buildings on a real board; naming them
// makes the end-of-game reveal read like a story instead of "+3 hidden".
// Six, because the expansion deck holds six point cards to the classic deck's five.
const VP_NAMES = ['Great Hall', 'Library', 'Market', 'Chapel', 'University', 'Cathedral'];

// Player colours.
//
// Eleven, for at most six players, so there is a real choice rather than whatever was
// left. Each carries the ink to write on it: these run from near-white to near-black and
// a single text colour would be unreadable on half of them.
//
// They are bright because they no longer have to carry the whole job of separating a
// piece from the board — every road, settlement and city is outlined in white now, so a
// colour only has to be told apart from the other ten, not from a photograph of a forest.
//
// The pairs that used to be confusable are gone rather than nudged: blue against sky,
// green against lime, orange against yellow. Picking between two shades of the same hue
// under a table lamp is not a choice worth offering. What is left is spaced around the
// wheel — red, sky, yellow, lime, teal, purple, pink — plus four neutrals. Copper is the
// one to watch: it is the old orange's corner of the wheel, kept deliberately darker than
// yellow so value separates them even where hue nearly does not.
export const PLAYER_COLORS = [
  { key: 'red',    hex: '#ff4d4f', ink: '#ffffff', name: 'Red' },
  { key: 'sky',    hex: '#35c4ff', ink: '#03293c', name: 'Sky' },
  { key: 'yellow', hex: '#ffd52b', ink: '#3a2f05', name: 'Yellow' },
  { key: 'lime',   hex: '#9ef01a', ink: '#1c3003', name: 'Lime' },
  { key: 'teal',   hex: '#13e3c8', ink: '#032f2a', name: 'Teal' },
  { key: 'purple', hex: '#b06cff', ink: '#ffffff', name: 'Purple' },
  { key: 'pink',   hex: '#ff5cb8', ink: '#40062a', name: 'Pink' },
  { key: 'white',  hex: '#f4f7fb', ink: '#0d1b28', name: 'White' },
  { key: 'slate',  hex: '#93a7bd', ink: '#0d1b28', name: 'Slate' },
  { key: 'copper', hex: '#c8802e', ink: '#ffffff', name: 'Copper' },
  { key: 'black',  hex: '#2a3444', ink: '#ffffff', name: 'Black' },
];

/**
 * Check a client-supplied {resource: count} bundle.
 *
 * Every one of these arrives from a device we do not control, and the counts were being
 * used in arithmetic without ever being checked. A negative count in a trade offer
 * reversed the transfer and pulled cards OUT of the other player's hand; a fractional
 * one produced fractional resources that no later check could tidy up. Whole numbers,
 * real resources, nothing absurd.
 */
function badBundle(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'Malformed.';
  for (const [r, n] of Object.entries(obj)) {
    if (!RESOURCES.includes(r)) return 'Unknown resource.';
    if (!Number.isInteger(n) || n < 0 || n > 999) return 'Bad card count.';
  }
  return null;
}

const clone = (o) => (typeof structuredClone === 'function'
  ? structuredClone(o)
  : JSON.parse(JSON.stringify(o)));

const emptyRes = () => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
const emptyDev = () => ({ knight: 0, road: 0, plenty: 0, mono: 0, vp: 0 });

export function handSize(p) {
  return RESOURCES.reduce((n, r) => n + (p.res?.[r] || 0), 0);
}
export function devCount(p) {
  return Object.keys(DEV_INFO).reduce((n, k) => n + (p.dev?.[k] || 0) + (p.devNew?.[k] || 0), 0);
}
export function canAfford(p, cost) {
  return Object.entries(cost).every(([r, n]) => (p.res[r] || 0) >= n);
}
function pay(g, p, cost) {
  for (const [r, n] of Object.entries(cost)) { p.res[r] -= n; g.bank[r] += n; }
}

// ---------------------------------------------------------------- setup
function shuffle(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Start a game. `seats` is the turn order (array of player ids); `rng` supplies the
 * dev-deck shuffle. The board itself is not stored — only its seed, because every
 * device rebuilds an identical board from it.
 */
export function newGame(seats, settings, rng = Math.random) {
  // An accepted map hands its seed in; without one the board is rolled fresh.
  const seed = Number.isFinite(settings.seed) ? settings.seed : Math.floor(rng() * 2 ** 31);
  const layout = LAYOUT_INFO[settings.layout] ? settings.layout : 'classic';
  const info = LAYOUT_INFO[layout];
  const players = {};
  for (const pid of seats) {
    players[pid] = {
      res: emptyRes(),
      dev: emptyDev(),          // playable
      devNew: emptyDev(),       // bought this turn, cannot be played until next turn
      vpCards: [],              // names of the victory-point cards held
      knights: 0,
      roadLen: 0,
      left: { road: PIECES.road, settlement: PIECES.settlement, city: PIECES.city },
    };
  }

  // Snake order: everyone places one settlement + road down the seats, then back up,
  // and the second settlement pays out its surrounding hexes immediately.
  const forward = seats.map((_, i) => i);
  const order = [...forward, ...forward.slice().reverse()];

  // With the robber switched off no tile is ever blocked, so nothing sits on the
  // desert and a 7 becomes purely a raid: take a card from whoever you like.
  const useRobber = settings.useRobber !== false;

  return {
    seed,
    mode: settings.boardMode || 'random',
    layout,
    useRobber,
    target: settings.targetVP || 10,
    discardLimit: settings.discardLimit || 7,
    seats: seats.slice(),
    players,
    bldg: {},
    roads: {},
    robber: useRobber ? makeBoard(seed, settings.boardMode || 'random', layout).robber : -1,
    bank: Object.fromEntries(RESOURCES.map((r) => [r, info.bank])),
    deck: shuffle(devBag(info), rng),
    vpNames: shuffle(VP_NAMES, rng),
    phase: 'setup',
    setup: { order, at: 0, need: 's', lastV: null },
    turnSeconds: TURN_OPTIONS.includes(settings.turnSeconds) ? settings.turnSeconds : 0,
    discardSeconds: DISCARD_OPTIONS.includes(settings.discardSeconds)
      ? settings.discardSeconds : DISCARD_SECONDS,
    turn: {
      seat: order[0], dice: null, rolled: false, playedDev: false, num: 0, freeRoads: 0,
      // The first player is already on the clock as the board appears.
      allowMs: SETUP_SECONDS * 1000, clockRestart: true,
    },
    award: { road: null, roadLen: 0, army: null, armySize: 0 },
    pending: { discard: {}, stealFrom: [] },
    // More than one offer can be on the table at once — see the offerTrade case.
    trades: [],
    tradeIds: 0,
    winner: null,
    seq: 0,
    log: [],
  };
}

/**
 * Start the allowance for the step just entered. `allowMs` of 0 means untimed, which is
 * what every reader checks, so switching timers off needs no other special cases.
 */
function startClock(g, seconds, always = false) {
  const on = always || !!g.turnSeconds;
  g.turn.allowMs = on ? seconds * 1000 : 0;
  g.turn.clockRestart = on;
}

/**
 * Hand control back to the player whose turn it is, with a fresh allowance.
 *
 * Everything between the roll and the next build — discarding, moving the robber,
 * choosing a victim — used to run on the clock that started at the roll. Other people's
 * discards were eating the roller's building time, and a seven could cost most of a
 * turn that had not begun. The step that gives control back starts the allowance again.
 */
function resumeTurn(g) {
  g.phase = g.turn.rolled ? 'build' : 'roll';
  startClock(g, g.turn.rolled ? g.turnSeconds : ROLL_SECONDS);
}

/**
 * Doing something buys you more time. The whole turn is capped at twice the chosen
 * limit: without a cap a player could hold a turn open forever by making a cheap bank
 * trade every ten seconds, and the bonus exists to stop the clock punishing you for
 * playing, not to become a way of never ending your turn.
 */
function bumpClock(g) {
  if (!g.turnSeconds || !g.turn.allowMs) return;
  g.turn.allowMs = Math.min(g.turn.allowMs + ACTION_BONUS_MS, g.turnSeconds * 2000);
}

export const currentPid = (g) => g.seats[g.turn.seat];
export const isTurn = (g, pid) => currentPid(g) === pid;

function note(g, events, entry) {
  g.seq = (g.seq || 0) + 1;
  // `i` is monotonic for the whole game. The log is capped and splices from the front,
  // so its length is not a usable "what's new" marker for clients.
  const e = { ...entry, n: g.turn.num, i: g.seq };
  g.log.push(e);
  // Sixty was about three rounds at a six-player table: a turn, a roll and a payout each
  // is most of it before anybody has built anything, so the builds and trades people
  // actually want to look back at were shoved off the end within a couple of minutes.
  // The whole log rides in the room document on every write, so this is not free — but
  // an entry is a few dozen bytes and a hundred and sixty of them is single-digit KB,
  // against a game state that is already much larger.
  let over = g.log.length - LOG_KEEP;
  // Oldest routine entries first, but never out of the recent tail. That leaves gaps
  // further back — a build whose roll has gone — which is the trade being made
  // deliberately: entries carry their turn number, so nothing becomes ambiguous, and what
  // survives from the distant past is what somebody would actually look back for.
  let floor = g.log.length - LOG_RECENT;
  for (let i = 0; i < floor && over > 0;) {
    if (LOG_ROUTINE.has(g.log[i].t)) { g.log.splice(i, 1); over -= 1; floor -= 1; } else i += 1;
  }
  // Nothing routine left to give up: the log really is all builds and trades now.
  if (over > 0) g.log.splice(0, over);
  events.push(e);
}

// ---------------------------------------------------------------- placement legality

/** Vertices where `pid` may put a settlement right now. */
export function legalSettlements(g, pid, setupMode = false) {
  const out = [];
  for (const v of VERTS) {
    if (g.bldg[v.i]) continue;
    // Distance rule: no building on any directly adjacent vertex.
    if (v.adj.some((n) => g.bldg[n])) continue;
    // Outside setup a settlement must touch one of your own roads.
    if (!setupMode && !v.edges.some((e) => g.roads[e] === pid)) continue;
    out.push(v.i);
  }
  return out;
}

/** Edges where `pid` may build a road. In setup it must touch the settlement just placed. */
export function legalRoads(g, pid, fromVertex = null) {
  const out = [];
  for (const e of EDGES) {
    if (g.roads[e.i] !== undefined) continue;
    if (fromVertex !== null) {
      if (e.a !== fromVertex && e.b !== fromVertex) continue;
      out.push(e.i);
      continue;
    }
    // Connected to one of your roads or buildings, and an opponent's building on the
    // shared vertex blocks you from running your road through it.
    const touches = [e.a, e.b].some((v) => {
      const b = g.bldg[v];
      if (b && b.p === pid) return true;
      if (b && b.p !== pid) return false; // their building seals this end off
      return VERTS[v].edges.some((x) => g.roads[x] === pid);
    });
    if (touches) out.push(e.i);
  }
  return out;
}

/** Vertices where `pid` may upgrade a settlement to a city. */
export function legalCities(g, pid) {
  return Object.keys(g.bldg)
    .filter((v) => g.bldg[v].p === pid && g.bldg[v].t === 's')
    .map(Number);
}

// ---------------------------------------------------------------- longest road
// Longest path through a player's own road network. Roads are few (15 at most), so a
// depth-first search with backtracking is instant and exact — no need to approximate.
export function longestRoadFor(g, pid) {
  const mine = new Set(Object.keys(g.roads).filter((e) => g.roads[e] === pid).map(Number));
  if (!mine.size) return 0;

  // An opponent's settlement or city cuts a road that would otherwise run through it.
  const blocked = (v) => { const b = g.bldg[v]; return !!b && b.p !== pid; };

  const visited = new Set();
  function extend(v, isStart) {
    if (!isStart && blocked(v)) return 0;
    let best = 0;
    for (const e of VERTS[v].edges) {
      if (!mine.has(e) || visited.has(e)) continue;
      visited.add(e);
      const other = EDGES[e].a === v ? EDGES[e].b : EDGES[e].a;
      best = Math.max(best, 1 + extend(other, false));
      visited.delete(e);
    }
    return best;
  }

  let best = 0;
  const endpoints = new Set();
  for (const e of mine) { endpoints.add(EDGES[e].a); endpoints.add(EDGES[e].b); }
  for (const v of endpoints) best = Math.max(best, extend(v, true));
  return best;
}

// Awards move only on a strict win — a tie leaves the card where it is, which is what
// stops it ping-ponging between two players every turn.
function refreshAwards(g, events) {
  for (const pid of g.seats) g.players[pid].roadLen = longestRoadFor(g, pid);

  // A player who walked out cannot keep an award, and their roads stop counting.
  if (g.award.road && !g.seats.includes(g.award.road)) { g.award.road = null; g.award.roadLen = 0; }
  if (g.award.army && !g.seats.includes(g.award.army)) { g.award.army = null; g.award.armySize = 0; }

  const holder = g.award.road;
  let bestPid = holder;
  let bestLen = holder ? g.players[holder].roadLen : 0;
  for (const pid of g.seats) {
    const len = g.players[pid].roadLen;
    if (len >= 5 && len > bestLen) { bestPid = pid; bestLen = len; }
  }
  // The holder can also lose it outright if their own road gets cut below five.
  if (holder && g.players[holder].roadLen < 5 && bestPid === holder) { bestPid = null; bestLen = 0; }
  if (bestPid !== holder) {
    g.award.road = bestPid;
    g.award.roadLen = bestPid ? g.players[bestPid].roadLen : 0;
    if (bestPid) note(g, events, { t: 'longest', p: bestPid, len: g.players[bestPid].roadLen });
  } else if (bestPid) {
    g.award.roadLen = g.players[bestPid].roadLen;
  }

  const armyHolder = g.award.army;
  let armyPid = armyHolder;
  let armyBest = armyHolder ? g.players[armyHolder].knights : 0;
  for (const pid of g.seats) {
    const k = g.players[pid].knights;
    if (k >= 3 && k > armyBest) { armyPid = pid; armyBest = k; }
  }
  if (armyPid !== armyHolder) {
    g.award.army = armyPid;
    g.award.armySize = armyBest;
    if (armyPid) note(g, events, { t: 'army', p: armyPid, size: armyBest });
  } else if (armyPid) {
    g.award.armySize = g.players[armyPid].knights;
  }
}

// ---------------------------------------------------------------- scoring
/** Points everyone can see: buildings and the two awards. */
export function publicVP(g, pid) {
  let vp = 0;
  for (const v of Object.keys(g.bldg)) {
    const b = g.bldg[v];
    if (b.p === pid) vp += b.t === 'c' ? 2 : 1;
  }
  if (g.award.road === pid) vp += 2;
  if (g.award.army === pid) vp += 2;
  return vp;
}
/** Public points plus the victory-point cards still face down in hand. */
export function totalVP(g, pid) {
  const p = g.players[pid];
  return publicVP(g, pid) + (p.dev.vp || 0) + (p.devNew.vp || 0);
}

function checkWin(g, events) {
  const pid = currentPid(g);
  // Only the player whose turn it is can cross the line, exactly as in the real game.
  if (totalVP(g, pid) >= g.target) {
    g.phase = 'over';
    g.winner = pid;
    note(g, events, { t: 'win', p: pid, vp: totalVP(g, pid) });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- trading rates
/** Best bank rate `pid` can get for a resource: 2 with its own port, 3 with a generic, else 4. */
export function tradeRate(g, board, pid, res) {
  let rate = 4;
  for (const v of Object.keys(g.bldg)) {
    if (g.bldg[v].p !== pid) continue;
    const kind = board.portAt[v];
    if (!kind) continue;
    if (kind === res) return 2;
    if (kind === 'any') rate = Math.min(rate, 3);
  }
  return rate;
}
/**
 * How many cards to select when a resource's card is tapped, given what is already
 * selected, what is in hand, and the bank's rate for it.
 *
 * Cycles through whole trades — one lot, two lots, and so on — then back to nothing, so a
 * tap can always undo itself. A hand that cannot cover even one lot selects all of it
 * instead: those cards are only good for offering to another player, and picking them all
 * up is the next thing you would do.
 *
 * Lives here rather than in the interface because it is the same "what makes a whole
 * trade" question the bank itself asks, and the two must not drift apart.
 */
export function lotAfterTap(cur, have, rate) {
  const lots = Math.floor(have / rate);
  if (!lots) return cur ? 0 : have;
  const wanted = (Math.floor(cur / rate) + 1) * rate;
  return wanted > lots * rate ? 0 : wanted;
}

/** Every port this player is standing on, for the HUD. */
export function portsOwned(g, board, pid) {
  const out = new Set();
  for (const v of Object.keys(g.bldg)) {
    if (g.bldg[v].p === pid) { const k = board.portAt[v]; if (k) out.add(k); }
  }
  return [...out];
}

// ---------------------------------------------------------------- production
// Paying out a roll. The official bank rule is the fiddly bit: if the bank cannot
// cover everyone's claim on a resource, nobody receives that resource at all — unless
// exactly one player is owed it, who then takes whatever is left.
function produce(g, board, roll, events) {
  const claims = {}; // res -> { pid: amount }
  for (const hi of board.byNumber[roll] || []) {
    if (g.useRobber !== false && hi === g.robber) continue;
    const tile = board.tiles[hi];
    if (!tile.res) continue;
    for (const v of HEXES[hi].corners) {
      const b = g.bldg[v];
      if (!b) continue;
      // A player who walked out leaves their buildings on the board — they still block
      // roads and still count for whoever cut them off — but paying them drains the
      // bank into a hand nobody will ever spend.
      if (!g.seats.includes(b.p)) continue;
      const amt = b.t === 'c' ? 2 : 1;
      ((claims[tile.res] ||= {})[b.p] ||= 0);
      claims[tile.res][b.p] += amt;
    }
  }

  const gains = {};
  for (const [res, byPlayer] of Object.entries(claims)) {
    const total = Object.values(byPlayer).reduce((a, b) => a + b, 0);
    const stock = g.bank[res];
    if (total <= stock) {
      for (const [pid, amt] of Object.entries(byPlayer)) {
        g.players[pid].res[res] += amt;
        g.bank[res] -= amt;
        ((gains[pid] ||= {})[res] = ((gains[pid] || {})[res] || 0) + amt);
      }
    } else if (Object.keys(byPlayer).length === 1) {
      const pid = Object.keys(byPlayer)[0];
      if (stock > 0) {
        g.players[pid].res[res] += stock;
        g.bank[res] = 0;
        ((gains[pid] ||= {})[res] = stock);
      }
      note(g, events, { t: 'shortfall', res, partial: true });
    } else {
      note(g, events, { t: 'shortfall', res, partial: false });
    }
  }
  if (Object.keys(gains).length) note(g, events, { t: 'produce', roll, gains });
  else note(g, events, { t: 'nothing', roll });
  return gains;
}

// ---------------------------------------------------------------- turn plumbing
function startTurn(g, events) {
  const pid = currentPid(g);
  const p = g.players[pid];
  // Cards bought last turn become playable now.
  for (const k of Object.keys(p.devNew)) { p.dev[k] += p.devNew[k]; p.devNew[k] = 0; }
  g.turn.dice = null;
  g.turn.rolled = false;
  g.turn.playedDev = false;
  g.turn.freeRoads = 0;
  g.turn.num += 1;
  g.phase = 'roll';
  g.trades = [];
  startClock(g, ROLL_SECONDS);
  note(g, events, { t: 'turn', p: pid });
}

function advanceSeat(g) {
  g.turn.seat = (g.turn.seat + 1) % g.seats.length;
}

/** After the robber lands, who can be robbed? Only players with cards on that hex. */
function stealCandidates(g, hexIndex, pid) {
  const out = new Set();
  for (const v of HEXES[hexIndex].corners) {
    const b = g.bldg[v];
    if (b && b.p !== pid && handSize(g.players[b.p]) > 0) out.add(b.p);
  }
  return [...out];
}

function moveRobber(g, hexIndex, pid, events, rng) {
  g.robber = hexIndex;
  note(g, events, { t: 'robber', p: pid, hex: hexIndex });
  const victims = stealCandidates(g, hexIndex, pid);
  if (victims.length === 0) {
    // The robber landed somewhere with nobody worth robbing. Worth saying, for the same
    // reason as the raid above.
    note(g, events, { t: 'noloot', p: pid });
    g.pending.stealFrom = [];
    resumeTurn(g);
    return;
  }
  if (victims.length === 1) {
    steal(g, pid, victims[0], events, rng);
    resumeTurn(g);
    return;
  }
  g.pending.stealFrom = victims;
  g.phase = 'steal';
  startClock(g, g.turnSeconds);
}

function steal(g, thief, victim, events, rng) {
  const vp = g.players[victim];
  const pool = [];
  for (const r of RESOURCES) for (let i = 0; i < vp.res[r]; i++) pool.push(r);
  if (!pool.length) return null;
  const res = pool[Math.floor(rng() * pool.length)];
  vp.res[res] -= 1;
  g.players[thief].res[res] += 1;
  note(g, events, { t: 'steal', p: thief, from: victim, res });
  return res;
}

/**
 * Where a 7 goes once everyone has discarded.
 *
 * With the robber in play you move it and rob whoever it lands on. With it switched
 * off nobody discards and you simply take a card from any player who has one — a 7
 * stops being a punishment and becomes a small raid.
 * Either way, if there is nobody worth robbing the turn moves on rather than parking on
 * a step with no legal move.
 */
function afterSeven(g, events, rng) {
  if (g.useRobber !== false) { g.phase = 'robber'; startClock(g, g.turnSeconds); return; }
  const pid = currentPid(g);
  const targets = g.seats.filter((s) => s !== pid && handSize(g.players[s]) > 0);
  if (!targets.length) {
    // Nobody is holding anything, so the raid is over before it starts. Recorded, because
    // otherwise a knight is spent and absolutely nothing appears to happen — the single
    // most confusing thing this game can do.
    note(g, events, { t: 'noloot', p: pid });
    resumeTurn(g);
    return;
  }
  // One possible target is not a choice. Asking "who?" of a two-player game — or of any
  // game where only one person is holding cards — is a tap that can only be answered one
  // way. The robber's own path has always taken it automatically; this is the same rule
  // for the raid that replaces it.
  if (targets.length === 1) {
    steal(g, pid, targets[0], events, rng);
    g.pending.stealFrom = [];
    resumeTurn(g);
    return;
  }
  g.pending.stealFrom = targets;
  g.phase = 'take';
  startClock(g, g.turnSeconds);
}

/** Who still owes a discard after a 7. */
function computeDiscards(g) {
  const out = {};
  for (const pid of g.seats) {
    const n = handSize(g.players[pid]);
    if (n > g.discardLimit) out[pid] = Math.floor(n / 2);
  }
  return out;
}

// ---------------------------------------------------------------- running out of time
//
// Nothing here reads a clock — the engine still has no idea what time it is. It only
// answers "if the player on the clock has run out, what should happen?", and the caller
// decides when to ask. Keeping the answer in here means a timed-out human, a sleeping
// phone and a crashed bot all resolve the same way, and it can be tested without one.

/** The best-looking legal corner: production first, then variety. */
function autoSettlement(g, board, pid, setupMode) {
  const spots = legalSettlements(g, pid, setupMode);
  if (!spots.length) return null;
  let best = spots[0], bestScore = -Infinity;
  for (const v of spots) {
    let score = 0;
    const kinds = new Set();
    for (const h of VERTS[v].hexes) {
      const t = board.tiles[h];
      score += pips(t.num);
      if (t.res) kinds.add(t.res);
    }
    score += kinds.size * 1.5;
    if (board.portAt[v]) score += 1;
    if (score > bestScore) { bestScore = score; best = v; }
  }
  return best;
}

/** Of the roads on offer, the one whose far end is worth walking to. */
function autoRoad(g, board, pid, fromVertex) {
  const legal = legalRoads(g, pid, fromVertex);
  if (!legal.length) return null;
  let best = legal[0], bestScore = -Infinity;
  for (const e of legal) {
    const target = fromVertex === null || fromVertex === undefined
      ? EDGES[e].b
      : (EDGES[e].a === fromVertex ? EDGES[e].b : EDGES[e].a);
    let score = 0;
    for (const h of VERTS[target].hexes) score += pips(board.tiles[h].num);
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
}

/** Half a hand for a discard nobody made in time, taken off the biggest piles. */
function autoDiscard(g, pid) {
  const owed = g.pending.discard[pid] || 0;
  const res = {};
  let left = owed;
  const held = g.players[pid].res;
  const order = RESOURCES.slice().sort((a, b) => (held[b] || 0) - (held[a] || 0));
  for (const r of order) {
    if (!left) break;
    const take = Math.min(left, held[r] || 0);
    if (take > 0) { res[r] = take; left -= take; }
  }
  return res;
}

/** What the game should do for itself, and who it acts as. Null when nothing is stalled. */
function timeoutMove(g, board) {
  const up = currentPid(g);
  switch (g.phase) {
    case 'setup': {
      if (g.setup.need === 's') {
        const v = autoSettlement(g, board, up, true);
        return v === null ? null : { pid: up, move: { type: 'setupSettlement', v } };
      }
      const e = autoRoad(g, board, up, g.setup.lastV);
      return e === null ? null : { pid: up, move: { type: 'setupRoad', e } };
    }
    case 'roll':
      return { pid: up, move: { type: 'roll' } };
    case 'discard': {
      // One player per call; the next expiry collects the next one.
      const who = Object.keys(g.pending.discard)[0];
      return who ? { pid: who, move: { type: 'discard', res: autoDiscard(g, who) } } : null;
    }
    case 'robber': {
      const hex = HEXES.map((h) => h.i).find((i) => i !== g.robber);
      return hex === undefined ? null : { pid: up, move: { type: 'moveRobber', hex } };
    }
    case 'steal':
    case 'take': {
      const from = g.pending.stealFrom[0];
      return from ? { pid: up, move: { type: g.phase === 'take' ? 'takeCard' : 'steal', from } } : null;
    }
    case 'build': {
      if (g.turn.freeRoads > 0) {
        const e = autoRoad(g, board, up, null);
        if (e !== null) return { pid: up, move: { type: 'build', what: 'road', e } };
      }
      return { pid: up, move: { type: 'endTurn' } };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- the move dispatcher

const fail = (msg) => ({ ok: false, error: msg });

/**
 * Apply one move. Returns `{ ok, game, events }` on success or `{ ok: false, error }`.
 * `rng` is injected so tests can make dice and steals deterministic.
 */
export function applyMove(state, pid, move, rng = Math.random) {
  const g = clone(state);
  // A game that started on a build where only one offer could exist has no `trades`.
  // Rather than carry the old shape around, the list simply starts empty: a live offer is
  // lost across that one deploy and can be made again, which costs nothing.
  if (!Array.isArray(g.trades)) { g.trades = []; g.tradeIds = g.tradeIds || 0; }
  if (!DISCARD_OPTIONS.includes(g.discardSeconds)) g.discardSeconds = DISCARD_SECONDS;
  const events = [];
  // Rebuilding the board here is also what switches the shared topology to this
  // game's layout, so every rules helper below reads the right island.
  const board = makeBoard(g.seed, g.mode, g.layout);
  const me = g.players[pid];
  if (!me) return fail('You are not in this game.');
  if (g.phase === 'over') return fail('The game is over.');

  const myTurn = isTurn(g, pid);
  const ok = () => ({ ok: true, game: g, events });

  switch (move.type) {
    // ------------------------------------------------------------ setup
    case 'setupSettlement': {
      if (g.phase !== 'setup' || g.setup.need !== 's') return fail('Not placing a settlement.');
      if (!myTurn) return fail('Wait your turn.');
      const v = move.v;
      if (!legalSettlements(g, pid, true).includes(v)) return fail('You cannot build there.');
      g.bldg[v] = { t: 's', p: pid };
      me.left.settlement -= 1;
      g.setup.need = 'r';
      g.setup.lastV = v;
      startClock(g, SETUP_SECONDS, true);
      note(g, events, { t: 'build', p: pid, what: 'settlement', v });

      // The second settlement each player places pays out its surrounding hexes.
      const secondRound = g.setup.at >= g.seats.length;
      if (secondRound) {
        const gains = {};
        for (const hi of VERTS[v].hexes) {
          const tile = board.tiles[hi];
          if (!tile.res || g.bank[tile.res] <= 0) continue;
          me.res[tile.res] += 1;
          g.bank[tile.res] -= 1;
          gains[tile.res] = (gains[tile.res] || 0) + 1;
        }
        if (Object.keys(gains).length) note(g, events, { t: 'produce', roll: 0, gains: { [pid]: gains } });
      }
      return ok();
    }

    case 'setupRoad': {
      if (g.phase !== 'setup' || g.setup.need !== 'r') return fail('Not placing a road.');
      if (!myTurn) return fail('Wait your turn.');
      const e = move.e;
      if (!legalRoads(g, pid, g.setup.lastV).includes(e)) return fail('That road must touch your new settlement.');
      g.roads[e] = pid;
      me.left.road -= 1;
      note(g, events, { t: 'build', p: pid, what: 'road', e });

      g.setup.at += 1;
      g.setup.need = 's';
      g.setup.lastV = null;
      if (g.setup.at >= g.setup.order.length) {
        // Setup finished. The last player to place is also the last to act, so play
        // opens back at seat 0.
        refreshAwards(g, events);
        g.turn.seat = 0;
        g.turn.num = 0;
        startTurn(g, events);
      } else {
        g.turn.seat = g.setup.order[g.setup.at];
        startClock(g, SETUP_SECONDS, true);
      }
      return ok();
    }

    // ------------------------------------------------------------ the roll
    case 'roll': {
      if (!myTurn) return fail('Not your turn.');
      if (g.phase !== 'roll') return fail('You cannot roll now.');
      const d1 = 1 + Math.floor(rng() * 6);
      const d2 = 1 + Math.floor(rng() * 6);
      const roll = d1 + d2;
      g.turn.dice = [d1, d2];
      g.turn.rolled = true;
      note(g, events, { t: 'roll', p: pid, dice: [d1, d2], roll });

      if (roll === 7) {
        // No robber means no discard either: switching it off takes the whole penalty
        // out of a 7, leaving only the raid.
        const owed = g.useRobber === false ? {} : computeDiscards(g);
        if (Object.keys(owed).length) {
          g.pending.discard = owed;
          g.phase = 'discard';
          // The turn's clock stops here and the discard's starts. Whoever is over the
          // limit is choosing at their own pace; the roller is only waiting, and gets a
          // whole allowance back once the table is done — see afterSeven.
          startClock(g, g.discardSeconds || DISCARD_SECONDS, true);
          return ok();
        }
        afterSeven(g, events, rng);
      } else {
        produce(g, board, roll, events);
        g.phase = 'build';
      }
      // Whatever else the roll led to, the acting allowance starts now.
      startClock(g, g.turnSeconds);
      return ok();
    }

    case 'discard': {
      if (g.phase !== 'discard') return fail('Nothing to discard.');
      const owed = g.pending.discard[pid];
      if (!owed) return fail('You do not need to discard.');
      const give = move.res || {};
      const bad = badBundle(give);
      if (bad) return fail(bad);
      const total = Object.values(give).reduce((a, b) => a + b, 0);
      if (total !== owed) return fail(`Discard exactly ${owed}.`);
      for (const [r, n] of Object.entries(give)) {
        if ((me.res[r] || 0) < n) return fail('You do not have those cards.');
      }
      for (const [r, n] of Object.entries(give)) { me.res[r] -= n; g.bank[r] += n; }
      delete g.pending.discard[pid];
      note(g, events, { t: 'discard', p: pid, count: owed });
      if (!Object.keys(g.pending.discard).length) afterSeven(g, events, rng);
      return ok();
    }

    case 'moveRobber': {
      if (!myTurn) return fail('Not your turn.');
      if (g.useRobber === false) return fail('The robber is not in this game.');
      if (g.phase !== 'robber') return fail('You cannot move the robber now.');
      if (move.hex === g.robber) return fail('The robber is already there.');
      if (!(move.hex >= 0 && move.hex < HEXES.length)) return fail('No such tile.');
      moveRobber(g, move.hex, pid, events, rng);
      return ok();
    }

    case 'steal': {
      if (!myTurn) return fail('Not your turn.');
      if (g.phase !== 'steal') return fail('Nobody to rob.');
      if (!g.pending.stealFrom.includes(move.from)) return fail('You cannot rob that player.');
      steal(g, pid, move.from, events, rng);
      g.pending.stealFrom = [];
      resumeTurn(g);
      return ok();
    }

    // Take one card from any player, when the robber is switched off. The card itself
    // is still random: the interface never shows another player's hand, and letting the
    // raider pick the resource would mean showing it.
    case 'takeCard': {
      if (!myTurn) return fail('Not your turn.');
      if (g.phase !== 'take') return fail('Nothing to take right now.');
      if (!g.pending.stealFrom.includes(move.from)) return fail('You cannot take from that player.');
      steal(g, pid, move.from, events, rng);
      g.pending.stealFrom = [];
      resumeTurn(g);
      return ok();
    }

    // ------------------------------------------------------------ building
    case 'build': {
      if (!myTurn) return fail('Not your turn.');
      const free = move.what === 'road' && g.turn.freeRoads > 0;
      if (g.phase !== 'build' && !(g.phase === 'roll' && free)) return fail('Roll the dice first.');

      if (move.what === 'road') {
        if (me.left.road <= 0) return fail('You are out of roads.');
        if (!free && !canAfford(me, COSTS.road)) return fail('You need 1 wood and 1 brick.');
        if (!legalRoads(g, pid).includes(move.e)) return fail('That road has nothing to connect to.');
        if (free) g.turn.freeRoads -= 1; else pay(g, me, COSTS.road);
        g.roads[move.e] = pid;
        me.left.road -= 1;
        note(g, events, { t: 'build', p: pid, what: 'road', e: move.e, free });
        bumpClock(g);
        refreshAwards(g, events);
        if (g.turn.freeRoads > 0 && !legalRoads(g, pid).length) g.turn.freeRoads = 0;
        checkWin(g, events);
        return ok();
      }

      if (move.what === 'settlement') {
        if (me.left.settlement <= 0) return fail('You are out of settlements.');
        if (!canAfford(me, COSTS.settlement)) return fail('You need wood, brick, sheep and wheat.');
        if (!legalSettlements(g, pid).includes(move.v)) return fail('You cannot build there.');
        pay(g, me, COSTS.settlement);
        g.bldg[move.v] = { t: 's', p: pid };
        me.left.settlement -= 1;
        note(g, events, { t: 'build', p: pid, what: 'settlement', v: move.v });
        bumpClock(g);
        // A new settlement can cut an opponent's road, so awards are rechecked.
        refreshAwards(g, events);
        checkWin(g, events);
        return ok();
      }

      if (move.what === 'city') {
        if (me.left.city <= 0) return fail('You are out of cities.');
        if (!canAfford(me, COSTS.city)) return fail('You need 2 wheat and 3 ore.');
        const b = g.bldg[move.v];
        if (!b || b.p !== pid || b.t !== 's') return fail('Upgrade one of your own settlements.');
        pay(g, me, COSTS.city);
        b.t = 'c';
        me.left.city -= 1;
        me.left.settlement += 1; // the settlement piece comes back to your supply
        note(g, events, { t: 'build', p: pid, what: 'city', v: move.v });
        bumpClock(g);
        checkWin(g, events);
        return ok();
      }
      return fail('Unknown build.');
    }

    case 'buyDev': {
      if (!myTurn) return fail('Not your turn.');
      if (g.phase !== 'build') return fail('Roll the dice first.');
      if (!g.deck.length) return fail('The development deck is empty.');
      if (!canAfford(me, COSTS.dev)) return fail('You need sheep, wheat and ore.');
      pay(g, me, COSTS.dev);
      const card = g.deck.pop();
      if (card === 'vp') {
        me.devNew.vp += 1;
        // The five point cards are distinct buildings — draw a name off the shared pile
        // so two players can never both hold "the Library".
        me.vpCards.push(g.vpNames.pop() || 'Victory Point');
      } else {
        me.devNew[card] += 1;
      }
      note(g, events, { t: 'buyDev', p: pid });
      bumpClock(g);
      checkWin(g, events); // a victory-point card can be the winning card
      return ok();
    }

    // ------------------------------------------------------------ development cards
    case 'playDev': {
      if (!myTurn) return fail('Not your turn.');
      const kind = move.card;
      if (kind === 'vp') return fail('Victory point cards are never played.');
      // A knight may be played before rolling; everything else waits for the roll.
      const okPhase = kind === 'knight' ? (g.phase === 'roll' || g.phase === 'build') : g.phase === 'build';
      if (!okPhase) return fail('You cannot play that right now.');
      if (g.turn.playedDev) return fail('One development card per turn.');
      if ((me.dev[kind] || 0) <= 0) {
        return (me.devNew[kind] || 0) > 0
          ? fail('You bought that this turn — it can be played from next turn.')
          : fail('You do not hold that card.');
      }
      me.dev[kind] -= 1;
      g.turn.playedDev = true;
      note(g, events, { t: 'playDev', p: pid, card: kind });
      bumpClock(g);

      if (kind === 'knight') {
        me.knights += 1;
        refreshAwards(g, events);
        // A knight is a robber move, so without a robber it is a raid instead.
        afterSeven(g, events, rng);
        checkWin(g, events); // Largest Army can be the winning move
        return ok();
      }
      if (kind === 'road') {
        g.turn.freeRoads = Math.min(2, me.left.road);
        if (!legalRoads(g, pid).length) g.turn.freeRoads = 0;
        return ok();
      }
      if (kind === 'plenty') {
        const take = move.res || {};
        const badTake = badBundle(take);
        if (badTake) return fail(badTake);
        const total = Object.values(take).reduce((a, b) => a + b, 0);
        if (total !== 2) return fail('Choose exactly two resources.');
        for (const [r, n] of Object.entries(take)) {
          if (g.bank[r] < n) return fail(`The bank is out of ${r}.`);
        }
        for (const [r, n] of Object.entries(take)) { me.res[r] += n; g.bank[r] -= n; }
        note(g, events, { t: 'plenty', p: pid, res: take });
        return ok();
      }
      if (kind === 'mono') {
        const r = move.res;
        if (!RESOURCES.includes(r)) return fail('Name a resource.');
        let taken = 0;
        for (const other of g.seats) {
          if (other === pid) continue;
          const n = g.players[other].res[r] || 0;
          g.players[other].res[r] = 0;
          me.res[r] += n;
          taken += n;
        }
        note(g, events, { t: 'mono', p: pid, res: r, count: taken });
        return ok();
      }
      return fail('Unknown card.');
    }

    // ------------------------------------------------------------ trading
    /**
     * A whole basket at the bank, in one move.
     *
     * The bank has always dealt in single swaps, which meant six wood at 2:1 was three
     * separate trades and three separate taps — and if the third one failed you were left
     * halfway through something you had asked for as one thing. Now it takes any bundle
     * either way and settles it atomically.
     *
     * Each given resource is priced at its own rate, which is the part worth having in
     * one place: a player with a 2:1 wood port can put in four wood and four brick and
     * get three cards back — two for the wood, one for the brick — and no interface
     * should be doing that sum on its own.
     */
    case 'bankTrade': {
      if (!myTurn) return fail('Not your turn.');
      if (g.phase !== 'build') return fail('Roll the dice first.');
      const give = move.give || {}, want = move.want || {};
      const badBank = badBundle(give) || badBundle(want);
      if (badBank) return fail(badBank);

      const giving = Object.entries(give).filter(([, n]) => n > 0);
      const wanting = Object.entries(want).filter(([, n]) => n > 0);
      if (!giving.length || !wanting.length) return fail('Offer something and ask for something.');
      for (const [r] of wanting) {
        if (give[r]) return fail('Asking for what you are handing over.');
      }

      // What the given cards are worth, in cards back. A remainder means some of them
      // would simply vanish, so it is refused rather than quietly swallowed.
      let credits = 0;
      for (const [r, n] of giving) {
        const rate = tradeRate(g, board, pid, r);
        if (n % rate !== 0) return fail(`${n} ${r} is not a whole number of ${rate}:1 trades.`);
        if ((me.res[r] || 0) < n) return fail(`You do not have ${n} ${r}.`);
        credits += n / rate;
      }
      const asked = wanting.reduce((t, [, n]) => t + n, 0);
      if (credits !== asked) return fail(`That buys ${credits}, and you asked for ${asked}.`);
      for (const [r, n] of wanting) {
        if ((g.bank[r] || 0) < n) return fail(`The bank does not have ${n} ${r}.`);
      }

      for (const [r, n] of giving) { me.res[r] -= n; g.bank[r] += n; }
      for (const [r, n] of wanting) { me.res[r] += n; g.bank[r] -= n; }
      note(g, events, { t: 'bankTrade', p: pid, give, want });
      bumpClock(g);
      return ok();
    }

    case 'offerTrade': {
      if (!myTurn) return fail('Only the player whose turn it is can open a trade.');
      if (g.phase !== 'build') return fail('Roll the dice first.');
      const give = move.give || {}, want = move.want || {};
      const badGive = badBundle(give) || badBundle(want);
      if (badGive) return fail(badGive);
      const gTotal = Object.values(give).reduce((a, b) => a + b, 0);
      const wTotal = Object.values(want).reduce((a, b) => a + b, 0);
      if (gTotal <= 0 || wTotal <= 0) return fail('Offer something and ask for something.');
      for (const [r, n] of Object.entries(give)) if ((me.res[r] || 0) < n) return fail('You do not have that to give.');
      if (g.trades.filter((t) => t.from === pid).length >= MAX_OFFERS) {
        return fail(`You can have ${MAX_OFFERS} offers out at once.`);
      }

      // Offers are checked against the hand one at a time, not against all of them added
      // up. Putting the same sheep in front of two people is a normal thing to do — you
      // want whichever of them bites first, not both — and acceptTrade re-checks the hand
      // at the moment it closes, so the second one simply fails rather than conjuring a
      // card that is already gone.
      g.trades.push({ id: ++g.tradeIds, from: pid, give, want, replies: {} });
      note(g, events, { t: 'offer', p: pid, give, want });
      // Waiting on other people should not cost you the turn you are waiting during.
      bumpClock(g);
      return ok();
    }

    case 'replyTrade': {
      const offer = g.trades.find((t) => t.id === move.id);
      if (!offer) return fail('That offer is no longer on the table.');
      if (offer.from === pid) return fail('You made this offer.');
      // Only accept if you can actually pay — saves a dead-end handshake.
      if (move.yes) {
        for (const [r, n] of Object.entries(offer.want)) {
          if ((me.res[r] || 0) < n) return fail('You do not have what they asked for.');
        }
      }
      offer.replies[pid] = move.yes ? 'yes' : 'no';
      // Nobody left to hear from and nobody said yes. An offer in that state is not
      // pending, it is finished — leaving it on the table asks its author to notice four
      // separate "Declined" rows and tidy it away themselves.
      const others = g.seats.filter((s) => s !== offer.from);
      if (others.length && others.every((s) => offer.replies[s] === 'no')) {
        g.trades = g.trades.filter((t) => t.id !== offer.id);
        note(g, events, { t: 'declined', p: offer.from, give: offer.give, want: offer.want });
      }
      return ok();
    }

    case 'acceptTrade': {
      const deal = g.trades.find((t) => t.id === move.id);
      if (!deal) return fail('That offer is no longer on the table.');
      if (deal.from !== pid) return fail('Only the player who offered can close the trade.');
      const withPid = move.with;
      if (deal.replies[withPid] !== 'yes') return fail('They have not accepted.');
      const them = g.players[withPid];
      // Re-check both hands. An offer may have been sitting while things changed — and
      // with several offers live at once, closing one can be what empties the hand the
      // next one was promising.
      for (const [r, n] of Object.entries(deal.give)) if ((me.res[r] || 0) < n) return fail('You no longer have that.');
      for (const [r, n] of Object.entries(deal.want)) if ((them.res[r] || 0) < n) return fail('They no longer have that.');
      for (const [r, n] of Object.entries(deal.give)) { me.res[r] -= n; them.res[r] += n; }
      for (const [r, n] of Object.entries(deal.want)) { them.res[r] -= n; me.res[r] += n; }
      note(g, events, { t: 'trade', p: pid, with: withPid, give: deal.give, want: deal.want });
      bumpClock(g);
      // Only this one closes. The rest stay up; they are separate offers.
      g.trades = g.trades.filter((t) => t.id !== deal.id);
      return ok();
    }

    // An offer whose time ran out. Separate from cancelTrade because the deadline is a
    // fact about the offer rather than a change of mind, and because it says so in the
    // log — a strip vanishing on its own with no word for it reads as a fault.
    case 'expireTrade': {
      const offer = g.trades.find((t) => t.id === move.id);
      if (!offer) return fail('That offer is already gone.');
      // Any player at the table, not just whoever made it. The deadline is public — it
      // is stamped on the room where every device can read it — and the engine has no
      // clock of its own to check it against, exactly as with `timeout`. Restricting it
      // to the author meant an offer from somebody whose app had gone to sleep, or from
      // a bot, could never be retired at all: it sat on everyone else's screen for the
      // rest of the turn with its counter stopped at zero.
      if (!g.seats.includes(pid)) return fail('Not seated.');
      g.trades = g.trades.filter((t) => t.id !== offer.id);
      note(g, events, { t: 'expired', p: pid, give: offer.give, want: offer.want });
      return ok();
    }

    case 'cancelTrade': {
      const mine = g.trades.filter((t) => t.from === pid);
      if (!mine.length) return fail('Nothing to cancel.');
      // No id withdraws the lot, which is what the "clear" control sends.
      const before = g.trades.length;
      g.trades = move.id === undefined || move.id === null
        ? g.trades.filter((t) => t.from !== pid)
        : g.trades.filter((t) => !(t.id === move.id && t.from === pid));
      if (g.trades.length === before) return fail('Not your offer.');
      return ok();
    }

    // ------------------------------------------------------------ end of turn
    case 'endTurn': {
      if (!myTurn) return fail('Not your turn.');
      if (g.phase !== 'build') return fail('You still have something to do.');
      if (g.turn.freeRoads > 0) return fail('Place your free roads first.');
      g.trades = [];
      g.pending.stealFrom = [];
      advanceSeat(g);
      startTurn(g, events);
      return ok();
    }

    // A player disconnected or quit. Their stuff stays on the board (it still blocks
    // roads and scores), but the turn never waits on them again.
    case 'dropPlayer': {
      const gone = move.who;
      if (!g.seats.includes(gone)) return fail('Not seated.');
      if (g.seats.length <= 2) {
        g.phase = 'over';
        g.winner = g.seats.find((s) => s !== gone) || null;
        note(g, events, { t: 'abandoned', p: gone });
        return ok();
      }
      const idx = g.seats.indexOf(gone);
      const wasTheirTurn = g.turn.seat === idx;
      g.seats.splice(idx, 1);
      if (g.turn.seat > idx) g.turn.seat -= 1;
      if (g.turn.seat >= g.seats.length) g.turn.seat = 0;
      delete g.pending.discard[gone];
      g.pending.stealFrom = g.pending.stealFrom.filter((x) => x !== gone);
      g.trades = g.trades.filter((t) => t.from !== gone);
      for (const t of g.trades) delete t.replies[gone];
      note(g, events, { t: 'left', p: gone });
      if (g.phase === 'setup') {
        // Rebuilding the snake mid-setup is not worth the corner cases — drop the
        // departed seat's remaining slots and carry on with who is left.
        // The pointer has to move back by however many of the departed player's slots
        // were already behind it. Clamping it to the new length instead — which is what
        // this did — leaves it pointing at a different player's slot, so somebody gets
        // skipped and somebody else places twice.
        const doneRemoved = g.setup.order.slice(0, g.setup.at).filter((sx) => sx === idx).length;
        g.setup.order = g.setup.order.filter((sx) => sx !== idx).map((sx) => (sx > idx ? sx - 1 : sx));
        g.setup.at = Math.max(0, Math.min(g.setup.at - doneRemoved, g.setup.order.length));

        // Only the departing player's own half-finished placement is abandoned. Resetting
        // this unconditionally threw away the settlement somebody ELSE had just put down
        // and sent them back to place another one, so that player ended the opening with
        // three settlements and one road.
        if (wasTheirTurn) {
          g.setup.need = 's';
          g.setup.lastV = null;
        }

        if (g.setup.at >= g.setup.order.length) {
          refreshAwards(g, events);
          g.turn.seat = 0; g.turn.num = 0;
          startTurn(g, events);
        } else {
          g.turn.seat = g.setup.order[g.setup.at];
          startClock(g, SETUP_SECONDS, true);
        }
      } else if (wasTheirTurn) {
        startTurn(g, events);
      } else if (g.phase === 'discard' && !Object.keys(g.pending.discard).length) {
        // Straight to 'robber' was wrong in a game with the robber switched off: that
        // phase has no legal move there, so the turn parked and never came back.
        afterSeven(g, events, rng);
      }
      refreshAwards(g, events);
      return ok();
    }

    /**
     * The clock ran out. Any player at the table may send this.
     *
     * It has to be sendable by anyone, because the commonest reason a turn stalls is
     * that the phone whose turn it is has gone to sleep — the one device that cannot
     * report it. Every device watches the same server-stamped deadline, so they all
     * reach the same conclusion; whoever's transaction lands first does the work and the
     * rest find the turn already moved on.
     *
     * It is not a way to act as somebody else: the move is chosen here, from the phase,
     * and it is always the move the game was already waiting for.
     */
    case 'timeout': {
      if (!g.seats.includes(pid)) return fail('Not seated.');
      const auto = timeoutMove(g, board);
      if (!auto) return fail('Nothing to force.');
      // Re-entered from the original state so the move is credited to, and validated
      // against, the player who actually owed it.
      return applyMove(state, auto.pid, auto.move, rng);
    }

    default:
      return fail('Unknown move.');
  }
}

// ---------------------------------------------------------------- read-only helpers
// Small queries the UI asks constantly. Kept here so the interface never has to
// re-derive a rule the engine already knows.

export function whatCanIBuild(g, pid) {
  const p = g.players[pid];
  if (!p || !isTurn(g, pid) || g.phase !== 'build') {
    return { road: false, settlement: false, city: false, dev: false };
  }
  return {
    road: canAfford(p, COSTS.road) && p.left.road > 0 && legalRoads(g, pid).length > 0,
    settlement: canAfford(p, COSTS.settlement) && p.left.settlement > 0 && legalSettlements(g, pid).length > 0,
    city: canAfford(p, COSTS.city) && p.left.city > 0 && legalCities(g, pid).length > 0,
    dev: canAfford(p, COSTS.dev) && g.deck.length > 0,
  };
}

/** Everything the board needs to highlight for the move in progress. */
export function highlightsFor(g, pid) {
  if (g.phase === 'setup' && isTurn(g, pid)) {
    return g.setup.need === 's'
      ? { verts: legalSettlements(g, pid, true), edges: [], hexes: [], cities: [] }
      : { verts: [], edges: legalRoads(g, pid, g.setup.lastV), hexes: [], cities: [] };
  }
  if (g.phase === 'robber' && isTurn(g, pid)) {
    return { verts: [], edges: [], cities: [], hexes: HEXES.map((h) => h.i).filter((i) => i !== g.robber) };
  }
  if (g.phase === 'take') return { verts: [], edges: [], hexes: [], cities: [] };

  if (g.phase !== 'build' || !isTurn(g, pid)) return { verts: [], edges: [], hexes: [], cities: [] };

  // Free roads from a Road Building card have to be placed before anything else, so
  // nothing else is offered.
  if (g.turn.freeRoads > 0) {
    return { verts: [], edges: legalRoads(g, pid), hexes: [], cities: [] };
  }

  /**
   * Everything affordable, all at once.
   *
   * The three never collide, which is what makes this safe to do without asking first.
   * Roads are edges. A settlement spot is an empty corner and an upgrade is a corner with
   * your own settlement already on it, so no vertex can mean two things — a tap resolves
   * to exactly one action by where it landed.
   */
  const p = g.players[pid];
  return {
    edges: canAfford(p, COSTS.road) && p.left.road > 0 ? legalRoads(g, pid) : [],
    verts: canAfford(p, COSTS.settlement) && p.left.settlement > 0 ? legalSettlements(g, pid) : [],
    cities: canAfford(p, COSTS.city) && p.left.city > 0 ? legalCities(g, pid) : [],
    hexes: [],
  };
}

/** True when the engine is waiting on this player specifically. */
export function waitingOn(g, pid) {
  if (g.phase === 'over') return false;
  if (g.phase === 'discard') return !!g.pending.discard[pid];
  if (g.trades.some((t) => t.from !== pid && !t.replies[pid])) return true;
  return isTurn(g, pid);
}
