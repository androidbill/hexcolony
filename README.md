# HexColony

An online multiplayer island-trading board game, built as an installable PWA for
phones. Create a room, share a four-letter code, and settle the island.

> HexColony is an independent hobby project inspired by the classic island-trading board
> game. It is not affiliated with or endorsed by the rights holders of that game.

## Playing

One person taps **Create a Room** and reads out the four-letter code. Everyone else
types it into **Join**. Two to six players. Nobody makes an account.

Or tap **Play Solo** for a game against one to five bots at Easy, Medium or Hard.
Solo needs no network at all — it runs on the device and keeps working when Firebase
cannot be reached — and the game is saved as you play, so closing the app offers to
resume it.

Two boards to choose from, in the lobby or the solo sheet:

| board | tiles | tokens | ports | bank | dev deck |
|---|---|---|---|---|---|
| Classic | 19 (1 desert) | one 2 and 12, two of everything else | 9 | 19 each | 25 |
| Expansion | 30 (2 deserts) | two 2s and 12s, **three** of everything else | 11 | 24 each | 34 |

The expansion is the 5-6 player island: three 6s and three 8s rather than two, laid out
in rows of 3-4-5-6-5-4-3. The bank and development deck scale with it, because six
players on a 30-tile board would drain the classic supply long before anyone won.

The rules are the ones you already know: place two settlements and two roads in snake
order, roll for production, build with wood/brick/sheep/wheat/ore, upgrade settlements
to cities, buy development cards, take Longest Road at five and Largest Army at three
knights, and win at ten points (configurable, 5-15).

## Running it locally

No build step. It is plain ES modules served as static files:

```bash
python -m http.server 5208 --directory public
```

The workspace `.claude/launch.json` has a `hexcolony` entry that does exactly this.

To test with two players on one machine, open `localhost:5208` in one tab and
`127.0.0.1:5208` in another — different origins mean different `localStorage`, hence
two different player identities.

## Layout

Everything ships from `public/`:

| file | what it is |
|------|------------|
| `board.js` | Hex geometry. Vertices, edges, coastline and ports are all *computed* from a list of hex centres, not hand-typed — which is why a second board size costs only a new row plan. Boards are generated from a seed, so only the seed travels over the wire. |
| `rules.js` | The whole game as pure functions. `applyMove(game, playerId, move)` validates and returns the next state. No DOM, no network. |
| `render.js` | Canvas board: tiles, tokens, ports, roads, houses, robber, plus pan/zoom and hit testing. |
| `bot.js` | The opponents. One brain with the knobs turned for each difficulty; returns the next move and never touches the state. |
| `app.js` | Firestore room sync, solo play, and the interface. |
| `art/` | Optional illustrated terrain tiles — see `public/art/README.md`. The board falls back to procedural terrain textures when they are absent. |

## Multiplayer

One Firestore document per room holds the entire game. Every move runs inside a
transaction: the engine re-validates against the state actually on the server, so two
people acting at once cannot both win the race.

### Taps draw before the server answers

A move goes up inside a transaction, and a transaction is a server read followed by a
commit followed by the snapshot coming back — one to two seconds on a phone. Waiting
for all of that before drawing anything meant every tap, all game long, appeared to do
nothing for a beat.

So the device works the move out for itself with the same `applyMove` and draws it at
once. The transaction still runs, still re-validates against the state actually on the
server, and still has the last word: when its snapshot lands it replaces whatever was
drawn locally. Guessing shortens the wait for the server's answer without ever changing
what that answer is — a guess gets no vote, so this cannot be used to cheat, and a move
the server refuses is taken back off the board with the refusal.

Only moves this device can work out on its own are guessed. `roll`, `steal`,
`takeCard` and `moveRobber` (which can rob on the way past) draw from the server's
random source, and `timeout` re-enters as whatever move was owed. Showing a guessed die
and then correcting it is worse than a short wait, so those go the long way round.

Snapshots that predate the guess are held back rather than drawn, or the road would come
off the board and go back on. Moves queue in the order they were tapped rather than
being refused while one is in flight, so both halves of a Road Building card land.

Liveness uses the same design as the other party games in this collection. A separate
`pulses/{code}` document is heartbeated every four seconds by exactly one device.
Every healthy phone must therefore receive a server-sent snapshot on that cadence, and
going quiet is proof that this phone's stream is wedged — which triggers an escalating
repair ladder (resubscribe → read from server → tear down and rebuild the transport).
The heartbeat lives outside the room on purpose: Firestore has no field-level deltas,
so beating inside the room would rebroadcast the whole game state to everyone every
few seconds.

Firebase project `catanx-6644`, Firestore only, free Spark plan. Rules are **not**
deployed by the Pages workflow — deploy them separately:

```bash
firebase deploy --only firestore:rules --project catanx-6644
```

### A note on hidden information

Rooms are open by design — there are no accounts, and you join by saying a word out
loud to the people next to you. That means the whole room document, including every
player's hand, reaches every device in the room. The interface only ever shows public
information (card *counts*, which are public in this game anyway), but somebody with
devtools open could read more. Closing that properly needs a server holding the hidden
state, which means Cloud Functions and a paid plan. Until then it is a game among
friends and the honour system applies.

## Bots

A bot is a pure function of the game state, and its move is fed through the same
`applyMove` a human's tap goes through — so a bot cannot cheat, and an illegal bot move
would be rejected like anyone else's. Solo games never touch Firestore.

The three levels are the same brain with different settings. Nothing is hidden from
Easy that Hard can see; Hard just reasons further and adds less noise to its own
conclusions, so "hard" means playing better rather than peeking.

The ladder is measured, not asserted. Over 200 games per matchup with seats alternating
to cancel first-player advantage:

| matchup | result |
|---|---|
| hard vs easy | hard wins 95% |
| hard vs medium | hard wins 60% |
| medium vs easy | medium wins 90% |

At a four-player table (hard, medium, medium, easy) the wins land 104 / 41 / 51 / 4.
Across 230,794 moves the bots produced **zero** illegal moves and every game finished.
Re-run it yourself:

```bash
node scripts/bot-tournament.mjs 200
```

That harness doubles as the regression test for the engine and the bots together — it
reports any illegal move and any game that fails to finish.

Bots answer trades but do not propose them, which keeps the offer sheet from popping up
every turn. That is a deliberate limit, not an oversight.

## Discord

The app runs as a Discord Activity — embedded in a voice channel, the way colonist.io
does it. Inside Discord the room *is* the voice channel: everyone Discord launched the
activity for shares one `instance_id`, so nobody types a code.

It needs an application ID in `public/discord-config.js` and three URL mappings in the
developer portal. Full checklist, and an honest list of what is and is not tested, in
[DISCORD.md](DISCORD.md).

Outside Discord none of it runs, so the website behaves exactly as before.

## Version

`APP_VERSION` in `public/version.js` is the single source of truth — bump it on every
change. It busts the service worker cache and drives the in-app update banner.

## Icons

Generated, not drawn: `node scripts/build-icons.mjs` computes the pixels and writes
the PNG container by hand.
