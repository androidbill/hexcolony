// Firebase loading, with two jobs beyond `import`.
//
// 1. Inside a Discord Activity every external host must be reached through Discord's
//    proxy, and a static `import` of an absolute URL cannot be rewritten. Loading the
//    SDK with a dynamic `import()` lets the URL be computed.
//
// 2. Losing Firebase must not take the whole app down. Solo play needs no network at
//    all, but a failed *static* import aborts the entire module graph — so a player
//    with no signal would get a blank page instead of a game against the bots. Here the
//    failure is caught and the online functions degrade to rejected promises, which the
//    calling code already treats as "that did not go through".

import { firebaseConfig } from './firebase-config.js';
import { applyUrlMappings, remap, IN_DISCORD } from './discord.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

let db = null;
let online = false;
let fs = null;

try {
  // Install the proxy patches first: once Firestore opens a connection it is too late,
  // and inside Discord an unmapped request is simply blocked.
  await applyUrlMappings();

  const [appUrl, fsUrl] = await Promise.all([
    remap(`${SDK}/firebase-app.js`),
    remap(`${SDK}/firebase-firestore.js`),
  ]);
  const [appMod, fsMod] = await Promise.all([import(appUrl), import(fsUrl)]);
  fs = fsMod;

  const app = appMod.initializeApp(firebaseConfig);
  const settings = IN_DISCORD
    // Through a proxy the streaming transport is the first thing to break, and
    // auto-detection cannot always tell a proxy from a dead connection. Inside Discord
    // long-polling is simply forced, which is slower to notice a change but reliable.
    ? { experimentalForceLongPolling: true }
    // Some phones (iOS Safari behind content blockers, certain captive wifi) silently
    // break the streaming transport; auto-detection falls back to long-polling.
    : { experimentalAutoDetectLongPolling: true };

  db = fsMod.initializeFirestore(app, settings);
  online = true;
} catch (e) {
  console.warn('HexColony: Firebase unavailable — online rooms are disabled, solo play '
    + 'still works.', e);
}

/** True when rooms can actually be created and joined. */
export const NET_READY = online;
export { db, IN_DISCORD };

// Stand-ins used when Firebase never loaded. They reject rather than throw, because
// every call site already handles a rejected promise but not a synchronous throw.
const offline = () => Promise.reject(new Error('You are offline — online rooms need a connection.'));
const noop = () => () => {};

// The room browser needs to ask about the whole collection rather than one document by
// id. Deliberately only ever a single equality filter and a limit — Firestore serves that
// from the automatic single-field index, where adding an orderBy on a second field would
// demand a composite index that has to be created in the console before the query works
// at all. The sorting is done on the client instead, on at most fifty rooms.
export const collection = fs ? fs.collection : (() => null);
export const addDoc = fs ? fs.addDoc : offline;
export const orderBy = fs ? fs.orderBy : (() => null);
export const query = fs ? fs.query : (() => null);
export const where = fs ? fs.where : (() => null);
export const limit = fs ? fs.limit : (() => null);

export const doc = fs ? fs.doc : (() => ({ id: 'offline' }));
export const getDoc = fs ? fs.getDoc : offline;
export const getDocs = fs ? fs.getDocs : offline;
export const getDocFromServer = fs ? fs.getDocFromServer : offline;
export const setDoc = fs ? fs.setDoc : offline;
export const updateDoc = fs ? fs.updateDoc : offline;
export const deleteDoc = fs ? fs.deleteDoc : offline;
export const onSnapshot = fs ? fs.onSnapshot : noop();
export const runTransaction = fs ? fs.runTransaction : offline;
export const deleteField = fs ? fs.deleteField : (() => null);
export const serverTimestamp = fs ? fs.serverTimestamp : (() => Date.now());
export const disableNetwork = fs ? fs.disableNetwork : offline;
export const enableNetwork = fs ? fs.enableNetwork : offline;
