// xTrivia's own Firebase project config — deliberately separate from HexColony's.
//
// This app uses only the Realtime Database product (no Firestore, no Auth). To stand up
// your own backend:
//   1. https://console.firebase.google.com -> Add project (any name, e.g. "xtrivia").
//   2. Build -> Realtime Database -> Create Database -> start in "locked mode" (the rules
//      in ../database.rules.json get deployed over that default separately).
//   3. Project settings -> General -> "Your apps" -> Add app -> Web (</>) -> register it,
//      no Firebase Hosting needed. Copy the `firebaseConfig` object it shows you and
//      paste its values in below.
//   4. Deploy the rules once you have the Firebase CLI: from the xtrivia/ folder run
//      `firebase deploy --only database --project <your-project-id>`.
//
// This file is safe to commit — a Firebase web config is a public client identifier, not
// a secret; access is controlled by database.rules.json, not by hiding this object.
export const firebaseConfig = {
  apiKey: 'REPLACE_ME',
  authDomain: 'REPLACE_ME.firebaseapp.com',
  databaseURL: 'https://REPLACE_ME-default-rtdb.firebaseio.com',
  projectId: 'REPLACE_ME',
  storageBucket: 'REPLACE_ME.appspot.com',
  messagingSenderId: 'REPLACE_ME',
  appId: 'REPLACE_ME',
};
