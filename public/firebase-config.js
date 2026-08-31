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
  // Confirmed against the Firebase console's own Realtime Database page — not a guess.
  // Wrong or unset, the app just never offers RTDB as a room backend — see RTDB_READY
  // in fb.js.
  databaseURL: 'https://catanx-6644-default-rtdb.firebaseio.com',
};
