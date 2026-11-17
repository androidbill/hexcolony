// Play again voting and player stats, run against the code that ships in app.js.
//
// app.js is a browser module and cannot be imported, so the functions under test are cut
// out of it by name and run in a sandbox — the same approach session-tests.mjs takes.

import fs from 'node:fs';
import vm from 'node:vm';
import { gameTimes, playerTimes } from '../public/playtime.js';

const src = fs.readFileSync('public/app.js', 'utf8');

function shipped(name) {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (start < 0) throw new Error(`function ${name} not found in app.js`);
  let i = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}
function shippedConst(name) {
  const start = src.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`const ${name} not found in app.js`);
  return src.slice(start, src.indexOf('];', start) + 2);
}

const ctx = vm.createContext({ esc: (s) => String(s), console });
vm.runInContext(`
  let room = null, playerId = 'a';
  const nameFor = (id) => id;
  const randomSea = () => 'test-sea';   // app.js picks a random sea colour per rematch
  ${shipped('rematchVoters')}
  ${shipped('planRematch')}
  ${shipped('rematchLine')}
  ${shipped('historyNameKey')}
  ${shippedConst('STAT_SOURCES')}
  ${shipped('buildPlayerStats')}
  ${shipped('diceFacts')}
  ${shippedConst('TITLES')}
  ${shipped('winTitles')}
  const HEXES = [{ corners: [0, 1] }, { corners: [2, 3] }];
`, ctx);
const run = (code) => vm.runInContext(code, ctx);

let failed = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) failed++; };

const over = (ids, votes = {}) => ({
  state: 'over', hostId: ids[0],
  players: Object.fromEntries(ids.map((id) => [id, { name: id }])),
  rematch: Object.keys(votes).length ? { votes } : null,
});
const plan = (data, pid, on, voters) => {
  ctx.__d = JSON.parse(JSON.stringify(data));
  return run(`planRematch(__d, ${JSON.stringify(pid)}, ${on}, ${JSON.stringify(voters ?? null)})`);
};

// ---- voting
let p = plan(over(['a', 'b', 'c']), 'a', true);
ok('one vote of three keeps waiting', p.outcome === 'waiting' && Object.keys(p.patch.rematch.votes).length === 1);
p = plan(over(['a', 'b', 'c'], { a: true }), 'b', true);
ok('two of three keeps waiting', p.outcome === 'waiting' && Object.keys(p.patch.rematch.votes).length === 2);
p = plan(over(['a', 'b', 'c'], { a: true, b: true }), 'c', true);
ok('the third vote starts it', p.outcome === 'started' && p.patch.state === 'lobby' && Object.keys(p.patch.players).length === 3);
ok('starting clears the old game and the votes', p.patch.game === null && p.patch.rematch === null && p.patch.order.length === 0);
p = plan(over(['a', 'b', 'c'], { a: true }), 'a', false);
ok('pressing again takes the vote back', p.outcome === 'waiting' && p.patch.rematch === null);

// ---- people leaving
p = plan(over(['a', 'b'], { a: true, b: true, c: true }), null, false);
ok('a player who left is not counted: 2 votes of 2 seated start it', p.outcome === 'started' && Object.keys(p.patch.players).length === 2);
p = plan(over(['a', 'b'], { a: true, c: true }), null, false);
ok('a leaver\'s vote does not count towards the others', p.outcome === 'waiting' && Object.keys(p.patch.rematch.votes).join() === 'a');
p = plan(over(['a'], { a: true }), null, false);
ok('a lone player never starts a game by themselves', p.outcome === 'waiting');

// ---- guards
ok('nothing happens outside a finished game', plan({ ...over(['a', 'b']), state: 'playing' }, 'a', true) === null);
ok('somebody not seated cannot vote', plan(over(['a', 'b']), 'z', true) === null);

// ---- the host going ahead without the rest
p = plan(over(['a', 'b', 'c'], { a: true, b: true }), null, false, ['a', 'b']);
ok('host can start with just the two who voted', p.outcome === 'started' && Object.keys(p.patch.players).join() === 'a,b');
p = plan(over(['a', 'b', 'c'], { b: true, c: true }), null, false, ['b', 'c']);
ok('the host seat moves to a voter if the host is not one', p.patch.hostId === 'b');
p = plan(over(['a', 'b', 'c'], { a: true }), null, false, ['a']);
ok('one voter is not enough even when forced', p.outcome === 'waiting');

// ---- the wording
const line = (votes, me = 'a') => {
  run(`playerId = '${me}'; room = ${JSON.stringify(over(['a', 'b', 'c', 'd'], votes))}`);
  return run('rematchLine()');
};
ok('one other person: "b wants to play again"', line({ b: true }) === 'b wants to play again');
ok('you alone: "You want to play again"', line({ a: true }) === 'You want to play again');
ok('three: "a, b and c want to play again"', line({ b: true, c: true, d: true }, 'x') === 'b, c and d want to play again');
ok('nobody: empty', line({}) === '');

// ---- stats
const game = (winner, players) => ({ id: Math.random(), winner, players });
const pts = (houses, cities, road, army, cards) => ({ houses, cities, road, army, cards });
ctx.__h = [
  game('a', [{ id: 'a', name: 'Bill', pts: pts(3, 6, 2, 0, 0) }, { id: 'b', name: 'Vera', pts: pts(4, 2, 0, 2, 1) }]),
  game('a', [{ id: 'a', name: 'bill', pts: pts(2, 2, 2, 2, 2) }, { id: 'b', name: 'Vera', pts: pts(5, 0, 0, 0, 0) }]),
  game('b', [{ id: 'a', name: 'Bill' }, { id: 'b', name: 'Vera' }]),   // saved before scoring was tracked
];
const stats = run('buildPlayerStats(__h)');
const bill = stats.find((r) => r.name.toLowerCase() === 'bill');
const vera = stats.find((r) => r.name === 'Vera');
ok('the same name in a different case is one player', stats.length === 2);
ok('wins and games add up', bill.wins === 2 && bill.games === 3 && vera.wins === 1 && vera.games === 3);
ok('old games count for wins but not for the scoring breakdown', bill.scored === 2 && vera.scored === 2);
ok('points are summed by source', bill.pts.houses === 5 && bill.pts.cities === 8 && bill.pts.road === 4 && bill.pts.army === 2);
ok('a win is credited to its biggest engine', bill.engine.cities === 1 && bill.engine.cards === 0);
ok('a tie between engines takes the first listed', bill.engine.houses === 1);
ok('longest road and largest army are counted on top of the engine', bill.wonRoad === 2 && bill.wonArmy === 1);
ok('the table is sorted by wins', stats[0].name.toLowerCase() === 'bill');

// ---- pace and dice
// Turn timing lives in playtime.js now (it replaced turnPace in app.js), so it is imported directly.
const clock = { gid: 'g', partial: false, done: true, turns: [
  { k: 't1', pid: 'a', s: true, ms: 9000 },            // placement: counts toward total only
  { k: 't2', pid: 'a', s: false, ms: 45000 },
  { k: 't3', pid: 'b', s: false, ms: 5000 },
  { k: 't4', pid: 'b', s: false, ms: 500 },            // under a second: an auto-skip, not a turn
  { k: 't5', pid: 'a', s: false, ms: 12000, part: true }, // partly seen: total only
  { k: 't6', pid: 'c', s: false, ms: 20000 },          // a bot, left out of gameTimes below
] };
const pa = playerTimes(clock, 'a');
const pb = playerTimes(clock, 'b');
ok('total time counts every turn, including placement and partial ones', pa.ms === 66000 && pb.ms === 5500);
ok('slowest is the longest ordinary turn', pa.max === 45000 && pa.n === 1);
ok('fastest ignores auto-skips under a second', pb.min === 5000 && pb.n === 1);
ok('a player with no ordinary turns has a zero minimum', playerTimes(clock, 'nobody').min === 0);
const gt = gameTimes(clock, ['a', 'b']);
ok('table total includes everyone, per-player lists only the humans asked for', gt.total === 91500 && !('c' in gt.per) && gt.per.a.ms === 66000);
const board = { byNumber: { 6: [0], 8: [1] } };
ctx.__g = { seats: ['a', 'b'], bldg: { 0: { p: 'a', t: 's' }, 2: { p: 'b', t: 'c' } }, rolls: { 6: 5, 7: 2, 8: 1 } };
ctx.__b = board;
const dice = run('diceFacts(__g, __b)');
ok('most rolled number and who is on it', dice.most.n === 6 && dice.most.who.join() === 'a');
ok('least rolled counts never-rolled numbers', dice.least.count === 0);
ok('too few rolls says nothing', run('diceFacts({ seats: [], bldg: {}, rolls: { 6: 1 } }, __b)') === null);

// ---- titles
ctx.__t = { seats: ['a', 'b', 'c'], roads: { 1: 'a', 2: 'a', 3: 'a', 4: 'a', 5: 'a', 6: 'a', 7: 'b' },
  players: { a: { knights: 0 }, b: { knights: 3 }, c: { knights: 3 } },
  tally: { a: { steals: 3 }, b: { steals: 3, trades: 5 }, c: { devs: 4 } } };
const ti = run('winTitles(__t)');
ok('the road leader is the Road Hog', ti.a === 'Road Hog');
ok('a tie earns nothing (steals 3-3, knights 3-3)', !Object.values(ti).includes('Robber Baron') && !Object.values(ti).includes('Sir Knight'));
ok('trades and dev cards go to their leaders', ti.b === 'Merchant Prince' && ti.c === 'Card Shark');
ok('nobody is titled below the minimum', Object.keys(run('winTitles({ seats: ["a","b"], roads: {}, players: {}, tally: {} })')).length === 0);

console.log(failed ? `\n${failed} FAILED` : '\nplay again + stats checks passed');
process.exit(failed ? 1 : 0);
