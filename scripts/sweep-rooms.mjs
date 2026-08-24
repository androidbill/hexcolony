// Delete rooms nobody is sitting in.
//
// Nothing in the app ever removes a room. The browser filters expired ones out of the
// list (see renderRoomList) but the documents stay in Firestore for good, so a session
// of testing leaves a pile of tables behind that only this clears up.
//
// "Active" is decided by the heartbeat, not by the room's own eight-hour TTL: a phone in
// a room writes pulses/{code} every four seconds, so a room whose last beat is minutes
// old has nobody in it whatever its TTL says. A game in progress cannot look idle for
// long — the default window below is thirty missed beats.
//
// Talks to the REST API rather than the SDK: the app loads Firebase from a CDN, which
// Node will not import, and none of this needs a library. The rules already allow an
// unauthenticated client to read and delete rooms (firestore.rules), which is the same
// permission the game itself runs on.
//
//   node scripts/sweep-rooms.mjs                 # say what would go, delete nothing
//   node scripts/sweep-rooms.mjs --delete        # actually delete them
//   node scripts/sweep-rooms.mjs --idle=30       # count a room dead after 30 minutes
//   node scripts/sweep-rooms.mjs --delete --all  # every room, even one in use

import { firebaseConfig } from '../public/firebase-config.js';

const KEY = firebaseConfig.apiKey;
const ROOT = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}`
  + '/databases/(default)/documents';

const args = process.argv.slice(2);
const DELETE = args.includes('--delete');
const ALL = args.includes('--all');
const idleArg = args.find((a) => a.startsWith('--idle='));
const IDLE_MS = (idleArg ? Number(idleArg.split('=')[1]) : 2) * 60 * 1000;

const url = (path, params = '') => `${ROOT}/${path}?key=${KEY}${params}`;

async function get(path, params = '') {
  const res = await fetch(url(path, params));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  return res.json();
}

/** Firestore REST wraps every value in a type tag; this is only the few shapes used here. */
function plain(field) {
  if (!field) return undefined;
  if ('timestampValue' in field) return Date.parse(field.timestampValue);
  if ('integerValue' in field) return Number(field.integerValue);
  if ('stringValue' in field) return field.stringValue;
  if ('mapValue' in field) {
    return Object.fromEntries(Object.entries(field.mapValue.fields || {})
      .map(([k, v]) => [k, plain(v)]));
  }
  return undefined;
}

const idOf = (doc) => doc.name.split('/').pop();

async function listAll(path) {
  const out = [];
  let token = '';
  do {
    const page = await get(path, `&pageSize=300${token ? `&pageToken=${token}` : ''}`);
    if (!page) break;
    out.push(...(page.documents || []));
    token = page.nextPageToken || '';
  } while (token);
  return out;
}

async function main() {
  const rooms = await listAll('rooms');
  if (!rooms.length) { console.log('No rooms in the database at all.'); return; }

  // One read per room for its heartbeat. Fine for the handful this is ever pointed at.
  const pulses = new Map();
  await Promise.all(rooms.map(async (r) => {
    const p = await get(`pulses/${idOf(r)}`).catch(() => null);
    if (p) pulses.set(idOf(r), plain(p.fields?.at));
  }));

  const now = Date.now();
  const rows = rooms.map((doc) => {
    const code = idOf(doc);
    const f = doc.fields || {};
    // The pulse doc is the usual signal; pulseAt on the room is the fallback the app
    // switches to when pulses/ is not writable.
    const beat = pulses.get(code) ?? plain(f.pulseAt) ?? null;
    const idleMs = beat === null ? Infinity : now - beat;
    const players = Object.keys(plain(f.players) || {}).length;
    return {
      code,
      state: plain(f.state) || '?',
      players,
      idleMs,
      live: idleMs <= IDLE_MS,
    };
  }).sort((a, b) => a.idleMs - b.idleMs);

  const ago = (ms) => (ms === Infinity ? 'never' : ms < 60000
    ? `${Math.round(ms / 1000)}s ago`
    : `${Math.round(ms / 60000)}m ago`);

  console.log(`${rooms.length} room${rooms.length === 1 ? '' : 's'}, `
    + `idle cutoff ${IDLE_MS / 60000}m\n`);
  for (const r of rows) {
    console.log(`  ${r.live && !ALL ? 'KEEP' : 'DROP'}  ${r.code.padEnd(10)} `
      + `${String(r.players).padStart(2)} player(s)  ${r.state.padEnd(8)} last beat ${ago(r.idleMs)}`);
  }

  const doomed = ALL ? rows : rows.filter((r) => !r.live);
  console.log(`\n${doomed.length} to delete, ${rows.length - doomed.length} left alone.`);
  if (!doomed.length) return;

  if (!DELETE) {
    console.log('\nDry run — nothing was deleted. Add --delete to go ahead.');
    return;
  }

  for (const r of doomed) {
    // The chat lives in a subcollection, which deleting the room does NOT remove:
    // Firestore keeps orphaned subcollections forever.
    const chat = await listAll(`rooms/${r.code}/chat`).catch(() => []);
    await Promise.all(chat.map((m) => fetch(url(`rooms/${r.code}/chat/${idOf(m)}`), { method: 'DELETE' })));
    await fetch(url(`pulses/${r.code}`), { method: 'DELETE' }).catch(() => {});
    const res = await fetch(url(`rooms/${r.code}`), { method: 'DELETE' });
    console.log(`  ${res.ok ? 'deleted' : `FAILED (${res.status})`}  ${r.code}`
      + `${chat.length ? ` (+${chat.length} chat)` : ''}`);
  }
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
