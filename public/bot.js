// HexColony bots.
//
// A bot is a pure function: given a game, a board and a seat, it returns the single
// next move it wants to make. It never touches the state — the caller feeds the move
// through the same `applyMove` a human's tap goes through, so a bot cannot cheat, and
// a bot that tries something illegal is simply rejected like anyone else.
//
// The three difficulties are one brain with the knobs turned. Nothing is hidden from
// the easy bot that the hard bot can see; the hard bot just reasons further and adds
// less noise to its own conclusions. That keeps "hard" honest — it is playing better,
// not peeking.

import { VERTS, HEXES, RESOURCES, pips } from './board.js';
import * as R from './rules.js';

export const LEVELS = {
  easy: {
    label: 'Easy',
    blurb: 'Takes a decent corner, asks for a card now and then, and is slow to reach for the robber.',
    noise: 5,            // random points added to every judgement
    robberSmart: 0.25,   // chance of aiming the robber rather than dropping it anywhere
    bankTrade: 0.45,     // willingness to convert spare cards toward a goal
    devPlay: 0.55,       // chance of remembering to play a card it holds
    offerTrade: 0.15,    // chance of asking the table for what it is short of
    asksPerTurn: 1,      // how many times in one turn it will put something to the table
    acceptBias: 0.55,    // how readily it accepts an offered trade
    denyLeader: false,   // does it refuse to help whoever is winning
    roadPlan: false,     // does it build roads toward somewhere worth going
  },
  medium: {
    label: 'Medium',
    blurb: 'Plays the odds, upgrades to cities, trades to fill a gap, and puts the robber where it hurts.',
    noise: 1,
    robberSmart: 0.92,
    bankTrade: 0.95,
    devPlay: 0.95,
    offerTrade: 0.7,
    asksPerTurn: 1,
    acceptBias: 0.35,
    denyLeader: false,
    roadPlan: true,
  },
  hard: {
    label: 'Hard',
    blurb: 'Works the table for the card it needs, chases the cheapest points, blocks the leader, and will not trade with a winner.',
    noise: 0,
    robberSmart: 1,
    bankTrade: 1,
    devPlay: 1,
    offerTrade: 0.95,
    // Two goes at the table in a turn, where the others get one. The first ask is often
    // refused for a reason that has nothing to do with the price — nobody happened to
    // hold it — and asking again for something else is exactly what a person does next.
    asksPerTurn: 2,
    acceptBias: 0.25,
    denyLeader: true,
    roadPlan: true,
  },
};

const BOT_NAMES = ['Astrid', 'Bjorn', 'Cora', 'Dag', 'Eira', 'Finn', 'Greta', 'Hakon'];

/** Seat descriptors for `count` bots, in colours the human has not taken. */
export function makeBots(count, level, avoidColour = 0) {
  const picked = [];
  const names = BOT_NAMES.slice();
  let colour = 0;
  for (let i = 0; i < count; i++) {
    if (colour === avoidColour) colour++;
    const n = Math.floor(Math.random() * names.length);
    picked.push({
      id: `bot${i + 1}`,
      name: names.splice(n, 1)[0],
      colorIdx: colour++,
      level,
      bot: true,
    });
  }
  return picked;
}

const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// ---------------------------------------------------------------- board judgement

/** Every resource this player's buildings already produce. */
function myResources(g, board, pid) {
  const out = new Set();
  for (const [v, b] of Object.entries(g.bldg)) {
    if (b.p !== pid) continue;
    for (const h of VERTS[v].hexes) {
      const res = board.tiles[h].res;
      if (res) out.add(res);
    }
  }
  return out;
}

/**
 * What a corner is worth to this player. Production is the base, but a spot that adds
 * a resource you cannot otherwise make is worth far more than its dots suggest — a
 * player with no brick or ore cannot build anything at all, which is the single most
 * common way a promising opening dies.
 */
function vertexScore(g, board, v, pid, have) {
  let score = 0;
  const kinds = new Set();
  for (const h of VERTS[v].hexes) {
    const t = board.tiles[h];
    score += pips(t.num);
    if (t.res) kinds.add(t.res);
  }
  for (const res of kinds) {
    if (have.has(res)) continue;
    score += (res === 'brick' || res === 'ore') ? 8 : 5;
  }
  score += kinds.size * 1.5;                       // spread beats a double-up
  const port = board.portAt[v];
  if (port) score += port === 'any' ? 1.5 : (kinds.has(port) || have.has(port)) ? 3 : 1;
  return score;
}

/** Rank the legal corners, best first, with difficulty noise folded in. */
function rankSettlements(g, board, pid, cfg, rng, setup = false) {
  const have = myResources(g, board, pid);
  return R.legalSettlements(g, pid, setup)
    .map((v) => ({ v, s: vertexScore(g, board, v, pid, have) + rng() * cfg.noise }))
    .sort((a, b) => b.s - a.s);
}

/**
 * The road that best opens up somewhere worth settling.
 *
 * Roads are only worth building for what they reach, so each candidate is actually
 * tried: drop it on a scratch copy, ask the rules which corners that makes legal, and
 * score the best one. A road that unlocks nothing scores nothing.
 */
function bestRoad(g, board, pid, cfg, rng) {
  const legal = R.legalRoads(g, pid);
  if (!legal.length) return null;
  if (!cfg.roadPlan) return { e: pick(rng, legal), s: 0 };

  const have = myResources(g, board, pid);
  const before = new Set(R.legalSettlements(g, pid));
  const scratch = clone(g);
  let best = null;

  for (const e of legal) {
    scratch.roads[e] = pid;
    let gain = 0;
    for (const v of R.legalSettlements(scratch, pid)) {
      if (before.has(v)) continue;
      gain = Math.max(gain, vertexScore(scratch, board, v, pid, have));
    }
    // A road is also worth something on its own once Longest Road is in reach.
    const len = R.longestRoadFor(scratch, pid);
    const holder = g.award.road;
    const target = holder && holder !== pid ? g.players[holder].roadLen : 4;
    if (len > target) gain += 6;
    else if (len >= target - 1) gain += 2;

    delete scratch.roads[e];
    const s = gain + rng() * cfg.noise;
    if (!best || s > best.s) best = { e, s };
  }
  return best;
}

// ---------------------------------------------------------------- the robber

/** Where the robber hurts most: good tiles that feed rivals and not us. */
function robberTarget(g, board, pid, cfg, rng) {
  const options = HEXES.map((h) => h.i).filter((i) => i !== g.robber);
  if (rng() > cfg.robberSmart) return pick(rng, options);

  const leader = g.seats
    .filter((s) => s !== pid)
    .sort((a, b) => R.publicVP(g, b) - R.publicVP(g, a))[0];

  let best = null;
  for (const i of options) {
    const tile = board.tiles[i];
    if (!tile.res) continue;                       // the desert robs nobody
    let score = 0, touchesMe = false;
    for (const v of HEXES[i].corners) {
      const b = g.bldg[v];
      if (!b) continue;
      if (b.p === pid) { touchesMe = true; continue; }
      const worth = pips(tile.num) * (b.t === 'c' ? 2 : 1);
      score += worth;
      if (R.handSize(g.players[b.p]) > 0) score += 2;
      if (cfg.denyLeader && b.p === leader) score += worth;
    }
    if (touchesMe) score -= 100;                   // never rob yourself
    if (score <= 0) continue;
    const s = score + rng() * cfg.noise;
    if (!best || s > best.s) best = { i, s };
  }
  return best ? best.i : pick(rng, options);
}

// ---------------------------------------------------------------- shopping

const NEEDS = {
  city: R.COSTS.city,
  settlement: R.COSTS.settlement,
  dev: R.COSTS.dev,
  road: R.COSTS.road,
};

/** What is this bot saving up for? Cheapest route to the next point, roughly. */
function goal(g, board, pid, cfg) {
  const p = g.players[pid];
  if (p.left.city > 0 && R.legalCities(g, pid).length) return 'city';
  if (p.left.settlement > 0 && R.legalSettlements(g, pid).length) return 'settlement';
  if (p.left.settlement > 0 && cfg.roadPlan) return 'road';
  if (g.deck.length) return 'dev';
  return 'road';
}

/** Cards still missing for a target, and the ones we can spare. */
function shortfall(p, cost) {
  const need = {};
  for (const [res, n] of Object.entries(cost)) {
    const short = n - (p.res[res] || 0);
    if (short > 0) need[res] = short;
  }
  return need;
}

function surplusFor(p, cost) {
  const spare = {};
  for (const res of RESOURCES) {
    const keep = cost[res] || 0;
    const extra = (p.res[res] || 0) - keep;
    if (extra > 0) spare[res] = extra;
  }
  return spare;
}

// ---------------------------------------------------------------- the brain

/**
 * The bot's next move, or null if it has nothing it wants to do (the caller should
 * then end its turn). Never mutates `game`.
 */
export function botMove(game, board, pid, level, rng = Math.random) {
  const cfg = LEVELS[level] || LEVELS.medium;
  const g = game;
  const p = g.players[pid];
  if (!p || g.phase === 'over') return null;

  // ---- things owed regardless of whose turn it is
  if (g.phase === 'discard' && g.pending.discard[pid]) {
    return { type: 'discard', res: chooseDiscard(g, board, pid, cfg, rng) };
  }

  // Answer the oldest offer still waiting on us; the rest come round on later calls.
  const asked = (g.trades || []).find((t) => t.from !== pid && !t.replies[pid]);
  if (asked) {
    return { type: 'replyTrade', id: asked.id, yes: judgeTrade(g, asked, board, pid, cfg, rng) };
  }

  if (!R.isTurn(g, pid)) return null;

  // ---- an offer of ours that the table has finished answering
  //
  // Reached only once everybody has replied: while somebody is still thinking, neither
  // the app's botActor nor the tournament hands the turn back to us. An offer nobody
  // wanted has already taken itself off the table by then — the engine drops it on the
  // last "no" — so in practice this is here to close a deal, and the withdrawal is the
  // belt and braces.
  const ours = (g.trades || []).find((t) => t.from === pid);
  if (ours) {
    const yes = g.seats.find((s) => s !== pid && ours.replies[s] === 'yes');
    if (yes) return { type: 'acceptTrade', id: ours.id, with: yes };
    if (g.seats.some((s) => s !== pid && !ours.replies[s])) return null;
    return { type: 'cancelTrade', id: ours.id };
  }

  // ---- setup
  if (g.phase === 'setup') {
    if (g.setup.need === 's') {
      const ranked = rankSettlements(g, board, pid, cfg, rng, true);
      return ranked.length ? { type: 'setupSettlement', v: ranked[0].v } : null;
    }
    const legal = R.legalRoads(g, pid, g.setup.lastV);
    if (!legal.length) return null;
    if (!cfg.roadPlan) return { type: 'setupRoad', e: pick(rng, legal) };
    // Point the first road at the best corner it could eventually reach.
    const have = myResources(g, board, pid);
    let best = legal[0], bv = -Infinity;
    for (const e of legal) {
      const scratch = clone(g);
      scratch.roads[e] = pid;
      let v = 0;
      for (const cand of R.legalSettlements(scratch, pid)) {
        v = Math.max(v, vertexScore(scratch, board, cand, pid, have));
      }
      if (v > bv) { bv = v; best = e; }
    }
    return { type: 'setupRoad', e: best };
  }

  // ---- robber business
  if (g.phase === 'robber') return { type: 'moveRobber', hex: robberTarget(g, board, pid, cfg, rng) };

  // 'take' is the no-robber version of the same decision: pick a victim, no tile move.
  if (g.phase === 'steal' || g.phase === 'take') {
    const victims = g.pending.stealFrom;
    if (!victims.length) return null;
    const ranked = victims.slice().sort((a, b) => {
      const ha = R.handSize(g.players[a]), hb = R.handSize(g.players[b]);
      if (cfg.denyLeader) return (R.publicVP(g, b) * 3 + hb) - (R.publicVP(g, a) * 3 + ha);
      return hb - ha;
    });
    const type = g.phase === 'take' ? 'takeCard' : 'steal';
    return { type, from: cfg.robberSmart > rng() ? ranked[0] : pick(rng, victims) };
  }

  // ---- before the roll
  if (g.phase === 'roll') {
    // A knight before rolling clears the robber off your own tile in time to matter.
    // With the robber switched off there is no tile to be sitting on — and no index
    // either, since g.robber is -1 in that game.
    const robbedByMe = g.useRobber !== false && g.robber >= 0
      && HEXES[g.robber].corners.some((v) => g.bldg[v]?.p === pid);
    if (p.dev.knight > 0 && !g.turn.playedDev && robbedByMe && rng() < cfg.devPlay) {
      return { type: 'playDev', card: 'knight' };
    }
    return { type: 'roll' };
  }

  if (g.phase !== 'build') return null;

  // ---- free roads from a Road Building card must be placed before anything else
  if (g.turn.freeRoads > 0) {
    const road = bestRoad(g, board, pid, cfg, rng);
    return road ? { type: 'build', what: 'road', e: road.e } : null;
  }

  // ---- development cards
  if (!g.turn.playedDev && rng() < cfg.devPlay) {
    const dev = playableDev(g, board, pid, cfg, rng);
    if (dev) return dev;
  }

  // ---- build the best thing we can afford
  const can = R.whatCanIBuild(g, pid);
  if (can.city) {
    const cities = R.legalCities(g, pid);
    const best = cities
      .map((v) => ({ v, s: VERTS[v].hexes.reduce((a, h) => a + pips(board.tiles[h].num), 0) + rng() * cfg.noise }))
      .sort((a, b) => b.s - a.s)[0];
    return { type: 'build', what: 'city', v: best.v };
  }
  if (can.settlement) {
    const ranked = rankSettlements(g, board, pid, cfg, rng);
    if (ranked.length) return { type: 'build', what: 'settlement', v: ranked[0].v };
  }

  const want = goal(g, board, pid, cfg);

  if (want === 'road' && can.road) {
    const road = bestRoad(g, board, pid, cfg, rng);
    // Only spend on a road that actually reaches something, unless cards are piling up.
    if (road && (road.s > 4 || R.handSize(p) > 6)) return { type: 'build', what: 'road', e: road.e };
  }
  if (can.dev && (want === 'dev' || R.handSize(p) > 8)) return { type: 'buyDev' };

  // ---- ask the table before paying the bank's rate
  //
  // Before, not after: two of something for the one card you need beats every bank rate
  // but a two-for-one port, and the worst that happens is three people say no and the
  // bank is still there. Capped at one ask per turn per bot — the engine closes an
  // offer the moment the last player declines, so without the cap a bot could stand
  // there asking the same table the same question all turn.
  if (rng() < (cfg.offerTrade || 0) && g.seats.length > 1
      && asksThisTurn(g, pid) < (cfg.asksPerTurn || 1)) {
    const offer = findTableOffer(g, board, pid, NEEDS[want] || NEEDS.road);
    if (offer) return offer;
  }

  // ---- convert spare cards toward whatever we are saving for
  if (rng() < cfg.bankTrade) {
    const trade = findBankTrade(g, board, pid, NEEDS[want] || NEEDS.road);
    if (trade) return trade;
  }

  // Holding more than seven cards into someone else's 7 is how you lose half of them.
  if (R.handSize(p) > 7 && can.dev) return { type: 'buyDev' };

  return { type: 'endTurn' };
}

/** How many times this bot has put something to the table this turn. */
function asksThisTurn(g, pid) {
  return (g.log || []).filter((e) => e.t === 'offer' && e.p === pid && e.n === g.turn.num).length;
}

/**
 * Something to put to the table, or null.
 *
 * Two cards it can spare for one it is short of. That is a real offer rather than a
 * lowball — it beats 4:1 and 3:1 handily, so somebody sitting on a spare is likely to
 * take it, and it still costs less than the bank would. Where the bot holds the matching
 * two-for-one port it does not ask at all: the bank is already that cheap and the bank
 * never says no.
 */
function findTableOffer(g, board, pid, cost) {
  const p = g.players[pid];
  const need = Object.keys(shortfall(p, cost));
  if (!need.length) return null;
  // Where a bot gets more than one go, the second has to be a different question — the
  // table has already answered the first one.
  const asked = new Set((g.log || [])
    .filter((e) => e.t === 'offer' && e.p === pid && e.n === g.turn.num)
    .flatMap((e) => Object.keys(e.want || {})));
  const open = need.filter((r) => !asked.has(r));
  if (!open.length) return null;
  const spare = surplusFor(p, cost);
  for (const give of Object.keys(spare).sort((a, b) => spare[b] - spare[a])) {
    if (spare[give] < 2) continue;
    if (R.tradeRate(g, board, pid, give) <= 2) continue;
    const want = open.find((w) => w !== give);
    if (!want) continue;
    return { type: 'offerTrade', give: { [give]: 2 }, want: { [want]: 1 } };
  }
  return null;
}

/** A 4:1 (or better) swap that moves us closer to the current goal. */
function findBankTrade(g, board, pid, cost) {
  const p = g.players[pid];
  const need = shortfall(p, cost);
  const wanted = Object.keys(need);
  if (!wanted.length) return null;
  const spare = surplusFor(p, cost);
  for (const give of Object.keys(spare).sort((a, b) => spare[b] - spare[a])) {
    const rate = R.tradeRate(g, board, pid, give);
    if (spare[give] < rate) continue;
    for (const want of wanted) {
      if (want === give || g.bank[want] <= 0) continue;
      return { type: 'bankTrade', give: { [give]: rate }, want: { [want]: 1 } };
    }
  }
  return null;
}

/** Which card to play, if any is worth playing right now. */
function playableDev(g, board, pid, cfg, rng) {
  const p = g.players[pid];
  if (p.dev.knight > 0) {
    // Three knights is Largest Army and two points; before that a knight is a robber.
    const wantsArmy = p.knights + 1 >= 3 && (!g.award.army || g.award.army === pid
      || g.players[g.award.army].knights < p.knights + 1);
    if (wantsArmy || rng() < 0.5) return { type: 'playDev', card: 'knight' };
  }
  if (p.dev.mono > 0) {
    // Worth it only if the table is actually holding some of it.
    let best = null;
    for (const res of RESOURCES) {
      const total = g.seats.filter((s) => s !== pid).reduce((n, s) => n + (g.players[s].res[res] || 0), 0);
      if (!best || total > best.n) best = { res, n: total };
    }
    if (best && best.n >= 3) return { type: 'playDev', card: 'mono', res: best.res };
  }
  if (p.dev.plenty > 0) {
    const want = goal(g, board, pid, cfg);
    const need = shortfall(p, NEEDS[want] || NEEDS.road);
    const take = {};
    let n = 0;
    for (const res of Object.keys(need)) {
      while (n < 2 && (take[res] || 0) < need[res] && g.bank[res] > (take[res] || 0)) { take[res] = (take[res] || 0) + 1; n++; }
      if (n >= 2) break;
    }
    for (const res of RESOURCES) {
      if (n >= 2) break;
      if (g.bank[res] > (take[res] || 0)) { take[res] = (take[res] || 0) + 1; n++; }
    }
    if (n === 2) return { type: 'playDev', card: 'plenty', res: take };
  }
  if (p.dev.road > 0 && R.legalRoads(g, pid).length >= 2 && p.left.road >= 2) {
    return { type: 'playDev', card: 'road' };
  }
  return null;
}

/** Half the hand goes; give up whatever we are least likely to spend. */
function chooseDiscard(g, board, pid, cfg, rng) {
  const p = g.players[pid];
  const owed = g.pending.discard[pid];
  const want = goal(g, board, pid, cfg);
  const cost = NEEDS[want] || NEEDS.road;
  const give = {};
  const held = {};
  for (const res of RESOURCES) held[res] = p.res[res] || 0;

  for (let i = 0; i < owed; i++) {
    let worst = null;
    for (const res of RESOURCES) {
      if (held[res] - (give[res] || 0) <= 0) continue;
      // Cards earmarked for the goal are the last to go; ties break on abundance.
      const keep = cost[res] || 0;
      const spare = held[res] - (give[res] || 0) - keep;
      const s = spare * 2 + (held[res] - (give[res] || 0)) + rng() * cfg.noise;
      if (!worst || s > worst.s) worst = { res, s };
    }
    if (!worst) break;
    give[worst.res] = (give[worst.res] || 0) + 1;
  }
  return give;
}

/** Is an offered trade worth taking? */
function judgeTrade(g, t, board, pid, cfg, rng) {
  const p = g.players[pid];
  for (const [res, n] of Object.entries(t.want)) {
    if ((p.res[res] || 0) < n) return false;         // cannot pay
  }
  // Never hand the leader their winning card.
  if (cfg.denyLeader) {
    const lead = g.seats.filter((s) => s !== pid).sort((a, b) => R.publicVP(g, b) - R.publicVP(g, a))[0];
    if (t.from === lead && R.publicVP(g, lead) >= g.target - 3) return false;
  }
  const want = goal(g, board, pid, cfg);
  const need = shortfall(p, NEEDS[want] || NEEDS.road);
  const gain = Object.entries(t.give).reduce((n, [res, c]) => n + c * (need[res] ? 3 : 1), 0);
  const loss = Object.entries(t.want).reduce((n, [res, c]) => {
    const keep = (NEEDS[want] || NEEDS.road)[res] || 0;
    return n + c * ((p.res[res] || 0) - c < keep ? 3 : 1);
  }, 0);
  if (gain > loss) return true;
  return rng() < cfg.acceptBias;
}
