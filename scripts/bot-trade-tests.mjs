// Bots do not trade with anyone within three points of winning, on any level.
import * as R from '../public/rules.js';
import { makeBoard } from '../public/board.js';
import { botMove } from '../public/bot.js';

let failed = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) failed++; };
const rngFrom = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

function setup(target, offererPoints) {
  const g = R.newGame(['bot', 'rival', 'third'], { targetVP: target, layout: 'classic', seed: 4242 }, rngFrom(1));
  const board = makeBoard(g.seed, g.mode, g.layout);
  g.phase = 'build'; g.setup = null; g.turn.rolled = true;
  // Give `rival` this many public points as stand-in cities-worth of buildings.
  for (let i = 0; i < offererPoints; i++) g.bldg[200 + i] = { t: 's', p: 'rival' };
  g.players.bot.res = { wood: 4, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  g.players.rival.res = { wood: 0, brick: 3, sheep: 0, wheat: 0, ore: 0 };
  return { g, board };
}

const LEVELS = ['easy', 'medium', 'hard', 'harder', 'hardest'];
const offer = (g) => { g.trades = [{ id: 1, from: 'rival', give: { brick: 2 }, want: { wood: 1 }, replies: {} }]; g.tradeIds = 1; };

for (const target of [10, 12]) {
  const nearPts = target - 3, farPts = target - 7;   // outside even Hardest's wider margin of six
  for (const lvl of LEVELS) {
    let nearYes = 0, farYes = 0;
    for (let seed = 1; seed <= 60; seed++) {
      let { g, board } = setup(target, nearPts); offer(g);
      const a = botMove(g, board, 'bot', lvl, rngFrom(seed));
      if (a?.type === 'replyTrade' && a.yes) nearYes++;
      ({ g, board } = setup(target, farPts)); offer(g);
      const b = botMove(g, board, 'bot', lvl, rngFrom(seed));
      if (b?.type === 'replyTrade' && b.yes) farYes++;
    }
    ok(`${lvl}, target ${target}: never accepts from ${nearPts} points`, nearYes === 0);
    ok(`${lvl}, target ${target}: still trades at ${farPts} points (so the test can tell)`, farYes > 0);
  }
}

// A bot's own offer is not closed with a player who is that close, even if they said yes.
for (const lvl of LEVELS) {
  const { g, board } = setup(12, 9);
  g.turn.seat = g.seats.indexOf('bot');
  g.trades = [{ id: 1, from: 'bot', give: { wood: 2 }, want: { brick: 1 }, replies: { rival: 'yes', third: 'no' } }];
  g.tradeIds = 1;
  const m = botMove(g, board, 'bot', lvl, rngFrom(7));
  ok(`${lvl}: does not close its own offer with a player at 9/12`, !(m?.type === 'acceptTrade' && m.with === 'rival'));
}
{
  const { g, board } = setup(12, 6);
  g.turn.seat = g.seats.indexOf('bot');
  g.trades = [{ id: 1, from: 'bot', give: { wood: 2 }, want: { brick: 1 }, replies: { rival: 'yes', third: 'no' } }];
  g.tradeIds = 1;
  const m = botMove(g, board, 'bot', 'hard', rngFrom(7));
  ok('hard: does close its own offer with a player at 6/12', m?.type === 'acceptTrade' && m.with === 'rival');
}

console.log(failed ? `\n${failed} FAILED` : '\nbot trade-near-win checks passed');
process.exit(failed ? 1 : 0);
