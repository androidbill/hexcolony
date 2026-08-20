// HexColony — room sync and interface.
//
// The whole game lives in one Firestore document per room. Turn-based play means
// contention is rare, and every move goes through a transaction, so a move either
// lands whole or is rejected and reported. The rules engine is the authority on what
// is legal; this file only draws buttons and posts moves.
//
// The liveness machinery (heartbeat, server-clock offset, escalating reconnect) is the
// same design used by the other party games in this collection — see the comments at
// "liveness" for why each rung exists.

// Firebase comes through fb.js rather than a direct import: it has to be loadable
// through Discord's proxy, and a failure there must not stop solo play from running.
import {
  db, NET_READY, doc, getDoc, getDocFromServer, setDoc, updateDoc, onSnapshot,
  deleteField, deleteDoc, serverTimestamp, runTransaction,
  disableNetwork, enableNetwork,
} from './fb.js';
import { IN_DISCORD, initDiscord, discordRoomCode } from './discord.js';
import { WORD_CODES } from './wordcodes.js';
import { APP_VERSION } from './version.js';
import { makeBoard, RESOURCES, TERRAIN, HEXES, VERTS, EDGES, LAYOUT_INFO } from './board.js';
import { BoardView, RES_ICON, loadTerrainArt, SEA_COLORS, SEA_DEFAULT, seaAt } from './render.js';
import { sfx, buzz, setSound, soundEnabled, unlock } from './audio.js';
import { resCard, devCard, cardRow, costRow, RES_NAME } from './cards.js';
import * as R from './rules.js';
import { botMove, makeBots, LEVELS as BOT_LEVELS } from './bot.js';

const ROOM_TTL_MS = 8 * 60 * 60 * 1000;

// Firestore promises can hang forever on a bad mobile connection — never let a UI flow
// await one without a deadline.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

// ---------------------------------------------------------------- identity
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/**
 * A real shuffle.
 *
 * `sort(() => Math.random() - 0.5)` is not one: the comparator is inconsistent, so the
 * result depends on the sort's internal order of comparisons and leaves some
 * arrangements far likelier than others — often barely moving a short list at all. Seat
 * order decides who opens the board, so it is worth getting right.
 */
function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
let playerId = localStorage.getItem('hexcolony_pid');
if (!playerId) { playerId = rid(); localStorage.setItem('hexcolony_pid', playerId); }

let myColorIdx = Number(localStorage.getItem('hexcolony_color') ?? 0);
if (!Number.isInteger(myColorIdx) || myColorIdx < 0 || myColorIdx >= R.PLAYER_COLORS.length) myColorIdx = 0;

// ---------------------------------------------------------------- dom helpers
const $ = (id) => document.getElementById(id);
const show = (el) => el && el.classList.remove('hidden');
// Escapes for BOTH text and attribute contexts — names arrive from other people's
// devices, and a quote that survives breaks straight out of an attribute.
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const SCREENS = ['screen-home', 'screen-lobby', 'screen-game'];
function showScreen(id) {
  for (const s of SCREENS) $(s).classList.toggle('is-active', s === id);
  // The game screen's top bar already occupies both corners, so the kebab steps aside
  // there; its three entries live in that screen's own menu instead.
  $('kebab-wrap').hidden = id === 'screen-game';
  closeKebab();
  if (id === 'screen-game') {
    // Size it now, then again after layout settles. The second pass catches the real
    // box once flex has run; the first means a throttled requestAnimationFrame — a
    // backgrounded tab, a hidden window — can never leave the board unsized.
    view.resize();
    requestAnimationFrame(() => view.resize());
  }
  updateInstallBanner();
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// Three seconds of somebody's name across the middle of the screen. Six people round a
// table watching six phones needed one place that said whose go it was without anyone
// having to read the score strip and work it out.
let shoutTimer = null;
function shoutout(msg, accent) {
  const box = $('shoutout');
  const card = $('shoutout-card');
  card.textContent = msg;
  card.style.setProperty('--c', accent || 'var(--gold)');
  box.hidden = false;
  // Taking the class off and reading a layout property in between is what restarts the
  // animation. Without the read the browser coalesces both changes and nothing replays,
  // so a second shoutout in a row would never appear.
  card.classList.remove('show');
  void card.offsetWidth;
  card.classList.add('show');
  clearTimeout(shoutTimer);
  shoutTimer = setTimeout(() => { card.classList.remove('show'); box.hidden = true; }, 3000);
}

// The one measurement that matters on a phone: 100vh lies when the URL bar is showing,
// and an installed PWA reports a different height again.
function appHeight() {
  const h = window.innerHeight;
  if (h > 0) document.documentElement.style.setProperty('--app-height', `${h}px`);
}
appHeight();
window.addEventListener('resize', () => { appHeight(); view.resize(); });
window.addEventListener('orientationchange', () => setTimeout(() => { appHeight(); view.resize(); }, 250));

// ---------------------------------------------------------------- sheets
let openSheet = null;
function sheet(id) {
  if (openSheet && openSheet !== id) $(openSheet).classList.remove('show');
  openSheet = id;
  $(id).classList.add('show');
  $('veil').classList.add('show');
}
function closeSheet() {
  if (openSheet) $(openSheet).classList.remove('show');
  openSheet = null;
  $('veil').classList.remove('show');
}
// Sheets the game is actually waiting on. Tapping the veil used to dismiss these, and
// because nothing re-renders while it is still your turn there was then no way to get
// them back — the game simply looked frozen. They now stay put until they are answered.
const MANDATORY_SHEETS = new Set(['sheet-discard', 'sheet-steal']);
$('veil').addEventListener('click', () => {
  if (MANDATORY_SHEETS.has(openSheet)) return;
  closeSheet();
});
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeSheet();
});

// ---------------------------------------------------------------- state
let roomCode = null;
let roomRef = null;
let pulseRef = null;
let room = null;
let unsub = null;

// Solo play is a whole game with no network at all: the same room shape lives in
// memory, `send` applies moves locally, and the bots take their turns on a timer. Every
// screen, sheet and renderer below is untouched by it — they only ever read `room`.
let solo = false;
let soloTimer = null;
const SOLO_KEY = 'hexcolony_solo';

const view = new BoardView($('board-cv'));
// Illustrated terrain tiles load in the background. Until they arrive (or if they are
// not there at all) the board draws its procedural motifs, so play never waits on art.
loadTerrainArt(() => view.draw(performance.now()));
let board = null;              // regenerated whenever the seed changes
let boardSeed = null;
let lastSeq = 0;               // highest game-log id already reacted to
let announcedUp = null;        // the turn already shouted; null until the first render
let lastPhaseKey = '';
let seenLogAt = 0;

// ---------------------------------------------------------------- optimistic moves
// A tap used to take the full width of a Firestore transaction before anything moved on
// screen: a server read, a commit, then the snapshot coming back. On a phone that is a
// second or two of nothing happening, on every single tap, all game long.
//
// So the device works the move out for itself and draws it immediately. The transaction
// still runs, still re-validates against the state actually on the server, and still has
// the last word — when its snapshot lands it replaces whatever was drawn here. Guessing
// only ever shortens the wait for the answer the server was going to give anyway; it
// never changes what that answer is.
//
// Only moves this device can work out on its own are guessed. `roll`, `steal`,
// `takeCard` and `moveRobber` (which can rob on the way past) all draw from the server's
// random source, and `timeout` re-enters as whatever move was owed, which may be a roll.
// Showing a guessed die and then correcting it is worse than a short wait, so those go
// the long way round.
const PREDICTABLE = new Set([
  'setupSettlement', 'setupRoad', 'build', 'buyDev', 'playDev', 'discard',
  'bankTrade', 'offerTrade', 'replyTrade', 'acceptTrade', 'cancelTrade', 'endTurn',
]);

// Longer than the transaction's own timeout, so in the ordinary failure the move
// itself takes the guess down. This is the backstop for the case where it cannot —
// a guess must never be able to wedge a device on a state the server has moved past.
const GUESS_HOLD_MS = 20000;

let serverRoom = null;   // the last state the server actually sent
let guessSeq = 0;        // g.seq the guess on screen has reached; 0 when not guessing
let guessAt = 0;         // when it was drawn
const resetGuess = () => { serverRoom = null; guessSeq = 0; guessAt = 0; };

const myName = () => ($('name-input').value || '').trim().slice(0, 14);
const isHost = () => room && room.hostId === playerId;
const game = () => room && room.game;
const seatOrder = () => (room?.order || Object.keys(room?.players || {}));

function paletteFor(pid) {
  const p = room?.players?.[pid];
  const idx = p?.colorIdx ?? 0;
  return R.PLAYER_COLORS[idx % R.PLAYER_COLORS.length];
}
const colorFor = (pid) => paletteFor(pid).hex;
const inkFor = (pid) => paletteFor(pid).ink;

/** Colours already spoken for by somebody else in this room. */
function takenColours() {
  const out = new Map();
  for (const [id, p] of Object.entries(room?.players || {})) {
    if (id === playerId) continue;
    out.set(p.colorIdx ?? 0, p);
  }
  return out;
}

/** The colour you want if it is free, otherwise the first that is. */
function freeColourIdx(players) {
  const used = new Set(Object.values(players || {}).map((p) => p.colorIdx ?? 0));
  if (!used.has(myColorIdx)) return myColorIdx;
  for (let i = 0; i < R.PLAYER_COLORS.length; i++) if (!used.has(i)) return i;
  return myColorIdx;
}
function nameFor(pid) { return room?.players?.[pid]?.name || 'Someone'; }
view.colorOf = colorFor;

// ---------------------------------------------------------------- landing screen
$('name-input').value = localStorage.getItem('hexcolony_name') || '';
$('btn-colour').addEventListener('click', () => { unlock(); sfx.tap(); openColourPicker(); });

function drawColourGrid() {
  const taken = takenColours();
  const mine = room?.players?.[playerId]?.colorIdx ?? myColorIdx;
  $('colour-grid').innerHTML = R.PLAYER_COLORS.map((c, i) => {
    const by = taken.get(i);
    return `<button class="colour-cell${i === mine ? ' on' : ''}" data-colour="${i}"
      style="--c:${c.hex};--ink:${c.ink}"${by ? ' disabled' : ''}
      aria-label="${esc(c.name)}${by ? ` — taken by ${esc(by.name)}` : ''}">
      ${by ? `<span class="taken-by">${esc((by.name || '?').slice(0, 2))}</span>` : (i === mine ? '✓' : '')}
    </button>`;
  }).join('');
  for (const b of document.querySelectorAll('[data-colour]')) {
    b.addEventListener('click', () => pickColour(Number(b.dataset.colour)));
  }
}

function pickColour(idx) {
  if (!R.PLAYER_COLORS[idx]) return;
  if (takenColours().has(idx)) return toast('Somebody already has that colour.');
  if (room && room.state !== 'lobby') return toast('Colours are locked once the game starts.');
  myColorIdx = idx;
  localStorage.setItem('hexcolony_color', String(idx));
  sfx.tap();
  paintLookButton();
  if (roomRef) updateDoc(roomRef, { [`players.${playerId}.colorIdx`]: idx }).catch(() => {});
  else if (solo && room?.players?.[playerId]) { room.players[playerId].colorIdx = idx; saveSolo(); render(); }
  drawColourGrid();
}

/** The swatch on the home screen button, so your colour is visible before you sit down. */
function paintLookButton() {
  const c = R.PLAYER_COLORS[myColorIdx] || R.PLAYER_COLORS[0];
  $('look-swatch').style.setProperty('--c', c.hex);
  $('colour-name').textContent = c.name;
}

/** Colour is the only thing left to choose, so this is the whole of it. */
function openColourPicker() {
  drawColourGrid();
  sheet('sheet-colour');
}

$('code-input').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
});

function makeCode() { return WORD_CODES[Math.floor(Math.random() * WORD_CODES.length)]; }

function roomIsStale(data) {
  if (!data) return true;
  const expires = typeof data.expiresAt?.toMillis === 'function'
    ? data.expiresAt.toMillis()
    : (data.createdAt || 0) + ROOM_TTL_MS;
  return Date.now() > expires;
}

function freshPlayer(name, colorIdx) {
  return { name, colorIdx, joinedAt: Date.now() };
}

$('btn-create').addEventListener('click', createRoom);
$('btn-join').addEventListener('click', joinRoom);

async function createRoom() {
  unlock();
  const name = myName();
  if (!name) return toast('Enter your name first.');
  localStorage.setItem('hexcolony_name', name);
  $('btn-create').disabled = true;
  try {
    let code = null;
    for (let i = 0; i < 12; i++) {
      const candidate = makeCode();
      if (candidate.length !== 4) continue;
      try {
        const snap = await withTimeout(getDoc(doc(db, 'rooms', candidate)), 4000);
        if (!snap.exists() || roomIsStale(snap.data())) { code = candidate; break; }
      } catch {
        // The lookup hung on a flaky connection. Take the code rather than stall.
        code = candidate;
        break;
      }
    }
    if (!code) return toast('Every room code is busy — try again in a minute.');

    // Fire the write and enter immediately; the live listener confirms it. Waiting on
    // a server ack that a phone connection might swallow is how lobbies feel broken.
    setDoc(doc(db, 'rooms', code), {
      code,
      createdAt: Date.now(),
      expiresAt: new Date(Date.now() + ROOM_TTL_MS),
      hostId: playerId,
      state: 'lobby',
      settings: { targetVP: 10, discardLimit: 7, boardMode: 'random', layout: 'classic', useRobber: true, turnSeconds: 0, sea: SEA_DEFAULT },
      players: { [playerId]: freshPlayer(name, myColorIdx) },
      order: [],
      game: null,
    }).catch((e) => { console.error(e); toast('Could not create the room — check your connection.'); });
    sfx.join();
    enterRoom(code);
  } finally {
    $('btn-create').disabled = false;
  }
}

async function joinRoom() {
  unlock();
  const name = myName();
  const code = ($('code-input').value || '').trim().toUpperCase();
  if (!name) return toast('Enter your name first.');
  if (code.length !== 4) return toast('Room codes are four letters.');
  localStorage.setItem('hexcolony_name', name);
  $('btn-join').disabled = true;
  try {
    const ref = doc(db, 'rooms', code);
    let data = null;
    try {
      const snap = await withTimeout(getDoc(ref), 6000);
      if (!snap.exists()) return toast(`Room ${code} not found.`);
      data = snap.data();
      if (roomIsStale(data)) return toast(`Room ${code} has expired — ask for a new code.`);
    } catch {
      // Lookup hung; join optimistically and let the listener bounce us if it's wrong.
    }
    if (data && !data.players?.[playerId]) {
      if (data.state !== 'lobby') return toast('That game has already started.');
      const taken = Object.values(data.players || {})
        .some((p) => (p.name || '').toLowerCase() === name.toLowerCase());
      if (taken) return toast('That name is taken in this room — pick another.');
      if (Object.keys(data.players || {}).length >= 6) return toast('That room is full.');
    }
    if (!data || !data.players?.[playerId]) {
      updateDoc(ref, { [`players.${playerId}`]: freshPlayer(name, freeColourIdx(data?.players)) }).catch(() => {});
    }
    sfx.join();
    enterRoom(code);
  } finally {
    $('btn-join').disabled = false;
  }
}

// ---------------------------------------------------------------- discord activity
/**
 * Sit down at the voice channel's table.
 *
 * There is no code to type: everyone Discord loaded this activity for shares one
 * `instance_id`, so the first player through creates the room and the rest join it.
 */
async function joinDiscordRoom() {
  const code = discordRoomCode();
  if (!code) return toast('Could not read the Discord session.');
  const name = myName();
  if (!name) return toast('Enter your name first.');
  localStorage.setItem('hexcolony_name', name);

  const btn = $('btn-discord-join');
  btn.disabled = true;
  try {
    const ref = doc(db, 'rooms', code);
    let data = null;
    try {
      const snap = await withTimeout(getDoc(ref), 6000);
      if (snap.exists()) data = snap.data();
    } catch { /* lookup hung; fall through and try to create */ }

    if (!data || roomIsStale(data)) {
      await withTimeout(setDoc(ref, {
        code,
        createdAt: Date.now(),
        expiresAt: new Date(Date.now() + ROOM_TTL_MS),
        hostId: playerId,
        state: 'lobby',
        settings: { targetVP: 10, discardLimit: 7, boardMode: 'random', layout: 'classic', useRobber: true, turnSeconds: 0, sea: SEA_DEFAULT },
        players: { [playerId]: freshPlayer(name, myColorIdx) },
        order: [],
        game: null,
      }), 8000);
    } else if (!data.players?.[playerId]) {
      if (data.state !== 'lobby') return toast('That game has already started.');
      await withTimeout(updateDoc(ref, { [`players.${playerId}`]: freshPlayer(name, freeColourIdx(data.players)) }), 8000);
    }
    sfx.join();
    enterRoom(code);
  } catch (e) {
    console.error(e);
    toast('Could not reach the table — check your connection.');
  } finally {
    btn.disabled = false;
  }
}

$('btn-discord-join').addEventListener('click', () => { unlock(); joinDiscordRoom(); });

// ---------------------------------------------------------------- clock sync
// Phone clocks disagree, sometimes by minutes. Each phone measures its own offset from
// the Firestore server clock, riding along on the heartbeat the room already writes.
let clockSamples = [];
let clockOffset = null;
function noteServerTime(serverMs) {
  // Every sample UNDER-estimates the offset by its own network latency, so the largest
  // recent sample is the one that travelled fastest and is closest to the truth.
  clockSamples.push(serverMs - Date.now());
  if (clockSamples.length > 8) clockSamples.shift();
  clockOffset = Math.max(...clockSamples);
}
const clockReady = () => clockOffset !== null;
/**
 * The time everyone agrees on. Turn deadlines are stored as absolute timestamps in the
 * game state, so each device subtracts its own corrected clock and they all show the
 * same number without having to tick together. In solo the offset is zero and this is
 * just the local clock.
 */
const serverNow = () => Date.now() + (clockOffset || 0);

/**
 * Whether this device has actually measured its distance from the server clock.
 *
 * Until it has, `serverNow()` is just the device's own clock — and phones are routinely
 * minutes out. Nothing timed may be shown or acted on before this is true, which is the
 * difference between a timer that survives a bad clock and one that silently misfires
 * on a single handset. Solo has no server and no other player to disagree with, so the
 * local clock is authoritative there by definition.
 */
const clockTrusted = () => solo || clockReady();

// ---------------------------------------------------------------- liveness
// Phones dim, lock, background the browser or drop wifi, any of which can silently
// wedge the Firestore stream and freeze that phone on a stale turn. One device beats
// every few seconds, so a healthy phone MUST receive a server snapshot on that cadence.
// Going quiet is proof this phone's stream is broken, and it repairs itself.
const PULSE_MS = 4000;
const HEALTH_MS = 2000;
const STALE_RESUB_MS = 11000;
const STALE_PULL_MS = 17000;
const STALE_RESET_MS = 26000;
const TAKEOVER_MS = 12000;

let unsubPulse = null;
let pulseMode = 'doc';
let lastFreshAt = 0, lastResubAt = 0, lastPullAt = 0, lastPulseWrite = 0;
let lastPulseServerMs = 0, lastPulseSeenAt = 0, lastPulseBy = null;
let healthInterval = null, pulling = false, resetting = false;
let nudgedAt = 0, nudgeCount = 0;

const markFresh = () => { lastFreshAt = Date.now(); };
function setConnBadge(bad) { $('conn-badge').hidden = !bad; }

function applyRoom(data, fresh) {
  if (fresh) markFresh();
  serverRoom = data;
  if (data.pulseAt) applyPulse({ at: data.pulseAt, by: data.pulseBy }, fresh);
  // A guess is on screen and this snapshot predates it. Drawing it would take the road
  // back off the board for a moment and then put it straight back — the flicker the
  // guess exists to avoid. The snapshot that confirms the move is already on its way,
  // and it carries everything this one did.
  if (guessSeq && Date.now() - guessAt < GUESS_HOLD_MS && (data.game?.seq ?? 0) < guessSeq) return;
  guessSeq = 0;
  room = data;
  render();
}

/**
 * Draw `move` now, on this device's own reading of the rules.
 *
 * Returns false when the move cannot be guessed — either it is one of the random ones,
 * or the engine refuses it here. A local refusal is never reported: this copy of the
 * state can be a moment behind, so the server gets to say no rather than this.
 */
function drawGuess(move) {
  const g = room?.game;
  if (!g || !PREDICTABLE.has(move?.type)) return false;
  const res = R.applyMove(g, playerId, move);
  if (!res.ok) return false;
  room = { ...room, game: res.game };
  // The engine says the allowance restarts; normally Firestore says when. Until the real
  // stamp arrives, use this device's *corrected* clock — the one measured against the
  // server — so the timer does not jump. An unmeasured clock is left alone: the timer
  // already shows nothing rather than a number that could be minutes wrong.
  if (res.game.turn.clockRestart && clockTrusted()) {
    res.game.turn.clockRestart = false;
    room.turnStartedAt = serverNow();
  }
  guessSeq = res.game.seq || 0;
  guessAt = Date.now();
  render();
  return true;
}

/** The server disagreed, or never heard. Put back what it last told us. */
function dropGuess() {
  if (!guessSeq) return;
  guessSeq = 0;
  if (!serverRoom) return;
  room = serverRoom;
  // Drawing the guess also moved the log marker past entries that turned out never to
  // have happened. Wind it back to what the server has actually said, or the next real
  // move would be read as already seen and go through without its sound.
  lastSeq = Math.max(0, ...(serverRoom.game?.log || []).map((e) => e.i || 0));
  render();
}

function applyPulse(data, fresh) {
  if (fresh) markFresh();
  const ms = typeof data?.at?.toMillis === 'function' ? data.at.toMillis() : 0;
  // Only a newly arrived beat is a usable clock sample; re-reading an old one would
  // look like a hugely delayed beat and drag the measurement off.
  if (ms > lastPulseServerMs) {
    lastPulseServerMs = ms;
    lastPulseSeenAt = Date.now();
    lastPulseBy = data.by || null;
    if (fresh) noteServerTime(ms);
  }
}

function pulseUnavailable() {
  if (pulseMode === 'room') return;
  pulseMode = 'room';
  if (unsubPulse) { unsubPulse(); unsubPulse = null; }
  console.warn('HexColony: pulses/ is not writable — falling back to an in-room heartbeat. '
    + 'Deploy firestore.rules to restore the cheap path.');
}

function subscribePulse() {
  if (!pulseRef || pulseMode !== 'doc') return;
  if (unsubPulse) { unsubPulse(); unsubPulse = null; }
  unsubPulse = onSnapshot(pulseRef, { includeMetadataChanges: true }, (snap) => {
    if (snap.exists()) applyPulse(snap.data(), !snap.metadata.fromCache);
  }, (err) => { if (err?.code === 'permission-denied') pulseUnavailable(); });
}

function subscribeRoom() {
  if (!roomRef) return;
  if (unsub) { unsub(); unsub = null; }
  // includeMetadataChanges is what lets us tell a real server delivery from a cache
  // replay. Without it, re-attaching a listener always looks healthy even when the
  // connection underneath is dead — which is exactly how phones get stuck.
  unsub = onSnapshot(roomRef, { includeMetadataChanges: true }, (snap) => {
    if (!snap.exists()) {
      if (snap.metadata.fromCache) return;
      toast('The room was closed.');
      leaveRoom(false);
      return;
    }
    applyRoom(snap.data(), !snap.metadata.fromCache);
  }, (err) => {
    console.error(err);
    setTimeout(() => resubscribe(true), 1500);
  });
}

function resubscribe(force = false) {
  if (!roomRef) return;
  if (!force && Date.now() - lastResubAt < 4000) return;
  lastResubAt = Date.now();
  subscribeRoom();
  subscribePulse();
}

// Rung 2: bypass the stream and read the room straight off the server.
async function pullFromServer(force = false) {
  if (!roomRef || pulling) return;
  if (!force && Date.now() - lastPullAt < 5000) return;
  lastPullAt = Date.now();
  pulling = true;
  try {
    const snap = await withTimeout(getDocFromServer(roomRef), 6000);
    if (snap.exists()) applyRoom(snap.data(), true);
  } catch { /* still wedged — the next rung handles it */ }
  finally { pulling = false; }
}

// Rung 3: tear the transport down and rebuild it. This is the one that actually cures
// a jammed long-poll; re-attaching listeners does not.
async function hardReset() {
  if (!roomRef || resetting) return;
  resetting = true;
  try {
    if (unsub) { unsub(); unsub = null; }
    if (unsubPulse) { unsubPulse(); unsubPulse = null; }
    await withTimeout(disableNetwork(db), 4000);
    await withTimeout(enableNetwork(db), 4000);
    subscribeRoom();
    subscribePulse();
    await pullFromServer(true);
  } catch { /* try again next cycle */ }
  finally { setTimeout(() => { resetting = false; }, 8000); }
}

// Exactly one phone beats at a time: the host by preference, then everyone else in a
// stable order. A backup only steps in after a long silence and then KEEPS the job —
// without that stickiness the room flaps between bursts and dead air.
function pulseCandidates() {
  if (!room?.players) return [];
  const ids = Object.keys(room.players).sort();
  const host = room.hostId;
  return host && ids.includes(host) ? [host, ...ids.filter((i) => i !== host)] : ids;
}

function shouldPulse() {
  if (!room) return false;
  const list = pulseCandidates();
  const rank = list.indexOf(playerId);
  if (rank < 0) return false;
  if (rank === 0) return true;
  if (lastPulseBy === playerId) return true;
  const silence = Date.now() - lastPulseSeenAt;
  const leaderRank = list.indexOf(lastPulseBy);
  const leaderAlive = leaderRank >= 0 && leaderRank < rank && silence < TAKEOVER_MS;
  return !leaderAlive && silence >= rank * TAKEOVER_MS;
}

async function writePulse(force = false) {
  if (!roomRef) return;
  if (!force && Date.now() - lastPulseWrite < PULSE_MS - 400) return;
  lastPulseWrite = Date.now();
  if (pulseMode === 'doc' && pulseRef) {
    try {
      await setDoc(pulseRef, {
        at: serverTimestamp(), by: playerId, code: roomCode,
        expiresAt: new Date(Date.now() + ROOM_TTL_MS),
      });
      return;
    } catch (e) {
      if (e?.code !== 'permission-denied') return;
      pulseUnavailable();
    }
  }
  try { await updateDoc(roomRef, { pulseAt: serverTimestamp(), pulseBy: playerId }); }
  catch { /* fine */ }
}

function healthCheck() {
  if (!roomRef) return;
  if (shouldPulse()) writePulse();

  const stale = Date.now() - lastFreshAt;
  if (stale > STALE_RESET_MS) hardReset();
  else if (stale > STALE_PULL_MS) pullFromServer();
  else if (stale > STALE_RESUB_MS) resubscribe(true);
  setConnBadge(stale > STALE_RESUB_MS);

  // Your phone is on the table and the table is waiting for you. Nudge, but give up
  // after a while so it doesn't buzz all evening.
  const g = game();
  if (g && g.phase !== 'over' && R.waitingOn(g, playerId)
      && nudgeCount < 6 && Date.now() - nudgedAt > 6000) {
    nudgedAt = Date.now();
    nudgeCount += 1;
    buzz([60, 50, 60]);
  }
}

function enterRoom(code) {
  roomCode = code;
  roomRef = doc(db, 'rooms', code);
  pulseRef = doc(db, 'pulses', code);
  localStorage.setItem('hexcolony_room', code);
  const now = Date.now();
  lastFreshAt = now; lastPulseSeenAt = now;
  lastPulseWrite = 0; lastPulseServerMs = 0; lastPulseBy = null;
  clockSamples = []; clockOffset = null;
  lastSeq = 0; lastPhaseKey = ''; payoutKey = null;
  announcedUp = null;
  resetGuess(); resetTrade();
  subscribeRoom();
  subscribePulse();
  // One immediate beat so this phone has a clock reading straight away.
  writePulse(true);
  if (healthInterval) clearInterval(healthInterval);
  healthInterval = setInterval(healthCheck, HEALTH_MS);
  showScreen('screen-lobby');
}

async function leaveRoom(removeSelf = true) {
  if (solo) { exitSolo(); return; }
  const wasPlaying = room?.state === 'playing' && game();
  const ref = roomRef;
  const others = Object.keys(room?.players || {}).filter((id) => id !== playerId);

  if (unsub) { unsub(); unsub = null; }
  if (unsubPulse) { unsubPulse(); unsubPulse = null; }
  if (healthInterval) { clearInterval(healthInterval); healthInterval = null; }

  if (removeSelf && ref && room) {
    try {
      if (!others.length) {
        // Last one out closes the room and its heartbeat, freeing the code.
        await deleteDoc(ref);
        if (pulseRef) deleteDoc(pulseRef).catch(() => {});
      } else {
        if (wasPlaying) {
          // Hand the seat to the engine so the turn never waits on a phone that left.
          await runTransaction(db, async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists()) return;
            const data = snap.data();
            const patch = { [`players.${playerId}`]: deleteField() };
            if (data.hostId === playerId) patch.hostId = others[0];
            if (data.game) {
              const res = R.applyMove(data.game, playerId, { type: 'dropPlayer', who: playerId });
              if (res.ok) {
                patch.game = res.game;
                if (res.game.phase === 'over') patch.state = 'over';
                if (res.game.turn.clockRestart) {
                  res.game.turn.clockRestart = false;
                  patch.turnStartedAt = serverTimestamp();
                }
              }
            }
            tx.update(ref, patch);
          });
        } else {
          const patch = { [`players.${playerId}`]: deleteField() };
          if (room.hostId === playerId) patch.hostId = others[0];
          await updateDoc(ref, patch);
        }
      }
    } catch { /* best effort — walking out must never hang */ }
  }

  setConnBadge(false);
  roomCode = null; roomRef = null; pulseRef = null; room = null;
  board = null; boardSeed = null;
  resetGuess(); resetTrade();
  localStorage.removeItem('hexcolony_room');
  keepAwake(false);
  closeSheet();
  showScreen('screen-home');
}

// ---------------------------------------------------------------- posting moves
// Moves go up one at a time and in the order they were tapped, so the server replays
// the turn the way it was played. They used to be *refused* while one was in flight,
// which was invisible when a tap took a second to show anything — and now that the tap
// draws at once, a refusal would contradict a road already on the board. Two quick taps
// (the pair of free roads off a Road Building card, say) both land.
let sendChain = Promise.resolve();
// Bumped whenever the server turns a move down. Anything already queued behind the
// refusal was worked out from a state that never existed, so it is dropped rather than
// sent.
let sendEra = 0;

/**
 * Send a move.
 *
 * The move is drawn straight away where this device can work it out (see `drawGuess`),
 * and the transaction below then confirms or overrules it. The engine re-validates
 * inside that transaction against the state actually on the server, so two people
 * acting at once cannot both win the race — the guess never gets a vote.
 */
function send(move, opts = {}) {
  if (solo) return Promise.resolve(sendLocal(move, opts));
  if (!roomRef) return Promise.resolve(false);
  const drew = drawGuess(move);
  const era = sendEra;
  const run = sendChain.then(() => postMove(move, opts, drew, era));
  // The chain must survive a failed move, or every later tap queues behind a rejection
  // that already resolved.
  sendChain = run.then(() => {}, () => {});
  return run;
}

async function postMove(move, opts, drew, era) {
  // A move queued behind one the server refused was reasoned from a state that never
  // happened. Sending it anyway would be asking for a second, more confusing refusal.
  if (era !== sendEra) return false;
  if (!roomRef) return false;
  let rejected = null;
  try {
    await withTimeout(runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) { rejected = 'The room is gone.'; return; }
      const data = snap.data();
      if (!data.game) { rejected = 'The game has not started.'; return; }
      const res = R.applyMove(data.game, playerId, move);
      if (!res.ok) { rejected = res.error; return; }
      const patch = { game: res.game };
      if (res.game.phase === 'over') patch.state = 'over';
      // The engine says the allowance restarts; Firestore says when. Stamping it
      // server-side is what stops a device with a wrong clock poisoning the deadline
      // for everyone — no client's idea of "now" ever reaches the shared state.
      if (res.game.turn.clockRestart) {
        res.game.turn.clockRestart = false;
        patch.turnStartedAt = serverTimestamp();
      }
      tx.update(roomRef, patch);
    }), 15000);
  } catch (e) {
    console.error(e);
    rejected = 'That did not go through — check your connection.';
  }
  if (rejected) {
    // Whatever was drawn for this move did not happen. Put the server's state back
    // before saying so, so the message and the board agree.
    if (drew) { sendEra += 1; dropGuess(); }
    // Automatic moves are sent by every device at once; all but the first are expected
    // to be refused, and saying so would be noise rather than news.
    if (!opts.quiet) { toast(rejected); sfx.error(); }
    return false;
  }
  nudgeCount = 0;
  return true;
}

// ---------------------------------------------------------------- map choice
// Between the lobby and the first roll the host flips through boards while everyone
// watches. The offered maps live in the room as a list of seeds rather than a single
// one, so "previous" really returns to the board people just saw instead of rolling a
// different one, and every screen renders the same island from the same seed.
const mapSeedNow = () => room?.mapSeeds?.[room?.mapIndex ?? 0] ?? null;
const newSeed = () => Math.floor(Math.random() * 2 ** 31);

async function beginMapChoice() {
  if (!isHost()) return toast('Only the host can start.');
  if (!solo && Object.keys(room.players || {}).length < 2) {
    return toast('You need at least two players.');
  }
  const patch = { state: 'map', mapSeeds: [newSeed()], mapIndex: 0 };
  if (solo) { Object.assign(room, patch); render(); return; }
  try { await updateDoc(roomRef, patch); }
  catch { toast('Could not open the map picker.'); }
}

async function stepMap(dir) {
  if (!isHost()) return;
  const seeds = (room.mapSeeds || []).slice();
  let idx = room.mapIndex ?? 0;
  if (dir > 0) {
    idx += 1;
    // Only roll a new board when going past the end of what has been shown.
    if (idx >= seeds.length) seeds.push(newSeed());
  } else {
    if (idx === 0) return;
    idx -= 1;
  }
  sfx.tap();
  const patch = { mapSeeds: seeds, mapIndex: idx };
  if (solo) { Object.assign(room, patch); render(); return; }
  try { await updateDoc(roomRef, patch); } catch { /* the next tap will retry */ }
}

async function backToLobby() {
  if (!isHost()) return;
  sfx.tap();
  if (solo) { room.state = 'lobby'; render(); return; }
  try { await updateDoc(roomRef, { state: 'lobby' }); } catch { /* fine */ }
}

async function acceptMap() {
  if (!isHost()) return;
  const seed = mapSeedNow();
  if (seed === null) return;
  sfx.yourTurn();

  if (solo) {
    const game = R.newGame(room.order, { ...room.settings, seed });
    game.turn.clockRestart = false;
    room.state = 'playing';
    room.game = game;
    // The first placement is already on the clock, so it needs its starting point.
    room.turnStartedAt = Date.now();
    delete room.mapSeeds;
    delete room.mapIndex;
    saveSolo();
    lastSeq = 0;
    render();
    scheduleBots(900);
    return;
  }

  const ids = Object.keys(room.players || {});
  if (ids.length < 2) return toast('You need at least two players.');
  // Seat order is shuffled here, which is this game's version of rolling for first player.
  const order = shuffle(ids);
  const game = R.newGame(order, { ...room.settings, seed });
  // Setup is timed from the moment the board appears, and the deadline is only
  // meaningful against a stamp every device reads the same way — so the server sets it,
  // exactly as it does for every later turn.
  game.turn.clockRestart = false;
  try {
    await updateDoc(roomRef, { state: 'playing', order, game, turnStartedAt: serverTimestamp() });
  } catch (e) {
    console.error(e);
    toast('Could not start — check your connection.');
  }
}

/** The board preview, shown to everyone while the host flips through maps. */
function renderMapPreview() {
  if (!$('screen-game').classList.contains('is-active')) {
    showScreen('screen-game');
    view.resetView();
  }
  ensureBoard();
  view.setGame(null);
  view.setHighlights({ verts: [], edges: [], hexes: [] });
  view.setPayout(null);       // whatever the last game's dice lit, this is a new island
  view.setRolled(null);

  const host = isHost();
  const badge = $('turn-badge');
  badge.textContent = host ? 'Choose a map' : `${nameFor(room.hostId)} is choosing a map`;
  badge.classList.toggle('mine', host);

  $('score-strip').innerHTML = '';
  $('dice-float').hidden = true;
  $('turn-timer').hidden = true;
  $('hand').innerHTML = `<span class="map-count">Map ${(room.mapIndex ?? 0) + 1}`
    + `${LAYOUT_INFO[room.settings?.layout || 'classic']?.tiles ? ` · ${LAYOUT_INFO[room.settings.layout || 'classic'].tiles} tiles` : ''}</span>`;

  if (!host) {
    $('actions').innerHTML =
      `<div class="act-prompt"><span class="act-ico">🗺️</span>${esc(nameFor(room.hostId))} is choosing a map</div>`;
    return;
  }

  const atStart = (room.mapIndex ?? 0) === 0;
  $('actions').innerHTML = `
    <div class="map-bar">
      <button class="map-step" data-map="back" title="Back to the lobby">
        <svg viewBox="0 0 24 24"><path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Lobby
      </button>
      <button class="map-step" data-map="prev"${atStart ? ' disabled' : ''}>
        <svg viewBox="0 0 24 24"><path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Previous
      </button>
      <button class="map-accept" data-map="accept">Accept this map</button>
      <button class="map-step" data-map="next">
        <svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Next
      </button>
    </div>`;

  for (const b of document.querySelectorAll('[data-map]')) {
    b.addEventListener('click', () => {
      const what = b.dataset.map;
      if (what === 'next') stepMap(1);
      else if (what === 'prev') stepMap(-1);
      else if (what === 'back') backToLobby();
      else acceptMap();
    });
  }
}

// ---------------------------------------------------------------- solo play
const isBot = (pid) => !!room?.players?.[pid]?.bot;

/** The local twin of `send` — same engine, same validation, no server. */
function sendLocal(move, opts = {}) {
  const g = room?.game;
  if (!g) return false;
  const res = R.applyMove(g, playerId, move);
  if (!res.ok) {
    if (!opts.quiet) { toast(res.error); sfx.error(); }
    return false;
  }
  room.game = res.game;
  if (res.game.turn.clockRestart) { res.game.turn.clockRestart = false; room.turnStartedAt = Date.now(); }
  saveSolo();
  render();
  scheduleBots();
  return true;
}

/** Which bot, if any, the game is currently waiting on. */
function botActor(g) {
  if (!g || g.phase === 'over') return null;
  if (g.phase === 'discard') return Object.keys(g.pending.discard).find(isBot) || null;
  for (const t of g.trades || []) {
    // Everyone still to answer this offer, then the proposer closing it out.
    const pending = g.seats.filter((s) => s !== t.from && !t.replies[s]);
    const waiting = pending.find(isBot);
    if (waiting) return waiting;
    if (!pending.length && isBot(t.from)) return t.from;
  }
  if ((g.trades || []).length) return null;
  const up = R.currentPid(g);
  return isBot(up) ? up : null;
}

// Bots think instantly, which is unreadable. Pace each kind of move so you can follow
// what happened — the dice in particular need a beat to be seen.
function paceFor(move) {
  switch (move?.type) {
    // Paced against the recorded effects, but not slaved to them — a bot that waited out
    // every sound in full would crawl. Rolling gets the longest beat because the number
    // has to be read, not just heard.
    case 'roll': return 1200;
    case 'moveRobber': return 900;
    case 'steal': return 800;
    case 'build': return move.what === 'city' ? 1200 : 1000;
    case 'playDev': return 900;
    case 'endTurn': return 500;
    default: return 620;
  }
}

function scheduleBots(delay = 620) {
  clearTimeout(soloTimer);
  if (!solo) return;
  const who = botActor(room?.game);
  if (!who) return;
  soloTimer = setTimeout(() => runBot(who), delay);
}

/**
 * A guaranteed-legal move for whatever the game is waiting on.
 *
 * The bot brain returns null when it has nothing it wants to do, which is the right
 * answer to "do you want anything?" but a terrible one to "it is your turn". A solo
 * game freezing is the worst failure it has — there is no other player to nudge it —
 * so every phase that demands an action has a dumb, always-valid answer here.
 */
function fallbackMove(g, pid) {
  switch (g.phase) {
    case 'setup': {
      if (g.setup.need === 's') {
        const spots = R.legalSettlements(g, pid, true);
        return spots.length ? { type: 'setupSettlement', v: spots[0] } : null;
      }
      const roads = R.legalRoads(g, pid, g.setup.lastV);
      return roads.length ? { type: 'setupRoad', e: roads[0] } : null;
    }
    case 'roll':
      return { type: 'roll' };
    case 'discard': {
      const owed = g.pending.discard[pid];
      if (!owed) return null;                    // someone else owes; nothing to do
      const res = {};
      let left = owed;
      for (const r of RESOURCES) {
        const take = Math.min(left, g.players[pid].res[r] || 0);
        if (take > 0) { res[r] = take; left -= take; }
        if (!left) break;
      }
      return { type: 'discard', res };
    }
    case 'robber': {
      const hex = HEXES.map((h) => h.i).find((i) => i !== g.robber);
      return hex === undefined ? null : { type: 'moveRobber', hex };
    }
    case 'steal':
      return g.pending.stealFrom.length ? { type: 'steal', from: g.pending.stealFrom[0] } : null;
    // The no-robber version of the same step. Without this a solo game with the robber
    // switched off could stop dead here, and there is no other player to unstick it.
    case 'take':
      return g.pending.stealFrom.length ? { type: 'takeCard', from: g.pending.stealFrom[0] } : null;
    case 'build': {
      if (g.turn.freeRoads > 0) {
        const roads = R.legalRoads(g, pid);
        if (roads.length) return { type: 'build', what: 'road', e: roads[0] };
      }
      return { type: 'endTurn' };
    }
    default:
      return null;
  }
}

function runBot(pid) {
  if (!solo || !room?.game) return;
  const g = room.game;
  const board = ensureBoard();
  const level = room.players[pid]?.level || 'medium';

  let move = null;
  try { move = botMove(g, board, pid, level); } catch (e) { console.error('bot brain failed', e); }
  if (!move) move = fallbackMove(g, pid);
  if (!move) return;

  let res = R.applyMove(g, pid, move);
  if (!res.ok) {
    // A bot must never be able to wedge the game, and in solo there is nobody else to
    // unstick it. Fall back to the always-legal move for this phase before giving up.
    console.warn('bot move rejected:', move.type, res.error);
    const safe = fallbackMove(g, pid);
    res = safe ? R.applyMove(g, pid, safe) : res;
  }
  if (!res.ok) { console.error('bot could not act at all in phase', g.phase); return; }
  room.game = res.game;
  if (res.game.turn.clockRestart) { res.game.turn.clockRestart = false; room.turnStartedAt = Date.now(); }
  saveSolo();
  render();
  scheduleBots(paceFor(move));
}

// ---- persistence: a solo game survives closing the app
function saveSolo() {
  if (!solo || !room || !room.game) return;
  try {
    localStorage.setItem(SOLO_KEY, JSON.stringify({
      players: room.players, order: room.order, game: room.game,
      settings: room.settings, level: room.level, bots: room.bots,
    }));
  } catch { /* storage full or blocked — the game still plays, it just won't resume */ }
}
function loadSolo() {
  try { return JSON.parse(localStorage.getItem(SOLO_KEY) || 'null'); } catch { return null; }
}
function clearSolo() { try { localStorage.removeItem(SOLO_KEY); } catch { /* fine */ } }

function enterSolo(saved) {
  solo = true;
  roomCode = null; roomRef = null; pulseRef = null;
  lastSeq = 0; lastPhaseKey = ''; payoutKey = null;
  announcedUp = null;
  resetGuess(); resetTrade();
  room = {
    code: 'SOLO', hostId: playerId, state: 'playing', solo: true,
    players: saved.players, order: saved.order, game: saved.game,
    settings: saved.settings, level: saved.level, bots: saved.bots,
  };
  boardSeed = null;
  // A resumed game has no start stamp — it was never saved, and holding someone to a
  // deadline that expired while the app was shut would be absurd. The current step
  // simply gets its allowance afresh.
  room.turnStartedAt = Date.now();
  showScreen('screen-game');
  view.resetView();
  render();
  // Skip the audio replay of everything that already happened on a resume.
  lastSeq = Math.max(0, ...(room.game.log || []).map((e) => e.i || 0));
  scheduleBots(900);
}

function startSolo(level, botCount, targetVP, layout = 'classic', useRobber = true) {
  const bots = makeBots(botCount, level, myColorIdx);
  const me = myName() || 'You';
  const players = {
    [playerId]: { name: me, colorIdx: myColorIdx, joinedAt: Date.now() },
  };
  for (const b of bots) {
    players[b.id] = {
      name: b.name, colorIdx: b.colorIdx,
      joinedAt: Date.now(), bot: true, level: b.level,
    };
  }
  // Seat order is shuffled, so you don't always open the board.
  const order = shuffle([playerId, ...bots.map((b) => b.id)]);
  const settings = {
    targetVP, discardLimit: 7, boardMode: 'random', layout, useRobber,
    turnSeconds: soloTurnSeconds, sea: soloSea,
  };

  // Straight to the map picker: solo has a host too, and it is you.
  solo = true;
  roomCode = null; roomRef = null; pulseRef = null;
  lastSeq = 0; lastPhaseKey = ''; payoutKey = null;
  announcedUp = null;
  resetGuess(); resetTrade();
  boardSeed = null;
  room = {
    code: 'SOLO', hostId: playerId, state: 'map', solo: true,
    players, order, game: null, settings, level, bots: botCount,
    mapSeeds: [newSeed()], mapIndex: 0,
  };
  render();
}

function exitSolo() {
  clearTimeout(soloTimer);
  solo = false;
  room = null;
  board = null; boardSeed = null;
  clearSolo();
  closeSheet();
  keepAwake(false);
  showScreen('screen-home');
  paintLookButton();
  refreshResume();
}

/** Offer to pick up an unfinished solo game. */
function refreshResume() {
  const saved = loadSolo();
  const btn = $('btn-resume');
  if (!saved?.game || saved.game.phase === 'over') { btn.hidden = true; return; }
  const g = saved.game;
  const mine = R.publicVP(g, playerId);
  const best = Math.max(...g.seats.map((s) => R.publicVP(g, s)));
  const lvl = BOT_LEVELS[saved.level]?.label || saved.level;
  $('resume-sub').textContent = `Turn ${g.turn.num} · ${lvl} · you ${mine}, best ${best}`;
  btn.hidden = false;
}

// ---- solo setup sheet
let soloLevel = localStorage.getItem('hexcolony_solo_level') || 'medium';
let soloBots = Number(localStorage.getItem('hexcolony_solo_bots') || 3);
let soloTarget = Number(localStorage.getItem('hexcolony_solo_target') || 10);
let soloLayout = localStorage.getItem('hexcolony_solo_layout') || 'classic';
let soloRobber = localStorage.getItem('hexcolony_solo_robber') !== 'off';
let soloTurnSeconds = Number(localStorage.getItem('hexcolony_solo_timer') || 0);
let soloSea = localStorage.getItem('hexcolony_solo_sea') || SEA_DEFAULT;

function drawSoloSheet() {
  for (const b of document.querySelectorAll('#solo-levels [data-level]')) {
    b.classList.toggle('on', b.dataset.level === soloLevel);
  }
  $('solo-blurb').textContent = BOT_LEVELS[soloLevel]?.blurb || '';
  for (const b of document.querySelectorAll('[data-solo-layout]')) {
    b.classList.toggle('on', b.dataset.soloLayout === soloLayout);
  }
  $('solo-layout-blurb').textContent = LAYOUT_INFO[soloLayout]?.blurb || '';
  for (const b of document.querySelectorAll('[data-solo-robber]')) {
    b.classList.toggle('on', (b.dataset.soloRobber === 'on') === soloRobber);
  }
  for (const b of document.querySelectorAll('[data-solo-timer]')) {
    b.classList.toggle('on', Number(b.dataset.soloTimer) === soloTurnSeconds);
  }
  $('solo-timer-blurb').textContent = soloTurnSeconds
    ? `${soloTurnSeconds}s to act, ${R.ROLL_SECONDS}s to roll. Doing something adds 10s.`
    : 'No limit — take as long as you like.';
  $('solo-robber-blurb').textContent = soloRobber
    ? 'Discard down, move the robber, rob whoever it lands on.'
    : 'No discard, no robber — just take a card from any player.';
  drawSeaRow('solo-sea-row', soloSea, (key) => {
    soloSea = key;
    localStorage.setItem('hexcolony_solo_sea', key);
    sfx.tap();
    drawSoloSheet();
  });
  $('solo-sea-blurb').textContent = `${seaAt(soloSea).name} — the water around the island`;
  $('solo-bots').textContent = String(soloBots);
  $('solo-target').textContent = String(soloTarget);
}

for (const b of document.querySelectorAll('[data-solo-timer]')) {
  b.addEventListener('click', () => {
    soloTurnSeconds = Number(b.dataset.soloTimer);
    localStorage.setItem('hexcolony_solo_timer', String(soloTurnSeconds));
    sfx.tap();
    drawSoloSheet();
  });
}
for (const b of document.querySelectorAll('[data-solo-layout]')) {
  b.addEventListener('click', () => {
    soloLayout = b.dataset.soloLayout;
    localStorage.setItem('hexcolony_solo_layout', soloLayout);
    sfx.tap();
    drawSoloSheet();
  });
}
for (const b of document.querySelectorAll('[data-solo-robber]')) {
  b.addEventListener('click', () => {
    soloRobber = b.dataset.soloRobber === 'on';
    localStorage.setItem('hexcolony_solo_robber', soloRobber ? 'on' : 'off');
    sfx.tap();
    drawSoloSheet();
  });
}

$('btn-solo').addEventListener('click', () => { unlock(); sfx.tap(); drawSoloSheet(); sheet('sheet-solo'); });
$('btn-resume').addEventListener('click', () => {
  unlock();
  const saved = loadSolo();
  if (!saved?.game) { refreshResume(); return; }
  // A finished game is not something to resume into; drop it so the offer stops.
  if (saved.game.phase === 'over') { clearSolo(); refreshResume(); return; }
  sfx.tap();
  enterSolo(saved);
});

for (const b of document.querySelectorAll('#solo-levels [data-level]')) {
  b.addEventListener('click', () => {
    soloLevel = b.dataset.level;
    localStorage.setItem('hexcolony_solo_level', soloLevel);
    sfx.tap();
    drawSoloSheet();
  });
}
for (const b of document.querySelectorAll('[data-solo]')) {
  b.addEventListener('click', () => {
    const step = Number(b.dataset.step);
    if (b.dataset.solo === 'bots') {
      soloBots = Math.max(1, Math.min(5, soloBots + step));
      localStorage.setItem('hexcolony_solo_bots', String(soloBots));
    } else {
      soloTarget = Math.max(5, Math.min(15, soloTarget + step));
      localStorage.setItem('hexcolony_solo_target', String(soloTarget));
    }
    sfx.tap();
    drawSoloSheet();
  });
}
$('btn-solo-start').addEventListener('click', () => {
  closeSheet();
  startSolo(soloLevel, soloBots, soloTarget, soloLayout, soloRobber);
});

// ---------------------------------------------------------------- lobby
$('lobby-back').addEventListener('click', () => leaveRoom(true));
$('lobby-code').addEventListener('click', copyCode);
$('lobby-share').addEventListener('click', shareRoom);

async function copyCode() {
  try {
    await navigator.clipboard.writeText(roomCode);
    toast(`Copied ${roomCode}`);
  } catch { toast(`Room code: ${roomCode}`); }
}

async function shareRoom() {
  const text = `Join my HexColony game — room code ${roomCode}`;
  const url = location.href.split('?')[0];
  if (navigator.share) {
    try { await navigator.share({ title: 'HexColony', text, url }); return; } catch { /* cancelled */ }
  }
  copyCode();
}

for (const b of document.querySelectorAll('[data-set]')) {
  b.addEventListener('click', () => {
    const key = b.dataset.set;
    const step = Number(b.dataset.step);
    const s = room?.settings || {};
    const patch = key === 'target'
      ? { 'settings.targetVP': Math.max(5, Math.min(15, (s.targetVP || 10) + step)) }
      : { 'settings.discardLimit': Math.max(5, Math.min(12, (s.discardLimit || 7) + step)) };
    if (setSetting(patch)) sfx.tap();
  });
}

for (const b of document.querySelectorAll('[data-board]')) {
  b.addEventListener('click', () => {
    if (setSetting({ 'settings.boardMode': b.dataset.board })) sfx.tap();
  });
}

for (const b of document.querySelectorAll('[data-timer]')) {
  b.addEventListener('click', () => {
    if (setSetting({ 'settings.turnSeconds': Number(b.dataset.timer) })) sfx.tap();
  });
}

for (const b of document.querySelectorAll('[data-robber]')) {
  b.addEventListener('click', () => {
    if (setSetting({ 'settings.useRobber': b.dataset.robber === 'on' })) sfx.tap();
  });
}

/**
 * Change a room setting from the lobby.
 *
 * A solo game has a lobby too — it is one tap back from the map picker — but no room
 * document, and every one of these handlers passed a null reference straight to
 * updateDoc. That throws synchronously, which the trailing .catch() does not catch, so
 * touching any setting there took the screen down. Solo keeps its settings in memory.
 */
function setSetting(patch) {
  if (!isHost()) { toast('Only the host can change the setup.'); return false; }
  if (solo) {
    room.settings = room.settings || {};
    for (const [k, v] of Object.entries(patch)) room.settings[k.replace('settings.', '')] = v;
    render();
    return true;
  }
  updateDoc(roomRef, patch).catch(() => {});
  return true;
}

function pickSea(key) {
  if (!setSetting({ 'settings.sea': key })) return;
  sfx.tap();
  // Remembered for the next solo game too, the way the other solo options are.
  if (solo) { soloSea = key; localStorage.setItem('hexcolony_solo_sea', key); }
  applySea();
}

for (const b of document.querySelectorAll('[data-layout]')) {
  b.addEventListener('click', () => {
    const layout = b.dataset.layout;
    const patch = { 'settings.layout': layout };
    // The fixed "Standard" arrangement only exists for the 19-tile island, so choosing
    // the expansion also drops back to a shuffled board rather than silently ignoring it.
    if (layout === 'expansion') patch['settings.boardMode'] = 'random';
    if (setSetting(patch)) sfx.tap();
  });
}

$('btn-start').addEventListener('click', beginMapChoice);

function renderLobby() {
  $('lobby-code').textContent = roomCode || '----';
  const ids = Object.keys(room.players || {})
    .sort((a, b) => (room.players[a].joinedAt || 0) - (room.players[b].joinedAt || 0));
  $('lobby-count').textContent = String(ids.length);

  $('seat-list').innerHTML = ids.map((pid) => {
    const p = room.players[pid];
    const c = colorFor(pid);
    const tags = [];
    if (pid === room.hostId) tags.push('<span class="seat-tag host">Host</span>');
    if (pid === playerId) tags.push('<span class="seat-tag you">You</span>');
    // Your own row opens the colour picker — the only place it is reachable once you
    // have left the home screen, and the only place the "already taken" marks mean
    // anything, since that is when you can see who else is at the table.
    const tag = pid === playerId ? 'button' : 'div';
    const extra = pid === playerId ? ' data-my-seat title="Tap to change your colour"' : '';
    return `<${tag} class="seat${pid === playerId ? ' seat-me' : ''}" style="border-left-color:${esc(c)};--c:${esc(c)}"${extra}>
      <span class="seat-swatch"></span>
      <span class="seat-name">${esc(p.name)}</span>${tags.join('')}
    </${tag}>`;
  }).join('');

  const mySeat = document.querySelector('[data-my-seat]');
  if (mySeat) mySeat.addEventListener('click', () => { unlock(); sfx.tap(); openColourPicker(); });

  const s = room.settings || {};
  $('set-target').textContent = String(s.targetVP || 10);
  $('set-discard').textContent = String(s.discardLimit || 7);
  const turnSeconds = R.TURN_OPTIONS.includes(s.turnSeconds) ? s.turnSeconds : 0;
  for (const b of document.querySelectorAll('[data-timer]')) {
    b.classList.toggle('on', Number(b.dataset.timer) === turnSeconds);
  }
  $('timer-blurb').textContent = turnSeconds
    ? `${turnSeconds}s to act, ${R.ROLL_SECONDS}s to roll. Doing something adds 10s.`
    : 'No limit — take as long as you like.';

  const useRobber = s.useRobber !== false;
  for (const b of document.querySelectorAll('[data-robber]')) {
    b.classList.toggle('on', (b.dataset.robber === 'on') === useRobber);
  }
  $('robber-blurb').textContent = useRobber
    ? 'Discard down, move the robber, rob whoever it lands on.'
    : 'No discard, no robber — just take a card from any player.';
  // The discard limit has nothing to govern once the robber is off.
  for (const b of document.querySelectorAll('[data-set="discard"]')) b.disabled = !useRobber;
  const discardRow = $('set-discard').closest('.opt-row');
  if (discardRow) discardRow.style.opacity = useRobber ? '' : '0.4';

  const layout = s.layout || 'classic';
  for (const b of document.querySelectorAll('[data-layout]')) {
    b.classList.toggle('on', b.dataset.layout === layout);
  }
  $('layout-blurb').textContent = LAYOUT_INFO[layout]?.blurb || '';

  const sea = s.sea;
  drawSeaRow('sea-row', sea, pickSea);
  $('sea-blurb').textContent = `${seaAt(sea).name} — the water around the island`;
  applySea();
  for (const b of document.querySelectorAll('[data-board]')) {
    b.classList.toggle('on', b.dataset.board === (s.boardMode || 'random'));
    // A fixed arrangement is only defined for the classic island.
    b.disabled = layout !== 'classic' && b.dataset.board === 'classic';
    b.style.opacity = b.disabled ? '0.4' : '';
  }

  const enough = ids.length >= 2;
  $('btn-start').disabled = !enough || !isHost();
  $('start-hint').textContent = !enough
    ? 'Needs at least 2 players.'
    : isHost() ? 'Everyone in? Pick a map next.' : `Waiting for ${esc(nameFor(room.hostId))} to start.`;
  $('lobby-hint').textContent = isHost()
    ? 'Share the code — players can join until you start.'
    : 'You can change your name and colour on the home screen.';
}

// ---------------------------------------------------------------- board plumbing
/** Paint the water the host chose. An unknown or missing choice falls back to the default. */
function applySea() {
  view.setSea(room?.settings?.sea);
}

/**
 * The swatches, darkest water first.
 *
 * Identified by key rather than by position: the player colours were stored as indexes
 * into an array, and reordering that array repainted everybody's pieces. A list of
 * twenty-seven is going to be reordered again.
 */
function drawSeaRow(elId, chosen, onPick) {
  const row = $(elId);
  if (!row) return;
  const now = seaAt(chosen).key;
  row.innerHTML = SEA_COLORS.map((c) => `
    <button class="sea-cell${c.key === now ? ' on' : ''}" data-sea="${esc(c.key)}"
      style="--a:${c.a};--b:${c.b}" aria-label="${esc(c.name)} sea"
      title="${esc(c.name)}">${c.key === now ? '✓' : ''}</button>`).join('');
  for (const b of row.querySelectorAll('[data-sea]')) {
    b.addEventListener('click', () => onPick(b.dataset.sea));
  }
}

function ensureBoard() {
  const g = game();
  // During map selection there is no game yet, so the preview is built from the room's
  // currently-offered seed instead.
  const seed = g ? g.seed : mapSeedNow();
  if (seed === null || seed === undefined) return null;
  const mode = g ? g.mode : (room?.settings?.boardMode || 'random');
  const layout = (g ? g.layout : room?.settings?.layout) || 'classic';
  // Rebuilding also re-points the shared topology at this game's island, so this has
  // to run before anything asks the rules where a road may go.
  if (boardSeed !== seed || board?.mode !== mode || board?.layout !== layout) {
    board = makeBoard(seed, mode, layout);
    boardSeed = seed;
    view.setBoard(board);
  }
  applySea();
  return board;
}

view.onPick = (hit) => {
  const g = game();
  if (!g) return;
  unlock();

  if (hit.kind === 'info') {
    const t = board.tiles[hit.id];
    const tip = $('tile-tip');
    const robbed = g.robber === hit.id ? ' · robber here' : '';
    tip.textContent = t.res
      ? `${TERRAIN[t.terrain].label} · ${t.num} · ${TERRAIN[t.terrain].short}${robbed}`
      : `${TERRAIN[t.terrain].label} — produces nothing${robbed}`;
    tip.hidden = false;
    clearTimeout(tip._t);
    tip._t = setTimeout(() => { tip.hidden = true; }, 2400);
    return;
  }

  if (g.phase === 'setup') {
    if (hit.kind === 'vertex') send({ type: 'setupSettlement', v: hit.id });
    if (hit.kind === 'edge') send({ type: 'setupRoad', e: hit.id });
    return;
  }
  if (g.phase === 'robber' && hit.kind === 'hex') {
    send({ type: 'moveRobber', hex: hit.id });
    return;
  }
  // Only legal, affordable targets are ever highlighted, and only highlighted things can
  // be hit — so what was tapped is the whole instruction. No mode to choose first.
  if (hit.kind === 'edge') {
    send({ type: 'build', what: 'road', e: hit.id });
    return;
  }
  if (hit.kind === 'vertex') {
    send({ type: 'build', what: 'settlement', v: hit.id });
    return;
  }
  if (hit.kind === 'city') {
    send({ type: 'build', what: 'city', v: hit.id });
  }
};


$('btn-recenter').addEventListener('click', () => { view.resetView(); sfx.tap(); });

// A continuous loop so the legal-move highlights can pulse and the sea drifts.
//
// It only draws when there is something to look at. The board is behind the home and
// lobby screens, and a hidden tab or a pocketed phone is not looking at anything — but
// the loop was redrawing the whole island, waves and all, sixty times a second
// throughout. That is a battery drain for no picture.
function loop(t) {
  requestAnimationFrame(loop);
  if (document.hidden) return;
  if (!$('screen-game').classList.contains('is-active')) return;
  view.draw(t);
}
requestAnimationFrame(loop);

// ---------------------------------------------------------------- turn clock
// The deadline lives in the game state; this only reads it. A short interval keeps the
// number moving without re-rendering the whole screen, and fires the automatic move
// when it runs out.
let autoFiredFor = null;
let timerInterval = null;

/** Firestore hands back a Timestamp; solo stores a plain number. */
function stampMs(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  return null;
}

function secondsLeft(g) {
  // `allowMs` is the whole answer: the engine sets it to 0 for any step that is not on
  // the clock. Listing the timed phases here as well was a second copy of that decision,
  // and it was already out of date — a player who had to discard, move the robber or
  // choose a victim could hold the entire table up for as long as they liked, timer
  // setting or not.
  if (!g || !g.turn.allowMs) return null;
  const started = stampMs(room?.turnStartedAt);
  if (started === null) return null;          // the server has not stamped it yet
  if (!clockTrusted()) return null;           // this device cannot be trusted to judge
  return (started + g.turn.allowMs - serverNow()) / 1000;
}

function drawTimer() {
  const g = game();
  const el = $('turn-timer');
  // Timed game, but this device has not measured the server clock yet — say so rather
  // than counting down from a number that might be minutes wrong.
  if (g && g.turn.allowMs && !clockTrusted()) {
    el.hidden = false;
    el.classList.remove('mine', 'urgent');
    $('timer-secs').textContent = '⋯';
    return;
  }
  const left = secondsLeft(g);
  if (left === null) { el.hidden = true; return; }
  const mine = R.isTurn(g, playerId);
  const secs = Math.max(0, Math.ceil(left));
  el.hidden = false;
  $('timer-secs').textContent = String(secs);
  el.classList.toggle('mine', mine);
  el.classList.toggle('urgent', secs <= 5);
}

/**
 * Run out of time and the turn takes itself.
 *
 * The player whose turn it is fires first. Everyone else waits three more seconds and
 * then tries too, which covers a phone that has gone to sleep mid-turn — the move goes
 * through the same transaction as any other, so a second attempt simply finds the turn
 * already over and is rejected harmlessly.
 */
async function fireTimeout() {
  const g = game();
  const left = secondsLeft(g);
  if (left === null || left > 0) return;

  // The phone whose turn it is goes first. Everyone else waits three more seconds and
  // then tries too, which is what covers the commonest stall of all: the phone on the
  // clock has gone to sleep and is the one device that cannot report it.
  const mine = R.waitingOn(g, playerId);
  if (!mine && left > -3) return;

  // Keyed on the move counter, so each automatic move can be followed by another. The
  // old key could not tell one forced discard from the next and stopped after one, which
  // left the rest of a seven's discards stuck.
  const key = `${g.turn.num}:${g.phase}:${g.seq}`;
  if (autoFiredFor === key) return;
  autoFiredFor = key;

  // One move type for every stalled step. The engine works out what was owed and credits
  // it to whoever owed it — this used to send `endTurn` as the local player, which the
  // engine rightly refused as "Not your turn", and then showed that refusal to every
  // innocent bystander at the table.
  await send({ type: 'timeout' }, { quiet: true });
}

function startTimerLoop() {
  if (timerInterval) return;
  timerInterval = setInterval(() => {
    if (!room || room.state !== 'playing') return;
    drawTimer();
    fireTimeout();
  }, 250);
}

// ---------------------------------------------------------------- game rendering
function render() {
  if (!room) return;

  if (room.state === 'lobby') {
    if (!$('screen-lobby').classList.contains('is-active')) showScreen('screen-lobby');
    renderLobby();
    return;
  }

  if (room.state === 'map') { renderMapPreview(); return; }

  const g = game();
  if (!g) return;
  ensureBoard();
  if (!$('screen-game').classList.contains('is-active')) {
    showScreen('screen-game');
    view.resetView();
  }

  view.setGame(g);
  // Whatever ended the moment you were in — the timer running out, a 7, someone
  // leaving — the pending "tap the board" is over with it. Clearing it here covers
  // every route out of your turn instead of each one having to remember.
  view.setHighlights(R.highlightsFor(g, playerId));

  reactToLog(g);
  announceTurn(g);
  updatePayout(g);
  startTimerLoop();
  drawTimer();
  renderScoreStrip(g);
  renderTurnBadge(g);
  renderDice(g);
  renderHand(g);
  renderActions(g);
  renderTrade(g);
  syncSheets(g);

  if (g.phase === 'over') renderOver(g);
}

// Sound and flourish are driven off the shared log, not off local move results, so
// every player hears the same dice and the same robber.
function reactToLog(g) {
  const entries = (g.log || []).filter((e) => (e.i || 0) > lastSeq);
  if (!entries.length) return;
  const first = lastSeq === 0;
  lastSeq = Math.max(lastSeq, ...(g.log || []).map((e) => e.i || 0));
  if (first) return; // don't replay the whole game's audio when you open the room

  $('log-dot').classList.add('on');
  for (const e of entries) {
    switch (e.t) {
      case 'roll': sfx.dice(); view.setRolled(e.roll); break;
      case 'build': e.what === 'city' ? sfx.city() : e.what === 'road' ? sfx.road() : sfx.build(); break;
      case 'robber': sfx.robber(); break;
      case 'steal':
        sfx.steal();
        if (e.p === playerId) toast(`You took a ${e.res} from ${nameFor(e.from)}.`);
        else if (e.from === playerId) toast(`${nameFor(e.p)} stole a ${e.res} from you.`);
        break;
      case 'produce':
        if (e.gains?.[playerId]) { sfx.gain(); bumpCards(Object.keys(e.gains[playerId])); }
        break;
      case 'mono':
        toast(e.p === playerId
          ? `You monopolised ${e.count} ${e.res}.`
          : `${nameFor(e.p)} monopolised ${e.res} — ${e.count} cards.`);
        break;
      case 'playDev': {
        const name = R.DEV_INFO[e.card]?.name || 'a card';
        sfx.card();
        toast(e.p === playerId ? `You played ${name}.` : `${nameFor(e.p)} played ${name}.`);
        break;
      }
      case 'noloot':
        if (e.p === playerId) toast('Nobody had a card to take.');
        break;
      case 'offer':
        // The tray shows the offer; this is what makes you look down at it.
        if (e.p !== playerId) { sfx.card(); toast(`${nameFor(e.p)} offers you a trade.`); }
        break;
      case 'trade': sfx.trade(); break;
      case 'bankTrade': if (e.p === playerId) sfx.trade(); break;
      case 'buyDev': if (e.p === playerId) sfx.card(); break;
      case 'longest': toast(`${e.p === playerId ? 'You take' : nameFor(e.p) + ' takes'} Longest Road (${e.len}).`); break;
      case 'army': toast(`${e.p === playerId ? 'You take' : nameFor(e.p) + ' takes'} Largest Army (${e.size}).`); break;
      case 'turn':
        if (e.p === playerId) { sfx.yourTurn(); buzz([40, 40, 40]); }
        break;
      case 'win': (e.p === playerId ? sfx.win : sfx.lose)(); break;
      default: break;
    }
  }
}

/**
 * Shout whose turn it is, once per turn, on every screen in the room.
 *
 * Keyed on the turn rather than just the player, so the same person coming round again
 * is a new turn and a player leaving mid-game cannot make the key repeat. Setup has no
 * turn number and turns proper have no setup index, so the two are keyed apart.
 */
const upKey = (g) => (g.phase === 'setup' ? `s${g.setup.at}` : `t${g.turn.num}`)
  + ':' + R.currentPid(g);

function announceTurn(g) {
  if (g.phase === 'over') return;
  const up = R.currentPid(g);
  if (!up) return;
  const key = upKey(g);
  if (key === announcedUp) return;
  const first = announcedUp === null;
  announcedUp = key;
  // Opening the app into a game already under way is not a turn changing hands — it is
  // finding out where the game got to, and shouting it would claim something happened
  // that did not. A game still on its first placement is the exception: that turn is
  // news to everyone watching it start.
  if (first && !(g.phase === 'setup' && (g.setup?.at ?? 0) === 0)) return;
  shoutout(`${nameFor(up)}'s turn`, colorFor(up));
}

function bumpCards(list) {
  for (const r of list) {
    const el = document.querySelector(`.rcard-wrap[data-res="${r}"]`);
    if (!el) continue;
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }
}

function renderScoreStrip(g) {
  const up = R.currentPid(g);
  $('score-strip').innerHTML = g.seats.map((pid) => {
    const p = g.players[pid];
    const crowns = (g.award.road === pid ? '🛣️' : '') + (g.award.army === pid ? '⚔️' : '');
    return `<button class="chip${pid === up ? ' up' : ''}" style="--c:${esc(colorFor(pid))};--ink:${esc(inkFor(pid))}" data-pcard>
      <span class="chip-name">${esc(nameFor(pid))}</span>
      <span class="chip-vp">${R.publicVP(g, pid)}</span>
      <span class="chip-cards">${R.handSize(p)}🂠</span>
      ${crowns ? `<span class="chip-crown">${crowns}</span>` : ''}
    </button>`;
  }).join('');
}

function turnText(g) {
  const up = R.currentPid(g);
  const mine = up === playerId;
  const who = mine ? 'You' : nameFor(up);
  if (g.phase === 'setup') {
    const what = g.setup.need === 's' ? 'a settlement' : 'a road';
    return mine ? `Place ${what}` : `${who} is placing ${what}`;
  }
  if (g.phase === 'discard') {
    const owed = g.pending.discard[playerId];
    if (owed) return `Discard ${owed} card${owed > 1 ? 's' : ''}`;
    const n = Object.keys(g.pending.discard).length;
    return `Waiting: ${n} to discard`;
  }
  if (g.phase === 'robber') return mine ? 'Move the robber' : `${who} is moving the robber`;
  if (g.phase === 'steal') return mine ? 'Choose who to rob' : `${who} is choosing who to rob`;
  if (g.phase === 'take') return mine ? 'Take a card' : `${who} is taking a card`;
  if (g.phase === 'roll') return mine ? 'Your turn — roll the dice' : `${who} to roll`;
  if (g.phase === 'build') {
    if (g.turn.freeRoads > 0 && mine) return `Place ${g.turn.freeRoads} free road${g.turn.freeRoads > 1 ? 's' : ''}`;
    return mine ? 'Your turn' : `${who}'s turn`;
  }
  if (g.phase === 'over') return `${g.winner === playerId ? 'You' : nameFor(g.winner)} won`;
  return '';
}

function renderTurnBadge(g) {
  const badge = $('turn-badge');
  const mine = R.isTurn(g, playerId) || (g.phase === 'discard' && g.pending.discard[playerId]);
  let text = turnText(g);
  if (mine && g.phase === 'build') {
    // Say what is actually lit, so the highlights are self-explanatory rather than
    // something to be decoded.
    const h = R.highlightsFor(g, playerId);
    // Icons rather than words: this shares the row with the clock and the dice now, and
    // the highlights on the board say the same thing at full length.
    const bits = [];
    if (h.edges.length) bits.push('🛣️');
    if (h.verts.length) bits.push('🏠');
    if (h.cities.length) bits.push('🏛️');
    if (bits.length) text = `Tap ${bits.join(' ')}`;
  }
  badge.textContent = text;
  badge.classList.toggle('mine', !!mine);
}

function renderDice(g) {
  const d = g.turn.dice;
  const wrap = $('dice-float');
  if (!d || g.phase === 'setup') { wrap.hidden = true; return; }
  wrap.hidden = false;
  if ($('die-a').textContent !== String(d[0]) || $('die-b').textContent !== String(d[1])) {
    $('die-a').textContent = String(d[0]);
    $('die-b').textContent = String(d[1]);
    $('die-sum').textContent = String(d[0] + d[1]);
    for (const el of [$('die-a'), $('die-b'), $('die-sum')]) {
      el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    }
  }
}

// How long the producing tiles stay lit after a roll lands.
const PAYOUT_MS = 6000;
let payoutKey = null;

/**
 * Light up what the roll just paid: the tiles that came up, and every building standing
 * on one, haloed in its owner's colour.
 *
 * Keyed on the roll's own log id rather than on the dice, so the flash starts once and
 * is not restarted by the next unrelated snapshot — and so two 8s in a row are two
 * separate flashes rather than one that never ends.
 */
function updatePayout(g) {
  const rollEvt = (g.log || []).filter((e) => e.t === 'roll').pop();
  const key = rollEvt ? `${rollEvt.i}` : null;
  if (key === payoutKey) return;
  payoutKey = key;

  const roll = rollEvt?.roll;
  // A seven pays nobody; there is nothing to light.
  if (!board || !roll || roll === 7) { view.setPayout(null); return; }

  const hexes = (board.byNumber[roll] || [])
    .filter((i) => g.useRobber === false || i !== g.robber);
  if (!hexes.length) { view.setPayout(null); return; }

  const spots = [];
  for (const i of hexes) {
    for (const v of HEXES[i].corners) {
      const b = g.bldg[v];
      // A player who has left still owns the building, but it is no longer paid.
      if (!b || !g.seats.includes(b.p)) continue;
      if (spots.some((sp) => sp.v === Number(v))) continue;
      spots.push({ v: Number(v), colour: colorFor(b.p), city: b.t === 'c' });
    }
  }
  view.setPayout({ hexes, spots, until: performance.now() + PAYOUT_MS });
}

function renderHand(g) {
  const p = g.players[playerId];
  if (!p) { $('hand').innerHTML = '<span class="hint">You are watching this game.</span>'; return; }
  const devs = R.devCount(p);
  $('hand').innerHTML = RESOURCES.map((r) => {
    const n = p.res[r] || 0;
    // While trading, the hand is the give side — there is no second copy of it in a
    // sheet any more, and no row of "have 3" labels standing in for cards you could not
    // see. The badge still counts what you hold; the label under it says how many of
    // them are going, or what the bank charges for them when none are.
    const take = trading ? (giveSel[r] || 0) : 0;
    return resCard(r, {
      count: n || null, dim: !n, size: 'sm', selected: !!take,
      dataset: ` data-res="${r}"`,
      label: trading ? (take ? `give ${take}` : `${R.tradeRate(g, board, playerId, r)}:1`) : '',
    });
    // A zero card stays on the table, greyed: the hand doubles as the legend for what
    // the board's tiles produce, and cards appearing and vanishing is hard to read.
  }).join('') + devCard({ count: devs || null, dim: !devs, size: 'sm' });
}

// Tapping your own card is how you overrule the payment the app worked out. One more
// each tap, round to nothing at the top, so a tap is always undoable by tapping again.
$('hand').addEventListener('click', (e) => {
  if (!trading) return;
  const el = e.target.closest('[data-res]');
  const g = game();
  if (!el || !g) return;
  const r = el.dataset.res;
  const have = g.players[playerId]?.res[r] || 0;
  if (!have) return;
  payTouched = true;
  giveSel[r] = ((giveSel[r] || 0) + 1) % (have + 1);
  if (!giveSel[r]) delete giveSel[r];
  sfx.tap();
  render();
});

function actBtn(id, ico, label, opts = {}) {
  const cls = ['act'];
  if (opts.primary) cls.push('primary');
  if (opts.wide) cls.push('wide');
  // Enabled says "you may press this". Ready says "there is something here worth pressing
  // it for" — for Cards that means the resources for a new one are in hand.
  if (opts.ready) cls.push('ready');
  const badge = opts.badge ? `<span class="badge">${opts.badge}</span>` : '';
  return `<button class="${cls.join(' ')}" data-act="${id}"${opts.disabled ? ' disabled' : ''}>
    <span class="act-ico">${ico}</span><span>${esc(label)}</span>${badge}</button>`;
}

function renderActions(g) {
  const mine = R.isTurn(g, playerId);
  const p = g.players[playerId];
  const bar = $('actions');
  // Whether the Cards sheet opens is a question about what is HELD, not about what can be
  // played this second. Gating it on the playable subset — which excludes victory points
  // and anything bought this turn — meant a victory point card, five of the twenty-five in
  // the deck, left the tray saying you owned a development card while the only door to it
  // was greyed out. What can actually be played is decided inside the sheet, per card,
  // where there is room to say why not.
  const held = p ? R.devCount(p) : 0;
  // The badge matches the tray's count rather than the playable subset; a badge that
  // disagreed with the number two inches below it would be its own small mystery.
  const devBadge = held;

  if (!p) { bar.innerHTML = actBtn('log', '📜', 'Game log', { wide: true }); return; }

  if (g.phase === 'over') {
    bar.innerHTML = actBtn('over', '🏆', 'Results', { primary: true, wide: true }) + actBtn('log', '📜', 'Log'); return;
  }

  if (g.phase === 'discard') {
    bar.innerHTML = g.pending.discard[playerId]
      ? actBtn('discard', '🗑️', `Discard ${g.pending.discard[playerId]}`, { primary: true, wide: true })
      : `<div class="act-prompt"><span class="act-ico">⏳</span>Waiting for others to discard</div>`
        + actBtn('dev', '🃏', 'Cards', { disabled: !held, badge: devBadge || 0 }); return;
  }

  // Cards stays in the bar while somebody else is playing. What is in your hand is
  // yours to look at whenever you like — it was only ever reachable on your own turn,
  // so the one time you actually want to check what you are holding, which is while you
  // are sitting there waiting, was the one time there was no way in. The sheet knows it
  // is not your turn and offers nothing to press.
  if (!mine || g.phase === 'setup') {
    bar.innerHTML = actBtn('players', '👥', 'Players')
      + actBtn('dev', '🃏', 'Cards', { disabled: !held, badge: devBadge || 0 })
      + actBtn('log', '📜', 'Log', { badge: 0 }); return;
  }

  if (g.phase === 'robber') {
    bar.innerHTML = `<div class="act-prompt"><span class="act-ico">🥷</span>Tap a highlighted tile to move the robber</div>`
      + actBtn('log', '📜', 'Log'); return;
  }

  if (g.phase === 'steal' || g.phase === 'take') {
    // A button back into the sheet, in case it was somehow closed.
    bar.innerHTML = actBtn('steal', '🥷', g.phase === 'take' ? 'Take a card' : 'Rob a player', { primary: true, wide: true })
      + actBtn('log', '📜', 'Log'); return;
  }

  if (g.phase === 'roll') {
    bar.innerHTML =
      actBtn('roll', '🎲', 'Roll', { primary: true, wide: true }) +
      actBtn('dev', '🃏', 'Cards', { disabled: !held, badge: devBadge || 0 }) +
      actBtn('log', '📜', 'Log'); return;
  }

  // build phase
  const can = R.whatCanIBuild(g, playerId);
  const mustPlace = g.turn.freeRoads > 0;
  bar.innerHTML =
    actBtn('trade', '🤝', 'Trade', { disabled: R.handSize(p) === 0 }) +
    actBtn('dev', '🃏', 'Cards', { disabled: !held && !can.dev, badge: devBadge || 0, ready: can.dev }) +
    actBtn('end', '✔️', 'End turn', { primary: !mustPlace, disabled: mustPlace });
}

// Delegated, and bound once to the containers rather than to the buttons.
//
// The action bar is rebuilt with innerHTML on every render, so a listener attached to a
// button dies with that button. Re-binding after each rebuild looks like it covers that,
// but the handlers were registered with { once: true }: the first tap consumed the
// listener, and opening or closing a sheet does not change any game state, so nothing
// re-rendered and nothing re-bound. Every button in the bar therefore worked exactly
// once per render — tap Trade, wave the sheet away, and Trade was dead. So were Build,
// Cards and End turn. A listener on the container survives the buttons being replaced.
$('actions').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b && !b.disabled) onAction(b.dataset.act);
});
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-pcard]')) openPlayers();
});

function onAction(id) {
  unlock();
  const g = game();
  if (!g) return;
  sfx.tap();
  switch (id) {
    case 'roll': send({ type: 'roll' }); break;
    case 'end': send({ type: 'endTurn' }); break;
    case 'trade': startTrade(); break;
    case 'dev': openDev(g); break;
    case 'discard': openDiscard(g); break;
    case 'steal': openSteal(g); break;
    case 'players': openPlayers(); break;
    case 'log': openLog(g); break;
    case 'over': sheet('sheet-over'); break;
    default: break;
  }
}

// ---------------------------------------------------------------- build sheet
// A cost is drawn as one card per unit, dimmed for whatever you cannot cover — you can
// see at a glance both what it costs and how close you are.
const COST_BITS = (cost, have = null) => costRow(cost, have);


// ---------------------------------------------------------------- dev cards
function openDev(g) {
  const p = g.players[playerId];

  // Buying sits above the hand rather than under "Build", because a development card is
  // not a building — and this is the sheet people open when they want one. It states the
  // price and what is left in the deck whether or not it can be pressed, so an
  // unaffordable card explains itself instead of just being greyed out.
  const can = R.whatCanIBuild(g, playerId);
  const empty = !g.deck.length;
  // A knight is the one card with no phase of its own — it can be played before the
  // roll — so nothing in the per-card test below would have stopped one being tapped on
  // somebody else's turn. The engine would have refused it a round trip later with "Not
  // your turn"; the sheet says so up front instead, and greys what cannot be pressed.
  const myTurn = R.isTurn(g, playerId);
  $('dev-buy').innerHTML = `
    <button class="dev-buy" id="btn-buy-dev"${can.dev ? '' : ' disabled'}>
      <span class="dev-buy-ico">🃏</span>
      <span class="dev-buy-txt">
        <span class="dev-buy-name">Buy a development card</span>
        <span class="build-cost">${COST_BITS(R.COSTS.dev, p.res)}</span>
      </span>
      <span class="dev-buy-left">${empty ? 'deck empty' : myTurn ? `${g.deck.length} left` : 'not your turn'}</span>
    </button>`;
  if (can.dev) {
    $('btn-buy-dev').addEventListener('click', () => {
      closeSheet();
      send({ type: 'buyDev' });
    });
  }

  const rows = [];
  for (const [k, info] of Object.entries(R.DEV_INFO)) {
    if (k === 'vp') continue;
    const ready = p.dev[k] || 0;
    const fresh = p.devNew[k] || 0;
    if (!ready && !fresh) continue;
    const blocked = !myTurn || g.turn.playedDev || !ready
      || (k !== 'knight' && g.phase !== 'build');
    rows.push(`<button class="dev-card" data-dev="${k}"${blocked ? ' disabled' : ''}>
      <span class="dev-n">${ready + fresh}</span>
      <span class="dev-txt">
        <span class="dev-name">${esc(info.name)}</span>
        <span class="dev-blurb">${esc(info.blurb)}</span>
        ${fresh ? `<span class="dev-lock">${fresh} bought this turn — playable next turn</span>` : ''}
        ${!myTurn && ready ? '<span class="dev-lock">Not your turn — playable when it is</span>' : ''}
        ${myTurn && g.turn.playedDev && ready ? '<span class="dev-lock">One card per turn, already used</span>' : ''}
      </span>
    </button>`);
  }
  const vps = (p.dev.vp || 0) + (p.devNew.vp || 0);
  if (vps) {
    rows.push(`<div class="dev-card" style="opacity:.85">
      <span class="dev-n">${vps}</span>
      <span class="dev-txt">
        <span class="dev-name">Victory Points</span>
        <span class="dev-blurb">${esc(p.vpCards.join(', '))} — worth ${vps} point${vps > 1 ? 's' : ''}, revealed when you win.</span>
      </span></div>`);
  }
  $('dev-list').innerHTML = rows.length ? rows.join('')
    : '<p class="hint">Nothing in hand yet.</p>';

  for (const b of document.querySelectorAll('[data-dev]')) {
    b.addEventListener('click', () => {
      const k = b.dataset.dev;
      closeSheet();
      if (k === 'knight') { send({ type: 'playDev', card: 'knight' }); return; }
      if (k === 'road') { send({ type: 'playDev', card: 'road' }); return; }
      if (k === 'plenty') { openPickRes('plenty'); return; }
      if (k === 'mono') { openPickRes('mono'); return; }
    });
  }
  sheet('sheet-dev');
}

// ---------------------------------------------------------------- resource pickers
// One reusable +/- grid, used for discarding, year of plenty and monopoly.
function resPicker(elId, counts, opts = {}) {
  const g = game();
  const p = g.players[playerId];
  $(elId).innerHTML = RESOURCES.map((r) => {
    const have = opts.showHave === false ? '' : `<span class="pick-have">have ${p.res[r] || 0}</span>`;
    const n = counts[r] || 0;
    return `<div class="pick-col">
      ${resCard(r, { size: 'sm', count: n || null, selected: !!n, dim: !n })}
      <div class="pick-pm">
        <button data-pm="-" data-r="${r}" aria-label="One fewer ${RES_NAME[r]}">−</button>
        <button data-pm="+" data-r="${r}" aria-label="One more ${RES_NAME[r]}">+</button>
      </div>
      ${have}</div>`;
  }).join('');
}

function openDiscard(g) {
  const owed = g.pending.discard[playerId] || 0;
  const chosen = {};
  const draw = () => {
    const total = Object.values(chosen).reduce((a, b) => a + b, 0);
    $('discard-sub').textContent = `Rolled a 7 — choose ${owed} card${owed > 1 ? 's' : ''} to lose. (${total}/${owed})`;
    resPicker('discard-picker', chosen);
    $('btn-discard').disabled = total !== owed;
    for (const b of document.querySelectorAll('#discard-picker [data-pm]')) {
      b.addEventListener('click', () => {
        const r = b.dataset.r;
        const p = g.players[playerId];
        if (b.dataset.pm === '+') {
          if ((chosen[r] || 0) >= (p.res[r] || 0)) return;
          if (Object.values(chosen).reduce((a, c) => a + c, 0) >= owed) return;
          chosen[r] = (chosen[r] || 0) + 1;
        } else {
          if (!chosen[r]) return;
          chosen[r] -= 1;
          if (!chosen[r]) delete chosen[r];
        }
        sfx.tap();
        draw();
      });
    }
  };
  draw();
  $('btn-discard').onclick = () => {
    closeSheet();
    send({ type: 'discard', res: chosen });
  };
  sheet('sheet-discard');
}

function openPickRes(kind) {
  const g = game();
  const title = kind === 'plenty' ? 'Year of Plenty' : 'Monopoly';
  const sub = kind === 'plenty'
    ? 'Take any two resources from the bank.'
    : 'Name a resource. Every other player hands you all of theirs.';
  $('pickres-title').textContent = title;
  $('pickres-sub').textContent = sub;

  if (kind === 'mono') {
    let chosen = null;
    const draw = () => {
      $('pickres-picker').innerHTML = RESOURCES.map((r) => `
        <div class="pick-col">
          <button class="pick-plain" data-pick="${r}" aria-label="${RES_NAME[r]}">
            ${resCard(r, { size: 'sm', selected: chosen === r, dim: chosen !== null && chosen !== r })}
          </button>
          <span class="pick-have">${RES_NAME[r]}</span>
        </div>`).join('');
      for (const b of document.querySelectorAll('#pickres-picker [data-pick]')) {
        b.addEventListener('click', () => { chosen = b.dataset.pick; sfx.tap(); draw(); });
      }
      $('btn-pickres').disabled = !chosen;
    };
    draw();
    $('btn-pickres').onclick = () => { closeSheet(); send({ type: 'playDev', card: 'mono', res: chosen }); };
  } else {
    const chosen = {};
    const draw = () => {
      const total = Object.values(chosen).reduce((a, b) => a + b, 0);
      resPicker('pickres-picker', chosen, { showHave: false });
      $('btn-pickres').disabled = total !== 2;
      for (const b of document.querySelectorAll('#pickres-picker [data-pm]')) {
        b.addEventListener('click', () => {
          const r = b.dataset.r;
          if (b.dataset.pm === '+') {
            if (Object.values(chosen).reduce((a, c) => a + c, 0) >= 2) return;
            if ((chosen[r] || 0) >= (g.bank[r] || 0)) return;
            chosen[r] = (chosen[r] || 0) + 1;
          } else {
            if (!chosen[r]) return;
            chosen[r] -= 1;
            if (!chosen[r]) delete chosen[r];
          }
          sfx.tap();
          draw();
        });
      }
    };
    draw();
    $('btn-pickres').onclick = () => { closeSheet(); send({ type: 'playDev', card: 'plenty', res: chosen }); };
  }
  sheet('sheet-pickres');
}

// ---------------------------------------------------------------- trading
//
// One picker, two destinations. You choose what to hand over and what you want back, and
// only then decide who with — which is the order people actually think in. The old two
// tabs made you commit to a counterparty first and then discover you could not afford it.
//
// Offers to other players stack up: set one out, build another, send that too. They are
// independent, and the same card may be promised in two of them — you want whoever bites
// first, not both — because the engine re-checks the hand at the moment a deal closes.

// ---------------------------------------------------------------- trading
// Trading happens in the tray, not in a sheet over it.
//
// It used to be a sheet, and the sheet covered the two things you need in order to trade
// at all: your own cards, and the turn clock. It duplicated the hand as a row of "have 3"
// labels — a worse copy of the cards sitting underneath it — and left you doing
// arithmetic against a deadline you could not see. Four people played a game with it and
// all four found it confusing, which is a clear enough verdict.
//
// So the board stays up, the timer stays up, and the cards you tap are your actual hand.
// You ask for what you need first, because that is the half a player already knows, and
// the payment works itself out at your own port rates.
const WANT_MAX = 4;

let trading = false;
let giveSel = {}, wantSel = {};
// Once you have picked your own payment the app stops picking one for you. Choosing
// cards by hand says plainly that the automatic answer was not the one you wanted, and
// having it overwritten on your next tap would be maddening.
let payTouched = false;
// Acceptances already announced, as `offerId:playerId`. An acceptance is not written to
// the game log — see the note in syncSheets — so nothing else would ever say it happened.
const notedAccepts = new Set();

const bundleTotal = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const kindsIn = (o) => Object.keys(o).filter((r) => o[r] > 0);
const bundleText = (o) => kindsIn(o)
  .map((r) => `${o[r]} ${RES_NAME[r].toLowerCase()}`).join(' + ') || 'nothing';

function startTrade() {
  trading = true;
  giveSel = {}; wantSel = {}; payTouched = false;
  render();
}

function stopTrade(quiet = false) {
  trading = false;
  giveSel = {}; wantSel = {}; payTouched = false;
  if (!quiet) render();
}

/** A different game entirely: forget the basket and every offer already announced. */
function resetTrade() {
  trading = false;
  giveSel = {}; wantSel = {}; payTouched = false;
  notedAccepts.clear();
  // The tray is only redrawn once there is a game to draw it for, and the rows would
  // otherwise still be showing the last one's offers while the lobby loads.
  for (const id of ['trade-want', 'trade-bar', 'trade-offers', 'trade-asks']) $(id).hidden = true;
  $('actions').hidden = false;
}

/**
 * The cheapest way to pay for what has been asked for, out of the hand, at this player's
 * own rates.
 *
 * Lowest rate first — owning a 2:1 port ought to be the reason it gets used — and among
 * equal rates the deepest pile, so a trade spends the wheat you are drowning in rather
 * than the last of your ore. Nothing being asked for is ever spent: the bank will not
 * take a card in exchange for itself.
 *
 * Null means the hand cannot cover the ask at any rate, which is the signal that this
 * one has to go to the table instead of the bank.
 */
function autoPay(g) {
  let left = bundleTotal(wantSel);
  const p = g.players[playerId];
  if (!left || !p) return {};
  const asking = new Set(kindsIn(wantSel));
  const piles = RESOURCES
    .filter((r) => !asking.has(r) && (p.res[r] || 0) > 0)
    .map((r) => ({ r, have: p.res[r], rate: R.tradeRate(g, board, playerId, r) }))
    .sort((a, b) => a.rate - b.rate || b.have - a.have);

  const pay = {};
  for (const pile of piles) {
    while (left > 0 && pile.have - (pay[pile.r] || 0) >= pile.rate) {
      pay[pile.r] = (pay[pile.r] || 0) + pile.rate;
      left -= 1;
    }
    if (!left) break;
  }
  return left ? null : pay;
}

/** Work the payment out again, unless the player has taken it over. */
function refillPay(g) {
  if (payTouched) return;
  giveSel = autoPay(g) || {};
}

function bankPlan(g) {
  if (!g.players[playerId]) return { ok: false, note: 'You are watching this game' };
  const gk = kindsIn(giveSel), wk = kindsIn(wantSel);
  if (!gk.length || !wk.length) return { ok: false, note: 'Pick both sides' };
  for (const r of wk) {
    if (giveSel[r]) return { ok: false, note: 'The bank will not swap a card for itself' };
  }

  const held = g.players[playerId].res;
  let credits = 0;
  const odd = [];
  for (const r of gk) {
    const rate = R.tradeRate(g, board, playerId, r);
    if ((held[r] || 0) < giveSel[r]) return { ok: false, note: 'More than you hold' };
    if (giveSel[r] % rate !== 0) {
      odd.push(`The bank takes ${RES_NAME[r].toLowerCase()} ${rate} at a time`);
    }
    credits += Math.floor(giveSel[r] / rate);
  }
  if (odd.length) return { ok: false, note: odd[0] };

  const asked = bundleTotal(wantSel);
  if (!credits) return { ok: false, note: 'Not enough to trade' };
  if (credits !== asked) {
    return { ok: false, note: `That buys ${credits} card${credits > 1 ? 's' : ''} — you asked for ${asked}` };
  }
  for (const r of wk) {
    if ((g.bank[r] || 0) < wantSel[r]) {
      return { ok: false, note: `The bank is out of ${RES_NAME[r].toLowerCase()}` };
    }
  }
  return { ok: true, note: `${bundleText(giveSel)} → ${bundleText(wantSel)}` };
}

/** Can this selection be put to the table? */
function offerPlan(g) {
  if (!g.players[playerId]) return { ok: false, note: 'You are watching this game' };
  if (!bundleTotal(giveSel) || !bundleTotal(wantSel)) return { ok: false, note: 'Pick both sides' };
  const held = g.players[playerId].res;
  for (const r of kindsIn(giveSel)) {
    if ((held[r] || 0) < giveSel[r]) return { ok: false, note: 'More than you hold' };
  }
  const mine = (g.trades || []).filter((t) => t.from === playerId).length;
  if (mine >= R.MAX_OFFERS) return { ok: false, note: `${R.MAX_OFFERS} offers is the limit` };
  return { ok: true, note: 'Offer to the table' };
}

/**
 * One line saying what the basket does, in the order a player thinks about it.
 *
 * The old sheet answered with diagnostics — "Buys 3 — asked for 2", "Pick both sides" —
 * which say what is wrong without saying what to do about it. Every line here either
 * states the deal or gives the next instruction.
 */
function tradeReadout(g, bank, offer) {
  const wantN = bundleTotal(wantSel);
  const giveN = bundleTotal(giveSel);
  if (!wantN) {
    return giveN ? 'Now tap what you want for them.'
      : 'Tap what you need. The payment fills itself in.';
  }
  if (bank.ok) return `Bank: ${bank.note}`;
  if (!giveN) return 'Your hand will not cover that at the bank — tap cards to offer a swap.';
  if (offer.ok) return `Offer: ${bundleText(giveSel)} → ${bundleText(wantSel)}`;
  return bank.note;
}

/** The "what do you need" row: five cards, tap for one more. */
function renderWantRow(g) {
  $('trade-want').innerHTML = '<span class="trade-lead">I need</span>' + RESOURCES.map((r) => {
    const n = wantSel[r] || 0;
    return resCard(r, {
      size: 'sm', count: n || null, selected: !!n, dim: !n,
      dataset: ` data-want="${r}"`,
      label: `${g.bank[r] || 0} left`,
    });
  }).join('');
}

/**
 * The trade bar: what the basket does, and the ways to close it.
 *
 * Bank and table are both offered when both are genuinely open, rather than as two
 * permanently half-dead buttons with a note each. Which one is highlighted depends on
 * which one can actually happen.
 */
function renderTradeBar(g) {
  const bank = bankPlan(g);
  const offer = offerPlan(g);
  // Exactly one button is ever the loud one, and it is whichever can actually happen —
  // the bank when the basket balances, the table when it does not. Two equally bright
  // buttons is the shape the old sheet had, and it made the player choose between them
  // before finding out which one their cards even qualified for.
  const loud = bank.ok ? 'bank' : offer.ok ? 'table' : null;
  const btn = (act, label, off) =>
    `<button class="btn ${act === loud ? 'btn-key' : 'btn-ghost'}" data-trade="${act}"`
    + `${off ? ' disabled' : ''}>${esc(label)}</button>`;

  $('trade-bar').innerHTML =
    `<div class="trade-note">${esc(tradeReadout(g, bank, offer))}</div>
     <div class="trade-go">
       ${btn('cancel', 'Cancel', false)}
       ${btn('table', 'Ask table', !offer.ok)}
       ${btn('bank', 'Bank', !bank.ok)}
     </div>`;
}

/**
 * Your own offers and what people have said about them, in the tray.
 *
 * Outside trade mode as well as in it. An acceptance is worth seeing without going
 * looking for it, and it used to live behind a sheet you had to reopen.
 */
function renderMyOffers(g) {
  const box = $('trade-offers');
  const mine = (g.trades || []).filter((t) => t.from === playerId);
  if (!mine.length) { box.innerHTML = ''; box.hidden = true; return; }
  box.hidden = false;

  box.innerHTML = mine.map((t) => {
    const rows = g.seats.filter((s) => s !== playerId).map((pid) => {
      const r = t.replies[pid];
      const tag = r === 'yes' ? 'Accepts — tap to trade' : r === 'no' ? 'Declined' : 'Thinking…';
      return `<button class="reply-row${r === 'yes' ? ' yes' : r === 'no' ? ' no' : ''}"
        ${r === 'yes' ? ` data-close-deal="${t.id}:${esc(pid)}"` : ' disabled'}>
        <span class="reply-name">${esc(nameFor(pid))}</span>
        <span class="reply-tag">${tag}</span>
      </button>`;
    }).join('');
    return `<div class="my-offer">
      <div class="my-offer-top">
        <span class="offer-cards">${cardRow(t.give, { size: 'xs' })}</span>
        <span class="swap-arrow" aria-hidden="true">⇄</span>
        <span class="offer-cards">${cardRow(t.want, { size: 'xs' })}</span>
        <button class="offer-drop" data-drop-offer="${t.id}" aria-label="Withdraw this offer">✕</button>
      </div>
      <div class="offer-replies">${rows}</div>
    </div>`;
  }).join('');

  // Somebody saying yes is news, and a reply is not written to the game log, so this is
  // the only place it can be announced.
  for (const t of mine) {
    for (const [pid, r] of Object.entries(t.replies)) {
      const key = `${t.id}:${pid}`;
      if (r !== 'yes' || notedAccepts.has(key)) continue;
      notedAccepts.add(key);
      toast(`${nameFor(pid)} accepts — tap to close the deal.`);
      sfx.trade();
    }
  }
}

/** The tray, in whichever mode it is in. */
function renderTrade(g) {
  const canTrade = R.isTurn(g, playerId) && g.phase === 'build' && !!g.players[playerId];
  // The clock can run out under an open trade. Leaving the pickers up over somebody
  // else's turn would be offering a move that no longer exists.
  if (trading && !canTrade) stopTrade(true);
  const on = trading && canTrade;

  $('trade-want').hidden = !on;
  $('trade-bar').hidden = !on;
  $('actions').hidden = on;

  renderAsks(g);
  renderMyOffers(g);
  if (!on) return;
  refillPay(g);
  renderWantRow(g);
  renderTradeBar(g);
}

// Delegated once, as the action bar is: every row here is rebuilt with innerHTML on each
// render, so a listener bound to the element itself would die with it.
$('trade-want').addEventListener('click', (e) => {
  const el = e.target.closest('[data-want]');
  const g = game();
  if (!el || !g) return;
  // Straight up, and round to nothing at the top. Every tap can undo itself by carrying
  // on tapping, which is the whole of the interaction — there are no plus and minus
  // buttons to find any more.
  const r = el.dataset.want;
  wantSel[r] = ((wantSel[r] || 0) + 1) % (WANT_MAX + 1);
  if (!wantSel[r]) delete wantSel[r];
  sfx.tap();
  render();
});

$('trade-bar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-trade]');
  const g = game();
  if (!b || b.disabled || !g) return;
  const what = b.dataset.trade;
  if (what === 'cancel') { sfx.tap(); stopTrade(); return; }
  if (what === 'bank') {
    if (!bankPlan(g).ok) return;
    // One move for the whole basket. Sending it as several trades in a row meant a
    // failure partway through left the player halfway into something they had asked for
    // as one thing.
    send({ type: 'bankTrade', give: giveSel, want: wantSel });
    giveSel = {}; wantSel = {}; payTouched = false;
    render();
    return;
  }
  if (!offerPlan(g).ok) return;
  send({ type: 'offerTrade', give: giveSel, want: wantSel });
  giveSel = {}; wantSel = {}; payTouched = false;
  render();
});

$('trade-offers').addEventListener('click', (e) => {
  const deal = e.target.closest('[data-close-deal]');
  if (deal) {
    const [id, who] = deal.dataset.closeDeal.split(':');
    send({ type: 'acceptTrade', id: Number(id), with: who });
    return;
  }
  const drop = e.target.closest('[data-drop-offer]');
  if (drop) { sfx.tap(); send({ type: 'cancelTrade', id: Number(drop.dataset.dropOffer) }); }
});

/**
 * Offers waiting on an answer from you, in the tray.
 *
 * This was a sheet, and it had exactly the fault the trade sheet had: it covered your
 * hand and the turn clock. Being asked "will you take two wheat for an ore" is precisely
 * the moment you need to see what you are holding and how long you have got — arguably
 * more than the person doing the asking does, because you are answering on their clock.
 *
 * Read from your side of the table: what leaves your hand first, what arrives second.
 */
function renderAsks(g) {
  const box = $('trade-asks');
  const me = g.players[playerId];
  const waiting = me
    ? (g.trades || []).filter((t) => t.from !== playerId && !t.replies[playerId])
    : [];
  if (!waiting.length) { box.innerHTML = ''; box.hidden = true; return; }
  box.hidden = false;

  box.innerHTML = waiting.map((t) => {
    // No point offering a button that the engine will refuse: replyTrade checks the hand
    // before it will record a yes.
    const able = Object.entries(t.want).every(([r, n]) => (me.res[r] || 0) >= n);
    return `<div class="ask" style="--c:${esc(colorFor(t.from))}">
      <div class="ask-top">
        <span class="ask-who">${esc(nameFor(t.from))}</span>
        <span class="ask-side">
          <span class="ask-tag">you give</span>
          <span class="offer-cards">${cardRow(t.want, { size: 'xs' })}</span>
        </span>
        <span class="swap-arrow" aria-hidden="true">⇄</span>
        <span class="ask-side">
          <span class="ask-tag">you get</span>
          <span class="offer-cards">${cardRow(t.give, { size: 'xs' })}</span>
        </span>
      </div>
      <div class="ask-go">
        ${able ? '' : '<span class="ask-cant">You have not got that</span>'}
        <button class="btn btn-ghost" data-say="${t.id}:no">No thanks</button>
        <button class="btn btn-key" data-say="${t.id}:yes"${able ? '' : ' disabled'}>Accept</button>
      </div>
    </div>`;
  }).join('');
}

$('trade-asks').addEventListener('click', (e) => {
  const b = e.target.closest('[data-say]');
  if (!b || b.disabled) return;
  const [id, yes] = b.dataset.say.split(':');
  sfx.tap();
  send({ type: 'replyTrade', id: Number(id), yes: yes === 'yes' });
});

// ---------------------------------------------------------------- steal / players / log
function openSteal(g) {
  const raid = g.phase === 'take';
  $('steal-title').textContent = raid ? 'Take a card' : 'Rob someone';
  $('steal-sub').textContent = raid
    ? 'You rolled a 7. Take one card at random from any player.'
    : 'Take one card at random from a player on that tile.';
  $('steal-list').innerHTML = g.pending.stealFrom.map((pid) => `
    <button class="steal-btn" style="--c:${esc(colorFor(pid))}" data-steal="${esc(pid)}">
      <span class="steal-name">${esc(nameFor(pid))}</span>
      <span class="steal-n">${R.handSize(g.players[pid])} cards</span>
    </button>`).join('');
  for (const b of document.querySelectorAll('[data-steal]')) {
    b.addEventListener('click', () => {
      closeSheet();
      const type = game()?.phase === 'take' ? 'takeCard' : 'steal';
      send({ type, from: b.dataset.steal });
    });
  }
  sheet('sheet-steal');
}

function openPlayers() {
  const g = game();
  if (!g) return;
  $('player-cards').innerHTML = g.seats.map((pid) => {
    const p = g.players[pid];
    const ports = R.portsOwned(g, board, pid);
    const stats = [
      `<span class="pstat">${R.handSize(p)} cards</span>`,
      `<span class="pstat">${R.devCount(p)} dev</span>`,
      `<span class="pstat">⚔️ ${p.knights}</span>`,
      `<span class="pstat">🛣️ ${p.roadLen}</span>`,
      // What is left in the box. This used to live in the Build sheet, where it was only
      // ever about you — but an opponent down to their last settlement is real
      // information, and this is the card that already answers "how is everyone doing".
      `<span class="pstat">left ${p.left.road}🛣️ ${p.left.settlement}🏠 ${p.left.city}🏛️</span>`,
    ];
    if (g.award.road === pid) stats.push('<span class="pstat award">Longest Road</span>');
    if (g.award.army === pid) stats.push('<span class="pstat award">Largest Army</span>');
    if (ports.length) stats.push(`<span class="pstat">${ports.map((k) => k === 'any' ? '3:1' : `2:1 ${k}`).join(' · ')}</span>`);
    return `<div class="pcard" style="--c:${esc(colorFor(pid))}">
      <div class="pcard-top">
        <span class="pcard-name">${esc(nameFor(pid))}${pid === playerId ? ' (you)' : ''}</span>
        <span class="pcard-vp">${R.publicVP(g, pid)}</span>
      </div>
      <div class="pcard-stats">${stats.join('')}</div>
    </div>`;
  }).join('');
  sheet('sheet-players');
}

function logLine(e) {
  const who = (pid) => pid === playerId ? 'You' : esc(nameFor(pid));
  const c = e.p ? colorFor(e.p) : 'transparent';
  const bits = (o) => Object.entries(o).map(([r, n]) => `${n}${RES_ICON[r]}`).join(' ');
  let text = '';
  switch (e.t) {
    case 'turn': text = `<b>${who(e.p)}</b> — turn ${e.n}`; break;
    case 'roll': text = `<b>${who(e.p)}</b> rolled <b>${e.roll}</b> (${e.dice[0]}+${e.dice[1]})`; break;
    case 'produce': {
      const parts = Object.entries(e.gains).map(([pid, gain]) => `${who(pid)} +${bits(gain)}`);
      text = parts.join(', ');
      break;
    }
    case 'nothing': text = `<span class="r">Nobody produced on ${e.roll}</span>`; break;
    case 'shortfall': text = `<span class="r">The bank ran short of ${e.res}${e.partial ? ' — partial payout' : ' — nobody paid'}</span>`; break;
    case 'build': text = `<b>${who(e.p)}</b> built a ${e.what}${e.free ? ' (free)' : ''}`; break;
    case 'buyDev': text = `<b>${who(e.p)}</b> bought a development card`; break;
    case 'playDev': text = `<b>${who(e.p)}</b> played ${esc(R.DEV_INFO[e.card]?.name || e.card)}`; break;
    case 'noloot': text = `<span class="r">Nobody had a card for <b>${who(e.p)}</b> to take</span>`; break;
    case 'robber': text = `<b>${who(e.p)}</b> moved the robber`; break;
    case 'steal': text = `<b>${who(e.p)}</b> robbed <b>${who(e.from)}</b>`; break;
    case 'discard': text = `<b>${who(e.p)}</b> discarded ${e.count}`; break;
    case 'mono': text = `<b>${who(e.p)}</b> monopolised ${e.res} — ${e.count} cards`; break;
    case 'plenty': text = `<b>${who(e.p)}</b> took ${bits(e.res)} from the bank`; break;
    case 'bankTrade': text = `<b>${who(e.p)}</b> traded ${bits(e.give)} to the bank for ${bits(e.want)}`; break;
    case 'offer': text = `<b>${who(e.p)}</b> offered ${bits(e.give)} for ${bits(e.want)}`; break;
    case 'trade': text = `<b>${who(e.p)}</b> traded with <b>${who(e.with)}</b>`; break;
    case 'longest': text = `<span class="g"><b>${who(e.p)}</b> takes Longest Road (${e.len})</span>`; break;
    case 'army': text = `<span class="g"><b>${who(e.p)}</b> takes Largest Army (${e.size})</span>`; break;
    case 'left': text = `<b>${who(e.p)}</b> left the game`; break;
    case 'abandoned': text = `<b>${who(e.p)}</b> left — game over`; break;
    case 'win': text = `<span class="g">🏆 <b>${who(e.p)}</b> wins with ${e.vp} points</span>`; break;
    default: text = e.t;
  }
  return `<div class="log-row" style="--c:${esc(c)}">${text}</div>`;
}

function openLog(g) {
  $('log-list').innerHTML = (g.log || []).map(logLine).join('') || '<p class="hint">Nothing yet.</p>';
  $('log-dot').classList.remove('on');
  seenLogAt = Date.now();
  sheet('sheet-log');
}

// ---------------------------------------------------------------- mandatory sheets
// Some phases stop the game until you act. Those sheets reopen if dismissed; optional
// ones (a trade offer) stay closed once you've waved them away.
function syncSheets(g) {
  // Replies have to be part of this. Answering an offer does not write to the game log,
  // so it does not move g.seq, so the key did not change, so the offer sheet was never
  // redrawn — the player who made the offer sat looking at "Thinking…" while the
  // acceptance was already in. It was never a failed trade; it was a screen that never
  // caught up.
  const trades = g.trades || [];
  const shape = trades
    .map((t) => t.id + Object.keys(t.replies).sort().map((k) => k + t.replies[k]).join(''))
    .join('|');
  const key = `${g.phase}:${g.turn.num}:${g.seq}:${shape}`;
  const changed = key !== lastPhaseKey;
  lastPhaseKey = key;

  if (g.phase === 'discard' && g.pending.discard[playerId]) {
    if (openSheet !== 'sheet-discard') openDiscard(g);
    return;
  }
  if ((g.phase === 'steal' || g.phase === 'take') && R.isTurn(g, playerId)) {
    if (openSheet !== 'sheet-steal') openSteal(g);
    return;
  }
  if (openSheet === 'sheet-discard' || openSheet === 'sheet-steal') closeSheet();

  // Trades need no sheet at all any more. Both sides of one live in the tray, under the
  // board, where the clock and your own cards stay visible while you decide.

  // Now that Cards can be opened on somebody else's turn, it can still be open when
  // your own arrives — and it would have sat there insisting it was not your turn, with
  // every card greyed, until it was closed and opened again.
  if (openSheet === 'sheet-dev' && changed) openDev(g);

  if (g.phase === 'over' && openSheet !== 'sheet-over') { renderOver(g); sheet('sheet-over'); }
}

// ---------------------------------------------------------------- game over
function renderOver(g) {
  const win = g.winner;
  $('over-title').textContent = win === playerId ? 'You win!' : `${nameFor(win)} wins`;
  $('over-hero').innerHTML = `
    <div class="over-name">${esc(nameFor(win))}</div>
    <div class="over-sub">${R.totalVP(g, win)} victory points</div>`;

  const rows = g.seats.slice().sort((a, b) => R.totalVP(g, b) - R.totalVP(g, a));
  $('final-table').innerHTML = rows.map((pid, i) => {
    const p = g.players[pid];
    const hidden = (p.dev.vp || 0) + (p.devNew.vp || 0);
    const parts = [`${R.publicVP(g, pid)} on the board`];
    if (hidden) parts.push(`${hidden} hidden (${esc(p.vpCards.join(', '))})`);
    return `<div class="final-row${pid === win ? ' win' : ''}" style="--c:${esc(colorFor(pid))}">
      <span class="final-pos">${i + 1}</span>
      <span class="final-name">${esc(nameFor(pid))}
        <span class="final-break">${parts.join(' · ')}</span></span>
      <span class="final-vp">${R.totalVP(g, pid)}</span>
    </div>`;
  }).join('');
}

$('btn-again').addEventListener('click', async () => {
  if (solo) {
    closeSheet();
    startSolo(room.level, room.bots, room.settings.targetVP, room.settings.layout, room.settings.useRobber);
    return;
  }
  if (!isHost()) return toast('Only the host can start a new game.');
  closeSheet();
  try {
    await updateDoc(roomRef, { state: 'lobby', game: null, order: [] });
    lastSeq = 0;
    announcedUp = null;
    resetGuess(); resetTrade();
  } catch { toast('Could not reset the room.'); }
});
$('btn-home').addEventListener('click', () => leaveRoom(true));

// ---------------------------------------------------------------- menus
$('game-menu').addEventListener('click', () => { sfx.tap(); sheet('sheet-menu'); });
$('game-log-btn').addEventListener('click', () => { const g = game(); if (g) openLog(g); });
$('menu-players').addEventListener('click', openPlayers);
$('menu-how').addEventListener('click', openHow);
$('menu-settings').addEventListener('click', openSettings);
$('menu-leave').addEventListener('click', () => { closeSheet(); leaveRoom(true); });
$('btn-how').addEventListener('click', openHow);
$('btn-settings').addEventListener('click', openSettings);

function openHow() {
  const g = game();
  $('how-target').textContent = String(g?.target || room?.settings?.targetVP || 10);
  $('how-discard').textContent = String(g?.discardLimit || room?.settings?.discardLimit || 7);
  $('how-costs').innerHTML = [
    ['🛣️', 'Road', R.COSTS.road],
    ['🏠', 'Settlement', R.COSTS.settlement],
    ['🏛️', 'City', R.COSTS.city],
    ['🃏', 'Development card', R.COSTS.dev],
  ].map(([ico, name, cost]) => `<div class="cost-row">
      <span>${ico}</span><span class="cost-name">${name}</span>
      <span class="cost-bits">${COST_BITS(cost)}</span></div>`).join('');
  sheet('sheet-how');
}

function openSettings() {
  syncToggles();
  sheet('sheet-settings');
}

function togState(key) {
  if (key === 'sound') return soundEnabled();
  if (key === 'haptics') return localStorage.getItem('hexcolony_haptics') !== 'off';
  return localStorage.getItem('hexcolony_awake') === 'on';
}
function syncToggles() {
  for (const t of document.querySelectorAll('[data-tog]')) {
    t.classList.toggle('on', togState(t.dataset.tog));
  }
}
for (const t of document.querySelectorAll('[data-tog]')) {
  t.addEventListener('click', () => {
    const key = t.dataset.tog;
    const now = !togState(key);
    if (key === 'sound') { setSound(now); if (now) { unlock(); sfx.tap(); } }
    else if (key === 'haptics') { localStorage.setItem('hexcolony_haptics', now ? 'on' : 'off'); if (now) buzz(40); }
    else { localStorage.setItem('hexcolony_awake', now ? 'on' : 'off'); keepAwake(now); }
    syncToggles();
  });
}

// ---------------------------------------------------------------- wake lock
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not supported, or denied — harmless */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (localStorage.getItem('hexcolony_awake') === 'on') keepAwake(true);
    // Coming back from a locked screen is exactly when the stream is likely wedged.
    if (roomRef) { resubscribe(true); pullFromServer(true); }
  }
});

// ---------------------------------------------------------------- app menu
function closeKebab() {
  const menu = $('kebab-menu');
  if (menu) { menu.hidden = true; $('btn-kebab').setAttribute('aria-expanded', 'false'); }
}

$('btn-kebab').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('kebab-menu');
  const open = menu.hidden;
  menu.hidden = !open;
  $('btn-kebab').setAttribute('aria-expanded', String(open));
  unlock(); sfx.tap();
});
// Any tap elsewhere, or Escape, puts it away.
document.addEventListener('click', (e) => {
  if (!e.target.closest('#kebab-wrap')) closeKebab();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeKebab(); });

/**
 * Throw away everything cached and start clean.
 *
 * A plain reload is not enough: the service worker would serve the same build back. The
 * caches and the registration both have to go first, which is the whole point of a
 * Refresh the player can reach.
 */
/**
 * Pull fresh bytes for every file this page is built from, into the browser's own cache.
 *
 * This is the step the Refresh button was missing, and the reason it looked dead.
 * Unregistering the worker removes the one thing that was revalidating anything, so the
 * reload afterwards is served entirely by the HTTP cache — and GitHub Pages sends these
 * files with max-age=600. index.html came back fresh because of the ?fresh= marker, and
 * everything it pulls in came back ten minutes old, APP_VERSION included. The app then
 * compared the real version against a stale constant and put the banner right back up.
 *
 * cache:'reload' skips the cache on the way out and replaces what is stored on the way
 * back, so the reload that follows reads new code.
 *
 * The list is not written down anywhere: the page reports what it actually loaded, so
 * this cannot drift out of step with the imports the way a hand-kept list would.
 */
async function refetchEverything() {
  const here = location.origin + location.pathname.replace(/[^/]*$/, '');
  const urls = new Set(['index.html', 'sw.js', 'version.js', 'manifest.webmanifest']
    .map((f) => here + f));
  for (const entry of performance.getEntriesByType('resource')) {
    if (entry.name.startsWith(here) && /\.(js|css|webmanifest)(\?|$)/.test(entry.name)) {
      urls.add(entry.name.split('?')[0]);
    }
  }
  // Never hang on a bad connection — a stale reload beats a button that never returns.
  await Promise.race([
    Promise.all([...urls].map((u) => fetch(u, { cache: 'reload' }).catch(() => {}))),
    new Promise((r) => setTimeout(r, 6000)),
  ]);
}

let refreshing = false;
async function fullRefresh() {
  // Say so immediately. Clearing caches and reloading takes a moment, and with no
  // acknowledgement the button reads as dead — which is exactly how this has felt.
  if (refreshing) return;
  refreshing = true;
  const banner = $('update-banner');
  if (banner) banner.querySelector('span').textContent = 'Updating…';
  toast('Updating…');

  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    await refetchEverything();
  } catch { /* best effort — reload anyway */ }

  // Emptying the service worker's caches is not enough: the browser's own HTTP cache
  // can still answer a plain reload, and GitHub Pages serves these files with a ten
  // minute max-age. That brought back the very build we were trying to escape, the
  // version check fired again, and the banner reappeared — which looks exactly like
  // the button doing nothing. A URL it has never seen cannot be answered from cache.
  // Note what we were trying to reach. If the next load is still on the old build, the
  // refresh did not take and the app should say so rather than offer the same button.
  try {
    const res = await fetch(`version.js?nocache=${Date.now()}`, { cache: 'no-store' });
    const m = (await res.text()).match(/APP_VERSION\s*=\s*'([^']+)'/);
    if (m) sessionStorage.setItem('hexcolony_tried', m[1]);
  } catch { /* offline — nothing to record */ }

  const url = new URL(location.href);
  url.searchParams.set('fresh', Date.now().toString(36));
  location.replace(url.toString());

  // An installed PWA can ignore replace() in some states. If we are still here a moment
  // later, go the other way rather than leaving the player looking at a dead button.
  setTimeout(() => { location.href = url.toString(); }, 1200);
  setTimeout(() => { location.reload(); }, 2600);
}

/** Hand the app to the phone's own share sheet. */
async function shareApp() {
  const url = location.origin + location.pathname;
  const inRoom = !!roomCode && !solo;
  const text = inRoom
    ? `Join my HexColony game — room code ${roomCode}`
    : 'Play HexColony with me — settle the island.';
  try {
    if (navigator.share) { await navigator.share({ title: 'HexColony', text, url }); return; }
    await navigator.clipboard.writeText(`${text} ${url}`);
    toast('Link copied');
  } catch { /* the player dismissed the share sheet — nothing to report */ }
}

function openAbout() {
  $('about-version').textContent = `Version ${APP_VERSION}`;
  sheet('sheet-about');
}

$('kebab-refresh').addEventListener('click', () => { closeKebab(); fullRefresh(); });
$('kebab-share').addEventListener('click', () => { closeKebab(); shareApp(); });
$('kebab-about').addEventListener('click', () => { closeKebab(); openAbout(); });
$('menu-share').addEventListener('click', () => { closeSheet(); shareApp(); });
$('menu-about').addEventListener('click', () => { closeSheet(); openAbout(); });
// The whole bar refreshes. A 60px button is a poor target on a phone, and the useful
// thing to do with this banner is always "yes, update".
$('update-banner').addEventListener('click', (e) => {
  if (e.target.closest('.banner-x')) return;   // the dismiss cross still dismisses
  fullRefresh();
});

// ---------------------------------------------------------------- update check
/**
 * Is the running build the one that is deployed?
 *
 * version.js is fetched with no-store so the answer comes from the server rather than
 * from the cache we are trying to check. An installed PWA is resumed rather than
 * reloaded, so this also runs whenever the app comes back to the foreground — otherwise
 * a phone can sit on a stale build for days without ever asking.
 */
let refreshStuck = false;

/** The refresh ran and changed nothing. Only the player can clear this one. */
function announceStuck(want) {
  const banner = $('update-banner');
  banner.querySelector('span').textContent = `Still on v${APP_VERSION}`;
  refreshStuck = true;
  const btn = $('btn-refresh');
  if (btn) btn.textContent = 'Why?';
  $('stuck-have').textContent = APP_VERSION;
  $('stuck-want').textContent = want;
  banner.classList.add('show');
  console.warn('HexColony: refresh did not take —', APP_VERSION, 'wanted', want);
}

function announceUpdate(why) {
  const banner = $('update-banner');
  if (banner.classList.contains('show')) return;
  console.info('HexColony: update available via', why);
  banner.classList.add('show');
  updateInstallBanner();          // stand the install offer down while this is up
  buzz([40, 60, 40]);
}

async function checkForUpdate() {
  try {
    const res = await fetch(`version.js?nocache=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const m = (await res.text()).match(/APP_VERSION\s*=\s*'([^']+)'/);
    if (m && m[1] === APP_VERSION) { sessionStorage.removeItem('hexcolony_tried'); return; }
    if (!m) return;
    // A refresh that lands back on the same build means something below the app is
    // holding the old files. Say that, instead of offering the same button again.
    if (sessionStorage.getItem('hexcolony_tried') === m[1]) { announceStuck(m[1]); return; }
    announceUpdate('version.js');
  } catch { /* offline — nothing to compare against */ }
}
checkForUpdate();

/**
 * The instant route: one document holding whatever the deploy last published, watched
 * by every device from the moment the app opens.
 *
 * Polling can only ever be as quick as its interval, and an installed app that is
 * resumed rather than reloaded may not poll at all. A listener costs one document and
 * fires the moment a build lands, whether the phone is sitting on the home screen or
 * halfway through a game.
 *
 * The app never writes here — only the deploy does — so a device running an old build
 * cannot announce itself as the newest.
 */
function watchPublishedVersion() {
  if (!NET_READY) return;
  try {
    onSnapshot(doc(db, 'meta', 'version'), (snap) => {
      const v = snap.exists() ? snap.data().version : null;
      if (v && v !== APP_VERSION) announceUpdate('firestore');
    }, () => { /* unreadable — the worker and the poll still cover it */ });
  } catch { /* offline */ }
}
watchPublishedVersion();

let lastUpdateCheck = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - lastUpdateCheck < 600000) return;
  lastUpdateCheck = Date.now();
  checkForUpdate();
});

// ---------------------------------------------------------------- PWA
$('ver-home').textContent = `v${APP_VERSION}`;
$('ver-about').textContent = `HexColony v${APP_VERSION}`;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register(`sw.js?v=${APP_VERSION}`);

      // A worker reaching "installed" while another is already in charge means a new
      // build has arrived and is waiting for this page to go away.
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            announceUpdate('service worker');
          }
        });
      });

      // Ask, rather than wait to be told. This is a conditional request for one small
      // file, so a minute is cheap and keeps an open phone close to current.
      const poke = () => reg.update().catch(() => {});
      setInterval(poke, 60000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') poke();
      });
    } catch { /* no worker — the other two routes still apply */ }
  });

  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'NEW_VERSION' && e.data.version !== APP_VERSION) {
      announceUpdate('worker message');
    }
  });
}

$('btn-refresh').addEventListener('click', () => {
  if (refreshStuck) { sheet('sheet-stuck'); return; }
  fullRefresh();
});

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  // Chrome will show its own bar unless we take the event; we show ours instead so it
  // appears where the rest of the app's messages do.
  e.preventDefault();
  installPrompt = e;
  updateInstallBanner();
});

/** Already installed — running from the home screen rather than in a browser tab. */
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches
  || window.navigator.standalone === true;

// Safari never fires beforeinstallprompt, on any device. An iPhone can still install
// the app, but only through the Share menu, so it gets told how rather than nothing.
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);   // iPadOS

const installDismissed = () => localStorage.getItem('hexcolony_install_off') === '1';

function updateInstallBanner() {
  const onHome = $('screen-home').classList.contains('is-active');
  // One bar at a time, and an available update outranks an install offer — they share
  // the same corner of the screen and would otherwise cover each other.
  const updating = $('update-banner').classList.contains('show');
  const canOffer = !isStandalone() && !installDismissed() && (!!installPrompt || isIOS());
  if (canOffer && isIOS() && !installPrompt) {
    $('install-text').textContent = 'Add HexColony to your Home Screen';
    $('btn-install').textContent = 'How';
  }
  $('install-banner').classList.toggle('show', canOffer && onHome && !updating);
}

$('btn-install').addEventListener('click', async () => {
  if (installPrompt) {
    installPrompt.prompt();
    installPrompt = null;
    $('install-banner').classList.remove('show');
    return;
  }
  sheet('sheet-ios-install');
});

// "Not now" has to mean it. Without remembering, the bar comes back on every visit.
$('install-dismiss').addEventListener('click', () => {
  localStorage.setItem('hexcolony_install_off', '1');
  $('install-banner').classList.remove('show');
});

// ---------------------------------------------------------------- test hook
// Exposed on purpose. A game of HexColony takes four people and half an hour, which is a
// terrible way to find out that Longest Road recounts wrong. This lets a full game be
// driven from the console against the real Firestore document — the same reason Tetrix
// exposes its frame stepper. It posts moves through `send`, so everything still goes
// through the engine and the transaction; there is no privileged path here.
window.HEXCOLONY = {
  get room() { return room; },
  get game() { return game(); },
  get me() { return playerId; },
  get board() { return board; },
  rules: R,
  view,
  send,
  // The board topology, so a console driver can reason about what a corner touches
  // without re-importing the module.
  topo: { VERTS, EDGES, HEXES },
  checkForUpdate,
  legalSettlements: (setup = false) => R.legalSettlements(game(), playerId, setup),
  legalRoads: (from = null) => R.legalRoads(game(), playerId, from),
  tap: (kind, id) => view.onPick({ kind, id }),
};

// ---------------------------------------------------------------- boot
(async function boot() {
  // Drop the cache-busting marker fullRefresh added, so it is not carried into shares
  // or bookmarks.
  if (new URLSearchParams(location.search).has('fresh')) {
    const url = new URL(location.href);
    url.searchParams.delete('fresh');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }

  showScreen('screen-home');
  paintLookButton();
  refreshResume();
  if (localStorage.getItem('hexcolony_awake') === 'on') keepAwake(true);

  if (!NET_READY) {
    // No Firebase: solo still plays, so say so rather than letting the buttons fail.
    $('btn-create').disabled = true;
    $('btn-join').disabled = true;
    $('code-input').disabled = true;
    $('code-input').placeholder = 'OFFLINE';
  }

  if (IN_DISCORD) {
    // Swap the code-based lobby for the voice channel one, then finish the handshake
    // that stops Discord showing its loading spinner.
    $('online-panel').hidden = true;
    $('discord-panel').hidden = false;
    const ctx = await initDiscord();
    if (ctx?.channelId) $('discord-sub').textContent = 'Same game for the whole channel';
    return;
  }

  // Rejoin the room this device was last in — a locked phone killing the tab mid-game
  // should not cost you your settlements.
  const last = localStorage.getItem('hexcolony_room');
  if (!last) return;
  try {
    const snap = await withTimeout(getDoc(doc(db, 'rooms', last)), 5000);
    if (snap.exists() && !roomIsStale(snap.data()) && snap.data().players?.[playerId]) {
      enterRoom(last);
      toast(`Back in room ${last}`);
    } else {
      localStorage.removeItem('hexcolony_room');
    }
  } catch {
    localStorage.removeItem('hexcolony_room');
  }
})();
