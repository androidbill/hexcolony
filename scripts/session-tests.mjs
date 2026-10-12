// Exercise the shipped app's asynchronous room/clock code with delayed network
// replies and the real rules engine. No live rooms or player data are touched.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as R from '../public/rules.js';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function shippedFunction(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(app);
  assert(match, `Missing shipped function ${name}`);
  const end = app.indexOf('\n}', match.index);
  assert(end > match.index, `Missing end of ${name}`);
  return app.slice(match.index, end + 2);
}
const clockCode = app.slice(app.indexOf('let clockSamples = [];'), app.indexOf('// ---------------------------------------------------------------- liveness'));
const functionNames = [
  'stampMs', 'resetRoomSession', 'enterRoom', 'leaveRoom', 'subscribeClock',
  'subscribeRoom', 'subscribePulse', 'applyPulse', 'applyRoom', 'pullFromServer',
  'send', 'postMove', 'turnIdentity', 'turnDeadlinePassed', 'tradeDeadlinePassed',
  'idleKillDue', 'resumeOnlineRoom', 'secondsLeft', 'fireTimeout', 'handleRoomVisibility',
];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
function harness(backend = 'firestore') {
  const storage = new Map();
  const listeners = [], timeouts = [], stopped = [], writes = [];
  let wall = 1_000_000, mono = 1000;
  const ctx = vm.createContext({
    R, console, Date: { now: () => wall }, performance: { now: () => mono },
    document: { visibilityState: 'visible' },
    localStorage: { getItem: k => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    Promise, Set, Map,
    setTimeout: fn => { timeouts.push(fn); return timeouts.length; },
    clearTimeout: id => stopped.push(['timeout', id]),
    setInterval: fn => { listeners.push({ kind: 'interval', fn }); return listeners.length; },
    clearInterval: id => stopped.push(['interval', id]),
    db: {}, rtdb: {}, playerId: 'p1', IDLE_KILL_MS: 600000, HEALTH_MS: 2000,
    GUESS_HOLD_MS: 20000, SEND_QUEUE_MAX_MS: 3000,
    clone: structuredClone, withTimeout: promise => promise,
    roomBackendOf: code => code.startsWith('R') ? 'rtdb' : 'firestore',
    doc: (_, kind, code) => ({ kind, code }), rtdbRef: (_, path) => ({ path }),
    onSnapshot: (ref, options, fn, error) => {
      listeners.push({ kind: ref.kind, ref, fn, error }); return () => stopped.push(ref);
    },
    rtdbOnValue: (ref, fn, error) => {
      listeners.push({ kind: ref.path, ref, fn, error }); return () => stopped.push(ref);
    },
    toast: () => {}, sfx: { error() {} }, normalizeRtdbGame: () => {},
    showScreen: () => {}, render: () => {}, markFresh: () => {},
    stopChat: () => {}, clearUndo: () => {}, resetGuess: () => {}, resetTrade: () => {},
    subscribeChat: () => {}, writePulse: () => Promise.resolve(), healthCheck: () => {},
    drawGuess: () => false, dropGuess: () => {}, armUndo: () => {},
    keepAwake: () => {}, closeSheet: () => {}, renderChatButton: () => {}, setConnBadge: () => {},
    resubscribe: () => {}, pulseUnavailable: () => {}, pauseElapsedMs: () => 0, pauseBlocksGame: () => false, ACTING_MOVES: new Set(['build', 'buyDev']),
    usableName: () => 'Bill', roomIsStale: data => data.expiresAt < wall,
    serverTimestamp: () => wall, rtdbServerTimestamp: () => wall, deleteField: () => null,
    deleteDoc: ref => { writes.push({ delete: ref }); return Promise.resolve(); },
    rtdbRemove: ref => { writes.push({ delete: ref }); return Promise.resolve(); },
  });
  vm.runInContext(`
    let roomCode = null, roomRef = null, pulseRef = null, room = null;
    let roomSession = 0, roomIntent = 0, solo = false;
    const currentSession = (session, ref) => session === roomSession && ref === roomRef;
    let unsub = null, unsubPulse = null, healthInterval = null, timerInterval = null, soloTimer = null;
    let board = null, boardSeed = null, lastSeq = 0, lastPhaseKey = '', payoutKey = null;
    let trackedGameSeed, announcedUp = null, autoFiredFor = null, lastBeat = null;
    let pauseBeat = null, pauseBannerKey = null, pulseMode = 'doc';
    let pulling = false, resetting = false, killingIdleRoom = false;
    let lastFreshAt = 0, lastPulseSeenAt = 0, lastPulseWrite = 0, lastPulseServerMs = 0;
    let lastPulseBy = null, lastResubAt = 0, lastPullAt = 0, lastMoveAt = 0, nudgeCount = 0, nudgedAt = 0;
    let sawRoomDoc = false, wasSeated = false, serverRoom = null, guessSeq = 0, guessAt = 0;
    let sendEra = 0, sendChain = Promise.resolve();
    const game = () => room?.game;
    const UNDO_LABEL = {};
    ${clockCode}
    ${functionNames.map(shippedFunction).join('\n')}
  `, ctx);
  const run = code => vm.runInContext(code, ctx);
  const code = backend === 'rtdb' ? 'RNEW' : 'NEW';
  run(`enterRoom('${code}')`);
  const newRoom = (seed = 2, started = wall) => ({
    code, hostId: 'p1', state: 'playing', expiresAt: wall + 500000,
    players: { p1: { name: 'Bill' }, p2: { name: 'Roz' } },
    game: R.newGame(['p1', 'p2'], { seed, layout: 'classic', turnSeconds: 30 }),
    turnStartedAt: started,
  });
  const snapshot = (data, metadata = {}) => ({ exists: () => !!data,
    data: () => data, val: () => data,
    metadata: { fromCache: false, hasPendingWrites: false, ...metadata } });
  ctx.getDocFromServer = async () => snapshot(ctx.serverData);
  ctx.rtdbGet = async () => snapshot(ctx.serverData);
  ctx.runTransaction = async (_, fn) => fn({
    get: async ref => snapshot(ctx.serverData),
    update: (ref, patch) => { writes.push({ ref, patch }); Object.assign(ctx.serverData, patch); },
  });
  ctx.rtdbRunTransaction = async (ref, fn) => {
    const next = fn(structuredClone(ctx.serverData));
    if (next) { ctx.serverData = next; writes.push({ ref, next }); }
  };
  const setRoom = data => { ctx.data = data; run('room = data'); ctx.serverData = structuredClone(data); };
  setRoom(newRoom());
  run('noteServerTime(Date.now())');
  return { ctx, run, storage, listeners, writes, timeouts, stopped, newRoom, snapshot, setRoom,
    wall: value => { wall = value; }, advance: ms => { wall += ms; mono += ms; } };
}
let passed = 0;
async function check(name, test) {
  try { await test(); passed++; console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`, err); process.exitCode = 1; }
}

for (const backend of ['firestore', 'rtdb']) {
  await check(`${backend}: retiring a table clears its timers, board, room and clock`, () => {
    const h = harness(backend);
    h.run('timerInterval = 42; soloTimer = 43; autoFiredFor = "yesterday"; board = {}; resetRoomSession()');
    assert.equal(h.run('room'), null);
    assert.equal(h.run('roomRef'), null);
    assert.equal(h.run('board'), null);
    assert.equal(h.run('clockTrusted()'), false);
    assert.equal(h.run('autoFiredFor'), null);
    assert(h.stopped.some(item => Array.isArray(item) && item[0] === 'interval' && item[1] === 42));
    assert(h.stopped.some(item => Array.isArray(item) && item[0] === 'timeout' && item[1] === 43));
  });
  await check(`${backend}: queued automatic placement cannot enter a new room`, async () => {
    const h = harness(backend), queue = deferred();
    h.ctx.queue = queue.promise; h.run('sendChain = queue');
    h.setRoom(h.newRoom(1, 0));
    const sent = h.run('send({type: "timeout"}, {quiet: true})');
    h.run(`enterRoom('${backend === 'rtdb' ? 'RNEXT' : 'NEXT'}')`);
    h.setRoom({ ...h.newRoom(2), code: backend === 'rtdb' ? 'RNEXT' : 'NEXT' });
    h.run('noteServerTime(Date.now())');
    queue.resolve();
    assert.equal(await sent, false);
    assert.equal(h.writes.length, 0);
    assert.equal(Object.keys(h.ctx.serverData.game.bldg).length, 0);
  });
  await check(`${backend}: late snapshot and deletion from yesterday cannot replace or leave today`, () => {
    const h = harness(backend);
    const old = h.listeners.find(l => l.kind === (backend === 'rtdb' ? 'rooms/RNEW' : 'rooms'));
    const oldData = h.newRoom(1, 0);
    old.fn(h.snapshot(oldData));
    h.run(`enterRoom('${backend === 'rtdb' ? 'RNEW' : 'NEW'}')`); // same code, new visit
    const today = h.newRoom(99); h.setRoom(today);
    old.fn(h.snapshot(oldData)); old.fn(h.snapshot(null));
    assert.equal(h.run('room.game.seed'), 99);
    assert.equal(h.run('roomCode'), today.code);
  });
  await check(`${backend}: slow server pull from old room is ignored`, async () => {
    const h = harness(backend), pending = deferred();
    const oldData = h.newRoom(1, 0);
    h.ctx.getDocFromServer = h.ctx.rtdbGet = () => pending.promise;
    const pull = h.run('pullFromServer(true)');
    h.run(`enterRoom('${backend === 'rtdb' ? 'RNEW' : 'NEW'}')`);
    h.setRoom(h.newRoom(99));
    pending.resolve(h.snapshot(oldData)); await pull;
    assert.equal(h.run('room.game.seed'), 99);
  });
  await check(`${backend}: queued timeout is rejected after the human places their settlement`, async () => {
    const h = harness(backend), queue = deferred();
    h.setRoom(h.newRoom(1, 0)); h.ctx.queue = queue.promise; h.run('sendChain = queue');
    const sent = h.run('send({type: "timeout"}, {quiet: true})');
    const g = h.ctx.serverData.game;
    const placed = R.applyMove(g, 'p1', { type: 'setupSettlement', v: R.legalSettlements(g, 'p1', true)[0] });
    assert(placed.ok);
    h.ctx.serverData.game = placed.game;
    // Even if delivery is delayed so the *road* deadline has also expired, the old
    // settlement timeout has no authority to place that road.
    queue.resolve(); assert.equal(await sent, false);
    assert.equal(h.writes.length, 0);
    assert.equal(Object.keys(h.ctx.serverData.game.roads).length, 0);
  });
  await check(`${backend}: an unexpired opening remains under human control`, async () => {
    const h = harness(backend);
    assert.equal(await h.run('send({type: "timeout"}, {quiet: true})'), false);
    assert.equal(h.writes.length, 0);
  });
  await check(`${backend}: the player's settlement tap still works normally`, async () => {
    const h = harness(backend);
    const g = h.ctx.serverData.game;
    h.ctx.move = { type: 'setupSettlement', v: R.legalSettlements(g, 'p1', true)[0] };
    assert.equal(await h.run('send(move)'), true);
    assert.equal(Object.keys(h.ctx.serverData.game.bldg).length, 1);
    assert.equal(h.ctx.serverData.game.setup.need, 'r');
  });
  await check(`${backend}: a genuinely expired opening still places exactly one settlement`, async () => {
    const h = harness(backend);
    h.advance(91000);
    assert.equal(await h.run('send({type: "timeout"}, {quiet: true})'), true);
    assert.equal(h.writes.length, 1);
    assert.equal(Object.keys(h.ctx.serverData.game.bldg).length, 1);
    assert.equal(Object.keys(h.ctx.serverData.game.roads).length, 0);
    assert.equal(h.ctx.serverData.game.setup.need, 'r');
  });
  await check(`${backend}: hidden app and unmeasured clock cannot force a move`, async () => {
    const h = harness(backend);
    h.advance(91000);
    h.ctx.document.visibilityState = 'hidden';
    assert.equal(await h.run('send({type: "timeout"}, {quiet: true})'), false);
    h.ctx.document.visibilityState = 'visible'; h.run('resetClock()');
    assert.equal(await h.run('send({type: "timeout"}, {quiet: true})'), false);
    assert.equal(h.writes.length, 0);
  });
  await check(`${backend}: Leave resets locally even while room deletion is waiting`, async () => {
    const h = harness(backend), pending = deferred();
    h.ctx.deleteDoc = h.ctx.rtdbRemove = () => pending.promise;
    const leaving = h.run('leaveRoom(true)');
    assert.equal(h.run('roomRef'), null);
    h.run(`enterRoom('${backend === 'rtdb' ? 'RNEW' : 'NEW'}')`);
    h.setRoom(h.newRoom(99));
    pending.resolve(); await leaving;
    assert.equal(h.run('room.game.seed'), 99);
  });
}

await check('boot lookup cannot rejoin yesterday after user starts a new room', async () => {
  const h = harness(), pending = deferred();
  h.storage.set('hexcolony_room', 'OLD');
  h.ctx.getRoomData = () => pending.promise;
  const boot = h.run('resumeOnlineRoom()');
  h.run('roomIntent += 1'); // user's Create action, before its network lookup finishes
  pending.resolve({ ...h.newRoom(1), code: 'OLD' });
  assert.equal(await boot, true);
  assert.equal(h.run('roomCode'), 'NEW');
});
await check('failed old boot lookup cannot erase a newly remembered room', async () => {
  const h = harness(), pending = deferred();
  h.storage.set('hexcolony_room', 'OLD'); h.ctx.getRoomData = () => pending.promise;
  const boot = h.run('resumeOnlineRoom()');
  h.run('enterRoom("NEXT")'); pending.reject(new Error('offline'));
  assert.equal(await boot, true);
  assert.equal(h.storage.get('hexcolony_room'), 'NEXT');
});
await check('unfinished live room can still be resumed when no new action is underway', async () => {
  const h = harness(); h.storage.set('hexcolony_room', 'OLD');
  h.ctx.getRoomData = async () => ({ ...h.newRoom(1), code: 'OLD' });
  assert.equal(await h.run('resumeOnlineRoom()'), true);
  assert.equal(h.run('roomCode'), 'OLD');
});
await check('Firestore in-flight old transaction cannot write after switching rooms', async () => {
  const h = harness(), pending = deferred();
  h.advance(91000);
  let entered = deferred();
  h.ctx.runTransaction = async (_, fn) => fn({ get: () => { entered.resolve(); return pending.promise; },
    update: () => h.writes.push('bad write') });
  const sent = h.run('send({type: "timeout"}, {quiet: true})');
  await entered.promise;
  const old = h.ctx.serverData;
  h.run('enterRoom("NEXT")'); h.setRoom({ ...h.newRoom(99), code: 'NEXT' });
  pending.resolve(h.snapshot(old)); assert.equal(await sent, false);
  assert.equal(h.writes.length, 0);
});
await check('RTDB transaction retry from old table cannot write to a new visit', async () => {
  const h = harness('rtdb'), pending = deferred(), entered = deferred();
  h.advance(91000);
  let retry;
  h.ctx.rtdbRunTransaction = async (_, fn) => {
    retry = fn; entered.resolve(); await pending.promise;
    if (fn(structuredClone(h.ctx.serverData))) h.writes.push('bad write');
  };
  const sent = h.run('send({type: "timeout"}, {quiet: true})');
  await entered.promise;
  h.run('enterRoom("RNEW")'); h.setRoom(h.newRoom(99));
  assert.equal(retry(structuredClone(h.ctx.serverData)), undefined);
  pending.resolve(); assert.equal(await sent, false);
  assert.equal(h.writes.length, 0);
});
await check('old solo bot callback cannot play in a replacement solo game', () => {
  const h = harness();
  h.ctx.botActor = () => 'bot1'; h.ctx.runBot = () => h.writes.push('bad bot move');
  vm.runInContext(shippedFunction('scheduleBots'), h.ctx);
  h.run('solo = true; scheduleBots()');
  const oldBot = h.timeouts.at(-1);
  h.run('resetRoomSession(); solo = true'); h.setRoom(h.newRoom(99));
  oldBot(); assert.equal(h.writes.length, 0);
});
await check('a new roll keeps its full timer even after an expired old game', async () => {
  const h = harness();
  h.setRoom(h.newRoom(1, 0));
  h.run('enterRoom("NEW")');
  const fresh = h.newRoom(99);
  while (fresh.game.phase === 'setup') fresh.game = R.applyMove(fresh.game, 'p1', { type: 'timeout' }).game;
  fresh.game.turn.clockRestart = false;
  h.setRoom(fresh); h.run('noteServerTime(Date.now())');
  assert.equal(h.run('secondsLeft(game())'), R.ROLL_SECONDS);
  await h.run('fireTimeout()');
  assert.equal(h.writes.length, 0);
  assert.equal(h.ctx.serverData.game.phase, 'roll');
});
await check('clock samples survive phone wall-clock jumps without early timeouts', () => {
  const h = harness();
  assert.equal(h.run('secondsLeft(game())'), 90);
  h.wall(1_000_000 + 86400000); // clock corrected forward by a day
  assert.equal(h.run('secondsLeft(game())'), 90);
  h.advance(1000); h.run('noteServerTime(1001000)');
  assert.equal(h.run('secondsLeft(game())'), 89);
  h.wall(500000); // clock corrected backward
  h.advance(1000); h.run('noteServerTime(1002000)');
  assert.equal(h.run('secondsLeft(game())'), 88);
  assert.equal(h.run('turnDeadlinePassed(room)'), false);
});
await check('pending/local Firestore heartbeat never calibrates the clock', () => {
  const h = harness(); h.run('resetClock()');
  const pulse = h.listeners.find(l => l.kind === 'pulses');
  pulse.fn(h.snapshot({ at: 9000000 }, { hasPendingWrites: true }));
  assert.equal(h.run('clockReady()'), false);
  pulse.fn(h.snapshot({ at: 9000000 }, { fromCache: true }));
  assert.equal(h.run('clockReady()'), false);
  pulse.fn(h.snapshot({ at: 1000000 }));
  assert.equal(h.run('clockReady()'), true);
  assert.equal(h.run('secondsLeft(game())'), 90);
});
await check('RTDB clock uses connected server offset, never projected room heartbeat', () => {
  const h = harness('rtdb'); h.run('resetClock()');
  h.ctx.pulse = { at: 9000000 }; h.run('applyPulse(pulse, true)');
  assert.equal(h.run('clockReady()'), false);
  const offset = h.listeners.find(l => l.kind === '.info/serverTimeOffset');
  const connection = h.listeners.find(l => l.kind === '.info/connected');
  offset.fn(h.snapshot(0)); assert.equal(h.run('clockReady()'), false);
  connection.fn(h.snapshot(true)); assert.equal(h.run('secondsLeft(game())'), 90);
  connection.fn(h.snapshot(false)); assert.equal(h.run('clockReady()'), false);
});
await check('returning from background invalidates yesterday\'s clock before timeout checks', async () => {
  const h = harness(); h.advance(86400000);
  h.run('handleRoomVisibility()');
  await h.run('fireTimeout()');
  assert.equal(h.run('clockReady()'), false);
  assert.equal(h.writes.length, 0);
});
console.log(`\n${passed} session/clock checks passed.`);
