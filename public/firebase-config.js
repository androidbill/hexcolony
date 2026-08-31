// Firebase web config for HexColony. These values are public by design — a web API key
// identifies the project, it does not authorise anything. Access is controlled by the
// Firestore rules in ../firestore.rules.
export const firebaseConfig = {
  projectId: 'catanx-6644',
  appId: '1:721798241537:web:249555a078f193cdab0f00',
  storageBucket: 'catanx-6644.firebasestorage.app',
  apiKey: 'AIzaSyBTc0uLxBGerekxPHdFhDsyFeCmjXynhec',
  authDomain: 'catanx-6644.firebaseapp.com',
  messagingSenderId: '721798241537',
  // Realtime Database has to be turned on for this project in the Firebase console
  // before this URL means anything — it is not created by writing a config value here.
  // The console's Realtime Database page shows the real URL once that is done; this is
  // the default US-central shape most new databases get, so it is a starting guess, not
  // a promise. Wrong or unset, the app just never offers RTDB as a room backend — see
  // RTDB_READY in fb.js.
  databaseURL: 'https://catanx-6644-default-rtdb.firebaseio.com',
};
