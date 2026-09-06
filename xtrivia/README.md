# xTrivia

A live multiplayer trivia PWA in the spirit of BuzzTrivia: a host stands up a room,
players join from their phones with a 5-character code, and everyone answers each
question simultaneously — points reward both being correct and being fast. No accounts,
no build step, no server code beyond a Firebase Realtime Database.

This is an independent app inside the `hexcolony` repo — it does not share code, a
Firebase project, or a deploy target with HexColony.

## How it works

- **Host** picks a category, difficulty, question count, and a per-question timer, then
  creates a room. Questions come from the [Open Trivia
  Database](https://opentdb.com) at game-start time and are stored on the room so every
  device sees the identical question set and shuffled answer order.
- **Players** join with a name and the room code.
- Once started, every connected player sees the same question at the same time and has
  until the timer runs out to pick an answer. Correct answers score more the faster
  they're submitted (500-1000 points); wrong or missed answers score 0.
- After each question the host reveals the correct answer and the room moves on; after
  the last question everyone sees a final podium and leaderboard.
- The host device is authoritative for timing and scoring (there's no server function) —
  if the host closes their tab mid-game, the round stalls until they come back.

## One-time setup: your own Firebase project

The app ships with a placeholder `public/firebase-config.js` — it will not connect to
anything until you point it at a real project:

1. Create a project at <https://console.firebase.google.com>.
2. **Build → Realtime Database → Create Database.** Region doesn't matter; start in
   locked mode (the rules below get deployed over that separately).
3. **Project settings → General → Your apps → Add app → Web.** No Hosting needed at this
   step. Copy the `firebaseConfig` values it shows you into
   `public/firebase-config.js`.
4. Install the Firebase CLI (`npm install -g firebase-tools`) if you don't have it, then
   from this `xtrivia/` folder:
   ```
   firebase login
   firebase deploy --only database --project <your-project-id>
   ```
   That pushes `database.rules.json`. (`firebase.json` also has a `hosting` block if you
   want to `firebase deploy --only hosting` this folder instead of hosting `public/`
   yourself — either works, they just serve the same static files.)

## Running it locally

No build step — it's static files plus ES modules. Any static file server works:

```
cd xtrivia
npm run serve      # http-server on :8080
```

or point any other static server (Vite, `python -m http.server`, Firebase Hosting
emulator, etc.) at `public/`.

## Notes / known limitations

- **No auth.** Like a living-room party game, the room code is the only thing gating
  access — the database rules check data shape, not who's writing. Don't use this for
  anything where a cheating player matters.
- **Host is a single point of failure** for timing/scoring — there's no serverless
  function standing in if the host tab closes mid-round.
- **Icon is SVG-only** (`public/icons/icon.svg`) — installs and looks correct on Android
  Chrome and desktop; iOS home-screen icons want a PNG `apple-touch-icon`, which isn't
  generated here yet.
