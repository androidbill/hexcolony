# CatanX

An online multiplayer island-trading board game, built as an installable PWA for
phones. Create a room, share a four-letter code, and settle the island.

> CatanX is an independent hobby project inspired by the classic island-trading board
> game. It is not affiliated with or endorsed by the rights holders of that game.

## Playing

One person taps **Create a Room** and reads out the four-letter code. Everyone else
types it into **Join**. Two to six players. Nobody makes an account.

The rules are the ones you already know: place two settlements and two roads in snake
order, roll for production, build with wood/brick/sheep/wheat/ore, upgrade settlements
to cities, buy development cards, take Longest Road at five and Largest Army at three
knights, and win at ten points (configurable, 5-15).

## Running it locally

No build step. It is plain ES modules served as static files:

```bash
python -m http.server 5208 --directory public
```

The workspace `.claude/launch.json` has a `catanx` entry that does exactly this.

To test with two players on one machine, open `localhost:5208` in one tab and
`127.0.0.1:5208` in another — different origins mean different `localStorage`, hence
two different player identities.

## Layout

Everything ships from `public/`:

| file | what it is |
|------|------------|
| `board.js` | Hex geometry. The 19 tiles, 54 vertices, 72 edges, coastline and ports are all *computed* from 19 hex centres, not hand-typed. Boards are generated from a seed, so only the seed travels over the wire. |
| `rules.js` | The whole game as pure functions. `applyMove(game, playerId, move)` validates and returns the next state. No DOM, no network. |
| `render.js` | Canvas board: tiles, tokens, ports, roads, houses, robber, plus pan/zoom and hit testing. |
| `app.js` | Firestore room sync and the interface. |
| `art/` | Optional illustrated terrain tiles — see `public/art/README.md`. The board falls back to procedural terrain textures when they are absent. |

## Multiplayer

One Firestore document per room holds the entire game. Every move runs inside a
transaction: the engine re-validates against the state actually on the server, so two
people acting at once cannot both win the race.

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

## Version

`APP_VERSION` in `public/version.js` is the single source of truth — bump it on every
change. It busts the service worker cache and drives the in-app update banner.

## Icons

Generated, not drawn: `node scripts/build-icons.mjs` computes the pixels and writes
the PNG container by hand.
