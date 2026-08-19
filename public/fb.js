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
import { proxyUrl, firestoreHost, IN_DISCORD } from './discord.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

let db = null;
let online = false;
let fs = null;

try {
  const [appMod, fsMod] = await Promise.all([
    import(proxyUrl(`${SDK}/firebase-app.js`)),
    import(proxyUrl(`${SDK}/firebase-firestore.js`)),
  ]);
  fs = fsMod;

  const app = appMod.initializeApp(firebaseConfig);
  const settings = {
    // Some phones (iOS Safari behind content blockers, certain captive wifi) silently
    // break the streaming transport; auto-detection falls back to long-polling.
    experimentalAutoDetectLongPolling: true,
  };
  const host = firestoreHost();
  if (host) {
    // Inside Discord, Firestore's own traffic has to go through the mapped proxy too.
    settings.host = host;
    settings.ssl = true;
  }
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

export const doc = fs ? fs.doc : (() => ({ id: 'offline' }));
export const getDoc = fs ? fs.getDoc : offline;
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
