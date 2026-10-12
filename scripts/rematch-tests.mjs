// Play again voting and player stats, run against the code that ships in app.js.
//
// app.js is a browser module and cannot be imported, so the functions under test are cut
// out of it by name and run in a sandbox — the same approach session-tests.mjs takes.

import fs from 'node:fs';
import vm from 'node:vm';

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
  ${shipped('rematchVoters')}
  ${shipped('planRematch')}
  ${shipped('rematchLine')}
  ${shipped('historyNameKey')}
  ${shippedConst('STAT_SOURCES')}
  ${shipped('buildPlayerStats')}
  const stampMs = (v) => (typeof v === 'number' ? v : null);
  ${shipped('turnPace')}
  ${shipped('diceFacts')}
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
const log = { t1: { at: 0, p: 'a' }, t2: { at: 20000, p: 'b', a: true }, t3: { at: 25000, p: 'a' }, t4: { at: 70000, p: 'b', a: true }, t0: { at: 0, p: 'c' } };
ctx.__l = log;
let pace = run('turnPace(__l, 76000)');
ctx.__l2 = { t1: { at: 0, p: 'a', a: true }, t2: { at: 3000, p: 'b' }, t3: { at: 9000, p: 'a' } };
const pace2 = run('turnPace(__l2, 20000)');
ok('a turn with no action is never the fastest', pace2 === null || pace2.fast.pid === 'a');
ok('slowest is the longest single turn', pace.slow.pid === 'a' && pace.slow.ms === 45000);
ok('fastest is the shortest single turn', pace.fast.pid === 'b' && pace.fast.ms === 5000);
ok('no pace without a log', run('turnPace(null, 5)') === null);
const board = { byNumber: { 6: [0], 8: [1] } };
ctx.__g = { seats: ['a', 'b'], bldg: { 0: { p: 'a', t: 's' }, 2: { p: 'b', t: 'c' } }, rolls: { 6: 5, 7: 2, 8: 1 } };
ctx.__b = board;
const dice = run('diceFacts(__g, __b)');
ok('most rolled number and who is on it', dice.most.n === 6 && dice.most.who.join() === 'a');
ok('least rolled counts never-rolled numbers', dice.least.count === 0);
ok('too few rolls says nothing', run('diceFacts({ seats: [], bldg: {}, rolls: { 6: 1 } }, __b)') === null);

console.log(failed ? `\n${failed} FAILED` : '\nplay again + stats checks passed');
process.exit(failed ? 1 : 0);
