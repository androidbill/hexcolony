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

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  initializeFirestore, doc, getDoc, getDocFromServer, setDoc, updateDoc, onSnapshot,
  deleteField, deleteDoc, serverTimestamp, runTransaction,
  disableNetwork, enableNetwork,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

import { firebaseConfig } from './firebase-config.js';
import { WORD_CODES } from './wordcodes.js';
import { APP_VERSION } from './version.js';
import { makeBoard, RESOURCES, TERRAIN, HEXES, VERTS, EDGES } from './board.js';
import { BoardView, RES_COLOR, RES_ICON, loadTerrainArt } from './render.js';
import { sfx, buzz, setSound, soundEnabled, unlock } from './audio.js';
import * as R from './rules.js';

const app = initializeApp(firebaseConfig);
// Some phones (iOS Safari behind content blockers, certain captive wifi) silently
// break the streaming transport; auto-detection falls back to long-polling.
const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });

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
let playerId = localStorage.getItem('hexcolony_pid');
if (!playerId) { playerId = rid(); localStorage.setItem('hexcolony_pid', playerId); }

const AVATARS = [
  '🐺', '🦊', '🦅', '🐗', '🦌', '🐻', '🦉', '🐍', '🦂', '🐙',
  '🦈', '🐊', '🦏', '🐫', '🦬', '🐉', '🦅', '🦭', '🐅', '🦍',
  '⚔️', '🛡️', '🏹', '⚒️', '👑', '🗿', '⛵', '🧭', '🗺️', '⚓',
  '🔥', '🌋', '⛰️', '🌾', '🌲', '🧱', '🐑', '💎', '🏰', '🎲',
];
let myAvatar = localStorage.getItem('hexcolony_avatar') || AVATARS[Math.floor(Math.random() * AVATARS.length)];

// ---------------------------------------------------------------- dom helpers
const $ = (id) => document.getElementById(id);
const show = (el) => el && el.classList.remove('hidden');
// Escapes for BOTH text and attribute contexts — names and avatars arrive from other
// people's devices, and a quote that survives breaks straight out of an attribute.
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const SCREENS = ['screen-home', 'screen-lobby', 'screen-game'];
function showScreen(id) {
  for (const s of SCREENS) $(s).classList.toggle('is-active', s === id);
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
$('veil').addEventListener('click', closeSheet);
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeSheet();
});

// ---------------------------------------------------------------- state
let roomCode = null;
let roomRef = null;
let pulseRef = null;
let room = null;
let unsub = null;

const view = new BoardView($('board-cv'));
// Illustrated terrain tiles load in the background. Until they arrive (or if they are
// not there at all) the board draws its procedural motifs, so play never waits on art.
loadTerrainArt(() => view.draw(performance.now()));
let board = null;              // regenerated whenever the seed changes
let boardSeed = null;
let intent = null;             // 'road' | 'settlement' | 'city' | null — what a board tap means
let lastSeq = 0;               // highest game-log id already reacted to
let lastPhaseKey = '';
let seenLogAt = 0;
let dismissedTrade = null;
let sending = false;

const myName = () => ($('name-input').value || '').trim().slice(0, 14);
const isHost = () => room && room.hostId === playerId;
const game = () => room && room.game;
const seatOrder = () => (room?.order || Object.keys(room?.players || {}));

function colorFor(pid) {
  const p = room?.players?.[pid];
  const idx = p?.colorIdx ?? 0;
  return R.PLAYER_COLORS[idx % R.PLAYER_COLORS.length].hex;
}
function nameFor(pid) { return room?.players?.[pid]?.name || 'Someone'; }
function faceFor(pid) { return room?.players?.[pid]?.avatar || '🎲'; }
view.colorOf = colorFor;

// ---------------------------------------------------------------- landing screen
$('name-input').value = localStorage.getItem('hexcolony_name') || '';
$('avatar-face').textContent = myAvatar;

$('avatar-big').addEventListener('click', () => {
  // A tap rolls to the next unused-looking avatar. No picker grid: it's one control.
  const i = AVATARS.indexOf(myAvatar);
  myAvatar = AVATARS[(i + 1 + Math.floor(Math.random() * 3)) % AVATARS.length];
  localStorage.setItem('hexcolony_avatar', myAvatar);
  $('avatar-face').textContent = myAvatar;
  unlock(); sfx.tap();
  if (roomRef) updateDoc(roomRef, { [`players.${playerId}.avatar`]: myAvatar }).catch(() => {});
});

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
  return { name, avatar: myAvatar, colorIdx, joinedAt: Date.now() };
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
      settings: { targetVP: 10, discardLimit: 7, boardMode: 'random' },
      players: { [playerId]: freshPlayer(name, 0) },
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
      const used = new Set(Object.values(data?.players || {}).map((p) => p.colorIdx));
      let colorIdx = 0;
      while (used.has(colorIdx) && colorIdx < R.PLAYER_COLORS.length - 1) colorIdx++;
      updateDoc(ref, { [`players.${playerId}`]: freshPlayer(name, colorIdx) }).catch(() => {});
    }
    sfx.join();
    enterRoom(code);
  } finally {
    $('btn-join').disabled = false;
  }
}

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
  room = data;
  if (data.pulseAt) applyPulse({ at: data.pulseAt, by: data.pulseBy }, fresh);
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
  lastSeq = 0; lastPhaseKey = ''; dismissedTrade = null;
  subscribeRoom();
  subscribePulse();
  // One immediate beat so this phone has a clock reading straight away.
  writePulse(true);
  if (healthInterval) clearInterval(healthInterval);
  healthInterval = setInterval(healthCheck, HEALTH_MS);
  showScreen('screen-lobby');
}

async function leaveRoom(removeSelf = true) {
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
  board = null; boardSeed = null; intent = null;
  localStorage.removeItem('hexcolony_room');
  keepAwake(false);
  closeSheet();
  showScreen('screen-home');
}

// ---------------------------------------------------------------- posting moves
/**
 * Send a move. The engine re-validates inside the transaction against the state that
 * is actually on the server, so two people acting at once cannot both win the race.
 */
async function send(move) {
  if (!roomRef || sending) return false;
  sending = true;
  let rejected = null;
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) { rejected = 'The room is gone.'; return; }
      const data = snap.data();
      if (!data.game) { rejected = 'The game has not started.'; return; }
      const res = R.applyMove(data.game, playerId, move);
      if (!res.ok) { rejected = res.error; return; }
      const patch = { game: res.game };
      if (res.game.phase === 'over') patch.state = 'over';
      tx.update(roomRef, patch);
    });
  } catch (e) {
    console.error(e);
    rejected = 'That did not go through — check your connection.';
  } finally {
    sending = false;
  }
  if (rejected) { toast(rejected); sfx.error(); return false; }
  nudgeCount = 0;
  return true;
}

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
    if (!isHost()) return toast('Only the host can change the setup.');
    const key = b.dataset.set;
    const step = Number(b.dataset.step);
    const s = room.settings || {};
    if (key === 'target') {
      const v = Math.max(5, Math.min(15, (s.targetVP || 10) + step));
      updateDoc(roomRef, { 'settings.targetVP': v }).catch(() => {});
    } else {
      const v = Math.max(5, Math.min(12, (s.discardLimit || 7) + step));
      updateDoc(roomRef, { 'settings.discardLimit': v }).catch(() => {});
    }
    sfx.tap();
  });
}

for (const b of document.querySelectorAll('[data-board]')) {
  b.addEventListener('click', () => {
    if (!isHost()) return toast('Only the host can change the setup.');
    updateDoc(roomRef, { 'settings.boardMode': b.dataset.board }).catch(() => {});
    sfx.tap();
  });
}

$('btn-start').addEventListener('click', startGame);

async function startGame() {
  if (!isHost()) return toast('Only the host can start.');
  const ids = Object.keys(room.players || {});
  if (ids.length < 2) return toast('You need at least two players.');
  // Seat order is shuffled, which is this game's version of rolling for first player.
  const order = ids.slice().sort(() => Math.random() - 0.5);
  const g = R.newGame(order, room.settings || {});
  try {
    await updateDoc(roomRef, { state: 'playing', order, game: g });
    sfx.yourTurn();
  } catch (e) { console.error(e); toast('Could not start — check your connection.'); }
}

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
    return `<div class="seat" style="border-left-color:${esc(c)}">
      <span class="seat-face">${esc(p.avatar || '🎲')}</span>
      <span class="seat-name">${esc(p.name)}</span>${tags.join('')}
    </div>`;
  }).join('');

  const s = room.settings || {};
  $('set-target').textContent = String(s.targetVP || 10);
  $('set-discard').textContent = String(s.discardLimit || 7);
  for (const b of document.querySelectorAll('[data-board]')) {
    b.classList.toggle('on', b.dataset.board === (s.boardMode || 'random'));
  }

  const enough = ids.length >= 2;
  $('btn-start').disabled = !enough || !isHost();
  $('start-hint').textContent = !enough
    ? 'Needs at least 2 players.'
    : isHost() ? 'Everyone in? Deal the island.' : `Waiting for ${esc(nameFor(room.hostId))} to start.`;
  $('lobby-hint').textContent = isHost()
    ? 'Share the code — players can join until you start.'
    : 'You can change your name and avatar on the home screen.';
}

// ---------------------------------------------------------------- board plumbing
function ensureBoard() {
  const g = game();
  if (!g) return null;
  if (boardSeed !== g.seed || board?.mode !== g.mode) {
    board = makeBoard(g.seed, g.mode);
    boardSeed = g.seed;
    view.setBoard(board);
  }
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
    if (hit.kind === 'vertex') send({ type: 'setupSettlement', v: hit.id }).then((ok) => ok && sfx.build());
    if (hit.kind === 'edge') send({ type: 'setupRoad', e: hit.id }).then((ok) => ok && sfx.road());
    return;
  }
  if (g.phase === 'robber' && hit.kind === 'hex') {
    send({ type: 'moveRobber', hex: hit.id }).then((ok) => ok && sfx.robber());
    return;
  }
  if (intent === 'road' && hit.kind === 'edge') {
    send({ type: 'build', what: 'road', e: hit.id }).then((ok) => { if (ok) { sfx.road(); clearIntent(); } });
    return;
  }
  if (intent === 'settlement' && hit.kind === 'vertex') {
    send({ type: 'build', what: 'settlement', v: hit.id }).then((ok) => { if (ok) { sfx.build(); clearIntent(); } });
    return;
  }
  if (intent === 'city' && hit.kind === 'vertex') {
    send({ type: 'build', what: 'city', v: hit.id }).then((ok) => { if (ok) { sfx.city(); clearIntent(); } });
  }
};

function setIntent(kind) { intent = kind; render(); }
function clearIntent() {
  // Road Building hands out two free roads; stay in road mode until they are placed.
  const g = game();
  if (g && g.turn?.freeRoads > 0 && intent === 'road') { render(); return; }
  intent = null;
  render();
}

$('btn-recenter').addEventListener('click', () => { view.resetView(); sfx.tap(); });

// A continuous loop so the legal-move highlights can pulse.
function loop(t) {
  view.draw(t);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---------------------------------------------------------------- game rendering
function render() {
  if (!room) return;

  if (room.state === 'lobby') {
    if (!$('screen-lobby').classList.contains('is-active')) showScreen('screen-lobby');
    renderLobby();
    return;
  }

  const g = game();
  if (!g) return;
  ensureBoard();
  if (!$('screen-game').classList.contains('is-active')) {
    showScreen('screen-game');
    view.resetView();
  }

  view.setGame(g);
  view.setHighlights(R.highlightsFor(g, playerId, intent));

  reactToLog(g);
  renderScoreStrip(g);
  renderTurnBadge(g);
  renderDice(g);
  renderHand(g);
  renderActions(g);
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
      case 'roll': sfx.dice(); break;
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
      case 'trade': sfx.trade(); break;
      case 'bankTrade': if (e.p === playerId) sfx.trade(); break;
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

function bumpCards(list) {
  for (const r of list) {
    const el = document.querySelector(`.res-card[data-res="${r}"]`);
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
    return `<button class="chip${pid === up ? ' up' : ''}" style="--c:${esc(colorFor(pid))}" data-pcard>
      <span class="chip-face">${esc(faceFor(pid))}</span>
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
    return `Waiting on ${n} player${n > 1 ? 's' : ''} to discard`;
  }
  if (g.phase === 'robber') return mine ? 'Move the robber — tap a tile' : `${who} is moving the robber`;
  if (g.phase === 'steal') return mine ? 'Choose who to rob' : `${who} is choosing who to rob`;
  if (g.phase === 'roll') return mine ? 'Your turn — roll the dice' : `${who} to roll`;
  if (g.phase === 'build') {
    if (g.turn.freeRoads > 0 && mine) return `Place ${g.turn.freeRoads} free road${g.turn.freeRoads > 1 ? 's' : ''}`;
    return mine ? 'Your turn — build, trade or end' : `${who}'s turn`;
  }
  if (g.phase === 'over') return `${g.winner === playerId ? 'You' : nameFor(g.winner)} won`;
  return '';
}

function renderTurnBadge(g) {
  const badge = $('turn-badge');
  const mine = R.isTurn(g, playerId) || (g.phase === 'discard' && g.pending.discard[playerId]);
  let text = turnText(g);
  if (intent) {
    text = intent === 'road' ? 'Tap a highlighted edge' :
           intent === 'city' ? 'Tap one of your settlements' : 'Tap a highlighted corner';
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
    for (const el of [$('die-a'), $('die-b')]) {
      el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    }
  }
}

function renderHand(g) {
  const p = g.players[playerId];
  if (!p) { $('hand').innerHTML = '<span class="hint">You are watching this game.</span>'; return; }
  $('hand').innerHTML = RESOURCES.map((r) => {
    const n = p.res[r] || 0;
    return `<div class="res-card${n ? '' : ' zero'}" data-res="${r}" style="--c:${RES_COLOR[r]}">
      <div class="res-icon">${RES_ICON[r]}</div>
      <div class="res-n">${n}</div>
      <div class="res-name">${r}</div>
    </div>`;
  }).join('');
}

function actBtn(id, ico, label, opts = {}) {
  const cls = ['act'];
  if (opts.primary) cls.push('primary');
  if (opts.wide) cls.push('wide');
  const badge = opts.badge ? `<span class="badge">${opts.badge}</span>` : '';
  return `<button class="${cls.join(' ')}" data-act="${id}"${opts.disabled ? ' disabled' : ''}>
    <span class="act-ico">${ico}</span><span>${esc(label)}</span>${badge}</button>`;
}

function renderActions(g) {
  const mine = R.isTurn(g, playerId);
  const p = g.players[playerId];
  const bar = $('actions');
  const devHand = p ? Object.entries(p.dev).filter(([k, n]) => k !== 'vp' && n > 0) : [];
  const devBadge = devHand.reduce((n, [, c]) => n + c, 0);

  if (!p) { bar.innerHTML = actBtn('log', '📜', 'Game log', { wide: true }); wireActions(); return; }

  if (g.phase === 'over') {
    bar.innerHTML = actBtn('over', '🏆', 'Results', { primary: true, wide: true }) + actBtn('log', '📜', 'Log');
    wireActions(); return;
  }

  if (g.phase === 'discard') {
    bar.innerHTML = g.pending.discard[playerId]
      ? actBtn('discard', '🗑️', 'Discard', { primary: true, wide: true })
      : actBtn('log', '📜', 'Game log', { wide: true });
    wireActions(); return;
  }

  if (!mine || g.phase === 'setup') {
    bar.innerHTML = actBtn('players', '👥', 'Players') + actBtn('log', '📜', 'Log', { badge: 0 });
    wireActions(); return;
  }

  if (g.phase === 'robber' || g.phase === 'steal') {
    bar.innerHTML = actBtn('players', '👥', 'Players') + actBtn('log', '📜', 'Log');
    wireActions(); return;
  }

  if (g.phase === 'roll') {
    bar.innerHTML =
      actBtn('roll', '🎲', 'Roll', { primary: true, wide: true }) +
      actBtn('dev', '🃏', 'Cards', { disabled: !devHand.length, badge: devBadge || 0 }) +
      actBtn('log', '📜', 'Log');
    wireActions(); return;
  }

  // build phase
  const can = R.whatCanIBuild(g, playerId);
  const anyBuild = can.road || can.settlement || can.city;
  const mustPlace = g.turn.freeRoads > 0;
  bar.innerHTML =
    actBtn('build', '🏗️', 'Build', { disabled: !anyBuild && !mustPlace, primary: mustPlace }) +
    actBtn('trade', '🤝', 'Trade', { disabled: R.handSize(p) === 0 }) +
    actBtn('dev', '🃏', 'Cards', { disabled: !devHand.length && !can.dev, badge: devBadge || 0 }) +
    actBtn('end', '✔️', 'End turn', { primary: !mustPlace, disabled: mustPlace });
  wireActions();
}

function wireActions() {
  for (const b of document.querySelectorAll('[data-act]')) {
    b.addEventListener('click', () => onAction(b.dataset.act), { once: true });
  }
  for (const b of document.querySelectorAll('[data-pcard]')) {
    b.addEventListener('click', () => { openPlayers(); }, { once: true });
  }
}

function onAction(id) {
  unlock();
  const g = game();
  if (!g) return;
  sfx.tap();
  switch (id) {
    case 'roll': send({ type: 'roll' }); break;
    case 'end': intent = null; send({ type: 'endTurn' }); break;
    case 'build': openBuild(g); break;
    case 'trade': openTrade(g); break;
    case 'dev': openDev(g); break;
    case 'discard': openDiscard(g); break;
    case 'players': openPlayers(); break;
    case 'log': openLog(g); break;
    case 'over': sheet('sheet-over'); break;
    default: break;
  }
}

// ---------------------------------------------------------------- build sheet
const COST_BITS = (cost) => Object.entries(cost)
  .flatMap(([r, n]) => Array(n).fill(`<span>${RES_ICON[r]}</span>`)).join('');

function openBuild(g) {
  const p = g.players[playerId];
  const can = R.whatCanIBuild(g, playerId);
  const items = [
    { k: 'road', ico: '🛣️', name: 'Road', cost: R.COSTS.road, ok: can.road, left: p.left.road },
    { k: 'settlement', ico: '🏠', name: 'Settlement', cost: R.COSTS.settlement, ok: can.settlement, left: p.left.settlement },
    { k: 'city', ico: '🏛️', name: 'City', cost: R.COSTS.city, ok: can.city, left: p.left.city },
    { k: 'dev', ico: '🃏', name: 'Development card', cost: R.COSTS.dev, ok: can.dev, left: g.deck.length },
  ];
  $('build-grid').innerHTML = items.map((it) => `
    <button class="build-item" data-build="${it.k}"${it.ok ? '' : ' disabled'}>
      <span class="build-ico">${it.ico}</span>
      <span class="build-txt">
        <span class="build-name">${it.name}</span>
        <span class="build-cost">${COST_BITS(it.cost)}</span>
      </span>
      <span class="build-left">${it.left} left</span>
    </button>`).join('');

  for (const b of document.querySelectorAll('[data-build]')) {
    b.addEventListener('click', () => {
      const k = b.dataset.build;
      closeSheet();
      if (k === 'dev') { send({ type: 'buyDev' }).then((ok) => ok && sfx.card()); return; }
      setIntent(k);
      toast(k === 'city' ? 'Tap one of your settlements.' : 'Tap a highlighted spot on the board.');
    }, { once: true });
  }
  sheet('sheet-build');
}

// ---------------------------------------------------------------- dev cards
function openDev(g) {
  const p = g.players[playerId];
  const rows = [];
  for (const [k, info] of Object.entries(R.DEV_INFO)) {
    if (k === 'vp') continue;
    const ready = p.dev[k] || 0;
    const fresh = p.devNew[k] || 0;
    if (!ready && !fresh) continue;
    const blocked = g.turn.playedDev || !ready
      || (k !== 'knight' && g.phase !== 'build');
    rows.push(`<button class="dev-card" data-dev="${k}"${blocked ? ' disabled' : ''}>
      <span class="dev-n">${ready + fresh}</span>
      <span class="dev-txt">
        <span class="dev-name">${esc(info.name)}</span>
        <span class="dev-blurb">${esc(info.blurb)}</span>
        ${fresh ? `<span class="dev-lock">${fresh} bought this turn — playable next turn</span>` : ''}
        ${g.turn.playedDev && ready ? '<span class="dev-lock">One card per turn, already used</span>' : ''}
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
    : '<p class="hint">No development cards yet. Buy one with sheep, wheat and ore.</p>';

  for (const b of document.querySelectorAll('[data-dev]')) {
    b.addEventListener('click', () => {
      const k = b.dataset.dev;
      closeSheet();
      if (k === 'knight') { send({ type: 'playDev', card: 'knight' }).then((ok) => ok && sfx.card()); return; }
      if (k === 'road') { send({ type: 'playDev', card: 'road' }).then((ok) => { if (ok) { sfx.card(); setIntent('road'); } }); return; }
      if (k === 'plenty') { openPickRes('plenty'); return; }
      if (k === 'mono') { openPickRes('mono'); return; }
    }, { once: true });
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
    if (opts.single) {
      return `<div class="pick-col">
        <button class="pick-btn${opts.chosen === r ? ' on' : ''}" data-pick="${r}" style="--c:${RES_COLOR[r]}">
          <span class="pick-ico">${RES_ICON[r]}</span>
          <span class="pick-n">${RES_ICON[r] ? '' : ''}${r === opts.chosen ? '✓' : ''}</span>
        </button>${have}</div>`;
    }
    return `<div class="pick-col">
      <button class="pick-btn${n ? ' on' : ''}" style="--c:${RES_COLOR[r]}" disabled>
        <span class="pick-ico">${RES_ICON[r]}</span>
        <span class="pick-n">${n}</span>
      </button>
      <div class="pick-pm">
        <button data-pm="-" data-r="${r}">−</button>
        <button data-pm="+" data-r="${r}">+</button>
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
      }, { once: true });
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
          <button class="pick-btn${chosen === r ? ' on' : ''}" data-pick="${r}" style="--c:${RES_COLOR[r]}">
            <span class="pick-ico">${RES_ICON[r]}</span>
            <span class="pick-n">${chosen === r ? '✓' : ''}</span>
          </button>
          <span class="pick-have">${r}</span>
        </div>`).join('');
      for (const b of document.querySelectorAll('#pickres-picker [data-pick]')) {
        b.addEventListener('click', () => { chosen = b.dataset.pick; sfx.tap(); draw(); }, { once: true });
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
        }, { once: true });
      }
    };
    draw();
    $('btn-pickres').onclick = () => { closeSheet(); send({ type: 'playDev', card: 'plenty', res: chosen }); };
  }
  sheet('sheet-pickres');
}

// ---------------------------------------------------------------- trading
let tradeTab = 'bank';
let giveSel = {}, wantSel = {};

for (const b of document.querySelectorAll('[data-trade-tab]')) {
  b.addEventListener('click', () => {
    tradeTab = b.dataset.tradeTab;
    for (const x of document.querySelectorAll('[data-trade-tab]')) x.classList.toggle('on', x === b);
    $('trade-bank').hidden = tradeTab !== 'bank';
    $('trade-players').hidden = tradeTab !== 'players';
    sfx.tap();
    if (tradeTab === 'players') drawOfferPickers();
  });
}

function openTrade(g) {
  tradeTab = 'bank';
  for (const x of document.querySelectorAll('[data-trade-tab]')) x.classList.toggle('on', x.dataset.tradeTab === 'bank');
  $('trade-bank').hidden = false;
  $('trade-players').hidden = true;
  giveSel = {}; wantSel = {};
  drawBankTrades(g);
  drawOfferPickers();
  sheet('sheet-trade');
}

function drawBankTrades(g) {
  const p = g.players[playerId];
  const rows = [];
  for (const give of RESOURCES) {
    const rate = R.tradeRate(g, board, playerId, give);
    const able = (p.res[give] || 0) >= rate;
    rows.push(`<div class="bank-row${able ? '' : ' dim'}"${able ? '' : ' style="opacity:.4"'}>
      <span class="bank-give">${rate}× ${RES_ICON[give]}</span>
      <span class="rate-badge">${rate}:1</span>
      <span class="bank-arrow">→</span>
      <span class="bank-want">${RESOURCES.filter((w) => w !== give).map((w) => `
        <b data-bank="${give}:${w}"${able && g.bank[w] > 0 ? '' : ' style="opacity:.35;pointer-events:none"'}>${RES_ICON[w]}</b>`).join('')}</span>
    </div>`);
  }
  $('bank-list').innerHTML = rows.join('');
  for (const b of document.querySelectorAll('[data-bank]')) {
    b.addEventListener('click', () => {
      const [give, want] = b.dataset.bank.split(':');
      closeSheet();
      send({ type: 'bankTrade', give, want }).then((ok) => ok && sfx.trade());
    }, { once: true });
  }
}

function drawOfferPickers() {
  const g = game();
  if (!g) return;
  const p = g.players[playerId];
  const build = (elId, sel, cap) => {
    $(elId).innerHTML = RESOURCES.map((r) => `
      <div class="pick-col">
        <button class="pick-btn${sel[r] ? ' on' : ''}" style="--c:${RES_COLOR[r]}" disabled>
          <span class="pick-ico">${RES_ICON[r]}</span>
          <span class="pick-n">${sel[r] || 0}</span>
        </button>
        <div class="pick-pm">
          <button data-off="${elId}:-:${r}">−</button>
          <button data-off="${elId}:+:${r}">+</button>
        </div>
        ${cap ? `<span class="pick-have">have ${p.res[r] || 0}</span>` : ''}
      </div>`).join('');
  };
  build('give-picker', giveSel, true);
  build('want-picker', wantSel, false);

  for (const b of document.querySelectorAll('[data-off]')) {
    b.addEventListener('click', () => {
      const [elId, op, r] = b.dataset.off.split(':');
      const sel = elId === 'give-picker' ? giveSel : wantSel;
      if (op === '+') {
        if (elId === 'give-picker' && (sel[r] || 0) >= (p.res[r] || 0)) return;
        sel[r] = (sel[r] || 0) + 1;
      } else {
        if (!sel[r]) return;
        sel[r] -= 1;
        if (!sel[r]) delete sel[r];
      }
      sfx.tap();
      drawOfferPickers();
    }, { once: true });
  }
  const gTotal = Object.values(giveSel).reduce((a, b) => a + b, 0);
  const wTotal = Object.values(wantSel).reduce((a, b) => a + b, 0);
  $('btn-offer').disabled = !gTotal || !wTotal;
}

$('btn-offer').addEventListener('click', () => {
  closeSheet();
  send({ type: 'offerTrade', give: giveSel, want: wantSel }).then((ok) => {
    if (ok) { giveSel = {}; wantSel = {}; }
  });
});

const cardBits = (obj) => Object.entries(obj)
  .flatMap(([r, n]) => Array(n).fill(`<span>${RES_ICON[r]} ${r}</span>`)).join('');

function openOffer(g) {
  const t = g.trade;
  if (!t) return;
  const mine = t.from === playerId;
  $('offer-title').textContent = mine ? 'Your offer' : `${nameFor(t.from)} offers a trade`;

  // Shown from the reader's point of view: what they'd hand over and what they'd get.
  const youGet = mine ? t.want : t.give;
  const youGive = mine ? t.give : t.want;
  $('offer-body').innerHTML = `
    <div class="offer-side">
      <div class="offer-side-l">You give</div>
      <div class="offer-cards">${cardBits(youGive) || '<span>—</span>'}</div>
    </div>
    <div class="offer-swap">⇄</div>
    <div class="offer-side">
      <div class="offer-side-l">You get</div>
      <div class="offer-cards">${cardBits(youGet) || '<span>—</span>'}</div>
    </div>`;

  if (mine) {
    const others = g.seats.filter((s) => s !== playerId);
    $('offer-replies').innerHTML = others.map((pid) => {
      const r = t.replies[pid];
      const cls = r === 'yes' ? ' yes' : r === 'no' ? ' no' : '';
      const tag = r === 'yes' ? 'Accepts — tap to trade' : r === 'no' ? 'Declined' : 'Thinking…';
      return `<button class="reply-row${cls}"${r === 'yes' ? ` data-accept="${esc(pid)}"` : ' disabled'}>
        <span>${esc(faceFor(pid))}</span>
        <span class="reply-name">${esc(nameFor(pid))}</span>
        <span class="reply-tag">${tag}</span>
      </button>`;
    }).join('');
    $('offer-actions').innerHTML = '<button class="btn btn-ghost" id="offer-cancel">Withdraw offer</button>';
    $('offer-cancel').onclick = () => { closeSheet(); send({ type: 'cancelTrade' }); };
    for (const b of document.querySelectorAll('[data-accept]')) {
      b.addEventListener('click', () => {
        closeSheet();
        send({ type: 'acceptTrade', with: b.dataset.accept }).then((ok) => ok && sfx.trade());
      }, { once: true });
    }
  } else {
    const me = g.players[playerId];
    const able = Object.entries(t.want).every(([r, n]) => (me.res[r] || 0) >= n);
    $('offer-replies').innerHTML = able ? '' :
      '<p class="hint">You do not have what they are asking for.</p>';
    $('offer-actions').innerHTML =
      `<button class="btn btn-key" id="offer-yes"${able ? '' : ' disabled'}><span class="btn-label">Accept</span></button>
       <button class="btn btn-ghost" id="offer-no">No thanks</button>`;
    $('offer-yes').onclick = () => { closeSheet(); send({ type: 'replyTrade', yes: true }); };
    $('offer-no').onclick = () => { closeSheet(); send({ type: 'replyTrade', yes: false }); };
  }
  sheet('sheet-offer');
}

// ---------------------------------------------------------------- steal / players / log
function openSteal(g) {
  $('steal-list').innerHTML = g.pending.stealFrom.map((pid) => `
    <button class="steal-btn" style="--c:${esc(colorFor(pid))}" data-steal="${esc(pid)}">
      <span>${esc(faceFor(pid))}</span>
      <span class="steal-name">${esc(nameFor(pid))}</span>
      <span class="steal-n">${R.handSize(g.players[pid])} cards</span>
    </button>`).join('');
  for (const b of document.querySelectorAll('[data-steal]')) {
    b.addEventListener('click', () => {
      closeSheet();
      send({ type: 'steal', from: b.dataset.steal }).then((ok) => ok && sfx.steal());
    }, { once: true });
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
    ];
    if (g.award.road === pid) stats.push('<span class="pstat award">Longest Road</span>');
    if (g.award.army === pid) stats.push('<span class="pstat award">Largest Army</span>');
    if (ports.length) stats.push(`<span class="pstat">${ports.map((k) => k === 'any' ? '3:1' : `2:1 ${k}`).join(' · ')}</span>`);
    return `<div class="pcard" style="--c:${esc(colorFor(pid))}">
      <div class="pcard-top">
        <span style="font-size:22px">${esc(faceFor(pid))}</span>
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
    case 'robber': text = `<b>${who(e.p)}</b> moved the robber`; break;
    case 'steal': text = `<b>${who(e.p)}</b> robbed <b>${who(e.from)}</b>`; break;
    case 'discard': text = `<b>${who(e.p)}</b> discarded ${e.count}`; break;
    case 'mono': text = `<b>${who(e.p)}</b> monopolised ${e.res} — ${e.count} cards`; break;
    case 'plenty': text = `<b>${who(e.p)}</b> took ${bits(e.res)} from the bank`; break;
    case 'bankTrade': text = `<b>${who(e.p)}</b> traded ${e.rate}${RES_ICON[e.give]} for 1${RES_ICON[e.want]}`; break;
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
  const key = `${g.phase}:${g.turn.num}:${g.trade ? g.trade.from + g.seq : ''}`;
  const changed = key !== lastPhaseKey;
  lastPhaseKey = key;

  if (g.phase === 'discard' && g.pending.discard[playerId]) {
    if (openSheet !== 'sheet-discard') openDiscard(g);
    return;
  }
  if (g.phase === 'steal' && R.isTurn(g, playerId)) {
    if (openSheet !== 'sheet-steal') openSteal(g);
    return;
  }
  if (openSheet === 'sheet-discard' || openSheet === 'sheet-steal') closeSheet();

  if (g.trade) {
    const tradeKey = `${g.trade.from}:${Object.keys(g.trade.replies).length}`;
    const iReplied = g.trade.from === playerId || g.trade.replies[playerId];
    if (dismissedTrade !== g.trade.from && (!iReplied || g.trade.from === playerId)) {
      if (openSheet !== 'sheet-offer') openOffer(g);
      else if (changed) openOffer(g);
    }
  } else {
    dismissedTrade = null;
    if (openSheet === 'sheet-offer') closeSheet();
  }

  if (g.phase === 'over' && openSheet !== 'sheet-over') { renderOver(g); sheet('sheet-over'); }
}

// Waving away a trade offer should stick until the next one.
$('sheet-offer').addEventListener('click', (e) => {
  if (e.target.closest('#offer-no') || e.target.closest('#offer-cancel')) {
    dismissedTrade = game()?.trade?.from || null;
  }
});

// ---------------------------------------------------------------- game over
function renderOver(g) {
  const win = g.winner;
  $('over-title').textContent = win === playerId ? 'You win!' : `${nameFor(win)} wins`;
  $('over-hero').innerHTML = `
    <div class="over-face">${esc(faceFor(win))}</div>
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
      <span>${esc(faceFor(pid))}</span>
      <span class="final-name">${esc(nameFor(pid))}
        <span class="final-break">${parts.join(' · ')}</span></span>
      <span class="final-vp">${R.totalVP(g, pid)}</span>
    </div>`;
  }).join('');
}

$('btn-again').addEventListener('click', async () => {
  if (!isHost()) return toast('Only the host can start a new game.');
  closeSheet();
  try {
    await updateDoc(roomRef, { state: 'lobby', game: null, order: [] });
    lastSeq = 0;
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

// ---------------------------------------------------------------- brand mark
$('brand-mark').innerHTML = `
<svg viewBox="0 0 100 100" aria-hidden="true">
  <defs>
    <linearGradient id="bmSea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1c5b8c"/><stop offset="1" stop-color="#0b2540"/>
    </linearGradient>
    <linearGradient id="bmLand" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e3ba57"/><stop offset="1" stop-color="#b8613a"/>
    </linearGradient>
  </defs>
  <circle cx="50" cy="50" r="46" fill="url(#bmSea)" stroke="#e8d6b2" stroke-width="3" stroke-opacity=".55"/>
  ${[[50, 30], [33, 40], [67, 40], [33, 60], [67, 60], [50, 70], [50, 50]].map(([x, y], i) => {
    const r = 11.5;
    const pts = [0, 1, 2, 3, 4, 5].map((k) => {
      const a = (Math.PI / 180) * (60 * k - 30);
      return `${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}`;
    }).join(' ');
    return `<polygon points="${pts}" fill="${i === 6 ? '#2f6b3a' : 'url(#bmLand)'}"
      stroke="#0d1b28" stroke-width="1.6" stroke-opacity=".5"/>`;
  }).join('')}
  <circle cx="50" cy="50" r="5.4" fill="#f3e6cb"/>
  <text x="50" y="52.4" text-anchor="middle" font-size="7.4" font-weight="800"
    fill="#b3261e" font-family="system-ui, sans-serif">8</text>
</svg>`;

// ---------------------------------------------------------------- PWA
$('ver-home').textContent = `v${APP_VERSION}`;
$('ver-about').textContent = `HexColony v${APP_VERSION}`;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`sw.js?v=${APP_VERSION}`).catch(() => {});
  });
  // The version file is fetched fresh; if the running build is behind, offer a refresh.
  setTimeout(async () => {
    try {
      const res = await fetch(`version.js?t=${Date.now()}`, { cache: 'no-store' });
      const text = await res.text();
      const m = text.match(/APP_VERSION\s*=\s*'([^']+)'/);
      if (m && m[1] !== APP_VERSION) $('update-banner').classList.add('show');
    } catch { /* offline — nothing to check against */ }
  }, 4000);
}

$('btn-refresh').addEventListener('click', async () => {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch { /* fine */ }
  location.reload();
});

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  updateInstallBanner();
});
function updateInstallBanner() {
  const onHome = $('screen-home').classList.contains('is-active');
  $('install-banner').classList.toggle('show', !!installPrompt && onHome);
}
$('btn-install').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  installPrompt = null;
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
  legalSettlements: (setup = false) => R.legalSettlements(game(), playerId, setup),
  legalRoads: (from = null) => R.legalRoads(game(), playerId, from),
  tap: (kind, id) => view.onPick({ kind, id }),
};

// ---------------------------------------------------------------- boot
window.addEventListener('beforeunload', () => {
  // Best effort: tell the room we're gone so the turn doesn't stall on a closed tab.
  if (roomRef && room?.state === 'lobby') {
    try { navigator.sendBeacon?.(''); } catch { /* no-op */ }
  }
});

(async function boot() {
  showScreen('screen-home');
  if (localStorage.getItem('hexcolony_awake') === 'on') keepAwake(true);

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
