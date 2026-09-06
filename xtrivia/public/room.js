// Room lifecycle on top of the Realtime Database. One room = one `rooms/$code` node.
//
// There is no Firebase Auth here (same trust model as a living-room party game — the
// room code is the only secret), so "host" just means "the browser tab that created the
// room and holds `hostId` in localStorage". Any tab could technically forge writes; the
// database rules only check shape, not identity.

import {
  rtdb, ref, get, set, update, onValue, onDisconnect,
  serverTimestamp, serverNow,
} from './fb.js';

// Letters/digits with the visually-confusable ones dropped (0/O, 1/I/L) — this gets read
// off one phone screen and typed into another.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_RE = /^[A-Z0-9]{5}$/;

function makeCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).slice(0, 24);
}

const roomRef = (code) => ref(rtdb, `rooms/${code}`);

/** Points for one answer: 0 if wrong, else 500-1000 scaled by how fast it came in. */
export function scoreAnswer(correct, msRemaining, msTotal) {
  if (!correct) return 0;
  const frac = Math.max(0, Math.min(1, msRemaining / msTotal));
  return Math.round(500 + 500 * frac);
}

/** Create a room in 'lobby' state. Returns { code, playerId }. Retries on a code clash. */
export async function createRoom(hostName, settings) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = makeCode();
    const existing = await get(roomRef(code));
    if (existing.exists()) continue;

    const hostId = newId();
    await set(roomRef(code), {
      code,
      hostId,
      state: 'lobby',
      createdAt: serverTimestamp(),
      settings,
      players: {
        [hostId]: { name: hostName, score: 0, isHost: true, joinedAt: serverTimestamp(), connected: true },
      },
      currentIndex: -1,
    });
    onDisconnect(ref(rtdb, `rooms/${code}/players/${hostId}/connected`)).set(false);
    return { code, playerId: hostId };
  }
  throw new Error('Could not allocate a room code — try again.');
}

/** Join an existing lobby. Returns { code, playerId }. */
export async function joinRoom(code, name) {
  const snap = await get(roomRef(code));
  if (!snap.exists()) throw new Error(`No room found for code ${code}.`);
  const room = snap.val();
  if (room.state !== 'lobby') throw new Error('That game has already started.');

  const playerId = newId();
  await update(ref(rtdb, `rooms/${code}/players/${playerId}`), {
    name, score: 0, isHost: false, joinedAt: serverTimestamp(), connected: true,
  });
  onDisconnect(ref(rtdb, `rooms/${code}/players/${playerId}/connected`)).set(false);
  return { code, playerId };
}

/** Rejoin after a refresh/reconnect — just marks presence back on if the player still exists. */
export async function rejoinRoom(code, playerId) {
  const snap = await get(ref(rtdb, `rooms/${code}/players/${playerId}`));
  if (!snap.exists()) return false;
  await update(ref(rtdb, `rooms/${code}/players/${playerId}`), { connected: true });
  onDisconnect(ref(rtdb, `rooms/${code}/players/${playerId}/connected`)).set(false);
  return true;
}

/** Live-subscribe to the whole room. Returns an unsubscribe function. */
export function watchRoom(code, cb) {
  return onValue(roomRef(code), (snap) => cb(snap.val()));
}

/** Host: store the fetched question set and open the first question. */
export async function startGame(code, questions) {
  await update(roomRef(code), {
    questions,
    currentIndex: 0,
    state: 'question',
    questionStartedAt: serverTimestamp(),
    answers: null,
  });
}

/** Player: record an answer for the current question, once. */
export async function submitAnswer(code, qIndex, playerId, optionIndex) {
  const path = ref(rtdb, `rooms/${code}/answers/${qIndex}/${playerId}`);
  const existing = await get(path);
  if (existing.exists()) return; // already answered this question
  await set(path, { optionIndex, answeredAt: serverTimestamp() });
}

/**
 * Host: close out the current question — score every submitted answer against the
 * correct index, add points to each player, and move the room into 'reveal'.
 */
export async function revealAnswer(code, room) {
  const qIndex = room.currentIndex;
  const question = room.questions[qIndex];
  const seconds = room.settings.seconds;
  const startedAt = room.questionStartedAt;
  const answers = (room.answers && room.answers[qIndex]) || {};

  const updates = { state: 'reveal' };
  for (const [pid, ans] of Object.entries(answers)) {
    const correct = ans.optionIndex === question.correctIndex;
    const msRemaining = (startedAt + seconds * 1000) - ans.answeredAt;
    const points = scoreAnswer(correct, msRemaining, seconds * 1000);
    updates[`answers/${qIndex}/${pid}/correct`] = correct;
    updates[`answers/${qIndex}/${pid}/points`] = points;
    const prevScore = (room.players[pid] && room.players[pid].score) || 0;
    updates[`players/${pid}/score`] = prevScore + points;
  }
  await update(roomRef(code), updates);
}

/** Host: advance to the next question, or to 'end' if that was the last one. */
export async function nextQuestion(code, room) {
  const next = room.currentIndex + 1;
  if (next >= room.questions.length) {
    await update(roomRef(code), { state: 'end' });
  } else {
    await update(roomRef(code), {
      currentIndex: next,
      state: 'question',
      questionStartedAt: serverTimestamp(),
    });
  }
}

/** Host: same players and settings, fresh question set. */
export async function playAgain(code, questions) {
  await update(roomRef(code), {
    questions,
    answers: null,
    currentIndex: 0,
    state: 'question',
    questionStartedAt: serverTimestamp(),
  });
  const snap = await get(ref(rtdb, `rooms/${code}/players`));
  const players = snap.val() || {};
  const resets = {};
  for (const pid of Object.keys(players)) resets[`players/${pid}/score`] = 0;
  await update(roomRef(code), resets);
}

export function msLeft(room) {
  if (!room.questionStartedAt) return 0;
  const total = room.settings.seconds * 1000;
  const elapsed = serverNow() - room.questionStartedAt;
  return Math.max(0, total - elapsed);
}
