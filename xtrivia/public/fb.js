// Realtime Database loading, kept deliberately small.
//
// xTrivia only ever needs one Firebase product (Realtime Database), so unlike a
// multi-backend app there is nothing to switch between — just "online" or "not". A
// failed import must not take the app down: it should degrade to an explicit
// "you're offline" state rather than a blank page.

import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

let rtdb = null;
let mod = null;
let online = false;

try {
  const [appMod, dbMod] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-database.js`),
  ]);
  mod = dbMod;
  const app = appMod.initializeApp(firebaseConfig);
  rtdb = dbMod.getDatabase(app, firebaseConfig.databaseURL);
  online = true;
} catch (e) {
  console.warn('xTrivia: Realtime Database unavailable — rooms are disabled.', e);
}

/** True once a room can actually be created/joined. */
export const NET_READY = online;

const offline = () => Promise.reject(new Error('You are offline — rooms need a connection.'));
const noop = () => () => {};

export const ref = mod ? mod.ref : (() => null);
export const push = mod ? mod.push : offline;
export const get = mod ? mod.get : offline;
export const set = mod ? mod.set : offline;
export const update = mod ? mod.update : offline;
export const remove = mod ? mod.remove : offline;
export const onValue = mod ? mod.onValue : noop();
export const onDisconnect = mod ? mod.onDisconnect : (() => ({ set: offline, cancel: offline }));
export const runTransaction = mod ? mod.runTransaction : offline;
export const serverTimestamp = mod ? mod.serverTimestamp : (() => Date.now());
export { rtdb };

// Estimate of (server time - our local clock), kept live via the special
// `.info/serverTimeOffset` node. Used so every device's countdown timer agrees on how
// much time is left, even when a phone's clock is wrong.
let offset = 0;
if (mod && rtdb) {
  mod.onValue(mod.ref(rtdb, '.info/serverTimeOffset'), (snap) => {
    offset = snap.val() || 0;
  });
}
export const serverNow = () => Date.now() + offset;
